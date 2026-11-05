// SPDX-License-Identifier: MIT
//
// The scheduled exchange-rate fetcher, and the EventBridge rule that drives it.
//
// The second and last Lambda in this stack. `NeotmsApi`'s header argues at length for one function
// serving every route, and the header of lambdas/neotms/nodejs/fxrate.ts sets out why this is not a
// counter-example - no caller to route, a failure that must not consume the API's reserved
// concurrency, and a grant (`secretsmanager:GetSecretValue` on the KEXIM key) that the API function
// must not hold. The short version: the argument for one function is about ROUTES, and this has none.
//
// ## What it is for
//
// `fx_rate` is a live input to reporting as of db/014_fx_rates.sql - every report, dashboard and
// project rollup joins `fx_rate_latest` to convert a foreign-currency total into KRW. Nothing else
// in the system writes that table, so without this construct the view is permanently empty and every
// open position falls back to its stored KRW figure. That fallback is deliberate and not an outage
// (see NeotmsMoney.ts), which is what makes it safe to deploy this separately from the API.
//
// ## Why no DLQ, no retries, no alarm
//
// `onFailure`, `retryAttempts` and a CloudWatch alarm are all deliberately absent. The next run is
// five minutes away and will do exactly the same work against the same upstream, so a retry only
// makes a failed fetch cost two API calls instead of one, and a dead-letter queue would collect
// events whose payload is empty (EventBridge sends a schedule tick, not data - there is nothing in
// the message to reprocess). What a queue of empty ticks cannot tell you, the function's own error
// metric can, which is why the handler rethrows rather than swallowing.
//
// The thing actually worth alarming on is not an error at all - it is `fx_rate_latest` going stale
// while every invocation reports success, which happens if KEXIM starts answering with an empty
// result set. That is a query against the database, not a Lambda metric, and the staleness SELECT at
// the foot of db/014_fx_rates.sql is where it lives.

import * as cdk from "aws-cdk-lib/core";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "node:path";
import { Construct } from "constructs";
import { NeotmsStageConfig } from "../config/NeotmsConfig.js";
import { NeotmsSupabase } from "./NeotmsSupabase.js";

export interface NeotmsFxRateProps {
  readonly config: NeotmsStageConfig;
  readonly database: NeotmsSupabase;
}

export class NeotmsFxRate extends Construct {
  public readonly fn: NodejsFunction;
  public readonly rule: events.Rule;

  constructor(scope: Construct, id: string, props: NeotmsFxRateProps) {
    super(scope, id);
    const { config, database } = props;

    this.fn = new NodejsFunction(this, "Fetcher", {
      functionName: `${config.resourcePrefix}-fxrate`,
      // Resolved from the working directory for the same reason NeotmsApi's entry is - see the
      // comment there. esbuild bundles per entry point, so this artifact contains none of the API's
      // route handlers even though the two share a source tree.
      entry: path.join(process.cwd(), "lambdas/neotms/nodejs/fxrate.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      /*
       * 256MB, where the API gets 1024 - and the difference is the whole point.
       *
       * NeotmsApi buys CPU with memory because its slow parts are CPU-bound (JWKS verification, an
       * ExcelJS render). This function's entire runtime is two network waits: one HTTPS call to
       * KEXIM and one multi-row upsert. More CPU does not make a socket answer faster, so the extra
       * memory would be billed and not used. The GB-seconds argument that makes 1024 free over
       * there does not apply to work that is not compute.
       */
      memorySize: 256,
      /*
       * 30 seconds, chosen from the upstream's behaviour rather than from a default.
       *
       * KEXIM's endpoint is a public-sector service that occasionally takes several seconds to
       * answer and occasionally hangs outright. The fetcher's own `AbortSignal.timeout` gives up
       * first (see NeotmsFxFetcher), so reaching this ceiling means something the fetcher did not
       * anticipate - and the right outcome then is a recorded failure, not a container billed for a
       * minute of waiting.
       */
      timeout: cdk.Duration.seconds(30),
      environment: {
        NEOTMS_STAGE: config.stage,
        /*
         * The database block, minus everything this function has no use for.
         *
         * No session table, no buckets, no OIDC settings, no Mailgun - this function has no caller
         * to authenticate and nothing to render. The password is absent for the same reason it is
         * absent from the API's block; PostgresUtils reads it from the secret below.
         */
        NEOTMS_DB_HOST: database.host,
        NEOTMS_DB_PORT: String(database.port),
        NEOTMS_DB_USER: database.user,
        NEOTMS_DB_NAME: database.databaseName,
        NEOTMS_DB_SECRET_ARN: database.secret.secretArn,
        NEOTMS_DB_CA_CERT: database.caCertPem,
        // The NAME of the secret, never the key. NeotmsFxSecret.ts explains why at length.
        NEOTMS_FX_SECRET_NAME: config.fx.secretName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
        NODE_OPTIONS: "--enable-source-maps",
      },
      // Identical to NeotmsApi's bundling, and that is the intent rather than a copy waiting to
      // drift: the two entry points import the same dbops and the same Postgres pool, so a build
      // setting that is right for one is right for the other. The ESM/mainFields/banner trio is
      // explained there.
      bundling: {
        format: OutputFormat.ESM,
        target: "node22",
        minify: true,
        sourceMap: true,
        externalModules: [],
        mainFields: ["module", "main"],
        banner:
          "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
      },
      /*
       * Its own log group, which is the point rather than a side effect.
       *
       * "Did the rate update today" is a question about this schedule. Sharing the API's log group
       * would mean answering it by filtering every request of the day for a `[fxrate]` prefix; here
       * the group holds 288 one-line entries and the answer is the last of them.
       */
      logGroup: new logs.LogGroup(this, "FetcherLogs", {
        logGroupName: `/aws/lambda/${config.resourcePrefix}-fxrate`,
        retention: config.protectData ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_MONTH,
        removalPolicy: config.protectData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      }),
      /*
       * One. Not a prudent ceiling - a correctness one.
       *
       * Two concurrent runs would write the same quotes for the same business day through the same
       * `ON CONFLICT` upsert, so the outcome is harmless but every pair of them holds two of
       * Supavisor's forty client connections that the API is waiting on. More to the point, a run
       * that overlaps itself means the previous one has not finished, which only happens when the
       * upstream is hanging - and the correct response to a hanging upstream is one pending request,
       * not a growing fleet of them.
       *
       * This also protects the API's own reservation: unreserved concurrency is drawn from the
       * account pool that the API's 20 are carved out of.
       */
      reservedConcurrentExecutions: 1,
    });

    // --- Permissions -------------------------------------------------------

    // The database password, exactly as the API function reads it.
    database.grantReadCredential(this.fn);

    /*
     * The KEXIM key, granted on an ARN this construct BUILDS rather than on a Secret it owns.
     *
     * The secret is created out of band - it holds one credential issued to a person by a government
     * service, so there is no value for CDK to put in it and no CloudFormation resource to import
     * without hardcoding a random suffix. `formatArn` with a `-??????` wildcard is the documented
     * way to name a secret by its logical name: Secrets Manager appends six random characters to
     * every secret's ARN, and IAM matches `?` as exactly one character, so this grants the one
     * secret called `config.fx.secretName` and nothing else that happens to share a prefix. Writing
     * `${name}*` instead would also match `neotms/erapikey-backup`, which is the kind of over-grant
     * that is invisible until it matters.
     *
     * Skipped entirely when the name is blank, because an IAM statement with an ARN ending in
     * `secret:-??????` would grant a pattern matching every six-character secret name in the
     * account. A blank name is a supported configuration (see NeotmsFxConfig), so this branch is a
     * real path and not defensive clutter: the fetcher logs that it has no key to read and writes
     * nothing, which is the correct behaviour for a half-configured stack.
     */
    if (config.fx.secretName) {
      this.fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["secretsmanager:GetSecretValue"],
          resources: [
            cdk.Stack.of(this).formatArn({
              service: "secretsmanager",
              resource: "secret",
              resourceName: `${config.fx.secretName}-??????`,
              arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
            }),
          ],
        }),
      );
    }

    // --- The schedule ------------------------------------------------------

    /*
     * `Schedule.rate`, not `Schedule.cron`.
     *
     * A cron expression would let the schedule say "11:05 KST on weekdays", which is when KEXIM
     * actually publishes - and that is precisely what should NOT be encoded here. A fixed-time
     * schedule that happens to run during an upstream outage leaves every report a day stale until
     * tomorrow, and it would also have to carry a timezone and a holiday calendar to be correct.
     * A flat rate needs neither: see `scheduleMinutes` in NeotmsFxConfig for the cost of being
     * wrong in this direction, and the fetcher's own walk-back logic for how it recovers a day it
     * missed.
     *
     * EventBridge Scheduler (the newer service) would also do this. The classic rule is kept
     * because it is one construct with no IAM role of its own to manage, and nothing here needs
     * flexible time windows or a timezone.
     */
    this.rule = new events.Rule(this, "Schedule", {
      ruleName: `${config.resourcePrefix}-fxrate-schedule`,
      description: "Fetches KRW exchange rates from the Korea Export-Import Bank open API",
      schedule: events.Schedule.rate(cdk.Duration.minutes(config.fx.scheduleMinutes)),
      // `retryAttempts: 0` on the target rather than relying on the default. EventBridge retries a
      // failed invocation for up to 24 hours by default, which here means a KEXIM outage produces a
      // backlog of identical attempts competing with the five-minute schedule that supersedes them.
      targets: [new targets.LambdaFunction(this.fn, { retryAttempts: 0 })],
    });
  }
}
