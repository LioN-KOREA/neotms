// SPDX-License-Identifier: MIT
//
// Buckets and the session table.
//
// Three stores, each with a different reason to exist:
//
//   * Attachments - the quotes, POs, delivered translations and reference files staff upload against
//     a job. The legacy system holds roughly 1.5-2GB of these in total (Q2), so S3 Standard costs
//     cents and tiering would cost more in transition requests than it saved.
//   * Exports - where the FUNCTION spills a report too large for Lambda's 6MB response payload, and
//     where the presigned download points. Short-lived by design.
//   * Sessions - DynamoDB, not the database. See the table below for why.
//
// Gone from the Aurora variant: the SSE-KMS `exportKey`. It existed only because
// `aws_s3.query_export_to_s3` refuses to write to a bucket that is not SSE-KMS, and that function
// existed only because the RDS Data API capped a result set at 1 MiB. Over a plain socket the
// database is not involved in an export at all, so the bucket takes SSE-S3 like the others and the
// key, its alias, its rotation and the two grants that referenced it are all simply deleted.

import * as cdk from "aws-cdk-lib/core";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { NeotmsStageConfig } from "../config/NeotmsConfig.js";

export interface NeotmsStorageProps {
  readonly config: NeotmsStageConfig;
}

/**
 * The CORS rule that makes a browser PUT to the attachment bucket legal.
 *
 * Named once because two places need it: the configured developer origins, below, and the deployed
 * console's own origin, which is only known once the distribution exists (see
 * `allowOriginOnAttachments`). Two rules built from the same shape cannot drift in the headers or
 * the methods they allow - only in the origins, which is the one thing that differs.
 */
function attachmentCorsRule(allowedOrigins: string[]): s3.CorsRule {
  return {
    allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
    allowedOrigins,
    allowedHeaders: ["*"],
    exposedHeaders: ["ETag"],
    maxAge: 3000,
  };
}

export class NeotmsStorage extends Construct {
  public readonly attachmentBucket: s3.Bucket;
  public readonly exportBucket: s3.Bucket;
  public readonly sessionTable: dynamodb.TableV2;
  public readonly attachmentTable: dynamodb.TableV2;
  public readonly logArchiveBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: NeotmsStorageProps) {
    super(scope, id);
    const { config } = props;
    const retain = config.protectData;

    /*
     * Attachments.
     *
     * Uploads never pass through the Lambda: the browser gets a presigned PUT and sends the bytes
     * straight to S3. That keeps a 100MB file out of the function's 6MB response payload limit and
     * off the function's duration bill, and it is the only reason a 100MB cap is even plausible on a
     * serverless backend. The CORS rule below is what makes a browser PUT legal - without it the
     * preflight fails and the upload looks like a network error.
     */
    this.attachmentBucket = new s3.Bucket(this, "AttachmentBucket", {
      bucketName: `${config.resourcePrefix}-attachments-${cdk.Stack.of(this).account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: retain,
      /*
       * No rule at all when the list is empty, rather than a rule allowing nobody.
       *
       * S3 requires every CORS rule to name at least one origin; `AllowedOrigins: []` is refused at
       * deploy time with a `MalformedXML` that names neither the bucket nor the rule. Production's
       * `allowedOriginUrls` is deliberately empty (see NeotmsConfig), so without this guard the
       * production stack could not create this bucket at all - and the deployed console gets its
       * access from `allowOriginOnAttachments` below, not from this list.
       */
      cors:
        config.allowedOriginUrls.length > 0
          ? [attachmentCorsRule([...config.allowedOriginUrls])]
          : [],
      lifecycleRules: [
        {
          /*
           * Sweep abandoned presigned uploads.
           *
           * A presigned PUT that the browser never completes leaves nothing behind, but a
           * multipart upload that stalls leaves billable parts that are invisible in the console's
           * object list. This is the rule that stops them accumulating for years.
           */
          id: "abort-incomplete-multipart",
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
        {
          /*
           * Objects under `tmp/` are presign staging: the key is handed out, and the row that makes
           * it permanent is only written on confirm. Anything still here after a day was abandoned.
           */
          id: "expire-staging",
          prefix: "tmp/",
          expiration: cdk.Duration.days(1),
        },
        {
          /*
           * Files mailed to a translator, which the PO request mail links to for 21 days.
           *
           * The number has to match ATTACHMENT_TTL_DAYS in the Lambda, and the two are enforced at
           * different layers for different failures: the DynamoDB TTL stops the LINK working, and
           * this stops the FILE existing. Without this rule a revoked or expired link would leave
           * the bytes in the bucket forever, which is the opposite of what a translator is told
           * when they are given a link that expires.
           *
           * Deliberately a day longer than the token. S3 lifecycle expiry runs once a day and
           * DynamoDB TTL sweeps within ~48h of the timestamp, so making them equal would
           * occasionally delete the object while a live token still pointed at it - and that
           * failure reads as "the link is broken" rather than "the link has expired".
           */
          id: "expire-mailed-attachments",
          prefix: "po-request/",
          expiration: cdk.Duration.days(22),
        },
        ...(retain
          ? [
              {
                /*
                 * Deleted-object versions are the undo for a mistaken delete, not an archive. A
                 * month is long enough for someone to notice and ask.
                 */
                id: "expire-noncurrent-versions",
                noncurrentVersionExpiration: cdk.Duration.days(30),
              },
            ]
          : []),
      ],
      removalPolicy: retain ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !retain,
    });

    /*
     * Exports.
     *
     * A staging area, not a record. The FUNCTION renders the XLSX the managers actually asked for
     * (Q25 - hand them a raw CSV and they will ask for it in Excel); if it fits in the 6MB response
     * payload it goes straight back, and if it does not it lands here and the caller is handed a
     * presigned URL. Seven days later it is gone. Keeping them longer would mean keeping stale
     * financial snapshots nobody has a reason to trust.
     *
     * SSE-S3, not SSE-KMS. On the Aurora variant this bucket had to be SSE-KMS because
     * `aws_s3.query_export_to_s3` refuses anything else; nothing writes here from inside PostgreSQL
     * now, so the managed key is one less resource, one less grant and one less $1/month.
     */
    this.exportBucket = new s3.Bucket(this, "ExportBucket", {
      bucketName: `${config.resourcePrefix}-exports-${cdk.Stack.of(this).account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        { id: "expire-exports", expiration: cdk.Duration.days(7) },
        { id: "abort-incomplete-multipart", abortIncompleteMultipartUploadAfter: cdk.Duration.days(1) },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    /*
     * Log archive (Q14).
     *
     * CloudWatch keeps six months hot; this is where the older copy lands. Glacier Instant Retrieval
     * rather than Deep Archive: the reason to keep an audit log is that someone will eventually ask
     * "who changed this PO", and a 12-hour restore turns a question into a project. Instant
     * Retrieval is ~$0.004/GB-month, so on this volume the saving from Deep Archive is pennies.
     */
    this.logArchiveBucket = new s3.Bucket(this, "LogArchiveBucket", {
      bucketName: `${config.resourcePrefix}-log-archive-${cdk.Stack.of(this).account}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: "to-glacier-ir",
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(config.logGlacierAfterDays),
            },
          ],
          // Korean tax law wants business records kept five years; this is the outer bound, not a
          // target. Nothing reads a seven-year-old application log.
          expiration: cdk.Duration.days(365 * 5),
        },
      ],
      removalPolicy: retain ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !retain,
    });

    /*
     * Sessions.
     *
     * In DynamoDB rather than in PostgreSQL. On the Aurora variant the reason was the ACU floor: a
     * session read on every authenticated request would have kept the cluster from ever pausing, at
     * roughly $48/month to check cookies. Supabase bills flat compute, so that argument is gone and
     * a different one carries the decision - CONNECTIONS. A cookie check that went to Postgres would
     * take a Supavisor server connection out of the function's budget of 40 (20 reserved executions
     * x pool max 2) on every request, including the ones that end in a 401 and read nothing. See
     * NeotmsSession.dbops.ts.
     *
     * DynamoDB on-demand for a few dozen staff is cents, TTL expiry is free, and a session is
     * exactly the key-value lookup DynamoDB is good at. The refresh-lease condition expression (see
     * NeotmsSession.dbops) also needs a single-item conditional write, which is native here.
     */
    this.sessionTable = new dynamodb.TableV2(this, "SessionTable", {
      tableName: `${config.resourcePrefix}-sessions`,
      partitionKey: { name: "NTPK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "NTSK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      /*
       * TTL is the only thing that deletes a session record, so the attribute name has to match the
       * one the ops module writes. DynamoDB deletes within ~48h of the timestamp, not at it, which
       * is why the application also checks the expiry itself rather than trusting absence.
       */
      timeToLiveAttribute: "NTTTL",
      encryption: dynamodb.TableEncryptionV2.awsManagedKey(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: retain },
      removalPolicy: retain ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    /*
     * Attachment tokens.
     *
     * One row per file mailed to a translator: token -> object key, with a 21-day TTL. It exists
     * because Hiworks cannot attach files and an S3 presigned URL cannot live 21 days - SigV4 caps
     * one at 7, and a URL signed with the function's own temporary credentials dies within hours.
     * The mail therefore links to this system, and a click turns a token into a short-lived
     * presigned URL. See NeotmsAttachment.dbops.ts.
     *
     * A SECOND table rather than a prefix in the session table, though the key shape is the same.
     * The two hold different things for different readers: a session row identifies a staff member
     * and is read on every authenticated request; a row here authorises one file and is read by
     * somebody outside the company clicking a link in a mail. One table would mean one name, one
     * set of metrics and one blast radius for two unrelated concerns - and a table called
     * `-sessions` holding translators' download tokens is a name that misleads whoever reads it
     * next. On-demand billing makes the second table cost nothing until it is used.
     */
    this.attachmentTable = new dynamodb.TableV2(this, "AttachmentTable", {
      tableName: `${config.resourcePrefix}-attachments`,
      partitionKey: { name: "NTPK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "NTSK", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      /*
       * The attribute name must match what NeotmsAttachment.dbops.ts writes, and the value must be
       * SECONDS. DynamoDB silently never expires a row whose TTL is in milliseconds, and nothing
       * notices because the application checks the expiry itself - the rows would just accumulate
       * forever.
       */
      timeToLiveAttribute: "NTTTL",
      encryption: dynamodb.TableEncryptionV2.awsManagedKey(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: retain },
      removalPolicy: retain ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });
  }

  /**
   * Let a browser served from `origin` upload attachments.
   *
   * This exists because `config.allowedOriginUrls` cannot name the deployed console. That list is
   * what a DEVELOPER's browser is served from; the console itself lives on a CloudFront domain that
   * does not exist until the distribution is created, and production's list is empty on purpose. So
   * the rule built in the constructor allows the console nothing, and a presigned PUT from the
   * deployed console fails its preflight.
   *
   * That failure is worth spelling out, because it is why this was missed: a refused preflight
   * produces no S3 access-log entry, no 4xx metric and no CloudWatch log line anywhere in this
   * stack. The browser reports a bare network error, so the upload looks like the FUNCTION's
   * problem - or like the user's connection - rather than like a bucket setting.
   *
   * A second rule rather than an edit to the first: S3 answers a preflight from the first rule whose
   * origin matches, so two rules read as "the origins we configured" and "this deployment's own
   * console" instead of one list that silently mixes the two.
   *
   * The twin of `NeotmsSite.allowOwnOriginOnApi`, and for the same reason. Called from the stack,
   * which is where both constructs exist; the site has no other business with storage.
   */
  public allowOriginOnAttachments(origin: string): void {
    this.attachmentBucket.addCorsRule(attachmentCorsRule([origin]));
  }
}
