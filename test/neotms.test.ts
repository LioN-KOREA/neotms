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

import * as cdk from "aws-cdk-lib/core";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { Match, Template } from "aws-cdk-lib/assertions";
import {
  NEOTMS_AUTH_CONTEXT_KEYS,
  NEOTMS_CONFIGS,
  resolveStageConfig,
} from "../infra/config/NeotmsConfig.js";
import { NeotmsStack } from "../infra/stacks/neotms-stack.js";

function synth(stage: "dev" | "prod" = "prod"): Template {
  const app = new cdk.App();
  const stack = new NeotmsStack(app, "TestStack", {
    config: NEOTMS_CONFIGS[stage],
    env: { account: "123456789012", region: "ap-northeast-2" },
  });
  return Template.fromStack(stack);
}

describe("cost guards", () => {
  test("no NAT Gateway exists", () => {
    // ~$43/month before a byte flows through it. The whole architecture - Data API instead of a
    // socket, Lambda outside the VPC - exists to avoid needing one.
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

  test("no RDS Proxy is created", () => {
    // ~$15/month per endpoint, and pointless here: the Data API has no connection to pool.
    synth().resourceCountIs("AWS::RDS::DBProxy", 0);
  });

  test("the cluster has exactly one instance", () => {
    // A second instance would roughly double the compute bill. The ~60-second failover that buys is
    // an accepted trade (Q13), not an oversight - so a reader appearing here should be a deliberate
    // decision with this test updated, not a side effect.
    synth().resourceCountIs("AWS::RDS::DBInstance", 1);
  });
});

describe("Data API", () => {
  test("the HTTP endpoint is enabled", () => {
    // Without this the cluster is only reachable from inside the VPC, which forces the Lambda into
    // the VPC and brings the NAT Gateway back with it.
    synth().hasResourceProperties("AWS::RDS::DBCluster", { EnableHttpEndpoint: true });
  });

  test("the engine is pinned to PostgreSQL 16", () => {
    // The Data API's supported-version table has no PostgreSQL 18 column. A cluster on an
    // unsupported major deploys fine and then rejects every ExecuteStatement, at which point the
    // only fix is a major-version migration. Raise this only after checking that table.
    synth().hasResourceProperties("AWS::RDS::DBCluster", {
      Engine: "aurora-postgresql",
      EngineVersion: Match.stringLikeRegexp("^16\\."),
    });
  });

  test("the function may call the Data API and read the credential", () => {
    // Both halves are required and they are separate permissions: the rds-data actions authorise
    // the call, GetSecretValue authorises the secretArn named inside it. Granting only the first
    // produces an AccessDenied that names the secret and so reads like a secret problem.
    const template = synth();
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(["rds-data:ExecuteStatement"]) }),
        ]),
      }),
    });
    template.hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: Match.arrayWith(["secretsmanager:GetSecretValue"]) }),
        ]),
      }),
    });
  });
});

describe("Korean full-text search", () => {
  test("pg_bigm is preloaded", () => {
    // `CREATE EXTENSION pg_bigm` fails until the library is in shared_preload_libraries, and adding
    // it needs a reboot - so it has to be in the parameter group, not in a migration script.
    //
    // pg_bigm rather than pg_trgm is the substantive point: pg_trgm indexes 3-grams, and a
    // 2-character Korean term (삼성, 번역) produces no trigram at all. The planner then falls back to
    // a sequential scan, so the index exists and does nothing - silently.
    synth().hasResourceProperties("AWS::RDS::DBClusterParameterGroup", {
      Parameters: Match.objectLike({
        shared_preload_libraries: Match.stringLikeRegexp("pg_bigm"),
      }),
    });
  });
});

type ScalingPayload = {
  ServerlessV2ScalingConfiguration: { MinCapacity: number; SecondsUntilAutoPause: number };
};

/**
 * The payload one schedule sends to `rds:ModifyDBCluster`, parsed.
 *
 * `Target.Input` is a JSON string as far as the Scheduler is concerned, but it embeds the cluster
 * identifier - a CloudFormation `Ref` - so CDK emits it as an `Fn::Join` of literal fragments and
 * intrinsics instead of as one string. Reassembling it with the intrinsics stubbed gives valid JSON
 * back, and the assertions below only care about the numbers around them.
 */
function scheduleInput(resource: Record<string, any>): ScalingPayload {
  const input: unknown = resource.Properties.Target.Input;
  if (typeof input === "string") return JSON.parse(input) as ScalingPayload;
  const [delimiter, parts] = (input as { "Fn::Join": [string, unknown[]] })["Fn::Join"];
  const reassembled = parts
    .map((part) => (typeof part === "string" ? part : "<resolved-at-deploy-time>"))
    .join(delimiter);
  return JSON.parse(reassembled) as ScalingPayload;
}

describe("ACU scheduling", () => {
  test("two schedules exist, raising the floor to 0.5 and dropping it to 0", () => {
    const template = synth();
    template.resourceCountIs("AWS::Scheduler::Schedule", 2);

    const schedules = Object.values(template.findResources("AWS::Scheduler::Schedule"));
    const floors = schedules
      .map((s) => scheduleInput(s).ServerlessV2ScalingConfiguration.MinCapacity)
      .sort();
    expect(floors).toEqual([0, 0.5]);
  });

  test("every schedule resends SecondsUntilAutoPause", () => {
    // Omitting it from a ModifyDBCluster that carries a ServerlessV2ScalingConfiguration CLEARS it,
    // and a floor of 0 with no auto-pause duration never actually pauses - silently undoing the
    // entire saving the schedules exist for.
    const schedules = Object.values(synth().findResources("AWS::Scheduler::Schedule"));
    for (const schedule of schedules) {
      const input = scheduleInput(schedule);
      expect(input.ServerlessV2ScalingConfiguration.SecondsUntilAutoPause).toBeGreaterThanOrEqual(
        300,
      );
    }
  });

  test("the floor is held every day of the week, not Mon-Fri", () => {
    /*
     * This was `MON-FRI` and it was a defect, not a saving.
     *
     * A weekend floor is ~29% of the monthly compute bill paid for days when the office is shut -
     * which is a persuasive argument right up to the point where a PM picks up a weekend delivery
     * and meets a paused cluster. The resume stall is several seconds and is indistinguishable from
     * a broken system, on the one day there is nobody around to explain it.
     *
     * CDK renders an unrestricted day-of-week as a literal `?`, so this asserts the absence of any
     * weekday enumeration rather than the presence of a particular spelling.
     */
    const schedules = Object.values(synth().findResources("AWS::Scheduler::Schedule"));
    expect(schedules).toHaveLength(2);
    for (const schedule of schedules) {
      expect(schedule.Properties.ScheduleExpression).toMatch(/^cron\(\d+ \d+ \* \* \? \*\)$/);
    }
  });

  test("the floor is up before the earliest arrival and down after the latest departure", () => {
    /*
     * PMs arrive as early as 06:30 and work as late as 23:00, so the only hours that may carry a
     * zero floor are 00:00-06:00. Written as two bounds rather than as `[0, 6]` because the failure
     * this guards is someone "restoring" the official 09:00-18:00 day (Q11) to save money, and the
     * message should say why that is wrong.
     */
    const schedules = Object.values(synth().findResources("AWS::Scheduler::Schedule"));
    const hourOf = (expression: string) => Number(/^cron\(\d+ (\d+)/.exec(expression)![1]);

    const floorOf = (s: Record<string, any>) =>
      scheduleInput(s).ServerlessV2ScalingConfiguration.MinCapacity;
    const raise = schedules.find((s) => floorOf(s) > 0)!;
    const drop = schedules.find((s) => floorOf(s) === 0)!;

    // KST. The raise must be at or before 06:00 (earliest arrival 06:30), and the drop at midnight
    // (latest departure 23:00) - any later and the floor is paid for hours nobody works.
    expect(hourOf(raise.Properties.ScheduleExpression)).toBeLessThanOrEqual(6);
    expect(hourOf(drop.Properties.ScheduleExpression)).toBe(0);
    expect(raise.Properties.ScheduleExpressionTimezone).toBe("Asia/Seoul");
    expect(drop.Properties.ScheduleExpressionTimezone).toBe("Asia/Seoul");
  });

  test("the scheduler role is scoped to this cluster, not to *", () => {
    // rds:ModifyDBCluster on * would let the schedule resize, rename or disable deletion protection
    // on every cluster in the account.
    synth().hasResourceProperties("AWS::IAM::Policy", {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: "rds:ModifyDBCluster",
            Resource: Match.not("*"),
          }),
        ]),
      }),
    });
  });
});

describe("report exports", () => {
  test("the export bucket is SSE-KMS, not SSE-S3", () => {
    // `aws_s3.query_export_to_s3` requires SSE-KMS. With SSE-S3 the export fails, and the error
    // surfaces from inside PostgreSQL as a generic S3 problem that says nothing about encryption.
    synth().hasResourceProperties("AWS::S3::Bucket", {
      BucketName: Match.stringLikeRegexp("^neotms-exports-"),
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.arrayWith([
          Match.objectLike({
            ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: "aws:kms" }),
          }),
        ]),
      }),
    });
  });

  test("the cluster has a role it can assume to write exports", () => {
    // The PutObject is made by the CLUSTER, not by the Lambda, because query_export_to_s3 runs
    // inside PostgreSQL.
    synth().hasResourceProperties("AWS::RDS::DBCluster", {
      AssociatedRoles: Match.arrayWith([Match.objectLike({ RoleArn: Match.anyValue() })]),
    });
  });
});

describe("production data protection", () => {
  test("the cluster is retained and deletion-protected", () => {
    const clusters = synth("prod").findResources("AWS::RDS::DBCluster");
    expect(Object.keys(clusters)).toHaveLength(1);
    for (const cluster of Object.values(clusters)) {
      expect(cluster.DeletionPolicy).toBe("Retain");
      expect(cluster.Properties.DeletionProtection).toBe(true);
    }
  });

  test("dev is destroyable, so a stack can actually be torn down", () => {
    const clusters = synth("dev").findResources("AWS::RDS::DBCluster");
    for (const cluster of Object.values(clusters)) {
      expect(cluster.DeletionPolicy).toBe("Delete");
    }
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

  test("settings this repo owns are not overridable", () => {
    // The list is deliberately limited to values registered on LPX. Capacity, retention and region
    // are decisions that should arrive as a reviewed commit, not as a flag someone typed once.
    for (const key of ["maxAcu", "logRetentionDays", "region", "protectData", "resourcePrefix"]) {
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
