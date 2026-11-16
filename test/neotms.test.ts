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
  deadlines,
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
  return [...sql("003_indexes.sql").matchAll(pattern)].map((m) => ({
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

  for (const raw of sql("002_tables.sql").split(/\r?\n/)) {
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
    expect(sql("003_indexes.sql")).not.toMatch(/gin_bigm_ops|pg_bigm/);
    expect(sql("001_extensions.sql")).toContain("CREATE EXTENSION IF NOT EXISTS pgroonga");
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
      ...sql("003_indexes.sql").matchAll(/USING\s+(?:pgroonga|gin)\s*\([^)]*?\s+(\w+_ops\w*)\s*\)/gi),
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

  test("the session table expires rows by TTL", () => {
    // TTL is the only thing that deletes a session record. If the attribute name here and the one
    // the ops module writes ever diverge, sessions accumulate forever and nothing visibly breaks.
    synth().hasResourceProperties("AWS::DynamoDB::GlobalTable", {
      TimeToLiveSpecification: { AttributeName: "NTTTL", Enabled: true },
    });
  });
});

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
const sqlCode = (file: string) =>
  sql(file)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");

describe("the empty-database bootstrap", () => {
  test("every menu the API gates permissions on is seeded", () => {
    /*
     * The coupling this guards is invisible and total. `hasPermission` refuses any menu id the
     * role's matrix has no row for, and `sys_role_grant_all_menus` builds that matrix by iterating
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
      ["006_bootstrap.sql", "008_admin.sql", "013_dashboard_menus.sql", "015_payment.sql"].flatMap(
        (file) => [...sqlCode(file).matchAll(/^\s*\('([A-Z_]+)',/gm)].map((m) => m[1]),
      ),
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
    const code = sqlCode("008_admin.sql");
    expect(code).toMatch(/SELECT sys_role_grant_all_menus\('NEOTMS_SYSADMIN'\)/);
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
     * `sys_role_grant_all_menus` for anything other than the bootstrap superuser, would undo the
     * split on the way in - and silently, because the symptom is a screen appearing for someone it
     * was meant to be withheld from, which nobody reports.
     *
     * The superuser is the exception the user named: the only account that holds both.
     */
    const code = sqlCode("013_dashboard_menus.sql");
    expect(code).toMatch(/INSERT INTO sys_menu[\s\S]*?ON CONFLICT \(menu_id\) DO NOTHING/);
    expect(code).toContain("'DASHBOARD_SALES'");
    expect(code).toContain("'DASHBOARD_PM'");

    // The paths must be the ones the router and NEOTMS_NAV use. `menu_url` is not what the client
    // navigates by, but it is what someone reading `sys_menu` directly will believe.
    expect(code).toContain("'/dashboard/sales'");
    expect(code).toContain("'/dashboard/pm'");

    // Exactly one grant call, and for NEOTMS_SYSADMIN. Grants written by 006 and 008 do not cover
    // rows added here, so without this the superuser sees two tabs that both answer 403.
    const grants = [...code.matchAll(/sys_role_grant_all_menus\('([A-Z_]+)'\)/g)].map((m) => m[1]);
    expect(grants).toEqual(["NEOTMS_SYSADMIN"]);
    expect(code).not.toMatch(/INSERT INTO sys_role_auth/);

    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/m);
  });

  test("the seeded superuser role is the one the bootstrap function hands out", () => {
    const code = sqlCode("006_bootstrap.sql");
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

  test("the superuser is granted both the action matrix and menu visibility", () => {
    // Two tables, and granting one without the other is a role that is permitted to use a screen it
    // cannot navigate to - or worse, one that appears in the sidebar and then refuses every click.
    // `\$\w*\$;` closes the body whatever the dollar-quote tag is - `$fn$` today. Anchoring on the
    // tag itself would make renaming it look like a missing grant.
    const grant = /CREATE OR REPLACE FUNCTION sys_role_grant_all_menus[\s\S]*?\n\$\w*\$;/.exec(
      sqlCode("006_bootstrap.sql"),
    );
    expect(grant).not.toBeNull();
    expect(grant![0]).toContain("INSERT INTO sys_role_auth");
    expect(grant![0]).toContain("INSERT INTO sys_role_menu");
    // All five action flags. Four would be a superuser who cannot, say, export.
    for (const flag of ["role_1", "role_2", "role_3", "role_4", "role_5"]) {
      expect(grant![0]).toContain(flag);
    }
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
      "001_extensions.sql",
      "002_tables.sql",
      "003_indexes.sql",
      "004_rollup.sql",
      "005_code_sequences.sql",
      "006_bootstrap.sql",
      "007_codes.sql",
      "008_admin.sql",
      "009_selfservice.sql",
      "010_currency.sql",
      "011_job_types.sql",
      "012_job_pricing.sql",
      "013_dashboard_menus.sql",
      "014_fx_rates.sql",
      "015_payment.sql",
      "016_project_fields.sql",
    ];
    for (const file of editorFiles) {
      const code = sqlCode(file);
      expect(code).not.toMatch(/^\s*\\\w+/m);
      // `(^|[^:])` so `::text` and `$1::date` are not read as placeholders, and `[a-z_]` so `:=`
      // is not either.
      expect(code).not.toMatch(/(^|[^:]):[a-z_][a-z0-9_]*/m);
    }
    expect(sql("004_verify_search.sql")).toContain("\\set ON_ERROR_STOP on");
  });

  test("004 tears the reporting rollup down and does not build a new one", () => {
    /*
     * The reports aggregate `job` and `purchase_order` on every request. A pre-aggregated table is
     * the obvious design and it was wrong here three times over - see the decision record in
     * db/004_rollup.sql - and the way it would come back is not a commit titled "reintroduce the
     * rollup". It is a CREATE TABLE in a bootstrap file, added to make a report faster, by someone
     * who never saw the empty one.
     *
     * The specific failure mode is why this is worth a test rather than a comment: a rollup with
     * nothing writing it returns ZEROES, not errors. An empty chart over a valid date range reads
     * as "a quiet quarter", not as "the pipeline does not exist", so the report stays broken for
     * as long as nobody happens to know what the number should be.
     *
     * The DROPs are asserted by name, individually, because a half-applied older bootstrap can
     * leave one index behind, and `DROP TABLE` alone would not remove it.
     */
    const code = sqlCode("004_rollup.sql");
    expect(code).toContain("DROP TABLE IF EXISTS report_daily_rollup");
    expect(code).toContain("DROP FUNCTION IF EXISTS report_rollup_recompute(date)");
    for (const index of [
      "ix_rollup_customer",
      "ix_rollup_pm",
      "ix_rollup_sales",
      "ix_rollup_corp",
      "ix_rollup_category",
      "ix_rollup_langpair",
    ]) {
      expect(code).toContain(`DROP INDEX IF EXISTS ${index}`);
    }
    // The function is dropped BEFORE the table it reads and writes, or there is a window in which
    // it exists over a missing one.
    expect(code.indexOf("DROP FUNCTION")).toBeLessThan(code.indexOf("DROP TABLE"));

    // And nothing in the bootstrap creates one. Checked across every file, not just this one: a
    // rollup added to 002 with the tables would be just as invisible, and more plausible.
    for (const file of readdirSync(dbDir).filter((f) => f.endsWith(".sql"))) {
      expect(sqlCode(file)).not.toMatch(/CREATE\s+(TABLE|MATERIALIZED VIEW)[^;]*rollup/i);
      expect(sqlCode(file)).not.toMatch(/CREATE\s+(OR REPLACE\s+)?FUNCTION\s+report_rollup/i);
    }
  });

  test("006 is idempotent at every statement, because there is no transaction around it", () => {
    /*
     * The Supabase SQL editor wraps a submission in its own transaction and rejects `\` commands,
     * so this file carries neither `BEGIN`/`COMMIT` nor `\set ON_ERROR_STOP`. The consequence is
     * that a partial application has to be recoverable by re-running the whole file - which is only
     * true if every statement in it is idempotent. These are the three forms that make it so.
     */
    const code = sqlCode("006_bootstrap.sql");
    expect(code).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/m);
    // The menus must not reset a label an operator has corrected; the role is this file's own row,
    // so it is re-asserted.
    expect(code).toMatch(/INSERT INTO sys_menu[\s\S]*?ON CONFLICT \(menu_id\) DO NOTHING/);
    expect(code).toMatch(/INSERT INTO sys_role[\s\S]*?ON CONFLICT \(role_code\) DO UPDATE/);
    for (const fn of ["sys_role_grant_all_menus", "staff_bootstrap_superuser"]) {
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

  test("every staff and role route is gated on the STAFF menu", () => {
    /*
     * Not `anyStaff`. The role listing is the one that could plausibly be argued into being open -
     * a role's name is not a secret - and that is exactly why it is pinned: the argument is easy to
     * make in review, and the consequence is that any signed-in account can enumerate the company's
     * privilege tiers. If a non-admin screen ever needs role names, the answer is a second path the
     * way `/codes` and `/admin/codes` are split, not a flag on this one.
     */
    for (const line of handler()
      .split("\n")
      .filter((l) => /path: (ADMIN_STAFF|ADMIN_ROLES|`\$\{ADMIN_STAFF\})/.test(l))) {
      expect(line).toContain("menu: NeotmsMenu.STAFF");
      expect(line).not.toContain("anyStaff");
    }
  });

  test("there are exactly three staff routes, and none of them creates or deletes", () => {
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
    const routes = handler()
      .split("\n")
      .filter((l) => /path: (ADMIN_STAFF|ADMIN_ROLES|`\$\{ADMIN_STAFF\})/.test(l));
    expect(routes).toHaveLength(3);
    const methods = routes.map((l) => /method: "(\w+)"/.exec(l)?.[1]);
    expect(methods.sort()).toEqual(["GET", "GET", "PATCH"]);
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
     * Looks for `role_id =` written as literal SQL anywhere under neotms/. The admin path does not
     * match it, because it builds the SET clause from `STAFF_ADMIN_FIELDS` (asserted above) rather
     * than spelling the assignment out - so the expected set here is empty, and anything that turns
     * up is a second write site that needs the same scrutiny as the first.
     *
     * `staff_self_register()` is in SQL, not here, and it is also the reason this test matters: that
     * function is allowed to set `role_id` because it forces it to NULL. A TypeScript statement that
     * set it to anything else would be the hole this whole design closes.
     */
    const offenders = walkTs(neotmsLambdaDir)
      .filter((file) => /role_id\s*=\s*:/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(neotmsLambdaDir, file));
    expect(offenders).toEqual([]);
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
    const code = sqlCode("009_selfservice.sql");
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
      sqlCode("006_bootstrap.sql"),
    )?.[0];
    expect(bootstrap).toMatch(/lower\(\s*(btrim|trim)\(\s*mgr_email/);

    const selfRegister = /CREATE OR REPLACE FUNCTION staff_self_register[\s\S]*?\n\$\w*\$;/.exec(
      sqlCode("009_selfservice.sql"),
    )?.[0];
    expect(selfRegister).not.toMatch(/lower\(\s*(btrim|trim)\(\s*mgr_email/);
    // The only row this function may look up by is the verified OIDC subject.
    expect(selfRegister).toMatch(/FROM staff WHERE lpx_sub = p_lpx_sub/);
    expect(selfRegister).not.toMatch(/WHERE[\s\S]{0,80}mgr_email\s*=/);
  });

  test("009 is idempotent at every statement, like the rest of db/", () => {
    // Same rule as 006 and 008, for the same reason: the Supabase SQL editor wraps a submission in
    // its own transaction, so a partial application has to be recoverable by re-running the file.
    const code = sqlCode("009_selfservice.sql");
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
    expect(manager).toMatch(/menus: approved \? await grantsFor\(caller\) : \[\],/);
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
    const insert = /INSERT INTO currency[\s\S]*?ON CONFLICT/.exec(sqlCode("010_currency.sql"));
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
    const code = sqlCode("010_currency.sql");
    expect(code).toMatch(/ON CONFLICT \(coin_code\) DO NOTHING/);
    expect(code).not.toMatch(/ON CONFLICT[\s\S]{0,40}DO UPDATE/);
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
  const code = () => sqlCode("011_job_types.sql");

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
      expect(code()).toMatch(
        new RegExp(
          `ALTER TABLE ${table!}\\s+ADD COLUMN IF NOT EXISTS ${column!}\\s+text NOT NULL DEFAULT 'LINGUISTICS'`,
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
    expect(code()).not.toMatch(/CREATE (OR REPLACE )?(TRIGGER|FUNCTION)/i);
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

  test("the backfill runs before the drop, and the drop takes only the four language columns", () => {
    /*
     * The ordering is the one thing in this file that cannot be recovered from by re-running it.
     * Section 5 reads `job.job_slang`; section 6 drops it. Reversed, the backfill finds no column
     * and the migration "succeeds" with the detail tables empty - and the application, which reads
     * only the detail tables from here on, shows every language pair as blank. The data is not lost
     * at that point, it is gone.
     *
     * `po_lang` and the four `po_cat_*` columns must survive, and they are the two most plausible
     * casualties of a search-and-replace: `po_lang` is the PRINTED PO's letterhead language (Korean
     * or English) and `po_cat_*` is CAT-TOOL analysis, where 'cat' is Computer-Assisted Translation
     * and not 'category'. Both read like the thing being migrated and neither is.
     *
     * Asserted as the exact SET of dropped columns rather than as four separate absences, so a
     * fifth DROP COLUMN added later has to be justified here.
     */
    const dropped = [...code().matchAll(/DROP COLUMN IF EXISTS (\w+)/g)].map((m) => m[1]!);
    expect([...dropped].sort()).toEqual(["job_elang", "job_slang", "po_elang", "po_slang"]);

    const backfill = code().indexOf("INSERT INTO job_detail_linguistic");
    const drop = code().indexOf("DROP COLUMN IF EXISTS job_slang");
    expect(backfill).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(backfill);

    // Re-runnable, and DO NOTHING rather than DO UPDATE: an existing detail row is NEWER than these
    // columns, and overwriting it with pre-migration values is the one thing a re-runnable
    // migration must never do.
    expect(code()).toMatch(/ON CONFLICT \(job_id\) DO NOTHING/);
    expect(code()).toMatch(/ON CONFLICT \(po_id\) DO NOTHING/);
    expect(code()).not.toMatch(/ON CONFLICT[^;]{0,60}DO UPDATE/);
    // Empty strings normalise to NULL on the way in, so the application has one kind of unset to
    // handle from here rather than the two the old columns permitted.
    expect(code()).toContain("NULLIF(job_slang, '')");
    expect(code()).toContain("NULLIF(po_slang, '')");
  });

  test("the backfill is guarded, because section 6 drops the column section 5 reads", () => {
    /*
     * The defect the docker rehearsal in README.md found and this suite could not: `ON CONFLICT DO
     * NOTHING` does NOT make section 5 re-runnable. A second run of the file reaches an INSERT that
     * names `job.job_slang`, which the FIRST run dropped - and PostgreSQL refuses it at PARSE time
     * with 42703, before ON CONFLICT or the WHERE clause can observe that there is nothing left to
     * move. The file then stops one section short of the indexes, which for a file whose stated
     * purpose is to be safe to repeat is the worst outcome available.
     *
     * So each backfill sits inside a `DO` block that checks `information_schema` and runs the
     * INSERT through `EXECUTE`, where it stays a string until the guard has passed. Asserted here
     * because the fix looks like ceremony: the plain INSERT reads fine, works on a first run, and
     * is exactly what someone tidying this file would restore.
     */
    expect([...code().matchAll(/DO \$backfill_(?:job|po)\$/g)]).toHaveLength(2);
    expect([...code().matchAll(/EXECUTE \$move_(?:job|po)\$/g)]).toHaveLength(2);
    expect(code()).toContain("information_schema.columns");

    // Both INSERTs are INSIDE a guard, not left at the top level where parsing reaches them. The
    // job block is the first of the two, so every backfill INSERT must follow it.
    for (const table of ["job_detail_linguistic", "po_detail_linguistic"]) {
      expect(code().indexOf(`INSERT INTO ${table}`)).toBeGreaterThan(
        code().indexOf("DO $backfill_job$"),
      );
    }
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
    expect(code().match(/ON CONFLICT \(code\) DO NOTHING/g)).toHaveLength(3);
  });
});

describe("the pricing-model split", () => {
  /** db/012_job_pricing.sql, comments stripped - same reason as 011's. */
  const code = () => sqlCode("012_job_pricing.sql");

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

  test("the drop takes only the nine columns the backfill moved, and runs after it", () => {
    /*
     * Same ordering hazard as 011, one file later: section 2 reads `job.job_volume` and section 3
     * drops it. Reversed, the file "succeeds" with the detail tables holding languages but no
     * prices, and every job in the system reads as having no unit price - recoverable only from a
     * backup, because the columns are gone by then.
     *
     * `po_cat_word` / `po_cat_mid` / `po_cat_stotal` must survive, and they are the likeliest
     * casualty of a search-and-replace over this file: they look like pricing inputs and are not.
     * 'cat' is Computer-Assisted Translation, their meaning is marked UNCONFIRMED in 002_tables.sql,
     * and nothing in the application multiplies them by anything. `po_lang` - the printed PO's
     * letterhead language - is the other one.
     */
    const dropped = [...code().matchAll(/DROP COLUMN IF EXISTS (\w+)/g)].map((m) => m[1]!);
    expect([...dropped].sort()).toEqual([
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
    // The added and dropped sets are the same nine: everything that moved left its old home, and
    // nothing was dropped that did not get a new one.
    const added = [...code().matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map((m) => m[1]!);
    expect([...dropped].sort()).toEqual([...added].sort());

    expect(code()).not.toMatch(/DROP COLUMN IF EXISTS po_cat_/);
    expect(code()).not.toMatch(/DROP COLUMN IF EXISTS po_lang\b/);

    const backfill = code().indexOf("INSERT INTO job_detail_linguistic");
    const drop = code().indexOf("DROP COLUMN IF EXISTS job_volume");
    expect(backfill).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(backfill);
  });

  test("the backfill is guarded the way 011's had to be", () => {
    /*
     * 011 shipped with a plain INSERT and the docker rehearsal in README.md found it on the SECOND
     * run: the statement names a column the first run dropped, so PostgreSQL refuses it at PARSE
     * time with 42703 - before ON CONFLICT or any WHERE clause can observe there is nothing left to
     * move. The file then stops one section short of the end.
     *
     * This file was written with the guard from the start. Asserted because the guard looks like
     * ceremony: the plain INSERT reads better, works on a first run, and is exactly what someone
     * tidying this file would restore.
     */
    expect([...code().matchAll(/DO \$backfill_(?:job|po)_pricing\$/g)]).toHaveLength(2);
    expect([...code().matchAll(/EXECUTE \$move_(?:job|po)_pricing\$/g)]).toHaveLength(2);
    // Every dollar-quote tag opens and closes exactly once. An unbalanced one does not fail at parse
    // time in any readable way - the rest of the file is swallowed into the string literal - so the
    // pairing is worth asserting rather than eyeballing.
    for (const tag of [
      "backfill_job_pricing",
      "backfill_po_pricing",
      "move_job_pricing",
      "move_po_pricing",
    ]) {
      expect([...code().matchAll(new RegExp(`\\$${tag}\\$`, "g"))]).toHaveLength(2);
    }
    expect(code()).toContain("information_schema.columns");
    for (const table of ["job_detail_linguistic", "po_detail_linguistic"]) {
      expect(code().indexOf(`INSERT INTO ${table}`)).toBeGreaterThan(
        code().indexOf("DO $backfill_job_pricing$"),
      );
    }
  });

  test("the upsert fills blanks only - DO UPDATE here, unlike 011's DO NOTHING", () => {
    /*
     * The one place this file deliberately disagrees with its predecessor, and the reason is the
     * state 011 leaves behind.
     *
     * 011 inserted into empty tables, so any conflicting row it met was newer than the columns it
     * was reading and DO NOTHING was right. By the time 012 runs, a detail row already exists for
     * every job that has a language - created by 011, necessarily with all five pricing columns
     * NULL. DO NOTHING would therefore skip MOST jobs and silently lose their prices: the migration
     * reports success, the job list shows every unit price blank, and the columns it would have read
     * are dropped three sections later.
     *
     * The WHERE on the DO UPDATE is what keeps it safe to repeat. It fires only when all the target
     * columns are still NULL, so a run that was interrupted after the backfill but before the drop -
     * and then had prices edited through the console - cannot have those edits overwritten by the
     * pre-migration values on the retry.
     */
    expect(code()).toMatch(/ON CONFLICT \(job_id\) DO UPDATE/);
    expect(code()).toMatch(/ON CONFLICT \(po_id\) DO UPDATE/);
    for (const column of [
      "job_volume",
      "unit_code",
      "job_price_sel",
      "job_price",
      "job_price_dis",
    ]) {
      expect(code()).toMatch(
        new RegExp(`job_detail_linguistic\\.${column}\\s+IS NULL`),
      );
    }
    for (const column of ["po_volume", "po_unit_code", "po_price_sel", "po_price"]) {
      expect(code()).toMatch(new RegExp(`po_detail_linguistic\\.${column}\\s+IS NULL`));
    }
    // Legacy empty strings normalise to NULL on the way in, as in 011, so the application has one
    // kind of unset to handle rather than two.
    expect(code()).toContain("NULLIF(unit_code, '')");
    expect(code()).toContain("NULLIF(po_unit_code, '')");
    // Only linguistic parents are read. A MICE job created through the new console before this file
    // ran may hold a volume, and discarding it is correct - its money is on the parent regardless.
    expect(code()).toContain("WHERE job_type = 'LINGUISTICS'");
    expect(code()).toContain("WHERE po_type = 'LINGUISTICS'");
  });

  test("012 requires nothing and creates no trigger", () => {
    // Same rule as 011: constraints forbid, they never require. A NOT NULL on `job_volume` would
    // make the thousands of existing jobs with no volume unsaveable, and the type CHECKs 011 already
    // put on these tables are what makes a word count on a MICE job impossible - so this file needs
    // no constraint of its own.
    // Scoped to the column definitions on purpose. A looser "no NOT NULL anywhere" would trip over
    // section 5's verification SELECTs, which legitimately read `WHERE job_volume IS NOT NULL`.
    expect(code()).not.toMatch(/ADD COLUMN IF NOT EXISTS\s+\w+\s+[^;]*NOT NULL/);
    expect(code()).not.toMatch(/CREATE (OR REPLACE )?(TRIGGER|FUNCTION)/i);
    expect(code()).not.toMatch(/ADD CONSTRAINT/);
    expect(code()).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/m);
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
     */
    expect([...dbops().matchAll(/LEFT JOIN LATERAL/g)]).toHaveLength(2);
    expect(dbops()).not.toMatch(/GROUP BY/i);
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
    for (const [role, menu] of [
      ["sales", "DASHBOARD_SALES"],
      ["pm", "DASHBOARD_PM"],
    ]) {
      const routes = lines.filter((l) => l.includes(`path: "/api/v0/dashboard/${role}"`));
      expect(routes).toHaveLength(1);
      expect(routes[0]).toContain(`menu: NeotmsMenu.${menu}`);
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
    for (const [role, menu] of [
      ["sales", "DASHBOARD_SALES"],
      ["pm", "DASHBOARD_PM"],
    ]) {
      expect(routes).toMatch(
        new RegExp(
          `path: 'dashboard/${role}'[^}]*?RequireMenu menuId=\\{NeotmsMenuId\\.${menu}\\}` +
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

    const items = [...nav.matchAll(/menuId: NeotmsMenuId\.(\w+),\s*\n\s*path: '([^']+)'/g)].map(
      (m) => [m[2], m[1]],
    );
    expect(items.slice(0, 2)).toEqual([
      ["/dashboard/sales", "DASHBOARD_SALES"],
      ["/dashboard/pm", "DASHBOARD_PM"],
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
  const code = () => sqlCode("014_fx_rates.sql");

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

  test("the backfill pins a legacy rate and refuses to invent one", () => {
    /*
     * The invariant: A ROW THAT ALREADY HAS A BOOKED KRW FIGURE NEVER FLOATS.
     *
     * Legacy `COIN_RATE` was nvarchar and holds '' or '-' on some rows, which arrives as NULL. Such
     * a row has an invoiced `job_price_ksum` and no rate, so the moment the view goes live it would
     * start floating - restating a figure a customer has already been billed for. Deriving the rate
     * from `ksum / sum` and storing it changes no reported figure; it only stops the figure from
     * changing later.
     *
     * Every guard is asserted individually because each one admits a row class that genuinely
     * occurs, and dropping any single one is a different silent corruption:
     *
     *   coin_rate IS NULL       - idempotence. Without it, a second run overwrites rates the
     *                             console wrote, with a quotient that disagrees in the sixth
     *                             decimal.
     *   price_sum <> 0          - division by zero, which aborts the whole file mid-apply.
     *   price_ksum IS NOT NULL  - the one that matters most, and the one that looks removable. A
     *                             row with no booked figure has nothing to protect and SHOULD
     *                             float; pinning it would freeze an open position at a rate nobody
     *                             ever agreed to.
     */
    for (const [table, rate, sum, ksum] of [
      ["job", "coin_rate", "job_price_sum", "job_price_ksum"],
      ["purchase_order", "po_coin_rate", "po_price_sum", "po_price_ksum"],
    ] as const) {
      const stmt = new RegExp(`UPDATE ${table}\\s+SET ${rate} = round\\(([\\s\\S]*?);`).exec(
        code(),
      )?.[0];
      expect(stmt).toBeDefined();
      expect(stmt).toContain(`${ksum} / ${sum}`);
      expect(stmt).toContain(`${rate} IS NULL`);
      expect(stmt).toContain(`${sum} <> 0`);
      expect(stmt).toContain(`${ksum} IS NOT NULL`);
      expect(stmt).toContain("deleted = false");
    }
  });

  test("the backfill is an UPDATE of the rate and never touches an amount", () => {
    /*
     * Stated as a prohibition because the file's own argument invites the opposite reading. Having
     * established that `ksum / sum` is the rate, the next apparently-tidy step is to "normalise" the
     * amounts to agree with it - and that would rewrite money. Nothing in this feature may ever
     * change a booked figure: the whole point of pinning the rate is that the figure stays exactly
     * where it is.
     *
     * So the only columns any SET in this file assigns are the two rate columns.
     */
    const assigned = [...code().matchAll(/SET\s+(\w+)\s*=/g)].map((m) => m[1]!);
    expect([...new Set(assigned)].sort()).toEqual(["coin_rate", "po_coin_rate"]);
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

  test("014 creates no table and drops nothing", () => {
    /*
     * `fx_rate` and `ix_fx_rate_lookup` already exist - 002 and 003 created them, and this file only
     * starts USING them. Asserted because a re-reading of the header ("the table nothing populates")
     * naturally suggests the table is new here, and a `CREATE TABLE fx_rate` added on that
     * assumption would be silently skipped by `IF NOT EXISTS` on a real database and would mask a
     * schema divergence on a fresh one.
     *
     * No DROP of any kind: unlike 011, this file migrates no structure. A `DROP COLUMN coin_rate`
     * would be the catastrophic version of "the rate is no longer what someone typed".
     */
    expect(code()).not.toMatch(/CREATE\s+TABLE/i);
    expect(code()).not.toMatch(/DROP\s+(TABLE|COLUMN|VIEW|INDEX)/i);
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
     * `sys_role_grant_all_menus` re-grant (the hazard 008, 013 and 015 all carry a warning about).
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
  const code = () => sqlCode("016_project_fields.sql");

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
    expect(code().match(/ON CONFLICT \(code\) DO NOTHING/g)).toHaveLength(2);
  });

  test("the backfill moves the detailed value down before deriving the coarse one, and never overwrites a 세부 분야", () => {
    /*
     * Order is the whole correctness argument: 3b reads `prj_field2`, so running it first would
     * classify every project from a column that is still empty and land them all in '일반'. And the
     * `prj_field2 IS NULL` guard in 3a is what stops a project that already HAS a detailed value from
     * losing it - that value is the more specific of the two, and it is the only thing `prj_field2`
     * ever carried.
     *
     * The re-run guard is the `NOT IN (SELECT code ... PRJCAT)` predicate. Without it a second
     * application reclassifies the coarse values it just wrote, every one of them falls through to
     * `ELSE '일반'`, and the 분야별 report becomes a single bar. That is a silent, total loss of the
     * grouping, which is why it is asserted rather than trusted to the header's "apply it whole".
     */
    const lines = code().split("\n");
    const moveDown = lines.findIndex((line) => /SET prj_field2 = prj_field/.test(line));
    const derive = lines.findIndex((line) => /SET prj_field = CASE/.test(line));
    expect(moveDown).toBeGreaterThan(-1);
    expect(derive).toBeGreaterThan(moveDown);

    expect(code()).toMatch(/SET prj_field2 = prj_field[\s\S]*?prj_field2 IS NULL/);
    expect(code()).toMatch(/prj_field NOT IN \(SELECT code FROM sys_code WHERE code_parent = 'PRJCAT'\)/);
    // Unrecognised values land in a real group rather than in NULL, which the report would print as
    // '(unassigned)' - a data-entry gap, which is not what an ungrouped field is.
    expect(code()).toMatch(/ELSE '일반'/);
  });

  test("every code the backfill maps onto exists in the seed", () => {
    /*
     * `project.prj_field` is a foreign key onto `sys_code (code)`, so a CASE arm naming a code the
     * INSERT above does not create fails the whole UPDATE with 23503 - and it fails on the operator's
     * screen, halfway through a file whose earlier sections have already committed. A typo in one of
     * seven Korean compound names with a middle dot in it is exactly the mistake this catches.
     */
    const seeded = [...code().matchAll(/\('([^']+)',[^\n]*'PRJCAT'/g)].map((m) => m[1]);
    expect(seeded).toHaveLength(7);
    const targets = [...code().matchAll(/THEN '([^']+)'/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(0);
    for (const target of [...targets, "일반"]) {
      expect(seeded).toContain(target);
    }
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
    expect(sql("002_tables.sql")).toContain("prj_invoice_state");
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
    expect(css).toMatch(/\.dateBtns \{[^}]*grid-template-columns: repeat\(5, 1fr\)/);
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
    const field = frontendCode("shared", "ui", "DateField.tsx");
    expect(field).toContain("function clipBox(node: HTMLElement)");
    expect(field).toMatch(/overflowX !== 'visible'/);
    expect(field).toContain("translate(${fit.dx}px, ${fit.dy}px)");
    // `useLayoutEffect`, not `useEffect`: the latter runs after paint, so the calendar would show
    // clipped for a frame and then jump - and a click inside that frame lands on the wrong day.
    expect(field).toContain("useLayoutEffect(() => {");
    expect(field).not.toContain("useEffect(() => {");
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
    const field = frontendCode("shared", "ui", "DateField.tsx");
    expect(field).toMatch(/overflowY !== 'visible'/);
    expect(field).toContain("return { left, right, top, bottom }");
    expect(field).toContain("pop.offsetParent as HTMLElement | null");
    expect(field).toContain("anchor.top - gap - height");

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
    // one of the four ends up without a confirmation.
    expect(view.match(/runSequential\(/g)).toHaveLength(1);
    expect(view.match(/runBulk\(/g)).toHaveLength(4);
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

    // Both tables grew a leading checkbox column, so both empty/loading rows must span ten. A missed
    // one is a cell short and the message sits under the wrong heading.
    expect(view.match(/colSpan=\{10\}/g)).toHaveLength(2);
    expect(view).not.toContain("colSpan={9}");
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

  const ALL = { formats: HANDOVER_FORMATS, layouts: HANDOVER_LAYOUTS } as const;
  const WORD = { formats: ["WORD"], layouts: ["보기좋게"] } as const;

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

  test("one shared deadline is one line; differing deadlines break into 언어: 납기 lines", () => {
    /*
     * The document's three steps. All the same -> one date. Dates differ -> one line per language.
     * Times differ too -> each line carries its own morning/afternoon word in brackets.
     *
     * The form's morning/afternoon cell is highlighted only while the half is UNIFORM.
     * Colouring one of them on a mail whose languages are split between morning and afternoon
     * would state something untrue about half the work, in the one place the reader would not
     * think to doubt.
     */
    const same = [
      job({ jobEday: "2026-11-13", jobEdayTime: "15:00:00" }),
      job({ jobElang: "일본어", jobEday: "2026-11-13", jobEdayTime: "15:00:00" }),
    ];
    expect(deadlines(same, project())).toEqual({ lines: ["11/13 (금)"], half: "오후" });
    expect(composeHandoverMail(project(), same, WORD).html).not.toContain("한국어 → 영어: ");

    const split = [
      job({ jobEday: "2026-11-13", jobEdayTime: "15:00:00" }),
      job({ jobElang: "베트남어", jobEday: "2026-11-20", jobEdayTime: "09:00:00" }),
    ];
    expect(deadlines(split, project())).toEqual({
      lines: ["한국어 → 영어: 11/13 (금)(오후)", "한국어 → 베트남어: 11/20 (금)(오전)"],
      half: null,
    });
  });

  test("a missing delivery time highlights neither 오전 nor 오후", () => {
    /*
     * The document says the job-list toggle defaults to afternoon. That is a default for a
     * control a person is about to set, not a licence to assert a time nobody recorded - a mail
     * that says afternoon cannot be told apart from one where afternoon was actually agreed.
     */
    const mail = composeHandoverMail(project({ prjEday: "2026-11-13" }), [], WORD);
    expect(deadlines([], project({ prjEday: "2026-11-13" })).half).toBeNull();
    expect(mail.html).toContain(">오전</td>");
    expect(mail.html).toContain(">오후</td>");
    // Two highlighted cells in the whole mail: the chosen format and the chosen layout.
    expect(mail.html.match(/background:#3b57c4/g) ?? []).toHaveLength(2);
  });

  test("the jobs' deadlines win over the project's, which is the outer fallback", () => {
    // The delivery date is per language wherever the data allows it; the project header is
    // the same rule's outer ring, not a different rule.
    const html = composeHandoverMail(
      project({ prjEday: "2026-12-31" }),
      [job({ jobEday: "2026-11-13" })],
      WORD,
    ).html;
    expect(html).toContain("11/13 (금)");
    expect(html).not.toContain("12/31");
  });

  test("every option is drawn and only the chosen ones are coloured", () => {
    /*
     * "clicking an editing format or a layout colours it in (several allowed); clicking
     * toggles colour and no colour".
     *
     * Printing only the chosen ones would leave a cell reading "WORD", which cannot be told from a
     * form on which HWP was never offered. The unchosen options being visible is what makes the
     * chosen one read as a decision.
     */
    const mail = composeHandoverMail(project(), [job()], {
      formats: ["HWP"],
      layouts: ["DTP"],
    } as const);
    for (const option of [...HANDOVER_FORMATS, ...HANDOVER_LAYOUTS]) {
      expect(mail.html).toContain(`>${option}</td>`);
    }
    expect(mail.html).toMatch(/background:#3b57c4[^>]*>HWP</);
    expect(mail.html).toMatch(/background:#3b57c4[^>]*>DTP</);
    expect(mail.html).toMatch(/#9aa0ad[^>]*>WORD</);

    // Choosing all seven is legitimate, and must colour all seven.
    expect(composeHandoverMail(project(), [job()], ALL).html.match(/background:#3b57c4/g) ?? [])
      .toHaveLength(7);
  });

  test("기타요청 carries the project's 내용, with its line breaks and without its markup", () => {
    /*
     * The document says to leave the remarks cell blank for the PM to fill in. That was written
     * for a copy-to-clipboard flow, where somebody saw the form before it was sent; this sends
     * directly, so a blank cell would stay blank forever. The request redirected the project's
     * own notes into it.
     *
     * The escaping half is the one that fails silently. A closing cell tag inside those notes
     * ends the cell early and shifts every later value one column left - a mail that looks
     * fine and puts real figures under the wrong headings.
     */
    const mail = composeHandoverMail(
      project({ prjContent: "원문 PDF 2종\n<b>급건</b></td><td>주입" }),
      [job()],
      WORD,
    );
    expect(mail.html).toContain("원문 PDF 2종<br>&lt;b&gt;급건&lt;/b&gt;&lt;/td&gt;&lt;td&gt;주입");
    expect(mail.html).not.toContain("<b>급건</b>");
    // Nine rows, whatever anyone types into the notes.
    expect(mail.html.match(/<tr>/g) ?? []).toHaveLength(9);
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

  test("the mail table has one column count, and every cell carries its style inline", () => {
    /*
     * Six columns, set by the widest row (name + sub-heading + four formats). A row short of the
     * count makes the client guess widths and the form comes out as a staircase - borders present,
     * verticals not lining up. The delivery-form block's second row is five because the first
     * lends it a cell through `rowspan`.
     *
     * Inline styles because Gmail and Outlook strip `<style>`. Without the borders the form is a
     * run of prose, and then nothing says which value belongs to which label.
     */
    const html = composeHandoverMail(project(), [job()], ALL).html;
    expect(html).not.toContain("<style");
    expect(html).not.toContain("class=");
    for (const row of html.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
      const cells = [...row.matchAll(/<td style="([^"]*)"(?: colspan="(\d+)")?(?: rowspan="\d+")?>/g)];
      expect(cells.length).toBeGreaterThan(0);
      expect([5, 6]).toContain(cells.reduce((sum, c) => sum + Number(c[2] ?? 1), 0));
      for (const cell of cells) expect(cell[1]).toContain("border:1px solid");
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
    expect(route).toContain("menu: NeotmsMenu.PROJECT");
    expect(route).toContain('action: "read"');
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
