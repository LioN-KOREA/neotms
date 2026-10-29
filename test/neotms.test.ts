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
 * `:business_date`, `\set` - and both appear in 004_rollup.sql's comments, which explain why they
 * are not in its statements. A test that could not tell the two apart would have to be deleted.
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
     * Both seed files, because the menus are deliberately split across two. 006 holds the six
     * business menus and is the lockout-recovery file - its one job is to stay the thing an operator
     * can run without deciding anything, so new menus are not added to it. 008 holds the two
     * administrative ones. Scanning both means neither file can be the one that was forgotten, which
     * is the real risk now that there is more than one: this very test failed on MAINTENANCE the
     * moment `NeotmsMenu` grew, which is exactly what it is for.
     */
    const seeded = new Set(
      ["006_bootstrap.sql", "008_admin.sql"].flatMap((file) =>
        [...sqlCode(file).matchAll(/^\s*\('([A-Z_]+)',/gm)].map((m) => m[1]),
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
     * from a `WHERE business_date = :business_date` left in 004_rollup.sql. `:name` is an
     * APPLICATION convention - `toPositional` in PostgresUtils.ts rewrites it to `$n` - and nothing
     * else in the world knows that, so a file carrying one cannot be applied at all.
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

  test("the seed and COIN_CODES have not drifted apart in either direction", () => {
    /*
     * The weaker converse, as a warning rather than as the security-shaped assertion above.
     *
     * A row here that `COIN_CODES` does not offer cannot break a save - it just sits unreachable,
     * because there is no GET endpoint for currencies and no screen that reads the table. It is
     * still worth failing on, for the reason 007's 작업/단위 blocks are worth keeping aligned: the
     * moment the two lists differ, the next person has to work out which one is authoritative, and
     * the answer ("the frontend constant, because the database list is invisible") is not something
     * either file says on its own.
     */
    expect([...seededCurrencies()].sort()).toEqual(
      [...optValues(frontendFile("apis", "neotms.codes.ts"), "COIN_CODES")].sort(),
    );
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
