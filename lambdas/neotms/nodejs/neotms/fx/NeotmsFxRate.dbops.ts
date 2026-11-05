// SPDX-License-Identifier: MIT
//
// Reading `fx_rate_latest`, for the one thing the server cannot do on the client's behalf.
//
// Every KRW figure the application REPORTS is converted in SQL - NeotmsMoney.ts is the single
// definition, and the three statistics queries join this same view. So why does the client need the
// rate at all?
//
// Because of one button. 원화로 환산 does not ask the server "what is this worth"; it rewrites the
// row - `coin_code` to KRW, the total to the converted amount, `coin_rate` to 1 - and the user has
// to SEE the number before committing to it. The form also previews 원화 환산 합계 live while the
// amount is being typed, which is a figure that exists only in the unsaved form. Neither of those
// can be answered by a query over stored rows.
//
// ## Read-only, and that is a decision
//
// There is no POST here and no manual-override endpoint, even though `fx_rate.source` documents a
// `'manual'` value. Writing a rate by hand is an operator action with company-wide reach - one row
// moves every open position's reported worth at once - and it belongs in SQL, where it leaves a
// trace, rather than behind a form somebody can reach by accident. If that ever becomes a screen it
// should be a 유지보수 one with its own menu right, not an addition to this module.

import {
  param,
  readBool,
  readMoney,
  readText,
  type SqlOps,
  type SqlParameter,
  type SqlWriteOps,
} from "../../utils/PostgresUtils.js";

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export type FxRateRow = {
  /** ISO 4217, three upper-case letters. Matches `job.coin_code` exactly. */
  currencyCode: string;
  /**
   * KRW per ONE unit of `currencyCode`, as a decimal string.
   *
   * A string rather than a number for the same reason every money field here is: `numeric(18,6)`
   * does not survive a round trip through a JavaScript double, and a rate is the one value in the
   * system that gets MULTIPLIED by a total. The client parses it at the point of use.
   *
   * Per one unit even for JPY, which the upstream quotes per 100 - the fetcher normalises that so
   * nothing downstream has to know which currencies are quoted in hundreds.
   */
  rate: string;
  /**
   * The business date this quote is for, in KST.
   *
   * Sent so the console can print it. The view is deliberately not capped by age
   * (db/014_fx_rates.sql), which means a dead fetcher produces old numbers rather than no numbers -
   * and the only thing that makes that safe is the date being visible beside the figure.
   */
  effectiveDate: string | null;
  /** `'koreaexim'`, or `'manual'` for an operator override. See the column comment. */
  source: string | null;
};

/**
 * One quote, on its way IN. The fetcher's output shape.
 *
 * Deliberately not `FxRateRow` with the nulls dropped. A row that is being WRITTEN has no optional
 * fields - a quote with no date is not a quote - and keeping the two shapes separate means the
 * fetcher cannot satisfy this type by handing over something it read back out of the table.
 */
export type FxQuote = {
  currencyCode: string;
  /** KRW per one unit. Already divided down from a per-100 upstream quote. A decimal string. */
  rate: string;
  /** `YYYY-MM-DD`, the KST business date. */
  effectiveDate: string;
  source: string;
};

/* -------------------------------------------------------------------------- */
/* The read                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every currency's newest quote.
 *
 * All of them in one request rather than one per currency, exactly as `CodeAllOps` does and for the
 * same reason: a job form offers seven currencies and the user may switch between them, so per-
 * currency fetching would mean a round trip - and a Supavisor connection out of forty - every time
 * the dropdown changed. There are at most six rows of short text (KRW is not quoted).
 *
 * KRW is not here and is not missing. Nothing quotes KRW against itself, and the client's conversion
 * is a no-op in that case anyway.
 *
 * Not scoped, and there is nothing to scope: a rate is a fact about a currency, identical for every
 * caller, with no owning staff member and no WHERE clause a scope could narrow. The same argument
 * `handleListCodes` makes for taking no caller.
 */
export const FxRateLatestOps: () => SqlOps<FxRateRow[]> = () => ({
  sql: `
    SELECT f.currency_code  AS fx_currency_code,
           f.rate           AS fx_rate,
           f.effective_date AS fx_effective_date,
           f.source         AS fx_source
      FROM fx_rate_latest f
     ORDER BY f.currency_code
  `,
  parameters: [],
  /*
   * A row whose currency or rate failed to read is DROPPED rather than passed on with an empty
   * string in it. Both columns are NOT NULL in `fx_rate`, so this cannot happen - and if it somehow
   * does, a currency missing from the response makes the button refuse to convert, while a currency
   * present with a rate of `""` makes it convert to zero. One of those is recoverable.
   */
  mapper: (rows) =>
    rows.flatMap((row) => {
      const currencyCode = readText(row, "fx_currency_code");
      const rate = readMoney(row, "fx_rate");
      if (!currencyCode || !rate) return [];
      return [
        {
          currencyCode,
          rate,
          effectiveDate: readText(row, "fx_effective_date"),
          source: readText(row, "fx_source"),
        },
      ];
    }),
});

/* -------------------------------------------------------------------------- */
/* The write, used only by the scheduled fetcher                              */
/* -------------------------------------------------------------------------- */

/*
 * There is deliberately no op here for "which currencies to collect".
 *
 * There was one - `SELECT coin_code FROM currency WHERE coin_code <> 'KRW'` - on the argument that
 * the table already IS the list of what the console can submit. It is now the constant
 * `FX_CURRENCY_CODES` in NeotmsCurrency.ts, because `currency` is an ETL target as well as a lookup:
 * a house code or a typo loaded out of legacy COINTB_MAIN became a currency the fetcher asked the
 * bank about, and then warned about on every one of its 288 daily runs. That module's header has the
 * full reasoning and the test that keeps the constant, the seed and `COIN_CODES` in step.
 */

/**
 * Whether `fx_rate` has ever held a row.
 *
 * Asked by the fetcher for one narrow purpose: deciding whether an empty upstream response is
 * routine or is the bootstrap case. See its header - the answer determines whether it is allowed to
 * spend extra API calls walking back to the last published business day.
 *
 * `EXISTS` rather than `count(*)`, so it stops at the first row.
 */
export const FxRateAnyOps: () => SqlOps<boolean> = () => ({
  sql: `SELECT EXISTS (SELECT 1 FROM fx_rate) AS fx_any`,
  parameters: [],
  // `readBool` rather than a `=== true` comparison: `bool` is not in the pinned-to-text OID list, so
  // whether `pg` hands this back as a boolean or as "t" is the driver's business, not this module's.
  mapper: (rows) => readBool(rows[0] ?? {}, "fx_any") ?? false,
});

/**
 * Every quote from one fetch, in one statement.
 *
 * `ON CONFLICT (currency_code, effective_date)` is `uq_fx_rate_ccy_date`, and the upsert is what
 * makes a five-minute schedule harmless: the upstream publishes once per business day, so all but
 * the first run of the day re-writes the same numbers. A plain INSERT would raise a unique violation
 * 287 times a day, and `DO NOTHING` would never pick up a corrected quote.
 *
 * One multi-row statement rather than a loop of single upserts, which buys two things. It is one
 * round trip instead of five - and under Supavisor transaction mode a round trip holds a pooled
 * backend that every other caller is waiting for. And it is atomic without a transaction: either
 * every currency moves to today's quote or none does, so there is no window in which the report
 * values USD at today's rate and EUR at Friday's.
 *
 * `created_at` is left to its default on insert and NOT touched on update, so it keeps meaning "when
 * this quote first arrived" - which is what makes a late correction visible as a row whose
 * `created_at` is well after its `effective_date`.
 *
 * Returns the number of rows written. An EMPTY `quotes` ARRAY IS NOT ACCEPTED: `VALUES ()` is a
 * syntax error, and more to the point the fetcher must decide what an empty fetch means (it means
 * "leave the table alone") rather than expressing it as a no-op write. Guarded by a throw so that
 * the decision cannot be skipped by accident.
 */
export const FxRateUpsertManyOps: (quotes: readonly FxQuote[]) => SqlWriteOps = (quotes) => {
  if (quotes.length === 0) {
    throw new Error("FxRateUpsertManyOps called with no quotes; an empty fetch must not write.");
  }
  const parameters: SqlParameter[] = [];
  const tuples = quotes.map((quote, i) => {
    parameters.push(
      param(`ccy_${String(i)}`, quote.currencyCode, "text"),
      param(`day_${String(i)}`, quote.effectiveDate, "date"),
      // "money" rather than "text", so the cast is `::numeric` and a malformed rate is refused by
      // PostgreSQL rather than stored as something that compares as text.
      param(`rate_${String(i)}`, quote.rate, "money"),
      param(`src_${String(i)}`, quote.source, "text"),
    );
    return `(:ccy_${String(i)}, :day_${String(i)}, :rate_${String(i)}, :src_${String(i)})`;
  });
  return {
    sql: `
      INSERT INTO fx_rate (currency_code, effective_date, rate, source)
      VALUES ${tuples.join(", ")}
      ON CONFLICT (currency_code, effective_date) DO UPDATE
         SET rate   = EXCLUDED.rate,
             source = EXCLUDED.source
    `,
    parameters,
  };
};
