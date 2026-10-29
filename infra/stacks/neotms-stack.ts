// SPDX-License-Identifier: MIT
//
// One stack, four constructs.
//
// Not split into a data stack and an app stack, even though that is the usual shape. The reason is
// that cross-stack references in CDK become CloudFormation exports, and an export cannot be changed
// while anything imports it - so renaming a bucket turns into a three-deploy dance. For a system
// two people maintain (Q17), a single stack that deploys in one step is worth more than the
// blast-radius isolation, especially since the data resources carry `RETAIN` in production anyway.
//
// Construction order below is load-bearing in one place only, and it is less tangled than on the
// Aurora variant: the database no longer needs anything from storage (it used to need the export
// bucket and its KMS key, to build the role `aws_s3.query_export_to_s3` assumed), the API needs the
// database to grant the credential read against, and the site needs the API because it serves
// `/api/*` as a behaviour on its own distribution - which is what keeps the SPA and the API
// same-origin and so keeps the `SameSite=Lax` session cookie working. See NeotmsSite's header.
//
// Note what is NOT here any more: NeotmsAcuScheduler. It existed to move the Aurora Serverless v2
// capacity floor between 0 and 0.5 ACU on a KST schedule, because the floor was the single largest
// variable in the bill. Supabase bills a flat monthly compute price per project, so there is no
// floor to schedule and nothing a cron could save.

import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import { NeotmsStageConfig } from "../config/NeotmsConfig.js";
import { NeotmsApi } from "../constructs/NeotmsApi.js";
import { NeotmsSite } from "../constructs/NeotmsSite.js";
import { NeotmsStorage } from "../constructs/NeotmsStorage.js";
import { NeotmsSupabase } from "../constructs/NeotmsSupabase.js";

export interface NeotmsStackProps extends cdk.StackProps {
  readonly config: NeotmsStageConfig;
}

export class NeotmsStack extends cdk.Stack {
  public readonly database: NeotmsSupabase;
  public readonly storage: NeotmsStorage;
  public readonly api: NeotmsApi;
  public readonly site: NeotmsSite;

  constructor(scope: Construct, id: string, props: NeotmsStackProps) {
    super(scope, id, props);
    const { config } = props;

    this.storage = new NeotmsStorage(this, "Storage", { config });

    this.database = new NeotmsSupabase(this, "Database", { config });

    this.api = new NeotmsApi(this, "Api", {
      config,
      database: this.database,
      storage: this.storage,
    });

    this.site = new NeotmsSite(this, "Site", {
      config,
      api: this.api,
    });

    cdk.Tags.of(this).add("Project", "NEOTMS");
    cdk.Tags.of(this).add("Stage", config.stage);

    // --- Outputs -----------------------------------------------------------
    //
    // Deliberately few. These are the values a human actually needs to type somewhere else: the
    // console URL goes to the users and into the LPX client registration, and the secret ARN plus
    // the psql command are what the schema bootstrap, the legacy migration and any manual query
    // need. Nothing here is a secret - a stack output is plaintext and readable by anyone with
    // `cloudformation:DescribeStacks` - which is why the psql command has no password in it.

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
    new cdk.CfnOutput(this, "DbSecretArn", {
      value: this.database.secret.secretArn,
      description:
        "Secrets Manager ARN of the Supabase password. Deployed as a PLACEHOLDER - overwrite it " +
        "with `aws secretsmanager put-secret-value` before anything will connect. See README.",
    });
    /*
     * The bootstrap command, emitted because it is the step most likely to be got wrong.
     *
     * Four values have to agree - host, port, user and database - and every way of getting one
     * wrong fails with a message that names none of them: a bad host is ENOTFOUND, a bare
     * `postgres` username on the pooler is "Tenant or user not found", and port 5432 on the direct
     * endpoint simply hangs, because that endpoint is IPv6-only without the paid add-on.
     */
    new cdk.CfnOutput(this, "DbPsqlCommand", {
      value: this.database.psqlCommand,
      description:
        "Run the schema bootstrap with this, after exporting NEOTMS_DB_PASSWORD. " +
        "Append `-f db/001_extensions.sql` etc.",
    });
    new cdk.CfnOutput(this, "AttachmentBucketName", {
      value: this.storage.attachmentBucket.bucketName,
      description: "Destination for the legacy attachment migration.",
    });
  }
}
