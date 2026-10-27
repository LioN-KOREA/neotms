// SPDX-License-Identifier: MIT
//
// The only way this application talks to PostgreSQL.
//
// Shaped like the codebase's DynamoDBUtils on purpose: per-domain modules build pure `*Ops`
// descriptors (`{ input, mapper }`) and the executors here run them. That keeps SQL construction
// testable without AWS credentials, and keeps retry, pagination and type coercion in one place
// instead of scattered through the domain code.
//
// Four things about the Data API that the rest of the codebase should never have to think about,
// because they are handled here:
//
// ## 1. A resuming cluster returns a 400, and the SDK will not retry it
//
// The cost model lets the cluster pause outside business hours (ACU floor 0). The first statement
// against a paused cluster fails with `DatabaseResumingException`. That is a 400-class error, and
// the AWS SDKs do not retry 400s - correctly, in general, since a malformed request will stay
// malformed no matter how often it is resent. This one is the exception, and without the wrapper
// below the first request every morning (and after every long quiet stretch) simply fails.
//
// This is not a rare edge case to be defensive about. It is a scheduled, expected, several-times-a-
// day occurrence, and it is the single most important thing in this file.
//
// ## 2. Decimals and bigints come back as strings
//
// `resultSetOptions` asks for STRING for both. The default hands back a JSON number, and a JS number
// is a float64: `numeric(18,2)` money and `bigint` ids both exceed its 53 bits of integer precision.
// The failure mode is not an error - it is a total that is off by a few won, or an id that silently
// rounds to an even number. Money is parsed where it is used, not here, so nothing accidentally
// does float arithmetic on a currency amount.
//
// ## 3. Parameters need type hints, or PostgreSQL guesses wrong
//
// The Data API sends every parameter as a tagged union, and for `date`, `time`, `timestamp`,
// `numeric`, `uuid` and `json` the tag has to be `stringValue` PLUS a `typeHint`. Without the hint
// PostgreSQL receives `text` and either errors on the comparison or - worse, for `numeric` - casts
// through float and loses precision. `sqlParams` below is the only correct way to build these.
//
// ## 4. The 1 MiB limit is on what is RETURNED, not what is scanned
//
// A query that scans the whole project table and returns 50 rows is fine. A query that returns
// 40,000 rows is not, and it fails rather than truncating. So list endpoints page (keyset, see
// below) and the one genuinely large read - the report export - goes through
// `aws_s3.query_export_to_s3` instead. `isResponseTooLarge` identifies the failure so a caller can
// choose that path rather than surfacing a confusing error.

import {
  BeginTransactionCommand,
  CommitTransactionCommand,
  type ExecuteStatementCommandInput,
  ExecuteStatementCommand,
  RDSDataClient,
  RollbackTransactionCommand,
  type SqlParameter,
} from "@aws-sdk/client-rds-data";
import { NeotmsEnv } from "../env/NeotmsEnv.js";

/*
 * Re-exported so that a `*.dbops` module has exactly one import for everything it needs to build a
 * statement. The alternative - importing the type from the SDK and the helpers from here - makes
 * the SDK look like a dependency of the domain layer, which is how a domain module ends up
 * constructing its own client.
 */
export type { SqlParameter };

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

let rdsClient: RDSDataClient | null = null;

export function getClient(): RDSDataClient {
  if (rdsClient) return rdsClient;
  rdsClient = new RDSDataClient({
    /*
     * 3, not the default 3-and-hope. The SDK's own retries only cover throttling and 5xx; the resume
     * case is handled by `withResumeRetry` below, which needs to see the error rather than have the
     * SDK burn the clock on it first. Keeping this low means a genuine throttle is retried quickly
     * and a resume reaches our wrapper fast.
     */
    maxAttempts: 3,
  });
  return rdsClient;
}

/** Test-only: drop the cached client. */
export function _resetClient(): void {
  rdsClient = null;
}

/* -------------------------------------------------------------------------- */
/* Descriptors                                                                */
/* -------------------------------------------------------------------------- */

/** A row as the Data API's JSON format hands it over: column name -> value. */
export type SqlRow = Record<string, unknown>;

/**
 * Pure descriptor produced by a per-domain `*.dbops` module.
 *
 * `sql` and `parameters` only - the cluster ARN, secret ARN, database name and result-set options
 * are filled in by the executor, so no domain module has to know or repeat them.
 */
export interface SqlOps<T> {
  readonly sql: string;
  readonly parameters?: SqlParameter[];
  readonly mapper: (rows: SqlRow[]) => T;
}

/** A statement run for its effect rather than its rows. */
export interface SqlWriteOps {
  readonly sql: string;
  readonly parameters?: SqlParameter[];
}

export interface RdsResponse<T> {
  data: T;
  message: string;
  status: number;
  /** Opaque keyset cursor for the next page, when there is one. See `encodeCursor`. */
  cursor?: string;
}

/* -------------------------------------------------------------------------- */
/* Parameters                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build a `SqlParameter` from a JS value.
 *
 * The `kind` argument is not optional noise - it is what decides the `typeHint`, and the wrong hint
 * fails in ways that do not look like a type problem. The cases worth knowing:
 *
 *   * `"money"` sends the value as a string with `DECIMAL`. Passing a JS number instead would
 *     round-trip through float64 and quietly change the amount.
 *   * `"date"` expects `YYYY-MM-DD`. The legacy schema stores a date and a time in two columns and
 *     this keeps that split, so a date parameter must never carry a time component.
 *   * `"id"` sends a bigint id as `longValue`. Safe because the Data API's wire format carries a
 *     64-bit integer; it is the JSON *response* that needs STRING, not the request.
 */
export type SqlParamKind =
  | "text"
  | "id"
  | "int"
  | "bool"
  | "money"
  | "date"
  | "time"
  | "timestamp"
  | "json"
  | "uuid";

export function param(name: string, value: unknown, kind: SqlParamKind = "text"): SqlParameter {
  // NULL is a value, not an absence. `{ isNull: true }` is the only encoding PostgreSQL reads as
  // NULL; sending an empty string instead would store '' and break every `IS NULL` predicate.
  if (value === null || value === undefined) {
    return { name, value: { isNull: true } };
  }

  switch (kind) {
    case "id":
      return { name, value: { longValue: Number(value) } };
    case "int":
      return { name, value: { longValue: Math.trunc(Number(value)) } };
    case "bool":
      return { name, value: { booleanValue: Boolean(value) } };
    case "money":
      // String + DECIMAL. See the header: a currency amount must never pass through a float.
      return { name, value: { stringValue: String(value) }, typeHint: "DECIMAL" };
    case "date":
      return { name, value: { stringValue: String(value) }, typeHint: "DATE" };
    case "time":
      return { name, value: { stringValue: String(value) }, typeHint: "TIME" };
    case "timestamp":
      return { name, value: { stringValue: String(value) }, typeHint: "TIMESTAMP" };
    case "json":
      return { name, value: { stringValue: JSON.stringify(value) }, typeHint: "JSON" };
    case "uuid":
      return { name, value: { stringValue: String(value) }, typeHint: "UUID" };
    case "text":
    default:
      return { name, value: { stringValue: String(value) } };
  }
}

/* -------------------------------------------------------------------------- */
/* Result coercion                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Read a `numeric` column.
 *
 * Returns a string, because that is the only lossless JS representation of an arbitrary-precision
 * decimal. Callers that need to add amounts together should do it in SQL, where `numeric` arithmetic
 * is exact - not here. The one legitimate use for the number form is display, and that is what
 * `toMoneyNumber` is for.
 */
export function readMoney(row: SqlRow, column: string): string | null {
  const raw = row[column];
  if (raw === null || raw === undefined) return null;
  return String(raw);
}

/**
 * Only for display and for JSON the browser will format.
 *
 * Named to be awkward on purpose. Any arithmetic on the result is a bug waiting to be a reconciled-
 * to-the-won discrepancy, and the margin figures this system exists to report are exactly the
 * numbers someone will eventually check by hand.
 */
export function toMoneyNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

export function readId(row: SqlRow, column: string): string | null {
  const raw = row[column];
  if (raw === null || raw === undefined) return null;
  // Already a string, because longReturnType is STRING. Kept as one: `bigint` ids will outlive
  // Number.MAX_SAFE_INTEGER eventually, and JSON has no bigint.
  return String(raw);
}

export function readBool(row: SqlRow, column: string): boolean | null {
  const raw = row[column];
  if (raw === null || raw === undefined) return null;
  return raw === true || raw === "true" || raw === "t" || raw === 1 || raw === "1";
}

export function readText(row: SqlRow, column: string): string | null {
  const raw = row[column];
  if (raw === null || raw === undefined) return null;
  return String(raw);
}

export function readInt(row: SqlRow, column: string): number | null {
  const raw = row[column];
  if (raw === null || raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

function errorName(err: unknown): string {
  return typeof err === "object" && err !== null && "name" in err ? String(err.name) : "";
}

function errorMessage(err: unknown): string {
  return typeof err === "object" && err !== null && "message" in err ? String(err.message) : "";
}

/**
 * Is this the cluster waking up?
 *
 * Checked by name AND by message, because the Data API is not consistent about which it uses.
 * `DatabaseResumingException` is the documented shape; in practice a resume also arrives as a
 * `BadRequestException` whose message mentions resuming, and relying on the name alone leaves the
 * first request of the morning failing some of the time rather than none of it.
 */
export function isResuming(err: unknown): boolean {
  const name = errorName(err);
  if (name === "DatabaseResumingException") return true;
  if (name === "BadRequestException" || name === "StatementTimeoutException") {
    const message = errorMessage(err).toLowerCase();
    return (
      message.includes("resuming") ||
      message.includes("is not currently available") ||
      message.includes("try again")
    );
  }
  return false;
}

/**
 * Did the result exceed the Data API's 1 MiB response limit?
 *
 * Worth distinguishing, because the answer is not "retry" - it is "this read needs a different
 * mechanism" (keyset paging for a list, `aws_s3.query_export_to_s3` for an export). Retrying would
 * fail identically, forever.
 */
export function isResponseTooLarge(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase();
  return (
    message.includes("response size limit") ||
    message.includes("result set") && message.includes("too large") ||
    errorName(err) === "UnsupportedResultException"
  );
}

export type RdsErrorDetail = { status: number; name: string; message: string };

/**
 * Map a Data API exception to the status this codebase should report.
 *
 * The distinction that matters most is 503 vs 500. A resuming or unavailable cluster is transient
 * and the client should retry; everything else is not, and a client that retries a 500 just makes
 * the problem worse. The legacy system returned 500 for both, which is why nobody could tell a
 * deploy problem from a cold cluster.
 */
export function exceptionToErrorResponse(err: unknown): RdsErrorDetail {
  const name = errorName(err);
  const message = errorMessage(err);

  if (isResuming(err)) {
    return { status: 503, name: name || "DatabaseResumingException", message: "The database is waking up. Please retry." };
  }
  if (isResponseTooLarge(err)) {
    return { status: 413, name: name || "UnsupportedResultException", message: "The result set is too large to return directly." };
  }

  switch (name) {
    case "DatabaseUnavailableException":
    case "InternalServerErrorException":
    case "ServiceUnavailableError":
      return { status: 503, name, message: "The database is temporarily unavailable." };
    case "StatementTimeoutException":
      return { status: 504, name, message: "The statement took too long and was cancelled." };
    case "AccessDeniedException":
    case "ForbiddenException":
      // Almost always a missing IAM grant rather than a user-facing permission problem, so it is a
      // 500: the caller did nothing wrong and must not be told to fix their request.
      return { status: 500, name, message: "The service is not permitted to reach the database." };
    case "HttpEndpointNotEnabledException":
      return { status: 500, name, message: "The Data API is not enabled on this cluster." };
    case "DatabaseNotFoundException":
    case "SecretsErrorException":
    case "InvalidSecretException":
      return { status: 500, name, message: "The database connection is misconfigured." };
    case "BadRequestException":
    case "DatabaseErrorException":
      /*
       * A constraint violation lands here, and it is the one BadRequestException that is the
       * caller's fault rather than the code's. Detected by SQLSTATE in the message because the Data
       * API does not surface PostgreSQL's error code as a field.
       */
      if (message.includes("23505") || message.toLowerCase().includes("duplicate key")) {
        return { status: 409, name, message: "That record already exists." };
      }
      if (message.includes("23503") || message.toLowerCase().includes("foreign key")) {
        return { status: 409, name, message: "A referenced record does not exist." };
      }
      return { status: 500, name, message: "The statement could not be executed." };
    default:
      return { status: 500, name: name || "UnknownError", message: "An unexpected database error occurred." };
  }
}

/* -------------------------------------------------------------------------- */
/* Resume retry                                                               */
/* -------------------------------------------------------------------------- */

/** Attempts, including the first. A resume takes seconds, not minutes. */
const RESUME_MAX_ATTEMPTS = 5;
/** First backoff. Doubles each time: 400, 800, 1600, 3200 - about 6 seconds in total. */
const RESUME_BASE_DELAY_MS = 400;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retry a call for as long as the only thing wrong is that the cluster is still waking up.
 *
 * Every executor in this file goes through here, so no caller can forget it. Three details:
 *
 *   * Only `isResuming` is retried. A constraint violation or a syntax error is rethrown on the
 *     first attempt - retrying those would turn a clear error into a six-second clear error.
 *   * Jitter on the backoff. When the cluster wakes, every concurrent Lambda retries at once;
 *     without jitter they all land in the same millisecond and the first thing the newly-available
 *     cluster sees is a thundering herd.
 *   * The budget is bounded by attempts, not by wall clock, and the total (~6s) is deliberately
 *     well inside the function's 29-second timeout. A resume that takes longer than this is not a
 *     resume - it is an outage, and it should surface as one rather than be hidden until the
 *     gateway times out.
 */
export async function withResumeRetry<T>(operation: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= RESUME_MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;
      if (!isResuming(err)) throw err;
      if (attempt === RESUME_MAX_ATTEMPTS) break;
      const backoff = RESUME_BASE_DELAY_MS * 2 ** (attempt - 1);
      const jittered = backoff / 2 + Math.random() * (backoff / 2);
      console.warn(
        `[rds] cluster resuming, retrying ${label} (attempt ${attempt}/${RESUME_MAX_ATTEMPTS}) in ${Math.round(jittered)}ms`,
      );
      await sleep(jittered);
    }
  }
  console.error(`[rds] gave up waiting for the cluster to resume: ${label}`);
  throw lastErr;
}

/* -------------------------------------------------------------------------- */
/* Executors                                                                  */
/* -------------------------------------------------------------------------- */

function baseInput(
  sql: string,
  parameters?: SqlParameter[],
  transactionId?: string,
): ExecuteStatementCommandInput {
  return {
    resourceArn: NeotmsEnv.NEOTMS_DB_CLUSTER_ARN,
    secretArn: NeotmsEnv.NEOTMS_DB_SECRET_ARN,
    database: NeotmsEnv.NEOTMS_DB_NAME,
    sql,
    parameters,
    transactionId,
    /*
     * JSON format rather than the column-metadata arrays.
     *
     * The arrays give full control over types but cost a hand-written converter per query, and the
     * converter is where the bugs live. JSON gives `{ column: value }` straight away.
     *
     * The price is one rule the SQL has to follow: EVERY column in a joined select must have a
     * unique name or alias. Two columns called `id` collapse into one key, silently, with the last
     * one winning. Hence the `project_id` / `customer_name` style aliasing throughout the dbops
     * modules - it is a correctness requirement, not a style preference.
     */
    formatRecordsAs: "JSON",
    resultSetOptions: {
      // See the header. Without these, money loses precision and bigint ids round.
      decimalReturnType: "STRING",
      longReturnType: "STRING",
    },
  };
}

function parseRows(formattedRecords: string | undefined): SqlRow[] {
  if (!formattedRecords) return [];
  try {
    const parsed = JSON.parse(formattedRecords);
    return Array.isArray(parsed) ? (parsed as SqlRow[]) : [];
  } catch (err) {
    // Should be unreachable - the Data API produced this string. If it ever happens, failing loudly
    // beats handing the domain layer an empty result it would read as "no rows".
    throw new Error(`The Data API returned records that are not valid JSON: ${err}`);
  }
}

/** Run a read. */
export async function rdsQuery<T>(ops: SqlOps<T>, transactionId?: string): Promise<RdsResponse<T>> {
  const out = await withResumeRetry(
    () => getClient().send(new ExecuteStatementCommand(baseInput(ops.sql, ops.parameters, transactionId))),
    "query",
  );
  return {
    data: ops.mapper(parseRows(out.formattedRecords)),
    status: 200,
    message: "Query successful",
  };
}

/**
 * Run a write.
 *
 * Returns the mapped rows too, because the house style is `INSERT ... RETURNING` rather than an
 * insert followed by a select: one round trip instead of two, and no window in which another
 * request could have changed the row in between.
 */
export async function rdsExecute<T>(ops: SqlOps<T>, transactionId?: string): Promise<RdsResponse<T>> {
  const out = await withResumeRetry(
    () => getClient().send(new ExecuteStatementCommand(baseInput(ops.sql, ops.parameters, transactionId))),
    "execute",
  );
  return {
    data: ops.mapper(parseRows(out.formattedRecords)),
    status: 200,
    message: "Statement executed",
  };
}

/** Run a write whose rows are not wanted. Returns the number of rows affected. */
export async function rdsExecuteCount(ops: SqlWriteOps, transactionId?: string): Promise<RdsResponse<number>> {
  const out = await withResumeRetry(
    () => getClient().send(new ExecuteStatementCommand(baseInput(ops.sql, ops.parameters, transactionId))),
    "execute",
  );
  return {
    data: out.numberOfRecordsUpdated ?? 0,
    status: 200,
    message: "Statement executed",
  };
}

/**
 * Run several statements as one transaction.
 *
 * The Data API's transactions are explicit three-call affairs (begin, statements, commit) rather
 * than a session property, because there is no session. Two consequences:
 *
 *   * Every statement in the body MUST be passed the `transactionId`. A statement without it runs
 *     outside the transaction and commits on its own - so a rollback leaves it in place. That is the
 *     classic Data API bug and it is why the body receives the id as an argument rather than reading
 *     it from somewhere ambient.
 *   * An abandoned transaction holds locks until the Data API times it out (three minutes). The
 *     `finally`-style rollback below is what stops a thrown error from parking a lock on a row for
 *     three minutes, which on the project table would stall every PM looking at it.
 *
 * Used where an invariant spans tables - creating a job and its first PO together, so a failure
 * cannot leave revenue booked with no cost line.
 */
export async function rdsTransaction<T>(body: (transactionId: string) => Promise<T>): Promise<T> {
  const begun = await withResumeRetry(
    () =>
      getClient().send(
        new BeginTransactionCommand({
          resourceArn: NeotmsEnv.NEOTMS_DB_CLUSTER_ARN,
          secretArn: NeotmsEnv.NEOTMS_DB_SECRET_ARN,
          database: NeotmsEnv.NEOTMS_DB_NAME,
        }),
      ),
    "beginTransaction",
  );
  const transactionId = begun.transactionId;
  if (!transactionId) throw new Error("The Data API began a transaction without returning an id");

  let committed = false;
  try {
    const result = await body(transactionId);
    await getClient().send(
      new CommitTransactionCommand({
        resourceArn: NeotmsEnv.NEOTMS_DB_CLUSTER_ARN,
        secretArn: NeotmsEnv.NEOTMS_DB_SECRET_ARN,
        transactionId,
      }),
    );
    committed = true;
    return result;
  } finally {
    if (!committed) {
      try {
        await getClient().send(
          new RollbackTransactionCommand({
            resourceArn: NeotmsEnv.NEOTMS_DB_CLUSTER_ARN,
            secretArn: NeotmsEnv.NEOTMS_DB_SECRET_ARN,
            transactionId,
          }),
        );
      } catch (rollbackErr) {
        /*
         * Swallowed, and only swallowed here.
         *
         * The original error is what the caller needs to see; a rollback failure on top of it would
         * replace a useful message ("duplicate key on customer.code") with a useless one
         * ("transaction not found"). Logged so it is not invisible - a repeated rollback failure
         * means transactions are being left open somewhere.
         */
        console.error(`[rds] rollback failed for transaction ${transactionId}: ${rollbackErr}`);
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Keyset pagination                                                          */
/* -------------------------------------------------------------------------- */

/**
 * This is the SQL-native equivalent of DynamoDB's `LastEvaluatedKey`, and it replaces `OFFSET`.
 *
 * `OFFSET` is not merely slow at depth - it is INCORRECT under concurrent writes, and the legacy
 * system demonstrates both. `OFFSET 97150` makes PostgreSQL (and SQL Server before it) walk and
 * discard 97,150 rows to return 50. That is the slow part, and it is the part people notice.
 *
 * The part nobody notices is worse: offset counts rows in a result set that is being changed
 * underneath the paging. Insert a row that sorts early while someone is on page 3, and page 4 starts
 * one row later than it should - a row is skipped and never seen. Delete one, and a row is shown
 * twice. For a list of translation jobs that someone is working through to assign POs, a silently
 * skipped row is a job nobody is ever assigned to.
 *
 * Keyset paging asks "give me the rows after this one" instead of "skip this many", so it is both
 * O(log n) on an index and immune to concurrent inserts.
 *
 * ## The rule that makes it work
 *
 * The sort key must be UNIQUE, or paging stalls or loops. Sorting projects by start date alone is
 * not unique - fifty projects can start on the same day - so every ordering here ends in the primary
 * key as a tiebreaker, and the cursor carries both parts. That is what the row-value comparison
 * `(sort_col, id) < (:cursor_sort, :cursor_id)` expresses, and PostgreSQL can satisfy it from a
 * composite index on exactly those columns.
 */
export interface KeysetCursor {
  /** The ordering column's value from the last row of the previous page. */
  readonly sortValue: string | null;
  /** That row's primary key. The tiebreaker that makes the ordering total. */
  readonly id: string;
}

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/**
 * Decode a cursor, treating anything unexpected as "no cursor".
 *
 * A cursor is client-supplied, so it is attacker-supplied. It is also ephemeral - a user who
 * bookmarks page 4 and comes back next week has a cursor pointing at a row that may be gone. Both
 * cases return null and restart from the first page, which is the honest answer; throwing a 400 at
 * someone whose only mistake was reloading an old tab is not.
 *
 * The cursor is NOT signed, and that is fine: it names a sort position, which is not a secret and
 * not a capability. Every query it feeds still applies the caller's row-level view scope
 * independently, so a forged cursor cannot reach a row the caller could not otherwise see. If that
 * ever stops being true, this needs an HMAC.
 */
export function decodeCursor(token: string | null | undefined): KeysetCursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { sortValue, id } = parsed as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0) return null;
    if (sortValue !== null && typeof sortValue !== "string") return null;
    return { sortValue, id };
  } catch {
    return null;
  }
}

export type SortDirection = "asc" | "desc";

/**
 * The `WHERE` fragment and parameters for "rows after the cursor".
 *
 * Returns an empty fragment for the first page, so callers can always interpolate the result
 * without branching.
 *
 * `sortColumn` is interpolated into the SQL rather than parameterised, because PostgreSQL does not
 * allow a parameter where a column name goes. It therefore MUST NOT come from request input - every
 * call site passes a literal from a fixed allow-list (see `resolveSort`). This is the one place in
 * the codebase where a string reaches the SQL text, and it is why that allow-list exists.
 */
export function keysetWhere(
  cursor: KeysetCursor | null,
  sortColumn: string,
  idColumn: string,
  direction: SortDirection,
  sortCast?: string,
): { fragment: string; parameters: SqlParameter[] } {
  if (!cursor) return { fragment: "", parameters: [] };
  const comparison = direction === "asc" ? ">" : "<";
  /*
   * The cursor's sort value travels as text, because a cursor is one opaque string and cannot carry
   * a type. `sortCast` is how a non-text sort column gets compared correctly: `:cursor_sort::date`
   * for a date column, `::timestamptz` for a timestamp, `::numeric` for an amount.
   *
   * The cast goes on the PARAMETER, never on the column. `(c.created_at::text, ...)` would also
   * compare correctly for ISO timestamps and would silently stop using the index on
   * `(created_at, id)`, turning a page read into a sequential scan - the exact failure this whole
   * pagination scheme exists to avoid. Without any cast, PostgreSQL usually coerces the unknown
   * literal for you; "usually" is not a property worth relying on for a comparison that decides
   * which rows a user sees.
   *
   * Like `sortColumn`, this is interpolated, so it comes from the same fixed allow-list.
   */
  const sortPlaceholder = sortCast ? `:cursor_sort::${sortCast}` : ":cursor_sort";
  /*
   * A row-value comparison, not `(sort > :s) OR (sort = :s AND id > :i)`.
   *
   * The two are logically identical and PostgreSQL optimises them differently: the row-value form
   * can be answered by a single index scan starting at the cursor position, while the expanded
   * boolean form often produces a bitmap-or of two scans. On a 100,000-row project table that is
   * the difference between a few pages read and a few thousand.
   */
  return {
    fragment: `AND (${sortColumn}, ${idColumn}) ${comparison} (${sortPlaceholder}, :cursor_id)`,
    parameters: [
      param("cursor_sort", cursor.sortValue, "text"),
      param("cursor_id", cursor.id, "id"),
    ],
  };
}

/**
 * Trim a page to its requested size and derive the cursor for the next one.
 *
 * Callers fetch `limit + 1` rows. The extra row is never returned - its only job is to answer "is
 * there a next page" without a second `COUNT(*)` query, which on a large filtered table costs about
 * as much as the page itself. If the extra row is absent, this is the last page and no cursor is
 * emitted, which is how the client knows to stop.
 */
export function paginate<T>(
  rows: SqlRow[],
  limit: number,
  sortColumn: string,
  idColumn: string,
  map: (row: SqlRow) => T,
): { items: T[]; cursor?: string } {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items = page.map(map);
  if (!hasMore || page.length === 0) return { items };

  const last = page[page.length - 1];
  const lastId = readId(last, idColumn);
  if (!lastId) {
    // No tiebreaker means no safe cursor. Returning one built from a null id would produce a page
    // that either repeats rows or skips them, so the honest answer is "this is the end".
    console.error(`[rds] cannot build a cursor: ${idColumn} missing from the last row of a page`);
    return { items };
  }
  const sortValue = last[sortColumn];
  return {
    items,
    cursor: encodeCursor({
      sortValue: sortValue === null || sortValue === undefined ? null : String(sortValue),
      id: lastId,
    }),
  };
}

/**
 * One entry in a sort allow-list: the qualified column, and the type its cursor value casts to.
 *
 * `cast` is omitted for text columns and required for everything else. See `keysetWhere`.
 */
export interface SortTarget {
  readonly column: string;
  readonly cast?: string;
}

/**
 * Resolve a client-supplied sort name to a real column.
 *
 * The allow-list is the security boundary for `keysetWhere`'s interpolation: without it, a `?sort=`
 * parameter would reach the SQL text. Unknown names fall back to the default rather than erroring,
 * so an old bookmarked URL keeps working.
 *
 * Prefer a NOT NULL column as the default sort. A row-value comparison against a NULL sort value is
 * NULL, not true, so a cursor that lands on a row whose sort column is NULL returns nothing and the
 * list appears to end early. Every table in this schema has a NOT NULL `created_at` for exactly
 * this reason; nullable columns (a project's start date, say) are fine as an explicit choice, where
 * a user who sorted by them can see the shape of the data, but they are a poor default.
 */
export function resolveSort<K extends string>(
  requested: string | undefined,
  allowed: Record<K, SortTarget>,
  fallback: K,
): { key: K } & SortTarget {
  const key = (requested && requested in allowed ? requested : fallback) as K;
  return { key, ...allowed[key] };
}

/** Clamp a client-supplied page size. See NeotmsEnv for why the maximum is a correctness guard. */
export function clampLimit(requested: string | undefined, fallback: number, max: number): number {
  const parsed = Number(requested);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.trunc(parsed), max);
}
