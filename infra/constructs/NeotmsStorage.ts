// SPDX-License-Identifier: MIT
//
// Buckets, the session table, and the key the report exports are encrypted with.
//
// Three stores, each with a different reason to exist:
//
//   * Attachments - the quotes, POs, delivered translations and reference files staff upload against
//     a job. The legacy system holds roughly 1.5-2GB of these in total (Q2), so S3 Standard costs
//     cents and tiering would cost more in transition requests than it saved.
//   * Exports - where `aws_s3.query_export_to_s3` writes a report too large for the Data API's 1 MiB
//     result limit, and where the XLSX renderer picks it up. Short-lived by design.
//   * Sessions - DynamoDB, not the database. See the table below for why.

import * as cdk from "aws-cdk-lib/core";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import { NeotmsStageConfig } from "../config/NeotmsConfig.js";

export interface NeotmsStorageProps {
  readonly config: NeotmsStageConfig;
}

export class NeotmsStorage extends Construct {
  public readonly attachmentBucket: s3.Bucket;
  public readonly exportBucket: s3.Bucket;
  public readonly exportKey: kms.Key;
  public readonly sessionTable: dynamodb.TableV2;
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
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: config.allowedOriginUrls,
          allowedHeaders: ["*"],
          exposedHeaders: ["ETag"],
          maxAge: 3000,
        },
      ],
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
     * The export key.
     *
     * `aws_s3.query_export_to_s3` requires the destination bucket to be SSE-KMS. With SSE-S3 the
     * export fails, and the failure surfaces as a generic S3 error from inside PostgreSQL that says
     * nothing about encryption - which is why this is a dedicated key with a comment rather than an
     * inherited default.
     */
    this.exportKey = new kms.Key(this, "ExportKey", {
      alias: `${config.resourcePrefix}-exports`,
      description: "SSE-KMS key for aws_s3.query_export_to_s3 report exports",
      enableKeyRotation: true,
      removalPolicy: retain ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    /*
     * Exports.
     *
     * A staging area, not a record. The cluster writes the CSV here, the renderer turns it into the
     * XLSX the managers actually asked for (Q25 - hand them a raw CSV and they will ask for it in
     * Excel), the browser downloads it, and seven days later it is gone. Keeping them longer would
     * mean keeping stale financial snapshots nobody has a reason to trust.
     */
    this.exportBucket = new s3.Bucket(this, "ExportBucket", {
      bucketName: `${config.resourcePrefix}-exports-${cdk.Stack.of(this).account}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.exportKey,
      bucketKeyEnabled: true,
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
     * In DynamoDB rather than in the PostgreSQL cluster, for one reason: a session read happens on
     * every single authenticated request, and if it hit the database then the cluster could never be
     * allowed to pause. That would turn the off-hours ACU floor from 0 back to 0.5 and cost roughly
     * $48/month - which is half the entire monthly budget, spent on checking cookies.
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
  }
}
