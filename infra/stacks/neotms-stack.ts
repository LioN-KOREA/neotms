// SPDX-License-Identifier: MIT
//
// One stack, four constructs.
//
// Not split into a data stack and an app stack, even though that is the usual shape. The reason is
// that cross-stack references in CDK become CloudFormation exports, and an export cannot be changed
// while anything imports it - so renaming a bucket or changing the cluster identifier turns into a
// three-deploy dance. For a system two people maintain (Q17), a single stack that deploys in one
// step is worth more than the blast-radius isolation, especially since the data resources carry
// `RETAIN` and deletion protection in production anyway.
//
// Construction order below is load-bearing: storage creates the export bucket and its KMS key, the
// database needs both to build the role that `aws_s3.query_export_to_s3` assumes, the API needs the
// database to grant Data API access against, and the site needs the API because it serves `/api/*`
// as a behaviour on its own distribution - which is what keeps the SPA and the API same-origin and
// so keeps the `SameSite=Lax` session cookie working. See NeotmsSite's header.

import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import { NeotmsStageConfig } from "../config/NeotmsConfig.js";
import { NeotmsAcuScheduler } from "../constructs/NeotmsAcuScheduler.js";
import { NeotmsApi } from "../constructs/NeotmsApi.js";
import { NeotmsDatabase } from "../constructs/NeotmsDatabase.js";
import { NeotmsSite } from "../constructs/NeotmsSite.js";
import { NeotmsStorage } from "../constructs/NeotmsStorage.js";

export interface NeotmsStackProps extends cdk.StackProps {
  readonly config: NeotmsStageConfig;
}

export class NeotmsStack extends cdk.Stack {
  public readonly database: NeotmsDatabase;
  public readonly storage: NeotmsStorage;
  public readonly api: NeotmsApi;
  public readonly site: NeotmsSite;

  constructor(scope: Construct, id: string, props: NeotmsStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.storage = new NeotmsStorage(this, "Storage", { config });

    this.database = new NeotmsDatabase(this, "Database", {
      config,
      exportBucket: this.storage.exportBucket,
      exportKey: this.storage.exportKey,
    });

    this.api = new NeotmsApi(this, "Api", {
      config,
      database: this.database,
      storage: this.storage,
    });

    this.site = new NeotmsSite(this, "Site", {
      config,
      api: this.api,
    });

    new NeotmsAcuScheduler(this, "AcuScheduler", {
      config,
      cluster: this.database.cluster,
    });

    cdk.Tags.of(this).add("Project", "NEOTMS");
    cdk.Tags.of(this).add("Stage", config.stage);

    // --- Outputs -----------------------------------------------------------
    //
    // Deliberately few. These are the values a human actually needs to type somewhere else: the
    // console URL goes to the users and into the LPX client registration, and the cluster ARN plus
    // secret ARN are what the migration scripts and any manual `aws rds-data execute-statement`
    // need.

    new cdk.CfnOutput(this, "ConsoleUrl", {
      value: this.site.siteUrl,
      description:
        "The console. `${ConsoleUrl}/auth/callback` and `/auth/logout` must be registered on the " +
        "LPX OIDC client, and this is also the value for NEOTMS_DEV_API_TARGET in frontend/.env.local.",
    });
    /*
     * The API's own execute-api origin, which is NOT where the browser talks to it.
     *
     * The console reaches the API at `${ConsoleUrl}/api/*`. This endpoint is listed anyway because
     * it is what `curl` and the Lambda's own logs refer to, and because a request sent here directly
     * bypasses the distribution - useful when the question is "is this CloudFront or the function".
     * Note that such a request carries no browser Origin, so it is not subject to the CORS refusal.
     */
    new cdk.CfnOutput(this, "ApiEndpoint", {
      value: this.api.httpApi.apiEndpoint,
      description: "The API's direct origin, bypassing CloudFront. For curl and for debugging only.",
    });
    new cdk.CfnOutput(this, "DbClusterArn", {
      value: this.database.cluster.clusterArn,
      description: "Pass as --resource-arn to aws rds-data execute-statement.",
    });
    new cdk.CfnOutput(this, "DbSecretArn", {
      value: this.database.secret.secretArn,
      description: "Pass as --secret-arn to aws rds-data execute-statement.",
    });
    new cdk.CfnOutput(this, "AttachmentBucketName", {
      value: this.storage.attachmentBucket.bucketName,
      description: "Destination for the legacy attachment migration.",
    });
  }
}
