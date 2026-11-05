// SPDX-License-Identifier: MIT
//
// The exchange-rate path, from the bank's JSON to the figure on a list screen.
//
// Two kinds of assertion in one file, because they guard the two halves of one mistake.
//
// The PARSER half is ordinary unit testing, and it is here because every defect this parser can have
// produces a NUMBER rather than an error. `parseFloat("1,388.50")` is 1 - silently, and an earlier
// draft of the fetcher used exactly that - which values a dollar at one won. A yen quote stored
// without its per-100 division overstates every yen job a hundredfold, which reads as a large job
// and not as a bug. Neither is visible to `tsc`, neither throws, and neither shows up in a log.
//
// The SQL half asserts that the five statistics queries all convert, and all convert the SAME way.
// There is one definition in NeotmsMoney.ts and one `fx_rate_latest` view precisely so that the job
// list, the PO list, the project rollup, both dashboards and the margin report cannot disagree about
// what a job is worth - and the failure mode of drift is two screens showing different revenue for
// the same job with neither looking wrong.
//
// No database and no network. `SqlOps` is a plain `{ sql, parameters, mapper }`, and the parser
// functions are exported for this purpose. The HTTP call itself is deliberately not tested here -
// mocking `fetch` would assert the shape of the mock, and what actually matters about that call (the
// timeout, the key staying out of the log, the empty-array case) is readable in the one function
// that makes it.

import { JobListOps, JOB_SORTS } from "../lambdas/neotms/nodejs/neotms/jobs/NeotmsJob.dbops.js";
import {
  PoListOps,
  PO_SORTS,
} from "../lambdas/neotms/nodejs/neotms/purchase-orders/NeotmsPurchaseOrder.dbops.js";
import {
  FxRateAnyOps,
  FxRateLatestOps,
  FxRateUpsertManyOps,
  type FxQuote,
} from "../lambdas/neotms/nodejs/neotms/fx/NeotmsFxRate.dbops.js";
import {
  CURRENCY_CODES,
  FX_CURRENCY_CODES,
} from "../lambdas/neotms/nodejs/neotms/NeotmsCurrency.js";
import {
  kstDate,
  parseCurrencyUnit,
  parseRate,
  toQuotes,
} from "../lambdas/neotms/nodejs/neotms/fx/NeotmsFxFetcher.js";
import { JOB_KRW, JOB_KRW_JOIN, PO_KRW, PO_KRW_JOIN } from "../lambdas/neotms/nodejs/neotms/NeotmsMoney.js";
import type { NeotmsCaller } from "../lambdas/neotms/nodejs/auth/NeotmsAuthGuard.js";

/** Whitespace collapsed, so an assertion is about the SQL and not about its indentation. */
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

/** An unrestricted caller - scope is not what this file is about, and its own tests cover it. */
const caller: NeotmsCaller = {
  sub: "sub-1",
  staffId: "1",
  mgrId: "mgr-1",
  name: "Admin",
  email: "admin@example.com",
  corpCode: null,
  roleId: "1",
  roleCode: "NEOTMS_SYSADMIN",
  roleName: "시스템관리자",
  permissions: new Map(),
  viewScope: "all",
  seesEveryRow: true,
};

/* -------------------------------------------------------------------------- */
/* The parser                                                                 */
/* -------------------------------------------------------------------------- */

describe("reading the bank's numbers", () => {
  test("a parenthesised currency unit is a quote count, not decoration", () => {
    /*
     * The single highest-consequence line in the fetcher. `"JPY(100)"` means the rate beside it is
     * KRW per ONE HUNDRED yen, and JPY is one of the six currencies this system actually collects -
     * so this is not a hypothetical about an exotic currency.
     *
     * `per` is returned rather than the division being done here so that the division happens in
     * exactly one place (`toQuotes`), which is the next test.
     */
    expect(parseCurrencyUnit("USD")).toEqual({ code: "USD", per: 1 });
    expect(parseCurrencyUnit("JPY(100)")).toEqual({ code: "JPY", per: 100 });
    expect(parseCurrencyUnit("IDR(100)")).toEqual({ code: "IDR", per: 100 });
    // The upstream pads some rows. Trimmed rather than rejected, because a leading space is not a
    // protocol change and refusing it would drop a currency for a cosmetic reason.
    expect(parseCurrencyUnit(" EUR ")).toEqual({ code: "EUR", per: 1 });
  });

  test("an unreadable unit is null, so a format change skips a currency rather than mispricing it", () => {
    /*
     * The failure direction matters more than the cases. A parser that GUESSED - taking the first
     * three characters, say - would turn an unrecognised format into a plausible rate for a currency
     * it had invented. Returning null makes the row a logged skip, which leaves the previous quote
     * standing: a correct, slightly old number instead of a new wrong one.
     *
     * `(0)` is rejected because it is the divisor. It would produce Infinity, and `toFixed` on
     * Infinity yields the string "Infinity", which PostgreSQL accepts into a `numeric` - at which
     * point every report that touches that currency is NaN.
     */
    for (const raw of ["", "US", "USDX", "us", "JPY(0)", "JPY()", "JPY(abc)", "JPY 100", "1388"]) {
      expect(parseCurrencyUnit(raw)).toBeNull();
    }
  });

  test("thousands separators are stripped before the parse, not after", () => {
    /*
     * The regression this test exists for, named in the fetcher's own comment: `parseFloat` on a
     * separated number returns the leading digits and stops at the comma. `parseFloat("1,388.50")`
     * is 1. It does not throw, it is not NaN, and it is not caught by any range check that permits
     * small rates - so a USD job would have reported its dollar figure as its won figure.
     */
    expect(parseRate("1,388.50")).toBe(1388.5);
    expect(parseRate("1388.5")).toBe(1388.5);
    expect(parseRate(" 999,999.99 ")).toBe(999999.99);
    /*
     * And the two interacting: the strip happens first, then the range check, so a separated number
     * above MAX_RATE is refused for being too large rather than for having commas in it. Worth
     * pinning because it means a currency the bank ever quotes above a million KRW per unit would be
     * dropped - which is the right call (nothing real is up there, so such a value means the field
     * changed meaning) but is a decision rather than an accident of the parse order.
     */
    expect(parseRate("1,234,567.89")).toBeNull();
  });

  test("a rate outside the sane band is refused", () => {
    /*
     * The band is what catches a field that has changed meaning rather than changed format. If
     * `deal_bas_r` ever started carrying a percentage or a basis-point figure, every value would
     * still parse as a number - so the only defence is a range, and the range is wide enough that
     * no real currency can hit it (the weakest currency the bank quotes is still well above
     * 0.000001 KRW per unit).
     *
     * Zero in particular must not pass. A rate of 0 would value every open position in that currency
     * at nothing, which looks exactly like a quarter with no revenue in it.
     */
    for (const raw of ["", "   ", "abc", "0", "-1388.5", "1e9", "NaN", "Infinity"]) {
      expect(parseRate(raw)).toBeNull();
    }
  });

  test("the business date is KST, not the Lambda's UTC clock", () => {
    /*
     * The nine-hour window this gets wrong. At 23:30 UTC it is already tomorrow in Seoul, so a
     * fetcher using its own clock asks the bank for yesterday - gets a table that exists and is
     * stale - and stores it under yesterday's `effective_date`. `fx_rate_latest` then keeps serving
     * the day-old figure for nine hours after the new one was published, with nothing anywhere
     * reporting a fault.
     *
     * A fixed +09:00 rather than an IANA zone: Korea has had no daylight saving since 1988, so there
     * is no transition for the offset to get wrong.
     */
    expect(kstDate(new Date("2026-03-01T23:30:00Z"))).toBe("2026-03-02");
    expect(kstDate(new Date("2026-03-01T14:00:00Z"))).toBe("2026-03-01");
    // Just before midnight KST is still the same day; one minute later is not.
    expect(kstDate(new Date("2026-03-01T14:59:00Z"))).toBe("2026-03-01");
    expect(kstDate(new Date("2026-03-01T15:00:00Z"))).toBe("2026-03-02");
    // The walk-back offset, which only the bootstrap path uses. Crossing a month boundary because
    // that is where a hand-rolled date subtraction would break.
    expect(kstDate(new Date("2026-03-01T23:30:00Z"), 3)).toBe("2026-02-27");
  });
});

describe("turning rows into quotes", () => {
  /** Silences the fetcher's own warn/error lines, which several cases below deliberately provoke. */
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const wanted = new Set(["USD", "EUR", "JPY"]);
  const row = (cur_unit: string, deal_bas_r: string) => ({ result: 1, cur_unit, deal_bas_r });

  test("a per-100 quote is divided down exactly once", () => {
    /*
     * The division is here and nowhere else, which is what lets everything downstream - the view,
     * NeotmsMoney's CASE, the client's own multiplication - assume per-one-unit without checking.
     *
     * Six decimal places because `fx_rate.rate` is `numeric(18,6)`: rounding here rather than
     * letting PostgreSQL do it means the number in the log line is the number in the table.
     */
    const quotes = toQuotes(
      [row("USD", "1,388.50"), row("JPY(100)", "912.34")],
      wanted,
      "2026-03-02",
    );
    expect(quotes).toEqual([
      { currencyCode: "USD", rate: "1388.500000", effectiveDate: "2026-03-02", source: "koreaexim" },
      { currencyCode: "JPY", rate: "9.123400", effectiveDate: "2026-03-02", source: "koreaexim" },
    ]);
  });

  test("a refusal discards the whole response rather than part of it", () => {
    /*
     * A failure response from this API is an array of one row carrying only `result`, so the code
     * has to be checked per row rather than once on the envelope. `3` is an authentication failure
     * and `4` is the daily call limit - the one that will actually happen, since the key allows
     * 1,000 calls a day and two stages share it.
     *
     * Returning `[]` rather than throwing is what keeps yesterday's quote standing. And returning
     * nothing at all - rather than the rows that happened to precede the refusal - matters because a
     * refusal is a statement about the REQUEST: there is nothing in the remaining rows to salvage.
     */
    expect(toQuotes([{ result: 3 }], wanted, "2026-03-02")).toEqual([]);
    expect(toQuotes([{ result: 4 }], wanted, "2026-03-02")).toEqual([]);
    expect(toQuotes([row("USD", "1388.5"), { result: 4 }], wanted, "2026-03-02")).toEqual([]);
  });

  test("one unusable row costs the others nothing", () => {
    /*
     * The bank quotes about twenty-three currencies and this system collects six. A malformed row in
     * any of the others must not abort the batch - the alternative is that an unrelated currency's
     * formatting breaks the conversion for every job in the system.
     *
     * Currencies outside `wanted` are dropped silently (not a problem, just not needed); currencies
     * inside it that cannot be read are dropped with a log line.
     */
    const quotes = toQuotes(
      [
        row("AUD", "920.00"), // outside this fixture's wanted set
        row("USD", "not a number"), // wanted, unreadable
        row("???", "1234.00"), // unreadable unit
        row("EUR", "1,502.75"), // fine
      ],
      wanted,
      "2026-03-02",
    );
    expect(quotes).toEqual([
      { currencyCode: "EUR", rate: "1502.750000", effectiveDate: "2026-03-02", source: "koreaexim" },
    ]);
  });

  test("an empty response produces no quotes and is not an error", () => {
    /*
     * MOST runs get this. The table is published once per business day around 11:00 KST, so every
     * run before publication, every night, every weekend and every holiday returns `[]` - and the
     * one thing the fetcher must never do is read that as "no rates exist". Friday's quote is the
     * right answer on a Sunday, which is why `fx_rate_latest` is uncapped by age.
     */
    expect(toQuotes([], wanted, "2026-03-02")).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* The write                                                                  */
/* -------------------------------------------------------------------------- */

describe("storing a fetch", () => {
  const quote = (currencyCode: string, rate: string): FxQuote => ({
    currencyCode,
    rate,
    effectiveDate: "2026-03-02",
    source: "koreaexim",
  });

  test("every currency goes in one statement, as an upsert", () => {
    /*
     * The upsert is what makes a five-minute schedule harmless: the upstream publishes once per
     * business day, so all but the first run of the day rewrites the same numbers. A plain INSERT
     * would raise a unique violation 287 times a day, and `DO NOTHING` would never pick up a
     * corrected quote.
     *
     * One multi-row statement rather than a loop, which buys atomicity without a transaction -
     * either every currency moves to today's quote or none does, so there is no window in which the
     * report values USD at today's rate and EUR at Friday's.
     *
     * `created_at` must NOT be in the SET list. It means "when this quote first arrived", and
     * leaving it alone is what makes a late correction visible as a row whose `created_at` is well
     * after its `effective_date`.
     */
    const ops = FxRateUpsertManyOps([quote("USD", "1388.500000"), quote("JPY", "9.123400")]);
    const sql = flat(ops.sql);
    expect(sql).toContain("INSERT INTO fx_rate (currency_code, effective_date, rate, source)");
    expect(sql).toContain("ON CONFLICT (currency_code, effective_date) DO UPDATE");
    expect(sql).toContain("SET rate = EXCLUDED.rate, source = EXCLUDED.source");
    expect(sql).not.toContain("created_at");
    // Two tuples, one statement - not two statements.
    expect(sql.match(/VALUES/g)).toHaveLength(1);
    expect(ops.parameters).toHaveLength(8);
  });

  test("the rate is bound as money so PostgreSQL refuses a malformed one", () => {
    /*
     * `"money"` rather than `"text"` means the cast is `::numeric`, so a rate that somehow got past
     * the parser is rejected by the database instead of being stored as something that compares as
     * text. The date is bound as `date` for the same reason - and because a text comparison would
     * stop `uq_fx_rate_ccy_date` from matching, which would turn the upsert back into an insert.
     */
    const bound = FxRateUpsertManyOps([quote("USD", "1388.5")]).parameters ?? [];
    const kinds = new Map(bound.map((p) => [p.name, p.kind]));
    expect(kinds.get("rate_0")).toBe("money");
    expect(kinds.get("day_0")).toBe("date");
    expect(kinds.get("ccy_0")).toBe("text");
    expect(kinds.get("src_0")).toBe("text");
  });

  test("an empty fetch cannot be expressed as a write", () => {
    /*
     * `VALUES ()` is a syntax error, so this guard is partly mechanical - but the reason it THROWS
     * rather than returning a no-op is a design decision. "An empty fetch means leave the table
     * alone" is a judgement the fetcher has to make explicitly; allowing an empty write would let
     * that judgement be skipped by accident, and the version of this code that clears the table on
     * an empty response is the one that breaks every report on a Sunday.
     */
    expect(() => FxRateUpsertManyOps([])).toThrow(/empty fetch must not write/);
  });

  test("the fetcher's currency list is a closed constant, not a query", () => {
    /*
     * This used to read `SELECT coin_code FROM currency WHERE coin_code <> 'KRW'`, on the argument
     * that the table already IS the list of what the console can submit. The argument had a hole:
     * `currency` is also an ETL TARGET, and legacy COINTB_MAIN is `nvarchar(20)` with nothing
     * constraining its contents - so a house code, a typo or a blank-padded duplicate loaded out of
     * it silently became a currency this Lambda asked the bank about, and then warned about ("the
     * upstream quotes no rate for: ...") on every one of its 288 daily runs, forever.
     *
     * Which currencies the business trades in is a decision people make, reviewed as a code change.
     * The list is therefore pinned here, exactly, so that growing it is deliberate - and so that the
     * accompanying `currency` seed and `COIN_CODES` change cannot be forgotten (the test in
     * neotms.test.ts asserts all three agree).
     */
    expect([...CURRENCY_CODES]).toEqual(["KRW", "USD", "EUR", "JPY", "CNH", "GBP", "HKD"]);
    expect([...FX_CURRENCY_CODES]).toEqual(["USD", "EUR", "JPY", "CNH", "GBP", "HKD"]);
  });

  test("the Chinese currency is CNH, because that is the only one the bank quotes", () => {
    /*
     * CNH is the OFFSHORE yuan and it is what `cur_unit` carries; CNY, the onshore yuan, is absent
     * from the upstream table altogether. So this is not a preference between two spellings of the
     * same thing - a CNY entry in the wanted set would match no row the bank ever sends, which makes
     * it indistinguishable from a currency the bank has stopped quoting: every open position in it
     * falls back to its stored `*_price_ksum` and reports a figure that stopped being true.
     *
     * It is also the right answer on the business facts. A Chinese customer pays this company by
     * international transfer into a Korean account rather than through a domestic Chinese service,
     * and that settles offshore - CNH is the rate the transfer actually clears at.
     *
     * Asserted through `toQuotes` with a realistic row set rather than against the constant alone,
     * because the constant being right is worth nothing if the filter does not match it.
     */
    const quotes = toQuotes(
      [
        { result: 1, cur_unit: "CNH", deal_bas_r: "191.45" },
        { result: 1, cur_unit: "CNY", deal_bas_r: "190.00" }, // never actually sent; ignored if it is
        { result: 1, cur_unit: "HKD", deal_bas_r: "178.52" },
        { result: 1, cur_unit: "GBP", deal_bas_r: "1,750.00" }, // and the separator, on a real code
      ],
      new Set(FX_CURRENCY_CODES),
      "2026-03-02",
    );
    expect(quotes.map((q) => q.currencyCode)).toEqual(["CNH", "HKD", "GBP"]);
    expect(quotes[2]!.rate).toBe("1750.000000");
  });

  test("the bootstrap check stops at the first row", () => {
    /*
     * Asked for one narrow purpose - deciding whether an empty upstream response is routine or is
     * the bootstrap case, which is what licenses spending up to seven extra API calls walking back
     * to the last published business day.
     *
     * `EXISTS` rather than `count(*)`, which would read the whole table to answer a yes/no question
     * that is settled by its first row.
     */
    const sql = flat(FxRateAnyOps().sql);
    expect(sql).toContain("SELECT EXISTS (SELECT 1 FROM fx_rate)");
    expect(sql).not.toMatch(/count\(/i);
  });

  test("the client's read is the view, ordered, with the date attached", () => {
    /*
     * `effective_date` in the projection is load-bearing rather than informational. The view is
     * deliberately uncapped by age, which means a dead fetcher produces OLD numbers rather than no
     * numbers - and the only thing that makes that safe is the date being visible beside the figure
     * in the console.
     */
    const sql = flat(FxRateLatestOps().sql);
    expect(sql).toContain("FROM fx_rate_latest");
    expect(sql).toContain("f.effective_date AS fx_effective_date");
    expect(sql).toContain("ORDER BY f.currency_code");
  });
});

/* -------------------------------------------------------------------------- */
/* The read path                                                              */
/* -------------------------------------------------------------------------- */

describe("the live KRW figure on a list", () => {
  /**
   * A first page, newest first. `sort` carries the resolved `SortTarget` rather than a key, because
   * that is what `readListQuery` hands the ops layer - which is also why the stalled-cursor
   * assertion below can check `JOB_SORTS` directly.
   */
  const listQuery = <K extends string>(sort: { key: K } & { column: string; cast?: string }) => ({
    limit: 50,
    cursor: null,
    sort,
    direction: "desc" as const,
    search: null,
  });
  const jobQuery = listQuery({ key: "created" as const, ...JOB_SORTS.created });
  const poQuery = listQuery({ key: "created" as const, ...PO_SORTS.created });

  test("both list queries carry the shared expression and its join", () => {
    /*
     * The job and PO list footers total the visible page, which makes them statistics screens and
     * puts them under the same rule as the report: they must convert, and they must convert using
     * the ONE definition. A list that summed `job_price_ksum` while the report converted would show
     * a different revenue for the same page, and the discrepancy would be exactly the open
     * positions on it.
     *
     * Compared against the imported constants rather than a pasted CASE, so that editing
     * NeotmsMoney.ts cannot leave this test passing against the old spelling.
     */
    const jobSql = flat(JobListOps(caller, jobQuery, {}).sql);
    expect(jobSql).toContain(`${flat(JOB_KRW)} AS job_price_krw`);
    expect(jobSql).toContain(flat(JOB_KRW_JOIN));

    const poSql = flat(PoListOps(caller, poQuery, {}).sql);
    expect(poSql).toContain(`${flat(PO_KRW)} AS po_price_krw`);
    expect(poSql).toContain(flat(PO_KRW_JOIN));
  });

  test("the booked figure survives alongside the live one", () => {
    /*
     * Two amounts on one row, which looks redundant and is not. `*_price_ksum` is WHAT WAS BOOKED -
     * the figure the form edits and the figure an already-issued invoice carries - and
     * `*_price_krw` is WHAT IT IS WORTH NOW. They are equal for every KRW row and every settled
     * one, which is almost every row, and that is precisely why dropping one would go unnoticed
     * until somebody opened an unexchanged foreign-currency job and found the form prefilled with a
     * number nobody had typed.
     */
    expect(flat(JobListOps(caller, jobQuery, {}).sql)).toContain("job_price_ksum AS job_price_ksum");
    expect(flat(PoListOps(caller, poQuery, {}).sql)).toContain("po_price_ksum AS po_price_ksum");
  });

  test("a zero original-currency total cannot convert a booked figure to zero", () => {
    /*
     * Found by applying db/014 to a throwaway database rather than by reading the expression, which
     * is the only way it shows up: every unit test here spells the CASE correctly, and the row that
     * breaks it is one nobody writes on purpose.
     *
     * The row: foreign currency, no rate, a booked `*_price_ksum`, and a `*_price_sum` of 0 - a
     * legacy nvarchar `''` that arrived as a number. 014's backfill cannot pin its rate, because
     * recovering one means dividing by that zero, so the row stays OPEN and arrives here. And
     * `0 * rate` is 0, not NULL, so a bare multiplication sails straight past the COALESCE and
     * reports an already-invoiced amount as nothing.
     *
     * `NULLIF(sum, 0)` is what routes it to the fallback instead. Asserted on both constants
     * because revenue and cost converting by different rules does not produce a wrong margin, it
     * produces a margin that no screen can explain.
     *
     * Note what is NOT asserted: that a genuinely free-of-charge job reads 0. It still does, by
     * falling back to its stored ksum of 0 - which is why the guard is safe to apply unconditionally
     * inside the open branch.
     */
    for (const expr of [JOB_KRW, PO_KRW]) {
      expect(flat(expr)).toMatch(/COALESCE\(NULLIF\([\w.]+, 0\) \* \w+\.rate, [\w.]+\)/);
      // The bare form, which is what this test exists to keep from coming back.
      expect(flat(expr)).not.toMatch(/COALESCE\([\w.]+ \* \w+\.rate/);
    }
  });

  test("the amount sort stays on a real column, not on the CASE", () => {
    /*
     * THE STALLED-CURSOR GUARD, and the least obvious assertion in this file.
     *
     * Sorting by the live figure is the intuitive follow-up to displaying it, and it breaks the
     * pagination silently. `sortAlias` in NeotmsQuery.ts derives the keyset cursor's row key by
     * slicing the sort target after its first dot, so the target has to be a real qualified column;
     * point it at `JOB_KRW` and the cursor stops advancing with no error at all, repeating the first
     * page forever.
     *
     * So `amount` deliberately sorts on the BOOKED figure, which means an open position can sit a
     * place or two away from where its displayed amount would put it. That is visible and
     * explicable. A list that silently never reaches page two is neither.
     */
    expect(JOB_SORTS.amount.column).toBe("j.job_price_ksum");
    expect(PO_SORTS.amount.column).toBe("po.po_price_ksum");
    for (const target of [...Object.values(JOB_SORTS), ...Object.values(PO_SORTS)]) {
      expect(target.column).not.toMatch(/CASE|fx_rate_latest|jfx\.|pofx\./);
      // One dot, i.e. `alias.column` - which is the shape `sortAlias` can split.
      expect(target.column).toMatch(/^\w+\.\w+$/);
    }
  });
});
