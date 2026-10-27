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
// sent to PostgreSQL as strings with a DECIMAL type hint (see `param` in RdsDataUtils). Nothing in
// this codebase performs arithmetic on a currency amount in JavaScript - the totals are computed in
// SQL, where `numeric` arithmetic is exact. The legacy system stored amounts in `nvarchar` and
// converted per row, which is how a yearly report came to take minutes; converting them to floats
// on the way in would be a different, quieter version of the same mistake.
//
// ## Ids are strings
//
// `bigint` primary keys, returned as strings by the Data API (`longReturnType: "STRING"`). Kept as
// strings end to end so nothing rounds, and so an id is never accidentally arithmetic.
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
  /** The customer's grade/class, which selects the default rate band. */
  cusUpro: settable(CodeSchema),
  /** Minimum charge per job, in `cusCoin`. */
  cusMincost: settable(MoneySchema),
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
  jobSlang: settable(CodeSchema),
  /** Target language ("ELANG" = end language). */
  jobElang: settable(CodeSchema),
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
  /** Delivery date. Also the business date revenue is recognised on, in the rollup. */
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
 * shows up as revenue and cost landing on different rollup rows, i.e. as a wrong margin on two
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
  poSlang: settable(CodeSchema),
  poElang: settable(CodeSchema),
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
/* Reports                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A report query.
 *
 * The date range is required, both of it. An unbounded report over the full history is the legacy
 * system's slowest screen - it aggregates everything on every page view - and the whole point of
 * `report_daily_rollup` is that a bounded range is an index scan. Making the bound mandatory is
 * what stops the new system growing the old problem back.
 */
export const ReportQuerySchema = v.object({
  from: DateSchema,
  to: DateSchema,
  /**
   * What to break the totals down by. One dimension, because a two-dimensional breakdown is a
   * pivot table and belongs in the XLSX export rather than in a JSON list.
   */
  groupBy: v.picklist(["date", "customer", "pm", "salesManager", "corp", "category", "langPair"]),
  customerId: v.optional(IdSchema),
  pmId: v.optional(IdSchema),
  salesManagerId: v.optional(IdSchema),
  corpId: v.optional(IdSchema),
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
export type ReportQuery = v.InferOutput<typeof ReportQuerySchema>;
