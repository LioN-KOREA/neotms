#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// CDK app entry point.
//
//   cdk deploy                  -> the dev stage
//   cdk deploy -c stage=prod    -> production
//
// The values LPX owns - the OIDC client id, the access authority, and the redirect URIs - can be
// supplied per stage in NeotmsConfig or overridden here with `-c key=value`. See
// NEOTMS_AUTH_CONTEXT_KEYS for the list and for why only those five are overridable:
//
//   npm run deploy -- -c stage=prod -c authClientId=... -c appAuthorityId=...
//
// (`npm run deploy -- ...` appends to the end of the script, which is where `cdk deploy` is, so the
// flags land on the CDK CLI and not on the frontend build that runs first.)
//
// The stack is NOT environment-agnostic, and that is on purpose. Three things here need a real
// account and region at synth time rather than a CloudFormation pseudo-parameter: the two S3 bucket
// names (globally unique, so they carry the account id), the KMS key policies, and the
// `aws:SourceAccount` condition on the Scheduler's trust policy. An agnostic stack would synth and
// then fail at deploy with a message about an unresolved token, which is a worse way to learn this.

import * as cdk from "aws-cdk-lib/core";
import { resolveStageConfig } from "./config/NeotmsConfig.js";
import { NeotmsStack } from "./stacks/neotms-stack.js";

const app = new cdk.App();

const stage = app.node.tryGetContext("stage") as string | undefined;
const config = resolveStageConfig(stage, app.node);

/*
 * The account comes from the ambient CLI credentials unless the config pins one.
 *
 * Pinning it is the safer habit once the account question is settled (Q23 - probably a separate IAM
 * account under the same root email): with `account` set, deploying with the wrong profile fails
 * immediately instead of creating a second copy of production somewhere unexpected.
 */
const account = config.account ?? process.env.CDK_DEFAULT_ACCOUNT;
if (!account) {
  throw new Error(
    "No AWS account resolved. Set one in NeotmsConfig, or run with credentials (CDK_DEFAULT_ACCOUNT).",
  );
}

new NeotmsStack(app, config.stage === "prod" ? "NeotmsStack" : `NeotmsStack-${config.stage}`, {
  config,
  env: { account, region: config.region },
  description: `NEOTMS (${config.stage}) - Aurora Serverless v2 + Data API, Lambda outside the VPC`,
  // Tags on the stack rather than only on resources, so Cost Explorer can answer "what does NEOTMS
  // cost" without every construct having remembered to tag itself.
  tags: { Project: "NEOTMS", Stage: config.stage },
});

app.synth();
