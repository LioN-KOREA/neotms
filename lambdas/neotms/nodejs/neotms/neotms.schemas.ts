// SPDX-License-Identifier: MIT
//
// What the API accepts. One file, because these shapes are the contract the frontend is written
// against and a contract is easier to read in one place than in five.
//
// Three conventions run through all of it, and each exists because of something the legacy system
// got wrong:
//
// ## Money is a string, never a number
//
// `numeric(18,2)` exceeds the 53 bits of integer precision a JS number has, and JSON has no decimal
// type. A price that arrives as the JSON number `1234567890123456.78` is already wrong before any
// code touches it. So amounts travel as decimal strings, are validated as decimal strings, and are
// sent to PostgreSQL as strings on a placeholder cast to `numeric` (see `param` and `CASTS` in
// PostgresUtils), so the server parses the decimal and no float is ever involved. Nothing in
// this codebase performs arithmetic on a currency amount in JavaScript - the totals are computed in
// SQL, where `numeric` arithmetic is exact. The legacy system stored amounts in `nvarchar` and
// converted per row, which is how a yearly report came to take minutes; converting them to floats
// on the way in would be a different, quieter version of the same mistake.
//
// ## Ids are strings
//
// `bigint` primary keys, returned as strings by node-postgres - its default `int8` parser hands
// back a string precisely because the type does not fit a JS number, and `registerTypeParsers` in
// PostgresUtils pins that so a dependency update cannot change it. Kept as strings end to end so
// nothing rounds, and so an id is never accidentally arithmetic.
//
// ## Dates and times are separate, and they are strings
//
// The schema keeps `prj_sday date` and `prj_sday_time time` as two columns because the UI edits
// them separately and the time is usually absent - a single timestamp cannot represent "due on the
// 5th, time not yet agreed". The API mirrors that rather than papering over it, which also means no
// timezone ever has to be guessed: a date has no timezone, and a timestamp with an assumed one is
// the classic way a KST deadline becomes the previous day.

import * as v from "valibot";

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A decimal amount, as a string.
 *
 * A JSON number is accepted and converted, because a frontend form field that holds `0` is easy to
 * produce by accident - but it is converted through `String`, not through any decimal maths, so an
 * integer amount survives exactly. The regex is what stops `"1e9"`, `"0x10"`, `"١٢٣"` and `""`
 * reaching PostgreSQL, each of which fails somewhere less obvious than here.
 */
export const MoneySchema = v.pipe(
  v.union([v.string(), v.number()]),
  v.transform(String),
  v.regex(/^-?\d{1,16}(\.\d{1,2})?$/, "must be a decimal amount with at most two decimal places"),
);

/** A volume: word counts, pages, hours. Fractional, hence the two decimal places. */
export const VolumeSchema = v.pipe(
  v.union([v.string(), v.number()]),
  v.transform(String),
  v.regex(/^-?\d{1,12}(\.\d{1,2})?$/, "must be a number with at most two decimal places"),
);

/**
 * A captured FX rate. Six decimal places, matching `numeric(18,6)`.
 *
 * Supplied by the client rather than looked up, because it is the rate used AT TRANSACTION TIME and
 * a report re-run in three years has to reproduce the original figure. See the comment on
 * `job.coin_rate`.
 */
export const RateSchema = v.pipe(
  v.union([v.string(), v.number()]),
  v.transform(String),
  v.regex(/^\d{1,12}(\.\d{1,6})?$/, "must be a positive number with at most six decimal places"),
);

/** `YYYY-MM-DD`. Checked for shape here and for validity by PostgreSQL, which knows about February. */
export const DateSchema = v.pipe(
  v.string(),
  v.trim(),
  v.regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date in YYYY-MM-DD form"),
);

/** `HH:MM` or `HH:MM:SS`. The legacy data holds the two-part form (e.g. '18:00'). */
export const TimeSchema = v.pipe(
  v.string(),
  v.trim(),
  v.regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, "must be a time in HH:MM form"),
);

/** A `bigint` primary key, as a string of digits. */
export const IdSchema = v.pipe(v.string(), v.trim(), v.regex(/^\d{1,19}$/, "must be a record id"));

/** A `sys_code.code` or `currency.coin_code` value. Validated by the FK, not by a list here. */
export const CodeSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100));

/** Free text with a sane ceiling. The columns are `text`; the limit is about forms, not storage. */
const text = (max = 500) => v.pipe(v.string(), v.trim(), v.maxLength(max));

/**
 * A field that may be set to a value or explicitly cleared.
 *
 * `nullable` is what carries "clear this", and `optional` is what carries "do not touch this". Both
 * are needed and they are not the same: without the first a due date could never be removed once
 * set, and without the second a PATCH of one field would blank every other.
 */
const settable = <S extends v.GenericSchema>(schema: S) => v.optional(v.nullable(schema));

/* -------------------------------------------------------------------------- */
/* Customer                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Creating a customer.
 *
 * `cusName` is the only required field. That is deliberate and it matches how the work actually
 * arrives: a salesperson gets a company name and a phone number, and the billing address, currency
 * and rate band are filled in later. Requiring them up front produces placeholder rows ("미정",
 * "000-0000-0000"), which are worse than nulls because they look like data.
 *
 * `cusCode` is absent on purpose - it is minted from a sequence (see NeotmsCodes), never supplied.
 *
 * `cusUpro` was here and was removed. "UPRO" is 사용 프로그램 - which CAT tool the counterparty
 * works in - and most clients of this company do not send translation work, so the field was a
 * required-looking box with no answer. The column survives for the ETL and is still read (see
 * CustomerRow.cusUpro); nothing can write it. `v.object` strips unknown keys rather than rejecting
 * them, so a browser still running yesterday's bundle and still posting `cusUpro` has it quietly
 * dropped instead of being handed a validation error for a field its user never saw.
 */
export const CustomerCreateSchema = v.object({
  cusName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)),
  cusEmail: settable(text(300)),
  cusPhone: settable(text(100)),
  cusZip: settable(text(20)),
  cusAddr: settable(text(1000)),
  /** Free text, not an ISO code: the legacy values are inconsistent Korean/English country names. */
  cusNation: settable(text(100)),
  cusCoin: settable(CodeSchema),
  /** Minimum charge per job, in `cusCoin`. */
  cusMincost: settable(MoneySchema),
  /** 분야. A `sys_code` code in the 'FIELD' domain - the screen picks it from a dropdown. */
  cusField: settable(CodeSchema),
  active: v.optional(v.boolean()),
});

/** Editing a customer. Every field optional; omitted means unchanged. */
export const CustomerUpdateSchema = v.partial(CustomerCreateSchema);

/* -------------------------------------------------------------------------- */
/* Translator                                                                 */
/* -------------------------------------------------------------------------- */

export const TranslatorCreateSchema = v.object({
  tranName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)),
  tranPhone: settable(text(100)),
  tranEmail: settable(text(300)),
  /** Alternate spellings and romanisations, so the same person is not registered twice. */
  tranDup: settable(text(500)),
  /** The note a PM sees when assigning: availability caveats, quality warnings. */
  tranMsg: settable(text(2000)),
  tranWorkCon: settable(CodeSchema),
  tranCatUse: v.optional(v.boolean()),
  /** How the fee is computed. Unconstrained text - the legacy value set is unconfirmed. */
  tranCalc: settable(text(50)),
  tranUpro: settable(CodeSchema),
  tranField: settable(CodeSchema),
  /** The domain this translator will NOT take. */
  tranUnfield: settable(CodeSchema),
  tranCoin: settable(CodeSchema),
  tranGive: settable(text(100)),
  /**
   * Withholding tax. A STRING, not a number: at `nvarchar(20)` the legacy column could hold either
   * a rate (3.3) or a classification code, and typing it numeric would reject half the real data.
   */
  tranIctax: settable(text(50)),
  tranBank: settable(text(200)),
  /** Text, not a number - leading zeros and hyphens are significant in an account number. */
  tranAcc: settable(text(100)),
  tranPaypal: settable(text(300)),
  /** When the translator was onboarded. A business fact, distinct from the row's `created_at`. */
  tranRegDay: settable(DateSchema),
  active: v.optional(v.boolean()),
});

export const TranslatorUpdateSchema = v.partial(TranslatorCreateSchema);

/* -------------------------------------------------------------------------- */
/* Project                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Creating a project.
 *
 * `customerId` is required even though the column is nullable. A project with no customer cannot be
 * invoiced and cannot appear in any report dimension, so it is a row that exists only to be fixed
 * later - and the legacy table is full of them.
 *
 * The denormalised name columns (`prj_mgr_name`, `cus_code_name`, ...) are NOT accepted from the
 * client. They are copies of rows this database already holds, and taking them from a request would
 * let a caller write a customer name that disagrees with the customer id - which is exactly the
 * sort of disagreement the list screen then displays as fact. They are filled in from the
 * referenced rows by the dbops layer.
 */
export const ProjectCreateSchema = v.object({
  prjName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  customerId: IdSchema,
  /** Which group entity invoices this project, and therefore whose letterhead is used. */
  corpId: settable(IdSchema),
  coinCode: settable(CodeSchema),
  /** The SALES manager, who owns the customer relationship. */
  prjMgrId: settable(IdSchema),
  /** The PROJECT manager, who delivers the work. A different person, and a different report axis. */
  prjPmId: settable(IdSchema),
  customerContactId: settable(IdSchema),
  prjField: settable(CodeSchema),
  prjField2: settable(CodeSchema),
  prjState: settable(text(50)),
  prjInvoiceState: settable(text(50)),
  prjMoneyState: settable(text(50)),
  prjSday: settable(DateSchema),
  prjSdayTime: settable(TimeSchema),
  prjEday: settable(DateSchema),
  prjEdayTime: settable(TimeSchema),
  prjContent: settable(text(5000)),
});

export const ProjectUpdateSchema = v.partial(ProjectCreateSchema);

/* -------------------------------------------------------------------------- */
/* Job  (revenue)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Creating a job. REVENUE IS BOOKED HERE.
 *
 * `jobPriceSum` (original currency) and `jobPriceKsum` (KRW) are accepted from the client rather
 * than computed from volume x price. That looks wrong and is not: the legacy screens let a PM
 * override a total after a negotiated adjustment, every historical row was produced that way, and
 * silently recomputing the total would change already-invoiced figures the moment anyone edited an
 * unrelated field on an old job. The computed value belongs in the UI, as a default the user can
 * see and accept.
 *
 * `coinRate` is likewise supplied, not looked up: it is the rate used at transaction time, and a
 * report re-run years later must reproduce the original number. Today's rate would not.
 */
export const JobCreateSchema = v.object({
  projectId: IdSchema,
  jobName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  workCode: settable(CodeSchema),
  jobPmId: settable(IdSchema),
  /**
   * 업무 구분 - a `JOBTYPE` code: LINGUISTICS, MICE or IMC. Decides which of the two fields below
   * applies, and therefore which detail table the job's payload lands in (db/011_job_types.sql).
   *
   * Optional, and absent means LINGUISTICS. Not because the type is unimportant but because the
   * ETL and every pre-existing client omit it, and the column's DEFAULT is the same value - a
   * required field here would reject exactly the requests that are correct by default.
   */
  jobType: settable(CodeSchema),
  jobSlang: settable(CodeSchema),
  /** Target language ("ELANG" = end language). */
  jobElang: settable(CodeSchema),
  /**
   * 업무 분류 - a `JOBCAT` code, for a MICE or IMC job. Any of the four is valid on either type;
   * the business has no type-to-category mapping.
   *
   * Deliberately NOT part of a discriminated union with `jobSlang` / `jobElang`. A `v.variant` on
   * `jobType` would make the type mandatory on every PATCH body and would reject a job that has
   * neither a language nor a category - and jobs in exactly that state exist by the thousand. The
   * enforcement that a MICE job cannot carry a language pair is in the database, where it holds for
   * the ETL too; see the constraint section of db/011_job_types.sql.
   */
  jobCategory: settable(CodeSchema),
  jobVolume: settable(VolumeSchema),
  unitCode: settable(CodeSchema),
  /** How the price was arrived at (rate card vs manual override). Value set unconfirmed. */
  jobPriceSel: settable(text(50)),
  jobPrice: settable(MoneySchema),
  /** Ambiguous in the legacy data - amount or percentage. Treated as an amount; see the DDL. */
  jobPriceDis: settable(MoneySchema),
  coinCode: settable(CodeSchema),
  coinRate: settable(RateSchema),
  /** Total in the original currency. */
  jobPriceSum: settable(MoneySchema),
  /** Total in KRW. This is the column the reports sum as revenue. */
  jobPriceKsum: settable(MoneySchema),
  jobSday: settable(DateSchema),
  jobSdayTime: settable(TimeSchema),
  /**
   * Delivery date, and the business date the reports recognise this job's revenue on. Leaving it
   * blank keeps the job out of every report, for any range: a report is a date range, and an
   * undated job belongs in none of them.
   */
  jobEday: settable(DateSchema),
  jobEdayTime: settable(TimeSchema),
  jobMemo: settable(text(5000)),
  jobState: settable(text(50)),
});

/**
 * Editing a job.
 *
 * `projectId` is removed rather than made optional. A job CAN be moved between projects - the
 * legacy system journalled it in LOG_JOB - but moving one relocates booked revenue between
 * customers and report dimensions, so it is its own operation with its own audit record, not a
 * field on a general edit form.
 */
export const JobUpdateSchema = v.partial(v.omit(JobCreateSchema, ["projectId"]));

/* -------------------------------------------------------------------------- */
/* Purchase order  (cost)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Creating a purchase order. COST IS BOOKED HERE.
 *
 * `jobId` is required and `projectId` is not accepted: the PO's project is derived from the job, so
 * accepting both would allow a PO whose project disagrees with its job's - a disagreement that
 * shows up as revenue and cost landing on different report lines, i.e. as a wrong margin on two
 * reports at once.
 */
export const PurchaseOrderCreateSchema = v.object({
  jobId: IdSchema,
  poName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
  poWorkCode: settable(CodeSchema),
  /** Was a CAT-tool analysis used to price this PO rather than a flat volume. */
  poCatUse: v.optional(v.boolean()),
  poCatWord: settable(VolumeSchema),
  poCatMid: settable(VolumeSchema),
  poCatStotal: settable(VolumeSchema),
  poPmId: settable(IdSchema),
  /** The vendor being paid. */
  translatorId: settable(IdSchema),
  /**
   * 업무 구분 - a `JOBTYPE` code, exactly as on a job, and **independent of the job's own type**.
   *
   * Independent because the real cases demand it: a MICE conference buys interpretation (a
   * LINGUISTICS PO on a MICE job), and a translation project buys event staffing. Tying the PO's
   * type to its job's would make both unrecordable.
   *
   * Absent on create means "the job's type" - the manager reads it from the job rather than
   * defaulting to LINGUISTICS, because a PO raised against a MICE job is a MICE PO far more often
   * than not. Absent on update means "leave it alone".
   */
  poType: settable(CodeSchema),
  poSlang: settable(CodeSchema),
  poElang: settable(CodeSchema),
  /**
   * 업무 분류 - a `JOBCAT` code, for a MICE or IMC purchase order. Any of the four is valid on
   * either type.
   *
   * Not a discriminated union with `poSlang` / `poElang`, for the reasons recorded on
   * `JobCreateSchema.jobCategory`. The database holds the line; see db/011_job_types.sql.
   */
  poCategory: settable(CodeSchema),
  poVolume: settable(VolumeSchema),
  poUnitCode: settable(CodeSchema),
  poPriceSel: settable(text(50)),
  poPrice: settable(MoneySchema),
  poCoinCode: settable(CodeSchema),
  poCoinRate: settable(RateSchema),
  poPriceSum: settable(MoneySchema),
  /** KRW total. This is the column the reports sum as cost. */
  poPriceKsum: settable(MoneySchema),
  /**
   * Withholding/VAT rate - `3.3` for the Korean 3.3% withholding.
   *
   * Read as a rate on inference, not on evidence: all three legacy tax columns were
   * `nvarchar(200)`, so any of them could hold an amount. The DDL comment on
   * `purchase_order.po_tax` is the authority and carries the query that settles it.
   *
   * `RateSchema` is the right schema under EITHER reading, which is why this field does not need to
   * change when the question is settled. It accepts up to twelve integer digits, so an amount in
   * KRW passes; the column is `numeric(18,3)`, so an amount stores without overflowing. The only
   * casualty of the wrong guess is precision beyond three decimals, which no tax rate or currency
   * amount has.
   */
  poTax: settable(RateSchema),
  poTaxPrice: settable(MoneySchema),
  /** Total including tax - what is actually remitted to the translator. */
  poTaxSum: settable(MoneySchema),
  poSday: settable(DateSchema),
  poSdayTime: settable(TimeSchema),
  /** The deadline the translator must deliver by. */
  poEday: settable(DateSchema),
  poEdayTime: settable(TimeSchema),
  /** Which language the PO DOCUMENT is rendered in - not a translation language. */
  poLang: settable(text(20)),
  poContent: settable(text(5000)),
  poState: settable(text(50)),
  poInvoiceState: settable(text(50)),
  poMoneyState: settable(text(50)),
  poMoneyDay: settable(DateSchema),
  poMoneyPrice: settable(MoneySchema),
  poMoneyGubun: settable(text(50)),
});

/** Editing a PO. `jobId` is fixed for the same reason a job's project is - see JobUpdateSchema. */
export const PurchaseOrderUpdateSchema = v.partial(v.omit(PurchaseOrderCreateSchema, ["jobId"]));

/* -------------------------------------------------------------------------- */
/* 결제 - approval, settlement, and the translator invoice                     */
/* -------------------------------------------------------------------------- */

/**
 * Approving - or un-approving - a purchase order. One boolean, and that is the entire body.
 *
 * ## Why a route of its own rather than a field on `PurchaseOrderUpdateSchema`
 *
 * Because the authority is different and a schema cannot express that; only the route table can. A
 * PM edits POs all day under `PURCHASE_ORDER:update`. Signing off the amount belongs to whoever
 * holds `PAYMENT:update` (see NeotmsMenus.PAYMENT). Put `poApproved` on the general edit body and
 * every PM who may correct a word count may also approve their own PO, which is not an approval
 * gate - it is a formality with extra steps.
 *
 * So `po_approved` has no `PO_FIELDS` spec and cannot be written by any PO edit. This body, through
 * this route, is the only way the column moves.
 *
 * ## Why it is `{ approved: boolean }` and not a bare POST
 *
 * Un-approving has to be expressible. A PO approved by mistake - wrong translator, wrong amount -
 * must be revocable before it is sent, and the alternative is a second route whose only difference
 * is a literal. `po_approved_at` and `po_approved_by` are stamped server-side from `now()` and the
 * caller's identity and are deliberately NOT in this body: a client-supplied "who approved this,
 * and when" is not an audit trail.
 */
export const PoApprovalSchema = v.object({ approved: v.boolean() });

/**
 * Recording what happened to the money on a purchase order.
 *
 * Picked from `PurchaseOrderCreateSchema` rather than restated, so the two cannot drift: these are
 * the same six columns, reached through a different gate. The narrowing is the point - this body
 * can move a PO to 완료 and mark it 정산완료, and it cannot touch an amount, a volume, a rate, a
 * deadline or a translator. Someone who may confirm a payment is not thereby someone who may change
 * what was owed.
 *
 * `poState` is included because settling the money IS what advances the workflow - 완료 means paid
 * in full (NeotmsPoStates.ts), so the state and the money state are set in the same request or they
 * are set inconsistently. 부분정산 stays at 납품 for the same reason.
 */
export const PoSettlementSchema = v.partial(
  v.pick(PurchaseOrderCreateSchema, [
    "poState",
    "poInvoiceState",
    "poMoneyState",
    "poMoneyDay",
    "poMoneyPrice",
    "poMoneyGubun",
  ]),
);

/**
 * Issuing a translator invoice.
 *
 * ## One invoice, several POs
 *
 * `poIds` is the whole reason this is a table and not a handful of columns on `purchase_order`. The
 * printed form is headed LIST OF INVOICE and bills up to ten POs under one code with one Sub Total
 * / Tax / Total, so the invoice needs an identity that no single PO row can hold. The ids are what
 * `purchase_order.invoice_translator_id` is set to, and that column is what the document is
 * rendered from - see db/015_payment.sql section 2.
 *
 * It is REQUIRED and must be non-empty. An invoice billing nothing is a document with a total of
 * zero sent to a translator who is owed money, which is the silent-arithmetic failure this whole
 * design is arranged to prevent. The manager additionally refuses POs that belong to another
 * translator, are not yet 납품, or are already on a different invoice - none of which a schema can
 * check, because all three are questions about rows.
 *
 * `invTranCode` is absent: minted from `seq_invoice_tran_code` (NeotmsCodes.INVOICE_TRAN_CODE),
 * never supplied, for the reason every other document code is.
 *
 * ## What is NOT here, and why
 *
 * No document-language field. The PO stores `po_lang` because the PO is addressed and sent; an
 * invoice is reprinted on demand, and which of the two letterheads is wanted is a question for the
 * moment of printing rather than a fact about the record. The print screen carries the toggle.
 *
 * No payment status either, beyond what the translator's own paperwork says: `inv_sum` / `inv_tax`
 * are WHAT WAS PRINTED on the document that was sent, and `purchase_order.po_money_state` remains
 * the single source of truth for what has actually been paid. The `invMo*` fields below record the
 * remittance against the invoice as a whole, which is the translator's view of it; they are not
 * what any report sums.
 */
export const InvoiceTranslatorCreateSchema = v.object({
  /** The one translator this invoice bills. Required - an invoice with no payee cannot be sent. */
  translatorId: IdSchema,
  /**
   * The POs on the invoice. At least one.
   *
   * Capped at 200, well above the ten slots the printed form has: a form that overflows onto a
   * second page is a formatting question, whereas an unbounded array is an unbounded `IN` list and
   * a request that can be made expensive by anyone who can make it at all.
   */
  poIds: v.pipe(v.array(IdSchema), v.minLength(1, "an invoice must cover at least one PO"), v.maxLength(200)),
  /** 인보이스 발행일. Absent means today, stamped server-side. */
  invDay: settable(DateSchema),
  /** The issuing PM, whose name, phone and email print in the signature block. */
  invPmId: settable(IdSchema),
  coinCode: settable(CodeSchema),
  /** Sub Total as PRINTED. Not recomputed on read - see the schema docstring. */
  invSum: settable(MoneySchema),
  /** Tax as PRINTED. An amount, not a rate - see the DDL comment on `invoice_translator.inv_tax`. */
  invTax: settable(MoneySchema),
  /** Planned payment date - the PAYMENT DATE line on the form. */
  invMoPday: settable(DateSchema),
  invMoState: settable(text(50)),
  invMoGubun: settable(text(50)),
  /** The date the translator was actually paid. */
  invMoDay: settable(DateSchema),
  invMoSum: settable(MoneySchema),
  invMoTax: settable(MoneySchema),
  invState: settable(text(50)),
});

/**
 * Editing an invoice.
 *
 * `translatorId` is omitted for the reason `JobUpdateSchema` omits `projectId`: re-pointing an
 * invoice at a different translator does not correct a mistake, it silently re-bills one person's
 * work to another. Cancel it and issue a new one, which leaves both documents in the record.
 *
 * `poIds` stays, and is a REPLACEMENT of the set rather than an addition to it - absent means "leave
 * the grouping alone", present means "these and only these". Adding a forgotten PO is the ordinary
 * case and must not require deleting the invoice.
 */
export const InvoiceTranslatorUpdateSchema = v.partial(
  v.omit(InvoiceTranslatorCreateSchema, ["translatorId"]),
);

/* -------------------------------------------------------------------------- */
/* Reports                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The largest top-N a report breakdown will return.
 *
 * Thirty, because the breakdown is read as a bar chart and thirty bars is about where a chart stops
 * being readable on a laptop screen. It is a product decision rather than a performance one - the
 * aggregate costs the same whether we return ten rows or a thousand - so the number lives here next
 * to the schema that enforces it instead of being buried in the SQL.
 */
export const REPORT_TOP_N_MAX = 30;

/**
 * How many breakdown rows to return. Whole, small, and arriving as either a string or a number.
 *
 * Built like `OrdNoSchema` below and for the same reason: this value reaches the server as a query
 * string, where `Number("")` is 0 and `Number("abc")` is NaN. A bare `v.number()` with a careless
 * transform in front of it would accept both, and a limit of 0 or NaN interpolated into `LIMIT`
 * yields either an empty chart or a syntax error at query time rather than a 400 here.
 *
 * `v.maxValue` rather than a clamp: silently narrowing 500 to 30 would have the caller believe they
 * asked for 500 and that the data really does stop at thirty rows. Refusing says which it is.
 */
export const ReportTopNSchema = v.pipe(
  v.union([v.string(), v.number()]),
  v.transform(String),
  v.regex(/^\d{1,2}$/, "must be a whole number"),
  v.transform(Number),
  v.minValue(1, "must be at least 1"),
  v.maxValue(REPORT_TOP_N_MAX, `must be at most ${String(REPORT_TOP_N_MAX)}`),
);

/**
 * A report query.
 *
 * The date range is required, both ends of it, and that requirement is what makes the report
 * affordable to compute per request. Bounded, the aggregate is an index scan on `ix_job_eday` -
 * single-digit milliseconds for a month. Unbounded, it is the legacy system's slowest screen,
 * which aggregates the full history on every page view. Making the bound mandatory is what stops
 * the new system growing the old problem back.
 */
export const ReportQuerySchema = v.object({
  from: DateSchema,
  to: DateSchema,
  /**
   * What to break the totals down by. One dimension, because a two-dimensional breakdown is a
   * pivot table and belongs in the XLSX export rather than in a JSON list.
   *
   * THIS LIST IS ONE OF THREE THAT HAVE TO STAY EQUAL. The keys of `REPORT_DIMENSIONS` in
   * `reports/NeotmsReport.dbops.ts` are the implementations, and `REPORT_GROUPS` in the frontend's
   * `apis/neotms.codes.ts` is the dropdown. An entry here with no dimension behind it is a 500; an
   * entry in the dropdown that is missing here is a 400 on a choice the console itself offered.
   */
  groupBy: v.picklist([
    "date",
    "customer",
    "pm",
    "salesManager",
    "corp",
    "category",
    "langPair",
    "jobType",
    "jobCategory",
  ]),
  customerId: v.optional(IdSchema),
  pmId: v.optional(IdSchema),
  salesManagerId: v.optional(IdSchema),
  corpId: v.optional(IdSchema),
  /**
   * Optional, and absent means "as many as the hard cap allows" rather than "thirty".
   *
   * The distinction matters because the totals row is computed by a separate, deliberately
   * unbounded query (see `ReportTotalsOps`). A caller that wants the full breakdown - the XLSX
   * export, a future API consumer - must be able to ask for it, and defaulting this to 30 would
   * truncate them without their having said anything. The screen always sends a value.
   */
  limit: v.optional(ReportTopNSchema),
});

/* -------------------------------------------------------------------------- */
/* sys_code - the 유지보수 screen                                              */
/* -------------------------------------------------------------------------- */

/**
 * A display order. Whole, small, and arriving as either a string or a number.
 *
 * Via `String` and a regex rather than `v.number()`, for the same reason `MoneySchema` does it: a
 * number input in a browser hands back a string, and `Number("")` is 0 while `Number("abc")` is
 * NaN - both of which would be accepted by a bare `v.number()` after a careless transform and then
 * written to the column. The regex rejects the empty string, signs, decimals and exponents before
 * anything is converted.
 */
export const OrdNoSchema = v.pipe(
  v.union([v.string(), v.number()]),
  v.transform(String),
  v.regex(/^\d{1,5}$/, "must be a whole number between 0 and 99999"),
  v.transform(Number),
);

/**
 * Adding a code to one of the `sys_code` domains.
 *
 * `code` is required and is the only field that can never be changed afterwards: twenty-two foreign
 * keys across the schema reference `sys_code (code)`, so it is the natural key rather than a label.
 * `CodeUpdateSchema` below drops it for exactly that reason.
 *
 * `codeParent` is the domain ('FIELD', 'WORK', 'UNIT', 'LANG', 'UPRO' as seeded by
 * db/007_codes.sql). Validated as a code, not as a picklist of those five: an administrator is
 * allowed to create a sixth domain, and a picklist here would refuse to let them while giving a
 * validation error that blames the field rather than explaining the policy. What a new domain does
 * NOT get is a dropdown somewhere reading it - that needs a line of frontend code.
 */
export const CodeCreateSchema = v.object({
  code: CodeSchema,
  codeName: settable(text(200)),
  /** Used when a document is rendered in English - see `purchase_order.po_lang`. */
  codeEngName: settable(text(200)),
  codeParent: settable(CodeSchema),
  ordNo: settable(OrdNoSchema),
  active: v.optional(v.boolean()),
});

/**
 * Editing a code. Everything optional, and `code` itself is absent.
 *
 * `v.partial(v.omit(...))` rather than a hand-written object so a field added above cannot be
 * forgotten here - the omission of `code` is then the one difference, stated once.
 */
export const CodeUpdateSchema = v.partial(v.omit(CodeCreateSchema, ["code"]));

/* -------------------------------------------------------------------------- */
/* staff - the 사용자 관리 screen, and self-registration                       */
/* -------------------------------------------------------------------------- */

/**
 * What an administrator may change about somebody else's staff row.
 *
 * Three fields, and all three are load-bearing security values. That is the whole point of this
 * schema being this small: the legacy system read the role out of an unsigned cookie, so anyone who
 * could edit a cookie could grant themselves anything. Here the role is a column, and the column is
 * writable through exactly one route, gated on one menu, validated by this object.
 *
 * `roleId` is nullable on purpose - clearing it is how an account is suspended without being
 * deleted. A staff row with no role signs in successfully and can do nothing, which is the state a
 * self-registered user starts in.
 *
 * What is NOT here: the person's name, email, phone or position. An administrator assigning a role
 * has no business editing somebody's contact details, and the user maintains those themselves (see
 * `SelfProfileSchema`). Keeping the two apart means the audit question "who changed this role" has
 * a different answer from "who corrected this phone number".
 */
export const StaffAdminUpdateSchema = v.partial(
  v.object({
    roleId: v.nullable(IdSchema),
    /**
     * `Y` = sees every row, `N` = sees only their own.
     *
     * A picklist of two, though `VIEW_SCOPE_ALL` in NeotmsAuthGuard also accepts the legacy 'ALL'
     * and 'A'. The guard has to read what the ETL loads; this screen only ever writes the canonical
     * pair, so the value set does not keep growing from the new system's side.
     */
    viewScope: v.picklist(["Y", "N"]),
    /** False removes the sign-in without deleting the history attributed to this `mgr_id`. */
    active: v.boolean(),
  }),
);

/**
 * What a user may say about themselves - at sign-up and afterwards.
 *
 * The defaults are prefilled from LPX's `/userInfo`, and every one of them is editable here,
 * including the name. That is deliberate: `mgr_name` is what gets printed on a purchase order and
 * an invoice, and the name on an SSO account is not always the name a person works under. Letting
 * them correct it is the difference between a document that looks official and one that looks wrong.
 *
 * Notice what this cannot touch: `roleId`, `viewScope`, `active`, `mgrId`, `corpCode`, `lpxSub`.
 * The first three are the permission system; the last three are identity. A self-service form that
 * could write any of the six would be the cookie-forging defect rebuilt with better manners.
 */
export const SelfProfileSchema = v.object({
  /** The name on documents. Required - a PO with a blank 담당자 is not a usable PO. */
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)),
  /** Romanised name, for English-language POs and invoices. */
  nameEng: settable(text(300)),
  email: settable(text(300)),
  phone: settable(text(100)),
  /** 직위. Printed on outgoing documents. */
  position: settable(text(100)),
});

/* -------------------------------------------------------------------------- */
/* Inferred types                                                             */
/* -------------------------------------------------------------------------- */

export type CustomerCreate = v.InferOutput<typeof CustomerCreateSchema>;
export type CustomerUpdate = v.InferOutput<typeof CustomerUpdateSchema>;
export type TranslatorCreate = v.InferOutput<typeof TranslatorCreateSchema>;
export type TranslatorUpdate = v.InferOutput<typeof TranslatorUpdateSchema>;
export type ProjectCreate = v.InferOutput<typeof ProjectCreateSchema>;
export type ProjectUpdate = v.InferOutput<typeof ProjectUpdateSchema>;
export type JobCreate = v.InferOutput<typeof JobCreateSchema>;
export type JobUpdate = v.InferOutput<typeof JobUpdateSchema>;
export type PurchaseOrderCreate = v.InferOutput<typeof PurchaseOrderCreateSchema>;
export type PurchaseOrderUpdate = v.InferOutput<typeof PurchaseOrderUpdateSchema>;
export type PoApproval = v.InferOutput<typeof PoApprovalSchema>;
export type PoSettlement = v.InferOutput<typeof PoSettlementSchema>;
export type InvoiceTranslatorCreate = v.InferOutput<typeof InvoiceTranslatorCreateSchema>;
export type InvoiceTranslatorUpdate = v.InferOutput<typeof InvoiceTranslatorUpdateSchema>;
export type ReportQuery = v.InferOutput<typeof ReportQuerySchema>;
export type CodeCreate = v.InferOutput<typeof CodeCreateSchema>;
export type CodeUpdate = v.InferOutput<typeof CodeUpdateSchema>;
export type StaffAdminUpdate = v.InferOutput<typeof StaffAdminUpdateSchema>;
export type SelfProfile = v.InferOutput<typeof SelfProfileSchema>;
