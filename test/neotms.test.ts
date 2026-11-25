// SPDX-License-Identifier: MIT
//
// These are not "does CDK work" tests. Every assertion here guards a decision that costs real money
// or real correctness if it is quietly reverted, and that would otherwise only be noticed on a bill
// or in an outage.
//
// The NAT Gateway case is the reason this file exists. Adding `vpc` to the Lambda is a one-line,
// entirely reasonable-looking change; CDK responds by creating a NAT Gateway so the function has
// egress, and the bill moves by ~$43/month with nothing else visibly different. That is close to
// half the project's entire monthly budget. A test is the only thing that turns it into a red CI
// run instead of a surprise a month later.
//
// Some of what is asserted below is not CloudFormation at all. The PGroonga section reads
// `db/*.sql` as text, because the highest-risk failure in this design is a search index that builds
// successfully and is then never used - which no synthesised template can show.

import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cdk from "aws-cdk-lib/core";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  NEOTMS_AUTH_CONTEXT_KEYS,
  NEOTMS_CONFIGS,
  NEOTMS_SUPABASE_CONTEXT_KEYS,
  resolveStageConfig,
} from "../infra/config/NeotmsConfig.js";
import { NeotmsStack } from "../infra/stacks/neotms-stack.js";
// A bare table of string constants with no imports of its own, so pulling it in here costs nothing
// and does not trip the Lambda's environment validation. It is imported rather than retyped because
// the test below is precisely an assertion that these two lists agree.
import { NeotmsMenu } from "../lambdas/neotms/nodejs/neotms/NeotmsMenus.js";
/*
 * The permission vocabulary, imported rather than retyped. Two assertions below are precisely that
 * this list and the CHECK on `sys_role_permission` are the same set - one is what the application
 * compares against, the other is what the database will store, and nothing reconciles them at
 * runtime. A file of constant strings with no imports of its own, so pulling it in costs nothing.
 */
import {
  NEOTMS_PERMISSIONS,
  NEOTMS_USER_ATTRIBUTES,
} from "../lambdas/neotms/nodejs/auth/NeotmsAuthorities.js";
// Likewise importable for free - a frozen list of seven strings with no imports of its own. It is
// the third member of a set of three lists that have to agree and that nothing reconciles at
// runtime; see `describe("the currency seed")`.
import { CURRENCY_CODES, FX_CURRENCY_CODES } from "../lambdas/neotms/nodejs/neotms/NeotmsCurrency.js";
/*
 * The one frontend module imported rather than read as text, and the exception proves the rule the
 * other frontend assertions follow.
 *
 * Those read source because `@/...` aliases would have to be taught to jest. `format.ts` has no
 * imports at all, so there is nothing to resolve. More to the point, string-matching is the wrong
 * instrument here: every other frontend assertion guards a DECISION that is visible in the source,
 * whereas these four functions do arithmetic, and the failures worth catching - a +1 that lands on
 * the 32nd, a 2026-02-30 that silently becomes March - are not visible in any substring. They have
 * to be executed.
 */
import {
  addDays,
  alignPeriod,
  calendarMonth,
  formatDateField,
  parseDateField,
  shiftMonth,
} from "../frontend/src/shared/utils/format.js";
/*
 * The third module imported rather than read, and for `format.ts`'s reason rather than
 * `NeotmsMenus`'s: the handover mail composer does arithmetic, and the failures worth catching are
 * not visible in any substring - a weekday computed through the local timezone, an off-by-one on
 * the '4개국어 이상' rule, an unescaped `</td>` that silently shifts a table column.
 *
 * Free to import. It pulls in `NeotmsJobTypes` (one constant, two pure functions) and two
 * `import type`s, which erase - so no `pg` and no environment validation, the same test that
 * `NeotmsMenus` passes.
 */
import {
  composeHandoverMail,
  languageGroups,
  HANDOVER_FORMATS,
  HANDOVER_LAYOUTS,
} from "../lambdas/neotms/nodejs/neotms/handover/NeotmsHandoverMail.js";
import type { HandoverJob } from "../lambdas/neotms/nodejs/neotms/handover/NeotmsHandover.dbops.js";
import type { ProjectRow } from "../lambdas/neotms/nodejs/neotms/projects/NeotmsProject.dbops.js";

/*
 * The synthesised template for a stage, built at most once per run.
 *
 * Memoised because synthesis bundles the Lambda with esbuild, which takes about a second; with one
 * synth per test that was the entire runtime of this file. Safe because synthesis is deterministic
 * and every assertion below only READS the template - if a test ever needs to mutate one, it should
 * build its own stack the way the last test in this file does, not reach for this.
 */
const templates = new Map<string, Template>();

function synth(stage: "dev" | "prod" = "prod"): Template {
  const cached = templates.get(stage);
  if (cached) return cached;

  const app = new cdk.App();
  const stack = new NeotmsStack(app, "TestStack", {
    config: NEOTMS_CONFIGS[stage],
    env: { account: "123456789012", region: "ap-northeast-2" },
  });
  const template = Template.fromStack(stack);
  templates.set(stage, template);
  return template;
}

describe("cost guards", () => {
  test("no NAT Gateway exists", () => {
    // ~$43/month before a byte flows through it. On this variant there is nothing in the stack that
    // would need one: the database is at Supabase, reached over TLS on the public internet, so the
    // function has no reason to be in a VPC and no VPC exists for it to be put into.
    synth().resourceCountIs("AWS::EC2::NatGateway", 0);
  });

  test("no Elastic IP is allocated", () => {
    // A NAT Gateway drags an EIP with it, so this is a second, independent tripwire for the same
    // mistake - it fails even if someone adds a NAT instance by hand instead.
    synth().resourceCountIs("AWS::EC2::EIP", 0);
  });

  test("the API function is not attached to a VPC", () => {
    // `VpcConfig` absent is what keeps egress to the LPX OIDC endpoints free and keeps the NAT
    // Gateway unnecessary. If this fails, the two tests above are about to start failing too.
    synth().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "neotms-api",
      VpcConfig: Match.absent(),
    });
  });

  test("the stack contains no RDS resource of any kind", () => {
    /*
     * The whole point of this variant, as one assertion.
     *
     * Written as a scan over every resource type rather than as counts of the types that used to be
     * here, because the mistake it guards against is not "someone re-adds the cluster" - nobody does
     * that by accident. It is a half-finished revert, or a copy-paste from the `neotms-a` branch
     * that brings back a parameter group, a subnet group or an RDS Proxy on its own. Any one of
     * those deploys cleanly, costs money, and is reachable by nothing.
     */
    const types = Object.values(synth().toJSON().Resources as Record<string, { Type: string }>)
      .map((resource) => resource.Type)
      .filter((type) => type.startsWith("AWS::RDS::"));
    expect(types).toEqual([]);
  });

  test("no VPC is created", () => {
    // The independent tripwire for the NAT Gateway: no VPC means `vpc:` on the function has nothing
    // to point at, so the mistake is a synth error in a pull request rather than a line on a bill.
    synth().resourceCountIs("AWS::EC2::VPC", 0);
  });
});

describe("the database credential", () => {
  test("the secret's generated value does not depend on any config value", () => {
    /*
     * The landmine this guards is specific and quiet.
     *
     * `generateSecretString` is only evaluated when CloudFormation creates or REPLACES the secret -
     * but editing it is an UPDATE that regenerates the password. The friendly-looking version of
     * this block is `secretStringTemplate: JSON.stringify({ username: poolerUser(ref) })`, which
     * makes the generated password a function of `projectRef`. The first
     * `cdk deploy -c supabaseProjectRef=...` after go-live would then silently replace the real
     * password with a fresh random one, and the symptom is the entire system answering 500 after a
     * deploy that changed nothing a human can see.
     *
     * `"{}"` is the only template with no config in it. The username lives in the function's
     * environment, where it is not a secret and costs nothing to change.
     */
    synth().hasResourceProperties("AWS::SecretsManager::Secret", {
      GenerateSecretString: Match.objectLike({
        SecretStringTemplate: "{}",
        GenerateStringKey: "password",
      }),
    });
  });

  test("the function may read the secret and has no rds-data grant", () => {
    // One grant where the Aurora variant needed two. The second half of this is a staleness check:
    // an `rds-data` action surviving here would mean an IAM policy was carried over from the other
    // branch, which is exactly the kind of leftover that is invisible in review.
    const statements = JSON.stringify(synth().findResources("AWS::IAM::Policy"));
    expect(statements).toContain("secretsmanager:GetSecretValue");
    expect(statements).not.toContain("rds-data:");
  });

  test("the password travels as an ARN, never as an environment variable", () => {
    /*
     * Env vars are readable by anyone with console access to the function, they appear in
     * `cdk.out/` and in any CI log that prints a diff, and changing one needs a redeploy. The ARN
     * is what travels; the value is read at first use and cached in the execution environment.
     *
     * Asserted over the variable NAMES rather than over the serialised block, because the block
     * legitimately contains the string "Password" - it is part of the secret's generated logical
     * id inside `NEOTMS_DB_SECRET_ARN`'s `Ref`, which is precisely the thing that is supposed to be
     * there. The realistic mistake this catches is a second variable added for local debugging.
     */
    const api = Object.values(synth().findResources("AWS::Lambda::Function")).find(
      (fn) => fn.Properties.FunctionName === "neotms-api",
    )!;
    const variables = api.Properties.Environment.Variables as Record<string, unknown>;

    for (const name of Object.keys(variables)) {
      expect(name).not.toMatch(/PASSWORD/i);
    }
    // And the one secret-shaped variable is an unresolved reference, not a literal. A plain string
    // here would mean someone had read the secret at synthesis time and baked it into the template.
    expect(variables.NEOTMS_DB_SECRET_ARN).toEqual({ Ref: expect.any(String) });
  });

  test("the connection coordinates reach the function's environment", () => {
    // Host, port, user, database and the secret ARN are five values that must all be right, and
    // `isDatabaseConfigComplete()` in the Lambda fails closed on any of them being blank - which is
    // correct, and diagnosable only at runtime. The ARN is an intrinsic, so it is matched loosely.
    synth().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "neotms-api",
      Environment: {
        Variables: Match.objectLike({
          NEOTMS_DB_PORT: "6543",
          NEOTMS_DB_NAME: "postgres",
          NEOTMS_DB_SECRET_ARN: Match.anyValue(),
        }),
      },
    });
  });

  test("the pooler port is the transaction-mode one, not 5432", () => {
    /*
     * 6543 is not a preference. Session mode (5432 on the pooler) pins a server connection for the
     * life of a client connection, so a function with reserved concurrency above the project's
     * connection limit exhausts the pool under load; and the direct endpoint, also 5432, resolves
     * to IPv6 only without the paid add-on, which a Lambda outside a VPC cannot reach at all. The
     * price of 6543 is paid in PostgresUtils: no prepared statements, no session state. Changing
     * this number means changing that file too.
     */
    for (const config of Object.values(NEOTMS_CONFIGS)) {
      expect(config.supabase.poolerPort).toBe(6543);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Korean full-text search                                                    */
/* -------------------------------------------------------------------------- */

const dbDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db");
const sql = (file: string) => readFileSync(path.join(dbDir, file), "utf8");

/**
 * Every `USING pgroonga (...)` in 003_indexes.sql, as (index, table, column, opclass).
 *
 * The operator class is OPTIONAL in this pattern, and that is deliberate: it is the thing the test
 * below checks for. Requiring it here would mean an index that omits it simply did not appear in
 * this list, and the failure would surface as the count assertion being one short - which says
 * nothing about what is actually wrong. A missing opclass comes back as `undefined` instead, and
 * gets named.
 */
function pgroongaIndexes(): {
  index: string;
  table: string;
  column: string;
  opclass: string | undefined;
}[] {
  const pattern =
    /CREATE\s+INDEX\s+(\w+)\s+ON\s+(\w+)\s+USING\s+pgroonga\s*\(\s*(\w+)(?:\s+([\w.]+))?\s*\)/gi;
  return [...sql("001_schemas.sql").matchAll(pattern)].map((m) => ({
    index: m[1],
    table: m[2],
    column: m[3],
    opclass: m[4],
  }));
}

/**
 * The declared type of every column, keyed `table.column`.
 *
 * A deliberately small parser: it tracks the current `CREATE TABLE` and reads the first two words
 * of each indented line inside it. That is enough because 002_tables.sql is machine-uniform - one
 * column per line, name then type - and a parser that understood more of the SQL grammar would be
 * a second thing to maintain. Table-scoped rather than keyed on the column name alone because
 * `cus_name`, `mgr_name` and `cus_mgr_name` each appear on more than one table.
 */
function columnTypes(): Map<string, string> {
  const types = new Map<string, string>();
  let table: string | null = null;

  for (const raw of sql("001_schemas.sql").split(/\r?\n/)) {
    const create = /^CREATE TABLE (\w+)\s*\(/.exec(raw);
    if (create) {
      table = create[1];
      continue;
    }
    if (!table) continue;
    if (/^\s*\)/.test(raw)) {
      table = null;
      continue;
    }
    const column = /^\s+(\w+)\s+([a-z0-9_]+(?:\s+precision)?)/i.exec(raw);
    if (column) types.set(`${table}.${column[1]}`, column[2].toLowerCase());
  }
  return types;
}

describe("Korean full-text search", () => {
  test("there are search indexes at all, and all of them are PGroonga", () => {
    // A sanity bound on the two tests below: they both iterate over whatever the parser found, so a
    // regex that silently stopped matching would turn them into assertions about nothing.
    const indexes = pgroongaIndexes();
    expect(indexes.length).toBeGreaterThanOrEqual(16);
    // Comment-stripped: the extensions prose NAMES pg_bigm as the alternative it rejected.
    expect(sqlCode("001_schemas.sql")).not.toMatch(/gin_bigm_ops|pg_bigm/);
    expect(sql("001_schemas.sql")).toContain("CREATE EXTENSION IF NOT EXISTS pgroonga");
  });

  test("every PGroonga index uses the regexp operator class", () => {
    /*
     * `USING pgroonga (col)` with no operator class builds an index that looks right, reports a
     * sensible size, and does not serve `LIKE '%X%'` - the default class answers `&@` and `&@~`,
     * not `LIKE`. The planner falls back to a sequential scan with no warning anywhere, so this is
     * a defect that only shows up as "search got slow" months later on a bigger table.
     *
     * Collected rather than asserted in the loop so a failure names the index; `undefined` in the
     * output means the opclass was omitted entirely, which is the realistic version of this mistake.
     */
    const wrong = pgroongaIndexes()
      .filter((index) => index.opclass !== "extensions.pgroonga_text_regexp_ops_v2")
      .map((index) => ({ index: index.index, opclass: index.opclass }));

    expect(wrong).toEqual([]);
  });

  test("every operator class is schema-qualified", () => {
    /*
     * The qualification is not style. 001_extensions.sql installs PGroonga and pg_trgm `WITH SCHEMA
     * extensions`, following Supabase's convention, so their operator classes are not in `public`.
     * An unqualified name is resolved against the caller's search_path, and a role without
     * `extensions` on it gets
     *
     *   ERROR: operator class "pgroonga_text_regexp_ops_v2" does not exist
     *          for access method "pgroonga"
     *
     * from the FIRST index statement in the file - a message that reads as "PGroonga is broken" and
     * mentions nothing about search_path. This was a live defect, found by applying db/*.sql to a
     * real PGroonga-enabled Postgres; it is asserted here because the error only appears at
     * bootstrap time, which is exactly when nobody has a baseline to compare against.
     *
     * The trigram indexes are checked by the same rule and for the same reason.
     */
    const unqualified = [
      ...sql("001_schemas.sql").matchAll(/USING\s+(?:pgroonga|gin)\s*\([^)]*?\s+(\w+_ops\w*)\s*\)/gi),
    ].map((m) => m[1]);

    expect(unqualified).toEqual([]);
  });

  test("every searched column is declared text, never varchar", () => {
    /*
     * THE landmine of this design.
     *
     * PGroonga cannot index `varchar`. `LIKE`/`ILIKE` on a varchar column is always a sequential
     * scan, and - this is the part that makes it dangerous - `CREATE INDEX ... USING pgroonga` on a
     * varchar column SUCCEEDS. There is no error at build time, no error at query time, and nothing
     * in the output of `\d` that says the index is dead. The legacy schema is full of `nvarchar`,
     * so "tidy this column up to match the old system" is a realistic and completely silent
     * regression.
     *
     * db/004_verify_search.sql asserts the query PLAN against a live database, which is the only
     * complete check. This one runs in CI without one.
     */
    const types = columnTypes();
    const offenders = pgroongaIndexes()
      .map((index) => ({ at: `${index.table}.${index.column}`, type: types.get(`${index.table}.${index.column}`) }))
      .filter((found) => found.type !== "text");

    // Compared as a list so a failure names the column and its type, rather than reporting that
    // `undefined` was not `"text"`. An unparsed column shows up here too, as `undefined`.
    expect(offenders).toEqual([]);
  });
});

describe("report exports", () => {
  test("the export bucket is SSE-S3 and the stack has no KMS key", () => {
    /*
     * This assertion was the other way round on the Aurora variant, and the reason is worth
     * keeping: `aws_s3.query_export_to_s3` refuses to write to a bucket that is not SSE-KMS, and
     * that function was only used because the Data API capped a result set at 1 MiB. Over a plain
     * socket PostgreSQL is not involved in an export at all - the Lambda renders the XLSX and
     * writes it - so the customer-managed key, its alias, its rotation and the two grants that
     * referenced it are all deleted. SSE-S3 is free; the key was ~$1/month plus request charges.
     */
    const template = synth();
    template.hasResourceProperties("AWS::S3::Bucket", {
      BucketName: Match.stringLikeRegexp("^neotms-exports-"),
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: "AES256" }),
          }),
        ]),
      }),
    });
    template.resourceCountIs("AWS::KMS::Key", 0);
  });

  test("exports expire, so stale financial snapshots do not accumulate", () => {
    // The bucket is a staging area for responses too large for Lambda's 6MB payload limit, not a
    // record. A report kept past its lifecycle is a number someone will eventually quote.
    synth().hasResourceProperties("AWS::S3::Bucket", {
      BucketName: Match.stringLikeRegexp("^neotms-exports-"),
      LifecycleConfiguration: Match.objectLike({
        Rules: Match.arrayWith([
          Match.objectLike({ Id: "expire-exports", ExpirationInDays: 7, Status: "Enabled" }),
        ]),
      }),
    });
  });
});

describe("production data protection", () => {
  /** The one Secrets Manager secret in the stack - the database password. */
  function dbSecret(stage: "dev" | "prod"): Record<string, any> {
    const secrets = synth(stage).findResources("AWS::SecretsManager::Secret");
    expect(Object.keys(secrets)).toHaveLength(1);
    return Object.values(secrets)[0];
  }

  test("the production credential is retained", () => {
    /*
     * This replaces the cluster retain/destroy pair, and it protects something different.
     *
     * Deleting this secret does not delete any data - the database is at Supabase and survives
     * `cdk destroy` completely. What it destroys is the ability to CONNECT: the password is only
     * recoverable from the secret, so losing it while the project lives on means someone has to
     * reset the password at Supabase before anything works again. Retaining it in production makes
     * an accidental teardown recoverable instead of merely survivable.
     */
    expect(dbSecret("prod").DeletionPolicy).toBe("Retain");
  });

  test("dev is destroyable, so a stack can actually be torn down", () => {
    // Without this a `cdk destroy` of dev leaves orphaned secrets behind, and the next deploy fails
    // on the name already existing - inside a 7-to-30-day recovery window nobody can shorten.
    expect(dbSecret("dev").DeletionPolicy).toBe("Delete");
  });

  test("every DynamoDB table expires its rows by TTL", () => {
    /*
     * TTL is the only thing that deletes either kind of row, and in both cases its absence is
     * silent: sessions would accumulate forever, and attachment tokens would stay valid after the
     * S3 lifecycle rule had already deleted the bytes they point at - turning "this link has
     * expired" into "this link is broken".
     *
     * Asserted over ALL tables rather than with `hasResourceProperties`, which passes as soon as
     * one resource of the type matches: the moment a second table existed, the old form could no
     * longer say which of the two it had checked. A table added later with no TTL fails here.
     */
    const tables = Object.values(synth().findResources("AWS::DynamoDB::GlobalTable"));
    expect(tables.map((t) => t.Properties.TableName as string).sort()).toEqual([
      "neotms-attachments",
      "neotms-sessions",
    ]);
    for (const table of tables) {
      expect(table.Properties.TimeToLiveSpecification).toEqual({
        AttributeName: "NTTTL",
        Enabled: true,
      });
    }
  });
});

type CorsRule = { AllowedMethods?: string[]; AllowedOrigins?: unknown[] };

/** The attachment bucket's CORS rules, in template order. */
function attachmentCorsRules(stage: "dev" | "prod"): CorsRule[] {
  const buckets = Object.values(synth(stage).findResources("AWS::S3::Bucket"));
  const matches = buckets.filter(
    (b) =>
      typeof b.Properties.BucketName === "string" &&
      (b.Properties.BucketName as string).includes("-attachments-"),
  );
  expect(matches).toHaveLength(1);
  return (matches[0].Properties.CorsConfiguration?.CorsRules ?? []) as CorsRule[];
}

/** The logical id of the one distribution, so an intrinsic can be shown to point AT it. */
function distributionLogicalId(stage: "dev" | "prod"): string {
  const ids = Object.keys(synth(stage).findResources("AWS::CloudFront::Distribution"));
  expect(ids).toHaveLength(1);
  return ids[0];
}

describe("CORS", () => {
  test("the HTTP API declares no CORS configuration", () => {
    // Handled in the function instead. An API Gateway CORS config answers the preflight before the
    // function sees it, so a rejected origin gets a 403 with no CORS headers and the browser reports
    // an opaque network failure - the UI cannot tell 401 from "the API is down". Two mechanisms both
    // setting Access-Control-Allow-Origin also produce duplicate headers, which browsers reject.
    synth().hasResourceProperties("AWS::ApiGatewayV2::Api", {
      CorsConfiguration: Match.absent(),
    });
  });

  test("the deployed console may PUT straight to the attachment bucket", () => {
    /*
     * The bug this exists to prevent, and it had already happened: attachment bytes never pass
     * through the function - the browser PUTs them to a presigned URL - so the BUCKET has to allow
     * the console's origin, and that origin is a CloudFront domain that no config file can name.
     * Production's `allowedOriginUrls` is empty by design, so the rule built in the constructor
     * allowed nobody at all and every upload failed its preflight.
     *
     * A refused preflight writes nothing anywhere: no S3 access-log line, no 4xx metric, no
     * CloudWatch entry. The browser reports a bare network error, so the only thing that can catch
     * this is an assertion on the template.
     */
    const rules = attachmentCorsRules("prod");
    expect(rules).toHaveLength(1);
    expect(rules[0].AllowedMethods).toContain("PUT");
    // Not merely "some intrinsic": the origin must be built from THIS distribution's domain.
    expect(JSON.stringify(rules[0].AllowedOrigins)).toContain(distributionLogicalId("prod"));
  });

  test("a developer origin does not displace the console's own", () => {
    // Development has both, and they are different browsers: a Vite dev server on localhost and the
    // deployed console. Allowing only the configured one is what production got wrong.
    const rules = attachmentCorsRules("dev");
    expect(rules).toHaveLength(2);
    expect(rules[0].AllowedOrigins).toEqual(["http://localhost:5173"]);
    expect(JSON.stringify(rules[1].AllowedOrigins)).toContain(distributionLogicalId("dev"));
  });

  test("no CORS rule names an empty set of origins", () => {
    /*
     * S3 requires at least one origin per rule. `AllowedOrigins: []` - which is what production
     * synthesised while `allowedOriginUrls` was empty - is refused at DEPLOY time with a
     * `MalformedXML` naming neither the bucket nor the rule, so the whole stack fails to create a
     * bucket for a reason that reads as nothing in particular.
     */
    for (const stage of ["dev", "prod"] as const) {
      for (const rule of attachmentCorsRules(stage)) {
        expect(rule.AllowedOrigins?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  test("mailed attachment links point at the console, in both stages", () => {
    /*
     * `NEOTMS_PUBLIC_BASE_URL` is the host a TRANSLATOR will click, so the two values the config
     * alone can produce are both wrong: development's first origin is `http://localhost:5173`,
     * which would mail a link to the recipient's own machine, and production's list is empty, which
     * makes the function refuse to send at all. The distribution is the answer in both stages.
     */
    for (const stage of ["dev", "prod"] as const) {
      const fn = Object.values(synth(stage).findResources("AWS::Lambda::Function")).find((f) =>
        String(f.Properties.FunctionName).endsWith("-api"),
      )!;
      const variables = fn.Properties.Environment.Variables as Record<string, unknown>;
      const base = JSON.stringify(variables.NEOTMS_PUBLIC_BASE_URL);
      expect(base).toContain(distributionLogicalId(stage));
      expect(base).not.toContain("localhost");
    }
  });

  test("no allowed origin is a wildcard, in any stage", () => {
    // An over-broad origin on a cookie-bearing API is a session-theft primitive, and "we will
    // tighten it later" never happens.
    for (const config of Object.values(NEOTMS_CONFIGS)) {
      for (const origin of config.allowedOriginUrls) {
        expect(origin).not.toContain("*");
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The console                                                                */
/* -------------------------------------------------------------------------- */

type Behavior = {
  PathPattern?: string;
  TargetOriginId: string;
  CachePolicyId?: string;
  OriginRequestPolicyId?: string;
  AllowedMethods?: string[];
  FunctionAssociations?: { EventType: string }[];
  ViewerProtocolPolicy?: string;
};

type DistributionConfig = {
  Origins: { Id: string; DomainName: unknown }[];
  DefaultCacheBehavior: Behavior;
  CacheBehaviors?: Behavior[];
  CustomErrorResponses?: unknown[];
  PriceClass?: string;
};

/** The one distribution in the stack. Asserting there is exactly one is part of the point. */
function distributionConfig(template: Template): DistributionConfig {
  const found = Object.values(template.findResources("AWS::CloudFront::Distribution"));
  expect(found).toHaveLength(1);
  return found[0].Properties.DistributionConfig as DistributionConfig;
}

/**
 * The id of the origin whose domain name mentions `needle`.
 *
 * Both origin domains are unresolved intrinsics at synthesis time - the bucket's is a `GetAtt` on
 * `RegionalDomainName`, the API's an `Fn::Join` containing `.execute-api.` - so they are matched by
 * searching the serialised intrinsic rather than by comparing strings. Matching on the generated
 * logical id instead would make these tests fail on any unrelated construct rename.
 */
function originIdByDomain(config: DistributionConfig, needle: string): string {
  const matches = config.Origins.filter((o) => JSON.stringify(o.DomainName).includes(needle));
  expect(matches).toHaveLength(1);
  return matches[0].Id;
}

function apiBehavior(config: DistributionConfig): Behavior {
  const matches = (config.CacheBehaviors ?? []).filter((b) => b.PathPattern === "/api/*");
  expect(matches).toHaveLength(1);
  return matches[0];
}

describe("same-origin API", () => {
  test("the API is a behaviour on the console's own distribution", () => {
    // The load-bearing assertion of the whole construct. The browser's credential is a
    // `SameSite=Lax` cookie, which browsers do NOT attach to a cross-site fetch. Move the API to its
    // own hostname and `POST /api/auth/refresh` arrives with no cookie, the backend answers 401, and
    // every user is signed out about once an hour - while devtools still shows the cookie as present.
    expect(apiBehavior(distributionConfig(synth())).PathPattern).toBe("/api/*");
  });

  test("/api/* goes to the API and everything else to the bucket", () => {
    // Swapping these two is a one-character edit in `additionalBehaviors` that produces a console
    // which loads fine and whose every request returns S3 XML.
    const config = distributionConfig(synth());
    expect(apiBehavior(config).TargetOriginId).toBe(originIdByDomain(config, "execute-api"));
    expect(config.DefaultCacheBehavior.TargetOriginId).toBe(
      originIdByDomain(config, "RegionalDomainName"),
    );
  });

  test("/api/* is never cached", () => {
    // Every response here is either a mutation or is scoped to the caller's row-level view (see
    // `scopeClause`), so one cached copy served to a second user is a data leak that raises no error
    // anywhere - not in the logs, not in the UI.
    expect(apiBehavior(distributionConfig(synth())).CachePolicyId).toBe(
      cloudfront.CachePolicy.CACHING_DISABLED.cachePolicyId,
    );
  });

  test("/api/* forwards the viewer's headers EXCEPT Host", () => {
    // ALL_VIEWER is the natural-looking choice and it breaks the API completely: API Gateway rejects
    // a request whose Host is not its own with a 403 mentioning neither CloudFront nor the header.
    const behavior = apiBehavior(distributionConfig(synth()));
    expect(behavior.OriginRequestPolicyId).toBe(
      cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER.originRequestPolicyId,
    );
    expect(behavior.OriginRequestPolicyId).not.toBe(
      cloudfront.OriginRequestPolicy.ALL_VIEWER.originRequestPolicyId,
    );
  });

  test("/api/* allows the write methods", () => {
    // The default behaviour is GET/HEAD/OPTIONS, which is correct for static files and would make
    // every save in the app fail with a CloudFront 405 that never reaches the function.
    expect(apiBehavior(distributionConfig(synth())).AllowedMethods).toEqual(
      expect.arrayContaining(["POST", "PATCH", "DELETE"]),
    );
  });

  test("the distribution's own origin reaches the function's allow-list", () => {
    // Browsers attach `Origin` to every POST even same-site, and the handler refuses an `Origin` it
    // does not recognise. Without this wiring every READ from the deployed console works and every
    // SAVE returns 403 - which reads like a permissions bug in the app.
    synth().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "neotms-api",
      Environment: {
        Variables: Match.objectLike({
          NEOTMS_ALLOWED_ORIGIN_URLS: Match.objectLike({
            "Fn::Join": Match.arrayWith([
              Match.arrayWith([
                Match.objectLike({ "Fn::GetAtt": Match.arrayWith(["DomainName"]) }),
              ]),
            ]),
          }),
        }),
      },
    });
  });
});

describe("SPA routing", () => {
  test("the distribution declares no custom error responses", () => {
    // The usual SPA recipe maps 403/404 to /index.html with status 200. Custom error responses apply
    // to the WHOLE distribution, including the API origin, so that recipe turns
    // `GET /api/v0/projects/999` into the console's HTML with status 200 - and `notFound()`, which
    // exists so a hidden row and a missing row are indistinguishable, becomes unparseable success.
    // The CloudFront Function below is what replaces it.
    expect(distributionConfig(synth()).CustomErrorResponses).toBeUndefined();
  });

  test("the rewrite function runs on the default behaviour only", () => {
    // On /api/* it would rewrite every extension-less API path - which is all of them - to
    // /index.html, so the entire API would answer with the console's HTML.
    const config = distributionConfig(synth());
    expect(config.DefaultCacheBehavior.FunctionAssociations).toEqual([
      { EventType: "viewer-request", FunctionARN: expect.anything() },
    ]);
    expect(apiBehavior(config).FunctionAssociations).toBeUndefined();
  });

  test("exactly one viewer-request function exists", () => {
    synth().resourceCountIs("AWS::CloudFront::Function", 1);
  });
});

describe("console bucket", () => {
  test("the bucket is private and is not a website endpoint", () => {
    // CloudFront reaches it through Origin Access Control. A public or website-enabled bucket is a
    // second, unlogged way to fetch the console's JavaScript, which means a stale build can keep
    // being served after a CloudFront invalidation is believed to have removed it.
    synth().hasResourceProperties("AWS::S3::Bucket", {
      BucketName: Match.stringLikeRegexp("-console-"),
      WebsiteConfiguration: Match.absent(),
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test("the bucket origin uses Origin Access Control, not a legacy OAI", () => {
    const config = distributionConfig(synth());
    const bucketOrigin = config.Origins.find(
      (o) => o.Id === config.DefaultCacheBehavior.TargetOriginId,
    );
    expect(bucketOrigin).toHaveProperty("OriginAccessControlId");
  });

  test("the deploy invalidates the shell and not the fingerprinted assets", () => {
    // `/*` would throw away the content-hashed assets that were just re-uploaded under new names, so
    // it buys a cache-miss storm for nothing. index.html is the only file that must not be stale -
    // it is what points at the hashed names.
    synth().hasResourceProperties("Custom::CDKBucketDeployment", {
      DistributionPaths: ["/", "/index.html"],
    });
  });
});

describe("console delivery", () => {
  test("the price class includes the Seoul edge", () => {
    // PRICE_CLASS_100 excludes Seoul and Tokyo, so every request would route through North America
    // or Europe and add roughly 150-200ms. Everyone who uses this system is in Korea, and the saving
    // at this traffic volume is cents.
    expect(distributionConfig(synth()).PriceClass).toBe("PriceClass_200");
  });
});

describe("OIDC client registration", () => {
  test("the dev client id and both URIs are the ones registered on LPX", () => {
    // These three only work as a SET. The account system reports any mismatch between them as an
    // opaque `invalid_request`, so a well-meaning edit to one of them produces a sign-in failure
    // with nothing to point at. Changing these means re-registering at LPX first.
    expect(NEOTMS_CONFIGS.dev.auth).toMatchObject({
      authClientId: "QP6B8rMvAnw8fOWXHP3A3qTGz",
      oidcRedirectUri: "http://localhost:5173/auth/callback",
      oidcPostLogoutRedirectUri: "http://localhost:5173/auth/logout",
    });
  });

  test("a stage with a client id has both redirect URIs filled in", () => {
    // Production ships all three deliberately blank, and `isAuthConfigComplete()` turns that into a
    // 500 that says the server is not configured. The failure this guards against is the HALF-filled
    // config - a client id with no redirect URI - which fails much later and less clearly.
    // Collected rather than asserted in the loop so a failure names the offending stage: jest's
    // `expect` takes no message argument, so a bare `expect(uri).not.toBe("")` inside the loop would
    // report only that `""` was `""`.
    const halfConfigured = Object.entries(NEOTMS_CONFIGS)
      .filter(([, config]) => config.auth.authClientId)
      .filter(
        ([, config]) =>
          !config.auth.oidcRedirectUri || !config.auth.oidcPostLogoutRedirectUri,
      )
      .map(([stage]) => stage);

    expect(halfConfigured).toEqual([]);
  });

  test("the redirect and logout URIs are frontend routes, not API routes", () => {
    // Both are paths React Router serves. A redirect URI under /api would mean the backend had to
    // answer a top-level navigation with HTML, which is how an SPA grows a server-rendered page
    // nobody maintains - and it would be shadowed by the /api/* behaviour above.
    for (const config of Object.values(NEOTMS_CONFIGS)) {
      for (const uri of [config.auth.oidcRedirectUri, config.auth.oidcPostLogoutRedirectUri]) {
        if (uri) expect(new URL(uri).pathname.startsWith("/api/")).toBe(false);
      }
    }
  });
});

describe("the LPX access authority", () => {
  test("every stage carries the authority id issued by LPX", () => {
    // Compared verbatim by LPX against `data.authorities` from /lpx/auth/userInfo. A typo denies
    // every account with a 403 that reads as a permissions decision, not as a configuration error -
    // so this is pinned rather than left to look plausible.
    for (const config of Object.values(NEOTMS_CONFIGS)) {
      expect(config.auth.appAuthorityId).toBe("527c4c39-be80-4f70-8f3e-a334b809ce10");
    }
  });

  test("no stage is left without an authority", () => {
    // Blank would mean `isAuthConfigComplete()` is false and the whole auth path answers 500. Unlike
    // the client id, there is nothing to decide per stage - the authority names a capability on the
    // account system, so production can and must ship it populated.
    for (const config of Object.values(NEOTMS_CONFIGS)) {
      expect(config.auth.appAuthorityId).not.toBe("");
    }
  });

  test("the authority reaches the function's environment", () => {
    // The config value is inert until it is an env var the Lambda reads. `NeotmsEnv` falls back to
    // "" when it is missing, which fails closed with a 500 - correct, but only diagnosable at
    // runtime, so the wiring is checked here instead.
    synth().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "neotms-api",
      Environment: {
        Variables: Match.objectLike({
          NEOTMS_APP_AUTHORITY_ID: "527c4c39-be80-4f70-8f3e-a334b809ce10",
        }),
      },
    });
  });
});

/* -------------------------------------------------------------------------- */
/* The empty-database bootstrap                                               */
/* -------------------------------------------------------------------------- */

/**
 * One SQL file with its comments removed.
 *
 * Needed because the tests below look for things that are legitimate in prose and fatal in code -
 * a `:placeholder`, a leading `\` - and both appear in 004_rollup.sql's comments, which exist to
 * explain why they are not in its statements. A test that could not tell the two apart would have
 * to be deleted.
 *
 * Block comments first, then line comments, so a `--` inside a block comment does not truncate the
 * line and leave the block's closing delimiter behind.
 */
/**
 * The consolidated schema and seed, read as one text.
 *
 * These assertions used to name the migration that introduced each rule - 011 for the
 * job-type split, 015 for the approval gate, and so on. Those sixteen files were
 * consolidated into `001_schemas.sql` and `002_initial_seeding.sql` once every one of
 * them had been applied everywhere, so what is pinned now is that THE RULE IS STILL IN
 * THE SCHEMA. Which of the two files carries it is not a fact worth asserting, and a
 * test that cared would break every time a statement moved between sections.
 */
const sqlAll = () =>
  sqlCode("001_schemas.sql") + "\n" + sqlCode("002_initial_seeding.sql");

const sqlCode = (file: string) =>
  sql(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");

/*
 * db/003_access_control.sql moves a database that already has data from the menu x action matrix
 * to named permissions. It was rehearsed against two real PostgreSQL databases - a migrated one
 * dumped and diffed against a fresh install, and a fixture set covering mixed flag patterns, an
 * inactive role, a legacy ETL menu and PMs named only on soft-deleted rows. These tests pin the
 * decisions that rehearsal cannot see from the outside: the ones where being wrong is silent.
 */
describe("the migration to named permissions", () => {
  const MIGRATION = "003_access_control.sql";

  /*
   * The section banners, used to ask questions of one section rather than of the whole file.
   * Asking the whole file would make "PO_APPROVE is granted from PAYMENT's flag 3" pass on the
   * strength of the header paragraph that explains it, which is the opposite of a test.
   */
  const BANNERS = [
    "-- 1. The new tables",
    "-- 2. Translate",
    "-- 3. Derive",
    "-- 4. Refuse",
    "-- 5. Verification",
    "-- 6. OPTIONAL",
    "-- 7. The point of no return",
  ];

  const section = (n: number): string => {
    const raw = sql(MIGRATION);
    for (const banner of BANNERS) {
      expect(raw.split(banner).length - 1).toBe(1);
    }
    const start = raw.indexOf(BANNERS[n - 1]!);
    const end = n < BANNERS.length ? raw.indexOf(BANNERS[n]!) : raw.length;
    return raw.slice(start, end);
  };

  /** One section with its prose removed, so an assertion cannot be satisfied by a comment. */
  const code = (n: number): string =>
    section(n)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ");

  const permissionsIn = (text: string): string[] =>
    [...new Set([...text.matchAll(/'(NEOTMS_PERMISSION_[A-Z_]+)'/g)].map((m) => m[1]!))].sort();

  test("every permission is either granted by the translation or withheld on purpose", () => {
    /*
     * The complete accounting, and the reason it is a test: adding a permission to
     * NeotmsAuthorities.ts is a two-line change that silently does nothing to this file. A role
     * that should have been given the new right simply does not get it, and the symptom is a
     * screen refusing somebody whose role looks correct on the admin page.
     *
     * Two deliberate omissions, for two different reasons, and each has to be NAMED in the file
     * so that it reads as a decision rather than an oversight - hence the prose assertion.
     *
     *   * PO_EMAIL - there is no feature behind it, so granting it would hand out the ability to
     *     do nothing, which then reads as a right somebody chose to give.
     *   * WORKSPACE_READ - 나의 업무 has no legacy counterpart, so there is no flag to translate
     *     FROM. Any rule this file invented would be a new grant presented as a migration; the
     *     permission is granted per role on 사용자 관리 instead.
     */
    const granted = permissionsIn(code(2));
    const withheld = ["NEOTMS_PERMISSION_PO_EMAIL", "NEOTMS_PERMISSION_WORKSPACE_READ"];

    expect(granted).toEqual([...NEOTMS_PERMISSIONS].filter((p) => !withheld.includes(p)).sort());
    for (const permission of withheld) {
      expect(granted).not.toContain(permission);
      expect(section(2)).toContain(permission);
    }
  });

  test("the two permissions that never had a flag go to whoever could already do the action", () => {
    /*
     * These two are where a migration is most likely to change behaviour while looking like it
     * preserved it. Neither existed as a grant, so there is no column to copy, and any choice is
     * a decision:
     *
     *   * PO_APPROVE went to PAYMENT's flag 3, because approving a purchase order WAS that grant.
     *   * PROJECT_EMAIL went to PROJECT's flag 1, because sending a handover mail was gated on
     *     being able to open the project.
     *
     * Both are deliberately too broad, and that breadth is why the permissions were split out in
     * the first place. Narrowing them is section 6's job, for an administrator, after the fact.
     * What must not happen is this file quietly choosing a narrower rule and presenting the
     * result as "nothing changed".
     */
    /*
     * `(?!INSERT INTO)` so the match cannot run from one statement into another. Without it the
     * span starts at the big VALUES mapping and swallows everything up to the permission - and the
     * mapping mentions both 'PAYMENT' and every flag, so the assertions below passed on a file
     * where PO_APPROVE had been repointed at the wrong flag. A tempered match is the difference
     * between testing this statement and testing the section.
     */
    const statementFor = (permission: string): string => {
      const re = new RegExp(
        `INSERT INTO sys_role_permission(?:(?!INSERT INTO).)*?` +
          `'${permission}'(?:(?!INSERT INTO).)*?;`,
        // dotAll, so `.` crosses newlines. Written this way rather than with a character
        // class because a template literal drops the backslash in `\s`, which turns
        // [\s\S] into [sS] -- a pattern that matches, just not what was meant.
        "s",
      );
      const found = re.exec(code(2));
      expect(found).not.toBeNull();
      return found![0];
    };

    const approve = statementFor("NEOTMS_PERMISSION_PO_APPROVE");
    expect(approve).toContain("'PAYMENT'");
    expect(approve).toMatch(/a\.role_3/);
    expect(approve).not.toMatch(/a\.role_[1245]/);

    const email = statementFor("NEOTMS_PERMISSION_PROJECT_EMAIL");
    expect(email).toContain("'PROJECT'");
    expect(email).toMatch(/a\.role_1/);
    expect(email).not.toMatch(/a\.role_[2345]/);

    // And section 6 offers the narrowing without performing it. A DELETE that runs on paste is a
    // migration that takes a capability away from people who had it this morning.
    expect(code(6).trim()).toBe("");
    expect(section(6)).toContain("DELETE FROM sys_role_permission");
  });

  test("the read-only menus do not acquire write permissions on the way across", () => {
    /*
     * REPORT and the two dashboards have one action in the route table; STAFF has read and update
     * and has never had create or delete. A role holding flag 2 or 4 on those menus held a right
     * the application never offered, so there is nothing to carry over - and inventing
     * REPORT_CREATE here would put a permission in the admin screen that no route consults, which
     * is worse than absent because it looks grantable.
     */
    const mapping = code(2);
    for (const [menu, flags] of [
      ["REPORT", ["1"]],
      ["DASHBOARD_SALES", ["1"]],
      ["DASHBOARD_PM", ["1"]],
      ["STAFF", ["1", "3"]],
    ] as const) {
      const rows = [...mapping.matchAll(new RegExp(`\\('${menu}',\\s*(\\d)`, "g"))].map((m) => m[1]!);
      expect(rows.sort()).toEqual([...flags]);
    }

    // Flag 5 maps to nothing anywhere: there is no export permission, and the five-flag mapping
    // is unconfirmed, so a guess that invents a right is the one guess with a victim.
    expect(mapping).not.toMatch(/,\s*5,\s*'NEOTMS_PERMISSION/);
  });

  test("the attributes are derived from every column that names a person", () => {
    /*
     * The server is about to start refusing a prj_pm_id that names somebody without the PM
     * attribute. Derived from all four columns, every project and job that exists today still
     * validates tomorrow; derived from fewer, the next edit of an old record fails on a field
     * nobody touched, and the error names a constraint rather than a cause.
     */
    const derive = code(3);
    expect(derive).toContain("p.prj_mgr_id");
    expect(derive).toContain("prj_pm_id");
    expect(derive).toContain("job_pm_id");
    expect(derive).toContain("po_pm_id");

    /*
     * And soft-deleted rows are included, which is the counter-intuitive half. A cancelled project
     * can be the only evidence that somebody was a PM; dropping it would take the attribute away
     * from a person still doing the job, as a side effect of a project being cancelled.
     */
    expect(derive).not.toMatch(/NOT\s+p?\.?deleted/);

    /*
     * Nobody is given SUPERUSER. It overrides every permission check, and the rule is that it
     * belongs to accounts holding lpx.admin.access - which the database cannot see. A migration
     * that hands out an override nobody asked for is not recoverable by noticing.
     */
    expect(derive).not.toContain("NEOTMS_USER_ATTRIBUTE_SUPERUSER");
    expect(section(3)).toContain("NEOTMS_USER_ATTRIBUTE_SUPERUSER");
    for (const attribute of NEOTMS_USER_ATTRIBUTES) {
      expect(sql(MIGRATION)).toContain(attribute);
    }
  });

  test("it refuses to finish if it would leave nobody able to administer users", () => {
    /*
     * The failure this exists for: the unconfirmed flag mapping is wrong in a way that drops
     * STAFF_UPDATE, the application deploys, and the only screen that could restore anyone's
     * access is the one nobody can now open. There is no way back from inside the application.
     *
     * Rehearsed both ways - it refused a database with one active staff member and no STAFF
     * rights, and allowed a seeded database with no staff at all. That second branch matters:
     * aborting there would block every staging database before its first ETL, where nobody can
     * be locked out and staff_bootstrap_superuser() is the documented way in.
     */
    const guard = code(4);
    expect(guard).toContain("NEOTMS_PERMISSION_STAFF_UPDATE");
    expect(guard).toMatch(/v_staff\s*=\s*0/);
    expect(guard).toMatch(/RAISE EXCEPTION/);
    expect(guard).toMatch(/s\.active/);
    expect(guard).toMatch(/NOT s\.deleted/);

    /*
     * And the abort can only undo anything because sections 1 to 4 are one transaction. psql
     * commits each statement on its own otherwise, so without this the refusal would leave new
     * tables, translated grants and no administrator - the exact state being guarded against.
     */
    const raw = sql(MIGRATION);
    const begin = raw.indexOf("\nBEGIN;");
    const commit = raw.indexOf("\nCOMMIT;");
    expect(begin).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(begin);
    expect(commit).toBeLessThan(raw.indexOf(BANNERS[4]!));
  });

  test("the destructive step cannot run by being pasted", () => {
    /*
     * Dropping sys_role_auth is the point of no return: until it happens, rolling the application
     * back is a deploy, and afterwards it is a restore from backup. The file has to describe the
     * step - an operator who cannot find it will improvise - without the step executing when
     * somebody pastes the whole file, which is how every other file in db/ is applied.
     */
    expect(code(7).trim()).toBe("");
    for (const dropped of ["sys_role_auth", "sys_role_menu", "sys_role_grant_all_menus"]) {
      expect(section(7)).toContain(`IF EXISTS ${dropped}`.replace("IF EXISTS ", "IF EXISTS "));
      expect(section(7)).toContain(dropped);
    }
    // Nothing earlier may drop them either: sections 1-4 run on paste.
    for (const n of [1, 2, 3, 4]) {
      expect(code(n)).not.toMatch(/DROP TABLE/);
    }
  });

  test("a migrated database documents the model it has, not the one it had", () => {
    /*
     * Caught by diffing a migrated database against a fresh one: everything matched except two
     * table comments, which still said sys_menu was what permissions are granted on and that
     * sys_role carried a menu x action matrix. `pg_dump` carries that text forward forever, so the
     * stale description outlives the schema it described - and it sits in the place somebody
     * reaching for \d sys_role looks first.
     *
     * The texts must be character-identical to the install files', because that identity is the
     * whole claim: 001 and 003 are two routes to one database, not two databases.
     */
    const install = sql("001_schemas.sql") + "\n" + sql("002_initial_seeding.sql");

    /** The comment that WINS for one table - the last statement, since each overwrites the last. */
    const tableComment = (text: string, table: string): string | null => {
      const re = new RegExp(
        `^COMMENT ON TABLE\\s+${table}\\s+IS\\s*((?:'(?:[^']|'')*'\\s*)+);`,
        "gm",
      );
      let winner: string | null = null;
      for (const m of text.matchAll(re)) {
        winner = [...m[1]!.matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1]!).join("");
      }
      return winner;
    };

    for (const table of ["sys_menu", "sys_role"]) {
      const installed = tableComment(install, table);
      expect(installed).not.toBeNull();
      expect(tableComment(sql(MIGRATION), table)).toBe(installed);
    }

    /*
     * And the install files say it once each. Three copies of the sys_menu comment used to be
     * written as the menus were seeded in stages, and the one that survived was the stalest -
     * it still cited db/006_bootstrap.sql and three other files the consolidation deleted.
     */
    expect(
      (sql("002_initial_seeding.sql").match(/^COMMENT ON TABLE sys_menu/gm) ?? []).length,
    ).toBe(0);
  });

  test("the new objects are created exactly as a fresh install creates them", () => {
    /*
     * Section 1 is 001's definitions again, with IF NOT EXISTS. They have to stay in step: a CHECK
     * that differs by one name is a database that accepts a permission the application will never
     * ask for, or refuses one it will - and the diff would only show up on whichever database was
     * built the other way.
     */
    const created = code(1);
    for (const object of [
      "sys_role_permission",
      "staff_attribute",
      "ix_role_permission_role",
      "ix_staff_attribute_staff",
      "ix_staff_attribute_attr",
      "neotms_known_permissions",
      "sys_role_grant_all_permissions",
    ]) {
      expect(created).toContain(object);
    }
    // Re-runnable: a database that has already been moved can be given this file again.
    expect((created.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length).toBe(2);
    expect((created.match(/CREATE INDEX IF NOT EXISTS/g) ?? []).length).toBe(3);

    // The CHECK is the same vocabulary the install file and the application use.
    const check = /CHECK \(permission IN \(([\s\S]*?)\)\)/.exec(created);
    expect(check).not.toBeNull();
    expect([...check![1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort()).toEqual(
      [...NEOTMS_PERMISSIONS].sort(),
    );
  });

  test("every grant it writes is attributed, and re-running it changes nothing", () => {
    /*
     * `created_by` is how somebody looking at a surprising grant next year can tell whether a
     * person gave it or this file inferred it. Rehearsed: applying the file twice leaves the same
     * grants, which is what makes a run interrupted halfway recoverable by repeating it.
     */
    for (const n of [2, 3]) {
      expect(code(n)).toContain("'neotms-003-migration'");
      expect(code(n)).toMatch(/ON CONFLICT \([^)]*\) DO NOTHING/);
    }
  });
});

describe("the empty-database bootstrap", () => {
  test("every menu the API gates permissions on is seeded", () => {
    /*
     * The coupling this guards is invisible and total. `hasPermission` refuses any menu id the
     * role's matrix has no row for, and `sys_role_grant_all_permissions` builds that matrix by iterating
     * over `sys_menu` - so a menu id that exists in `NeotmsMenu` but not in this INSERT is a route
     * that refuses the superuser, with the message "your role does not permit this action". Nothing
     * errors, nothing logs, and the natural reading of that message is that the role is wrong.
     *
     * It also drives the sidebar: `getProfile` builds the menu tree from `sys_menu`, so the same
     * omission removes the screen from the navigation entirely.
     *
     * Every seed file, because the menus are deliberately split across several. 006 holds the six
     * business menus and is the lockout-recovery file - its one job is to stay the thing an operator
     * can run without deciding anything, so new menus are not added to it. 008 holds the two
     * administrative ones, 013 the two dashboards, and 015 the 결제 section. Scanning all of them
     * means none can be the one that was forgotten, which is the real risk now that there is more
     * than one: this very test failed on MAINTENANCE the moment `NeotmsMenu` grew, and again on
     * DASHBOARD_SALES and DASHBOARD_PM, which is exactly what it is for.
     *
     * The list is literal rather than every `db/*.sql`, so that adding a menu to `NeotmsMenu` and a
     * row to a brand-new file is not enough on its own - the file has to be named here, which is
     * also what puts it under the editor-safety assertions further down.
     */
    const seeded = new Set(
      [...sqlCode("002_initial_seeding.sql").matchAll(/^\s*\('([A-Z_]+)',/gm)].map((m) => m[1]),
    );
    for (const menuId of Object.values(NeotmsMenu)) {
      expect([...seeded]).toContain(menuId);
    }
  });

  test("008 re-grants the superuser role after adding menus", () => {
    /*
     * The half of 008 that is easy to leave out, and whose absence is worse than forgetting the
     * INSERT. With the menu rows but no re-grant, the superuser SEES 유지보수 and 사용자 관리 in the
     * sidebar - `sys_menu` has them, and the sidebar is built from `sys_menu` - and gets 403 from
     * every request either screen makes, because `sys_role_auth` does not. A tab that exists and
     * refuses reads as a broken feature; a tab that is missing at least reads as a missing feature.
     *
     * Pinned as a call rather than as literal grant rows for the reason 006 gives: `sys_menu` grows,
     * and grants written once do not cover rows added later. The call is idempotent, so running it
     * again is the correct response to any doubt.
     */
    const code = sqlAll();
    expect(code).toMatch(/SELECT sys_role_grant_all_permissions\('NEOTMS_SYSADMIN'\)/);
    // The INSERT must not reset a label an operator has corrected - same rule as 006's menu seed.
    expect(code).toMatch(/INSERT INTO sys_menu[\s\S]*?ON CONFLICT \(menu_id\) DO NOTHING/);
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/m);
  });

  test("013 seeds two dashboard menus, re-grants them, and grants nobody else", () => {
    /*
     * The same three properties 008 is checked for, plus one that is specific to this file.
     *
     * The two dashboards exist as separate menus **in order to be granted separately** - a PM holds
     * DASHBOARD_PM, a 영업담당자 holds DASHBOARD_SALES, and that assignment is made on the 사용자
     * 관리 screen. A seed file that handed both to every existing role, or that called
     * `sys_role_grant_all_permissions` for anything other than the bootstrap superuser, would undo the
     * split on the way in - and silently, because the symptom is a screen appearing for someone it
     * was meant to be withheld from, which nobody reports.
     *
     * The superuser is the exception the user named: the only account that holds both.
     */
    const code = sqlAll();
    expect(code).toMatch(/INSERT INTO sys_menu[\s\S]*?ON CONFLICT \(menu_id\) DO NOTHING/);
    expect(code).toContain("'DASHBOARD_SALES'");
    expect(code).toContain("'DASHBOARD_PM'");

    // The paths must be the ones the router and NEOTMS_NAV use. `menu_url` is not what the client
    // navigates by, but it is what someone reading `sys_menu` directly will believe.
    expect(code).toContain("'/dashboard/sales'");
    expect(code).toContain("'/dashboard/pm'");

    // Exactly one grant call, and for NEOTMS_SYSADMIN. Grants written by 006 and 008 do not cover
    // rows added here, so without this the superuser sees two tabs that both answer 403.
    const grants = [...code.matchAll(/sys_role_grant_all_permissions\('([A-Z_]+)'\)/g)].map((m) => m[1]);
    expect(grants).toEqual(["NEOTMS_SYSADMIN"]);
    /*
     * The seed grants through the function and never by hand. A literal INSERT into
     * sys_role_auth would be a grant that the function's own list does not know about, so
     * adding a menu later would silently leave that one row behind - which is the drift
     * `sys_role_grant_all_permissions` exists to make impossible.
     *
     * Asked of the SEED file only. The one `INSERT INTO sys_role_auth` in this schema is
     * inside `sys_role_grant_all_permissions` itself, in 001 - which is the point: the grant
     * exists in exactly one place, and the seed calls it.
     */
    expect(sqlCode("002_initial_seeding.sql")).not.toMatch(/INSERT INTO sys_role_auth\s*\(/);

    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/m);
  });

  test("the seeded superuser role is the one the bootstrap function hands out", () => {
    const code = sqlAll();
    // The label the user asked for, in the column the sidebar and the admin screens display.
    expect(code).toMatch(/INSERT INTO sys_role[\s\S]*?'시스템관리자'/);
    /*
     * Namespaced, and not the obvious bare `SYSADMIN`. The legacy SY_ROLE ids have not been
     * profiled and `role_code` is UNIQUE, so a collision would not create a second row - it would
     * make `ON CONFLICT ... DO UPDATE` adopt the legacy role and then grant every menu and every
     * action to whoever already held it. That is a privilege escalation with no error and no
     * symptom until someone notices a translator can read company margin.
     */
    expect(code).toContain("'NEOTMS_SYSADMIN'");
    expect(code).not.toMatch(/role_code\s*=\s*'SYSADMIN'|VALUES\s*\(\s*'SYSADMIN'/);
  });

  test("the superuser is granted every permission this build knows", () => {
    // Two tables, and granting one without the other is a role that is permitted to use a screen it
    // cannot navigate to - or worse, one that appears in the sidebar and then refuses every click.
    // `\$\w*\$;` closes the body whatever the dollar-quote tag is - `$fn$` today. Anchoring on the
    // tag itself would make renaming it look like a missing grant.
    const grant = /CREATE OR REPLACE FUNCTION sys_role_grant_all_permissions[\s\S]*?\n\$\w*\$;/.exec(
      sqlAll(),
    );
    expect(grant).not.toBeNull();
    /*
     * ONE table now, and that is the change worth pinning. The old pair - a matrix of action flags
     * and a separate visibility list - could disagree, and when they did the symptom was a menu
     * that appears in the sidebar and then refuses every click.
     */
    expect(grant![0]).toContain("INSERT INTO sys_role_permission");
    expect(grant![0]).not.toContain("sys_role_auth");
    expect(grant![0]).not.toContain("sys_role_menu");
    /*
     * It grants from `neotms_known_permissions()`, which reads the CHECK. Spelling the names out
     * in the function would be a third copy of the vocabulary - after NeotmsAuthorities.ts and the
     * CHECK - and the copy that goes stale is always the one that grants too little, which
     * presents as a screen refusing somebody who was given everything.
     */
    expect(grant![0]).toContain("neotms_known_permissions()");

    /*
     * And the two vocabularies that do exist agree. The CHECK is what the database will store;
     * NEOTMS_PERMISSIONS is what the application compares against. A name in one and not the other
     * is either a grant that matches nothing or a permission the admin screen cannot give.
     */
    const check = /CHECK \(permission IN \(([\s\S]*?)\)\)/.exec(sqlAll());
    expect(check).not.toBeNull();
    expect([...check![1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort()).toEqual(
      [...NEOTMS_PERMISSIONS].sort(),
    );
  });

  test("the bootstrap authority is wired from the config into the function", () => {
    // `lpx.admin.access` is LPX's own superuser authority. Copied as a literal rather than imported
    // from lambdas/common, which tsconfig.app.json excludes - so this is the test that the copy has
    // not drifted from what the guard is comparing userInfo's authority list against.
    for (const config of Object.values(NEOTMS_CONFIGS)) {
      expect(config.auth.bootstrapAuthorityId).toBe("lpx.admin.access");
    }
    synth().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "neotms-api",
      Environment: {
        Variables: Match.objectLike({ NEOTMS_BOOTSTRAP_AUTHORITY_ID: "lpx.admin.access" }),
      },
    });
  });

  test("turning the bootstrap off is a committed edit, not a deploy flag", () => {
    /*
     * Deliberately absent from the override list, and this test states the reason so that adding it
     * "for symmetry" fails here instead of at a deploy. `readStringOverride` REJECTS a blank value -
     * on the correct grounds that every other setting on that list disables the API when blank - so
     * `-c bootstrapAuthorityId=` could never be how the back door is closed. Closing it is an edit
     * to the stage config, which is the reviewed commit we want for removing an administrative
     * bypass. db/006_bootstrap.sql section 5 tells the operator the same thing.
     */
    expect(NEOTMS_AUTH_CONTEXT_KEYS).not.toContain("bootstrapAuthorityId");
    /*
     * And the consequence, pinned: the flag an operator would reach for is IGNORED rather than
     * rejected. That silence is the reason the README and 006 both have to spell out the real
     * procedure - somebody who deploys with `-c bootstrapAuthorityId=` and sees no error has every
     * reason to believe they closed the door, and the door is open.
     */
    const attempted = resolveStageConfig("prod", {
      tryGetContext: (key: string) => (key === "bootstrapAuthorityId" ? "" : undefined),
    });
    expect(attempted.auth.bootstrapAuthorityId).toBe("lpx.admin.access");
  });

  test("the files an operator pastes into the SQL editor contain nothing psql-only", () => {
    /*
     * A real failure, reported from a real attempt: `ERROR: 42601: syntax error at or near ":"`,
     * from a `WHERE business_date = :business_date` left in the rollup recompute that 004_rollup.sql
     * used to define. `:name` is an APPLICATION convention - `toPositional` in PostgresUtils.ts
     * rewrites it to `$n` - and nothing else in the world knows that, so a file carrying one cannot
     * be applied at all. The recompute is gone; the rule it taught is still enforced here, and
     * 004_rollup.sql still carries the note that 006, 008 and 009 point at.
     *
     * `\set`, `\i` and friends are the same class of problem with a different audience: psql
     * executes them, the Supabase SQL editor does not, and the editor is what the operator is
     * actually using.
     *
     * 004_verify_search.sql is excluded BY NAME rather than by a pattern, because it is genuinely
     * psql-only (it needs `\set ON_ERROR_STOP on` to stop on a failed assertion) and its header says
     * so. Naming it means a second psql-only file cannot join it silently.
     */
    const editorFiles = [
      "001_schemas.sql",
      "002_initial_seeding.sql",
      // The migration is pasted into the same editor, by the same person, on the one occasion
      // when a syntax error is most expensive: against live data, with the old tables still
      // there and the application already deployed against the new ones.
      "003_access_control.sql",
      "004_recent_searches.sql",
      "005_project_acceptance.sql",
      "006_workspace.sql",
      "007_workspace_styles.sql",
      "008_workspace_text.sql",
    ];
    for (const file of editorFiles) {
      const code = sqlCode(file);
      expect(code).not.toMatch(/^\s*\\\w+/m);
      // `(^|[^:])` so `::text` and `$1::date` are not read as placeholders, and `[a-z_]` so `:=`
      // is not either.
      expect(code).not.toMatch(/(^|[^:]):[a-z_][a-z0-9_]*/m);
    }
    expect(sql("verify_search.sql")).toContain("\\set ON_ERROR_STOP on");
  });

  test("the bootstrap seed is idempotent at every statement, having no transaction around it", () => {
    /*
     * The Supabase SQL editor wraps a submission in its own transaction and rejects `\` commands,
     * so this file carries neither `BEGIN`/`COMMIT` nor `\set ON_ERROR_STOP`. The consequence is
     * that a partial application has to be recoverable by re-running the whole file - which is only
     * true if every statement in it is idempotent. These are the three forms that make it so.
     */
    const code = sqlAll();
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/m);
    // The menus must not reset a label an operator has corrected; the role is this file's own row,
    // so it is re-asserted.
    expect(code).toMatch(/INSERT INTO sys_menu[\s\S]*?ON CONFLICT \(menu_id\) DO NOTHING/);
    expect(code).toMatch(/INSERT INTO sys_role[\s\S]*?ON CONFLICT \(role_code\) DO UPDATE/);
    for (const fn of ["sys_role_grant_all_permissions", "staff_bootstrap_superuser"]) {
      expect(code).toContain(`CREATE OR REPLACE FUNCTION ${fn}`);
    }
  });

  test("the searched columns the bootstrap writes to are still text", () => {
    // `mgr_email` and `mgr_name` are both PGroonga-indexed, and the mint branch writes to both. A
    // length limit added to either would silently cost those columns their index (see
    // 001_extensions.sql), so the type is pinned where the write is introduced as well.
    const types = columnTypes();
    expect(types.get("staff.mgr_email")).toBe("text");
    expect(types.get("staff.mgr_name")).toBe("text");
    expect(types.get("staff.mgr_id")).toBe("text");
  });
});

/* -------------------------------------------------------------------------- */
/* 사용자 관리 - the one screen that writes permissions                         */
/* -------------------------------------------------------------------------- */

/**
 * One Lambda source file, as text.
 *
 * Read rather than imported, deliberately. Importing `neotms.handler.js` would pull the whole
 * module graph - managers, dbops, PostgresUtils, `pg` - and trip the Lambda's environment
 * validation, which is exactly the reason `NeotmsMenus.js` is singled out at the top of this file as
 * safe to import. A text assertion is weaker than a real one, and it is what is available without
 * making the test suite depend on runtime configuration.
 */
const neotmsLambdaDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "lambdas",
  "neotms",
  "nodejs",
  "neotms",
);

const lambdaSource = (relative: string) =>
  readFileSync(path.join(neotmsLambdaDir, relative), "utf8");

/**
 * TypeScript with its comments removed - `sqlCode`'s counterpart, and needed for the same reason.
 *
 * The modules in this codebase document what they deliberately do NOT do, by name. NeotmsDashboard
 * explains at length that it must not key on `job_pm_id` and must not use `CURRENT_DATE`; its header
 * is the clearest statement of both rules and would fail an assertion that either word is absent. A
 * test that could not tell a prose mention from a statement would have to be written as the weaker
 * "this file mentions neither", which is the opposite of what the file should say.
 *
 * Strips as text, which is what makes it wrong on a `//` inside a string literal - a URL, say. The
 * assertions that use it are scoped to modules with no URLs in them, and that limitation is the same
 * one `sqlCode` carries.
 */
const tsCode = (relative: string) =>
  lambdaSource(relative)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");

/** Every `.ts` under a directory, recursively. */
const walkTs = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkTs(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });

describe("사용자 관리 route gating", () => {
  /*
   * `PATCH /api/v0/admin/staff/:id` writes `staff.role_id`, and every permission in NEOTMS resolves
   * from that column. So this is the one endpoint where reaching it at all is equivalent to holding
   * every right in the system, and the tests below pin the three properties that keep that bounded.
   */
  const handler = () => lambdaSource("neotms.handler.ts");

  test("every staff and role route is reserved, and the reservation is one of two kinds", () => {
    /*
     * Not `anyStaff`. The role listing is the one that could plausibly be argued into being open -
     * a role's name is not a secret - and that is exactly why it is pinned: the argument is easy to
     * make in review, and the consequence is that any signed-in account can enumerate the company's
     * privilege tiers. If a non-admin screen ever needs role names, the answer is a second path the
     * way `/codes` and `/admin/codes` are split, not a flag on this one.
     *
     * TWO ACCEPTABLE GATES, not one, and the second is the point of the distinction:
     *
     *   * `NEOTMS_PERMISSION_STAFF_*` - reading the directory, and assigning an existing role to
     *     somebody. A staff administrator's daily business.
     *   * `superuser: true` - deciding what a role MEANS, and what a person may BE named as. This
     *     one cannot be a permission. A role holding "may edit grants" could grant itself the
     *     other thirty-five permissions in a single request, so the gate would be editable through
     *     the endpoint it gates, and the only thing standing between a staff administrator and the
     *     whole system would be that nobody thought to try.
     *
     * What must never appear is a third kind: `anyStaff` or `account` on any of these paths.
     */
    const lines = handler()
      .split("\n")
      .filter((l) =>
        /path: (ADMIN_STAFF|ADMIN_ROLES|ADMIN_ROLE_GRANTS|`\$\{ADMIN_STAFF\}|`\$\{ADMIN_ROLES\})/.test(l),
      );
    // A guard against the filter silently matching nothing after a rename of the constants.
    expect(lines.length).toBeGreaterThanOrEqual(8);

    for (const line of lines) {
      const staffPermission = line.includes("permission: NEOTMS_PERMISSION_STAFF_");
      const superuser = line.includes("superuser: true");
      // Exactly one, so a route cannot carry both and leave a reader guessing which one decides.
      expect(staffPermission !== superuser).toBe(true);
      expect(line).not.toContain("anyStaff");
      expect(line).not.toContain("account: true");
    }
  });

  test("everything that writes a role, a grant or an attribute is superuser-only", () => {
    /*
     * The complement of the test above, stated as a whitelist so that a NEW write cannot join this
     * group on a permission gate. The listing of grants is included: it reports which permissions
     * every role holds, which is the map somebody probing the system would want first.
     *
     * All PATCH, including the two whose bodies ARE a complete set and would read better as PUT:
     * `ALLOWED_CORS_METHODS` deliberately omits PUT, and the handler records that trade on the PO
     * approval route - a verb the allow-list misses fails in the browser as a CORS error naming
     * nothing about the route. What the replace-the-whole-set contract rules out is the shape a
     * PATCH invites, "add this one permission", because that puts the diff in the client.
     *
     * The list is sorted, so a route joining this group has to be added here deliberately.
     */
    const superuserRoutes = handler()
      .split("\n")
      // `path:` and `method:` as well, so the two prose comments that name the flag in order to
      // explain it are not read as routes. A comment matching a scan of the source is the same
      // mistake twice in this suite now; the fix is to require the shape, not the words.
      .filter((l) => l.includes("superuser: true") && /path:/.test(l) && /method:/.test(l))
      .map((l) => {
        const method = /method: "(\w+)"/.exec(l)?.[1] ?? "?";
        const route = /path: ([^,]+),/.exec(l)?.[1] ?? "?";
        return `${method} ${route.trim()}`;
      });

    expect(superuserRoutes.sort()).toEqual([
      "DELETE `${ADMIN_ROLES}/:id`",
      "GET ADMIN_ROLE_GRANTS",
      // `/permissions` sorts BEFORE the bare `:id` route: both share the prefix, and the next
      // character is "/" (0x2F) against the closing backtick (0x60).
      "PATCH `${ADMIN_ROLES}/:id/permissions`",
      "PATCH `${ADMIN_ROLES}/:id`",
      "PATCH `${ADMIN_STAFF}/:id/attributes`",
      "POST ADMIN_ROLES",
    ]);
  });

  test("nothing creates or deletes a staff row, whatever else these paths gained", () => {
    /*
     * The absences are the design, and both are the kind of symmetry a later contributor "completes"
     * without realising what it costs:
     *
     *   * No POST. A usable staff row needs an `lpx_sub`, which an administrator cannot issue. A row
     *     with an invented or absent subject is either dead weight or claimable by whoever next
     *     signs in with a matching email - so rows arrive from the ETL or `staff_self_register()`,
     *     and the admin's job is to approve, which is the PATCH.
     *   * No DELETE. Every historical project, job and purchase order carries this person's
     *     `mgr_id` in `created_by`. Ending access is `active: false`, which the PATCH already does.
     */
    /*
     * Scoped to the STAFF paths only. Roles are a different resource and genuinely need a POST and
     * a DELETE - a company adds and removes job titles - so folding them into one count would
     * either forbid what roles need or permit what staff rows must not have. The rule being pinned
     * is about rows representing PEOPLE.
     */
    const staffRoutes = handler()
      .split("\n")
      .filter((l) => /path: (ADMIN_STAFF|`\$\{ADMIN_STAFF\})/.test(l));
    const methods = (staffRoutes.map((l) => /method: "(\w+)"/.exec(l)?.[1]) ?? []).sort();

    expect(methods).not.toContain("POST");
    expect(methods).not.toContain("DELETE");
    // GET the directory, PATCH a person's role/scope/active, PATCH their attribute set.
    expect(methods).toEqual(["GET", "PATCH", "PATCH"]);
  });

  test("the admin-writable staff columns are exactly role, scope and active", () => {
    /*
     * `STAFF_ADMIN_FIELDS` IS the security boundary - `updateFragments` builds the SET clause from
     * it and from nothing else, so a column added to that array is a column the 사용자 관리 screen
     * can write to every other employee's row.
     *
     * The three that must never appear are `mgr_id`, `lpx_sub` and `corp_code`: they are identity.
     * Writing `lpx_sub` hands one person's record to another account, and writing `mgr_id` orphans
     * every `created_by` pointing at it. Name, email and phone are absent for a milder reason - the
     * person maintains those themselves - so they are not asserted against here, only the three
     * that would be an escalation.
     */
    const fields = lambdaSource("staff/NeotmsStaffAdmin.dbops.ts");
    const block = /STAFF_ADMIN_FIELDS[\s\S]*?\n\];/.exec(fields)?.[0] ?? "";
    expect(block).not.toBe("");
    expect([...block.matchAll(/column: "(\w+)"/g)].map((m) => m[1]).sort()).toEqual([
      "active",
      "role_id",
      "view_scope",
    ]);
    for (const forbidden of ["mgr_id", "lpx_sub", "corp_code"]) {
      expect(block).not.toContain(forbidden);
    }
  });

  test("the only UPDATE of staff.role_id in the codebase is the admin one", () => {
    /*
     * The claim the file header of NeotmsStaffAdmin.dbops.ts makes out loud - "there is exactly ONE
     * statement in this codebase that writes them" - turned into something that fails when it stops
     * being true. In LKTMS the equivalent value came from an unsigned cookie; what makes the fix
     * auditable rather than hopeful is that the write has one site, so this is the assertion that
     * keeps it that way.
     *
     * Finds every statement under neotms/ that WRITES the `staff` table, and looks for `role_id`
     * in the part before the WHERE - which is where an assignment would be. The admin path does not
     * match, because it builds the SET clause from `STAFF_ADMIN_FIELDS` (asserted above) rather
     * than spelling the assignment out, so the expected set is empty and anything appearing is a
     * second write site needing the same scrutiny as the first.
     *
     * This used to be `/role_id\s*=\s*:/` over the whole file, which was two kinds of wrong in
     * the same regex. Too loose: it matched `WHERE p.role_id = :role_id`, so merely READING the
     * column counted as writing it - and the role administration queries do read it, which is how
     * the test came to be looked at. Too tight: it only noticed PARAMETERIZED assignments, so a
     * hand-written `SET role_id = 1` would have sailed past the test whose entire job is to catch
     * exactly that.
     *
     * `UPDATE staff\b` and `INSERT INTO staff (` do not match `staff_attribute`: `_` is a word
     * character, so there is no word boundary between `staff` and `_attribute`. The attribute
     * writes are a different table and a different question.
     *
     * `staff_self_register()` is in SQL, not here, and it is also the reason this test matters: that
     * function is allowed to set `role_id` because it forces it to NULL. A TypeScript statement that
     * set it to anything else would be the hole this whole design closes.
     */
    const STAFF_WRITE = /(?:UPDATE\s+staff\b|INSERT\s+INTO\s+staff\s*\()[\s\S]*?(?=`)/gi;
    const offenders = walkTs(neotmsLambdaDir)
      .filter((file) =>
        [...readFileSync(file, "utf8").matchAll(STAFF_WRITE)].some((match) => {
          // Everything before the WHERE: the column list, the SET clause, the VALUES.
          const assigning = match[0].split(/\bWHERE\b/i)[0] ?? "";
          return /role_id/.test(assigning);
        }),
      )
      .map((file) => path.relative(neotmsLambdaDir, file));
    expect(offenders).toEqual([]);
  });
});

describe("the PO request mail and its attachments", () => {
  const src = (...segments: string[]) =>
    readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend", "src", ...segments),
      "utf8",
    );

  test("the attachment picker is a button, and the same file can be picked twice", () => {
    /*
     * Two invariants, because they fail as the same symptom - a button that does nothing.
     *
     * The real `<input type="file">` is hidden and a button clicks it. That is not decoration: the
     * browser draws the control's own button INSIDE the field and will not take this app's styling,
     * so the only way for the picker to look like the dialog's other buttons is for it to BE one.
     *
     * And the hidden input's value is cleared after every pick. Without that, choosing a file,
     * taking it back out and choosing the SAME file again raises no `change` event at all - the
     * value has not changed - so the picker is dead for exactly one input: the file somebody just
     * decided they did want after all. The copy has to come BEFORE the clear, because
     * `input.files` is a live list and the clear empties it; reversed, every pick uploads nothing
     * and reports no error.
     */
    const modal = src("features", "purchaseorders", "PoRequestMailModal.tsx");

    expect(modal).toMatch(/type="file"[\s\S]{0,120}hidden/);
    expect(modal).toContain("fileInput.current?.click()");

    const picker = modal.slice(modal.indexOf("ref={fileInput}"));
    const copy = picker.indexOf("Array.from(e.target.files");
    const clear = picker.indexOf("e.target.value = ''");
    expect(copy).toBeGreaterThanOrEqual(0);
    expect(clear).toBeGreaterThan(copy);
  });

  test("exactly one route in this API is unauthenticated, and it is the attachment download", () => {
    /*
     * THE most consequential assertion in this file. Every other route is behind the guard; this
     * one is reached by a translator - somebody with no account here - clicking a link in a mail.
     *
     * A whitelist of one, so that a second public route cannot be added without this test being
     * edited, and editing it means writing down why. The failure a drive-by `publicRoute: true`
     * would cause is not a visible bug: the endpoint simply starts answering everybody.
     */
    const handler = lambdaSource("neotms.handler.ts");
    const publicRoutes = handler
      .split("\n")
      .filter((l) => l.includes("publicRoute: true") && /path:/.test(l) && /method:/.test(l));

    expect(publicRoutes).toHaveLength(1);
    const route = publicRoutes[0]!;
    expect(route).toContain("GET");
    expect(route).toContain("${ATTACHMENTS}/:token");
    // It must not ALSO claim another tier - two answers to "who may call this".
    expect(route).not.toContain("permission:");
    expect(route).not.toContain("anyStaff");
    expect(route).not.toContain("superuser");
    expect(route).not.toContain("account:");
  });

  test("the public download answers a redirect, never bytes, and is never cached", () => {
    /*
     * Three properties, each guarding a different leak:
     *
     *   * A 302 rather than a body, because the bytes must not pass through Lambda - a 100MB file
     *     would hit the 6MB response payload limit and bill for the transfer twice.
     *   * `no-store`, because a shared cache holding this would serve one translator's 60-second
     *     presigned URL to the next request for the same token.
     *   * `no-referrer`, because without it the presigned URL's host sees this system's URL -
     *     token and all - in the `Referer` header, which puts a working link in somebody else's
     *     access log.
     */
    const handler = lambdaSource("neotms.handler.ts");
    const download = /const handleDownloadAttachment[\s\S]*?\n};/.exec(handler);
    expect(download).not.toBeNull();
    expect(download![0]).toContain("status: 302");
    expect(download![0]).toContain("Location:");
    expect(download![0]).toContain('"Cache-Control": "no-store, max-age=0"');
    expect(download![0]).toContain('"Referrer-Policy": "no-referrer"');
    // The body is empty: a body on a redirect is read by nothing and would only be somewhere for
    // the presigned URL to be logged.
    expect(download![0]).toMatch(/body: ""/);
  });

  test("a token names one object, and expiry is checked rather than assumed", () => {
    /*
     * What bounds the unauthenticated route. The token resolves to a row the SERVER wrote, naming
     * one key the server chose; nothing in the request can widen that.
     *
     * The expiry check matters on its own: DynamoDB sweeps a TTL row within ~48 hours of its
     * timestamp rather than at it, so trusting absence would let a link work for up to two days
     * past the 21 the translator was promised.
     */
    const manager = tsCode("attachments/NeotmsAttachmentManager.ts");
    const resolve = /export async function resolveDownload[\s\S]*?\n}/.exec(manager);
    expect(resolve).not.toBeNull();
    expect(resolve![0]).toMatch(/record\.expiresAt <= Date\.now\(\)/);
    expect(resolve![0]).toContain("record.objectKey");
    // The key comes from the row, never from the request.
    expect(resolve![0]).not.toMatch(/input\.|request\./);

    // 256 bits of randomness is what makes the token unguessable.
    expect(manager).toContain("randomBytes(32)");
  });

  test("the uploader cannot choose where in the bucket a file lands", () => {
    /*
     * The key is built by the server from the PO id and the token. The file NAME goes through
     * `safeKeyPart`, and the part that matters is the path separators: a file called
     * `../../etc/passwd` would otherwise pick its own location in the bucket.
     *
     * The original name is kept untouched in DynamoDB, because that is what the translator should
     * see as the link text and as the downloaded filename.
     */
    const manager = tsCode("attachments/NeotmsAttachmentManager.ts");
    expect(manager).toContain("safeKeyPart");
    const sanitiser = /const safeKeyPart[\s\S]*?;\n/.exec(manager);
    expect(sanitiser).not.toBeNull();
    expect(sanitiser![0]).toMatch(/replace\(\/\[\\\\\/\]\/g/);
    // The key is a template the server owns; `fileName` only reaches it through the sanitiser.
    expect(manager).toMatch(/objectKey = `po-request\/\$\{input\.poId\}\/\$\{token\}\//);
  });

  test("a mail can only link to files uploaded against the PO it is for", () => {
    /*
     * The client names tokens, so the server has to refuse one that belongs elsewhere. A token is
     * unguessable, so this is not about guessing - it is about a token that has LEAKED, which is
     * the expected state of affairs: every token has already been mailed to a translator. Without
     * this check, one of those could be re-mailed against any PO by anyone who can reach the
     * endpoint.
     *
     * The refusal says the same thing as "no such file", so the endpoint cannot be used to learn
     * that a token is real but belongs to somebody else.
     */
    const manager = tsCode("purchase-orders/NeotmsPoRequestMailManager.ts");
    const resolve = /async function resolveAttachments[\s\S]*?\n}/.exec(manager);
    expect(resolve).not.toBeNull();
    expect(resolve![0]).toMatch(/record\.poId !== poId/);
    expect(resolve![0]).toMatch(/record\.expiresAt <= Date\.now\(\)/);
    // One message for both refusals.
    const messages = [...resolve![0].matchAll(/no longer available/g)];
    expect(messages.length).toBe(2);
  });

  test("the PO is read through its scope before anything is signed in to", () => {
    /*
     * The handover mail's rule, and the reason is the same: trying the Hiworks credentials first
     * would hand somebody guessing at PO ids two facts instead of none - that the sign-in worked,
     * and that the PO does not exist.
     *
     * The approval check sits between them. It is after the scoped read (so a PO you cannot see
     * answers 404, not "not approved") and before the sign-in.
     */
    const manager = tsCode("purchase-orders/NeotmsPoRequestMailManager.ts");
    const send = /export async function sendPoRequestMail[\s\S]*?\n}/.exec(manager)![0];

    const read = send.indexOf("PoGetOps");
    const approved = send.indexOf("row.poApproved");
    const login = send.indexOf("hiworksLogin");
    expect(read).toBeGreaterThan(-1);
    expect(approved).toBeGreaterThan(read);
    expect(login).toBeGreaterThan(approved);
  });

  test("the mail escapes everything a person typed", () => {
    /*
     * The body is HTML built by concatenation, and three of the values in it are typed by people:
     * the remarks, the file names, and the names carried on the PO. This mail goes OUTSIDE the
     * company, so an unescaped one is markup in somebody else's inbox - and a file called
     * `<img src=x onerror=...>.pdf` is not a hypothetical, it is a file name.
     *
     * The URL is escaped too, which is the easy one to miss: it sits in an `href`, so a quote in
     * it would close the attribute and open another.
     */
    const mail = lambdaSource("purchase-orders/NeotmsPORequestEmail.ts");

    // Every interpolation of a caller-supplied value goes through esc/escLines.
    for (const field of ["facts.translatorName", "facts.pmName", "facts.languages", "facts.volume", "facts.deadline"]) {
      expect(mail).toContain(`esc(${field})`);
    }
    expect(mail).toContain("escLines(choices.note.trim())");
    expect(mail).toContain("esc(file.url)");
    expect(mail).toContain("esc(file.fileName)");

    // And nothing is interpolated raw. The template literal must not contain a bare ${facts.x}.
    expect(mail).not.toMatch(/\$\{facts\.\w+\}/);
    expect(mail).not.toMatch(/\$\{choices\.note\}/);

    // The link carries the file name as its text, which is what the request asked for.
    expect(mail).toMatch(/<a href="\$\{esc\(file\.url\)\}"[\s\S]*?esc\(file\.fileName\)/);
  });

  test("the file-type lists agree between the server, the schema and the screen", () => {
    /*
     * Three copies, as always, and each disagreement fails differently: a format the screen offers
     * but the schema rejects is a 400 on send; one the schema allows but the mail cannot label
     * goes out as a bare constant like `SDLPPX` in a mail to a customer's translator.
     *
     * The lists are deliberately different from each other - 작업파일 has sdlppx and 원본 does
     * not - so this cannot be collapsed into one list.
     */
    const mail = lambdaSource("purchase-orders/NeotmsPORequestEmail.ts");
    const serverList = (name: string): string[] => {
      const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(mail);
      expect(m).not.toBeNull();
      return [...m![1]!.matchAll(/"([A-Z]+)"/g)].map((x) => x[1]!);
    };
    const original = serverList("PO_ORIGINAL_FORMATS");
    const workspace = serverList("PO_WORKSPACE_FORMATS");

    expect(original).toEqual(["PDF", "PPT", "WORD", "HWP", "OTHERS"]);
    expect(workspace).toEqual(["SDLPPX", "PDF", "PPT", "WORD", "HWP", "OTHERS"]);

    // The screen's copies.
    const types = src("apis", "neotms.types.ts");
    const frontList = (name: string): string[] => {
      const m = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(types);
      expect(m).not.toBeNull();
      return [...m![1]!.matchAll(/'([A-Z]+)'/g)].map((x) => x[1]!);
    };
    expect(frontList("PO_ORIGINAL_FORMATS")).toEqual(original);
    expect(frontList("PO_WORKSPACE_FORMATS")).toEqual(workspace);

    /*
     * Every code has a label, and the labels are the only place Korean appears - the constants
     * themselves are English because they are application logic. `OTHERS` is the one worth naming:
     * it is 기타 on screen and in the mail, and `OTHERS` everywhere else.
     */
    for (const code of new Set([...original, ...workspace])) {
      expect(mail).toMatch(new RegExp(`${code}: "`));
      expect(types).toMatch(new RegExp(`${code}: '`));
    }
    expect(mail).toContain('OTHERS: "기타"');
  });

  test("the 21 days are enforced in three places that have to agree", () => {
    /*
     * The link lives as long as the DynamoDB row; the file lives as long as the S3 object; and the
     * mail tells the translator a number. Three layers, and the failures differ:
     *
     *   * Row outlives object -> the link works and answers 404. Reads as "broken", not "expired".
     *   * Object outlives row -> bytes nobody can reach, billed for, forever.
     *   * Mail says a different number -> the translator plans around the wrong date.
     *
     * The S3 rule is deliberately a day longer, because lifecycle expiry runs daily and DynamoDB
     * sweeps within ~48h - equal numbers would occasionally delete the object out from under a
     * live token.
     */
    const dbops = tsCode("attachments/NeotmsAttachment.dbops.ts");
    expect(dbops).toContain("export const ATTACHMENT_TTL_DAYS = 21");

    const storage = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "infra", "constructs", "NeotmsStorage.ts"),
      "utf8",
    );
    const rule = /id: "expire-mailed-attachments"[\s\S]*?\}/.exec(storage);
    expect(rule).not.toBeNull();
    expect(rule![0]).toContain("prefix: \"po-request/\"");
    expect(rule![0]).toContain("cdk.Duration.days(22)");

    // And what the mail promises.
    expect(lambdaSource("purchase-orders/NeotmsPORequestEmail.ts")).toContain("21일간 유효합니다");
  });

  test("the attachment table expires rows by TTL, and is its own table", () => {
    /*
     * The TTL attribute name has to match what the ops module writes, and the value has to be
     * SECONDS - DynamoDB silently never expires a row whose timestamp is in milliseconds, and
     * nothing notices because the application checks the expiry itself. The rows would just
     * accumulate forever.
     */
    const template = synth();
    template.hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      TableName: Match.stringLikeRegexp("attachments$"),
      TimeToLiveSpecification: { AttributeName: "NTTTL", Enabled: true },
    });
    expect(tsCode("attachments/NeotmsAttachment.dbops.ts")).toMatch(
      /NTTTL: \{ N: String\(Math\.floor\(record\.expiresAt \/ 1000\)\) \}/,
    );
  });

  test("sending is gated on the PO_EMAIL permission, which nothing granted before", () => {
    /*
     * `NEOTMS_PERMISSION_PO_EMAIL` was defined with the rest of the vocabulary and deliberately
     * granted to nobody - db/003_access_control.sql says so in as many words, because granting a
     * permission with no feature behind it reads, later, as a right somebody chose to hand out.
     *
     * It has a feature now. The migration's reasoning still holds for databases migrated before
     * today, so the first person to use this has to be given it on the 역할 관리 screen - which is
     * worth the test, because "the button is not there" is the symptom.
     */
    const handler = lambdaSource("neotms.handler.ts");
    const routes = handler
      .split("\n")
      .filter((l) => /request-mail|ATTACHMENT_UPLOADS/.test(l) && /method:/.test(l));
    expect(routes).toHaveLength(2);
    for (const route of routes) {
      expect(route).toContain("NEOTMS_PERMISSION_PO_EMAIL");
    }

    // The screen asks the same question before showing the button.
    const view = src("features", "purchaseorders", "PurchaseOrdersView.tsx");
    expect(view).toContain("may(profile, NEOTMS_PERMISSION_PO_EMAIL)");
    // And an unapproved PO cannot be mailed, matching the printable document's rule.
    expect(view).toContain("disabled={!row.poApproved}");
  });
});

describe("recent searches", () => {
  const src = (...segments: string[]) =>
    readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend", "src", ...segments),
      "utf8",
    );

  /** The quoted scope literals out of one SQL CHECK. */
  const scopesInCheck = (sql: string): string[] => {
    const check = /CONSTRAINT ck_staff_recent_search_scope CHECK \(scope IN \(([\s\S]*?)\)\)/.exec(
      sql,
    );
    expect(check).not.toBeNull();
    return [...check![1]!.matchAll(/'([a-z/-]+)'/g)].map((m) => m[1]!).sort();
  };

  test("the scope list is the same in all four places it exists", () => {
    /*
     * A scope is written down four times: the request schema's picklist, the CHECK in
     * 001_schemas.sql, the CHECK in 004_recent_searches.sql, and the string each screen passes to
     * `useRecentSearch`. Four copies is three chances to drift, and each disagreement fails
     * differently:
     *
     *   * A screen sending a scope the schema does not list gets a 400 on every search, which is
     *     at least loud.
     *   * A scope in the schema but not in the CHECK passes validation and dies at the database as
     *     a 23514 - a 500 for the user, naming a constraint.
     *   * A scope in the CHECKs but in neither the schema nor a screen is dead weight that reads
     *     like a screen somebody forgot to finish.
     *   * 001 and 004 disagreeing means a migrated database and a fresh one accept different
     *     scopes, which only shows up on whichever one was not tested.
     *
     * The DDL duplication is unavoidable - 001 builds a new database and 004 migrates an existing
     * one - so this is the test that keeps the two copies honest. It has already been checked
     * against two real databases: the table 004 creates is byte-identical to 001's.
     */
    const schemaScopes = (() => {
      const block = /export const RECENT_SEARCH_SCOPES = \[([\s\S]*?)\] as const/.exec(
        tsCode("neotms.schemas.ts"),
      );
      expect(block).not.toBeNull();
      return [...block![1]!.matchAll(/"([a-z/-]+)"/g)].map((m) => m[1]!).sort();
    })();

    expect(schemaScopes.length).toBe(7);
    expect(scopesInCheck(sql("001_schemas.sql"))).toEqual(schemaScopes);
    expect(scopesInCheck(sql("004_recent_searches.sql"))).toEqual(schemaScopes);

    /*
     * And the screens. Every scope must be used by exactly one screen - a scope nothing passes is
     * dead, and two screens sharing one would pool two different lists of searches into one
     * suggestion box.
     */
    const used: string[] = [];
    for (const file of [
      ["features", "projects", "ProjectsView.tsx"],
      ["features", "jobs", "JobsView.tsx"],
      ["features", "purchaseorders", "PurchaseOrdersView.tsx"],
      ["features", "customers", "CustomersView.tsx"],
      ["features", "translators", "TranslatorsView.tsx"],
      ["features", "payment", "PoPaymentView.tsx"],
      ["features", "payment", "InvoicePaymentView.tsx"],
    ]) {
      const call = /useRecentSearch\('([a-z/-]+)'\)/.exec(src(...file));
      expect(call).not.toBeNull();
      used.push(call![1]!);
    }
    expect(used.sort()).toEqual(schemaScopes);
  });

  test("a search is recorded when it is submitted, never while it is typed", () => {
    /*
     * The suggestion list holds five terms. Recording on every keystroke fills all five with the
     * prefixes of one word - '현', '현대', '현대차' - so the feature destroys itself on first use,
     * and it does it quietly: the list is full, the entries are real, and every one is useless.
     *
     * So `record` is called from each screen's `onSearch`, which is the form's submit handler and
     * therefore the moment the person committed to a term. The hook deliberately does not call it
     * itself - it could have intercepted the form's submit event, and then "when is a search
     * recorded" would not be visible in any screen's code.
     */
    for (const file of [
      ["features", "projects", "ProjectsView.tsx"],
      ["features", "jobs", "JobsView.tsx"],
      ["features", "purchaseorders", "PurchaseOrdersView.tsx"],
      ["features", "customers", "CustomersView.tsx"],
      ["features", "translators", "TranslatorsView.tsx"],
      ["features", "payment", "PoPaymentView.tsx"],
      ["features", "payment", "InvoicePaymentView.tsx"],
    ]) {
      const code = src(...file)
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ");

      // Inside onSearch, which is the submit handler.
      const onSearch = /const onSearch = \(e: FormEvent\) => \{[\s\S]*?\n  \}/.exec(code);
      expect(onSearch).not.toBeNull();
      expect(onSearch![0]).toContain("recent.record(");

      // And nowhere else. An onChange that records is the failure this test exists for.
      expect((code.match(/recent\.record\(/g) ?? []).length).toBe(1);
      expect(code).not.toMatch(/onChange[^\n]*recent\.record/);
    }
  });

  test("every search box turns the browser's own autofill off", () => {
    /*
     * Without `autoComplete="off"` the browser's form history takes the field and the datalist is
     * never drawn. The symptom is not "no suggestions" - it is "suggestions, but they are the
     * wrong ones", because what appears is whatever that person has typed into any similar box on
     * any site. The feature looks broken and its data looks wrong at the same time, and nothing
     * errors.
     *
     * Paired with `list`, so the two cannot drift apart: an input offering recent searches must
     * also be telling the browser to stay out of the way.
     */
    const views = [
      ["features", "projects", "ProjectsView.tsx"],
      ["features", "jobs", "JobsView.tsx"],
      ["features", "purchaseorders", "PurchaseOrdersView.tsx"],
      ["features", "customers", "CustomersView.tsx"],
      ["features", "translators", "TranslatorsView.tsx"],
      ["features", "payment", "PoPaymentView.tsx"],
      ["features", "payment", "InvoicePaymentView.tsx"],
    ];

    for (const view of views) {
      const code = src(...view);
      const listed = [...code.matchAll(/list="([a-z-]+-recent)"\s+autoComplete="off"/g)];
      expect(listed).toHaveLength(1);
    }
  });

  test("the endpoints read and write only the caller's own rows", () => {
    /*
     * This is the one table in the schema that is private to a person. The protection is not a
     * check somewhere - it is that no request shape can name whose rows to touch: the staff id
     * comes from the guard, and every statement puts it in the WHERE clause.
     *
     * `anyStaff` is the right tier for the same reason. Reading your own recent searches is not a
     * privilege a role grants; gating it on a permission would mean a role could be configured
     * such that somebody cannot see their own search history, which is not a sentence anybody
     * would write on purpose.
     */
    const handler = lambdaSource("neotms.handler.ts");
    const routes = handler
      .split("\n")
      .filter((l) => l.includes("RECENT_SEARCHES") && /method:/.test(l));
    expect(routes).toHaveLength(3);
    for (const route of routes) {
      expect(route).toContain("anyStaff: true");
      expect(route).not.toContain("permission:");
      expect(route).not.toContain("superuser:");
    }
    // Under /me/, with the other endpoint whose row set is chosen by who is asking.
    expect(handler).toContain('const RECENT_SEARCHES = "/api/v0/me/recent-searches"');

    // Every statement is scoped by staff_id, and none of them takes it from the body.
    const dbops = tsCode("profile/NeotmsRecentSearch.dbops.ts");
    const statements = [...dbops.matchAll(/sql: `([^`]*)`/g)].map((m) => m[1]!);
    expect(statements.length).toBeGreaterThanOrEqual(4);
    for (const statement of statements) {
      // Every statement carries the caller's id. The INSERT carries it in VALUES rather than in a
      // WHERE, so the assertion is on the parameter and not on the clause - and the reads and
      // deletes are checked for the predicate separately below.
      expect(statement).toContain(":staff_id");
    }
    for (const statement of statements.filter((sql) => !/INSERT INTO/.test(sql))) {
      expect(statement).toMatch(/staff_id = :staff_id/);
    }
    const manager = tsCode("profile/NeotmsRecentSearchManager.ts");
    expect((manager.match(/caller\.staffId/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  test("the five-term limit is enforced by the write, with the read as a backstop", () => {
    /*
     * Pruning on write rather than trimming on read is what keeps the table's size a function of
     * how many people and screens there are, instead of how much anybody searches. The read still
     * ranks and cuts at the same number, which covers the window between a record and its prune.
     *
     * The prune is a SEPARATE statement in the same transaction, and that is load-bearing: folded
     * into the INSERT as a data-modifying CTE it could not see the row just written - the shared
     * snapshot rule - so it would keep the previous five and leave a sixth behind. Verified
     * against a real database: eight terms recorded, five kept, newest first.
     */
    const dbops = tsCode("profile/NeotmsRecentSearch.dbops.ts");
    expect(dbops).toContain("export const RECENT_SEARCH_LIMIT = 5");
    // Both the prune and the read use the constant rather than a literal 5.
    expect((dbops.match(/\$\{String\(RECENT_SEARCH_LIMIT\)\}/g) ?? []).length).toBe(2);

    const manager = tsCode("profile/NeotmsRecentSearchManager.ts");
    const record = /export async function recordSearch[\s\S]*?\n}/.exec(manager);
    expect(record).not.toBeNull();
    expect(record![0]).toContain("pgTransaction");
    // Record first, then prune: the other order prunes before the new row exists.
    expect(record![0].indexOf("RecentSearchRecordOps")).toBeLessThan(
      record![0].indexOf("RecentSearchPruneOps"),
    );
  });

  test("recording a search cannot turn a working search into a visible error", () => {
    /*
     * The write happens after the search the user asked for has already run. A failure costs one
     * row in a suggestion list; surfacing it costs the user an error box on a screen where
     * nothing they wanted had failed. So the server answers 204 either way and logs, and the
     * client swallows it too.
     *
     * This is the opposite of every other write in the app, which is exactly why it is pinned -
     * the next person to touch it will reasonably assume the house rule applies.
     */
    const manager = tsCode("profile/NeotmsRecentSearchManager.ts");
    const record = /export async function recordSearch[\s\S]*?\n}/.exec(manager)![0];
    /*
     * The catch must SWALLOW it. Asserting only that a catch exists is not enough - a catch that
     * logs and rethrows reads the same at a glance and behaves like no catch at all, which is the
     * mutation this assertion was added for.
     *
     * Sliced rather than matched with a regex: the catch body contains a template literal, so its
     * `${...}` braces defeat any pattern that stops at the first `}`.
     */
    const catchAt = record.indexOf("} catch (err) {");
    expect(catchAt).toBeGreaterThan(-1);
    const caught = record.slice(catchAt);
    expect(caught).toContain("console.warn");
    expect(caught).not.toContain("throw");
    expect(record).toMatch(/status: 204/);
    // `runDb` would turn a throw into a 500, so it must not wrap this one.
    expect(record).not.toContain("runDb");

    // Forgetting, by contrast, reports failure: the user asked for it to be gone.
    const forget = /export async function forgetSearch[\s\S]*?\n}/.exec(manager)![0];
    expect(forget).toContain("runDb");

    const mutation = src("apis", "queries", "neotms.mutation.ts");
    const useRecord = /export function useRecordSearch[\s\S]*?\n}/.exec(mutation);
    expect(useRecord).not.toBeNull();
    expect(useRecord![0]).toContain("onError");
  });
});

describe("tables and the PO명 removal", () => {
  /** Every `.tsx` under frontend/src, recursively. */
  const walkTsx = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkTsx(full);
      return entry.name.endsWith(".tsx") ? [full] : [];
    });

  const frontendSrc = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "frontend",
    "src",
  );

  test("every table's empty-state row spans exactly its own columns", () => {
    /*
     * `TableState` renders one `<td colSpan={n}>` carrying the loading, error and empty messages.
     * When `n` disagrees with the number of `<th>`, nothing errors: too small leaves a gap at the
     * end of the row, too large stretches the cell past the last column and can push the table
     * wider than its container. Either way it only shows up on an empty list, which is the state
     * nobody opens a screen to look at.
     *
     * Asserted as "the two numbers agree" rather than as a list of expected widths. A test that
     * names the numbers has to be edited whenever a column is added - and when it was written that
     * way here it asserted that `colSpan={10}` and `colSpan={11}` each appeared once, which was
     * satisfied by the jobs table spanning eleven of its ten columns and the PO table spanning ten
     * of its eleven. Two bugs using the right pair of numbers, and the comment had the tables the
     * wrong way round.
     */
    const mismatches: string[] = [];

    for (const file of walkTsx(frontendSrc)) {
      const source = readFileSync(file, "utf8");
      for (const head of source.matchAll(/<thead>([\s\S]*?)<\/thead>/g)) {
        const columns = (head[1]!.match(/<th[\s/>]/g) ?? []).length;
        // The empty-state cell belongs to the table whose header it follows.
        const after = source.slice(head.index! + head[0].length);
        const span = /colSpan=\{(\d+)\}/.exec(after);
        if (!span) continue;
        const declared = Number(span[1]);
        if (declared !== columns) {
          mismatches.push(`${path.basename(file)}: ${String(columns)} columns, colSpan=${span[1]}`);
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  test("PO명 is gone from every screen, and still accepted by the API", () => {
    /*
     * The feedback was that nobody needed it. What "remove it from the UI but keep it" has to mean,
     * stated as four separate things, because doing three of them leaves a worse state than doing
     * none:
     *
     *   1. No input asks for it. A required field with no input refuses every save.
     *   2. No screen displays it. A value somebody can read but not edit is worse than one they
     *      cannot see - and the rows loaded from the legacy ETL still have names in them.
     *   3. The API still takes it, so a future screen needs no migration. That is the whole reason
     *      for keeping the column.
     *   4. The schema no longer requires it. It was `minLength(1)`, so leaving that in place would
     *      refuse every PO create with a 400 naming a field that has no input - unanswerable from
     *      the user's side.
     */
    const screens = walkTsx(frontendSrc).filter((file) =>
      /PurchaseOrder|PoPayment|InvoiceForm|Settlement|ProjectDetail|TranslatorSwap/.test(file),
    );
    expect(screens.length).toBeGreaterThanOrEqual(6);

    for (const file of screens) {
      const source = readFileSync(file, "utf8");
      // Comments explaining the removal are expected; `poName` as a VALUE is not. The one
      // permitted appearance is sending null.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
      const uses = [...code.matchAll(/poName/g)];
      const nulls = [...code.matchAll(/poName: null/g)];
      expect(uses.length).toBe(nulls.length);
      expect(code).not.toContain("PO명");
    }

    // The API still accepts it, and no longer demands it.
    const schemas = tsCode("neotms.schemas.ts");
    expect(schemas).toContain("poName: settable(text(500))");
    expect(schemas).not.toMatch(/poName:[^\n]*minLength\(1\)/);
    // The write path keeps its column spec, so a future screen writes it with no migration.
    expect(tsCode("purchase-orders/NeotmsPurchaseOrder.dbops.ts")).toContain("po_name");
  });
});

describe("data-modifying CTEs", () => {
  /*
   * `WITH x AS (INSERT/UPDATE ... RETURNING) SELECT ... FROM <the same table>` cannot work, and the
   * two ways it fails are both silent.
   *
   * PostgreSQL executes every part of such a statement against ONE snapshot, taken before the
   * statement began, so the outer query cannot see its own sub-statement's effects. Verified
   * against PostgreSQL 17:
   *
   *   * After an INSERT the outer join finds NOTHING. The statement returns zero rows while the
   *     row is committed - which is how `createRole` came to answer "The role was not created"
   *     with a 500 while the role sat in the table. A 500 on a request that succeeded is the worst
   *     shape of failure: the obvious response is to retry, and retrying hits a unique violation.
   *   * After an UPDATE the outer join finds the row with its OLD values. `StaffAdminUpdateOps`
   *     had this and nobody noticed, because the screen refetches the list immediately afterwards
   *     and overwrites the stale response. Its own comment said the shape existed to avoid
   *     re-rendering a row with the old label, which is precisely what it was doing.
   *
   * A fourth instance was correct BY ACCIDENT - `StaffClaimOps` in the auth path, whose UPDATE
   * writes only `lpx_sub` and `updated_at`, neither of which its column list selected. Adding
   * `lpx_sub` to that list would have broken every first sign-in with no error anywhere. That is
   * why this is a test about the pattern rather than three fixes.
   *
   * The correct shape: the written row's own columns come from RETURNING, and only columns from
   * OTHER tables are joined or subqueried - those the sub-statement did not touch, so the shared
   * snapshot is right for them.
   */
  test("no data-modifying CTE reads back the table it just wrote", () => {
    const offenders: string[] = [];

    /*
     * `lambdas/neotms/nodejs`, which is one level above `neotmsLambdaDir` and so covers both
     * `neotms/` and its sibling `auth/` - the auth module is where the fourth instance was. Not
     * `lambdas/` itself: that also holds `lambdas/common`, the LPX base code this repo does not
     * own and should not police.
     */
    for (const file of walkTs(path.join(neotmsLambdaDir, ".."))) {
      const source = readFileSync(file, "utf8");
      /*
       * Each `WITH <name> AS ( INSERT INTO <t> | UPDATE <t>` and the rest of its template literal.
       * Read from the raw source rather than from `tsCode`, because a comment explaining the
       * hazard is not an instance of it - and every one of these files now has such a comment.
       */
      for (const match of source.matchAll(
        /sql: `[\s\S]*?WITH\s+\w+\s+AS\s*\(\s*(INSERT INTO|UPDATE)\s+(\w+)([\s\S]*?)`/g,
      )) {
        const table = match[2]!;
        const afterReturning = (match[3] ?? "").split(/RETURNING/i).slice(1).join("RETURNING");
        /*
         * `\b` after the table name matters: `staff_attribute` must not count as `staff`. An
         * underscore is a word character, so there is no boundary between the two - which is what
         * makes this safe rather than lucky.
         */
        if (new RegExp(`\\b(?:JOIN|FROM)\\s+${table}\\b`).test(afterReturning)) {
          offenders.push(`${path.basename(file)}: ${match[1]} ${table}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("역할 관리 - editing what a role means", () => {
  const src = (...segments: string[]) =>
    readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend", "src", ...segments),
      "utf8",
    );

  test("the superuser override is reachable, by two routes", () => {
    /*
     * The bug this pins: `isSuperuser` read only `staff_attribute`, and NOTHING grants that row -
     * not the ETL, not the seed, and not `staff_bootstrap_superuser()`, which assigns a role and no
     * attributes. So the override was false for every caller on every database, and the screen that
     * repairs a misconfigured role was the screen a misconfigured role locked you out of.
     *
     * The second route is the bootstrap authority, which grants nothing genuinely new: a holder of
     * `lpx.admin.access` can already rewrite LPX's authority tables, so they could already give
     * themselves anything here. Making it explicit puts the capability on the caller instead of
     * leaving it implied by what somebody could do if they went looking.
     */
    const guard = tsCode("../auth/NeotmsAuthGuard.ts");
    const assignment = /isSuperuser:[\s\S]{0,200}?,\n/.exec(guard);
    expect(assignment).not.toBeNull();
    expect(assignment![0]).toContain("NEOTMS_USER_ATTRIBUTE_SUPERUSER");
    expect(assignment![0]).toContain("holdsBootstrapAuthority(account)");
  });

  test("a role's code is minted by the server, and then permanent", () => {
    /*
     * Two properties. The second is the old one; the first is why the screen stopped asking.
     *
     * MINTED. `role_code` is a surrogate key - nothing reads meaning out of it except the handful
     * of reserved codes the seed writes - so the box asking an administrator to invent one asked
     * for a value whose rules they had no reason to know. Both failures were real: a Korean label
     * is refused by the shape rule, which reads as the form being broken, and an English one typed
     * in a hurry is PERMANENT. The request schema no longer has the field at all, which is what
     * makes "it stopped asking" true of the API and not only of the form.
     *
     * PERMANENT. Four things resolve a role BY CODE: `staff_bootstrap_superuser()` and
     * `staff_self_register_bootstrap()` find the role to give an administrator, the seed re-asserts
     * grants `ON CONFLICT (role_code)`, and `sys_role_grant_all_permissions(text)` takes one as its
     * argument. A rename leaves all four looking for a row that no longer answers - and the
     * bootstrap's failure is silent until the day somebody needs it.
     *
     * Pinned in every place either property could be let back in: the writable-column list, the
     * INSERT, the generator, the two schemas, and the form.
     */
    const dbops = tsCode("staff/NeotmsRoleAdmin.dbops.ts");
    const fields = /const ROLE_ADMIN_FIELDS[\s\S]*?\];/.exec(dbops);
    expect(fields).not.toBeNull();
    expect(fields![0]).toContain("role_name");
    expect(fields![0]).toContain("active");
    expect(fields![0]).not.toContain("role_code");

    // The code the INSERT writes comes from the generator, and the request cannot reach it.
    const create = /export const RoleCreateOps[\s\S]*?^\}\);/m.exec(dbops);
    expect(create).not.toBeNull();
    expect(create![0]).toContain('param("role_code", newRoleCode(), "text")');
    expect(create![0]).not.toContain("input.roleCode");
    // And the generator is random, not derived from anything somebody typed. A code derived from
    // the Korean label would put a second, stale copy of the name in a column nothing can rename.
    expect(dbops).toMatch(/newRoleCode[\s\S]{0,300}randomUUID\(\)/);

    const schemas = tsCode("neotms.schemas.ts");
    const createSchema = /export const RoleAdminCreateSchema[\s\S]*?\}\);/.exec(schemas);
    expect(createSchema).not.toBeNull();
    expect(createSchema![0]).not.toContain("roleCode");
    // Required, because with a minted code the name is the only thing that tells two roles apart
    // on screen - and a nameless role reads as a line of hexadecimal in the assignment dropdown.
    expect(createSchema![0]).toContain("v.minLength(1)");
    // The update schema is derived from create, so a field added there cannot be forgotten here.
    expect(schemas).toContain(
      "export const RoleAdminUpdateSchema = v.partial(RoleAdminCreateSchema)",
    );

    // And the form: no input for a code anywhere, shown as text when editing.
    const form = src("features", "roles", "RoleFormModal.tsx");
    expect(form).not.toContain('id="role-code"');
    expect(form).toContain("{role.roleCode}");
    expect(form).toContain("바꿀 수 없습니다");
  });

  test("the permission and attribute editors are a replace, not a diff", () => {
    /*
     * The failure a diff produces: two administrators open one role in two tabs, each ticks one
     * box, and the result is the UNION of their intentions - both believe they saved what they
     * meant, and the role holds a combination neither chose. Sending the whole set makes the later
     * save win, which is at least a state somebody chose.
     *
     * Pinned on both sides. The server must prune what is not in the set, and the client must send
     * the set rather than a change list.
     */
    const dbops = tsCode("staff/NeotmsRoleAdmin.dbops.ts");
    const prune = /RolePermissionsPruneOps[\s\S]*?mapper/.exec(dbops);
    expect(prune).not.toBeNull();
    expect(prune![0]).toContain("DELETE FROM sys_role_permission");
    expect(prune![0]).toMatch(/NOT \(permission = ANY\(:keep\)\)/);

    for (const [file, field] of [
      ["RolePermissionsModal.tsx", "permissions"],
      ["../staff/StaffAttributesModal.tsx", "attributes"],
    ] as const) {
      const modal = src("features", "roles", file);
      // The whole picked set, sorted, and nothing resembling an add/remove pair.
      expect(modal).toContain(`${field}: [...picked].sort()`);
      expect(modal).not.toContain("added");
      expect(modal).not.toContain("removed");
    }
  });

  test("the two writes are refused when they would close the door behind the caller", () => {
    /*
     * The failure: an administrator empties the only role holding STAFF_UPDATE, or drops their own
     * superuser attribute, and the screen that would undo it is the one they just closed. Recovery
     * is then a SQL session run by whoever has database credentials - one person, on this
     * deployment.
     *
     * `NeotmsStaffAdminManager` used to record the first of these as deliberately NOT implemented,
     * because counting it needed the unconfirmed ROLE_1..ROLE_5 flag mapping. A flat permission
     * list has no mapping to be wrong about, so it is implemented - and this is the test that it
     * stays implemented.
     */
    const manager = tsCode("staff/NeotmsRoleAdminManager.ts");

    // Asked BEFORE the write, and with this role's own grants discounted - counting after the
    // prune would see the answer the prune created.
    expect(manager).toContain("lockoutRefusal");
    expect(manager).toMatch(/const refusal = await lockoutRefusal\([\s\S]{0,80}?\);/);
    expect(manager).toMatch(/if \(refusal\) return \{ status: 409/);
    expect(manager).toContain("AdminReachCountsOps");

    // A superuser passes every permission check, so one existing means nobody is locked out.
    const counts = /AdminReachCountsOps[\s\S]*?mapper/.exec(
      tsCode("staff/NeotmsRoleAdmin.dbops.ts"),
    );
    expect(counts).not.toBeNull();
    expect(counts![0]).toContain("NEOTMS_PERMISSION_STAFF_UPDATE");
    expect(counts![0]).toContain("NEOTMS_USER_ATTRIBUTE_SUPERUSER");
    expect(counts![0]).toContain("s.active");

    // And the caller cannot drop their own override.
    expect(manager).toMatch(/id === caller\.staffId/);
    expect(manager).toContain("You cannot remove your own superuser attribute");
  });

  test("the bootstrap role cannot be deleted or retired", () => {
    /*
     * `staff_bootstrap_superuser()` looks this role up by name to admit the first administrator
     * into an empty or locked-out database. Deleting it removes the way back in at the moment it
     * would be needed; retiring it leaves the function handing out a role the assignment dropdown
     * no longer offers, which is a confusing half-state.
     */
    const manager = tsCode("staff/NeotmsRoleAdminManager.ts");
    expect(manager).toContain("BOOTSTRAP_ROLE_CODE");
    expect(tsCode("staff/NeotmsRoleAdmin.dbops.ts")).toContain(
      'export const BOOTSTRAP_ROLE_CODE = "NEOTMS_SYSADMIN"',
    );
    // Both refusals, and both 409 rather than a silent no-op.
    expect((manager.match(/existing\.roleCode === BOOTSTRAP_ROLE_CODE/g) ?? []).length).toBe(2);
  });

  test("the screen can label every permission the server knows, and no others", () => {
    /*
     * Two failures, one in each direction, and both silent:
     *
     *   * A permission added to the server and not here renders as nothing at all - the checkbox
     *     is absent, so the permission cannot be granted or revoked from the only screen for it.
     *   * One removed from the server and left here is a tickable box that no route consults,
     *     which reads as a capability somebody has when they do not.
     *
     * The screen also warns at runtime about names it cannot label, because the two halves deploy
     * separately - but a warning is the fallback, and this is the check.
     */
    const labels = src("shared", "permissionLabels.ts");
    const named = [...labels.matchAll(/name: (NEOTMS_PERMISSION_[A-Z_]+),/g)].map((m) => m[1]!);
    expect(named.sort()).toEqual([...NEOTMS_PERMISSIONS].sort());

    const attributes = [...labels.matchAll(/name: (NEOTMS_USER_ATTRIBUTE_[A-Z_]+),/g)].map(
      (m) => m[1]!,
    );
    expect(attributes.sort()).toEqual([...NEOTMS_USER_ATTRIBUTES].sort());

    /*
     * Every permission carries a sentence, not just a label. The reader is deciding what a job
     * title may do, and `NEOTMS_PERMISSION_PO_APPROVE` does not say that approving is separate
     * from raising - a list of thirty-six constant names is a list somebody ticks by shape, which
     * is how a role ends up able to approve its own purchase orders.
     */
    const hints = (labels.match(/hint: '/g) ?? []).length;
    expect(hints).toBeGreaterThanOrEqual(NEOTMS_PERMISSIONS.length);
  });

  test("the role screen is gated on the attribute, not on a permission", () => {
    /*
     * The whole reason this screen is separate. A permission-shaped gate on grant editing is
     * editable through the endpoint it gates: a role holding "may edit grants" could grant itself
     * the other thirty-five in one request, and the only thing standing between a staff
     * administrator and the whole system would be that nobody thought to try.
     *
     * Three places have to agree - the route, the router and the sidebar - because disagreement is
     * silent in the worst direction: a nav entry shown to somebody the server will refuse looks
     * like the app is broken, and a route left open relies on the entry being hidden.
     */
    const routes = src("routes.tsx");
    expect(routes).toContain("function RequireSuperuser");
    expect(routes).toMatch(/hasAttribute\(profile, NEOTMS_USER_ATTRIBUTE_SUPERUSER\)/);
    expect(routes).toMatch(/<RequireSuperuser>\s*<RolesView \/>/);

    const permissions = src("shared", "permissions.ts");
    expect(permissions).toContain("superuserOnly?: true");
    expect(permissions).toContain("superuserOnly: true");
    // readableNav asks for the attribute as well as the permission.
    const nav = /export function readableNav[\s\S]*?\n}/.exec(permissions);
    expect(nav).not.toBeNull();
    expect(nav![0]).toContain("item.superuserOnly");
    expect(nav![0]).toContain("NEOTMS_USER_ATTRIBUTE_SUPERUSER");

    // The attribute editor on the staff screen is hidden the same way, for the same reason: it can
    // grant the superuser attribute, so a permission could not be allowed to open it.
    const staffView = src("features", "staff", "StaffView.tsx");
    expect(staffView).toContain("hasAttribute(profile, NEOTMS_USER_ATTRIBUTE_SUPERUSER)");
    expect(staffView).toContain("mayEditAttributes");
  });

  test("creating a role no longer leaves the assignment dropdown stale for half an hour", () => {
    /*
     * A real regression introduced by this screen existing. `useRoles` cached for thirty minutes on
     * the stated grounds that `sys_role` "only changes when a role is created, and that is an
     * operation this app has no screen for". It has one now - so creating a role and walking to
     * 사용자 관리 would show a dropdown without it, for up to thirty minutes, which reads as the
     * create having failed.
     *
     * Two things fix it and both are pinned: the write invalidates the `roles` prefix, and the two
     * role queries sit under that one prefix so a single invalidation reaches both.
     */
    const query = src("apis", "queries", "neotms.query.ts");
    const useRoles = /export function useRoles[\s\S]*?\n}/.exec(query);
    expect(useRoles).not.toBeNull();
    expect(useRoles![0]).toContain("neotmsKeys.rolesActive");
    expect(useRoles![0]).not.toContain("1000 * 60 * 30");

    const keys = src("apis", "queries", "neotms.keys.ts");
    expect(keys).toContain("roles: ['roles'] as const");
    expect(keys).toContain("rolesActive: ['roles', 'active'] as const");
    expect(keys).toContain("roleGrants: ['roles', 'grants'] as const");

    const mutation = src("apis", "queries", "neotms.mutation.ts");
    const affects = /const ROLE_AFFECTS[\s\S]*?as const/.exec(mutation);
    expect(affects).not.toBeNull();
    expect(affects![0]).toContain("neotmsKeys.roles");
    /*
     * `profile` too. A role's permissions decide what `/api/v0/me` returns, which is where the
     * sidebar and `may()` come from - so an administrator editing their own role would otherwise
     * keep a sidebar the server now refuses, and every click would 403.
     */
    expect(affects![0]).toContain("neotmsKeys.profile");
  });

  test("a role is created with no permissions, and the screen says so", () => {
    /*
     * The safe direction, deliberately. A new role that permits nothing presents as "the screens
     * are empty", which somebody reports within the hour. A new role that inherited a
     * sensible-looking default presents as nothing at all - nobody reports a permission they were
     * not supposed to have.
     *
     * The cost is that creating a usable role is two steps, so the screen opens the permission
     * editor straight after a create and the listing warns about roles with no grants.
     */
    const dbops = tsCode("staff/NeotmsRoleAdmin.dbops.ts");
    const create = /RoleCreateOps[\s\S]*?mapper/.exec(dbops);
    expect(create).not.toBeNull();
    expect(create![0]).toContain("INSERT INTO sys_role");
    expect(create![0]).not.toContain("sys_role_permission");

    const view = src("features", "roles", "RolesView.tsx");
    expect(view).toContain("if (created) setPermissionsFor(created)");
    expect(view).toContain("권한이 하나도 없는 역할");
  });

  test("counting holders and permissions cannot fan out", () => {
    /*
     * A role has many permissions AND many staff. One SELECT joining both multiplies them - a role
     * with 36 permissions and 4 holders reports 144 of each - and the wrong number is plausible
     * enough to ship. Scalar subqueries cannot fan out; a join plus GROUP BY can.
     *
     * The same hazard on the staff side: `staff` x `staff_attribute` is one-to-many, so a join
     * there would list somebody once per attribute.
     */
    for (const file of ["staff/NeotmsRoleAdmin.dbops.ts", "staff/NeotmsStaffAdmin.dbops.ts"]) {
      const code = tsCode(file);
      expect(code).toContain("array_agg");
      expect(code).not.toMatch(/GROUP BY/i);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Self-registration - the one write an unregistered account may perform       */
/* -------------------------------------------------------------------------- */

describe("self-registration", () => {
  const handler = () => lambdaSource("neotms.handler.ts");

  test("staff_self_register forces role_id to NULL and cannot be told otherwise", () => {
    /*
     * The single property the whole feature rests on. The row this function creates is a REQUEST,
     * and what makes it a request rather than an account is that `role_id` is NULL - a NULL role
     * means `RoleMenuPermissionsOps` is never even called, the permission matrix is empty, and
     * every menu-gated route refuses.
     *
     * Two halves, and the second is the one that would be easy to break:
     *
     *   1. The INSERT writes NULL. Written as a literal in the VALUES list, where it is next to the
     *      constraints that bound it.
     *   2. The function has NO PARAMETER that could carry a role, a scope or an active flag. This is
     *      the assertion that survives a refactor: somebody adding `p_role_id text` to "let the
     *      bootstrap reuse this" would turn the only endpoint an unapproved account can reach into
     *      an endpoint that assigns its own permissions. The signature is checked rather than the
     *      INSERT alone, because a parameter that exists will eventually be passed.
     */
    const code = sqlAll();
    const fn = /CREATE OR REPLACE FUNCTION staff_self_register\([\s\S]*?\n\$\w*\$;/.exec(code);
    expect(fn).not.toBeNull();
    const body = fn![0];

    const signature = /staff_self_register\(([\s\S]*?)\)\s*\n?RETURNS/.exec(body)?.[1] ?? "";
    expect(signature).not.toBe("");
    expect([...signature.matchAll(/(p_\w+)\s+text/g)].map((m) => m[1]).sort()).toEqual([
      "p_email",
      "p_ip",
      "p_lpx_sub",
      "p_name",
      "p_name_eng",
      "p_phone",
      "p_position",
    ]);
    for (const forbidden of ["role_id", "view_scope", "active", "mgr_auth", "p_role"]) {
      expect(signature).not.toContain(forbidden);
    }

    /*
     * And the literals the INSERT actually writes, pinned POSITIONALLY rather than by presence.
     *
     * Presence is not enough here. `NULL` appears in the VALUES list seven times - five of them
     * inside `NULLIF(...)` for the optional profile fields - so `toContain("NULL")` would pass on a
     * version that wrote a role id. What has to hold is that the literals line up with their slots
     * in the column list, so the two are asserted as a pair: the last six columns are
     * `role_id, view_scope, active, deleted, created_by, created_ip` and the last six values are
     * `NULL, 'N', true, false, 'self-registration', v_ip`.
     *
     * Whitespace is collapsed first because the file formats one value per line with a paragraph of
     * reasoning above each, and comments are already gone - `sqlCode()` strips them, which is why
     * this cannot anchor on the `-- THE THREE SECURITY COLUMNS` banner that introduces them.
     *
     * `view_scope` is 'N' rather than NULL for a presentational reason given in the file; `active`
     * is true because false would make the guard report "deactivated" to somebody who has never had
     * an account.
     */
    const insert = (/INSERT INTO staff[\s\S]*?RETURNING id/.exec(body)?.[0] ?? "")
      .replace(/\s+/g, " ")
      .trim();
    expect(insert).toContain(
      "role_id, view_scope, active, deleted, created_by, created_ip)",
    );
    expect(insert).toContain("NULL, 'N', true, false, 'self-registration', v_ip)");
  });

  test("staff_self_register has no adopt-by-email branch", () => {
    /*
     * The difference between this function and `staff_bootstrap_superuser`, and the reason it is a
     * test rather than only a comment: the bootstrap HAS an adopt-by-email branch, so the obvious
     * review note on this file is "why doesn't this one do the same thing".
     *
     * Because by the time it runs, the email match has already been tried and lost. The guard's
     * just-in-time linking (`StaffUnclaimedByEmailOps`) adopts an unclaimed row whose email matches
     * on every sign-in, provided it is active and undeleted, and the application only reaches this
     * function when that came back empty. So the unclaimed rows still matching are exactly the ones
     * the guard refused: `active = false` and `deleted = true`. Adopting one would inherit a
     * departed employee's `role_id` - sign up with an address matching a former manager's record
     * and you are that manager.
     *
     * Checked by absence of the lookup. `staff_bootstrap_superuser` does its adoption with a
     * `lower(trim(mgr_email))` comparison, which is the shape anybody writing this branch would
     * reach for, and 006 is read alongside to prove the pattern is the right thing to look for -
     * otherwise this test would pass just as well if the pattern were wrong.
     */
    const bootstrap = /CREATE OR REPLACE FUNCTION staff_bootstrap_superuser[\s\S]*?\n\$\w*\$;/.exec(
      sqlAll(),
    )?.[0];
    expect(bootstrap).toMatch(/lower\(\s*(btrim|trim)\(\s*mgr_email/);

    const selfRegister = /CREATE OR REPLACE FUNCTION staff_self_register\([\s\S]*?\n\$\w*\$;/.exec(
      sqlAll(),
    )?.[0];
    expect(selfRegister).not.toMatch(/lower\(\s*(btrim|trim)\(\s*mgr_email/);
    // The only row this function may look up by is the verified OIDC subject.
    expect(selfRegister).toMatch(/FROM staff WHERE lpx_sub = p_lpx_sub/);
    expect(selfRegister).not.toMatch(/WHERE[\s\S]{0,80}mgr_email\s*=/);
  });

  test("an LPX administrator is offered the sign-up form, not minted behind it", () => {
    /*
     * The guard used to mint a staff row for a holder of the bootstrap authority on their first
     * request, silently. They never saw the form, so NEOTMS never learned the English name that
     * goes on foreign documents, the phone number or the position - and the row it left could not
     * be told apart from one a person had filled in.
     *
     * What this pins is the EXCLUSION. `whyUnusable` has three answers and only two of them are
     * repairs of a row that already exists; "missing" has to fall through to `unregistered` so the
     * form is offered at all. Drop `unusable !== "missing"` and the branch fires first, the form is
     * never reached, and the regression looks like nothing whatsoever to anybody who was not
     * expecting a form - which is how it got shipped the first time.
     *
     * The other two stay, and they are the way back in for an administrator who has locked
     * themselves out: an `inactive` row is deliberately never offered the form, and a `no role` row
     * already has a session - the waiting screen - so there is nothing to submit.
     */
    const guard = tsCode("../auth/NeotmsAuthGuard.ts");
    const branch = /if \(unusable [^{]*\{/.exec(guard);
    expect(branch).not.toBeNull();
    expect(branch![0]).toContain('unusable !== "missing"');
    expect(branch![0]).toContain("holdsBootstrapAuthority(account)");
  });

  test("approval on arrival is decided from the token, and what it grants is a literal", () => {
    /*
     * Three properties, each closing the same hole from a different side.
     *
     *   1. The CHOICE between the two sign-up functions is made from the verified authority list,
     *      never from the request body - and in exactly one module, so there is one place to read.
     *   2. Neither function takes a role, a scope or an active flag. The test above says why that
     *      matters for `staff_self_register`; if it did not also hold here, writing two functions
     *      instead of one function with a boolean would have bought nothing.
     *   3. What "approved" MEANS is a literal in SQL - the reserved role code and view_scope 'Y'.
     *      'Y' is not cosmetic: a superuser whose scope is anything else can open every screen and
     *      see nothing on any of them.
     */
    const manager = tsCode("profile/NeotmsRegistrationManager.ts");
    expect(manager).toContain("holdsBootstrapAuthority(identity.account)");
    expect(manager).toMatch(/bootstrapAdmin[\s\S]{0,200}StaffSelfRegisterBootstrapOps/);

    // Two files may name the bootstrap ops: the one that defines it and the one that guards it.
    const callers = walkTs(path.join(neotmsLambdaDir, ".."))
      .filter((file) => readFileSync(file, "utf8").includes("StaffSelfRegisterBootstrapOps"))
      .map((file) => path.basename(file))
      .sort();
    expect(callers).toEqual(["NeotmsRegistrationManager.ts", "NeotmsStaff.dbops.ts"]);

    const fn = /CREATE OR REPLACE FUNCTION staff_self_register_bootstrap\([\s\S]*?\n\$\w*\$;/.exec(
      sqlAll(),
    );
    expect(fn).not.toBeNull();
    const signature =
      /staff_self_register_bootstrap\(([\s\S]*?)\)\s*\n?RETURNS/.exec(fn![0])?.[1] ?? "";
    expect([...signature.matchAll(/(p_\w+)\s+text/g)].map((m) => m[1]).sort()).toEqual([
      "p_email",
      "p_ip",
      "p_lpx_sub",
      "p_name",
      "p_name_eng",
      "p_phone",
      "p_position",
    ]);
    for (const forbidden of ["role_id", "view_scope", "active", "boolean", "p_role"]) {
      expect(signature).not.toContain(forbidden);
    }

    // It wraps the ordinary function rather than copying its mgr_id minting - the third copy of
    // that collision loop would be the one whose bugs nobody sees until two people sign up at once.
    expect(fn![0]).toContain("staff_self_register(");
    expect(fn![0]).toMatch(/role_code = 'NEOTMS_SYSADMIN'/);
    expect(fn![0]).toMatch(/view_scope = 'Y'/);
    // Its own audit marker, so a form submission is distinguishable from a silent mint.
    expect(fn![0]).toContain("lpx-bootstrap-signup");
  });

  test("the sign-up form does not promise an approval to somebody who needs none", () => {
    /*
     * The form's two sentences used to be one. An administrator who is approved on submission was
     * told "관리자 승인 후 사용할 수 있습니다" and then shown a confirmation saying their request was
     * queued for a review - and they would be inside the application a second later. Neither
     * sentence is harmful; both are false, and being told you are waiting when you are not is how
     * somebody concludes the screen is broken and signs up again.
     *
     * The server decides which sentence applies (`ProfileView.bootstrapAdmin`), so the promise of a
     * review has to sit INSIDE that conditional rather than in the paragraph above it.
     */
    const view = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "frontend",
        "src",
        "features",
        "auth",
        "SignupView.tsx",
      ),
      "utf8",
    );
    expect(view).toMatch(/bootstrapAdmin[\s\S]{0,400}관리자 승인 후 사용할 수 있습니다/);
    expect(view).toContain("승인 절차 없이");
  });

  test("009 is idempotent at every statement, like the rest of db/", () => {
    // Same rule as 006 and 008, for the same reason: the Supabase SQL editor wraps a submission in
    // its own transaction, so a partial application has to be recoverable by re-running the file.
    const code = sqlAll();
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/m);
    expect(code).toContain("CREATE OR REPLACE FUNCTION staff_self_register");
    // Pinned `search_path`, because the pooler hands out whatever session it has and a function
    // whose table references depend on the caller's path resolves differently per caller.
    expect(code).toMatch(/SET search_path = public, pg_temp/);
  });

  test("exactly two routes run without a staff row, and they are the deadlock-breaking pair", () => {
    /*
     * `account: true` is the widest tier in the routing table - a verified LPX account and nothing
     * else - so the list of routes carrying it is the list of endpoints reachable by somebody NEOTMS
     * knows nothing about. It is meant to stay at two, and this test is what makes growing it a
     * decision rather than an accident.
     *
     * The two exist to break a deadlock the earlier version had: `anyStaff` means "has a usable
     * staff row", so an unregistered employee was refused by every endpoint INCLUDING the one that
     * would have told them what was wrong and the one that would have fixed it. The SPA had nothing
     * to render but "not registered, contact an administrator" - on a system where self-registration
     * is how one becomes registered.
     */
    const accountRoutes = handler()
      .split("\n")
      .filter((l) => /^\s*\{ path:/.test(l) && l.includes("account: true"));
    expect(accountRoutes).toHaveLength(2);
    expect(accountRoutes.map((l) => /path: "([^"]+)", method: "(\w+)"/.exec(l)?.slice(1, 3))).toEqual(
      [
        ["/api/v0/me", "GET"],
        ["/api/v0/registration", "POST"],
      ],
    );
    // Not also `anyStaff`. The two flags are read in sequence by `routeAllows`, so carrying both
    // would be harmless today and misleading forever.
    for (const line of accountRoutes) expect(line).not.toContain("anyStaff");
  });

  test("the registration handler takes the identity, never a caller", () => {
    /*
     * `callerOf` throws on an `account: true` route - there may be no staff row to build a caller
     * from - and that is the designed outcome. This pins the two places it would be reached for:
     *
     *   * the handler, which must use `identityOf`;
     *   * the `created_by` stamp, which must NOT come from `writeContext(request)`. `writeContext`
     *     reads `callerOf(request).mgrId`, so using it here would throw on every sign-up. The IP is
     *     taken directly and `created_by` is written by the SQL function as 'self-registration'.
     */
    const block = /const handleRegisterSelf[\s\S]*?\n};/.exec(handler())?.[0] ?? "";
    expect(block).not.toBe("");
    expect(block).toContain("identityOf(request)");
    expect(block).not.toContain("callerOf");
    expect(block).not.toContain("writeContext");
    expect(block).toContain("clientInet(request.headers)");
  });

  test("the sign-up body cannot carry a permission or an identity", () => {
    /*
     * `SelfProfileSchema` is the allow-list for the one write an unapproved account can perform, and
     * valibot DROPS unrecognised keys - so a field absent from the schema is a field that cannot be
     * written however the request spells it. Six must stay absent: `roleId`, `viewScope` and
     * `active` are the permission system; `mgrId`, `corpCode` and `lpxSub` are identity. A form that
     * could write any of the six would be LKTMS's unsigned role cookie rebuilt with better manners.
     *
     * Asserted on the schema's own block rather than on the file, because the file also contains
     * `StaffAdminUpdateSchema`, which legitimately carries three of these names.
     */
    const schemas = lambdaSource("neotms.schemas.ts");
    const block = /export const SelfProfileSchema = v\.object\(\{[\s\S]*?\n\}\);/.exec(schemas)?.[0];
    expect(block).not.toBeUndefined();
    for (const forbidden of ["roleId", "viewScope", "active", "mgrId", "corpCode", "lpxSub"]) {
      expect(block).not.toContain(forbidden);
    }
    // And what it does carry, so that a field quietly dropped from the form shows up here.
    expect([...block!.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]).sort()).toEqual([
      "email",
      "name",
      "nameEng",
      "phone",
      "position",
    ]);
  });

  test("the pre-approval states report no grants rather than omitting the field", () => {
    /*
     * `menus` is always present in a `ProfileView` and is `[]` before approval. The honest answer -
     * no role, therefore no grants - and more usefully, it means the client's permission helpers
     * need no special case to fail closed: `mayDo` does `profile?.menus.find(...)` and an empty
     * array makes that undefined, which is a refusal.
     *
     * Had `menus` been omitted instead, `mayDo` would read `undefined.find` and throw - and it is
     * called during render of every screen, so the symptom would be a blank page rather than a
     * hidden button.
     */
    const manager = lambdaSource("profile/NeotmsProfileManager.ts");
    expect(manager).toMatch(/registration: "unregistered",[\s\S]*?menus: \[\],/);
    expect(manager).toMatch(/permissions: approved[\s\S]{0,120}: \[\],/);
    // The menu tree is not read at all for an unapproved caller. The whole company is unapproved on
    // the first morning, and each polling tab would otherwise cost a Supavisor connection.
    expect(manager).not.toMatch(/const menus = await grantsFor/);
  });

  test("a deactivated account is refused identically on both account-tier routes", () => {
    /*
     * `inactive` is a 403 and not a described state, on both routes, with the same sentence.
     *
     * Two different sentences for one state is how a user concludes that one of the two screens is
     * broken and keeps retrying. More importantly it must not be offered the sign-up form: that
     * would let somebody an administrator switched off mint a second staff row under a new `mgr_id`
     * and walk back in - which is also why `staff_self_register` refuses to adopt their old row.
     */
    const sentence = "This account has been deactivated in NEOTMS. Please contact an administrator.";
    for (const file of [
      "profile/NeotmsProfileManager.ts",
      "profile/NeotmsRegistrationManager.ts",
    ]) {
      const source = lambdaSource(file);
      expect(source).toContain(sentence);
      expect(source).toMatch(/if \(state\.kind === "inactive"\)|if \(before\.kind === "inactive"\)/);
    }
    // And the state is not in the type the SPA switches on - there is no screen for it.
    expect(lambdaSource("profile/NeotmsProfileManager.ts")).toMatch(
      /RegistrationStatus = "unregistered" \| "pending" \| "active"/,
    );
  });

  test("both notice texts are reproduced exactly, including the spacing", () => {
    /*
     * These two notices are copy the business wrote, and they are checked here because JSX makes
     * them easy to change without meaning to: a reformat that re-wraps a line inside a `<p>` is
     * invisible in review and changes nothing, but one that moves a space across the wrap point
     * changes the sentence.
     *
     * In particular the two differ on ONE SPACE - "기다려 주시면" on the waiting screen and
     * "기다려주시면" on the confirmation - and that difference is intentional. A well-meaning
     * normalisation of the pair is exactly what this test is here to catch, so neither is derived
     * from the other.
     *
     * Compared after collapsing each run of whitespace to a single space, because that is what a
     * browser does with the newline-and-indent JSX leaves between words.
     */
    const frontendDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "frontend",
      "src",
      "features",
      "auth",
    );
    const flat = (file: string) =>
      readFileSync(path.join(frontendDir, file), "utf8").replace(/\s+/g, " ");

    const gate = flat("AuthGate.tsx");
    expect(gate).toContain("관리자님께서 회원가입 요청을 검토하고 있습니다.");
    expect(gate).toContain(
      "요청이 승인된 후, 부여된 권한에 따라 서비스를 사용할 수 있습니다. 잠시만 기다려 주시면 감사드리겠습니다.",
    );

    const signup = flat("SignupView.tsx");
    expect(signup).toContain("회원가입 요청이 정상적으로 접수되었습니다.");
    expect(signup).toContain(
      "시스템 관리자님께서 요청을 신속히 검토한 후, 승인 처리를 진행할 예정입니다. 잠시만 기다려주시면 감사드리겠습니다.",
    );

    // The distinction itself, stated so that collapsing the two into one string fails here.
    expect(gate).toContain("기다려 주시면");
    expect(signup).not.toContain("기다려 주시면");
  });

  test("the shell picks the registration screen before the no-menus screen", () => {
    /*
     * An ordering bug with no type error and no runtime error. `menus` is `[]` before approval, so
     * `readableNav` is empty too - and if the `nav.length === 0` branch came first, somebody who has
     * never signed up would be shown "사용할 수 있는 메뉴가 없습니다. 시스템 담당자에게 역할 권한
     * 설정을 요청해 주세요": a screen that hides the thing they can do and instructs them to do a
     * thing they cannot. That is the deadlock this whole feature exists to remove, reintroduced in
     * the client.
     *
     * Each branch is located by its WHOLE STATEMENT, not by the condition alone. The comment that
     * sits above these branches in the shell explains the ordering requirement, and to do that it
     * quotes the condition - so `indexOf("nav.length === 0")` finds the explanation of the rule
     * rather than the code obeying it, and lands ABOVE the branches it is describing. The test then
     * fails on correct code, which is the worst kind of test to own.
     */
    const shell = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "frontend",
        "src",
        "NeotmsApp.tsx",
      ),
      "utf8",
    );
    const unregistered = shell.indexOf("if (profile?.registration === 'unregistered')");
    const pending = shell.indexOf("if (profile?.registration === 'pending')");
    const noMenus = shell.indexOf("if (nav.length === 0) return <NoMenusView");
    expect(unregistered).toBeGreaterThan(-1);
    expect(pending).toBeGreaterThan(-1);
    expect(noMenus).toBeGreaterThan(unregistered);
    expect(noMenus).toBeGreaterThan(pending);
  });
});

describe("the currency seed", () => {
  /**
   * `frontend/src/apis/neotms.codes.ts`, and the five `?? 'KRW'` form defaults, as text.
   *
   * Read as source rather than imported because the frontend is a separate TypeScript project with
   * its own module resolution and path aliases (`@/...`); importing one of its modules here would
   * mean teaching jest that alias to assert on a list of five strings.
   */
  const frontendFile = (...segments: string[]) =>
    readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend", "src", ...segments),
      "utf8",
    );

  /** The `value` of every entry in a `readonly CodeOption[]` declared with the `opt(...)` helper. */
  const optValues = (source: string, constant: string): string[] => {
    const block = new RegExp(`export const ${constant}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\]`).exec(source);
    expect(block).not.toBeNull();
    return [...block![1]!.matchAll(/opt\(\s*'([^']+)'/g)].map((m) => m[1]!);
  };

  /** The `coin_code` of every row the seed inserts. */
  const seededCurrencies = (): string[] => {
    const insert = /INSERT INTO currency[\s\S]*?ON CONFLICT/.exec(sqlAll());
    expect(insert).not.toBeNull();
    return [...insert![0].matchAll(/\(\s*'([A-Z]{3})'\s*,/g)].map((m) => m[1]!);
  };

  test("every currency the console can submit exists in the seed", () => {
    /*
     * The bug this file exists for, pinned in the direction that broke.
     *
     * `currency` is the parent of ten restricting foreign keys and nothing in 001..009 ever put a
     * row in it, so every create in the system failed with
     * `customer_cus_coin_fkey` / `Key (cus_coin)=(KRW) is not present in table "currency"`. What
     * made it hard to see rather than merely broken is that currency is never typed by a user:
     * `COIN_CODES` is hardcoded in the console and all five registration forms open with 'KRW'
     * already chosen, so the field that failed was one nobody had touched, and the error named a
     * constraint instead of a field.
     *
     * This is therefore the real invariant, and it is one-directional on purpose: every value the
     * console can SEND must have a parent row. A currency seeded here and absent from `COIN_CODES`
     * is merely unreachable - nothing reads this table to build a dropdown - which is why the
     * converse is asserted separately and more weakly below.
     */
    const offered = optValues(frontendFile("apis", "neotms.codes.ts"), "COIN_CODES");
    expect(offered.length).toBeGreaterThan(0);
    const seeded = seededCurrencies();
    expect(seeded).toEqual(expect.arrayContaining(offered));
  });

  test("the console and the rate fetcher offer the same currencies", () => {
    /*
     * The second half of the matched set, and the half with a live consequence.
     *
     * `CURRENCY_CODES` in the lambda is what the scheduled fetcher collects quotes for (minus KRW).
     * If it and `COIN_CODES` disagree, the effect is not a failed save - it is a currency the console
     * happily books jobs in and the fetcher never asks the bank about, which means every open
     * position in it reports its stored `*_price_ksum` forever while every other currency is revalued
     * at today's rate. Two screens, one answer each, neither looking wrong: the exact failure
     * NeotmsMoney.ts has one shared expression to prevent.
     *
     * Compared as sets, because the ORDER of `COIN_CODES` is the dropdown's running order and is a
     * presentation decision the lambda has no business constraining.
     */
    const offered = optValues(frontendFile("apis", "neotms.codes.ts"), "COIN_CODES");
    expect([...offered].sort()).toEqual([...CURRENCY_CODES].sort());

    // And KRW is excluded from what the fetcher asks for, rather than asked for and dropped later.
    // Nothing quotes KRW against itself, so requesting it would guarantee one permanent "currency in
    // use with no quote" row in the diagnostic at the foot of db/014_fx_rates.sql.
    expect(FX_CURRENCY_CODES).not.toContain("KRW");
    expect([...FX_CURRENCY_CODES].sort()).toEqual(
      [...CURRENCY_CODES].filter((c) => c !== "KRW").sort(),
    );
  });

  test("the only currency seeded but not offered is retired CNY", () => {
    /*
     * The converse of the first test, stated as "which extras are allowed" rather than as equality,
     * because there is now exactly one legitimate extra and the reason it is legitimate must be
     * recorded somewhere a change will trip over.
     *
     * A row seeded but not offered cannot break a save - nothing reads this table to build a
     * dropdown. It is still worth pinning, for the reason 007's 작업/단위 blocks are worth keeping
     * aligned: the moment the lists differ by something undocumented, the next person has to work
     * out which one is authoritative.
     *
     * CNY is the documented exception. The console offers CNH (the offshore yuan) because that is
     * what the bank quotes - `cur_unit` is "CNH" and CNY is absent from the upstream table
     * altogether - and because a Chinese customer pays this company by international transfer, which
     * settles offshore. The CNY ROW CANNOT SIMPLY BE DELETED: `coin_code` is referenced ON DELETE
     * RESTRICT by ten columns across nine tables, so on any database holding a legacy CNY job the
     * DELETE fails. Retiring it from `COIN_CODES` instead means no new row can be booked in it while
     * an existing one still renders - `codeOptions` shows it as `CNY (등록되지 않은 값)` rather than
     * snapping the field to KRW.
     *
     * If a currency is ever genuinely retired, add it here. If this fails because something was
     * ADDED to the seed and forgotten in the console, that is the drift this test is for.
     */
    const offered = new Set(optValues(frontendFile("apis", "neotms.codes.ts"), "COIN_CODES"));
    const seededOnly = seededCurrencies().filter((code) => !offered.has(code));
    expect(seededOnly).toEqual(["CNY"]);
  });

  test("no registration form defaults to a currency that is not seeded", () => {
    /*
     * The generalised form of the fault, and the one that catches its return.
     *
     * The original defect was not really "the table is empty" - it was that a form can commit the
     * user to a foreign-key value without ever showing them a choice. There are five such defaults
     * (`?? 'KRW'`), one per registration modal, and the next one added will be written by copying a
     * neighbour. If somebody copies it and changes the literal - a JPY-billing branch, a form that
     * opens on 'USD' - that form breaks completely and every other screen keeps working, which is
     * the hardest shape of bug to attribute.
     *
     * So the defaults are collected from the source and each one is required to have a parent row,
     * rather than 'KRW' being hardcoded here as the thing to look for.
     */
    const forms = [
      ["customers", "CustomerFormModal.tsx"],
      ["jobs", "JobFormModal.tsx"],
      ["projects", "ProjectFormModal.tsx"],
      ["purchaseorders", "PurchaseOrderFormModal.tsx"],
      ["translators", "TranslatorFormModal.tsx"],
    ];
    const seeded = seededCurrencies();

    for (const [feature, file] of forms) {
      const source = frontendFile("features", feature!, file!);
      /*
       * `cusCoin: customer?.cusCoin ?? 'KRW'` and its four siblings - the property names differ
       * per table (`cusCoin`, `tranCoin`, `coinCode`, `poCoinCode`), so the name is matched
       * rather than listed.
       *
       * The name must END at `Coin` or `CoinCode`, which is the whole reason for the `(?:Code)?:`
       * rather than a looser `\w*:`. Two of these forms also default an EXCHANGE RATE on the line
       * below the currency - `poCoinRate: po?.poCoinRate ?? '1'` in the purchase order form and
       * `coinRate: job?.coinRate ?? '1'` in the job form - and a trailing `\w*` swallows those,
       * collecting `'1'` as if it were a currency code. That is not a harmless extra match: '1'
       * is not in `currency`, so the test fails against correct source and the obvious repair is
       * to relax the assertion that does the real work.
       */
      const defaults = [...source.matchAll(/\w*[Cc]oin(?:Code)?:\s*[^\n]*?\?\?\s*'([^']+)'/g)].map(
        (m) => m[1]!,
      );
      // Every one of these forms has exactly one currency default. A form that lost its default
      // would silently stop sending a currency at all, so the count is asserted too.
      expect(defaults).toHaveLength(1);
      expect(seeded).toContain(defaults[0]!);
    }
  });

  test("010 cannot relabel a currency the ETL already loaded", () => {
    /*
     * `ON CONFLICT (coin_code) DO NOTHING`, and never `DO UPDATE`.
     *
     * `coin_name` is the company's own wording for a currency once the ETL has run. A re-runnable
     * seed that upserted would rewrite every migrated label to the guess made in this file, on
     * every apply - and because applying a `db/` file twice is explicitly encouraged everywhere
     * else in this suite, that would be a data loss somebody triggers while doing the right thing.
     */
    const code = sqlAll();
    expect(code).toMatch(/ON CONFLICT \(coin_code\) DO NOTHING/);
    // Scoped to the currency INSERT. Elsewhere in the schema an upsert is correct - the
    // self-registration function has one - so this cannot be asked of the whole file.
    expect(code).not.toMatch(/ON CONFLICT \(coin_code\)[\s\S]{0,40}DO UPDATE/);
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/m);
  });
});

describe("the 업무 구분 migration", () => {
  /**
   * db/011_job_types.sql, comments stripped.
   *
   * Every assertion below is about a statement, and this file's prose deliberately names the things
   * the statements must not do ("NOT TOUCHED ... purchase_order.po_lang", "the other direction was
   * considered and rejected"). Asserting on the raw text would make those explanations fail the
   * tests that exist to protect what they explain.
   */
  const code = () => sqlAll();

  test("the discriminator is on the parent rows, where it can be filtered", () => {
    /*
     * The headline requirement, and the reason the original sketch's shape was changed: with the
     * type inside a detail table there is no single predicate that answers "the MICE jobs", and a
     * LINGUISTICS job - which needs no detail row at all - has no type recorded anywhere.
     *
     * NOT NULL DEFAULT, and the default STAYS. The external LKTMS ETL does not know this column
     * exists, so dropping the default after the backfill - which is the usual playbook - breaks the
     * next load with a NOT NULL violation on a column the ETL has never heard of. The default is
     * also the correct answer for anything it inserts: all historical work here was linguistics.
     */
    for (const [table, column] of [
      ["job", "job_type"],
      ["purchase_order", "po_type"],
    ]) {
      // Declared in the CREATE TABLE now rather than added by a later ALTER, so the
      // column list of `job` is the whole statement of what a job holds. The table is
      // named in the pattern anyway, to keep the two columns' assertions apart.
      expect(code()).toMatch(
        new RegExp(
          `CREATE TABLE ${table!} \\([\\s\\S]*?${column!}\\s+text NOT NULL DEFAULT 'LINGUISTICS'`,
        ),
      );
    }
    expect(code()).not.toMatch(/ALTER COLUMN (job_type|po_type) DROP DEFAULT/);
    // And indexable in one predicate, partial to match the job/PO indexes 003 builds.
    expect(code()).toContain("CREATE INDEX IF NOT EXISTS ix_job_type ON job (job_type)");
    expect(code()).toContain("CREATE INDEX IF NOT EXISTS ix_po_type  ON purchase_order (po_type)");
  });

  test("a MICE job cannot hold a language pair, as a key constraint", () => {
    /*
     * The part of this design that is not obvious, and the one a later edit is most likely to
     * "simplify" away.
     *
     * Without the composite foreign key, a type change that leaves the old detail row behind is
     * silent AND asymmetric: the job list reads the language pair out of job_detail_linguistic while
     * the report counts that job under (비언어). Two screens disagreeing about one job, neither of
     * them looking wrong, and no error anywhere. With it, forgetting to clear the old side is a
     * 23503 - which is why NeotmsJobManager deletes the stale row BEFORE updating the type.
     *
     * The UNIQUE on the parent is what the composite FK references; a plain FK on `job_id` would
     * permit the mismatch, and so would a CHECK on its own.
     */
    expect(code()).toContain("ADD CONSTRAINT job_id_type_key UNIQUE (id, job_type)");
    expect(code()).toContain("ADD CONSTRAINT po_id_type_key UNIQUE (id, po_type)");
    expect(code()).toMatch(
      /jdl_job_type_fkey FOREIGN KEY \(job_id, job_type\)\s+REFERENCES job \(id, job_type\)/,
    );
    expect(code()).toMatch(
      /jdn_job_type_fkey FOREIGN KEY \(job_id, job_type\)\s+REFERENCES job \(id, job_type\)/,
    );
    expect(code()).toMatch(
      /pdl_po_type_fkey FOREIGN KEY \(po_id, po_type\)\s+REFERENCES purchase_order \(id, po_type\)/,
    );
    expect(code()).toMatch(
      /pdn_po_type_fkey FOREIGN KEY \(po_id, po_type\)\s+REFERENCES purchase_order \(id, po_type\)/,
    );

    /*
     * And both halves of each CHECK pair. The non-linguistic side is `<> 'LINGUISTICS'` rather than
     * `IN ('MICE', 'IMC')` on purpose: a fourth 업무 구분 added from the 유지보수 screen tomorrow
     * must be storable without a schema change. An allow-list here would reject it, from a
     * constraint nobody would think to look at.
     */
    expect(code()).toContain("jdl_is_linguistic CHECK (job_type = 'LINGUISTICS')");
    expect(code()).toContain("jdn_is_not_linguistic CHECK (job_type <> 'LINGUISTICS')");
    expect(code()).toContain("pdl_is_linguistic CHECK (po_type = 'LINGUISTICS')");
    expect(code()).toContain("pdn_is_not_linguistic CHECK (po_type <> 'LINGUISTICS')");
    expect(code()).not.toMatch(/CHECK \((job|po)_type IN \(/);
  });

  test("nothing in 011 requires a detail row to exist", () => {
    /*
     * "Constraints forbid; they never require" - the rule this file's header states and the one
     * worth a test, because the natural next edit is a NOT NULL on `job_slang` or a trigger that
     * inserts a detail row for every job.
     *
     * Jobs with both languages blank exist by the thousand. That is exactly why the report carries
     * '?' sentinels and why the console renders the language pickers with no `required`. A
     * constraint demanding a detail row, or a non-null language inside one, would make those
     * thousands of rows unsaveable - discovered one at a time, by whoever next edited one.
     */
    expect(code()).toMatch(/job_slang text REFERENCES/);
    expect(code()).toMatch(/job_category text REFERENCES/);
    expect(code()).not.toMatch(/(job|po)_(slang|elang|category) text NOT NULL/);
    // No trigger keeps a detail row in step with its parent either: the composite foreign
    // key and the two CHECKs do that declaratively, which is why they are asserted above.
    expect(code()).not.toMatch(/CREATE (OR REPLACE )?TRIGGER/i);
  });

  test("the detail rows are part of their parent, so they cascade", () => {
    // Deliberately against this schema's convention, which is ON DELETE RESTRICT everywhere. The
    // rest of the schema restricts because the child has independent meaning; a detail row has
    // none - it is part of the parent row, split out only so two types can carry different fields.
    // The application soft-deletes, so this fires only on a genuine hard delete.
    //
    // The PRIMARY KEY on the parent's id is what makes one-row-per-parent a key rather than a
    // convention: the rejected `job.job_detail_ling_id` direction has no unique constraint, so two
    // jobs could point at one detail row and editing one job's languages would change another's.
    for (const [table, key, parent] of [
      ["job_detail_linguistic", "job_id", "job"],
      ["job_detail_non_linguistic", "job_id", "job"],
      ["po_detail_linguistic", "po_id", "purchase_order"],
      ["po_detail_non_linguistic", "po_id", "purchase_order"],
    ]) {
      expect(code()).toMatch(
        new RegExp(
          `CREATE TABLE IF NOT EXISTS ${table!} \\(\\s+${key!}\\s+bigint PRIMARY KEY REFERENCES ${parent!} \\(id\\) ON DELETE CASCADE`,
        ),
      );
    }
    // On the composite FKs too, or a hard delete of a job would be blocked by the constraint that
    // was supposed to be about types.
    expect(code().match(/REFERENCES (job|purchase_order) \(id, (job|po)_type\) ON DELETE CASCADE/g))
      .toHaveLength(4);
  });

  test("every drop in the pinning block precedes every add", () => {
    /*
     * A defect this test was written for, which fails on the SECOND run of the file and not the
     * first - the worst possible time to find out.
     *
     * The four composite foreign keys depend on the two UNIQUE constraints they reference. So a
     * `DROP CONSTRAINT job_id_type_key` while `jdl_job_type_fkey` still exists fails with "cannot
     * drop constraint ... because other objects depend on it". On a fresh database there is nothing
     * to drop and the order is invisible; on a re-run it stops the file halfway, between the new
     * tables and the backfill.
     */
    const lines = code().split("\n");
    const lastDrop = lines.reduce(
      (at, line, i) => (/DROP CONSTRAINT IF EXISTS (jdl|jdn|pdl|pdn)_/.test(line) ? i : at),
      -1,
    );
    const firstUniqueDrop = lines.findIndex((line) =>
      /DROP CONSTRAINT IF EXISTS (job|po)_id_type_key/.test(line),
    );
    expect(lastDrop).toBeGreaterThan(-1);
    expect(firstUniqueDrop).toBeGreaterThan(lastDrop);
  });

  test("the two new code domains are seeded with the codes the application reads by name", () => {
    /*
     * `NeotmsCodeDomain` in NeotmsCode.dbops.ts and `CODE_DOMAIN` in the frontend both hold these
     * as literals, and `job.job_type` is a foreign key onto `sys_code (code)`. So a missing or
     * renamed seed row is not an empty dropdown: it is a job that cannot be created at all, with
     * `job_job_type_fkey` named in the error instead of a field.
     *
     * The three 업무 구분 codes are ASCII while most child codes in 007 are Korean. That is not a
     * deviation from the rule - the rule is "the code is whatever the thing is called", and 007 is
     * already ASCII for 사용 프로그램 (Trados, memoQ, XTM, Phrase, DTP) for the same reason.
     */
    for (const domain of ["'JOBTYPE'", "'JOBCAT'"]) {
      expect(code()).toContain(domain);
    }
    for (const child of ["'LINGUISTICS'", "'MICE'", "'IMC'"]) {
      expect(code()).toMatch(new RegExp(`${child},[^\\n]*'JOBTYPE'`));
    }
    for (const child of [
      "'online_marketing'",
      "'offline_marketing'",
      "'online_offline_marketing'",
      "'event_ceremony_management'",
    ]) {
      expect(code()).toMatch(new RegExp(`${child},[^\\n]*'JOBCAT'`));
    }
    // One shared category list, with no type-to-category allow-list anywhere: an IMC engagement can
    // be a 행사운영 and a MICE engagement can be 온라인홍보. A second JOBCAT-shaped domain per type
    // is the shape to watch for here.
    expect(code().match(/'JOBCAT'/g)?.length).toBeGreaterThanOrEqual(5);
    expect(code()).not.toMatch(/MICECAT|IMCCAT/);
    // Re-runnable, like every other seed in db/.
    /*
     * EVERY sys_code insert is `ON CONFLICT (code) DO NOTHING`, not three of them: re-running
     * the seed has to be harmless, and `sys_code.code` is unique across the whole table, so
     * an unguarded insert of a code another domain already has would abort the file.
     */
    const codeInserts = code().match(/INSERT INTO sys_code/g) ?? [];
    expect(codeInserts.length).toBeGreaterThanOrEqual(8);
    expect(code().match(/ON CONFLICT \(code\) DO NOTHING/g) ?? []).toHaveLength(
      codeInserts.length,
    );
  });
});

describe("the pricing-model split", () => {
  /** db/012_job_pricing.sql, comments stripped - same reason as 011's. */
  const code = () => sqlAll();

  test("the derivation moves to the linguistic detail tables and nothing else does", () => {
    /*
     * The whole design in one assertion pair: HOW an amount was arrived at is type-specific and
     * moves; the amount itself is not and stays.
     *
     * A MICE conference is not sold by the word. Before this file the only way to record one was the
     * legacy workaround - a fabricated 한국어 → 한국어 pair, a volume of 1, and the whole fee in the
     * unit price - which produced a row indistinguishable from a one-word translation and counted
     * that fake pair in the 언어쌍별 report.
     *
     * Asserted as the exact SET of added columns, not as nine separate presences, so a tenth has to
     * be justified here. In particular `job_price_sum` appearing in this list would be the mistake
     * this file exists to avoid.
     */
    const added = [...code().matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]!);
    expect([...added].sort()).toEqual([
      "job_price",
      "job_price_dis",
      "job_price_sel",
      "job_volume",
      "po_price",
      "po_price_sel",
      "po_unit_code",
      "po_volume",
      "unit_code",
    ]);

    // Onto the LINGUISTIC tables only. The non-linguistic tables gain nothing, because "total only"
    // means there is no derivation to record - the two totals on the parent are the whole answer.
    expect(code()).toMatch(/ALTER TABLE job_detail_linguistic\s+ADD COLUMN IF NOT EXISTS/);
    expect(code()).toMatch(/ALTER TABLE po_detail_linguistic\s+ADD COLUMN IF NOT EXISTS/);
    expect(code()).not.toMatch(/ALTER TABLE (job|po)_detail_non_linguistic\s+ADD COLUMN/);
  });

  test("the four amount columns are not moved, and not mentioned as being moved", () => {
    /*
     * `job_price_ksum` is summed by the margin report, sorted on by JOB_SORTS.amount and aggregated
     * by the project rollup; `po_price_ksum` is the cost equivalent. Moving either would have
     * changed REPORT_FROM, all nine report dimensions, both list sorts and the rollup at once, for
     * no gain whatsoever - a KRW total means the same thing on all three 업무 구분.
     *
     * It also keeps the legacy cleanup lossless: re-typing a dummy row to MICE drops the fabricated
     * pair and the `1 단어` while the money stays where it was. Nobody re-enters an amount, so
     * nobody mistypes one.
     *
     * Checked against both the ADD and the DROP lists, because getting this wrong in either
     * direction is equally bad and the two lists are edited at different times.
     */
    for (const column of [
      "job_price_sum",
      "job_price_ksum",
      "po_price_sum",
      "po_price_ksum",
      "coin_code",
      "coin_rate",
      "po_coin_code",
      "po_coin_rate",
    ]) {
      expect(code()).not.toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`));
      expect(code()).not.toMatch(new RegExp(`DROP COLUMN IF EXISTS ${column}\\b`));
    }
  });
});

describe("the 대시보드 aggregate", () => {
  /*
   * 대시보드(영업) and 대시보드(PM) answer "how are MY projects doing". Every assertion here guards a
   * way for that screen to be WRONG rather than broken, which is the whole difficulty: a tile is one
   * number with no units and no context, so a reader has nothing to check it against. Four of the
   * five failures below produce a plausible number.
   */
  /*
   * Comments stripped. This module's header is the clearest statement of what it must not do -
   * `job_pm_id`, `CURRENT_DATE`, a `GROUP BY` - so three of the assertions below would fail against
   * the prose that exists to prevent them.
   */
  const dbops = () => tsCode("dashboard/NeotmsDashboard.dbops.ts");

  /** `frontend/src/...`, as text. Same reason as the currency seed's reader above. */
  const frontendFile = (...segments: string[]) =>
    readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend", "src", ...segments),
      "utf8",
    );

  test("both dashboards key on the PROJECT's owner, never on the job's PM", () => {
    /*
     * The mismatch that made this a new endpoint instead of a report filter, pinned.
     *
     * `REPORT_DIMENSIONS`/`dimensionFilters` bind `pmId` to `j.job_pm_id` - the PM of the individual
     * JOB - and db/002_tables.sql says on the column that the two legitimately differ. So a
     * dashboard built on the report's filter would answer "the jobs I personally run" under a
     * heading that says "my projects", and a project manager who delegates every job would read
     * zero. Zero is a number a reader accepts.
     *
     * `job_pm_id` is asserted absent from the whole module, not just from the WHERE clause, because
     * the plausible mistake is adding it to one of the two LATERAL subqueries - which narrows the
     * money while leaving the counts right, so three tiles agree and the money quietly does not.
     */
    const owners = /OWNER_COLUMN[\s\S]*?\n\};/.exec(dbops())?.[0] ?? "";
    expect(owners).not.toBe("");
    expect(owners).toContain('sales: "p.prj_mgr_id"');
    expect(owners).toContain('pm: "p.prj_pm_id"');
    expect(dbops()).not.toContain("job_pm_id");
  });

  test("every role in DASHBOARD_ROLES has an owner column", () => {
    /*
     * `OWNER_COLUMN[role]` is interpolated into the statement text. A role present in the validated
     * list and absent from this record does not throw - it puts the string "undefined" into the
     * WHERE clause, and PostgreSQL answers `42703 column "undefined" does not exist`. That is a
     * loud failure, so this test is about the list growing, not about injection: a third dashboard
     * ('내가 등록한 프로젝트') is added by extending `DASHBOARD_ROLES`, and the record is the second
     * half of that edit.
     *
     * The membership check in the manager is what keeps a request string from becoming a column
     * name, and it is tested by being the only path to this record - there is no `as` value outside
     * `DASHBOARD_ROLES` that reaches the SQL at all.
     */
    const roles = [
      ...(/DASHBOARD_ROLES[^=]*=\s*\[([^\]]*)\]/.exec(dbops())?.[1] ?? "").matchAll(/"(\w+)"/g),
    ].map((m) => m[1]!);
    const columns = [
      ...(/OWNER_COLUMN[\s\S]*?\n\};/.exec(dbops())?.[0] ?? "").matchAll(/(\w+): "p\.\w+"/g),
    ].map((m) => m[1]!);
    expect(roles.length).toBe(2);
    expect(columns.sort()).toEqual([...roles].sort());
  });

  test("revenue and cost are collapsed separately, so neither multiplies the other", () => {
    /*
     * The fan-out NeotmsReport.dbops.ts describes: revenue lives on `job`, cost on `purchase_order`,
     * and a project has many of each. Joining both to `project` in one FROM clause multiplies every
     * job's revenue by the project's PO count.
     *
     * It is asserted here because of how it fails. The total does not error, does not go negative
     * and does not change shape - it is simply larger, by a factor nobody can derive from the
     * screen. On a project with one PO it is exactly right, which is most projects early on, so the
     * bug arrives later and looks like growth.
     *
     * Two LATERALs and no `GROUP BY`: with no grouping an aggregate over `project` returns exactly
     * one row, so the query cannot duplicate or drop a project either.
     *
     * Counted inside `DashboardSummaryOps` rather than over the whole file. The module holds a
     * second statement now - the acceptance panel - which has a LATERAL of its own for a different
     * reason, and a file-wide count would have made this assertion fail on a statement it is not
     * about. Narrowing it is not a loosening: the fan-out this test exists for is a property of the
     * aggregate, and the aggregate is what is now being read.
     */
    const summary = /export const DashboardSummaryOps[\s\S]*?\n\};/.exec(dbops())?.[0] ?? "";
    expect(summary).not.toBe("");
    expect([...summary.matchAll(/LEFT JOIN LATERAL/g)]).toHaveLength(2);
    expect(summary).not.toMatch(/GROUP BY/i);
  });

  test("the acceptance panel cannot show one project twice", () => {
    /*
     * Its own fan-out, with its own shape. A project collects an answer each time it is rejected and
     * re-assigned, so a plain join to `project_acceptance` would list a project once per answer -
     * each row carrying a different reason - and the panel would read as several projects in
     * trouble rather than one with a history.
     *
     * `LIMIT 1` inside a LATERAL is what makes it one row per project. Asserted together with the
     * ORDER BY, because the limit without the ordering picks an arbitrary answer, which on a
     * re-rejected project is the WRONG reason shown beside the right project.
     */
    const panel = /export const DashboardAcceptanceOps[\s\S]*?\n\};/.exec(dbops())?.[0] ?? "";
    expect(panel).not.toBe("");
    expect([...panel.matchAll(/LEFT JOIN LATERAL/g)]).toHaveLength(1);
    expect(panel).toContain("ORDER BY pa.created_at DESC, pa.id DESC");
    expect(panel).toContain("LIMIT 1");
    // And the two roles ask different questions - see ACCEPTANCE_FILTER. A PM must not be shown a
    // project they have already rejected, with an accept button the server refuses.
    const filter = /const ACCEPTANCE_FILTER[\s\S]*?\n\};/.exec(dbops())?.[0] ?? "";
    expect(filter).toContain("p.acceptance_status <> 1");
    expect(filter).toContain("p.acceptance_status = 0");
  });

  test("the overdue tile asks the database what day it is in Seoul", () => {
    /*
     * `CURRENT_DATE` is the server's date and the database runs in UTC, so between midnight and
     * 09:00 KST it is still yesterday there. The client's `isOverdue` splits the date in
     * `Asia/Seoul`, so for those nine hours the tile would call a project on time while the list
     * beside it already paints its due date red.
     *
     * Nine hours a day, starting at midnight - which is to say the tile would be wrong every
     * morning, and right by the time anyone went looking.
     */
    expect(dbops()).toContain("(now() AT TIME ZONE 'Asia/Seoul')::date");
    expect(dbops()).not.toContain("CURRENT_DATE");
  });

  test("the dashboard is scoped by the same two project columns it filters on", () => {
    /*
     * The ownership filter already pins one of `PROJECT_SCOPE_COLUMNS` to the caller, so
     * `scopeClause` is redundant today - and that is the reason to pin it. The day somebody widens
     * the ownership filter (a team dashboard, a "my department" view) the scope predicate is the
     * only thing standing between the widening and a widening of who may be read, and a scope
     * clause that was never there is not noticed at that moment.
     */
    expect(dbops()).toMatch(/scopeClause\(caller, \["p\.prj_mgr_id", "p\.prj_pm_id"\]\)/);
  });

  test("each dashboard is a path of its own, gated on a menu of its own", () => {
    /*
     * The requirement is that a person sees the dashboard matching their position, and the route
     * table is the only place this API says who may call what - per path. So the two screens are two
     * paths with one `menu:` each; one path taking `?as=sales|pm` could not express it, because a
     * gate that varied by query parameter would have to live inside the manager where no audit of
     * this table can see it.
     *
     * The pairing is what is asserted, not merely that both routes exist. Crossing them - the sales
     * path gated on DASHBOARD_PM - is the failure this guards: it is not a type error, both names are
     * real, and the symptom is a person holding one grant and reading the other person's book. That
     * is indistinguishable from working, since the numbers are plausible either way.
     *
     * Neither is REPORT, which would be wider: REPORT means "may read company figures", a grant an
     * organisation can reasonably withhold from a PM who should still see their own book.
     */
    const lines = lambdaSource("neotms.handler.ts").split("\n");
    for (const [role, permission] of [
      ["sales", "NEOTMS_PERMISSION_DASHBOARD_SALES_READ"],
      ["pm", "NEOTMS_PERMISSION_DASHBOARD_PM_READ"],
    ]) {
      const routes = lines.filter((l) => l.includes(`path: "/api/v0/dashboard/${role}"`));
      expect(routes).toHaveLength(1);
      expect(routes[0]).toContain(`permission: ${permission}`);
      expect(routes[0]).toContain('method: "GET"');
    }
    /*
     * And the old shape is gone. `?as=` surviving anywhere would mean a second way in, which - being
     * one path - could only be gated on one of the two menus.
     */
    expect(lambdaSource("neotms.handler.ts")).not.toContain('path: "/api/v0/dashboard"');
    expect(tsCode("dashboard/NeotmsDashboardManager.ts")).not.toContain('queryParams["as"]');
  });

  test("the client asks for the same two paths the server serves", () => {
    /*
     * Two files with no import between them, so nothing makes them agree. A mismatch is a 404 on a
     * screen that renders its loading state first, so it reads as a slow screen rather than a wrong
     * URL - and the nav entry, the route and the menu grant all look correct while it happens.
     */
    const api = frontendFile("apis", "neotms.api.ts");
    expect(api).toContain("`/api/v0/dashboard/${role}`");
    expect(api).not.toMatch(/'\/api\/v0\/dashboard'/);
  });

  test("the 진행 상태 vocabulary has one definition on the server and matches the client's", () => {
    /*
     * `project.prj_state` is unconstrained `text` - no CHECK, no FK, no default - so the counters are
     * built on literals, and a literal that does not match production does not fail. It reads zero,
     * and a zero tile is read as good news. `unrecognisedState` is what makes that loud at runtime;
     * this is what keeps the two lists from drifting in the first place.
     *
     * Both halves matter and they fail differently. A second definition on the server drifts
     * silently. A client list that offers a state the server does not know is worse than drift: the
     * dropdown writes it, every row saved with it lands in `unrecognisedState`, and the warning
     * banner then blames the data for what is actually a mismatch between two of our own files.
     */
    /*
     * TWO files, not one, and the second is not a leak.
     *
     * 진행, 완료 and 취소 are words in BOTH vocabularies: a project is 진행 and so is a PO. They are
     * not the same value - `project.prj_state` and `purchase_order.po_state` are different columns
     * answering different questions - so they get a module each, and the test allows exactly those
     * two. A third file matching this pattern is the thing being caught: anything else holding one of
     * these literals is a counter or a filter built on a guess, which is the failure mode the two
     * modules exist to prevent.
     */
    const offenders = walkTs(neotmsLambdaDir)
      .map((file) => path.relative(neotmsLambdaDir, file))
      .filter((relative) => /["'](진행|보류|완료|취소|견적)["']/.test(tsCode(relative)));
    expect(offenders.sort()).toEqual(["NeotmsPoStates.ts", "NeotmsProjectStates.ts"]);

    const states = tsCode("NeotmsProjectStates.ts");
    const server = [
      ...(/PROJECT_STATES: readonly string\[\] = \[([\s\S]*?)\]/.exec(states)?.[1] ?? "").matchAll(
        /PROJECT_STATE_(\w+)/g,
      ),
    ].map((m) => new RegExp(`PROJECT_STATE_${m[1]!} = "([^"]+)"`).exec(states)?.[1]);
    expect(server).toEqual(["견적", "진행", "완료", "보류", "취소"]);

    const codes = frontendFile("apis", "neotms.codes.ts");
    const block = /export const PROJECT_STATES[^=]*=\s*\[([\s\S]*?)\n\]/.exec(codes)?.[1] ?? "";
    expect(block).not.toBe("");
    /*
     * The client's list mixes `opt('진행', '진행')` with `opt(PROJECT_STATE_ACTIVE)`, the constant the
     * dashboard imports, so both forms are read: a quoted first argument, or the exported constant
     * resolved through its own declaration.
     */
    const client = [...block.matchAll(/opt\(\s*(?:'([^']+)'|(\w+))/g)].map(
      (m) => m[1] ?? new RegExp(`${m[2]!} = '([^']+)'`).exec(codes)?.[1],
    );
    expect(client).toEqual(server);
  });

  test("the 발주 상태 ladder matches on both sides, and 완료 means paid in full", () => {
    /*
     * The PO half of the test above, and it carries one hazard the project half does not:
     * db/015_payment.sql RENAMES two values in live data (발주 -> 미승인, 수락 -> 진행). A rename is
     * exactly the event that leaves a literal somewhere matching nothing, and a filter that matches
     * nothing returns an empty list rather than an error - which on the 승인·정산 screen reads as
     * "nothing is waiting for approval", the one sentence that screen must never say wrongly.
     *
     * Read through the exported constants rather than by matching the Korean words, so the test
     * fails on a REORDERED ladder too. Order is meaning here: the four rungs are a sequence, and the
     * screens that ask "how far along" read position, not just membership.
     */
    /*
     * Comments stripped (`tsCode`, as the project half does): the module's own docstrings spell the
     * ladder out in prose, and a regex that reads prose would pass on a module whose exports say
     * something else entirely.
     */
    const states = tsCode("NeotmsPoStates.ts");
    const names = (block: string) => [...block.matchAll(/PO_STATE_(\w+)/g)].map((m) => m[1]!);
    const valueOf = (name: string) =>
      new RegExp(`PO_STATE_${name} = "([^"]+)"`).exec(states)?.[1];

    const ladder = names(
      /PO_STATES: readonly string\[\] = \[([\s\S]*?)\]/.exec(states)?.[1] ?? "",
    );
    expect(ladder.map(valueOf)).toEqual(["미승인", "진행", "납품", "완료", "취소"]);

    /*
     * 납품 must NOT be closed and must BE invoiceable. That pair is the user's correction written as
     * an assertion: a partly-paid PO sits at 납품, so it still owes money (not closed) while the work
     * exists to be billed (invoiceable). Getting either one wrong is silent - a delivered PO would
     * either drop out of the outstanding-payables count, or become unbillable.
     */
    const closed = names(
      /PO_STATES_CLOSED: readonly string\[\] = \[([\s\S]*?)\]/.exec(states)?.[1] ?? "",
    ).map(valueOf);
    expect(closed).toEqual(["완료", "취소"]);
    expect(closed).not.toContain("납품");

    const invoiceable = names(
      /PO_STATES_INVOICEABLE: readonly string\[\] = \[([\s\S]*?)\]/.exec(states)?.[1] ?? "",
    ).map(valueOf);
    expect(invoiceable).toEqual(["납품", "완료"]);

    /*
     * The client's copy. `PO_STATES` is a `CodeOption[]` built from the same constant names, so the
     * two lists are compared through those names - a client that spells a value differently in its
     * own `PO_STATE_*` declaration still fails.
     */
    const codes = frontendFile("apis", "neotms.codes.ts");
    const clientBlock = /export const PO_STATES: readonly CodeOption\[\][^=]*=\s*\[([\s\S]*?)\n\]/
      .exec(codes)?.[1] ?? "";
    expect(clientBlock).not.toBe("");
    const clientLadder = [...clientBlock.matchAll(/PO_STATE_(\w+)/g)].map(
      (m) => new RegExp(`PO_STATE_${m[1]!} = '([^']+)'`).exec(codes)?.[1],
    );
    expect(clientLadder).toEqual(ladder.map(valueOf));

    const clientInvoiceable = [
      ...(/PO_STATES_INVOICEABLE: readonly string\[\] = \[([^\]]*)\]/.exec(codes)?.[1] ?? "")
        .matchAll(/PO_STATE_(\w+)/g),
    ].map((m) => new RegExp(`PO_STATE_${m[1]!} = '([^']+)'`).exec(codes)?.[1]);
    expect(clientInvoiceable).toEqual(invoiceable);
  });

  test("every nav path has a route, and both dashboards are in both tables", () => {
    /*
     * A nav entry whose path has no route is a menu item that lands on "페이지를 찾을 수 없습니다".
     * The two halves of the dashboard live in two files that do not import each other, so there is
     * no compile error in either direction - and the forgetful direction is the nav entry, because
     * that is the file a new screen is added to last.
     *
     * Asserted for the whole table rather than only for the dashboard: the hazard is structural, and
     * the two paths that prompted the test are the proof it can happen.
     */
    const nav = [...frontendFile("shared", "permissions.ts").matchAll(/path: '([^']+)'/g)].map(
      (m) => m[1]!,
    );
    const routes = [...frontendFile("routes.tsx").matchAll(/path: '([^']+)'/g)].map((m) => m[1]!);
    expect(nav).toContain("/dashboard/sales");
    expect(nav).toContain("/dashboard/pm");
    for (const item of nav) {
      // The route table is nested under `/`, so its paths are relative - `projects`, not `/projects`.
      expect(routes).toContain(item.replace(/^\//, ""));
    }
  });

  test("the client gates each dashboard on its own menu, the same way round as the server", () => {
    /*
     * `RequireMenu` is not a security boundary - every API re-checks - but it is the difference
     * between "접근 권한이 없습니다" and a screen that renders empty while three requests 403 behind
     * it.
     *
     * The crossing hazard from the server-side test applies here too, and worse: a client gated on
     * DASHBOARD_PM for the sales path would show the screen to the wrong holder, then let the server
     * refuse it - a visible menu whose every request 403s, which is the exact symptom
     * db/013_dashboard_menus.sql's header warns about and which reads as a deployment fault rather
     * than as a mistake in this table.
     */
    const routes = frontendFile("routes.tsx").replace(/\s+/g, " ");
    for (const [role, permission] of [
      ["sales", "NEOTMS_PERMISSION_DASHBOARD_SALES_READ"],
      ["pm", "NEOTMS_PERMISSION_DASHBOARD_PM_READ"],
    ]) {
      expect(routes).toMatch(
        new RegExp(
          `path: 'dashboard/${role}'[^}]*?RequireMenu permission=\\{${permission}\\}` +
            `[^}]*?DashboardView role="${role!}"`,
        ),
      );
    }
  });

  test("the two dashboards are their own nav group, and it is the one people land on", () => {
    /*
     * Three coupled facts, and the first two only work together.
     *
     * `HomeRedirect` sends to `readableNav(profile)[0]`, and `readableNav` filters NEOTMS_NAV in
     * **array** order - not group order. So the rail showing 대시보드 first and a person landing on
     * their dashboard are two different things, and moving only the group entry changes the rail
     * while leaving everyone's first screen at 프로젝트. Both are pinned because fixing one and
     * believing it fixed the other is the natural mistake.
     *
     * The third is that neither item is gated on PROJECT any more. While they were, this position was
     * actively wrong: every account's first screen became 대시보드(영업), so a PM-only user signed in
     * to four zeros that are true and read as a fault. It is right only because the grants are now
     * per screen - which is to say, this test fails if somebody reverts the menu split without
     * reverting the ordering.
     */
    const nav = frontendFile("shared", "permissions.ts");

    const groups = [...nav.matchAll(/\{ id: '(\w+)', label: '([^']+)'/g)].map((m) => [m[1], m[2]]);
    expect(groups[0]).toEqual(["dashboard", "대시보드"]);

    /*
     * Matched on `readPermission`, which is what now decides whether the entry appears. The
     * `menuId` beside it is still the screen's name but no longer gates anything, so asserting it
     * here would pin the label rather than the rule.
     */
    const items = [
      ...nav.matchAll(/readPermission: (\w+),\s*\n\s*path: '([^']+)'/g),
    ].map((m) => [m[2], m[1]]);
    expect(items.slice(0, 2)).toEqual([
      ["/dashboard/sales", "NEOTMS_PERMISSION_DASHBOARD_SALES_READ"],
      ["/dashboard/pm", "NEOTMS_PERMISSION_DASHBOARD_PM_READ"],
    ]);

    // Both in the 'dashboard' group, and nothing else in it - a 업무 screen landing there would take
    // the first slot from the dashboards and become the landing page instead.
    const inGroup = [...nav.matchAll(/path: '([^']+)',[\s\S]{0,160}?group: 'dashboard'/g)].map(
      (m) => m[1],
    );
    expect(inGroup).toEqual(["/dashboard/sales", "/dashboard/pm"]);
  });

  test("the client's menu ids are the server's", () => {
    /*
     * `NeotmsMenuId` in frontend/src/shared/config.ts mirrors `NeotmsMenu` by hand - there is no
     * shared package, deliberately, because the frontend is a static bundle and the Lambda is ESM
     * Node. A value that drifts produces a menu that is absent from the sidebar with no error
     * anywhere, which is the failure that file's own docstring describes.
     *
     * Checked for every id rather than just the two new ones: the drift is structural, and the
     * dashboards are only the latest proof that ids get added one side at a time.
     */
    const client = [
      ...frontendFile("shared", "config.ts").matchAll(/^\s{2}(\w+): '(\w+)',$/gm),
    ].map((m) => m[2]);
    expect([...client].sort()).toEqual([...Object.values(NeotmsMenu)].sort());
  });
});

describe("the floating KRW figure", () => {
  /** db/014_fx_rates.sql, comments stripped - same reason as 011's and 012's. */
  const code = () => sqlAll();

  test("the view is one row per currency and is not capped by age", () => {
    /*
     * `DISTINCT ON (currency_code)` with a matching ORDER BY is the whole view, and the two halves
     * are asserted together because either one alone is wrong in a way that still returns rows.
     * Without the DESC the view yields each currency's OLDEST quote - a number that is plausible,
     * stable, and quietly years out of date. Without the DISTINCT ON it yields every quote ever
     * collected, and then the LEFT JOIN in NeotmsMoney's expression FANS EVERY JOB OUT across its
     * currency's entire rate history, multiplying reported revenue by the number of days the
     * fetcher has been running. That one grows every day, which is the worst possible shape for a
     * reporting bug.
     *
     * No age cap, asserted as an absence. The temptation is real - a quote from three weeks ago
     * looks like something that should be filtered out - but filtering it produces NULL, which the
     * expression's COALESCE turns into the stored ksum, which is the figure this whole file exists
     * to stop quoting. The design decision is to SHOW staleness through `effective_date` rather
     * than hide it, so `current_date` must not appear in the view at all.
     */
    expect(code()).toMatch(
      /CREATE OR REPLACE VIEW fx_rate_latest AS\s+SELECT DISTINCT ON \(currency_code\)/,
    );
    expect(code()).toMatch(/ORDER BY currency_code, effective_date DESC/);
    const view = /CREATE OR REPLACE VIEW fx_rate_latest AS([\s\S]*?);/.exec(code())?.[1] ?? "";
    expect(view).not.toMatch(/current_date|now\(\)|INTERVAL/i);
    // `effective_date` is selected, not just ordered by - it is what the console prints beside the
    // converted amount, and without it in the projection the staleness is invisible.
    expect(view).toContain("effective_date");
  });

  test("014 corrects the comments that state the old frozen-rate rule", () => {
    /*
     * 002_tables.sql says the opposite of this model - it had to, it was written when the rate was
     * always captured - and the database's own column descriptions are what somebody inspecting the
     * schema in psql or the Supabase table editor reads. Leaving them would mean the authoritative
     * source on `coin_rate` tells the reader a rule the application no longer follows.
     *
     * The four columns the model actually redefines, by name. A COMMENT is documentation and so
     * nothing breaks if one is missed, which is exactly why it needs a test rather than a reviewer.
     */
    for (const column of [
      "job.coin_rate",
      "job.job_price_ksum",
      "purchase_order.po_coin_rate",
      "purchase_order.po_price_ksum",
    ]) {
      expect(code()).toContain(`COMMENT ON COLUMN ${column} IS`);
    }
    expect(code()).toContain("COMMENT ON VIEW fx_rate_latest IS");
    expect(code()).toContain("COMMENT ON TABLE fx_rate IS");
  });
});

describe("the rate fetcher", () => {
  test("it is a second function with its own log group, not a route on the API", () => {
    /*
     * Two Lambdas in this stack and no more. The API is deliberately monolithic (see NeotmsApi's
     * header), so a third function appearing here means that argument has been abandoned without
     * the header being updated - and the reasons this one is separate are specific and do not
     * generalise: it has no caller to route, its failure must not consume the API's reserved
     * concurrency, and it holds a grant the API must not.
     *
     * Its own log group is the third of those reasons made concrete. "Did the rate update today" is
     * a question about this schedule; answered in the API's group it would mean filtering a day of
     * requests for a `[fxrate]` prefix.
     *
     * Counted by the functions this repository NAMES, not by `resourceCountIs`. The template also
     * holds CDK's own custom-resource handlers - the S3 bucket deployment's, for one - which are
     * unnamed, come and go with CDK versions, and are nothing to do with this decision. A raw count
     * would fail on a library upgrade and say "a third Lambda appeared", which is both true and
     * useless.
     */
    const template = synth();
    const named = Object.values(template.findResources("AWS::Lambda::Function"))
      .map((r) => (r as { Properties: { FunctionName?: string } }).Properties.FunctionName)
      .filter((n): n is string => typeof n === "string");
    expect([...named].sort()).toEqual(["neotms-api", "neotms-fxrate"]);
    template.hasResourceProperties("AWS::Logs::LogGroup", {
      LogGroupName: "/aws/lambda/neotms-fxrate",
    });
  });

  test("the schedule is a flat rate and its target does not retry", () => {
    /*
     * `rate(5 minutes)` rather than a cron expression, and the difference is about RECOVERY rather
     * than about the data. KEXIM publishes once per business day around 11:00 KST, so a cron at
     * 11:05 would be the obvious encoding - and a cron that happens to fire during an upstream
     * outage leaves every report a day stale until tomorrow. It would also need a timezone and a
     * holiday calendar to be correct. A flat rate needs neither.
     *
     * `MaximumRetryAttempts: 0` asserted explicitly, because the DEFAULT is the dangerous value:
     * EventBridge retries a failed invocation for up to 24 hours, so a KEXIM outage would build a
     * backlog of identical attempts competing with the five-minute schedule that already supersedes
     * them. Zero is correct precisely because the next scheduled run IS the retry.
     */
    synth().hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(5 minutes)",
      State: "ENABLED",
      Targets: Match.arrayWith([
        Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 0 } }),
      ]),
    });
  });

  test("the fetcher is capped at one concurrent execution", () => {
    /*
     * A correctness ceiling, not prudence. Two concurrent runs write the same quotes for the same
     * business day through the same upsert - harmless in itself - but each holds Supavisor client
     * connections the API is waiting on, and a run that overlaps itself only happens when the
     * upstream is hanging. The right response to a hanging upstream is one pending request, not a
     * growing fleet.
     *
     * It also protects the API's own reservation: unreserved concurrency is drawn from the same
     * account pool the API's 20 are carved out of, so an unbounded fetcher could starve it.
     */
    synth().hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "neotms-fxrate",
      ReservedConcurrentExecutions: 1,
      MemorySize: 256,
    });
  });

  test("only the fetcher may read the KEXIM key, and only that one secret", () => {
    /*
     * The grant that justifies the second function, asserted from both sides.
     *
     * The fetcher's side: a `-??????` suffix, not a `*`. Secrets Manager appends six random
     * characters to every secret's ARN, and IAM matches `?` as exactly one character - so this names
     * the one secret called `neotms/erapikey`. A `*` would also match `neotms/erapikey-backup` or
     * anything else sharing the prefix, which is the kind of over-grant that is invisible until it
     * matters.
     *
     * The API's side is the half worth having a test for. Nothing the API serves needs this key, so
     * holding it would be a pure expansion of what a compromised API function can read - and the way
     * that happens is a `grantRead` added to the wrong construct during a refactor, which changes no
     * behaviour and so passes every other check.
     */
    const policies = synth().findResources("AWS::IAM::Policy");
    const forFetcher: string[] = [];
    const forApi: string[] = [];
    for (const [name, resource] of Object.entries(policies)) {
      const statements = (
        resource as { Properties: { PolicyDocument: { Statement: unknown[] } } }
      ).Properties.PolicyDocument.Statement;
      const text = JSON.stringify(statements);
      if (!text.includes("erapikey")) continue;
      (name.startsWith("FxRate") ? forFetcher : forApi).push(text);
    }
    expect(forFetcher).toHaveLength(1);
    expect(forApi).toEqual([]);
    expect(forFetcher[0]).toContain("secret:neotms/erapikey-??????");
    expect(forFetcher[0]).not.toContain("erapikey*");
  });

  test("the key itself is never an environment variable", () => {
    /*
     * The NAME is configuration; the key is not. A Lambda environment variable is readable by
     * anyone with `lambda:GetFunction`, it appears in the CloudFormation template - in plaintext, in
     * this very assertion's input - and it cannot be rotated faster than a release. The same rule
     * the database password follows.
     *
     * Checked across EVERY function's environment rather than just the fetcher's, because the shape
     * of this mistake is a value pasted into the wrong block.
     */
    for (const resource of Object.values(synth().findResources("AWS::Lambda::Function"))) {
      const env =
        (resource as { Properties: { Environment?: { Variables: Record<string, unknown> } } })
          .Properties.Environment?.Variables ?? {};
      for (const [key, value] of Object.entries(env)) {
        if (!/FX|ERAPI|EXCHANGE/i.test(key)) continue;
        // The only FX variable permitted is the secret's NAME, and its value must be that name.
        expect(key).toBe("NEOTMS_FX_SECRET_NAME");
        expect(value).toBe("neotms/erapikey");
      }
    }
  });

  test("both stages read the same FX secret, deliberately", () => {
    /*
     * The one resource the two stages share on purpose, so that it reads as a decision here rather
     * than as a copy-paste in the config.
     *
     * An exchange rate is a fact about a currency, not about a deployment - there is no "development
     * USD" - and the key is read-only against a public government API, so a development stack
     * reading it cannot affect production. The alternative is either a development stack with no
     * rates at all, which means the 원화로 환산 button cannot be tested before it ships, or two KEXIM
     * registrations maintained for one public data feed.
     */
    expect(NEOTMS_CONFIGS.dev.fx.secretName).toBe(NEOTMS_CONFIGS.prod.fx.secretName);
    // And the schedule is the same on both, because the recovery argument does not depend on stage.
    expect(NEOTMS_CONFIGS.dev.fx.scheduleMinutes).toBe(NEOTMS_CONFIGS.prod.fx.scheduleMinutes);
  });
});

describe("context overrides", () => {
  /** `app.node` as far as `resolveStageConfig` is concerned. */
  const ctx = (values: Record<string, unknown>) => ({
    tryGetContext: (key: string) => values[key],
  });

  test("no context leaves the committed stage config untouched", () => {
    expect(resolveStageConfig("dev", ctx({}))).toEqual(NEOTMS_CONFIGS.dev);
    expect(resolveStageConfig("dev")).toEqual(NEOTMS_CONFIGS.dev);
  });

  test("the authority and the client id can be overridden", () => {
    // The reason this mechanism exists: production ships the client id blank because it depends on a
    // hostname nobody has decided, and LPX could reissue the authority at any time.
    const config = resolveStageConfig(
      "prod",
      ctx({ authClientId: "other-client", appAuthorityId: "other-authority" }),
    );
    expect(config.auth.authClientId).toBe("other-client");
    expect(config.auth.appAuthorityId).toBe("other-authority");
  });

  test("an override does not mutate the shared config object", () => {
    // `NEOTMS_CONFIGS` is module state every caller shares. Applying overrides in place would make
    // one synth leak into the next, which in a test run looks like tests that pass alone and fail
    // together.
    resolveStageConfig("dev", ctx({ authClientId: "scratch" }));
    expect(NEOTMS_CONFIGS.dev.auth.authClientId).toBe("QP6B8rMvAnw8fOWXHP3A3qTGz");
  });

  test("a non-string context value is refused", () => {
    // The realistic source is cdk.json's `context` block, which is a wall of feature flags all set
    // to `true` - a key added there by analogy with its neighbours gets a boolean. Written into the
    // Lambda's environment that arrives as the string "true", which is non-empty, so
    // `isAuthConfigComplete()` passes and every account is then refused access.
    expect(() => resolveStageConfig("dev", ctx({ appAuthorityId: true }))).toThrow(
      /must be a string/,
    );
  });

  test("a valueless -c flag falls back to the stage default", () => {
    // Documents a CLI behaviour rather than a choice of ours: `cdk deploy -c appAuthorityId`, with
    // the `=value` forgotten, is dropped by the CLI and arrives as `undefined` (verified against
    // aws-cdk 2.1146) - so it cannot be told apart from not passing the flag. Asserted here so that
    // if a future CDK starts sending `true` instead, the test above is what fails, not a deployment.
    expect(resolveStageConfig("dev", ctx({ appAuthorityId: undefined })).auth.appAuthorityId).toBe(
      NEOTMS_CONFIGS.dev.auth.appAuthorityId,
    );
  });

  test("a blank override is refused rather than silently disabling a check", () => {
    expect(() => resolveStageConfig("dev", ctx({ authClientId: "   " }))).toThrow(/was empty/);
  });

  test("the Supabase project ref and pooler host can be overridden", () => {
    /*
     * Both ship blank, which is not laziness: the pooler hostname cannot be derived from the region
     * (`aws-0-` vs `aws-1-` is assigned per project), so it has to be copied out of the dashboard's
     * Connect dialog, and committing a guess would produce an ENOTFOUND that reads like an outage.
     * Until the projects exist these two arrive as flags.
     */
    const config = resolveStageConfig(
      "prod",
      ctx({
        supabaseProjectRef: "abcdefghijklmnopqrst",
        supabasePoolerHost: "aws-1-ap-northeast-2.pooler.supabase.com",
      }),
    );
    expect(config.supabase.projectRef).toBe("abcdefghijklmnopqrst");
    expect(config.supabase.poolerHost).toBe("aws-1-ap-northeast-2.pooler.supabase.com");
  });

  test("a Supabase override does not mutate the shared config object", () => {
    // `supabase` is a nested object, so the shallow copy that is enough for most configs is NOT
    // enough here - and the failure mode is tests that pass alone and fail together.
    resolveStageConfig("dev", ctx({ supabaseProjectRef: "scratch" }));
    expect(NEOTMS_CONFIGS.dev.supabase.projectRef).toBe("");
  });

  test("the pooler port and database name are not overridable", () => {
    // Both look like connection settings and neither is a free choice: 6543 is the only mode that
    // works from a Lambda (see above), and Supabase has no per-application database. An override on
    // either would be a flag that breaks the system in a way the flag's name does not suggest.
    for (const field of ["poolerPort", "databaseName", "caCertPem"]) {
      expect(Object.values(NEOTMS_SUPABASE_CONTEXT_KEYS)).not.toContain(field);
    }
  });

  test("settings this repo owns are not overridable", () => {
    // The auth list is deliberately limited to values registered on LPX. Retention, region and the
    // naming scheme are decisions that should arrive as a reviewed commit, not as a flag someone
    // typed once - and `supabase*` keys belong on their own list, not smuggled onto this one.
    for (const key of [
      "logRetentionDays",
      "region",
      "protectData",
      "resourcePrefix",
      "supabaseProjectRef",
    ]) {
      expect(NEOTMS_AUTH_CONTEXT_KEYS).not.toContain(key);
    }
  });

  test("an overridden authority reaches the synthesized function", () => {
    // End to end: context -> config -> construct -> env var. The hops above are each tested, but
    // this is the one that would catch `resolveStageConfig`'s result being dropped on the floor in
    // NeotmsApp.
    const app = new cdk.App({ context: { appAuthorityId: "authority-from-context" } });
    const stack = new NeotmsStack(app, "TestStack", {
      config: resolveStageConfig("dev", app.node),
      env: { account: "123456789012", region: "ap-northeast-2" },
    });
    Template.fromStack(stack).hasResourceProperties("AWS::Lambda::Function", {
      FunctionName: "neotms-dev-api",
      Environment: {
        Variables: Match.objectLike({ NEOTMS_APP_AUTHORITY_ID: "authority-from-context" }),
      },
    });
  });
});

describe("the 결제 print documents", () => {
  const frontendRoot = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "frontend",
    "src",
  );
  const frontendFile = (...segments: string[]) =>
    readFileSync(path.join(frontendRoot, ...segments), "utf8");
  const printDir = path.join(frontendRoot, "features", "payment", "print");
  const printFile = (name: string) => readFileSync(path.join(printDir, name), "utf8");

  /**
   * The same file with its comments stripped - `tsCode`'s counterpart for the console, and needed
   * here for a sharper reason than usual.
   *
   * Every negative assertion below names a legacy construct: `allowTaint`, `heightLeft`,
   * `window.print()`, `display: none`. These files document each of those by name, at length,
   * because the whole point of the modules is that they deliberately do NOT use them. So a test
   * reading raw source could only ever assert the useless "this file never mentions it", which
   * would forbid the documentation and permit the bug.
   *
   * JSX comments are block comments wrapped in braces, so they are stripped by the same rule.
   */
  const printCode = (name: string) =>
    printFile(name)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");

  test("the legacy html2canvas options that now fail SILENTLY are gone", () => {
    /*
     * The highest-value assertion here, because both of these are invisible failures rather than
     * errors.
     *
     * `onrendered` was html2canvas 0.4.x's only way to get the canvas back. It was REMOVED in 1.x:
     * the option is simply ignored, so the canvas is rendered, handed to nobody, and discarded. No
     * throw, no console warning - the 저장 button just does nothing, and "nothing happened" is the
     * hardest symptom to attribute to a library upgrade.
     *
     * `allowTaint: true` is worse because it breaks a DIFFERENT step from the one it appears on. It
     * permits cross-origin pixels into the canvas, which taints it, and a tainted canvas throws
     * SecurityError from `toDataURL()` - the capture succeeds and the SAVE fails. The logo is
     * bundled and same-origin, so `useCORS` alone covers it.
     *
     * Both lines were copy-pasted forward from 2013 in all four templates. Asserting their absence
     * is cheap; rediscovering why the button is dead is not.
     */
    const pdf = printCode("exportPdf.ts");
    expect(pdf).not.toMatch(/onrendered/);
    expect(pdf).not.toMatch(/allowTaint/);
    expect(pdf).toMatch(/useCORS\s*:\s*true/);
    /*
     * The background must be stated. html2canvas defaults to transparent, and a transparent PNG on
     * a PDF page renders BLACK in several viewers - with #555 body text on it.
     */
    expect(pdf).toMatch(/backgroundColor\s*:\s*['"]#ffffff['"]/);
  });

  test("the capture wrapper is max-content, or every PDF is cut off on a narrow window", () => {
    /*
     * The failure this prevents is visible only in the saved file. A plain block element takes its
     * parent's width, so on a window narrower than the form's fixed 1000px the wrapper measures
     * narrower than its contents; html2canvas uses the element's own width, and the right-hand
     * columns - RATE, SUB TOTAL, TOTAL - are simply not in the PDF. On screen everything looks
     * right, because the viewport scrolls.
     *
     * `fit-content` is the near-miss, not a synonym: it means "shrink to the space available",
     * which reintroduces this exact bug the day the form stops being a fixed width.
     */
    const css = printFile("PrintDocModal.module.css");
    expect(/\.docFrame\s*\{[^}]*max-content/.test(css)).toBe(true);
    expect(css).not.toMatch(/\.docFrame\s*\{[^}]*fit-content/);
  });

  test("only one language's form exists at a time - the other is not hidden", () => {
    /*
     * html2canvas reads COMPUTED styles. A `display: none` sibling measures zero, so the common
     * "render both, hide one" tab pattern produces either a blank page or - if the wrong one is
     * captured - a PDF in the language the screen is not showing. Both are silent.
     *
     * The structural guarantee is that `children` is a FUNCTION of the language, so the form that
     * is not selected does not exist in the DOM. Asserted on the type, because the type is what
     * forces every caller into the same shape.
     */
    expect(printFile("PrintDocModal.tsx")).toMatch(
      /children:\s*\(lang:\s*PrintLang\)\s*=>\s*ReactNode/,
    );
    expect(printCode("PrintDocModal.tsx")).not.toMatch(/display:\s*['"]?none/);
  });

  test("printing goes through an iframe, never window.print() on the app", () => {
    /*
     * There are no `@media print` rules anywhere in this console, and the reason is that the legacy
     * form WAS the whole page (PDF_Po_KOR.asp, whose 닫기 was `self.close()`). So `window.print()`
     * from inside the SPA sends the left rail, the top bar, the PO list behind the modal and the
     * translucent backdrop to the printer, and nothing says so until paper comes out.
     *
     * The iframe owns the only `.print()` call. Asserted across the whole folder so a later "quick
     * fix" inside a component is caught rather than shipped.
     */
    const files = readdirSync(printDir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    expect(files.filter((f) => /\bwindow\.print\s*\(/.test(printCode(f)))).toEqual([]);
    /*
     * The iframe's own call is `win.print()` on the frame's contentWindow, not `window.print()`, so
     * the assertion above does not merely exclude the file that does the printing - it would catch
     * printElement.ts too if that module ever reached for the app's window.
     */
    expect(printCode("printElement.ts")).toMatch(/\bwin\.print\(\)/);

    /*
     * And the iframe document must carry the app's styles in BOTH forms. Vite injects `<style>` in
     * development and emits `<link rel="stylesheet">` in a build, so collecting one of the two
     * yields a form that prints correctly in dev and unstyled in production, or the reverse - the
     * worst possible split, because the broken side is the one nobody tests on.
     */
    const print = printFile("printElement.ts");
    expect(print).toContain('style, link[rel="stylesheet"]');
    expect(print).toContain("srcdoc");
  });

  test("the PDF slices pages instead of re-placing one tall image, and keeps the tail", () => {
    /*
     * Legacy placed the full-height canvas on every page at a negative offset
     * (`position = heightLeft - imgHeight`), so an N-page PO embedded the same full-height PNG N
     * times and every page decoded all of it.
     *
     * The threshold matters more than the slicing. Legacy's loop was `while (heightLeft >= 20)` -
     * in millimetres, so up to 20mm of the document was dropped off the end. 20mm is about four
     * lines of body text, and what sits at the end of a PO is the PM's name, phone and e-mail. A
     * signature block that silently does not print is the expensive bug here.
     */
    const pdf = printCode("exportPdf.ts");
    expect(pdf).toMatch(/MIN_TAIL_MM\s*=\s*2\b/);
    expect(pdf).not.toContain("heightLeft");
    expect(pdf).toContain("drawImage(");
    /*
     * Each page is encoded from its OWN slice canvas. `canvas.toDataURL()` - the whole capture -
     * is the legacy shape, and seeing it here would mean the slicing loop is decorative.
     */
    expect(pdf).toContain("slice.toDataURL(");
    expect(pdf).not.toContain("canvas.toDataURL(");
  });

  test("PO 문서 출력 is gated on approval, on the screen as well as in the message", () => {
    /*
     * The approval gate is the point of the whole 결제 section: an unapproved PO must not reach the
     * translator. The screen's 승인 해제 confirmation already PROMISES this - "해제된 PO는 출력도
     * 정산도 할 수 없습니다" - and a promise in a confirm dialog that the button does not keep is
     * worse than no gate at all, because the person who read it stops checking.
     *
     * The asserted wording says PO, not 발주. That is this company's own vocabulary and the reason
     * the string reads the way it does; pinning it here is what stops a later "tidy-up" from
     * reintroducing a word the business does not use.
     *
     * ## The gate moved, deliberately, and this assertion moved with it
     *
     * It used to read `disabled={!row.poApproved}` on a single PO문서 button right here. The feedback
     * asked for the legacy 국/영 pair back and for the same buttons on two more screens, and three
     * copies of this condition is three chances for one of them to drift - at which point the
     * confirm dialog's promise above is kept on one screen and broken on the others, which is the
     * failure this test exists to prevent in the first place.
     *
     * So the condition now lives once, in `PoDocButtons`, and what is asserted here is that this
     * screen reaches printing only through it. `PoDocButtons`'s own test covers the condition.
     */
    const view = frontendFile("features", "payment", "PoPaymentView.tsx");
    expect(view).toContain("해제된 PO는 출력도 정산도 할 수 없습니다");
    expect(view).toContain("<PoDocButtons po={row} onPick={setPrinting} />");
    // No local copy of the gate left behind. `setPrinting` must have exactly one caller - the
    // component - rather than a button this screen still owns.
    expect(view).not.toMatch(/onClick=\{\(\) => setPrinting\(/);
  });

  test("the payment screens open already filtered, and only when the URL says nothing", () => {
    /*
     * A blank list was the old default, and on this table that is the one answer nobody wants: the
     * PO list carries no date restriction of its own, so an unfiltered read is the whole history.
     * Both screens therefore arrive with a query already made - PO on 승인됨 plus a 마감일 window,
     * invoices on a 발행일 window - and the window is today ±30 days.
     *
     * `DEFAULT_FROM`/`DEFAULT_TO` must be module-level constants, as in ReportsView: computed per
     * render they would be a new value on every pass, and a react-query key that changes every
     * render refetches forever.
     *
     * The `activeCount === 0` rule is the subtle half. `useUrlFilters` deletes empty keys, so
     * "전체 기간, no dates" and "just arrived from the menu" produce the same empty URL. Reading the
     * defaults only when NOTHING is in the URL is what keeps a deliberately cleared date box
     * cleared, instead of silently restoring today ±30 under the user.
     */
    for (const name of ["PoPaymentView.tsx", "InvoicePaymentView.tsx"]) {
      const view = frontendFile("features", "payment", name);
      expect(view).toMatch(/const DEFAULT_FROM = dateKstOffsetDays\(-30\)/);
      expect(view).toMatch(/const DEFAULT_TO = dateKstOffsetDays\(30\)/);
      expect(view).toContain("const pristine = activeCount === 0");
      // 전체 selects need a non-empty sentinel for exactly the reason above.
      expect(view).toMatch(/const FILTER_ALL = 'all'/);
    }

    /*
     * The PO screen's own default is 승인됨. It is the 결제 desk, not the approval queue - the work
     * done here (printing, settling) is only possible on an approved PO, so anything else is noise.
     */
    const po = frontendFile("features", "payment", "PoPaymentView.tsx");
    expect(po).toMatch(/approved:\s*'true'/);
  });

  test("the PO list can be cut by date, and sends only one of the two ranges", () => {
    /*
     * `PO_FILTERS` has had dueFrom/dueTo and paidFrom/paidTo all along, and
     * `NeotmsPurchaseOrderManager.readFilters` has read all four - the only thing missing was a
     * field on the client's query type, so no screen could send them. This pins the client side.
     */
    const api = frontendFile("apis", "neotms.api.ts");
    for (const field of ["dueFrom", "dueTo", "paidFrom", "paidTo"]) {
      expect(api).toContain(`${field}?: string | null`);
    }

    /*
     * And the screen sends ONE pair, chosen by 기간 기준 - the ProjectsView rule. The server ANDs
     * the two ranges, so filling all four silently asks a different question ("due inside this
     * window AND paid inside it too") than the two boxes on screen appear to ask.
     */
    const po = frontendFile("features", "payment", "PoPaymentView.tsx");
    expect(po).toContain("dueFrom: onDue ? chosen.from || undefined : undefined");
    expect(po).toContain("paidFrom: onPaid ? chosen.from || undefined : undefined");
  });

  test("결제 is two menu items under one menu id", () => {
    /*
     * The two screens answer different questions, so one address must mean one screen - hence two
     * nav items and two routes. But they share `PAYMENT` as the menu id, which is deliberate: the
     * id is the permission unit, and splitting it would need another db/0NN migration plus a
     * `sys_role_grant_all_permissions` re-grant (the hazard 008, 013 and 015 all carry a warning about).
     * The five action flags already separate seeing the screens from approving a PO from issuing an
     * invoice.
     *
     * `readableNav` filters per item, so two items on one id appear and disappear together - the
     * property that makes this safe. And `/payment` keeps a redirect, because links and bookmarks
     * were made while 결제 was a single screen with tabs.
     */
    const perms = frontendFile("shared", "permissions.ts");
    expect(perms).toContain("path: '/payment/purchase-orders'");
    expect(perms).toContain("path: '/payment/invoices'");
    expect(perms.match(/menuId: NeotmsMenuId\.PAYMENT/g)?.length).toBe(2);

    const routes = frontendFile("routes.tsx");
    expect(routes).toContain("payment/purchase-orders");
    expect(routes).toContain("payment/invoices");
    expect(routes).toContain('<Navigate to="/payment/purchase-orders" replace />');
  });

  test("the invoice form is not drawn until its POs have arrived", () => {
    /*
     * An invoice's line items are its POs, fetched separately - `InvoiceRow` holds only the totals.
     * Render the form while that read is in flight and it draws ten blank rows under a real Total,
     * which does not look broken; it looks like an invoice billing nothing. Nothing stops PDF저장
     * being pressed on it, and the saved file does not say it was incomplete.
     *
     * `limit: 200` is the other half: the server's page ceiling and the per-invoice PO ceiling are
     * both 200, so one request always holds the whole statement. Paginating it would mean a
     * settlement document whose row count depends on how many times somebody clicked 더 보기.
     */
    const modal = printFile("InvoicePrintModal.tsx");
    expect(modal).toMatch(/limit:\s*200/);
    expect(modal).toContain("if (!posQuery.isSuccess)");
  });

  test("the PO form reads the 업무 구분 through isLinguistic rather than comparing it", () => {
    /*
     * A MICE or IMC purchase order has no language pair; it has a 업무 분류. `isLinguistic()` already
     * carries the judgement that an UNKNOWN type counts as non-linguistic, so a fourth 업무 구분 added
     * later from 유지보수 prints its category instead of `? > ?`. Comparing against the constant
     * inline would lose that, and the loss shows up only on the printed order of a type nobody has
     * added yet.
     */
    const po = printFile("PoPrintDoc.tsx");
    expect(po).toContain("isLinguistic(po.poType)");
    expect(po).not.toMatch(/poType\s*(\?\?[^=]*)?===/);
  });

  test("the modern PDF libraries are the installed ones", () => {
    /*
     * Replacing the 2013 copies was asked for explicitly. Pinned here because the imports would
     * typecheck against whatever happens to be in node_modules on one machine.
     *
     * `html2canvas-pro` rather than `html2canvas`: the original has been unmaintained since 2022
     * and throws on modern CSS colour functions, while the fork keeps the same API surface.
     */
    const pkg = JSON.parse(
      readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend", "package.json"),
        "utf8",
      ),
    ) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).toContain("jspdf");
    expect(Object.keys(pkg.dependencies)).toContain("html2canvas-pro");
    expect(Object.keys(pkg.dependencies)).not.toContain("html2canvas");
  });
});

describe("the 분야 / 세부 분야 split", () => {
  /** db/016_project_fields.sql, comments stripped - same reason as 011's. */
  const code = () => sqlAll();

  const frontendFile = (...segments: string[]) =>
    readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend", "src", ...segments),
      "utf8",
    );

  /*
   * Comments stripped, for the negative assertions only. The last test in this block asserts that
   * `{row.cusField}` does NOT appear - and the screens being pinned document the defect they just
   * had, by name, in prose. Against the raw text such a test fails on the explanation, and the
   * cheapest way to a green run becomes deleting the explanation. Same reasoning, at length, above
   * the identical helper in the "날짜·시간" block.
   */
  const frontendCode = (...segments: string[]) =>
    frontendFile(...segments)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");

  test("the coarse list is a new domain and the eighteen detailed codes are left where they are", () => {
    /*
     * The defect being fixed is that both project 분야 columns read ONE list, and that the list is the
     * detailed one - legacy PRJ_FIELD2. So the fix adds the coarse list and must NOT move the
     * eighteen: `customer.cus_field`, `translator.tran_field` and `translator.tran_unfield` read the
     * FIELD domain too, and `sys_code.code` is unique across the whole table, so a value cannot sit
     * in both domains at once. A DELETE or an UPDATE of `code_parent` here would empty three other
     * dropdowns and leave their stored values rendering as '(등록되지 않은 값)'.
     */
    expect(code()).toMatch(/'PRJCAT',[^\n]*NULL,\s*8/);
    expect(code()).not.toMatch(/DELETE\s+FROM\s+sys_code/i);
    expect(code()).not.toMatch(/UPDATE\s+sys_code/i);
    // Re-runnable, like every other seed in db/.
    // Guarded like every other sys_code insert; the count is asserted once, above.
    expect(code()).toMatch(/'PRJCAT',[\s\S]{0,400}ON CONFLICT \(code\) DO NOTHING/);
  });

  test("the two dropdowns read the two different domains", () => {
    /*
     * The three literals that have to agree: the domain row in 016, `NeotmsCodeDomain` (which is what
     * the API's `domain` query parameter is validated against) and `CODE_DOMAIN` (which is what the
     * form passes to `CodeSelect`). The failure mode of a disagreement is an empty 분야 dropdown on
     * the project form, with nothing logged anywhere - `codesToOptions` has no fallback for this
     * domain and is right not to, since a project saves perfectly well without a 분야.
     *
     * The last assertion is the point of the whole change: if both selects read FIELD again, 세부
     * 분야 can only repeat or contradict 분야, and the report's 분야별 breakdown goes back to
     * eighteen thin bars.
     */
    expect(tsCode("codes/NeotmsCode.dbops.ts")).toContain('PRJCAT: "PRJCAT"');
    const codes = frontendFile("apis", "neotms.codes.ts");
    expect(codes).toContain("PRJCAT: 'PRJCAT'");
    expect(codes).toMatch(/PRJCAT: '프로젝트 분야'/);

    const form = frontendFile("features", "projects", "ProjectFormModal.tsx");
    expect(form).toContain("domain={CODE_DOMAIN.PRJCAT}");
    expect(form.match(/domain=\{CODE_DOMAIN\.FIELD\}/g)).toHaveLength(1);
  });

  test("every screen that shows a 분야 shows the name, and the project detail reads two domains to do it", () => {
    /*
     * Reported: the project's 분야 rendered as `PRJ_FIELD1` instead of 번역.
     *
     * What is stored is a `sys_code.code`; what a person can read is its `code_name`. Printing the
     * code is not merely ugly - the FORM shows the name in its dropdown, so the detail panel
     * displays different text for the value that was just picked, and that reads as a save that
     * went wrong.
     *
     * The project panel needs TWO lookups, which is the part that is easy to get half right. Since
     * db/016 the two columns read different domains: `prj_field` is PRJCAT (the seven coarse
     * groups) and `prj_field2` is FIELD (the eighteen detailed ones). One shared resolver would
     * silently fail on whichever column it was not built for and fall through to the raw code -
     * leaving one of the two halves looking exactly as it did before the fix.
     */
    const detail = frontendCode("features", "projects", "ProjectDetailView.tsx");
    expect(detail).toContain("const fieldName = useCodeNames(CODE_DOMAIN.PRJCAT)");
    expect(detail).toContain("const subFieldName = useCodeNames(CODE_DOMAIN.FIELD)");
    expect(detail).toContain("fieldName(project.prjField), subFieldName(project.prjField2)");

    /*
     * The same defect sat in the two neighbouring lists, on the same FIELD domain. They are pinned
     * here rather than in their own tests because the three are one bug, and a reader fixing a
     * fourth screen should find all of them in one place.
     *
     * The negative assertions are what keep it fixed: they fail on the exact edit that caused this
     * - interpolating the column straight into the cell.
     */
    for (const [feature, file, fields] of [
      ["customers", "CustomersView.tsx", ["cusField"]],
      ["translators", "TranslatorsView.tsx", ["tranField", "tranUnfield"]],
    ] as const) {
      const view = frontendCode("features", feature, file);
      expect(view).toContain("const fieldName = useCodeNames(CODE_DOMAIN.FIELD)");
      for (const column of fields) {
        expect(view).toContain(`fieldName(row.${column})`);
        expect(view).not.toContain(`{row.${column}}`);
      }
    }
  });

  test("the fields that cannot be empty commit a value instead of merely hiding the empty option", () => {
    /*
     * '선택 없음' is gone from every code select on all three registration forms, and the removal is
     * only half the change. A `<select>` whose value matches no option DISPLAYS the first option
     * while the form state stays `''`, so deleting the empty option without committing a value makes
     * the screen show one thing and save another - visible only after saving and reopening.
     * `CodeSelect` closes that by filling the value when `placeholder` is null, and `unsetPlaceholder`
     * is what decides: on an edit of a row that is ALREADY blank the option comes back, labelled
     * '지정 없음', so a memo-only edit cannot invent a 출발어 for one of the thousands of jobs that
     * legitimately have none (db/011's "forbid, never require").
     *
     * The regression to catch is someone re-adding a bare `<option value="">` to make one of these
     * fields clearable, which looks like a reasonable edit and silently reopens the mismatch. So each
     * named field is asserted to pass through the helper, and the bare options are pinned at NONE
     * rather than at a number - these counts were already stale once, back when 통화 still kept its
     * own option, and a count that has to be edited every time a field joins the set is a count that
     * gets edited to whatever makes the suite green.
     *
     * 단위 is not in this net and must not be: its `placeholder="단위"` is a visible label in a tight
     * row rather than an unset option, and that select is `silent`.
     */
    const project = frontendFile("features", "projects", "ProjectFormModal.tsx");
    expect(project).toContain("unsetPlaceholder(isEdit, form.prjField)");
    expect(project).toContain("unsetPlaceholder(isEdit, form.prjField2)");
    expect(project).toContain("unsetPlaceholder(isEdit, form.prjState)");
    expect(project).toContain("unsetPlaceholder(isEdit, form.prjMoneyState)");
    expect(project).toContain("unsetPlaceholder(isEdit, form.coinCode)");
    expect(project).not.toContain('<option value="">선택 없음</option>');

    const job = frontendFile("features", "jobs", "JobFormModal.tsx");
    expect(job).toContain("unsetPlaceholder(isEdit, form.workCode)");
    expect(job).toContain("unsetPlaceholder(isEdit, form.jobState)");
    expect(job).toContain("unsetPlaceholder(isEdit, form.jobSlang)");
    expect(job).toContain("unsetPlaceholder(isEdit, form.jobElang)");
    expect(job).toContain("unsetPlaceholder(isEdit, form.coinCode)");
    expect(job).not.toContain('<option value="">선택 없음</option>');

    const po = frontendFile("features", "purchaseorders", "PurchaseOrderFormModal.tsx");
    expect(po).toContain("unsetPlaceholder(isEdit, form.poWorkCode)");
    expect(po).toContain("unsetPlaceholder(isEdit, form.poState)");
    expect(po).toContain("unsetPlaceholder(isEdit, form.poSlang)");
    expect(po).toContain("unsetPlaceholder(isEdit, form.poElang)");
    expect(po).toContain("unsetPlaceholder(isEdit, form.poCoinCode)");
    expect(po).toContain("unsetPlaceholder(isEdit, form.poMoneyState)");
    expect(po).not.toContain('<option value="">선택 없음</option>');

    /*
     * 업무 구분 is the one field that gets a bare `null` rather than the helper, on the job form and
     * on the PO form alike, and that is correct rather than an oversight. On a job, `job.job_type` is
     * NOT NULL DEFAULT 'LINGUISTICS' (db/011), so no row can be blank and there is no '지정 없음' to
     * preserve. On a PO the displayed value falls back to the job's type whenever `form.poType` is
     * empty, so the blank state does not exist there either. Pinned because the obvious "tidy-up" is
     * to make every select on these forms look alike.
     */
    expect(job).toContain("placeholder={null}");
    expect(po).toContain("placeholder={null}");

    const codes = frontendFile("apis", "neotms.codes.ts");
    expect(codes).toContain("export const unsetPlaceholder");
    expect(codes).toContain("'지정 없음'");
    // The one place the fill actually happens. An effect, and the only one of its kind in these
    // forms, because the cause is arriving data rather than an input - see its comment.
    expect(frontendFile("shared", "ui", "CodeSelect.tsx")).toContain("onChange(first)");
  });

  test("세금계산서 left the screens but not the database", () => {
    /*
     * The request was explicit about the asymmetry: take 세금계산서 and 세금계산서 번호 off the
     * frontend, leave the backend alone, because they may come back. So both halves are asserted, and
     * the backend half is the one that needs a test - "we removed a field" is the kind of task that
     * drifts into removing the column, the schema entry and the SELECT too, and once the column is
     * dropped the data that was in it is not coming back with it.
     *
     * The frontend half is restricted to the project side on purpose. `po_invoice_state` still has a
     * writer - `SettlementModal` on the 결제 screen - so the PO list's 계산서 filter and column stay,
     * and `invoiceState` remains a live query parameter there. `prj_invoice_state` has none left,
     * which is why its filter, column and detail row went with the form fields rather than lingering
     * as read-only values nobody can change.
     */
    expect(sql("001_schemas.sql")).toContain("prj_invoice_state");
    expect(tsCode("neotms.schemas.ts")).toContain("prjInvoiceState");
    expect(tsCode("projects/NeotmsProject.dbops.ts")).toContain("prj_invoice_state");
    expect(tsCode("projects/NeotmsProject.dbops.ts")).toContain(
      'invoiceState: { column: "p.prj_invoice_state"',
    );

    for (const file of [
      frontendFile("features", "projects", "ProjectFormModal.tsx"),
      frontendFile("features", "projects", "ProjectsView.tsx"),
      frontendFile("features", "projects", "ProjectDetailView.tsx"),
      frontendFile("features", "purchaseorders", "PurchaseOrderFormModal.tsx"),
    ]) {
      /*
       * `project.prjInvoiceState` / `po.invCode` and friends - the JSX reads, not the prose. The
       * comments left behind at each vacated slot name these fields deliberately, so a bare substring
       * search would fail on the explanation rather than on the code.
       */
      expect(file).not.toMatch(/\b(project|po|row|form)\.(prj|po)?[Ii]nvoiceState\b/);
      expect(file).not.toMatch(/\b(project|po|row|form)\.invCode\b/);
    }

    // The PO side keeps its writer, and therefore keeps its screens. Stated as an assertion so that
    // "finish the job" does not quietly take these out too.
    expect(frontendFile("features", "payment", "SettlementModal.tsx")).toContain(
      "poInvoiceState: form.poInvoiceState.trim() || null",
    );
    expect(frontendFile("features", "purchaseorders", "PurchaseOrdersView.tsx")).toContain(
      "INVOICE_STATES",
    );
  });
});

describe("the date field's arithmetic", () => {
  /*
   * The only executed frontend code in this suite. Everything else here asserts that a decision is
   * written down; these assert that a calculation is right, which no amount of reading the source
   * establishes.
   *
   * All four functions work in UTC midnight (`Date.UTC` in, `getUTC*` out) and never touch the
   * viewer's zone. Tested that way deliberately: these cases would pass in Seoul and fail in a DST
   * zone if the implementation ever reached for local-time accessors, and CI runs in UTC.
   */

  test("a typed date is read in five shapes and a two-digit year means 2000-2099", () => {
    // The six-key gesture the whole component exists for.
    expect(parseDateField("261111")).toEqual({ ok: true, value: "2026-11-11" });
    expect(parseDateField("20261111")).toEqual({ ok: true, value: "2026-11-11" });
    expect(parseDateField("26-11-11")).toEqual({ ok: true, value: "2026-11-11" });
    expect(parseDateField("2026-11-11")).toEqual({ ok: true, value: "2026-11-11" });
    // Single-digit month and day, which is what people actually type.
    expect(parseDateField("2026-1-1")).toEqual({ ok: true, value: "2026-01-01" });

    /*
     * The app's own output, pasted back in. `formatDate` prints `2026. 10. 27.` into every table, so
     * copying a date out of a table and into a date box is the most natural gesture available -
     * and rejecting it would be the app refusing to read its own handwriting. The Excel form with
     * slashes is the same argument.
     */
    expect(parseDateField("2026. 10. 27.")).toEqual({ ok: true, value: "2026-10-27" });
    expect(parseDateField("2026/10/27")).toEqual({ ok: true, value: "2026-10-27" });

    /*
     * The weekday suffix is stripped and NOT verified. The box renders `2026-11-11(수)`, so editing
     * it in place leaves the old weekday attached to a new date - `2026-11-12(수)` - and 12 Nov 2026
     * is a Thursday. Checking the suffix would reject the single most likely edit there is.
     */
    expect(parseDateField("2026-11-12(수)")).toEqual({ ok: true, value: "2026-11-12" });

    // Clearing a date is a normal operation - jobs without a deadline exist, and `InlineDateCell`
    // turns the empty string into null. Making blank an error would remove the only way to clear it.
    expect(parseDateField("")).toEqual({ ok: true, value: "" });
    expect(parseDateField("   ")).toEqual({ ok: true, value: "" });

    // Two-digit years are 2000-2099 per the spec. 99 is 2099, not 1999.
    expect(parseDateField("991231")).toEqual({ ok: true, value: "2099-12-31" });
  });

  test("a date that does not exist is an error, not a different date", () => {
    /*
     * The single most important assertion in this block. `new Date(2026, 1, 30)` rolls forward to
     * 2 March without complaint, which is the default behaviour of every naive implementation and
     * the worst possible one: it stores a day the operator never typed and renders it as success.
     * A deadline silently two days late is not discoverable by looking at the screen.
     */
    const feb30 = parseDateField("2026-02-30");
    expect(feb30.ok).toBe(false);
    expect(parseDateField("20260230").ok).toBe(false);

    expect(parseDateField("2026-13-01").ok).toBe(false);
    expect(parseDateField("2026-00-10").ok).toBe(false);
    expect(parseDateField("2026-11-00").ok).toBe(false);
    expect(parseDateField("2026-11-31").ok).toBe(false);
    expect(parseDateField("ㅁㄴㅇㄹ").ok).toBe(false);
    expect(parseDateField("11111").ok).toBe(false); // five digits is neither shape

    // A real leap day passes - the round-trip check must not reject 29 Feb in a leap year.
    expect(parseDateField("2024-02-29")).toEqual({ ok: true, value: "2024-02-29" });
    expect(parseDateField("2026-02-29").ok).toBe(false);

    /*
     * Before 1990 is refused because `toDate` treats it as legacy garbage and returns null. Accept
     * it here and the value saves but every table renders it as '-': the input box and the list
     * would disagree about the same stored value, and nobody tracks that down.
     */
    expect(parseDateField("1989-12-31").ok).toBe(false);
    expect(parseDateField("1990-01-01").ok).toBe(true);

    // Failure carries a sentence, not a boolean. The box shows it verbatim.
    if (!feb30.ok) expect(feb30.reason.length).toBeGreaterThan(0);
  });

  test("the weekday is computed from the date, with Sunday at index 0", () => {
    /*
     * The Python reference indexes "월화수목금토일" with `weekday()`, which is Monday-0. `getUTCDay()`
     * is Sunday-0. Copying the reference string verbatim shifts every weekday by one day, and the
     * only symptom is somebody saying "the date is right but the day looks wrong" - which reads like
     * a cosmetic complaint and is instead the thing the weekday was added to prevent.
     */
    expect(formatDateField("2026-11-11")).toBe("2026-11-11(수)"); // Wednesday
    expect(formatDateField("2026-11-14")).toBe("2026-11-14(토)"); // Saturday
    expect(formatDateField("2026-11-15")).toBe("2026-11-15(일)"); // Sunday
    expect(formatDateField("2026-11-16")).toBe("2026-11-16(월)"); // Monday
    expect(formatDateField("")).toBe("");

    // Round-trips with the parser, which is what lets the box normalise what was typed.
    const parsed = parseDateField("261111");
    expect(parsed.ok && formatDateField(parsed.value)).toBe("2026-11-11(수)");
  });

  test("+N days crosses month, year and leap boundaries", () => {
    /*
     * `Date.UTC` carries the overflow, so these are free - but only while the arithmetic stays in
     * UTC. The reason to pin them is that "simplifying" to a local-time Date is an easy and
     * plausible edit, and in a DST zone `+1` becomes 23 hours: the result lands on the same calendar
     * day, so pressing +1 appears to do nothing twice a year.
     */
    expect(addDays("2026-11-11", 1)).toBe("2026-11-12");
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29"); // leap
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01"); // not
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");

    // +3 then +7 composes to +10. This is the gesture today-based buttons could not express, and
    // the reason `DateField` bases its steps on the field rather than on today.
    expect(addDays(addDays("2026-11-11", 3), 7)).toBe("2026-11-21");

    expect(addDays("", 1)).toBe("");
  });

  test("the calendar is Monday-first and always six rows tall", () => {
    /*
     * Six rows regardless of the month is a layout decision with a correctness symptom. Three months
     * sit side by side; if each grid were as tall as its month needs, moving between months would
     * change the popup's height, which moves the day cells under a cursor that is already heading
     * for one. Clicking the wrong deadline is the failure mode, not a cosmetic jump.
     */
    const nov = calendarMonth(2026, 11);
    expect(nov.weeks).toHaveLength(6);
    expect(nov.weeks.every((w) => w.length === 7)).toBe(true);
    expect(nov.title).toBe("2026년 11월");

    // 1 Nov 2026 is a Sunday, so a Monday-first grid puts it in the LAST column of the first row.
    expect(nov.weeks[0]![6]).toBe("2026-11-01");
    expect(nov.weeks[0]!.slice(0, 6).every((d) => d === null)).toBe(true);

    // Days outside the month are blanks, not the neighbouring month's dates - a cell showing 30 Nov
    // inside the December grid is a click that sets a date in the wrong month.
    expect(nov.weeks.flat().filter((d) => d !== null)).toHaveLength(30);
    expect(nov.weeks.flat().filter((d) => d !== null).every((d) => d!.startsWith("2026-11-"))).toBe(
      true,
    );

    // February 2026 starts on a Sunday too and has 28 days - the tightest month, still six rows.
    expect(calendarMonth(2026, 2).weeks).toHaveLength(6);
    expect(calendarMonth(2024, 2).weeks.flat().filter(Boolean)).toHaveLength(29);

    // Month stepping wraps the year in both directions.
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 1, -13)).toEqual({ year: 2024, month: 12 });
  });

  test("an inverted period is clamped toward whichever end was just edited", () => {
    /*
     * Which end moves is the whole rule. Pushing the START past the end drags the end along; pulling
     * the END in front of the start drags the start back. Getting it backwards is invisible in the
     * source and obvious only to the person whose other date just jumped.
     */
    expect(alignPeriod("2026-12-01", "2026-11-01", "start")).toEqual({
      start: "2026-12-01",
      end: "2026-12-01",
    });
    expect(alignPeriod("2026-12-01", "2026-11-01", "end")).toEqual({
      start: "2026-11-01",
      end: "2026-11-01",
    });

    // A period that is already in order is returned untouched, including the equal case - a job that
    // starts and ends on the same day is ordinary and must not be nudged.
    expect(alignPeriod("2026-11-01", "2026-12-01", "start")).toEqual({
      start: "2026-11-01",
      end: "2026-12-01",
    });
    expect(alignPeriod("2026-11-01", "2026-11-01", "end")).toEqual({
      start: "2026-11-01",
      end: "2026-11-01",
    });

    /*
     * A blank end is left blank. Filling it from the start would make someone who entered only a
     * start date save a deadline they never typed - and a deadline is what the overdue colouring,
     * the settlement queue and the PM dashboard all key on.
     */
    expect(alignPeriod("2026-11-01", "", "start")).toEqual({ start: "2026-11-01", end: "" });
    expect(alignPeriod("", "2026-11-01", "end")).toEqual({ start: "", end: "2026-11-01" });
  });
});

describe("date defaults, bulk operations and in-place editing", () => {
  const frontendFile = (...segments: string[]) =>
    readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend", "src", ...segments),
      "utf8",
    );

  /**
   * `tsCode`'s frontend counterpart, and needed here more sharply than on the lambda side.
   *
   * Every module in this section documents the WRONG version of itself by name, because the wrong
   * version is the plausible one: `DateField` explains at length why `<input type="date">` and a
   * today-based `+N` were abandoned, `useRowSelection` explains why the selection is not synced by a
   * `useEffect`, the three form modals quote `?? nowTimeKst()` as the trap being avoided. So a
   * negative assertion against the
   * raw text fails on the explanation - which would push the next person to delete the explanation
   * to get a green run, the one outcome worth less than no test at all.
   *
   * Same text-level limitation as `tsCode`: a `//` inside a string literal is stripped too. These
   * files hold no URLs, and `import` paths use no comment sequences.
   */
  const frontendCode = (...segments: string[]) =>
    frontendFile(...segments)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");

  test("the current-time default uses hourCycle, not hour12", () => {
    /*
     * `hour12: false` and `hourCycle: 'h23'` are not synonyms. `hour12: false` leaves the engine free
     * to pick h23 (0-23) or h24 (1-24), and under h24 midnight formats as `24:00`. `<input
     * type="time">` does not accept `24:00`: it drops the value and the field renders empty. So the
     * wrong option here is a bug that reproduces for one minute a day and is invisible the other
     * 1439 - precisely the kind that gets "cleaned up" to match the `hour12: false` already used by
     * the display formatter above it, which is fine there because it formats for human eyes rather
     * than for an input element.
     */
    const format = frontendCode("shared", "utils", "format.ts");
    const fn = format.slice(format.indexOf("const TIME_KST"), format.indexOf("export function isOverdue"));
    expect(fn).toContain("hourCycle: 'h23'");
    // Scoped to this one formatter. `hour12: false` is correct in the display formatter above it,
    // which formats for human eyes rather than for an `<input>` that validates what it is given.
    expect(fn).not.toContain("hour12");
    expect(format).toContain("hour12: false");
  });

  test("today/now is a create-path default only, branched on the row rather than coalesced", () => {
    /*
     * The request was "default 시작일 to today, at current time" - on NEW items. `project?.prjSdayTime
     * ?? nowTimeKst()` reads as the same thing and is not: a start TIME is nullable and thousands of
     * existing rows have none, so on an EDIT that expression injects the moment the form was opened.
     * Opening a job to fix a typo in its memo and pressing 저장 would then record a start time that
     * never happened, and nothing on screen would say so. Branching on the row object - `job ? ... :
     * ...` - is what keeps "no value" distinguishable from "no value yet".
     *
     * Asserted as the absence of `?? nowTimeKst()` on all three forms because that is the exact edit
     * someone makes when tidying the ternaries into the `??` chains used everywhere else in the same
     * initialiser.
     */
    for (const [file, prefix] of [
      [frontendCode("features", "projects", "ProjectFormModal.tsx"), "prj"],
      [frontendCode("features", "jobs", "JobFormModal.tsx"), "job"],
      [frontendCode("features", "purchaseorders", "PurchaseOrderFormModal.tsx"), "po"],
    ] as const) {
      expect(file).toMatch(new RegExp(`${prefix}Sday: \\w+ \\? toDateInputValue\\([^)]+\\) : todayKst\\(\\)`));
      expect(file).toMatch(new RegExp(`${prefix}SdayTime: \\w+ \\? \\([^)]+ \\?\\? ''\\) : nowTimeKst\\(\\)`));
      expect(file).not.toMatch(/\?\?\s*nowTimeKst\(\)/);
      expect(file).not.toMatch(/\?\?\s*todayKst\(\)/);
    }
  });

  test("the +N buttons count from the field, not from today, and do not submit", () => {
    /*
     * This reverses `DeadlineQuickPick`, which is now deleted. The old assertion here demanded
     * `dateKstOffsetDays(days)` - a TODAY-based base - and justified it by idempotence: two presses
     * of +3 give the same date, so a mispress costs one click.
     *
     * That argument holds only for a button considered alone. The real gesture is "pick a start date
     * in the calendar, then a week from there", and a today-based button cannot express it - if the
     * start date is next month, +7 still points at this week, so the operator abandons the button and
     * reopens the calendar. The idempotent button was safe and unused. Undo is what `today` and the
     * calendar are for, and +3 then +7 composing to +10 is the intended use.
     *
     * `type="button"` survives the reversal unchanged: a button inside a form defaults to submit, so
     * without it pressing +1 saves the record and closes the modal.
     *
     * The empty-field case is the one place today still appears - `+3` on a blank box can only mean
     * "three days from today", and anything else would be a date out of nowhere.
     */
    const field = frontendCode("shared", "ui", "DateField.tsx");
    expect(field).toContain("const DAY_STEPS = [1, 3, 7] as const");
    expect(field).toContain("onChange(addDays(value || todayKst(), days))");
    expect(field).not.toContain("dateKstOffsetDays");
    // Two `type="button"`s per step button is not checkable by count, so assert the attribute sits on
    // the mapped step button specifically.
    expect(field).toMatch(/DAY_STEPS\.map\(\(days\) => \([\s\S]{0,400}?type="button"/);

    // The component it replaced is gone, not merely unused. A dead module that argues the reversed
    // position is worse than no module - the next reader cannot tell which one is current.
    expect(
      readdirSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend", "src", "shared", "ui"),
      ),
    ).not.toContain("DeadlineQuickPick.tsx");

    /*
     * Time is still a separate box, so the date buttons cannot touch it. That was the third claim of
     * the old test (`not.toMatch(/Time/)` on the quick-pick file) and it is now structural rather
     * than textual: `DateField` only ever writes `time.onChange` from the time input and the two
     * o'clock buttons, never from `step()`.
     */
    expect(field).not.toMatch(/step\([^)]*\)[\s\S]{0,80}time\.onChange/);
  });

  test("the three forms clamp the period together, in one state update", () => {
    /*
     * `alignPeriod` pulls the other end along rather than rejecting the inversion. Blocking strands
     * the operator: moving a November period to December means both boxes change, and whichever is
     * edited first produces an inverted period as an intermediate state. Clamping lets that state be
     * passed through; blocking makes it a wall.
     *
     * Each form writes BOTH dates in a single `setForm`. Two sequential `set()` calls would be
     * correct in value - the updater form reads `prev` - but would render once with the inverted
     * pair, which is the exact flicker the clamp exists to remove.
     */
    for (const [file, sday, eday] of [
      ["ProjectFormModal.tsx", "prjSday", "prjEday"],
      ["JobFormModal.tsx", "jobSday", "jobEday"],
      ["PurchaseOrderFormModal.tsx", "poSday", "poEday"],
    ] as const) {
      const dir =
        file === "ProjectFormModal.tsx"
          ? "projects"
          : file === "JobFormModal.tsx"
            ? "jobs"
            : "purchaseorders";
      const code = frontendCode("features", dir, file);
      expect(code).toContain("const next = alignPeriod(start, end, changed)");
      expect(code).toContain(`{ ...prev, ${sday}: next.start, ${eday}: next.end }`);
      // The start box reports itself as the changed end, and vice versa - swapping these two makes
      // the clamp pull the wrong way and is invisible until someone inverts a period.
      expect(code).toContain(`onChange={(v) => setPeriod(v, form.${eday}, 'start')}`);
      expect(code).toContain(`onChange={(v) => setPeriod(form.${sday}, v, 'end')}`);
      /*
       * The two ends of the period sit in one `.datePair` row.
       *
       * Left to `.formGrid`'s auto-fit columns this breaks at three columns wide: an unrelated field
       * lands BETWEEN the start and the end. In the project form that field was 분야, which has its
       * own partner (세부 분야) and got separated from it in the same stroke - one wrong wrap, two
       * pairs broken. Wrapping the dates fixes both, because the pairs after it re-flow together.
       */
      expect(code).toMatch(
        /<div className=\{ui\.datePair\}>[\s\S]{0,1200}?label="시작일"[\s\S]{0,1200}?<\/div>/,
      );
      // No form passes `hint` any more - see the `DATE_INPUT_HINT` reversal below.
      expect(code).not.toContain("DATE_INPUT_HINT");
      // And no native date input survives in any of the three.
      expect(code).not.toContain('type="date"');
    }
  });

  test("the typing hint is a tooltip, and no format template is painted on screen", () => {
    /*
     * Reversal, reported as a bug: "the datetime template yyyy-mm-dd is exposed to the user".
     *
     * It was in two places at once. `DATE_INPUT_HINT` sat beside the label (the spec's placement, on
     * the argument that a label row's spare width is free) and `yyyy-mm-dd` sat in the empty box as a
     * placeholder. Neither is wrong alone; together they read as a leaked internal string rather than
     * as guidance, because the same token appears twice in two different registers.
     *
     * The label slot was not free either. A form column is ~240px, and `시작일` plus three formats
     * wraps - so that one field's label becomes two lines and its input drops a row below the 납기
     * input standing next to it. The period's two ends end up on different baselines, which is most
     * of what "disorganized" meant in the report.
     *
     * `title` keeps the knowledge and costs no layout. It is a learn-once rule, not a per-use one.
     */
    const field = frontendCode("shared", "ui", "DateField.tsx");
    expect(field).toContain("title={DATE_INPUT_HINT}");
    // The placeholder is gone, and so is the label slot that held the other copy.
    expect(field).not.toContain("placeholder=");
    expect(field).not.toContain("labelHint");
    expect(frontendCode("shared", "ui", "ui.module.css")).not.toMatch(/^\.labelHint \{/m);
    // The hint names real example dates now, not a template - a template is what got mistaken for a
    // value. Three of the five accepted shapes; the parser's own test covers all five.
    expect(field).toMatch(/DATE_INPUT_HINT = '[^']*261111[^']*2026-11-11/);
  });

  test("the date field is three fixed rows, not one wrapping row", () => {
    /*
     * The controls used to be a single `flex-wrap: wrap` line of ten-odd items, so where it broke was
     * decided by the text inside them. A filled time box (`오후 12:45`) and an empty one (`--:--`) are
     * different widths, so 시작일 and 납기 - standing side by side, same component - folded at
     * different points and their `+3` buttons landed at different heights. Nothing overflowed and
     * nothing overlapped, which is why it read as untidy rather than as broken.
     *
     * Three rows in the markup (text box / 달력·오늘·+N / time) make the geometry independent of the
     * content, and a 5-column grid makes the step buttons line up between the two fields.
     */
    const field = frontendCode("shared", "ui", "DateField.tsx");
    expect(field).toContain("ui.dateStack");
    expect(field).toContain("ui.dateBtns");
    expect(field).toContain("ui.dateTimeRow");
    // The inline width override on the time box is gone - the row grid sizes it now.
    expect(field).not.toContain("style={{ width: 92");

    const css = frontendCode("shared", "ui", "ui.module.css");
    // `.dateStack` is also the calendar popup's anchor; without `position: relative` the popup
    // measures itself against the modal and lands somewhere else entirely.
    expect(css).toMatch(/\.dateStack \{[^}]*position: relative/);
    // 2026-11-25: '달력' left the row for an icon inside the text box, so the row is 오늘/+1/+3/+7.
    expect(css).toMatch(/\.dateBtns \{[^}]*grid-template-columns: repeat\(4, 1fr\)/);
    expect(field).toContain("className={ui.dateIcon}");
    // No wrapping survives in the date rows. A re-added `flex-wrap` would silently restore the
    // content-dependent breaking this test exists to prevent.
    expect(css).not.toMatch(/\.date\w* \{[^}]*flex-wrap/);
  });

  test("the three months stand side by side, and the popup is measured back inside its clip box", () => {
    /*
     * Reported: "when I click the calendar it shows 3 months vertically... the user needs to scroll".
     *
     * The cause was NOT `.calendarMonths`'s `flex-wrap` - the wrap was doing as it was told. An
     * absolutely-positioned box's default width is shrink-to-fit CAPPED BY ITS CONTAINING BLOCK, and
     * the containing block is `.dateStack`, one ~300px form column. Three 188px months do not fit in
     * 300px, so they folded. Deleting the wrap would have produced a 590px box overflowing a 300px
     * one instead - a different bug with the same root. `width: max-content` is the fix: it ignores
     * the containing block. So the wrap stays, as the narrow-screen fallback `max-width` reaches.
     */
    const css = frontendCode("shared", "ui", "ui.module.css");
    expect(css).toMatch(/\.calendarPop \{[^}]*width: max-content/);
    expect(css).toMatch(/\.calendarPop \{[^}]*max-width: calc\(100vw - 32px\)/);
    // The wrap is deliberately kept. If a later reader deletes it as "the cause", this fails.
    expect(css).toMatch(/\.calendarMonths \{[^}]*flex-wrap: wrap/);

    /*
     * 610px of popup hanging off a 300px anchor overflows one side or the other, and which side
     * cannot be chosen in CSS: `left: 0` is right for 시작일, `right: 0` is right for 납기, and which
     * column a field lands in depends on the modal width (720/820/860) and the live column count.
     * So it is measured. The clip box is found by walking up for a non-`visible` `overflow-x` -
     * the modal body is `overflow-y: auto`, and CSS forces the other axis non-`visible` too, so an
     * over-wide popup grows a HORIZONTAL SCROLLBAR rather than being quietly hidden.
     */
    /*
     * 2026-11-25 (팀장님): the popup is no longer measured back inside the modal's clip box. It is
     * `position: fixed` against the viewport (so the modal body's overflow cannot clip it) and its
     * MIDDLE month is centred on the calendar icon, so the hand travels as little as possible.
     */
    const field = frontendCode("shared", "ui", "DateField.tsx");
    expect(field).toContain("position: 'fixed'");
    expect(field).toContain("data-mid-month={offset === 0 ? '' : undefined}");
    expect(field).toContain("let left = a.left + a.width / 2 - midCenter");
    // Measured before paint: a calendar that shows for a frame and then jumps takes a click on the
    // wrong day. (`useEffect` is used only for the outside-click listener.)
    expect(field).toContain("useLayoutEffect(() => {");
  });

  test("a calendar that does not fit below its field flips above it", () => {
    /*
     * Reported: "the calendar view should show up completely when clicked, without requiring the
     * user to scroll down".
     *
     * Same clip box as the test above, the other axis. The popup sits at `top: calc(100% + 4px)`,
     * so a date field in the lower half of a form opens it below the modal body's floor. This is
     * NOT fixable in CSS, and not for the usual "CSS cannot measure" reason - it is that the floor
     * is not in the CSS at all: `.panel` is `max-height: calc(100vh - 80px)` and `.body` declares
     * no `max-height`, so the same form overflows on a laptop and does not on a large monitor.
     *
     * Hence `clipBox` returns all four edges, and the vertical fit is ordered: fits below -> leave
     * it; fits above -> flip over the field; neither -> pin to the top of the clip box. The flip
     * measures from `offsetParent` (`.dateStack`), which holds the input AND the today/+1/+3/+7
     * row - measuring from the input alone would drop the flipped calendar onto the buttons.
     */
    // 2026-11-25: measured from the calendar icon against the window; below if it fits, else above.
    const field = frontendCode("shared", "ui", "DateField.tsx");
    expect(field).toContain("let top = a.bottom + gap");
    expect(field).toContain("const above = a.top - gap - height");

    /*
     * The last resort is a pair, and the halves live in different files. A popup taller than the
     * clip box (three months folded on a narrow screen) gets an inline `max-height`; without
     * `overflow-y: auto` on the class that `max-height` would CUT the last week off rather than
     * let it scroll. Deleting either half alone loses days silently.
     */
    expect(field).toContain("const maxHeight = box.height > room ? room : undefined");
    expect(frontendCode("shared", "ui", "ui.module.css")).toMatch(
      /\.calendarPop \{[^}]*overflow-y: auto/,
    );
  });

  test("a date that cannot be read keeps the cell open instead of reverting", () => {
    /*
     * `DateTextInput` reports whether the commit parsed, and `InlineDateCell` closes only on success.
     *
     * Without that boolean the cell would close on blur regardless, and `2026-02-30` would vanish:
     * the error message lives inside the cell, so closing takes it away at the same moment, and the
     * cell falls back to rendering the OLD value. Nothing on screen says the edit failed, which reads
     * exactly like a successful save of a date that was never entered.
     *
     * The other half is that the input must not quietly fix the date. Rolling 2026-02-30 forward to
     * 2026-03-02 is what the Date constructor does by default and is the worst available behaviour -
     * it stores a day the user did not type and shows it as success.
     */
    const field = frontendCode("shared", "ui", "DateField.tsx");
    expect(field).toContain("onBlur?: (ok: boolean) => void");
    expect(field).toContain("onBlur?.(commit())");
    expect(field).toContain("onDone?.(commit())");

    const cell = frontendCode("shared", "ui", "InlineEditCell.tsx");
    expect(cell).toContain("if (ok) setEditing(false)");

    /*
     * Scoped to the one function. A bare `/InlineDateCell[\s\S]*?useInlineEdit/` passes through the
     * end of the component and matches `InlineSelectCell` below it, which uses the hook correctly -
     * so the negative assertion would fail on code that is right.
     */
    const dateCell = cell.slice(
      cell.indexOf("export function InlineDateCell"),
      cell.indexOf("export function InlinePickerCell"),
    );
    expect(dateCell.length).toBeGreaterThan(0);
    // The draft, the display text and the parse all live in `DateTextInput`. A second draft here
    // would be a second answer to the same question.
    expect(dateCell).toContain("<DateTextInput");
    expect(dateCell).not.toContain("useInlineEdit");
    expect(dateCell).not.toContain('type="date"');

    /*
     * Escape has to suppress the blur that follows it. Removing a focused input fires blur, and that
     * blur's commit would save the very text Escape just discarded - the same trap `useInlineEdit`
     * documents with its `skip` ref, and a ref for the same reason: a state flag is not visible until
     * the next render.
     */
    expect(field).toContain("const cancelled = useRef(false)");
    expect(field).toContain("if (cancelled.current) return");
  });

  test("an inline-edit cell contributes the same width whether it is being edited or not", () => {
    /*
     * Reported: "when I double click on the items on the table, the width changes as the text
     * changes to an input field".
     *
     * The tables are `table-layout: auto`, which sizes every column from its CELLS' CONTENT. An
     * `<input>`'s intrinsic width comes from its `size` attribute - 20 characters, ~170px, by
     * default - and a `<select>`'s from its LONGEST OPTION. Neither has anything to do with the
     * text that was in the cell a moment earlier, so the column jumps and every column after it
     * shifts with it.
     *
     * `width: 100%` cannot fix this, and the reason is worth keeping: the input is itself one of
     * the contents the browser measures to decide what 100% refers to. It is a circular
     * constraint, and `auto` resolves it in favour of the intrinsic width.
     *
     * The fix is structural. The display text stays IN FLOW and keeps sizing the column; the
     * editor is taken OUT of flow (`position: absolute`), and an absolutely-positioned box
     * contributes nothing to an ancestor's min/max-content size. So the two states are provably
     * identical in what they contribute - not merely close.
     */
    const css = frontendCode("shared", "ui", "ui.module.css");
    expect(css).toMatch(/\.cellSwap \{[^}]*position: relative/);
    expect(css).toMatch(/\.cellSwapEdit \{[^}]*position: absolute/);

    /*
     * `visibility: hidden`, NOT `display: none`. The hidden text is the thing doing the measuring;
     * `display: none` removes it from the box tree and re-creates the identical bug pointing the
     * other way - the column would then collapse to the editor's width on open.
     */
    expect(css).toMatch(/\.cellSwapText \{\s*visibility: hidden/);
    expect(css).not.toMatch(/\.cellSwapText \{[^}]*display: none/);

    /*
     * Both states render the same wrapper. If only the editing branch were wrapped, the wrapper
     * itself (its `position: relative`, its `min-height`) would become a difference between the
     * two states - which is the class of bug being fixed here.
     */
    const cell = frontendCode("shared", "ui", "InlineEditCell.tsx");
    expect(cell).toContain("function CellSwap({");
    expect(cell).toMatch(/<div className=\{ui\.cellSwap\}>/);
    expect(cell).toContain("className={editing ? ui.cellSwapText : undefined}");
    // Three editors, one wrapper. A fourth editor added without it would reintroduce the jump.
    expect(cell.match(/<CellSwap/g)?.length).toBe(3);
  });

  test("the job type is changed from a dialog, and both job tables draw that cell with one function", () => {
    /*
     * Asked: "would it be possible to make the language pair / job type updatable from the table
     * view too?". It is, but not with an in-cell dropdown, for two independent reasons.
     *
     * First, that cell is not one value. A LINGUISTICS job holds TWO (출발어, 도착어); a MICE or IMC
     * job holds one (업무 분류). The number and kind of controls needed depends on the value being
     * edited, which one `<select>` cannot express.
     *
     * Second - and this is why it is a dialog rather than three controls crammed into a cell -
     * leaving LINGUISTICS is IRREVERSIBLE. 물량/단위/단가/할인 are columns of
     * `job_detail_linguistic` (db/012_job_pricing.sql), the server drops that row on a type
     * change (`JobDetailClearOps`), and the job's revenue goes to 0. A cell that saves the moment
     * you pick has nowhere to put that warning.
     */
    const modal = frontendCode("features", "jobs", "JobTypeSwapModal.tsx");
    expect(modal).toContain("export function JobTypeSwapModal");
    expect(modal).toMatch(/losesPricing =\s*\n?\s*wasLinguistic && !linguistic/);

    /*
     * The payload rule, which is the easiest thing in this file to get wrong. MICE and IMC SHARE
     * `job_detail_non_linguistic`, so the server's "clear the leaving type's table" also fires on
     * MICE -> IMC. Sending `{ jobType }` alone there deletes the row and writes nothing back, and
     * the category disappears with no error. Hence: if the type changed, re-send the whole
     * relevant side even when its values did not change.
     */
    expect(modal).toContain("if (typeChanged || (slang.trim() || null) !== (job.jobSlang?.trim() || null))");
    expect(modal).toContain("} else if (typeChanged || (category.trim() || null) !== (job.jobCategory?.trim() || null)) {");

    /*
     * One summary function, two tables. 작업 목록 and 프로젝트 상세 each held their own copy of the
     * same nested ternary; pairs like that get fixed on one side only. The assertion is that the
     * ternary exists in exactly one place - `jobTypeSummary` - so neither view can drift.
     */
    expect(modal).toContain("export function jobTypeSummary");
    for (const [feature, file] of [
      ["jobs", "JobsView.tsx"],
      ["projects", "ProjectDetailView.tsx"],
    ] as const) {
      const view = frontendCode("features", feature, file);
      expect(view).toContain("jobTypeSummary(");
      expect(view).toContain("<JobTypeSwapModal");
      // The cell only OPENS; the dialog owns the mutation. `InlinePickerCell` is that contract.
      expect(view).toContain('title="두 번 눌러 업무 구분 변경"');
      expect(view).not.toMatch(/isLinguistic\((row|job)\.jobType\)/);
    }
  });

  test("a job is assigned to a PM from a dialog, and both job tables say who that is", () => {
    /*
     * `job.job_pm_id` existed, was written by the server and appeared on no screen. That combination
     * is an assignment nobody can see or change: whoever enters a job becomes its PM (the default in
     * `createJob`), the reports group revenue by that column, and neither screen that lists jobs
     * says whose revenue it is going to be.
     *
     * Three things have to hold together.
     */
    const modal = frontendCode("features", "jobs", "JobPmSwapModal.tsx");

    // 1. One component draws the cell, for both tables. The rule `jobTypeSummary` is held to above.
    expect(modal).toContain("export function JobPmName");

    /*
     * 2. The dialog sends the id ALONE. It is opened from a row in a money table, and the reason it
     * exists rather than reusing the form is that the form carries the rate and the two totals; a
     * body that grew a money field here would give that back.
     */
    expect(modal).toContain("input: { jobPmId: nextId }");
    expect(modal).not.toMatch(/jobPrice|coinRate|jobVolume/);

    for (const [feature, file] of [
      ["jobs", "JobsView.tsx"],
      ["projects", "ProjectDetailView.tsx"],
    ] as const) {
      const view = frontendCode("features", feature, file);
      expect(view).toContain("<JobPmName job={");
      expect(view).toContain("<JobPmSwapModal");
      // The cell only OPENS; the dialog owns the mutation. `InlinePickerCell` is that contract.
      expect(view).toContain('title="두 번 눌러 담당 PM 변경"');
      // And neither view reads the name straight off the row: that is how the two cells would drift.
      expect(view).not.toMatch(/\{(row|job)\.jobPmName\}/);
    }

    /*
     * 3. The create form prefills the signed-in user, because the server assigns them when the field
     * is absent. The server's own test of absence is `=== undefined`, not truthiness: the original
     * line conflated the two emptinesses, so clearing the picker sent a falsy `null` and made the
     * person who cleared it the PM of the job that had just told them it had none.
     */
    const form = frontendCode("features", "jobs", "JobFormModal.tsx");
    expect(form).toContain("jobPmId: pm?.id ?? null");
    expect(form).toContain("profile?.staffId");
    expect(tsCode("jobs/NeotmsJobManager.ts")).toContain("input.jobPmId === undefined");
  });

  test("select-all recomputes inside the state updater and selection is an intersection with what is on screen", () => {
    /*
     * Two bugs that only appear under load, both avoided by where the computation sits.
     *
     * `toggleAll` must decide "are all rows already on?" INSIDE `setIds`, from `next`. A boolean
     * captured in the render can be one tick stale - click the header box twice quickly and the
     * second click reads the first click's pre-state, turning select-all into select-none (or the
     * reverse) with no way for the user to tell which happened except by counting checkboxes.
     *
     * `selected` is `rows.filter(...)` at render, not a state array kept in sync by an effect. This
     * screen genuinely destroys rows - bulk delete, 더 보기, filter changes - and an effect runs
     * AFTER a render in which the stale selection was already displayed and the 선택 삭제 button was
     * already clickable. One render is enough.
     */
    const hook = frontendCode("shared", "hooks", "useRowSelection.ts");
    expect(hook).toContain("const selected = useMemo(() => rows.filter((r) => ids.has(r.id)), [rows, ids])");
    expect(hook).toMatch(/setIds\(\([^)]*\) => \{[\s\S]*const everyOn = rows\.length > 0 && rows\.every/);
    expect(hook).not.toContain("useEffect");
  });

  test("bulk runs sequentially and reports partial failure honestly", () => {
    /*
     * `Promise.all` over a thirty-row selection - an ordinary selection size here - is wrong twice
     * over. It would claim thirty of the forty PostgreSQL connections this system has, so one
     * person's one click starves every other screen; and finishing thirty writes at once stacks
     * thirty copies of `JOB_AFFECTS`' five-key invalidation, turning thirty writes into a few hundred
     * reads. Sequential costs wall-clock time that is hidden behind the confirm dialog the user is
     * reading anyway.
     *
     * Not stopping on the first error is the other half. A job with a PO attached is legitimately
     * refused by the server, and three such rows in a selection of ten is a normal Tuesday. Aborting
     * there leaves the seven deletable rows behind and re-pressing the button stops in the same
     * place. So the run completes and the counts are reported - `describeBulk` prints the total even
     * on full success, because "selected 10, did 10" is the sentence that is worth reading.
     */
    const bulk = frontendCode("shared", "utils", "bulk.ts");
    expect(bulk).toContain("for (const item of items)");
    expect(bulk).not.toContain("Promise.all");
    expect(bulk).toMatch(/catch \(error\) \{[\s\S]*failed \+= 1/);
    expect(bulk).toContain("return `${total}건 중 ${result.ok}건을 ${verb}했습니다.");

    /*
     * The view keeps `bulkError` in its own state rather than reading the mutation hook's `error`.
     * react-query's `error` is per-call, so in a ten-row run where row 2 failed and row 10 succeeded
     * the hook has already forgotten the failure by the time the summary appears - the count would
     * say "3건은 실패했습니다" with no reason anywhere on the screen.
     */
    const view = frontendCode("features", "projects", "ProjectDetailView.tsx");
    expect(view).toContain("const [bulkError, setBulkError] = useState<unknown>(null)");
    expect(view).toContain("setBulkError(result.firstError)");
    expect(view).toContain("<ErrorNotice error={bulkError} />");
    // Every bulk path goes through the one confirm-then-run helper; a second hand-rolled loop is how
    // one of them ends up without a confirmation. Five now, not four: bulk approval was added, and
    // it was written as its own loop first - this assertion is what sent it back through `runBulk`.
    expect(view.match(/runSequential\(/g)).toHaveLength(1);
    expect(view.match(/runBulk\(/g)).toHaveLength(5);
  });

  test("a copy keeps the work and the price but not what happened to the original", () => {
    /*
     * The request said the copies "should have the exactly same contents". This is the one place that
     * is deliberately not honoured, and the reason is money.
     *
     * A PO carries records of events: that it was billed on an invoice (`invCode`, `invDt`,
     * `poInvoiceState`) and that the translator was paid (`poMoneyState` and its three companions).
     * Copied verbatim, a PO that has never been sent to anyone is born holding an invoice number it
     * does not appear on - reprint that invoice and the amount doubles, with nothing on the document
     * saying which line is the ghost - and born 정산완료, so money genuinely owed to a translator
     * disappears from the settlement list. That second one fails silently in the direction nobody
     * reports.
     *
     * Everything describing the WORK and its PRICE is copied exactly, `coinRate` included: that field
     * is a settlement flag with a value rather than a rate, so clearing it would set the copy's KRW
     * amount moving with the daily rate - which is not "the same amount".
     */
    const po = frontendCode("features", "purchaseorders", "poDuplicate.ts");
    for (const cleared of ["poStateDt: null", "poInvoiceState: null", "poMoneyDay: null", "poMoneyPrice: null", "poMoneyGubun: null", "invCode: null", "invDt: null"]) {
      expect(po).toContain(cleared);
    }
    expect(po).toContain("poState: PO_STATE_UNAPPROVED");
    expect(po).toContain("poMoneyState: MONEY_STATE_UNPAID");
    expect(po).toContain("poCoinRate: row.poCoinRate");
    /*
     * Approval and invoice ownership are absent from `PurchaseOrderInput` altogether, which is why
     * this mapper cannot leak them even by accident. Asserted so that "the duplicate should carry
     * everything" cannot be answered by widening the input type.
     */
    expect(po).not.toMatch(/poApproved\w*:/);
    expect(po).not.toMatch(/invoiceTranslatorId:/);

    const job = frontendCode("features", "jobs", "jobDuplicate.ts");
    expect(job).toContain("jobState: JOB_STATE_WAITING");
    expect(job).toContain("coinRate: row.coinRate");
    expect(job).toContain("jobPriceSum: row.jobPriceSum");
    // A job's only event is its progress. `jobCode` is not here and cannot be: `JobInput` has none,
    // the server mints it - which is the entire reason a duplicate is not a duplicate code.
    expect(job).not.toContain("jobCode:");
    expect(job).toContain("row.jobName || row.jobCode");

    // '대기' as a literal was already in three places. A drifted copy of a status string does not
    // throw; it makes a filter return nothing and a new row land in the wrong queue.
    expect(frontendFile("apis", "neotms.codes.ts")).toContain("export const JOB_STATE_WAITING = '대기'");
    expect(frontendCode("features", "jobs", "JobFormModal.tsx")).not.toContain("'대기'");
  });

  test("in-place editing sends one field, skips no-ops, and routes the status list through codeOptions", () => {
    /*
     * The edit modal holds every field of a row, including the money ones. Opening it to move a
     * deadline by a day is how a converted amount gets changed by accident, and that is the risk the
     * double-click cells remove: the body is `{ jobEday }` and nothing else, so partial-update
     * semantics make the amounts structurally unable to move.
     *
     * `draft !== value` guards the common gesture of opening a cell and clicking away. Saving there
     * would bump `updatedAt`/`updatedBy` on a row nobody changed, and an audit trail with entries
     * that mean nothing cannot answer the question it exists for.
     *
     * `codeOptions(JOB_STATES, job.jobState)` rather than `JOB_STATES`: operational data holds status
     * values that predate this list, and a `<select>` whose value matches no option displays the
     * first one. The user would see '대기' on a row that says something else and committing anything
     * - or nothing - would write it.
     */
    const cell = frontendCode("shared", "ui", "InlineEditCell.tsx");
    expect(cell).toContain("if (draft !== value) onCommit(draft)");
    expect(cell).toContain("const skip = useRef(false)");
    expect(cell).toContain("onCommit(next || null)");
    expect(cell).not.toContain("useEffect");
    /*
     * The date cell used to be asserted here as `type="date"`. It is now a `DateTextInput`, and the
     * two guarantees this test cares about did not move with it - they were re-derived rather than
     * dropped. `DateTextInput` calls `onChange` only when the parsed date DIFFERS from the one it was
     * given, which is the same no-op skip as `draft !== value`; the one-field body is unchanged
     * because the cell still commits through `onCommit(next || null)` above. The typing rules and the
     * close-on-success behaviour have their own test.
     */
    expect(cell).toContain("<DateTextInput");

    const view = frontendCode("features", "projects", "ProjectDetailView.tsx");
    expect(view).toContain("options={codeOptions(JOB_STATES, job.jobState)}");
    expect(view).toContain("options={codeOptions(PO_STATES, po.poState)}");
    expect(view).toContain("onCommit={(jobState) => patchJob(job, { jobState })}");
    expect(view).toContain("onCommit={(poState) => patchPo(po, { poState })}");

    /*
     * 지급 is the one status-shaped column left as a plain chip, and that asymmetry is the decision.
     * Writing `poMoneyState` alone produces a 정산완료 with no amount, no date and no method: the row
     * leaves the settlement list while no payment record exists anywhere. The server agrees - it
     * takes those four fields together through a separate endpoint - so 지급 goes through the
     * settlement modal only.
     */
    expect(view).toContain("<StatusChip value={po.poMoneyState} />");
    expect(view).not.toMatch(/poMoneyState\s*\}\s*\)/);

    /*
     * Both tables carry a leading checkbox column, the PO table an 승인 column and the job table a
     * 담당 PM one, so the job table is eleven wide and the PO table ten. The invariant itself is
     * asserted for every table in the application by "every table's empty-state spans exactly its
     * own columns" below - this is the local statement of the two numbers, worth having because
     * these are the two tables that keep gaining columns.
     */
    expect(view.match(/colSpan=\{11\}/g)).toHaveLength(1);
    expect(view.match(/colSpan=\{10\}/g)).toHaveLength(1);
    // `indeterminate` is a DOM property with no HTML attribute, so it can only be set through a ref.
    // Without it a partial selection renders as an empty box, and the header reads "nothing selected"
    // while 선택 삭제 is live.
    expect(view.match(/el\.indeterminate = \w+Sel\.someSelected/g)).toHaveLength(2);
  });

  test("the PO document buttons carry the approval gate into every screen that shows them", () => {
    /*
     * The gate is the whole reason this component exists. `PoPaymentView` had blocked printing an
     * unapproved PO with a written rationale - a 발주서 is a document sent OUT to a translator, and an
     * amount nobody approved reads as a promise once it is on paper. The feedback asked for the same
     * 국/영 buttons on the PO list and on 프로젝트 상세, and adding them as plain buttons there would
     * have left the gate standing on one screen out of three.
     *
     * That failure mode is the dangerous shape: nothing breaks, no test goes red, and the warning
     * sentence on the settlement screen quietly becomes false. So the assertion is not "the gate
     * exists" but "no screen reaches printing except through the component that holds it".
     *
     * Checked as the absence of any direct `setPrinting` click handler rather than as the absence of
     * `poApproved`: 결제 reads that flag for its OWN reasons - the 정산 button needs it too, and the
     * 승인/승인 해제 toggle is the thing that writes it - so banning the word there would be a test
     * asserting the wrong fact, and the next person would satisfy it by hiding the flag behind a
     * local alias.
     */
    const buttons = frontendCode("features", "payment", "print", "PoDocButtons.tsx");
    expect(buttons).toContain("const blocked = !po.poApproved");
    expect(buttons).toContain("disabled={disabled || blocked}");
    // The reason must reach the user. A button that does not react is read as broken, and the next
    // report is "the print button is dead" rather than "this PO needs approval".
    expect(buttons).toContain("승인되지 않은 PO는 출력할 수 없습니다.");
    // Two buttons, one per 서식 - the legacy pair of links (PDF_Po_KOR.asp / PDF_Po_ENG.asp) that a
    // single button plus an in-modal dropdown had turned into three clicks.
    expect(buttons).toContain("button(PRINT_LANG_KOR, '국')");
    expect(buttons).toContain("button(PRINT_LANG_ENG, '영')");

    for (const view of [
      frontendCode("features", "payment", "PoPaymentView.tsx"),
      frontendCode("features", "purchaseorders", "PurchaseOrdersView.tsx"),
      frontendCode("features", "projects", "ProjectDetailView.tsx"),
    ]) {
      expect(view).toContain("<PoDocButtons po=");
      expect(view).not.toMatch(/onClick=\{\(\) => setPrinting\(/);
      // And no screen keeps its own copy of the sentence, which is how two wordings drift apart.
      expect(view).not.toContain("출력할 수 없습니다");
    }

    /*
     * `lang` is optional and falls back to `po_lang`. Making it required would have been the tidier
     * signature and would have broken the modal's own rule: when nobody picked a 서식, the PO's own
     * stored letterhead language is the answer, not whichever constant the call site happened to
     * name.
     */
    const modal = frontendCode("features", "payment", "print", "PoPrintModal.tsx");
    expect(modal).toContain("initialLang={lang ?? printLangOf(po.poLang)}");
  });

  test("the translator swap is blocked by approval and by full settlement, but not by a partial one", () => {
    /*
     * Two locks with two different reasons, which is why they are listed separately rather than
     * folded into one "is editable" flag.
     *
     * 승인 writes who approved and when (`po_approved_by`/`po_approved_at`). Swapping the translator
     * underneath that record makes it read as a decision about a payment to someone who was never
     * approved - and the approver is the only person who could notice, on a screen that does not
     * show it.
     *
     * 정산완료 means the money has left. The four payment fields are facts about the person who
     * received it, so a swap turns "paid A" into "B's payment history": B never got it and does not
     * appear in the unpaid list, so nobody files it, while A finds the entry gone.
     *
     * 부분정산 is deliberately allowed. Being replaced after an advance is a real sequence (hand in a
     * first draft, get swapped out), and the remaining balance SHOULD go to the new person. The
     * settlement screen still holds what already went out, so no fact disappears.
     */
    const swap = frontendCode("features", "purchaseorders", "TranslatorSwapModal.tsx");
    expect(swap).toContain("return !po.poApproved && po.poMoneyState !== MONEY_STATE_PAID");
    expect(swap).not.toContain("MONEY_STATE_PARTIAL");

    // The cell and the dialog must agree. A cell that opens on a PO the dialog refuses to save is a
    // dialog whose 저장 button never enables, with nothing on screen explaining why.
    for (const view of [
      frontendCode("features", "purchaseorders", "PurchaseOrdersView.tsx"),
      frontendCode("features", "projects", "ProjectDetailView.tsx"),
    ]) {
      expect(view).toContain("mayChangeTranslator(");
      expect(view).toContain("title={translatorLockReason(");
      expect(view).toContain("<TranslatorSwapModal");
    }

    /*
     * One field in the body. This is the same guarantee the inline cells rely on: the 수정 modal
     * holds the converted amount and the FX rate, so opening it to change a person is how an amount
     * gets changed by accident. `{ translatorId }` makes the amounts structurally unable to move.
     */
    expect(swap).toContain("input: { translatorId: nextId }");
    expect(swap).not.toContain("poCoinCode:");

    /*
     * Two states, not one nullable one. If 'nothing picked yet' and 'clear the assignment' were both
     * `null`, 저장 would be live the moment the dialog opened and that first click would wipe a
     * perfectly good translator.
     */
    expect(swap).toContain("const [clearing, setClearing] = useState(false)");
    expect(swap).toContain("const canSave = (clearing || picked !== null) && changed");
  });

  test("the picker's number keys live on the result list, never on the search box", () => {
    /*
     * The split is the point, not an implementation detail. Translator and job codes are numeric
     * (`TRN_000123`, `JOB_071763`), so digits are among the most common keystrokes IN the search
     * box: intercepting them there would both break code search and - worse - select a row while the
     * user believed they were still typing. On a PO form that silently attaches cost to the wrong
     * job, and both margins are then wrong with nothing on screen saying so.
     *
     * So letters go to the input, numbers to the list, and ArrowDown is the single keystroke that
     * crosses between them.
     */
    const picker = frontendCode("shared", "ui", "RecordPicker.tsx");
    const onInput = picker.slice(picker.indexOf("const onKeyDown"), picker.indexOf("const onResultsKeyDown"));
    expect(onInput).toContain("if (e.key === 'ArrowDown')");
    // No digit handling in the input - the assertion that protects code search.
    expect(onInput).not.toMatch(/e\.key >= '1'/);
    expect(picker).toMatch(/const onResultsKeyDown[\s\S]*?e\.key >= '1' && e\.key <= String\(NUMBERED\)/);

    /*
     * Escape is unusable here. `Modal` listens for it on `document` and is not portaled, so an
     * Escape swallowed by the picker still closes the whole form - the user loses twenty filled
     * fields to a keystroke they expected to clear a search box. ArrowUp from the first row is the
     * way back to the input instead.
     */
    expect(picker).not.toContain("'Escape'");
    expect(picker).toContain("if (at === 0) inputRef.current?.focus()");

    /*
     * Focus is read from the DOM rather than tracked as an index. A separate `activeIndex` goes out
     * of step with a mouse hover the moment both are in play, and the arrow key then appears to jump
     * to a row the user was not on.
     */
    expect(picker).toContain("querySelectorAll<HTMLButtonElement>('button')");
    expect(picker).not.toContain("activeIndex");

    // Single digits only. Two-digit entry cannot work - pressing the first digit has already
    // selected a row - and a wait-for-the-second-key timer would tax everyone picking #1.
    expect(picker).toContain("const NUMBERED = 9");
  });

  test("the project's PO form scopes the job search to that project, on the server", () => {
    /*
     * 프로젝트 상세 grew a PO 추가 button in the PO card header, which means a `JobPicker` opens on a
     * screen where the project is already decided. Left unscoped, a search for a name as common as
     * '번역' returns other projects' jobs, and the person picking reads the results as belonging to
     * the project they are looking at. Picking wrong attaches THIS project's cost to ANOTHER
     * project's revenue - two margins wrong at once, neither screen complaining.
     *
     * The filter must go to the server. Filtering the 20 rows after they arrive means the cap of 20
     * was applied BEFORE the filter, so other projects' jobs occupy the slots and the job being
     * looked for is simply absent from the list.
     */
    const picker = frontendCode("features", "jobs", "JobPicker.tsx");
    expect(picker).toContain("projectId: projectId || undefined");
    expect(picker).not.toMatch(/\.filter\(\([^)]*\) => [^)]*projectId/);

    const view = frontendCode("features", "projects", "ProjectDetailView.tsx");
    expect(view).toContain("jobScopeProjectId={id}");
    /*
     * The row-level 'PO 추가' stays. It opens with the job already fixed, which is faster when the
     * job is the thing being looked at - the two entrances answer different questions.
     */
    expect(view).toContain("fixedJob={poForJob}");
  });

  test("the two create-path defaults branch on the row, and the margin rate keeps its zero case", () => {
    /*
     * Same trap as 시작일, in two more places. `customer?.cusNation ?? DEFAULT_NATION` would write
     * '대한민국' into any existing customer whose 국가 is blank the moment somebody opens the form and
     * presses 저장 - a country nobody verified, indistinguishable from one that was entered. Same for
     * 등록일: coalescing turns `tran_reg_day` into "the last day anyone pressed save", which breaks
     * the already-documented distinction between it and `createdAt`.
     */
    const customer = frontendCode("features", "customers", "CustomerFormModal.tsx");
    expect(customer).toContain("const DEFAULT_NATION = '대한민국'");
    expect(customer).toMatch(/cusNation: customer \? \(customer\.cusNation \?\? ''\) : DEFAULT_NATION/);
    expect(customer).not.toMatch(/\?\?\s*DEFAULT_NATION/);

    const translator = frontendCode("features", "translators", "TranslatorFormModal.tsx");
    expect(translator).toMatch(/tranRegDay: translator \? toDateInputValue\([^)]+\) : todayKst\(\)/);
    expect(translator).not.toMatch(/\?\?\s*todayKst\(\)/);

    /*
     * 수익률 reverses an earlier decision, and the reversal is the thing worth pinning. "마진율은
     * 보여 주지 않는다" was argued from division by zero, which is a reason to handle that one case -
     * not a reason to withhold the number on every project that has revenue.
     *
     * `decimalPercent` returns null for a zero denominator, and that null has to stay a sentence. A
     * `?? 0` there prints 0% on a project with no revenue, which reads as a measured result; a '-'
     * reads as a loading state. Negative rates are not clamped - a project that cost more than it
     * sold is a fact, and hiding the sign is how it stays unnoticed.
     */
    const view = frontendCode("features", "projects", "ProjectDetailView.tsx");
    expect(view).toContain("decimalPercent(margin, revenue.total)");
    expect(view).toContain("매출이 0이라 수익률을 셀 수 없습니다.");
    expect(view).not.toMatch(/marginRate \?\? 0/);
    expect(view).not.toMatch(/Math\.(max|abs)\(marginRate/);
  });
});

/* ========================================================================== */
/* 인계메일 - the handover mail                                               */
/* ========================================================================== */

describe("the handover mail", () => {
  /** A project with every column populated the way the document's example has it. */
  const project = (over: Partial<ProjectRow> = {}): ProjectRow => ({
    id: "1",
    prjCode: "PRJ_028961",
    prjName: "메타바이오메드 사용설명서",
    corpId: null,
    coinCode: null,
    prjMgrId: null,
    prjMgrName: "조선미",
    prjPmId: null,
    prjPmName: "김재윤",
    customerId: null,
    cusCodeName: "메타바이오메드",
    customerContactId: null,
    cusMgrName: "이성준 대리",
    prjField: null,
    prjField2: null,
    prjState: null,
    prjInvoiceState: null,
    prjMoneyState: null,
    invCode: null,
    invDt: null,
    prjSday: null,
    prjSdayTime: null,
    prjEday: null,
    prjEdayTime: null,
    prjContent: null,
    // Assigned and unanswered, which is what every project starts as. Nothing in the handover mail
    // reads it; it is here because `ProjectRow` requires it.
    acceptanceStatus: 0,
    createdAt: null,
    updatedAt: null,
    ...over,
  });

  const job = (over: Partial<HandoverJob> = {}): HandoverJob => ({
    jobName: "문서명",
    jobType: "LINGUISTICS",
    jobSlang: "한국어",
    jobElang: "영어",
    jobPmName: null,
    jobEday: null,
    jobEdayTime: null,
    ...over,
  });

  const ALL = { formats: HANDOVER_FORMATS, layouts: HANDOVER_LAYOUTS, note: "" } as const;
  const WORD = { formats: ["WORD"], layouts: ["보기좋게"], note: "" } as const;

  test("the subject is 고객사 / 담당자 / 언어, with the blank 담당자 left out rather than left in", () => {
    /*
     * The handover spec: "the customer, the contact and the languages go in". The contact is
     * deliberately blank for now (the request said so), and joining three parts with " / "
     * regardless would produce `Acme /  / ko-en` - which reads as a subject with a word
     * missing rather than as a field left empty on purpose.
     *
     * The subject separates the pair with `-` and the body with ` → `. That is not an
     * inconsistency waiting to be tidied: the document specifies the two separators separately,
     * for the two places.
     */
    const mail = composeHandoverMail(project(), [job()], WORD);
    expect(mail.subject).toBe("메타바이오메드 / 한국어-영어");
    expect(mail.subject).not.toContain(" /  / ");
    // The contact cell still exists in the body, empty. "Not recorded" and "this project has no
    // contact" are different statements, and only the empty cell makes the first one.
    expect(mail.html).toContain("거래처 / 담당자");
    expect(mail.html).not.toContain("이성준");
  });

  test("a subject never comes out blank, even with no customer and no languages", () => {
    // A mail with no subject cannot be found in an inbox afterwards. Falls back to the project
    // name, then to the code - which always exists, being minted from a sequence.
    expect(composeHandoverMail(project({ cusCodeName: null }), [], WORD).subject).toBe(
      "메타바이오메드 사용설명서",
    );
    expect(
      composeHandoverMail(project({ cusCodeName: null, prjName: null }), [], WORD).subject,
    ).toBe("PRJ_028961");
  });

  test("four or more target languages collapse to 다국어 in the subject but not in the body", () => {
    /*
     * "when there are four or more target languages, write the target as multilingual" - and
     * that bullet sits under the SUBJECT LINE heading, which is why the body keeps the full
     * list. The subject is for finding the mail later; the body is for doing the work, and
     * nobody can plan from one collapsed word.
     *
     * Both sides of the boundary are pinned. Reading "four or more" as "more than four" is the
     * off-by-one this catches, and it would only ever be noticed by someone counting languages in
     * a sent mail.
     */
    const three = ["영어", "일본어", "중국어(간체)"].map((t) => job({ jobElang: t }));
    expect(composeHandoverMail(project(), three, WORD).subject).toBe(
      "메타바이오메드 / 한국어-영어, 일본어, 중국어(간체)",
    );

    const mail = composeHandoverMail(project(), [...three, job({ jobElang: "베트남어" })], WORD);
    expect(mail.subject).toBe("메타바이오메드 / 한국어-다국어");
    expect(mail.html).toContain("한국어 → 영어, 일본어, 중국어(간체), 베트남어");
    expect(mail.html).not.toContain("다국어");
  });

  test("the language list is deduplicated and skips the jobs that have no language at all", () => {
    /*
     * Five documents translated from one language into another is one language pair, not five.
     * A project shaped like that is ordinary, and listing the pair five times makes the
     * subject unreadable.
     *
     * MICE and IMC jobs are skipped outright. They have no `job_detail_linguistic` row, so both
     * columns are null; counting them would add an empty pair and the language cell would start
     * with a comma.
     */
    const jobs = [
      job(),
      job({ jobName: "문서명 2" }),
      job({ jobType: "MICE", jobSlang: null, jobElang: null }),
      job({ jobType: "IMC", jobSlang: null, jobElang: null }),
    ];
    expect(composeHandoverMail(project(), jobs, WORD).subject).toBe("메타바이오메드 / 한국어-영어");
    expect(languageGroups(jobs)).toEqual([{ source: "한국어", targets: ["영어"] }]);
  });

  test("a job with only one side of its pair contributes that side, not a '?'", () => {
    /*
     * The report's `langPair` writes `? > ?` because an aggregate needs a bucket for the unset
     * case (db/011_job_types.sql). A mail is read by a person instead, so it prints what is known
     * and nothing where nothing is - the same choice `jobTypeSummary` makes on screen. The mail
     * and the screen calling one job by one name is worth more here than the mail and the report
     * doing so.
     */
    const mail = composeHandoverMail(project(), [job({ jobElang: null })], WORD);
    expect(mail.subject).toBe("메타바이오메드 / 한국어");
    expect(mail.html).not.toContain("?");
  });

  test("the weekday is computed in UTC, so it does not slip a day in KST", () => {
    /*
     * THE timezone bug available here. `new Date("2026-11-13")` is UTC midnight; asking it for a
     * LOCAL weekday in a zone behind UTC answers Thursday. Lambda runs in UTC and so does CI, so
     * the broken version is green everywhere except in the mail the PM actually reads.
     *
     * 2026-11-13 is a Friday and 2026-11-16 a Monday - the two dates the document's own examples
     * use, so a failure here can be checked against the source document rather than a calendar.
     */
    expect(composeHandoverMail(project({ prjEday: "2026-11-13" }), [], WORD).html).toContain(
      "11/13 (금)",
    );
    expect(composeHandoverMail(project({ prjEday: "2026-11-16" }), [], WORD).html).toContain(
      "11/16 (월)",
    );
  });






  test("담당PM is the jobs' PMs, and the project's PM only when no job names one", () => {
    /*
     * "for the PM cell, list the PM names from the selected items, separated by commas". A
     * handover happens per job, so the people receiving the work are the job PMs; the project
     * header's single PM answers a different question - who owns the project.
     */
    const assigned = composeHandoverMail(
      project(),
      [job({ jobPmName: "이현정" }), job({ jobPmName: "서기쁨" }), job({ jobPmName: "이현정" })],
      WORD,
    );
    expect(assigned.html).toContain("이현정, 서기쁨");
    expect(assigned.html).not.toContain("김재윤");
    expect(composeHandoverMail(project(), [job()], WORD).html).toContain("김재윤");
  });



  test("the deadline is the project's, on a twelve-hour clock, with one meridiem filled in", () => {
    /*
     * The official form has ONE date cell and two meridiem cells. That is the shape the company
     * works to, so the project's own deadline is what goes in it - the earlier template worked a
     * deadline out per language from the jobs, which does not fit the form and is not what it asks
     * for.
     *
     * The meridiem is NOT repeated inside the date. It has two cells of its own and one of them is
     * filled in; printing it twice would be the only thing on the form that says one fact in two
     * places, and two places can disagree.
     */
    const mail = composeHandoverMail(
      project({ prjEday: "2026-11-13", prjEdayTime: "15:00:00" }),
      [job({ jobEday: "2026-11-20" })],
      WORD,
    );
    expect(mail.html).toContain("11/13 (금) 3:00");
    expect(mail.html).not.toContain("11/20");
    expect(mail.html).not.toMatch(/3:00[^<]*오후/);
    // Afternoon is filled in, morning is not.
    expect(mail.html).toMatch(/background:#92d050[^>]*>오후</);
    expect(mail.html).toMatch(/background:#ffffff[^>]*>오전</);

    // Midnight and noon are the two the modulo gets wrong if it is written carelessly.
    const midnight = composeHandoverMail(
      project({ prjEday: "2026-11-13", prjEdayTime: "00:30:00" }),
      [],
      WORD,
    );
    expect(midnight.html).toContain("11/13 (금) 12:30");
    expect(midnight.html).toMatch(/background:#92d050[^>]*>오전</);
    const noon = composeHandoverMail(
      project({ prjEday: "2026-11-13", prjEdayTime: "12:00:00" }),
      [],
      WORD,
    );
    expect(noon.html).toContain("11/13 (금) 12:00");
    expect(noon.html).toMatch(/background:#92d050[^>]*>오후</);
  });

  test("a missing delivery time fills in neither meridiem", () => {
    /*
     * A time nobody recorded must not be asserted. The form would read as an agreement that the
     * afternoon was agreed, and nothing on it would say otherwise.
     */
    const mail = composeHandoverMail(project({ prjEday: "2026-11-13" }), [], WORD);
    expect(mail.html).toContain("11/13 (금)");
    expect(mail.html).toMatch(/background:#ffffff[^>]*>오전</);
    expect(mail.html).toMatch(/background:#ffffff[^>]*>오후</);
    // Two filled cells in the whole mail: the chosen format and the chosen layout.
    expect(mail.html.match(/background:#92d050/g) ?? []).toHaveLength(2);
  });

  test("every option is drawn and only the chosen ones are filled in", () => {
    /*
     * The form lists all four formats and all three layouts and fills in the chosen ones, in the
     * green the official template uses. Printing only the chosen ones would leave a cell reading
     * "WORD", which cannot be told from a form on which the alternatives were never offered.
     */
    const mail = composeHandoverMail(project(), [job()], {
      formats: ["HWP"],
      layouts: ["DTP"],
      note: "",
    } as const);
    for (const option of [...HANDOVER_FORMATS, ...HANDOVER_LAYOUTS]) {
      expect(mail.html).toContain(`>${option}</td>`);
    }
    expect(mail.html).toMatch(/background:#92d050[^>]*>HWP</);
    expect(mail.html).toMatch(/background:#92d050[^>]*>DTP</);
    expect(mail.html).toMatch(/background:#ffffff[^>]*>WORD</);

    expect(composeHandoverMail(project(), [job()], ALL).html.match(/background:#92d050/g) ?? [])
      .toHaveLength(7);
  });

  test("경로 carries the project notes; 기타요청 carries what the sender typed", () => {
    /*
     * The two swapped places when the official form arrived. The form has a 경로 row that the
     * project notes belong in, and a 기타요청 row the sales manager fills in as they send - which
     * is why the dialog grew a box for it.
     *
     * Both are escaped. A closing cell tag in either would end the cell early and shift every
     * later value one column left: a mail that looks fine and puts real values under the wrong
     * labels. The notes come from a form field and the remark is typed into this dialog, so both
     * are text somebody can choose.
     */
    const mail = composeHandoverMail(
      project({ prjContent: "\\\\nas01\\\\프로젝트\\n2종" }),
      [job()],
      { formats: ["WORD"], layouts: ["보기좋게"], note: "<b>급건</b></td><td>주입" } as const,
    );
    expect(mail.html).toContain("경로");
    expect(mail.html).toContain("2종");
    expect(mail.html).toContain("&lt;b&gt;급건&lt;/b&gt;&lt;/td&gt;&lt;td&gt;주입");
    expect(mail.html).not.toContain("<b>급건</b>");
  });

  test("an empty 기타요청 leaves the row in place, blank", () => {
    /*
     * Most handovers have nothing to add, so empty is the ordinary case rather than a failure -
     * the dialog does not require it. The ROW still has to be drawn: a reader who finds it missing
     * cannot tell whether nothing was asked for or whether the template is broken.
     */
    const mail = composeHandoverMail(project(), [job()], WORD);
    expect(mail.html).toContain("기타요청");
    expect(mail.html.match(/기타요청/g) ?? []).toHaveLength(1);
  });

  test("the official form's grid holds together: seven columns on every row", () => {
    /*
     * The company's template is seven columns wide - six that carry the form and a 1px spacer the
     * Word export leaves on every row. A row that does not add up makes the client guess widths
     * and the form comes out as a staircase, borders present and verticals not lining up.
     *
     * Borders are uniform with `border-collapse: collapse` rather than the source's per-side
     * `border-style: none solid solid none`. That trick only holds if every cell agrees, and the
     * source's `border-color: windowtext` is a Word-ism no mail client resolves.
     */
    const html = composeHandoverMail(project(), [job()], ALL).html;
    expect(html).not.toContain("<style");
    expect(html).not.toContain("windowtext");
    expect(html).toContain("border-collapse:collapse");
    expect(html.match(/<col style="width:\d+px">/g) ?? []).toHaveLength(7);

    const rows = html.match(/<tr>[\s\S]*?<\/tr>/g) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(13);
    for (const row of rows) {
      const cells = [...row.matchAll(/<td style="[^"]*"(?: colspan="(\d+)")?(?: rowspan="(\d+)")?>/g)];
      expect(cells.length).toBeGreaterThan(0);
      const width = cells.reduce((sum, c) => sum + Number(c[1] ?? 1), 0);
      // 7 on a full row; less where a cell above it spans down through this one.
      expect(width).toBeLessThanOrEqual(7);
    }
  });

  test("the two option lists are the same on both sides of the wire", () => {
    /*
     * The server's picklist is built from `HANDOVER_FORMATS` / `HANDOVER_LAYOUTS`, so an option the
     * console offers and the server does not know is a 400 the user cannot act on, and one the
     * server accepts and the console does not offer is unreachable. The two live in different build
     * outputs and nothing reconciles them at runtime, so this is the reconciliation.
     */
    const types = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "frontend",
        "src",
        "apis",
        "neotms.types.ts",
      ),
      "utf8",
    );
    expect(types).toContain(
      `export const HANDOVER_FORMATS = [${HANDOVER_FORMATS.map((f) => `'${f}'`).join(", ")}] as const`,
    );
    expect(types).toContain(
      `export const HANDOVER_LAYOUTS = [${HANDOVER_LAYOUTS.map((l) => `'${l}'`).join(", ")}] as const`,
    );
  });

  test("the route is declared on the project menu's read action, and stamps no audit columns", () => {
    /*
     * `PROJECT:read` rather than `update`, which looks wrong for an endpoint that sends mail and is
     * argued at length in NeotmsHandoverManager's header: everything leaving the server is already
     * readable by this caller, the project passes the same row scope a GET does, and the mail goes
     * out through the CALLER'S OWN Hiworks account. It replaces a clipboard copy, which needed no
     * authority beyond being able to look at the screen.
     *
     * The absent `writeContext` is the other half of the same claim. No row changes, so there is no
     * `created_by` to stamp, and stamping one would assert a record exists that does not.
     */
    const source = lambdaSource("neotms.handler.ts");
    const route = source
      .split("\n")
      .find((line) => line.includes("handleSendHandoverMail") && line.includes("path:"));
    expect(route).toContain('method: "POST"');
    /*
     * `PROJECT_EMAIL`, not `PROJECT_READ`, which is what this borrowed while the permission model
     * was a menu x action matrix with nothing finer to say. The mail carries the customer, the
     * languages, the deadline and the project's notes to an address the sender types; "may open
     * this project" was never the same decision, and now it does not have to be.
     */
    expect(route).toContain("permission: NEOTMS_PERMISSION_PROJECT_EMAIL");
    expect(route).toContain("/handover-mail");

    const block = /const handleSendHandoverMail[\s\S]*?\n};/.exec(source)?.[0] ?? "";
    expect(block).not.toBe("");
    expect(block).toContain("callerOf(request)");
    expect(block).not.toContain("writeContext");
  });

  test("the Hiworks credentials are never stored, logged or echoed", () => {
    /*
     * The one thing in this feature that would be unforgivable to get wrong. Somebody types their
     * own Hiworks password into a form; it may reach Hiworks and nowhere else.
     *
     * Four places it could leak, each asserted rather than trusted: the manager must not log it or
     * put it in a response body, the response must carry only the subject and the recipient, the
     * console must not persist it, and the composer must never see it at all - `composeHandoverMail`
     * takes the two option arrays and nothing else, so the credentials cannot reach the HTML even
     * by accident.
     */
    const manager = tsCode("handover/NeotmsHandoverManager.ts");
    expect(manager).toContain("hiworksLogin(input.hiworksId, input.hiworksPassword)");
    expect(manager).not.toMatch(/console\.(log|error|warn|info)/);
    expect(manager).not.toMatch(/body:[^\n]*hiworks(Id|Password)/);
    expect(manager).toContain("ok({ subject: mail.subject, recipient: input.recipient })");
    expect(tsCode("handover/NeotmsHandoverMail.ts")).not.toContain("hiworks");

    const modal = readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        "frontend",
        "src",
        "features",
        "projects",
        "HandoverMailModal.tsx",
      ),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");
    expect(modal).not.toContain("localStorage");
    expect(modal).not.toContain("sessionStorage");
    // The success notice names the subject and the recipient. Not the ID, and not the password.
    expect(modal).toContain("onSent(`${sent.recipient} 로 인계메일을 보냈습니다");
    expect(modal).not.toMatch(/onSent\([^)]*hiworks/i);
  });

  test("the Hiworks client sits inside the typecheck gate, not in the LPX base code", () => {
    /*
     * It arrived in `lambdas/common/layers/nodejs/hiworks/`. `tsconfig.app.json` EXCLUDES
     * `lambdas/common` on purpose - that tree is LPX base code importing SDK packages this project
     * does not install, and it must not be able to block a NEOTMS deploy. A NEOTMS-only file left
     * there would be re-synced away the next time that base code is refreshed, and this feature
     * would go with it.
     */
    const appConfig = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "tsconfig.app.json"),
      "utf8",
    );
    expect(appConfig).toContain('"lambdas/common"');
    expect(() => lambdaSource("handover/HiworksClient.ts")).not.toThrow();
    expect(tsCode("handover/NeotmsHandoverManager.ts")).toContain('from "./HiworksClient.js"');
  });
});

/* ========================================================================== */
/* Bulk PO approval, and the required-field marker                            */
/* ========================================================================== */

describe("approving purchase orders in bulk", () => {
  const frontendFile = (...segments: string[]) =>
    readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "frontend", "src", ...segments),
      "utf8",
    );

  /** Comments stripped, so a rule explained in prose cannot satisfy an assertion about code. */
  const frontendCode = (...segments: string[]) =>
    frontendFile(...segments)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\/\/[^\n]*/g, " ");

  const payment = () => frontendCode("features", "payment", "PoPaymentView.tsx");
  const project = () => frontendCode("features", "projects", "ProjectDetailView.tsx");

  test("both screens get the rule from one module instead of restating it", () => {
    /*
     * The payment desk approves POs filtered across every project; the project screen approves the
     * POs of one project. Same act on the same rows, so the skip rule and the wording have to be
     * the same - and two copies of a wording are two things, one of which gets corrected.
     *
     * Asserted as "imports it AND does not contain the rule inline": an import that is present
     * while a second implementation sits beside it is the drift this is meant to prevent.
     */
    for (const source of [payment(), project()]) {
      expect(source).toContain("unapprovedOf");
      expect(source).toContain("approvalPrompt");
      expect(source).toContain("poBulkApprove");
      // The filter itself must live in the shared module, not be re-derived per screen.
      expect(source).not.toMatch(/filter\(\s*\(\w+\)\s*=>\s*!\w+\.poApproved/);
    }
    const shared = frontendCode("features", "payment", "poBulkApprove.ts");
    expect(shared).toContain("export function unapprovedOf");
    expect(shared).toContain("rows.filter((row) => !row.poApproved)");
  });

  test("the bulk run skips rows that are already approved", () => {
    /*
     * `PATCH /purchase-orders/:id/approval` is idempotent, so re-approving is harmless on the
     * server and it would have been easier to send the whole selection. Two reasons not to.
     *
     * The bulk helper is SEQUENTIAL because this system's PostgreSQL connection budget is small
     * (see `runSequential`), so requests that change nothing are paid for in the one resource that
     * is actually scarce. And the summary afterwards counts what it sent - approving thirty rows of
     * which twenty-eight were already approved would report "30건을 승인했습니다", which is a
     * sentence about work that did not happen.
     */
    for (const source of [payment(), project()]) {
      expect(source).toMatch(/const pending = unapprovedOf\(\w+\.selected\)/);
      expect(source).toMatch(/pending\.length === 0/);
      expect(source).toContain("ALL_ALREADY_APPROVED");
      /*
       * What is confirmed, run and reported is the FILTERED list, never the raw selection - the
       * count in the prompt has to be the count that changes. Both screens hand `pending` to their
       * confirm-then-run helper, which derives the summary from the list it was given.
       */
      expect(source).toMatch(/runBulk\(\s*pending,/);
      expect(source).toMatch(/approvalPrompt\(pending, \w+\.selected\.length\)/);
      expect(source).toMatch(/'승인',/);
    }
  });

  test("the prompt states the money, and the amount-less rows are not counted as zero", () => {
    /*
     * Approval is the moment an amount becomes payable, and "12건을 승인할까요?" could be twelve
     * thousand won or twelve million. A PO with no amount is still approvable - the payment screen
     * explains why it does not block those - but it must not quietly shrink the total the approver
     * is agreeing to, so `decimalSum`'s skipped count is reported rather than folded in.
     */
    const shared = frontendCode("features", "payment", "poBulkApprove.ts");
    expect(shared).toContain("decimalSum(");
    expect(shared).toContain("krwToShow(row.poPriceKrw, row.poPriceKsum)");
    expect(shared).toContain("formatMoney(total)");
    expect(shared).toContain("skipped > 0");
    // And it says how many were left alone, so the two counts in the summary are explainable.
    expect(shared).toContain("alreadyDone");
  });

  test("there is no bulk UN-approve", () => {
    /*
     * Revoking approval can invalidate a PO document already sent to a translator, which is why
     * the single-row version asks first. A button that does it to a whole selection is the one
     * direction of this feature that should stay one-at-a-time.
     */
    for (const source of [payment(), project()]) {
      expect(source).not.toContain("승인 해제 선택");
      expect(source).not.toMatch(/runSequential\([^)]*approved: false/);
    }
    // The single-row toggle on the payment screen still exists, and still confirms.
    expect(payment()).toMatch(/approved: next/);
  });

  test("approving is gated on PAYMENT and deleting on PURCHASE_ORDER, on both screens", () => {
    /*
     * The split the route table makes: raising and editing a PO is PURCHASE_ORDER, signing off what
     * it costs is PAYMENT. Reading `mayUpdatePo` for the approve button would hand every PM the
     * authority the approval gate exists to withhold, and it would look right.
     *
     * The delete button is the mirror image - a payment clerk may approve an amount without
     * thereby being able to destroy the order it was for.
     */
    /*
     * Approval is its own permission now. It used to borrow the payment menu's `update` bit, which
     * is also what records a payment - so "may sign off an amount" and "may confirm the money
     * left" could not be told apart. Deleting the order it was for is a third thing again, and
     * still belongs to whoever owns purchase orders.
     */
    expect(project()).toContain("mayApprovePo = may(profile, NEOTMS_PERMISSION_PO_APPROVE)");
    expect(payment()).toContain("mayWrite = may(profile, NEOTMS_PERMISSION_PO_APPROVE)");
    expect(payment()).toContain("mayDelete = may(profile, NEOTMS_PERMISSION_PO_DELETE)");
    // The buttons read those flags, not each other's.
    expect(project()).toMatch(/poSel\.selected\.length > 0 && mayApprovePo/);
    expect(payment()).toMatch(/sel\.selected\.length > 0 && mayDelete/);
  });

  test("the payment table gained a checkbox column and its colSpan kept up", () => {
    /*
     * A `colSpan` that disagrees with the header count is invisible until the table is empty, and
     * then the "no rows" message sits under the wrong width. Counted from the source rather than
     * trusted, because adding a column is exactly when this gets forgotten.
     */
    const source = payment();
    const thead = /<thead>([\s\S]*?)<\/thead>/.exec(source)?.[1] ?? "";
    expect(thead).not.toBe("");
    expect((thead.match(/<th[\s/>]/g) ?? []).length).toBe(10);
    expect(source).toContain("colSpan={10}");
    expect(source).toContain('aria-label="PO 전체 선택"');
    expect(source).toContain("el.indeterminate = sel.someSelected");
  });

  test("the project screen shows the approval state it now lets you change", () => {
    /*
     * The 선택 승인 button went onto a table that had no approval column, which would have made the
     * action blind in both directions: nothing says which of the selected rows it will change, and
     * nothing afterwards says it did. The chip is the same one the payment screen uses.
     */
    const source = project();
    const thead = /<thead>([\s\S]*?)<\/thead>/g;
    const poHead = [...source.matchAll(thead)].at(-1)?.[1] ?? "";
    expect(poHead).toContain("승인");
    expect(source).toContain("<ApprovalChip approved={po.poApproved} />");
    /*
     * Ten, not eleven: PO명 was removed from every screen after the feedback that nobody needed it
     * (the column and the API field stay, and the form sends null). The `colSpan` is asserted
     * against the header count rather than as a second literal, so the two cannot drift - which is
     * how the jobs table came to span eleven columns of ten for as long as it did.
     */
    const poColumns = (poHead.match(/<th[\s/>]/g) ?? []).length;
    expect(poColumns).toBe(10);
    expect(source).toContain(`colSpan={${String(poColumns)}}`);
    expect(poHead).not.toContain("PO명");
  });
});

describe("the required-field marker", () => {
  const frontendSrc = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "frontend",
    "src",
  );

  /** Every .tsx under frontend/src. */
  const tsxFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return tsxFiles(full);
      return entry.name.endsWith(".tsx") ? [full] : [];
    });

  test("the asterisk comes from the stylesheet, and never also from the label text", () => {
    /*
     * `.required::after` emits " *" in the danger colour. Some labels also carried a literal `*`
     * inside a `<span className={ui.required}>`, which rendered BOTH - the span's own text in the
     * inherited colour, then the pseudo-element's in red. Two asterisks, one black and one red,
     * on the same field.
     *
     * Either half would have worked on its own; what cannot stand is both, and "both" is what you
     * get by copying a label from a screen that was written before the rule existed. So the rule is
     * pinned from both ends: the stylesheet owns the mark, and no element carrying the class may
     * contain one.
     */
    const css = readFileSync(path.join(frontendSrc, "shared", "ui", "ui.module.css"), "utf8");
    expect(css).toMatch(/\.required::after\s*\{[^}]*content:\s*' \*'/);

    const offenders: string[] = [];
    for (const file of tsxFiles(frontendSrc)) {
      const source = readFileSync(file, "utf8");
      // An element that carries `required` in its className and an asterisk in its own text.
      if (/className=\{[^}]*required[^}]*\}[^>]*>\s*\*/.test(source)) {
        offenders.push(path.relative(frontendSrc, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the marker is carried by the label element itself", () => {
    /*
     * The settled shape, so the next form copies something consistent: `ui.required` is one of the
     * label's classes. The alternative - an empty marker span beside the text - renders the same
     * but puts the class somewhere a reader has to go looking for it.
     */
    const offenders: string[] = [];
    for (const file of tsxFiles(frontendSrc)) {
      // Comments stripped: a comment explaining why a field does NOT carry the class names
      // it too, and a test that cannot tell the two apart would push the next person to
      // delete the explanation to get a green run.
      const source = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ");
      for (const line of source.split("\n")) {
        if (!line.includes("ui.required")) continue;
        if (!/<(label|span)\s/.test(line)) offenders.push(`${path.basename(file)}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("Mailgun (system mail)", () => {
  test("only the API function may read the Mailgun secret, and only that one secret", () => {
    /*
     * Same shape as the KEXIM grant above, mirrored: the API sends mail, the fetcher does not.
     * `-??????` names exactly one secret; a `*` would also match `neotms/mailgun-old`.
     */
    const policies = synth().findResources("AWS::IAM::Policy");
    const forApi: string[] = [];
    const forOthers: string[] = [];
    for (const [name, resource] of Object.entries(policies)) {
      const statements = (
        resource as { Properties: { PolicyDocument: { Statement: unknown[] } } }
      ).Properties.PolicyDocument.Statement;
      const text = JSON.stringify(statements);
      if (!text.includes("mailgun")) continue;
      (name.startsWith("Api") ? forApi : forOthers).push(text);
    }
    expect(forApi).toHaveLength(1);
    expect(forOthers).toEqual([]);
    expect(forApi[0]).toContain("secret:neotms/mailgun-??????");
    expect(forApi[0]).not.toContain("mailgun*");
    // And the dev stage grants its own secret, not production's.
    const devText = JSON.stringify(synth("dev").findResources("AWS::IAM::Policy"));
    expect(devText).toContain("secret:neotms-dev/mailgun-??????");
    expect(devText).not.toContain("secret:neotms/mailgun-");
  });

  test("neither the key nor the domain is an environment variable", () => {
    /*
     * Both live in the secret. The domain used to be `NEOTMS_MG_EMAIL_DOMAIN`; it moved into the
     * secret so the key and the domain it belongs to are always rotated and copied together.
     */
    for (const resource of Object.values(synth("dev").findResources("AWS::Lambda::Function"))) {
      const env =
        (resource as { Properties: { Environment?: { Variables: Record<string, unknown> } } })
          .Properties.Environment?.Variables ?? {};
      for (const key of Object.keys(env)) {
        if (!/MG_|MAILGUN/i.test(key)) continue;
        expect(key).toBe("NEOTMS_MG_SECRET_NAME");
        expect(env[key]).toBe("neotms-dev/mailgun");
      }
    }
    expect(Object.keys(NEOTMS_CONFIGS.dev.mail)).not.toContain("mailgunEmailDomain");
  });
});
