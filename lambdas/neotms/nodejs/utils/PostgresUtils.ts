// SPDX-License-Identifier: MIT
//
// The only way this application talks to PostgreSQL.
//
// This is the Supabase variant of the file. The ASv2 variant (branch `dev/neotms-a`) is the same
// module written against the RDS Data API; the EXPORTED SURFACE here is deliberately identical to
// it, because that is what lets the ~20 `*.dbops` and `*Manager` modules compile unchanged on both
// branches. Two rules follow from that, and breaking either one makes the branches diverge in the
// one place where divergence is expensive:
//
//   * `SqlOps` descriptors keep writing `:named` placeholders, not `$1`. The translation to
//     positional parameters happens here, in `toPositional`.
//   * `param(name, value, kind)` stays the only way to build a parameter. `kind` used to pick the
//     Data API's `typeHint`; here it picks an explicit SQL cast. Same job, same call sites.
//
// ## 1. The connection goes through Supavisor on 6543, not to the database directly
//
// Three reasons, in descending order of how badly ignoring them hurts:
//
//   * A direct connection (`db.<ref>.supabase.co:5432`) is IPv6-only unless the IPv4 add-on is
//     bought. A Lambda outside a VPC has no IPv6 egress, so the direct endpoint is not merely
//     slower here - it is unreachable. The shared pooler answers on IPv4 on every plan.
//   * Lambda's concurrency model is hostile to Postgres. Each container holds its own pool, so N
//     warm containers hold N pools; `max_connections` on a Small instance is in the low hundreds and
//     is shared with the dashboard, the SQL editor and PostgREST. Supavisor multiplexes them.
//   * Transaction mode returns the server connection at COMMIT rather than at disconnect, so a
//     frozen Lambda container does not hold a backend hostage while it is not running.
//
// What that costs us, from Supabase's own limitations list: prepared statements are not supported,
// query pipelining is not supported, and session-level state is lost between transactions. All
// three are handled or avoided below - see `createPool`.
//
// ## 2. There is no 1 MiB response cap, and no resuming cluster
//
// Both of those shaped the ASv2 version of this file and neither exists here. The Data API capped a
// result set at 1 MiB, which is why report exports went out through `aws_s3.query_export_to_s3`;
// over a socket a large result streams, so the export path is ordinary SQL. And a Supabase Pro
// instance does not pause, so `DatabaseResumingException` has no counterpart.
//
// What replaces the resume retry is NOT nothing, though. See `withTransientRetry`: a Lambda
// container that has been frozen for minutes wakes up holding a TCP socket the other end has
// already closed, and the first query after a thaw fails with `ECONNRESET` rather than with
// anything that looks like a database error. That failure is just as scheduled and just as
// expected as the resume was, and it needs the same treatment.
//
// ## 3. Timestamps are handed back as STRINGS, deliberately
//
// node-postgres parses `date`, `timestamp` and `timestamptz` into JS `Date` objects by default. The
// Data API returned ISO strings, and every mapper in this codebase reads those columns with
// `readText`, which is `String(raw)`. `String(new Date())` is
// `"Wed Oct 29 2026 09:00:00 GMT+0900 (KST)"` - not ISO, not parseable by the frontend, and not an
// error. So the type parsers are overridden in `registerTypeParsers` and the wire format wins.
// This is the single most load-bearing eight lines in the file.

import { Pool, types, type PoolClient } from "pg";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { NeotmsEnv } from "../env/NeotmsEnv.js";

/* -------------------------------------------------------------------------- */
/* Descriptors                                                                */
/* -------------------------------------------------------------------------- */

/** A row as `pg` hands it over: column name -> value. */
export type SqlRow = Record<string, unknown>;

/**
 * How a parameter's value should be typed on the way into PostgreSQL.
 *
 * On the ASv2 branch this chose the Data API's `typeHint`. Here it chooses an explicit cast on the
 * placeholder - `$1::numeric`, `$2::date` - which is the same guarantee by a different mechanism.
 *
 * The cast is not decoration. node-postgres sends every parameter in text format and lets the
 * server infer the type from context; in a predicate against a typed column that inference is
 * reliable, but in a `VALUES` list, a `COALESCE`, or either side of a row-value comparison it can
 * fail outright with «could not determine data type of parameter $1». An explicit cast removes the
 * inference step, so the behaviour cannot depend on how the surrounding SQL was written.
 *
 * The cases worth knowing:
 *
 *   * `"money"` travels as a STRING cast to `numeric`. A JS number would round-trip through float64
 *     and quietly change the amount - and the margin figures this system reports are exactly the
 *     numbers someone eventually checks by hand.
 *   * `"id"` also travels as a string, cast to `bigint`. The ASv2 version sent `Number(value)`,
 *     which silently loses precision above 2^53; there is no reason to repeat that here, because a
 *     string costs nothing and `::bigint` is exact.
 *   * `"date"` expects `YYYY-MM-DD`. The legacy schema splits date and time into two columns and
 *     this keeps that split, so a date parameter must never carry a time component.
 *   * `"timestamp"` casts to `timestamptz`, not `timestamp`. Every timestamp column in
 *     002_tables.sql is `timestamptz` (51 of them, no exceptions), and casting a parameter to
 *     `timestamp` to compare against a `timestamptz` column reintroduces the server's time zone as
 *     a silent factor in the comparison.
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

/**
 * One bound parameter.
 *
 * Shaped like this rather than like the Data API's tagged union because nothing outside this file
 * ever builds one - `param()` is the only constructor, verified by grep before the port. If that
 * stops being true, the translation in `toPositional` is the thing that breaks.
 */
export interface SqlParameter {
  readonly name: string;
  readonly value: string | number | boolean | null;
  readonly kind: SqlParamKind;
}

/**
 * Pure descriptor produced by a per-domain `*.dbops` module.
 *
 * `sql` and `parameters` only - the host, credential and database are filled in by the executor, so
 * no domain module has to know or repeat them.
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

export interface PgResponse<T> {
  data: T;
  message: string;
  status: number;
  /** Opaque keyset cursor for the next page, when there is one. See `encodeCursor`. */
  cursor?: string;
}

/* -------------------------------------------------------------------------- */
/* Parameters                                                                 */
/* -------------------------------------------------------------------------- */

const CASTS: Record<SqlParamKind, string> = {
  // No cast. A bare `$1` compared against a text column is already text, and adding `::text` here
  // would turn `keysetWhere`'s `:cursor_sort::date` into `$1::text::date` - valid, but noise in
  // every logged statement.
  text: "",
  id: "::bigint",
  int: "::int",
  bool: "::boolean",
  money: "::numeric",
  date: "::date",
  time: "::time",
  timestamp: "::timestamptz",
  json: "::jsonb",
  uuid: "::uuid",
};

export function param(name: string, value: unknown, kind: SqlParamKind = "text"): SqlParameter {
  // NULL is a value, not an absence. Passing an empty string instead would store '' and break
  // every `IS NULL` predicate - and `''::date` is an error rather than a NULL.
  if (value === null || value === undefined) {
    return { name, value: null, kind };
  }

  switch (kind) {
    case "int":
      return { name, value: Math.trunc(Number(value)), kind };
    case "bool":
      return { name, value: Boolean(value), kind };
    case "json":
      return { name, value: JSON.stringify(value), kind };
    // "id" and "money" are string-valued on purpose - see SqlParamKind.
    default:
      return { name, value: String(value), kind };
  }
}

/* -------------------------------------------------------------------------- */
/* Named -> positional translation                                            */
/* -------------------------------------------------------------------------- */

/** What `toPositional` hands to `pg`. */
export interface PositionalStatement {
  readonly text: string;
  readonly values: unknown[];
}

/**
 * Rewrite `:named` placeholders as `$1`, `$2`, ... and collect the values in that order.
 *
 * This is the highest-risk function in the port, because every single statement in the application
 * passes through it and a mistake here is a wrong query rather than a failed one. It is a small
 * hand-written scanner rather than a regular expression, and the three things that forced that:
 *
 *   * `::` is a cast, not a placeholder. A naive `/:\w+/` turns `created_at::date` into
 *     `created_at:$7ate` - which is a syntax error, so that one at least fails loudly. The same
 *     naive pattern applied to `:cursor_sort::date` produces something that still parses.
 *   * A colon inside a string literal is data. There are none in the current SQL (checked), but
 *     `'%:%'` is a legal search pattern and the scanner costs nothing.
 *   * A repeated name must reuse its number. `searchClause` emits
 *     `a LIKE :search OR b LIKE :search OR c LIKE :search` from ONE parameter; pushing the value
 *     three times and numbering them $1/$2/$3 would then bind only the first and leave `pg`
 *     complaining that it was given 1 value for 3 placeholders.
 *
 * Note on backslashes: inside a single-quoted literal only `''` escapes a quote. PostgreSQL ships
 * `standard_conforming_strings = on`, so a backslash in an ordinary literal is just a backslash -
 * which means `'\'` is a complete, one-character string. Treating backslash as an escape here
 * would swallow that closing quote and mis-parse the rest of the statement, and `ESCAPE '\'` is
 * exactly the shape this codebase used to write.
 */
export function toPositional(sql: string, parameters: SqlParameter[] = []): PositionalStatement {
  const byName = new Map(parameters.map((p) => [p.name, p]));
  const numberByName = new Map<string, number>();
  const values: unknown[] = [];
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    // --- string literal ---------------------------------------------------
    if (ch === "'") {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += sql.slice(start, i);
      continue;
    }

    // --- quoted identifier ------------------------------------------------
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += sql.slice(start, i);
      continue;
    }

    // --- line comment -----------------------------------------------------
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // --- block comment (PostgreSQL nests these) ---------------------------
    if (ch === "/" && sql[i + 1] === "*") {
      const start = i;
      let depth = 0;
      while (i < sql.length) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
          continue;
        }
        if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
          continue;
        }
        i += 1;
      }
      out += sql.slice(start, i);
      continue;
    }

    // --- cast, not a placeholder ------------------------------------------
    if (ch === ":" && sql[i + 1] === ":") {
      out += "::";
      i += 2;
      continue;
    }

    // --- placeholder ------------------------------------------------------
    if (ch === ":") {
      const match = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(sql.slice(i));
      if (match) {
        const name = match[1];
        const parameter = byName.get(name);
        if (!parameter) {
          /*
           * Thrown, not defaulted to NULL.
           *
           * A placeholder with no parameter means a conditional fragment was added to the SQL
           * without its value - and the overwhelmingly likely fragment is a filter. Binding NULL
           * there turns `AND status = :status` into `AND status = NULL`, which is never true, so a
           * list screen would silently return nothing at all. A thrown error names the parameter.
           */
          throw new Error(
            `SQL references :${name} but no such parameter was supplied. ` +
              `Supplied: ${parameters.map((p) => p.name).join(", ") || "(none)"}`,
          );
        }
        let position = numberByName.get(name);
        if (position === undefined) {
          values.push(parameter.value);
          position = values.length;
          numberByName.set(name, position);
        }
        out += `$${position}${CASTS[parameter.kind]}`;
        i += match[0].length;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return { text: out, values };
}

/* -------------------------------------------------------------------------- */
/* Result coercion                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Read a `numeric` column.
 *
 * Returns a string, because that is the only lossless JS representation of an arbitrary-precision
 * decimal. node-postgres already hands `numeric` back as a string for this reason and the parser is
 * pinned in `registerTypeParsers` so a dependency update cannot change it. Callers that need to add
 * amounts together should do it in SQL, where `numeric` arithmetic is exact - not here.
 */
export function readMoney(row: SqlRow, column: string): string | null {
  const raw = row[column];
  if (raw === null || raw === undefined) return null;
  return String(raw);
}

/**
 * Only for display and for JSON the browser will format.
 *
 * Named to be awkward on purpose. Any arithmetic on the result is a bug waiting to be a
 * reconciled-to-the-won discrepancy.
 */
export function toMoneyNumber(value: string | null): number | null {
  return value === null ? null : Number(value);
}

export function readId(row: SqlRow, column: string): string | null {
  const raw = row[column];
  if (raw === null || raw === undefined) return null;
  // Already a string: `pg` returns `int8` as a string, and the parser is pinned. Kept as one -
  // `bigint` ids will outlive Number.MAX_SAFE_INTEGER eventually, and JSON has no bigint.
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
/* Type parsers                                                               */
/* -------------------------------------------------------------------------- */

/** `SELECT oid, typname FROM pg_type WHERE typname IN (...)` - stable across versions. */
const OID = {
  int8: 20,
  numeric: 1700,
  date: 1082,
  time: 1083,
  timestamp: 1114,
  timestamptz: 1184,
  timetz: 1266,
} as const;

let typeParsersRegistered = false;

/**
 * Make `pg` hand back the wire text for every column this codebase reads as a string.
 *
 * See the file header for why. `int8` and `numeric` are already text by default and are pinned
 * anyway: both defaults are load-bearing (bigint ids, money) and a silent change in a minor
 * `pg` release would show up as rounded ids and off-by-a-few-won totals rather than as an error.
 *
 * Registration is global to the `pg` module and idempotent, which is why the guard exists - this
 * runs on the first query of a cold start, not at import, so that importing the module in a unit
 * test does not mutate shared state.
 */
function registerTypeParsers(): void {
  if (typeParsersRegistered) return;
  const asText = (value: string) => value;
  for (const oid of Object.values(OID)) {
    types.setTypeParser(oid, asText);
  }
  typeParsersRegistered = true;
}

/* -------------------------------------------------------------------------- */
/* Credential                                                                 */
/* -------------------------------------------------------------------------- */

let secretsClient: SecretsManagerClient | null = null;

/**
 * Read the database password out of Secrets Manager.
 *
 * The password is a STATIC credential - Supabase issues one password per project and there is no
 * IAM-style short-lived equivalent, so unlike the ASv2 branch (where the Data API authorised with
 * SigV4 and the password was never handled by anything) this value is a long-lived secret that the
 * function holds in memory. That is a real downgrade in the security posture and it is written up
 * in the README under "Static database credentials"; the mitigations that exist here are that it is
 * never an environment variable, never in the CloudFormation template, and never in git.
 *
 * Stored as JSON with a single `password` key rather than as a bare string: it leaves room for a
 * rotation function to add `username` later without changing this reader, and a one-key object
 * cannot be clobbered by an operator who runs `put-secret-value` with a partial payload.
 */
async function readPassword(): Promise<string> {
  const secretArn = NeotmsEnv.NEOTMS_DB_SECRET_ARN;
  if (!secretArn) {
    throw new Error(
      "NEOTMS_DB_SECRET_ARN is empty, so there is no database password to read. " +
        "The stack sets it; see README §3 if this is a local run.",
    );
  }
  secretsClient ??= new SecretsManagerClient({ maxAttempts: 3 });
  const out = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!out.SecretString) {
    throw new Error(`Secret ${secretArn} has no string value. It may never have been populated.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(out.SecretString);
  } catch {
    /*
     * A secret that is not JSON is almost certainly the password pasted in raw, which is a
     * forgivable mistake and a working credential. Accepted rather than rejected, because refusing
     * it would turn a deployment that is one `put-secret-value` from working into one that reports
     * a parse error.
     */
    return out.SecretString;
  }
  if (typeof parsed === "object" && parsed !== null && "password" in parsed) {
    const password = (parsed as { password: unknown }).password;
    if (typeof password === "string" && password.length > 0) return password;
  }
  throw new Error(
    `Secret ${secretArn} does not contain a non-empty "password" key. ` +
      `Expected {"password":"..."} - see README §3.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Pool                                                                       */
/* -------------------------------------------------------------------------- */

let poolPromise: Promise<Pool> | null = null;

async function createPool(): Promise<Pool> {
  registerTypeParsers();
  const password = await readPassword();

  const pool = new Pool({
    host: NeotmsEnv.NEOTMS_DB_HOST,
    port: Number(NeotmsEnv.NEOTMS_DB_PORT),
    user: NeotmsEnv.NEOTMS_DB_USER,
    database: NeotmsEnv.NEOTMS_DB_NAME,
    password,
    /*
     * TLS is mandatory on Supabase and `rejectUnauthorized` is the only interesting knob.
     *
     * With a CA supplied we verify properly. Without one we still encrypt but do not authenticate
     * the server, which leaves an active network attacker able to impersonate the pooler. That is
     * the weaker setting and it is the default ONLY because the alternative - failing to start
     * until someone fetches Supabase's CA bundle - would block a deployment on a step nobody has
     * been told about yet. Set NEOTMS_DB_CA_CERT to close it; README §3 has the two commands.
     */
    ssl: NeotmsEnv.NEOTMS_DB_CA_CERT
      ? { ca: NeotmsEnv.NEOTMS_DB_CA_CERT, rejectUnauthorized: true }
      : { rejectUnauthorized: false },
    /*
     * Two connections per container, not ten.
     *
     * A Lambda container serves one invocation at a time, so one connection would almost do; the
     * second exists so that a `pgTransaction` holding a client cannot deadlock against a query
     * issued inside its own body. Anything beyond that is multiplied by the number of warm
     * containers (up to `reservedConcurrentExecutions`, 20) and spent against a pooler quota that
     * is shared with the dashboard and PostgREST.
     */
    max: 2,
    /*
     * Shorter than Supavisor's own idle timeout, on purpose.
     *
     * Whoever closes an idle socket first decides what the other end sees. If the pooler closes it,
     * this process discovers the fact as an error on the next query; if we close it, the next query
     * opens a fresh one and nothing is ever in a half-dead state. 30s also means a container idle
     * between bursts is not holding pooler slots it is not using.
     */
    idleTimeoutMillis: 30_000,
    // Well inside the function's 29s budget, so a pooler that is refusing connections surfaces as a
    // 503 with time left to report it rather than as an API Gateway 504.
    connectionTimeoutMillis: 5_000,
    /*
     * Prepared statements are NOT supported by the shared pooler in transaction mode. This is the
     * line that keeps us away from them: node-postgres only issues a named PREPARE when a query is
     * given a `name`, and nothing here ever sets one. Said out loud because adding `name` to a
     * query object is an obvious-looking optimisation whose failure mode is an error from the
     * pooler about a prepared statement that does not exist, on a random subset of requests.
     */
    application_name: `neotms-${NeotmsEnv.NEOTMS_STAGE}`,
  });

  /*
   * Without this handler, a dropped idle socket CRASHES the function.
   *
   * node-postgres re-emits a connection error on the Pool when the client it happened to is idle,
   * and an 'error' event with no listener is an unhandled exception in Node - which kills the
   * container mid-request, for a connection nobody was using. This is the single most common way a
   * Lambda-plus-pg deployment produces 502s that do not correlate with anything in the logs.
   */
  pool.on("error", (err) => {
    console.error(`[pg] idle client error (connection discarded, not fatal): ${err.message}`);
  });

  return pool;
}

/**
 * The process-wide pool, created once per container.
 *
 * The promise rather than the pool is cached, so two concurrent cold-start queries share one
 * Secrets Manager call and one pool instead of racing to build two.
 */
async function getPool(): Promise<Pool> {
  poolPromise ??= createPool().catch((err) => {
    // Do not cache a failed construction: a Secrets Manager blip at cold start would otherwise
    // poison the container for the rest of its life.
    poolPromise = null;
    throw err;
  });
  return poolPromise;
}

/**
 * Throw the pool away so the next query rebuilds it, re-reading the secret.
 *
 * This is what makes password rotation self-healing. Rotating the Supabase password invalidates the
 * credential every warm container is holding; without this, those containers keep failing
 * authentication until Lambda happens to recycle them, which can take hours and looks like an
 * intermittent outage. With it, the first auth failure after a rotation costs one request and the
 * container recovers on the next.
 */
async function discardPool(reason: string): Promise<void> {
  const existing = poolPromise;
  poolPromise = null;
  if (!existing) return;
  console.warn(`[pg] discarding the connection pool: ${reason}`);
  try {
    await (await existing).end();
  } catch (err) {
    // Already broken; the point was to stop using it, and that has happened.
    console.warn(`[pg] pool shutdown after discard failed, continuing: ${err}`);
  }
}

/** Test-only: drop the cached pool and the registered parsers. */
export async function _resetPool(): Promise<void> {
  await discardPool("test reset");
  typeParsersRegistered = false;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * PostgreSQL hands back a five-character SQLSTATE on `err.code`. `""` when there is none - a
 * socket-level failure has no SQLSTATE at all.
 *
 * Exported because a few managers need to recognise one specific violation and answer it with a
 * sentence of their own. `exceptionToErrorResponse` below gives every 23505 the message "That
 * record already exists.", which is right for a customer and useless for `sys_code`, where the
 * unique constraint spans every domain and the actionable fact is that the code is registered under
 * a DIFFERENT list. Those managers catch, compare against this, and rethrow anything else - so the
 * default mapping stays the default and the exceptions are visible as exceptions. Nothing outside
 * this file should reach into `err.code` directly; how a driver reports its codes is this module's
 * business.
 */
export function sqlState(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err ? String(err.code) : "";
}

function errorMessage(err: unknown): string {
  return typeof err === "object" && err !== null && "message" in err ? String(err.message) : "";
}

/**
 * Is this worth trying again?
 *
 * Two disjoint groups, and the first is the one that matters in practice:
 *
 *   * Socket-level failures with no SQLSTATE at all. A Lambda container frozen between invocations
 *     wakes holding a TCP connection the pooler has already reaped, and the first query fails with
 *     `ECONNRESET` or «Connection terminated unexpectedly». This is the normal, expected cost of
 *     running a connection pool in a runtime that suspends processes, and it is why this function
 *     exists at all.
 *   * Server states that are explicitly temporary: class 08 (connection exception), shutdown and
 *     cannot-connect-now, too-many-connections, and the two serialisation failures.
 *
 * Deliberately NOT retryable: a constraint violation, a syntax error, a permission problem. Those
 * fail identically on the second attempt, so retrying only turns a clear error into a slow one.
 */
export function isTransient(err: unknown): boolean {
  const state = sqlState(err);
  if (state) {
    if (state.startsWith("08")) return true; // connection_exception
    return (
      state === "57P01" || // admin_shutdown
      state === "57P02" || // crash_shutdown
      state === "57P03" || // cannot_connect_now
      state === "53300" || // too_many_connections
      state === "40001" || // serialization_failure
      state === "40P01" // deadlock_detected
    );
  }
  const message = errorMessage(err).toLowerCase();
  return (
    message.includes("econnreset") ||
    message.includes("epipe") ||
    message.includes("etimedout") ||
    message.includes("connection terminated") ||
    message.includes("connection closed") ||
    message.includes("socket hang up") ||
    message.includes("timeout exceeded when trying to connect") ||
    // Supavisor's own back-pressure, which arrives as a plain message rather than a SQLSTATE.
    message.includes("max client connections reached")
  );
}

/** A credential that no longer works - almost always a rotation the containers have not seen. */
function isAuthFailure(err: unknown): boolean {
  const state = sqlState(err);
  return state === "28P01" || state === "28000";
}

export type PgErrorDetail = { status: number; name: string; message: string };

/**
 * Map a PostgreSQL error to the status this codebase should report.
 *
 * Driven by SQLSTATE rather than by string matching, which is the one unambiguous improvement the
 * port gets for free: the Data API flattened everything into `BadRequestException` with the real
 * code buried in a message, so the ASv2 version of this function had to grep for `"23505"` inside
 * prose. Here `err.code` IS the code.
 *
 * The distinction that matters most is 503 vs 500. A pooler at capacity or a dropped connection is
 * transient and the client should retry; a constraint violation or a bug is not, and a client that
 * retries a 500 makes the problem worse. The legacy system returned 500 for both, which is why
 * nobody could tell a deploy problem from an overloaded database.
 */
export function exceptionToErrorResponse(err: unknown): PgErrorDetail {
  const state = sqlState(err);
  const name = state || (typeof err === "object" && err !== null && "name" in err ? String(err.name) : "UnknownError");

  if (isAuthFailure(err)) {
    return {
      status: 500,
      name,
      message: "The database credential was rejected. It may have been rotated.",
    };
  }
  if (isTransient(err)) {
    return { status: 503, name, message: "The database is temporarily unreachable. Please retry." };
  }

  switch (state) {
    case "23505": // unique_violation
      return { status: 409, name, message: "That record already exists." };
    case "23503": // foreign_key_violation
      return { status: 409, name, message: "A referenced record does not exist." };
    case "23502": // not_null_violation
      return { status: 400, name, message: "A required field was missing." };
    case "23514": // check_violation
    case "23001": // restrict_violation
      return { status: 400, name, message: "That change is not allowed by a data rule." };
    case "22P02": // invalid_text_representation
    case "22007": // invalid_datetime_format
    case "22003": // numeric_value_out_of_range
      return { status: 400, name, message: "A value was not in the expected format." };
    case "57014": // query_canceled - i.e. statement_timeout fired
      return { status: 504, name, message: "The statement took too long and was cancelled." };
    case "42501": // insufficient_privilege
      // The caller did nothing wrong and must not be told to fix their request.
      return { status: 500, name, message: "The service is not permitted to read that data." };
    case "3D000": // invalid_catalog_name
    case "3F000": // invalid_schema_name
      return { status: 500, name, message: "The database connection is misconfigured." };
    case "42P01": // undefined_table
    case "42703": // undefined_column
    case "42601": // syntax_error
    case "42883": // undefined_function - the usual sign that PGroonga is not on the search_path
      return { status: 500, name, message: "The statement could not be executed." };
    default:
      return { status: 500, name, message: "An unexpected database error occurred." };
  }
}

/* -------------------------------------------------------------------------- */
/* Transient retry                                                            */
/* -------------------------------------------------------------------------- */

/** Attempts, including the first. A reconnect takes milliseconds, not seconds. */
const RETRY_MAX_ATTEMPTS = 4;
/** First backoff. Doubles: 150, 300, 600 - about a second in total. */
const RETRY_BASE_DELAY_MS = 150;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Retry an operation for as long as the only thing wrong is the connection.
 *
 * Every executor goes through here, so no caller can forget it. Four details:
 *
 *   * An authentication failure discards the pool and is then retried ONCE, because the realistic
 *     cause is a rotation this container has not seen and the retry re-reads the secret. A genuinely
 *     wrong password therefore costs two attempts and then reports honestly.
 *   * A transient failure also discards the pool when it looks socket-shaped, because the pool is
 *     holding at least one connection that is known bad.
 *   * Jitter on the backoff. When the pooler recovers, every concurrent Lambda retries at once;
 *     without jitter they land in the same millisecond and the first thing it sees is a herd.
 *   * The budget (~1s over 4 attempts) is well inside the function's 29s timeout. A failure that
 *     outlasts it is not a blip - it is an outage, and it should surface as one.
 */
export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  label: string,
): Promise<T> {
  let lastErr: unknown = null;
  let credentialRetried = false;

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await operation();
    } catch (err) {
      lastErr = err;

      if (isAuthFailure(err)) {
        if (credentialRetried) throw err;
        credentialRetried = true;
        await discardPool("the credential was rejected; re-reading the secret");
        continue;
      }

      if (!isTransient(err)) throw err;
      await discardPool(`transient failure on ${label}`);
      if (attempt === RETRY_MAX_ATTEMPTS) break;

      const backoff = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      const jittered = backoff / 2 + Math.random() * (backoff / 2);
      console.warn(
        `[pg] transient failure, retrying ${label} (attempt ${attempt}/${RETRY_MAX_ATTEMPTS}) in ${Math.round(jittered)}ms`,
      );
      await sleep(jittered);
    }
  }

  console.error(`[pg] gave up after ${RETRY_MAX_ATTEMPTS} attempts: ${label}`);
  throw lastErr;
}

/* -------------------------------------------------------------------------- */
/* Executors                                                                  */
/* -------------------------------------------------------------------------- */

async function run(
  sql: string,
  parameters: SqlParameter[] | undefined,
  client: PoolClient | undefined,
  label: string,
): Promise<SqlRow[] & { rowCount: number }> {
  /*
   * Translated OUTSIDE the retry, so a malformed statement is reported once rather than four times
   * - and so the thrown "no such parameter" error is not mistaken for a transient failure.
   */
  const { text, values } = toPositional(sql, parameters);

  const execute = async () => {
    if (client) return client.query(text, values);
    const pool = await getPool();
    return pool.query(text, values);
  };

  /*
   * A statement inside an explicit transaction is NOT retried here.
   *
   * Retrying it would re-send one statement onto a connection whose transaction the failure has
   * already aborted, which produces a confusing «current transaction is aborted» on top of the real
   * error. The whole transaction is the only correct retry unit, and that is the caller's decision.
   */
  const out = client ? await execute() : await withTransientRetry(execute, label);

  const rows = out.rows as SqlRow[];
  return Object.assign(rows, { rowCount: out.rowCount ?? 0 });
}

/** Run a read. */
export async function pgQuery<T>(ops: SqlOps<T>, client?: PoolClient): Promise<PgResponse<T>> {
  const rows = await run(ops.sql, ops.parameters, client, "query");
  return { data: ops.mapper(rows), status: 200, message: "Query successful" };
}

/**
 * Run a write.
 *
 * Returns the mapped rows too, because the house style is `INSERT ... RETURNING` rather than an
 * insert followed by a select: one round trip instead of two, and no window in which another
 * request could have changed the row in between.
 */
export async function pgExecute<T>(ops: SqlOps<T>, client?: PoolClient): Promise<PgResponse<T>> {
  const rows = await run(ops.sql, ops.parameters, client, "execute");
  return { data: ops.mapper(rows), status: 200, message: "Statement executed" };
}

/** Run a write whose rows are not wanted. Returns the number of rows affected. */
export async function pgExecuteCount(
  ops: SqlWriteOps,
  client?: PoolClient,
): Promise<PgResponse<number>> {
  const rows = await run(ops.sql, ops.parameters, client, "execute");
  return { data: rows.rowCount, status: 200, message: "Statement executed" };
}

/**
 * Run several statements as one transaction.
 *
 * Simpler than the ASv2 branch's version, and the difference is worth knowing. The Data API has no
 * session, so a transaction there was three separate HTTPS calls correlated by a `transactionId`,
 * and any statement that forgot to pass it silently committed on its own. Here a transaction is a
 * single connection held for its duration, so the thing that cannot be forgotten is the client -
 * and the body receives it as an argument rather than reading it from anywhere ambient.
 *
 * Two Supavisor consequences:
 *
 *   * The whole transaction MUST run on one client. In transaction mode the pooler assigns a
 *     backend per transaction, so a statement sent on a different connection reaches a different
 *     backend, outside this transaction. Passing the client through is not a style choice.
 *   * Keep it short. The backend is unavailable to every other caller until COMMIT, so a
 *     transaction that waits on anything (an S3 upload, an HTTP call) is holding a shared resource
 *     while doing no database work.
 *
 * Used where an invariant spans tables - creating a job and its first PO together, so a failure
 * cannot leave revenue booked with no cost line.
 */
export async function pgTransaction<T>(body: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = await getPool();
  const client = await withTransientRetry(() => pool.connect(), "beginTransaction");

  try {
    await client.query("BEGIN");
    const result = await body(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      /*
       * Swallowed, and only swallowed here.
       *
       * The original error is what the caller needs to see; a rollback failure on top of it would
       * replace a useful message ("duplicate key on customer.code") with a useless one. Logged so
       * it is not invisible - repeated rollback failures mean connections are dying mid-transaction.
       */
      console.error(`[pg] rollback failed: ${rollbackErr}`);
    }
    throw err;
  } finally {
    /*
     * `release()` is what returns the backend to the pooler. Without it the connection leaks and
     * the container runs out after `max` transactions - which presents as every request hanging for
     * `connectionTimeoutMillis` and then 503ing, with the database completely idle.
     */
    client.release();
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
   * pagination scheme exists to avoid.
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
    parameters: [param("cursor_sort", cursor.sortValue, "text"), param("cursor_id", cursor.id, "id")],
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
    console.error(`[pg] cannot build a cursor: ${idColumn} missing from the last row of a page`);
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
