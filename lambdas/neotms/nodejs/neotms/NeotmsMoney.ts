// SPDX-License-Identifier: MIT
//
// The KRW figure, and the one place that decides what it is.
//
// ## Settled money is frozen; open money floats
//
// A job or purchase order is denominated in `coin_code` and totalled in `*_price_sum`. Turning that
// into the KRW figure the reports add up has exactly three cases, and `coin_rate` is what tells
// them apart:
//
//   | currency      | rate      | meaning                | KRW figure                      |
//   |---------------|-----------|------------------------|---------------------------------|
//   | KRW (or NULL) | anything  | already won            | the stored `*_price_ksum`       |
//   | foreign       | not null  | SETTLED - was exchanged| the stored `*_price_ksum`       |
//   | foreign       | NULL      | OPEN - not exchanged   | `*_price_sum` x today's rate    |
//
// The reason the third row exists at all is that an unexchanged foreign receivable has no fixed
// worth in KRW. Its value moves with the currency until somebody actually converts it, so a report
// that keeps quoting the rate from the day the job was booked is quoting a number that stopped
// being true - while one that re-converts at today's rate is answering the question the reader is
// actually asking ("what is this book worth").
//
// The reason the first two rows exist is the mirror of that. Once money has been exchanged, its KRW
// amount is a historical fact: it was invoiced at that figure, and a report of a closed quarter must
// reproduce it on every run, forever. `*_price_ksum` is that fact - and it may have been
// hand-adjusted after a negotiation, which is the second reason nothing here recomputes it.
//
// So "exchange it" and "freeze it" are the same operation, and the console performs it as one: the
// 원화로 환산 button rewrites `coin_code` to KRW, `*_price_sum` to the converted amount and
// `coin_rate` to 1. No extra column, no boolean, no state machine - the row simply moves from the
// third case to the first. db/014_fx_rates.sql is the authority on the model.
//
// ## Why this is a module and not three copied CASE expressions
//
// Five queries need this figure: the margin report, both dashboards, the project rollup, and the
// job and purchase order lists (whose footers total the page, so they are statistics too). If any
// one of them spelled the rule differently, two screens would report different revenue for the same
// job and neither would look wrong. There is one definition here and one `fx_rate_latest` view in
// the database, and that is deliberate duplication-avoidance of the kind the margin number earns.
//
// ## The fallback, and why it is `*_price_ksum` rather than zero
//
// `COALESCE(NULLIF(sum, 0) x rate, ksum)` - if `fx_rate_latest` has no quote for the currency, the
// LEFT JOIN yields NULL, the multiplication yields NULL, and the expression falls back to the
// stored figure. That matters on day one, when `fx_rate` is empty because the scheduled fetcher has
// not run yet: every amount reads exactly as it did before this change rather than collapsing to
// zero. It matters again for a house currency nobody is collecting quotes for. Falling back to zero
// would make a missing quote look like a quiet quarter, which is the failure mode db/004_rollup.sql
// exists to warn about.
//
// The `NULLIF` extends the same protection to a row with no original-currency total to convert -
// see `krwAmount`. Both guards exist so that one rule holds without exception: THIS EXPRESSION
// NEVER TURNS A BOOKED KRW FIGURE INTO ZERO.
//
// ## What is deliberately NOT here
//
// Any notion of a rate "as at" a date. The open case uses the newest quote, full stop - because an
// open position's worth is its worth now, not its worth on its delivery date. A report of last
// March re-run today therefore gives last March's settled rows their original figures and values
// March's still-open rows at today's rate, which is the honest answer to "what is this worth" and
// the only one the data supports: `fx_rate` is populated going forward by the fetcher, so it has no
// history before this feature shipped to look a past rate up in.

/**
 * The join that makes `krwAmount` work.
 *
 * LEFT, always. An INNER join would drop every KRW row (nothing quotes KRW against itself) and
 * every row in a currency with no quote yet - silently, as missing revenue.
 *
 * @param fx    alias to give the view
 * @param coinCode  the qualified currency column to match on, e.g. `j.coin_code`
 */
export function krwJoin(fx: string, coinCode: string): string {
  return `LEFT JOIN fx_rate_latest ${fx} ON ${fx}.currency_code = ${coinCode}`;
}

/**
 * The KRW figure, as a SQL expression. See the header for the three cases.
 *
 * `COALESCE(coinCode, 'KRW') <> 'KRW'` rather than `coinCode <> 'KRW'`: a NULL currency compares
 * NULL to everything, so the bare form would send a currency-less row - of which there are plenty,
 * since `coin_code` is nullable - down the ELSE branch by accident rather than by decision. It
 * belongs there, but for the stated reason: no currency means the amount is already KRW.
 *
 * `NULLIF(sum, 0)` rather than a bare `sum`, so that a row with no original-currency total converts
 * to NULL and therefore falls back to its stored figure instead of to zero. Without it, a legacy
 * row holding a booked KRW figure against a zero `*_price_sum` - an nvarchar `''` that arrived as 0
 * - has that figure restated to 0 the moment this expression goes live, because `0 * rate` is not
 * NULL and so `COALESCE` never reaches the fallback. That is the one case db/014's backfill cannot
 * pin shut from its side: it skips a zero total because 0/0 yields no rate to recover, which leaves
 * the row OPEN and hands the problem here. Zero is also the dangerous direction to be wrong in -
 * it deflates revenue silently, the "quiet quarter" failure the header warns about. A genuinely
 * free-of-charge job is unaffected: its stored ksum is 0 too, so it still reads 0, by fallback
 * rather than by multiplication.
 */
export function krwAmount(cols: {
  /** Qualified currency column, e.g. `j.coin_code`. */
  coinCode: string;
  /** Qualified rate column, e.g. `j.coin_rate`. NULL here is what "open" means. */
  coinRate: string;
  /** Qualified original-currency total, e.g. `j.job_price_sum`. */
  sum: string;
  /** Qualified stored KRW total, e.g. `j.job_price_ksum`. */
  ksum: string;
  /** The alias given to `fx_rate_latest` by the matching `krwJoin`. */
  fx: string;
}): string {
  return `CASE
                 WHEN COALESCE(${cols.coinCode}, 'KRW') <> 'KRW' AND ${cols.coinRate} IS NULL
                 THEN COALESCE(NULLIF(${cols.sum}, 0) * ${cols.fx}.rate, ${cols.ksum})
                 ELSE ${cols.ksum}
               END`;
}

/** Revenue in KRW for a `job` aliased `j`, with `fx_rate_latest` aliased `jfx`. */
export const JOB_KRW = krwAmount({
  coinCode: "j.coin_code",
  coinRate: "j.coin_rate",
  sum: "j.job_price_sum",
  ksum: "j.job_price_ksum",
  fx: "jfx",
});

/** The join `JOB_KRW` requires. */
export const JOB_KRW_JOIN = krwJoin("jfx", "j.coin_code");

/** Cost in KRW for a `purchase_order` aliased `po`, with `fx_rate_latest` aliased `pofx`. */
export const PO_KRW = krwAmount({
  coinCode: "po.po_coin_code",
  coinRate: "po.po_coin_rate",
  sum: "po.po_price_sum",
  ksum: "po.po_price_ksum",
  fx: "pofx",
});

/** The join `PO_KRW` requires. */
export const PO_KRW_JOIN = krwJoin("pofx", "po.po_coin_code");
