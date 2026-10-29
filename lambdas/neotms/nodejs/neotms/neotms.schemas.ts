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
export type ReportQuery = v.InferOutput<typeof ReportQuerySchema>;
export type CodeCreate = v.InferOutput<typeof CodeCreateSchema>;
export type CodeUpdate = v.InferOutput<typeof CodeUpdateSchema>;
export type StaffAdminUpdate = v.InferOutput<typeof StaffAdminUpdateSchema>;
export type SelfProfile = v.InferOutput<typeof SelfProfileSchema>;
