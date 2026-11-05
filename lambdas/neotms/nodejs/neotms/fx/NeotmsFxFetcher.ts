// SPDX-License-Identifier: MIT
//
// The scheduled rate fetcher: Korea Export-Import Bank -> `fx_rate`.
//
// Called by EventBridge every five minutes (see infra/constructs/NeotmsFxRate.ts). It asks the bank
// for today's table, keeps the currencies this system actually uses, and upserts them. That is the
// whole job; everything below is about the ways it can go wrong quietly.
//
// ## Why cache at all, and why in PostgreSQL
//
// Two reasons not to call the API from the request path. The key is rate-limited to 1,000 calls a
// day, which a dozen staff opening job forms would exhaust by lunchtime; and the upstream is a
// public-sector endpoint whose latency is measured in seconds, which would be added to every job
// save.
//
// PostgreSQL rather than DynamoDB, which was the other candidate. The decisive argument is not cost
// or latency - DynamoDB would win both - it is that the rate's PRIMARY consumer is a SQL join.
// NeotmsMoney's `CASE` expression multiplies `job_price_sum` by `fx_rate_latest.rate` inside the
// aggregate; a rate living in DynamoDB would have to be read first and then interpolated into the
// statement, which means the reports could no longer be pure `SqlOps` and every one of the five
// statistics queries would need the rate passed in. `fx_rate` also already existed, with the right
// grain and the right index, and its own comment already said a scheduled job would fill it.
//
// ## Call budget
//
// 288 runs a day on a 1,000-call key, one call each. Two stages sharing one key is 576, which still
// fits but is most of the budget - so if a third stage ever appears, give it its own key rather than
// stretching this one. The bootstrap walk-back below can spend up to seven extra calls, once, on a
// database that has never held a quote.
//
// Five minutes is far more often than the data changes: AP01 is a DAILY table, published once per
// business day at around 11:00 KST. The frequency is therefore not about granularity, it is about
// RECOVERY - the window between publication and the figure being live is five minutes instead of a
// day, and a run that fails for any reason is retried twelve times an hour without anybody being
// paged.
//
// ## The three traps in this API
//
// Each of these has a matching piece of code below, and each is silent rather than loud:
//
//   1. **An empty array is the normal answer** outside business hours - nights, weekends, holidays,
//      and every day before publication. So MOST runs get nothing back. The one thing this function
//      must never do is treat that as "no rates exist" and clear the table: Friday's quote is the
//      correct answer on a Sunday, and `fx_rate_latest` is deliberately uncapped by age so that it
//      keeps serving it. An empty response writes nothing at all.
//   2. **JPY is quoted per 100 units.** `cur_unit` comes back as `"JPY(100)"`, and `deal_bas_r` is
//      KRW per 100 yen. Storing that unchanged would overstate every yen job by a hundredfold -
//      and JPY is one of the six currencies this company collects, so this is not a hypothetical.
//      Everything downstream assumes per-one-unit, so the division happens here, once.
//   3. **Numbers carry thousands separators.** `"1,388.50"` parses as 1 under `Number()` - not as
//      an error, as the integer one - which would value a dollar at one won. Stripped before parse,
//      and the result is range-checked afterwards.
//
// ## What this function deliberately does not do
//
//   * **It does not fail loudly on an empty or refused response.** It logs and returns. A fetcher
//     that throws is a fetcher with an alarm on it, and there is nobody on call; a fetcher that logs
//     leaves the previous quote in place, which is a correct answer. Real staleness is visible in
//     the console beside every converted figure, because `effective_date` is sent with the rate.
//   * **It does not touch `job` or `purchase_order`.** Nothing is re-valued by this Lambda. Open
//     positions are converted at read time by the statistics queries, and settled ones are frozen.
//     A fetcher with write access to the money columns is a fetcher that can restate an invoice.
//   * **It does not ask for a historical date.** There is no "rate as at" anywhere in this design -
//     see NeotmsMoney's header - so a backfill of past rates would be data nothing reads.

import { pgExecuteCount, pgQuery } from "../../utils/PostgresUtils.js";
import { FX_CURRENCY_CODES } from "../NeotmsCurrency.js";
import { FxRateAnyOps, FxRateUpsertManyOps, type FxQuote } from "./NeotmsFxRate.dbops.js";
import { readFxApiKey } from "./NeotmsFxSecret.js";

/* -------------------------------------------------------------------------- */
/* Upstream                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The endpoint, on the `oapi` host.
 *
 * Not `www.koreaexim.go.kr`, which also answers this path: the bank moved the open APIs to a
 * dedicated host and the old one's TLS chain is not reliably complete, which surfaces as
 * `unable to verify the first certificate` rather than as anything resembling a deprecation notice.
 */
const KEXIM_URL = "https://oapi.koreaexim.go.kr/site/program/financial/exchangeJSON";

/** `AP01` is the exchange-rate table. `AP02` is lending rates and `AP03` is SDR, neither of use. */
const KEXIM_DATA = "AP01";

/** Written into `fx_rate.source`. `'manual'` is the other value the column's comment documents. */
const SOURCE = "koreaexim";

/**
 * Give up on the HTTP call after this long.
 *
 * `fetch` has no default timeout, and a public-sector endpoint that accepts a connection and then
 * never answers would otherwise hold the Lambda until its own timeout - paying for the wait and,
 * worse, holding a pooled database backend if the connection had already been opened. Shorter than
 * the function timeout on purpose, so the log line comes from here and names the cause.
 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * How many days back the bootstrap walk may go.
 *
 * Only used when `fx_rate` has never held a row. Seven covers a long weekend plus 설날 or 추석,
 * which are the only stretches with more than three consecutive non-business days.
 */
const BOOTSTRAP_LOOKBACK_DAYS = 7;

/** Sanity bounds on a parsed rate, in KRW per unit. */
const MIN_RATE = 0.000001;
const MAX_RATE = 1_000_000;

/**
 * One row of the upstream's response.
 *
 * Every field is optional and typed `unknown`-ish on purpose: this is somebody else's JSON, it is
 * not versioned, and a field that stops arriving must produce a skipped currency with a log line
 * rather than a `TypeError` that loses the whole fetch. Only the three fields actually used are
 * named; the other eight (`ttb`, `tts`, `bkpr`, `yy_efee_r`, `ten_dd_efee_r`, `kftc_bkpr`,
 * `kftc_deal_bas_r`, `cur_nm`) are real but irrelevant here.
 *
 * `deal_bas_r` is the 매매기준율 - the mid rate. Deliberately not `ttb`/`tts`, the telegraphic
 * transfer buying and selling rates: those are what a bank would actually pay or charge, and they
 * straddle the mid rate by a spread. The question this system asks is "what is this receivable
 * worth", which is a valuation and not a quote for a transaction, so the mid rate is the honest
 * answer. Using `tts` would systematically overstate every open position.
 */
type KeximRow = {
  /** 1 = success. See `KEXIM_RESULTS`. Present on every row, including in a failure response. */
  result?: unknown;
  /**
   * `"USD"`, `"EUR"`, `"JPY(100)"`, `"IDR(100)"`. The parenthesised number is the quote unit.
   *
   * The Chinese currency arrives as **`"CNH"`**, the offshore yuan, and `"CNY"` is not in this table
   * at all - which is why `FX_CURRENCY_CODES` lists CNH. See NeotmsCurrency.ts before changing it
   * back; a CNY entry would simply never match a row here.
   */
  cur_unit?: unknown;
  /** 매매기준율, with thousands separators. `"1,388.5"`. */
  deal_bas_r?: unknown;
};

/**
 * `result` codes, as the bank documents them.
 *
 * Worth enumerating because three of the four are operator-actionable and the raw number is not.
 * `4` in particular is the one that will actually happen: it means this key has spent its 1,000
 * calls for the day, and the right response is to check whether another deployment is sharing it.
 */
const KEXIM_RESULTS: Record<number, string> = {
  1: "success",
  2: "DATA code error - the data=AP01 parameter was rejected",
  3: "authentication code error - the API key is wrong, expired, or not yet activated",
  4: "daily call limit exceeded - this key has used its 1,000 calls for today",
};

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `"JPY(100)"` -> `{ code: "JPY", per: 100 }`, `"USD"` -> `{ code: "USD", per: 1 }`.
 *
 * The parenthesised form is how the bank says "this quote is for N units", and it is the trap worth
 * the most care in this file: JPY and IDR are both quoted per 100, JPY is one of the five currencies
 * this company uses, and getting it wrong does not look wrong - a yen job simply reports a hundred
 * times its worth, which reads as a large job.
 *
 * Returns null on anything that is not a three-letter code, optionally followed by a count in
 * parentheses, so a new format arrives as a skipped currency rather than as a bad rate. `(0)` is
 * rejected for the obvious reason.
 */
export function parseCurrencyUnit(raw: string): { code: string; per: number } | null {
  const match = /^([A-Z]{3})(?:\((\d+)\))?$/.exec(raw.trim());
  if (!match) return null;
  const code = match[1]!;
  const per = match[2] === undefined ? 1 : Number(match[2]);
  if (!Number.isFinite(per) || per <= 0) return null;
  return { code, per };
}

/**
 * `"1,388.50"` -> `1388.5`.
 *
 * The strip is the entire point. `Number("1,388.50")` is `NaN`, which is caught - but
 * `parseFloat("1,388.50")` is `1`, silently, and an earlier draft of this parser used it. A dollar
 * worth one won would not have thrown anything; it would have shown up as a quarter with no revenue
 * in it. Hence a strict `Number()` on a cleaned string, and a range check after.
 */
export function parseRate(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (cleaned.length === 0) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value < MIN_RATE || value > MAX_RATE) return null;
  return value;
}

/**
 * Today in KST, as `YYYY-MM-DD`, offset by `daysBack`.
 *
 * KST and not the Lambda's clock, which is UTC: between 00:00 and 09:00 KST, UTC is still on
 * yesterday's date. Asking the bank for yesterday at 08:00 KST would fetch a table that exists and
 * is stale, and store it under yesterday's `effective_date` - so `fx_rate_latest` would keep serving
 * the day-old figure for nine hours after the new one was published. The same reasoning, and the
 * same fixed offset, as `TODAY_KST` in NeotmsDashboard.dbops.ts.
 *
 * A fixed +09:00 rather than an IANA zone because Korea has no daylight saving and has not since
 * 1988, so there is no transition for a fixed offset to get wrong.
 */
export function kstDate(now: Date, daysBack = 0): string {
  const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000 - daysBack * 24 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` -> `YYYYMMDD`, which is the only format `searchdate` accepts. */
const toSearchDate = (isoDate: string): string => isoDate.replace(/-/g, "");

/* -------------------------------------------------------------------------- */
/* The fetch                                                                  */
/* -------------------------------------------------------------------------- */

/** What one call to the upstream produced. `rows: []` is the routine out-of-hours answer. */
type FetchResult = { ok: true; rows: KeximRow[] } | { ok: false; reason: string };

/**
 * One call, for one business date.
 *
 * The API key goes in the QUERY STRING, because that is the only place this API accepts it. That is
 * worth one sentence of acknowledgement: a credential in a URL is normally a mistake, since it lands
 * in access logs and `Referer` headers. Here the request is server-to-server over TLS, so there is
 * no referrer and no browser history - but it does mean the URL must never be logged, which is why
 * every log line below names the DATE and not the URL.
 */
async function fetchOneDay(apiKey: string, isoDate: string): Promise<FetchResult> {
  const url = new URL(KEXIM_URL);
  url.searchParams.set("authkey", apiKey);
  url.searchParams.set("data", KEXIM_DATA);
  url.searchParams.set("searchdate", toSearchDate(isoDate));

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    // The URL carries the key, so the error is reported without it. `AbortError` here means the
    // timeout above fired.
    return { ok: false, reason: `the request for ${isoDate} failed: ${String(err)}` };
  }

  if (!response.ok) {
    return { ok: false, reason: `the upstream answered HTTP ${String(response.status)}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    /*
     * A 200 whose body is not JSON. This is the shape an outage takes on this endpoint - an HTML
     * maintenance page served with a 200 - so it is a distinct, named case rather than part of the
     * generic failure above.
     */
    return { ok: false, reason: `the upstream answered HTTP 200 with a non-JSON body: ${String(err)}` };
  }

  /*
   * A non-array body is a protocol change, not a bad day.
   *
   * On success and on an empty day this endpoint returns an array - `[]` for the latter. A failure
   * response is ALSO an array, of one row carrying only `result`, which is why the result code is
   * checked per row below rather than once here.
   */
  if (!Array.isArray(body)) {
    return { ok: false, reason: "the upstream answered with something that is not a JSON array" };
  }
  return { ok: true, rows: body as KeximRow[] };
}

/**
 * The rows the bank sent, turned into quotes for the currencies this system uses.
 *
 * Filtering to `wanted` here rather than in SQL means an unrecognised currency never reaches a
 * parameter list. Each skip is logged at most once per run and does not abort the batch: one
 * malformed currency must not cost the other five their update.
 */
export function toQuotes(
  rows: readonly KeximRow[],
  wanted: ReadonlySet<string>,
  effectiveDate: string,
): FxQuote[] {
  const quotes: FxQuote[] = [];
  for (const row of rows) {
    const result = Number(row.result);
    if (result !== 1) {
      const explanation = KEXIM_RESULTS[result] ?? "an undocumented result code";
      console.error(`[fxrate] the upstream refused the request: result=${String(row.result)} (${explanation})`);
      // Refused is refused for the whole response, not for one currency - there is nothing in the
      // remaining rows to salvage.
      return [];
    }

    const rawUnit = typeof row.cur_unit === "string" ? row.cur_unit : "";
    const unit = rawUnit ? parseCurrencyUnit(rawUnit) : null;
    if (!unit) {
      console.warn(`[fxrate] skipping a row with an unreadable cur_unit: ${JSON.stringify(rawUnit)}`);
      continue;
    }
    if (!wanted.has(unit.code)) continue;

    const rawRate = typeof row.deal_bas_r === "string" ? row.deal_bas_r : String(row.deal_bas_r ?? "");
    const rate = parseRate(rawRate);
    if (rate === null) {
      console.warn(`[fxrate] skipping ${unit.code}: deal_bas_r is unusable (${JSON.stringify(rawRate)})`);
      continue;
    }

    /*
     * The per-100 division, and the one place it happens.
     *
     * Six decimal places because that is `fx_rate.rate`'s scale - `numeric(18,6)` - so rounding
     * here rather than letting PostgreSQL do it means the number in the log line is the number in
     * the table. `toFixed` on a value bounded by MAX_RATE cannot reach exponential notation, which
     * `numeric` would reject.
     */
    const perOne = rate / unit.per;
    quotes.push({
      currencyCode: unit.code,
      rate: perOne.toFixed(6),
      effectiveDate,
      source: SOURCE,
    });
  }
  return quotes;
}

/* -------------------------------------------------------------------------- */
/* The run                                                                    */
/* -------------------------------------------------------------------------- */

/** What one invocation did. Returned so a manual invoke and a test can both read it. */
export type FxFetchOutcome = {
  /** `YYYY-MM-DD` the quotes were stored under, or null when nothing was stored. */
  effectiveDate: string | null;
  /** Currencies written. Zero is a normal out-of-hours result. */
  written: number;
  /** One sentence for the log and for a manual invoke's response. */
  note: string;
};

/**
 * Fetch and store, once.
 *
 * The wanted currency list is a constant (`FX_CURRENCY_CODES` in NeotmsCurrency.ts) and not a query.
 * An earlier version read it from `currency`, which put a database round trip ahead of the HTTP call
 * - justified at the time as failing on the cheap half first, so that a database outage could not
 * also spend an API call out of a daily budget of 1,000. That ordering is moot now and the reason the
 * list moved is a different one: `currency` is an ETL target, so a house code loaded out of legacy
 * COINTB_MAIN used to become a currency this function asked the bank about.
 *
 * Never throws on an upstream problem - see the file header. The only exceptions that escape are
 * database and secret failures, which are genuine faults and which Lambda should record as errors.
 */
export async function fetchFxRates(now = new Date()): Promise<FxFetchOutcome> {
  /*
   * No empty-list guard. The six entries are a literal in this deployment's own source, asserted
   * element-by-element in neotms.fx.test.ts, so "the list is empty" is not a runtime condition this
   * function can find itself in - unlike the query it replaces, whose guard ("the currency table is
   * empty; nothing to fetch") existed for a part-way-migrated database.
   */
  const wanted = new Set(FX_CURRENCY_CODES);

  const apiKey = await readFxApiKey();
  if (!apiKey) {
    return {
      effectiveDate: null,
      written: 0,
      note: "no API key is configured, so no rate was fetched",
    };
  }

  const today = kstDate(now);
  const first = await fetchOneDay(apiKey, today);
  if (!first.ok) {
    return { effectiveDate: null, written: 0, note: first.reason };
  }

  let rows = first.rows;
  let effectiveDate = today;

  /*
   * The bootstrap walk-back.
   *
   * An empty response is routine and the normal reaction is to leave the table alone - the previous
   * quote is still the right answer. There is exactly one case where that reasoning fails: a
   * database that has NEVER held a quote, where "leave it alone" means every open position keeps
   * falling back to its stored ksum indefinitely. A stack deployed on a Friday evening would read
   * no rate until Monday.
   *
   * So the walk is conditional on the table being empty, which makes it a once-ever cost of at most
   * seven extra calls rather than a per-run one. The condition is checked only when it matters, so
   * the usual path still issues one query and one HTTP call.
   */
  if (rows.length === 0) {
    const seeded = (await pgQuery(FxRateAnyOps())).data;
    if (seeded) {
      return {
        effectiveDate: null,
        written: 0,
        note: `no table published for ${today} yet; the stored quotes stand`,
      };
    }
    for (let back = 1; back <= BOOTSTRAP_LOOKBACK_DAYS && rows.length === 0; back += 1) {
      const day = kstDate(now, back);
      const attempt = await fetchOneDay(apiKey, day);
      if (!attempt.ok) {
        return { effectiveDate: null, written: 0, note: attempt.reason };
      }
      rows = attempt.rows;
      effectiveDate = day;
    }
    if (rows.length === 0) {
      return {
        effectiveDate: null,
        written: 0,
        note: `fx_rate is empty and no table was published in the last ${String(BOOTSTRAP_LOOKBACK_DAYS)} days`,
      };
    }
    console.warn(`[fxrate] bootstrapping an empty fx_rate from the table for ${effectiveDate}`);
  }

  const quotes = toQuotes(rows, wanted, effectiveDate);
  if (quotes.length === 0) {
    /*
     * Rows came back but none of them survived. Either the request was refused (already logged with
     * its result code) or every currency this system uses was unreadable. Both are worth a line and
     * neither is worth clearing the table over.
     */
    return {
      effectiveDate: null,
      written: 0,
      note: `the table for ${effectiveDate} carried no usable quote for any currency in use`,
    };
  }

  const written = (await pgExecuteCount(FxRateUpsertManyOps(quotes))).data;
  const missing = [...wanted].filter((code) => !quotes.some((q) => q.currencyCode === code));
  /*
   * A currency the bank does not quote is logged every run, deliberately.
   *
   * It is a permanent condition rather than a transient one - the bank quotes about twenty-three
   * currencies and a house currency outside that set will never appear - so one line per run is the
   * only thing that will eventually be noticed. The alternative is the failure db/004_rollup.sql
   * warns about: an open position in that currency silently reporting its stored ksum forever.
   */
  if (missing.length > 0) {
    console.warn(`[fxrate] the upstream quotes no rate for: ${missing.join(", ")}`);
  }

  return {
    effectiveDate,
    written,
    note: `stored ${String(written)} quote(s) for ${effectiveDate}`,
  };
}
