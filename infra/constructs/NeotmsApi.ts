// SPDX-License-Identifier: MIT
//
// The HTTP API and the single Lambda behind it.
//
// ## One function, every route
//
// A monolithic function rather than one per endpoint, and the reason is maintenance headcount
// rather than architecture: this system is looked after by two people, one of whom knows AWS
// (Q17). Forty functions means forty log groups to search, forty sets of permissions to keep in
// step, and forty cold starts to warm. One function means `rou3` does the dispatch in-process, the
// whole API shares one warm container, and a route added to the handler array needs no
// infrastructure change at all.
//
// The usual argument against this is least privilege - the login endpoint ends up holding the same
// IAM rights as the reporting endpoint. That is a real cost, and it is accepted here because the
// alternative's cost (a role nobody notices has drifted) is worse at this size. If this ever grows
// to the point where it matters, the seam to split on is the handler array.
//
// ## No authorizer on the API
//
// There is no API Gateway JWT authorizer. Authorization happens inside the function, and that is
// deliberate rather than lazy:
//
//   * A JWT authorizer can check a token's signature and claims. It cannot check the `SY_ROLE_AUTH`
//     equivalent - the 48-menu x 5-action matrix - nor the row-level view scope that comes from the
//     staff row (Q9). So a second check inside the function is needed regardless, and two places
//     that decide "may this request proceed" is one more than should exist.
//   * The browser's credential is an HttpOnly session cookie, not a bearer token. A JWT authorizer
//     reads the Authorization header; the cookie-to-token exchange is the backend's job.
//
// ## Not in the VPC
//
// `vpc` is deliberately absent below, and on this variant there is no VPC in the stack to join: the
// database is a Supabase project reached over TLS on the public internet. See NeotmsSupabase's
// header. Adding a VPC here would pull in a NAT Gateway at ~$43/month to restore the function's
// internet egress - which it needs both for the pooler and for the LPX OIDC endpoints.

import * as cdk from "aws-cdk-lib/core";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "node:path";
import { Construct } from "constructs";
import { NeotmsStageConfig } from "../config/NeotmsConfig.js";
import { NeotmsStorage } from "./NeotmsStorage.js";
import { NeotmsSupabase } from "./NeotmsSupabase.js";

export interface NeotmsApiProps {
  readonly config: NeotmsStageConfig;
  readonly database: NeotmsSupabase;
  readonly storage: NeotmsStorage;
}

export class NeotmsApi extends Construct {
  public readonly fn: NodejsFunction;
  public readonly httpApi: apigwv2.HttpApi;
  /**
   * The configured CORS allow-list, kept so NeotmsSite can APPEND to it.
   *
   * `addEnvironment` replaces a variable rather than extending it, so whoever adds the distribution's
   * own domain has to rewrite the whole list. Reading it back off the construct rather than
   * re-deriving it from config means there is one definition of what the function was given, and
   * adding a second appender later cannot silently drop the first one's entry.
   */
  public readonly allowedOriginUrls: string[];

  constructor(scope: Construct, id: string, props: NeotmsApiProps) {
    super(scope, id);
    const { config, database, storage } = props;
    this.allowedOriginUrls = [...config.allowedOriginUrls];

    this.fn = new NodejsFunction(this, "Handler", {
      functionName: `${config.resourcePrefix}-api`,
      /*
       * Resolved from the working directory, not from this file.
       *
       * The CDK CLI always runs the `app` command with its working directory set to the one holding
       * cdk.json, so this is deterministic. The alternative - `import.meta.dirname` - would pin this
       * file to ESM output, and the repository's tsconfig emits CommonJS for the infra code.
       */
      entry: path.join(process.cwd(), "lambdas/neotms/nodejs/index.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      /*
       * 1024MB is not about memory.
       *
       * Lambda allocates CPU in proportion to memory, and this function's slow parts are CPU-bound,
       * not RAM-bound: JWKS signature verification on a cold start, and ExcelJS rendering a report
       * into XLSX. At 256MB the XLSX render on a few thousand rows takes long enough to be
       * noticeable; at 1024MB it does not. Since Lambda bills GB-seconds, a 4x faster run at 4x the
       * memory costs the same - so the lower setting buys nothing and loses time.
       */
      memorySize: 1024,
      /*
       * 29 seconds, matching API Gateway's own hard ceiling.
       *
       * Anything longer cannot be observed by the caller anyway - the gateway has already returned
       * 504 - so a 60-second timeout would only mean paying for 31 seconds of work whose result is
       * thrown away.
       */
      timeout: cdk.Duration.seconds(29),
      environment: {
        NEOTMS_STAGE: config.stage,
        /*
         * Host, port, user, database name - and the ARN of the secret holding the password.
         *
         * The password itself is NOT here, and that is the one rule this block exists to state. A
         * Lambda environment variable is readable by anyone with `lambda:GetFunction`, it appears
         * in the CloudFormation template, and changing it means a redeploy - so a credential in
         * one cannot be rotated faster than a release cycle. PostgresUtils reads the secret at
         * first use and re-reads it when PostgreSQL answers 28P01.
         */
        NEOTMS_DB_HOST: database.host,
        NEOTMS_DB_PORT: String(database.port),
        NEOTMS_DB_USER: database.user,
        NEOTMS_DB_NAME: database.databaseName,
        NEOTMS_DB_SECRET_ARN: database.secret.secretArn,
        NEOTMS_DB_CA_CERT: database.caCertPem,
        NEOTMS_SESSION_TABLE_NAME: storage.sessionTable.tableName,
        NEOTMS_ATTACHMENT_BUCKET_NAME: storage.attachmentBucket.bucketName,
        NEOTMS_EXPORT_BUCKET_NAME: storage.exportBucket.bucketName,
        NEOTMS_ALLOWED_ORIGIN_URLS: config.allowedOriginUrls.join(","),
        NEOTMS_OIDC_ISSUER: config.auth.oidcIssuer,
        NEOTMS_AUTH_CLIENT_ID: config.auth.authClientId,
        NEOTMS_OIDC_REDIRECT_URI: config.auth.oidcRedirectUri,
        NEOTMS_OIDC_POST_LOGOUT_REDIRECT_URI: config.auth.oidcPostLogoutRedirectUri,
        NEOTMS_APP_AUTHORITY_ID: config.auth.appAuthorityId,
        /*
         * The authority that may bootstrap an empty NEOTMS - `lpx.admin.access`.
         *
         * Unlike every other value in this block, BLANK IS A SUPPORTED SETTING here: it removes the
         * bootstrap path entirely and is what production should carry once real administrators
         * exist. So this is not part of `isAuthConfigComplete()` in NeotmsEnv, and a blank value
         * must not be read as a half-finished deploy.
         */
        NEOTMS_BOOTSTRAP_AUTHORITY_ID: config.auth.bootstrapAuthorityId,
        NEOTMS_MG_SECRET_NAME: config.mail.mailgunSecretName,
        NEOTMS_MG_EMAIL_DOMAIN: config.mail.mailgunEmailDomain,
        NEOTMS_MAIL_FROM_ADDRESS: config.mail.mailFromAddress,
        NEOTMS_MAIL_FROM_NAME: config.mail.mailFromName,
        // Keeps the SDK from re-resolving credentials on every call in a warm container.
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        format: OutputFormat.ESM,
        target: "node22",
        minify: true,
        sourceMap: true,
        /*
         * Bundle the AWS SDK rather than using the runtime's copy.
         *
         * The managed runtime ships a v3 SDK, but its exact minor version changes underneath you
         * without a deploy. Bundling means the SDK that was tested is the SDK that runs - and with
         * tree-shaking, three or four v3 clients add well under a megabyte.
         */
        externalModules: [],
        /*
         * openid-client and jose are pure ESM. Without this, esbuild resolves the CommonJS
         * condition and the build fails on a `require` of an ESM-only package - a confusing error
         * that reads like a missing dependency.
         */
        mainFields: ["module", "main"],
        banner:
          // Some transitive dependencies still reach for `require`. Shimming it keeps an ESM bundle
          // working without falling back to a CommonJS output format.
          "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
      },
      logGroup: new logs.LogGroup(this, "HandlerLogs", {
        logGroupName: `/aws/lambda/${config.resourcePrefix}-api`,
        retention: config.protectData ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_MONTH,
        removalPolicy: config.protectData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      }),
      /*
       * A concurrency ceiling, and on this variant it is a hard requirement rather than prudence.
       *
       * The database is behind Supavisor, which has a finite client-connection limit per project.
       * Each warm container holds a pool of up to 2 clients (see `max` in PostgresUtils), so this
       * number multiplied by 2 is the worst-case client count this stack can present. Unbounded
       * Lambda concurrency would let a traffic spike - or one runaway retry loop - exhaust the
       * pooler, at which point Supavisor answers "max client connections reached" and EVERY
       * request fails, including the ones that would have succeeded. That is a far worse failure
       * than queueing, which is what a reserved ceiling produces instead.
       *
       * 20 x 2 = 40 clients, comfortably inside the pooler's allowance on the Pro plan and well
       * above what a few dozen staff generate. Raise it only together with `max`, and only after
       * checking the project's pooler limit in the dashboard.
       */
      reservedConcurrentExecutions: 20,
    });

    // --- Permissions -------------------------------------------------------
    //
    // One database grant, not two. The Aurora variant needed `rds-data:*` to authorise the call AND
    // `GetSecretValue` to authorise the secret named inside it; here IAM has no say in whether the
    // connection is allowed - the password is the only thing standing in front of the database - so
    // all that is granted is the read of that password.
    database.grantReadCredential(this.fn);
    storage.sessionTable.grantReadWriteData(this.fn);
    // Read-write rather than put-only: the presign flow needs to HEAD the object on confirm, and a
    // delete needs to remove it.
    storage.attachmentBucket.grantReadWrite(this.fn);
    // Spill target for a rendered report too large for Lambda's 6MB response payload. The function
    // both writes it and presigns a read of it. No KMS grant: with the Data API's 1 MiB cap gone,
    // nothing inside PostgreSQL writes here, so the bucket no longer needs SSE-KMS.
    storage.exportBucket.grantReadWrite(this.fn);

    /*
     * CORS is NOT configured on the HTTP API.
     *
     * It is handled in the function instead, because an API Gateway CORS configuration answers the
     * preflight before the function sees it - which means a rejected origin gets a 403 with no CORS
     * headers and the browser reports an opaque network failure. The handler distinguishes allowed
     * from rejected origins itself and attaches headers to refusals too, so the UI can tell 401
     * from "the API is unreachable". Two mechanisms both setting `Access-Control-Allow-Origin` also
     * produce duplicate headers, which browsers reject outright.
     */
    this.httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName: `${config.resourcePrefix}-api`,
      description: "NEOTMS API - all routes proxied to one function",
      createDefaultStage: true,
    });

    /*
     * A single catch-all route.
     *
     * `rou3` inside the function owns the routing table, so declaring routes here as well would mean
     * two tables to keep in step - and the failure mode of that drift is a 404 from the gateway for
     * a route the function implements, which looks like a code bug and is not.
     */
    this.httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      /*
       * The construct id must not be "Default", and this is not a style preference.
       *
       * CDK drops the path components named `Default` and `Resource` when it generates a logical id.
       * The integration lands at `.../ANY--{proxy+}/Default/Resource` and the route itself at
       * `.../ANY--{proxy+}/Resource`, so with the id "Default" both collapse to the same logical id
       * and synthesis fails with «SectionAlreadyContains» - an error that names a logical id nobody
       * wrote and points at no line of code.
       */
      integration: new integrations.HttpLambdaIntegration("Proxy", this.fn, {
        /*
         * Payload 2.0 is what `apiGatewayRequestEventToRouterRequest` expects, and the version that
         * splits cookies into their own array rather than concatenating them into one header.
         */
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      }),
    });

    const accessLogs = new logs.LogGroup(this, "AccessLogs", {
      logGroupName: `/aws/apigateway/${config.resourcePrefix}-api`,
      retention: config.protectData ? logs.RetentionDays.SIX_MONTHS : logs.RetentionDays.ONE_MONTH,
      removalPolicy: config.protectData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    /*
     * Access logging, configured on the escape hatch because the L2 does not expose it.
     *
     * Worth the ugliness: this is the only record of who called what and how long it took that
     * survives independently of the application's own logging. When the question is "the site was
     * slow at 14:00", `integrationLatency` here answers it without needing the function to have
     * been instrumented in advance.
     */
    const defaultStage = this.httpApi.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    defaultStage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({
        requestId: "$context.requestId",
        ip: "$context.identity.sourceIp",
        requestTime: "$context.requestTime",
        httpMethod: "$context.httpMethod",
        routeKey: "$context.routeKey",
        path: "$context.path",
        status: "$context.status",
        protocol: "$context.protocol",
        responseLength: "$context.responseLength",
        integrationLatency: "$context.integrationLatency",
        responseLatency: "$context.responseLatency",
      }),
    };
    accessLogs.grantWrite(new iam.ServicePrincipal("apigateway.amazonaws.com"));
  }
}
