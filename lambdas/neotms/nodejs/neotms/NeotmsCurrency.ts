// SPDX-License-Identifier: MIT
//
// The currencies this company trades in, as a closed list.
//
// Seven, fixed here in code: KRW (the default every form opens on) plus USD, EUR, JPY, CNH, GBP and
// HKD. Everything that needs to know "which currencies exist" reads this - the rate fetcher asks the
// bank for exactly these, db/010_currency.sql seeds exactly these, and the console offers exactly
// these as `COIN_CODES` in frontend/src/apis/neotms.codes.ts.
//
// ## Why a constant and not a query
//
// The fetcher used to read its list from `SELECT coin_code FROM currency`, on the argument that the
// table already IS the list of what the console can submit. That argument was wrong in one direction
// that matters: `currency` is also an ETL TARGET. Legacy COINTB_MAIN is `nvarchar(20)` with no
// constraint on its contents, so a house code, a typo or a blank-padded duplicate loaded from it
// became, silently, a currency the fetcher asked the bank about - and then logged as "the upstream
// quotes no rate for: ..." on every run, forever, at twelve runs an hour. The list of currencies the
// business trades in is a business decision made by people, which is to say a code change with a
// review on it; it is not a fact to be discovered from whatever happens to be in a lookup table.
//
// The direction the old argument got right is still honoured, by a test rather than by a query:
// every code here must have a row in `currency`, because `coin_code` is the target of ten restricting
// foreign keys across nine tables and a currency the console offers without a parent row makes every
// save that picks it fail with a constraint name (db/010_currency.sql's header is the long version).
// So the pair is checked in `test/neotms.test.ts` instead of being reconciled at runtime.
//
// ## CNH and not CNY
//
// The bank quotes the offshore yuan, and its `cur_unit` is `CNH`. CNY - the onshore yuan - is not in
// the upstream table at all, so a job denominated in it could never receive a live rate. The choice
// is also the correct one on the business facts rather than merely the convenient one: a Chinese
// customer paying this company pays into a Korean bank account by international transfer, which is an
// offshore settlement, and CNH is the rate that transfer actually clears at.
//
// CNY is therefore RETIRED rather than deleted. It stays seeded in `currency` (that row is the parent
// of any legacy or ETL-loaded CNY job) but is absent from this list and from `COIN_CODES`, which has
// three consequences, all of them wanted: no new row can be booked in it, `codeOptions` renders an
// existing one as `CNY (등록되지 않은 값)` rather than silently snapping the field to KRW, and the
// fetcher stops asking for a quote that never existed. An open CNY position reports its stored
// `*_price_ksum` - see NeotmsMoney.ts - which is the same answer it gave before this change, and the
// "currencies in use with no quote" query at the foot of db/014_fx_rates.sql is where it surfaces.
//
// ## What is deliberately NOT here
//
// A valibot picklist on `coinCode`. Rejecting an unlisted currency at the schema would mean a job
// carrying a retired one - CNY, or a legacy house code the ETL loaded - could not be SAVED at all,
// so the first person to correct a typo on such a job would be told their currency is invalid on a
// field they did not touch. That is the exact shape of the defect db/010_currency.sql exists to
// document. The gate on new data is the dropdown; the gate on garbage is the foreign key.

/**
 * Every currency the console offers, in the order the dropdown shows them.
 *
 * KRW first because it is the default: all five registration forms open with it already selected
 * (`?? 'KRW'`) and send it whether or not anybody touched the field.
 *
 * The matched pair of `COIN_CODES` in `frontend/src/apis/neotms.codes.ts` and of the INSERT in
 * db/010_currency.sql. A test asserts all three agree, because there is no endpoint between them -
 * unlike `sys_code`, nothing serves this list to the client.
 */
export const CURRENCY_CODES = ["KRW", "USD", "EUR", "JPY", "CNH", "GBP", "HKD"] as const;

/** The house currency. Reported figures are in this; `coin_code = 'KRW'` means "no conversion". */
export const KRW = "KRW";

/**
 * The currencies the scheduled fetcher collects a quote for.
 *
 * `CURRENCY_CODES` minus KRW, and the subtraction is the point: nothing quotes KRW against itself, so
 * asking for it would guarantee one permanent "currency in use with no quote" row in the diagnostic
 * at the foot of db/014_fx_rates.sql - a warning that cannot be acted on is a warning nobody reads.
 *
 * Six of the twenty-three-odd currencies the upstream publishes. Filtering to these is what keeps
 * `fx_rate` to the rows some query will actually join: storing the whole table every five minutes
 * would be some 6,600 pointless upserts a day.
 */
export const FX_CURRENCY_CODES: readonly string[] = CURRENCY_CODES.filter((code) => code !== KRW);
