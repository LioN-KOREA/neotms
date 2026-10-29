// SPDX-License-Identifier: MIT
//
// The Supabase Postgres project, reached over the Supavisor pooler.
//
// This construct creates almost nothing. That is the point of the variant: the database is not an
// AWS resource at all, so there is no VPC, no cluster, no parameter group, no storage key, no
// subnet group and no capacity schedule. What is left in AWS is one Secrets Manager secret holding
// the password, and the IAM grant that lets the function read it.
//
// Three consequences of that, each of which used to be a paragraph of machinery on the Aurora
// variant:
//
//   * No NAT Gateway, still - and this time not because of a trick. The Aurora variant avoided the
//     ~$43/month NAT Gateway by keeping the Lambda outside the VPC and reaching the cluster over
//     the Data API's HTTPS endpoint. Here the database is simply on the public internet behind TLS,
//     so there is no VPC in the stack for anyone to accidentally attach a Lambda to.
//   * No 1 MiB result cap and no `DatabaseResumingException`. Both were Data API properties, and
//     both shaped the application: the cap is why report exports went out through
//     `aws_s3.query_export_to_s3`, and the resuming exception is why every statement needed a
//     bespoke retry wrapper. Over a socket, neither exists.
//   * No multi-statement restriction, which is what unblocks the schema bootstrap. The Data API
//     rejects a payload containing more than one statement, and the cluster sat in an isolated
//     subnet, so loading `db/002_tables.sql` needed either a bastion or a custom resource. Here it
//     is one `psql -f`.
//
// ## What is paid for that
//
// A static password. There is no IAM authentication, no SigV4, and no short-lived credential: the
// function reads a long-lived password out of Secrets Manager and logs in with it. Anyone who
// obtains it has the database until a human changes it, and nothing in this stack will notice.
//
// Two mitigations are in place and neither is sufficient on its own. The password is never an
// environment variable (those are readable by anyone with console access to the function, and
// rotating one means a redeploy), and PostgresUtils discards its connection pool and re-reads the
// secret when PostgreSQL answers `28P01`, so changing the password takes effect within one request
// instead of presenting as a multi-hour intermittent outage. Rotation is still a manual act someone
// has to remember - see the README section this comment's counterpart lives in.

import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { NeotmsStageConfig, poolerUser } from "../config/NeotmsConfig.js";

export interface NeotmsSupabaseProps {
  readonly config: NeotmsStageConfig;
}

/** The key inside the secret's JSON. Read by PostgresUtils; changing it breaks every connection. */
export const NEOTMS_DB_SECRET_PASSWORD_KEY = "password";

export class NeotmsSupabase extends Construct {
  /** Holds `{"password": "..."}`. Read at first use, never an env var. */
  public readonly secret: secretsmanager.Secret;
  public readonly host: string;
  public readonly port: number;
  public readonly databaseName: string;
  /** `postgres.<project-ref>`, or empty if the project ref has not been configured yet. */
  public readonly user: string;
  public readonly caCertPem: string;

  constructor(scope: Construct, id: string, props: NeotmsSupabaseProps) {
    super(scope, id);
    const { config } = props;
    const { supabase } = config;

    this.host = supabase.poolerHost;
    this.port = supabase.poolerPort;
    this.databaseName = supabase.databaseName;
    this.user = poolerUser(supabase.projectRef);
    this.caCertPem = supabase.caCertPem;

    /*
     * The password, as a placeholder that someone must overwrite.
     *
     * Unlike the Aurora variant, CDK cannot generate this credential - the authoritative copy lives
     * at Supabase, and anything generated here would simply be wrong. So what is deployed is a
     * random string of the right shape, and the deploy is not finished until a human runs the
     * `put-secret-value` in the README. The alternatives were both worse:
     *
     *   * Putting the real password in `secretObjectValue` or `SecretStringValue.unsafePlainText`
     *     writes it into the CloudFormation template, where it is visible in the console's stack
     *     Parameters/Resources view, in `cdk.out/`, and in any CI log that prints a diff - and
     *     `cdk.out/` is one `.gitignore` mistake away from the repository.
     *   * Referencing a secret a human created by hand (`fromSecretNameV2`) synthesises an ARN
     *     without checking it exists, so a missing secret deploys cleanly and then fails at runtime
     *     as a ResourceNotFound from inside the connection pool.
     *
     * A generated placeholder fails in the one way that is unambiguous: PostgreSQL answers 28P01,
     * which `exceptionToErrorResponse` reports as an authentication failure naming the secret.
     *
     * IMPORTANT: `generateSecretString` is only evaluated when CloudFormation creates or REPLACES
     * this resource, so repeated `cdk deploy`s do not clobber the real password. Editing the
     * generation options below, however, is an update that regenerates it - which would look like
     * the database suddenly rejecting every request for no reason. Treat this block as frozen once
     * the stack is live.
     */
    this.secret = new secretsmanager.Secret(this, "DbPassword", {
      secretName: `${config.resourcePrefix}/db/supabase`,
      description:
        "Supabase Postgres password for the Supavisor pooler. Deployed as a PLACEHOLDER - " +
        "overwrite with the project's real password (see README, 'Database credential'). " +
        "Static and long-lived: rotate it on a schedule.",
      generateSecretString: {
        /*
         * `{}` - deliberately NOT `{"username": ...}`.
         *
         * Putting the username in here would be friendlier to read in the console and would be a
         * live landmine: the template is part of `generateSecretString`, so it would make the
         * password's generation depend on `projectRef`, and the first `-c supabaseProjectRef=...`
         * after go-live would be an update that regenerates it. The symptom is the whole system
         * rejecting every request immediately after a deploy that changed nothing visible.
         *
         * Nothing in this object may reference `config`. The username is in the function's
         * environment, where it belongs; it is not a secret.
         */
        secretStringTemplate: "{}",
        generateStringKey: NEOTMS_DB_SECRET_PASSWORD_KEY,
        passwordLength: 32,
        /*
         * Dropped from the placeholder for the same reason as on the Aurora variant: these are the
         * characters that break shell quoting, `psql` URIs and JDBC URLs. It matters more here,
         * because here a human does paste this password into a terminal.
         */
        excludeCharacters: "\"@/\\'`$%&;<>|(){}[]",
      },
      /*
       * RETAIN in production, and the recovery window with it.
       *
       * Deleting this secret does not delete the database - the data is at Supabase and survives a
       * `cdk destroy` entirely. That cuts both ways: the stack can be torn down safely, but losing
       * the secret while the project lives on means the password has to be reset at Supabase before
       * anything can connect again.
       */
      removalPolicy: config.protectData ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    /*
     * Tagged so the rotation question has an answer in the console.
     *
     * A static credential with no rotation schedule attached is invisible: Secrets Manager's
     * "Rotation" column just says "Disabled", which is also what it says for a secret that is
     * rotated by hand every quarter. This tag is the only machine-readable trace of the intended
     * discipline, and it is what an auditor or a new maintainer would search for.
     */
    cdk.Tags.of(this.secret).add("RotationPolicy", "manual-90-days");
  }

  /**
   * Lets a function read the database password.
   *
   * One grant where the Aurora variant needed two. `grantDataApiAccess` had to authorise both the
   * `rds-data` call and the `GetSecretValue` for the secret named in it, and granting only the
   * first produced an AccessDenied that named the secret - which read as a secret problem rather
   * than a missing API grant. Here there is no second half to forget.
   *
   * Note what is NOT granted: nothing authorises the connection itself. Any principal anywhere with
   * the password can connect, which is the trade this variant makes.
   */
  public grantReadCredential(grantee: iam.IGrantable): void {
    this.secret.grantRead(grantee);
  }

  /**
   * A `psql` invocation for the host, with the password left out.
   *
   * Emitted as a stack output so the schema bootstrap and any manual query start from a command
   * that is known to have the right host, port, user and database - the four things that are easy
   * to get wrong, and whose failure modes (ENOTFOUND, "Tenant or user not found") say nothing about
   * which one was wrong. The password is read from the environment by `psql` itself; it is not
   * interpolated here, because a stack output is plaintext and world-readable within the account.
   */
  public get psqlCommand(): string {
    return `PGPASSWORD=$NEOTMS_DB_PASSWORD psql -h ${this.host} -p ${this.port} -U ${this.user} -d ${this.databaseName}`;
  }
}
