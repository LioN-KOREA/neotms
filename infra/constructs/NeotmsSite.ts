// SPDX-License-Identifier: MIT
//
// The console: a private S3 bucket, a CloudFront distribution, and the API on the same origin.
//
// ## Why the API is a behaviour on this distribution rather than its own hostname
//
// This is the load-bearing decision in the whole construct, and it is not about tidiness.
//
// The browser's credential is an HttpOnly session cookie set by NeotmsSessionManager with
// `SameSite=Lax`. "Lax" means the browser sends it on top-level navigations and on same-site
// requests - and NOT on a cross-site `fetch`. So if the console were served from
// `console.example.com` and the API answered on `abc123.execute-api.ap-northeast-2.amazonaws.com`,
// then `POST /api/auth/refresh` would arrive with no cookie, the backend would answer 401, and the
// user would be signed out roughly every hour with no way to diagnose it from the browser - the
// request looks perfectly normal, it is simply missing a header the devtools cookie tab still shows
// as present.
//
// The alternatives are both worse. `SameSite=None` would make the cookie available to any site that
// can make a cross-origin request, which on a cookie-bearing financial API is a session-theft
// primitive. Keeping the refresh token in the browser instead would put a 24-hour credential inside
// reach of any XSS. One origin costs nothing and removes the question.
//
// One origin also means the console calls the API with RELATIVE paths (`/api/v0/projects`), so there
// is no API base URL to configure, no build-time environment variable, and no way for a development
// build to be shipped pointing at the wrong backend.
//
// ## Why a CloudFront Function instead of `errorResponses`
//
// The usual SPA recipe maps 403 and 404 to `/index.html` with status 200 via the distribution's
// custom error responses. That recipe is wrong here, and quietly so: custom error responses apply to
// the WHOLE distribution, including responses from the API origin. `GET /api/v0/projects/999` would
// stop returning 404 and start returning the console's HTML with status 200 - so `notFound()` in
// NeotmsResult, which exists specifically so a hidden row and a missing row are indistinguishable,
// would instead be answered with a successful-looking page the client cannot parse.
//
// A viewer-request function attached only to the default behaviour rewrites extension-less paths to
// `/index.html` and leaves everything under `/api/*` untouched. It costs $0.10 per million
// invocations and is the only thing here that touches the request path.

import * as cdk from "aws-cdk-lib/core";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as fs from "node:fs";
import * as path from "node:path";
import { Construct } from "constructs";
import { NeotmsStageConfig } from "../config/NeotmsConfig.js";
import { NeotmsApi } from "./NeotmsApi.js";

export interface NeotmsSiteProps {
  readonly config: NeotmsStageConfig;
  readonly api: NeotmsApi;
  /**
   * The built SPA, relative to the directory holding cdk.json.
   *
   * Relative to the working directory rather than to this file for the same reason as the Lambda's
   * `entry` in NeotmsApi: the CDK CLI always runs the app command from the cdk.json directory, and
   * `import.meta.dirname` would pin this file to ESM output while the infra code typechecks as
   * `module: "preserve"`.
   */
  readonly siteDistPath?: string;
}

export class NeotmsSite extends Construct {
  public readonly bucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;
  /** `https://...` - the console's address, and the origin the API must accept. */
  public readonly siteUrl: string;

  constructor(scope: Construct, id: string, props: NeotmsSiteProps) {
    super(scope, id);
    const { config, api } = props;
    const stack = cdk.Stack.of(this);

    /*
     * Private, with no website hosting and no public policy.
     *
     * CloudFront reaches it through Origin Access Control, so the bucket itself is never a public
     * endpoint. That matters beyond hygiene: a publicly readable bucket is a second, unlogged way to
     * fetch the console's JavaScript, which means a stale build can be served indefinitely after a
     * CloudFront invalidation is thought to have removed it.
     */
    this.bucket = new s3.Bucket(this, "SiteBucket", {
      bucketName: `${config.resourcePrefix}-console-${stack.account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      /*
       * Destroyed with the stack even in production, unlike the data buckets.
       *
       * This holds build output and nothing else. Retaining it on a `cdk destroy` would leave a
       * bucket whose globally-unique name then blocks the next deployment from recreating it - a
       * failure mode with no upside, since the contents are reproducible by `npm run build`.
       */
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    /*
     * Rewrite extension-less paths to the SPA shell.
     *
     * `/projects`, `/projects/4821` and `/auth/callback` are React Router routes, not S3 keys, so
     * S3 would answer 404 for a bookmarked link or a page reload. The check is "does the last path
     * segment contain a dot" rather than an allow-list of routes, so adding a route to the router
     * needs no infrastructure change - which is the same reason the API has one catch-all route.
     */
    const spaRewrite = new cloudfront.Function(this, "SpaRewrite", {
      functionName: `${config.resourcePrefix}-spa-rewrite`,
      comment: "Serve index.html for client-side routes",
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/')) {
    request.uri = '/index.html';
    return request;
  }
  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}
`),
    });

    /*
     * The API's regional domain, assembled rather than parsed out of `apiEndpoint`.
     *
     * `httpApi.apiEndpoint` is `https://<id>.execute-api.<region>.amazonaws.com`, and an
     * `HttpOrigin` wants the host only. Building it from `apiId` keeps this a plain string
     * concatenation; splitting the endpoint with `Fn::Select`/`Fn::Split` would work too but puts
     * two more intrinsics in the template for no gain.
     *
     * `urlSuffix` rather than a literal `amazonaws.com` so this is still correct in the China
     * partitions, which `cdk.json` lists under `core:target-partitions`.
     */
    const apiOrigin = new origins.HttpOrigin(
      `${api.httpApi.apiId}.execute-api.${stack.region}.${stack.urlSuffix}`,
      {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        /*
         * Longer than the function's own 29-second timeout, so a slow report is answered rather
         * than cut off by the CDN. CloudFront's default is 30s; a request that reaches 29s has
         * already been given up on by API Gateway, so 31s is the smallest value that can never be
         * the thing that failed.
         */
        readTimeout: cdk.Duration.seconds(31),
      },
    );

    this.distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: `NEOTMS console (${config.stage})`,
      defaultRootObject: "index.html",
      /*
       * PRICE_CLASS_200 includes the Seoul and Tokyo edges; PRICE_CLASS_100 does not.
       *
       * Everyone who uses this system is in Korea, so the cheaper class would route every request
       * through North America or Europe and add roughly 150-200ms to each one. The saving on this
       * traffic volume is cents.
       */
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // Q22 confirmed the office network is IPv6-capable; this is also CloudFront's default.
      enableIpv6: true,
      /*
       * No `minimumProtocolVersion` here, deliberately.
       *
       * It only takes effect alongside a custom `certificate`. On the default `*.cloudfront.net`
       * certificate the security policy is fixed at TLSv1 and CDK ignores the setting - with a
       * warning on every synth. Leaving it in would therefore assert a TLS floor this distribution
       * does not actually have, and it would print a permanent warning next to the
       * `neotms:site-not-built` one, which is the warning that stops a bare `cdk deploy` from
       * replacing a working console with a placeholder. A warning nobody reads protects nothing.
       *
       * When a custom domain is added, set BOTH here: `certificate` (ACM, us-east-1) and
       * `minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021`.
       */

      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        /*
         * Vite fingerprints every asset filename, so the immutable-asset cache policy is safe for
         * `/assets/*`. `index.html` is the one file that must not be cached long - it is what points
         * at the fingerprinted names - and that is handled by the invalidation below rather than by
         * splitting it into its own behaviour.
         */
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        functionAssociations: [
          {
            function: spaRewrite,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },

      additionalBehaviors: {
        /*
         * The API, uncached and with the viewer's cookies and headers passed through.
         *
         * `CACHING_DISABLED` is not a performance oversight: every one of these responses is either
         * a mutation or is scoped to the caller's row-level view (see `scopeClause`), so a cached
         * copy served to a second user would be a data leak with no error anywhere.
         *
         * `ALL_VIEWER_EXCEPT_HOST_HEADER` is the specific policy needed. `ALL_VIEWER` would forward
         * the viewer's `Host`, and API Gateway rejects a request whose Host is not its own with a
         * 403 that mentions neither CloudFront nor the header - one of the harder misconfigurations
         * to read backwards from the symptom.
         */
        "/api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          /*
           * The function's CORS headers vary by request origin, so they must not be rewritten or
           * collapsed by the CDN. `CORS_ALLOW_PREFLIGHT_AND_SECURITY_HEADERS` would ADD its own
           * `Access-Control-*`, producing two of each - which browsers reject outright. Hence no
           * response-headers policy at all on this behaviour.
           */
          compress: true,
        },
      },
    });

    this.siteUrl = `https://${this.distribution.distributionDomainName}`;

    /*
     * Upload the build, and invalidate the shell.
     *
     * `/index.html` and `/` only, not `/*`. A wildcard invalidation on every deploy would throw away
     * the fingerprinted assets too - which are immutable and were just re-uploaded under new names
     * anyway - so it would cost a cache-miss storm for no benefit. (The first 1,000 invalidation
     * paths per month are free; `/*` counts as one path, so this is about cache warmth, not cost.)
     */
    const distPath = props.siteDistPath ?? path.join(process.cwd(), "frontend", "dist");
    const distExists = fs.existsSync(path.join(distPath, "index.html"));

    if (!distExists) {
      /*
       * Synthesis must still work without a build, because the CDK assertion tests synth this stack
       * and `jest` does not run Vite. The placeholder keeps `cdk synth` and the tests green; the
       * warning is what stops a bare `cdk deploy` from quietly replacing a working console with it.
       *
       * `npm run deploy` builds first, so the placeholder is only ever reached by someone running
       * the CDK CLI directly.
       */
      cdk.Annotations.of(this).addWarningV2(
        "neotms:site-not-built",
        `No built console found at ${distPath}. A placeholder page will be deployed instead. ` +
          "Run `npm run deploy` (which builds the frontend first) rather than `cdk deploy`.",
      );
    }

    new s3deploy.BucketDeployment(this, "SiteDeployment", {
      destinationBucket: this.bucket,
      sources: distExists
        ? [s3deploy.Source.asset(distPath)]
        : [
            s3deploy.Source.data(
              "index.html",
              "<!doctype html><html lang=ko><meta charset=utf-8>" +
                "<title>라이온코리아 TMS 시스템</title>" +
                "<p>이 배포에는 콘솔 빌드가 포함되지 않았습니다. <code>npm run deploy</code> 로 다시 배포해 주세요.",
            ),
          ],
      distribution: this.distribution,
      distributionPaths: ["/", "/index.html"],
      /*
       * Clears keys that are no longer in the build.
       *
       * Vite's filenames are content-hashed, so without this every deploy leaves the previous
       * build's chunks behind forever. They are harmless but they accumulate, and after a year
       * nobody can tell which objects the current site actually uses.
       */
      prune: true,
      /*
       * 512MB rather than the 128MB default. The uploader is a Lambda that unzips the asset and
       * copies it object by object; the console is a few megabytes, and the extra memory buys
       * proportional CPU, so the deployment step finishes in seconds instead of a minute.
       */
      memoryLimit: 512,
    });

    this.allowOwnOriginOnApi(api);
  }

  /**
   * Add this distribution's own origin to the API's CORS allow-list.
   *
   * Needed because the console's requests are same-ORIGIN but not origin-less: browsers attach an
   * `Origin` header to every POST, PATCH and DELETE even when the target is the same site. The
   * handler refuses any request carrying an `Origin` it does not recognise (see `handleRequest`), so
   * without this every save from the deployed console would 403 while every read kept working - a
   * failure that looks like a permissions bug and is not.
   *
   * It has to happen here rather than in `NeotmsConfig` because `distributionDomainName` is only
   * known after deployment. Mutating the function's environment keeps that one deploy, and the
   * dependency order works out: the distribution refers to the HTTP API's id, the function's
   * environment refers to the distribution, and only the API's *integration* refers to the function
   * - so there is no cycle.
   */
  private allowOwnOriginOnApi(api: NeotmsApi): void {
    api.fn.addEnvironment(
      "NEOTMS_ALLOWED_ORIGIN_URLS",
      [...api.allowedOriginUrls, this.siteUrl].join(","),
    );
  }
}
