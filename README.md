# NEOTMS — infrastructure

AWS CDK app for the NEOTMS console and API. One stack, five constructs, deployed to
**ap-northeast-2 (Seoul)**.

```
CloudFront ──┬── /*      → S3 (private, OAC)        the React console
             └── /api/*  → HTTP API → Lambda        one bundled function, rou3 router
                                        │
                                        ├── Aurora Serverless v2 (PostgreSQL 16) via RDS Data API
                                        ├── DynamoDB                                    sessions
                                        └── S3                            attachments + exports
```

Two things about this shape drive most of the instructions below:

- **The Lambda is not attached to the VPC.** It reaches Aurora over the RDS Data API with SigV4, so
  there is no NAT Gateway and no VPC endpoint to pay for. The cluster itself sits in
  `PRIVATE_ISOLATED` subnets with `natGateways: 0` and is not publicly accessible — **the Data API is
  the only way in.** `psql` cannot reach it from anywhere.
- **The API is a behaviour on the console's own CloudFront distribution**, not a separate hostname.
  That is what keeps the SPA and the API same-origin, which is what keeps the `SameSite=Lax` session
  cookie working. It also means the console carries no backend address at all.

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| Node.js | Developed on v24. `npm ci` at the repo root, which also installs the CDK CLI locally. |
| AWS credentials | Must be present at **synth** time, not just deploy time — see below. |
| `cdk bootstrap` | Once per account+region. |

```bash
npm ci
npx cdk bootstrap aws://<account-id>/ap-northeast-2
```

Credentials are needed at synth because `infra/NeotmsApp.ts` resolves the account as
`config.account ?? process.env.CDK_DEFAULT_ACCOUNT`, and **neither stage sets `account`** — so it
always comes from your credentials. With none resolved, synth throws:

> No AWS account resolved. Set one in NeotmsConfig, or run with credentials (CDK_DEFAULT_ACCOUNT).

This is deliberate: the stack is **not** environment-agnostic. Bucket names carry the account id, and
the KMS key policies and the Scheduler trust policy's `aws:SourceAccount` all name it. See the header
of `infra/NeotmsApp.ts`.

---

## 2. Stages

| Stage | Flag | Stack name | Resource prefix | Data on destroy |
|---|---|---|---|---|
| `dev` (default) | *(none)* | `NeotmsStack-dev` | `neotms-dev` | destroyed |
| `prod` | `-c stage=prod` | `NeotmsStack` | `neotms` | retained (`protectData: true`) |

An unknown stage throws at synth and lists the valid ones. Both stages are defined in
`infra/config/NeotmsConfig.ts` — that file is the single place configuration lives.

Other per-stage differences worth knowing: `dev` allows `http://localhost:5173` as a CORS origin and
keeps logs 30 days; `prod` allows no extra origins and keeps logs 180 days. `prod` needs no origin
entry for itself, because `NeotmsSite` adds its own distribution URL to the API's allow-list
automatically.

---

## 3. Configuration

### What you edit in the repo

Everything except five values. Capacity, log retention, resource prefixes, mail settings and origins
are decisions this repo owns, so changing them is a reviewed commit in
`infra/config/NeotmsConfig.ts` — not a flag somebody typed once.

### What you pass at deploy time

Exactly five keys may be overridden with `-c key=value`, because they are **registered on the LPX
account system** rather than chosen here:

```
authClientId   appAuthorityId   oidcIssuer   oidcRedirectUri   oidcPostLogoutRedirectUri
```

`prod` deliberately ships `authClientId`, `oidcRedirectUri` and `oidcPostLogoutRedirectUri` **empty**,
because they depend on a hostname that only exists after the first deploy. `isAuthConfigComplete()`
fails closed, so a prod deploy without them comes up and refuses every login rather than
half-working.

```bash
npm run deploy -- \
  -c stage=prod \
  -c authClientId=<client-id-from-LPX> \
  -c oidcRedirectUri=https://<console-host>/auth/callback \
  -c oidcPostLogoutRedirectUri=https://<console-host>/auth/logout
```

Three traps, all real:

- **The three auth values only work as a set.** LPX reports any mismatch between them as an opaque
  `invalid_request`, so overriding one usually means overriding all three.
- **`-c key` with the `=value` forgotten is silently dropped by the CDK CLI.** It arrives as
  `undefined` and the stage default applies. Quiet, but the safe direction — verified against
  aws-cdk 2.1146.
- **A non-string or blank value throws** rather than being written through. A boolean would reach the
  Lambda as the string `"true"`, which is non-empty, so `isAuthConfigComplete()` would pass and then
  every account would be refused.

Note the `--` in `npm run deploy -- -c …`. npm appends the extra arguments to the end of the script,
which is `npm run build:site && cdk deploy`, so they land on `cdk deploy`. Without `--` they are
swallowed by npm.

---

## 4. Deploy

```bash
npm run deploy                      # dev
npm run deploy -- -c stage=prod     # prod (plus the auth overrides above)
```

`npm run deploy` is `npm run build:site && cdk deploy`. **Use it instead of bare `cdk deploy`.**
`cdk deploy` on its own does not build the console, and `NeotmsSite` will then deploy a placeholder
page in place of a working one. It warns (`neotms:site-not-built`) rather than failing, because synth
has to work without a build for the assertion tests to run.

Every `cdk` command type-checks first — `cdk.json` runs the app as
`npx tsc -p tsconfig.app.json && npx tsx infra/NeotmsApp.ts`, so `tsconfig.app.json` is the deploy
gate.

### Outputs

| Output | What it is for |
|---|---|
| `ConsoleUrl` | The console. Register `${ConsoleUrl}/auth/callback` and `/auth/logout` on the LPX OIDC client. Also the value for `NEOTMS_DEV_API_TARGET`. |
| `ApiEndpoint` | The API's direct `execute-api` origin, bypassing CloudFront. `curl` and debugging only — not where the browser talks to it. |
| `DbClusterArn` | `--resource-arn` for `aws rds-data execute-statement`. |
| `DbSecretArn` | `--secret-arn` for the same. |
| `AttachmentBucketName` | Destination for the legacy attachment migration. |

### The first deploy of a stage is a three-step loop

The console's hostname is an output of the deploy, but the OIDC redirect URIs must be byte-identical
to what LPX has registered — so the first deploy cannot know them:

1. Deploy once with no auth overrides. Login will not work yet; everything else comes up.
2. Take `ConsoleUrl` and register `${ConsoleUrl}/auth/callback` and `${ConsoleUrl}/auth/logout` on the
   LPX OIDC client. Note the client id it issues.
3. Deploy again with `-c authClientId=… -c oidcRedirectUri=… -c oidcPostLogoutRedirectUri=…`.

For `dev` this is already done: the committed defaults point at `http://localhost:5173`, because dev
is driven from the Vite dev server rather than from the deployed console.

---

## 5. Database bootstrap

The SQL in `db/` must be applied **once per cluster, in order**, after the first deploy. The database
name is `neotms`; the application user is `neotms_app`, whose generated credentials live in the secret
named by `DbSecretArn` (`<prefix>/db/app`).

| File | Contents |
|---|---|
| `001_extensions.sql` | `pg_bigm`, `pg_trgm`, `aws_s3`, `aws_commons` |
| `002_tables.sql` | schema |
| `003_indexes.sql` | 16 `gin_bigm_ops` indexes plus the trigram ones |
| `004_rollup.sql` | rollup aggregation |
| `005_code_sequences.sql` | code sequences |

### Before anything else: confirm `pg_bigm`

A **blocking** check, documented at the top of `001_extensions.sql`:

```sql
SELECT * FROM pg_available_extensions WHERE name = 'pg_bigm';
```

`pg_bigm` is not in the default Aurora extension set on every minor version, and it is not
interchangeable with `pg_trgm`. Korean search terms here are very often exactly two characters
(삼성, 번역, 계약). `pg_trgm`'s GIN operator class cannot index a pattern shorter than three
characters: the index is skipped, the planner falls back to a sequential scan, and **no error is
raised**. That silent fallback is the legacy performance defect this rebuild exists to remove. If
`pg_bigm` is unavailable on the pinned engine version, stop and redesign the index plan.

After `003`, confirm the index is really used — the plan must be a Bitmap Index Scan, not a Seq Scan:

```sql
EXPLAIN ANALYZE SELECT id FROM project WHERE prj_name LIKE '%삼성%';
```

### ⚠ There is no runner, and the obvious path does not work

Applying these files is the one step in this document with **no working recipe yet**, and it will
block a first deploy. The constraint is specific:

- **The Aurora Serverless v2 Data API does not support multi-statement SQL.** One statement per
  `ExecuteStatement` call, and no trailing semicolon. The RDS console's Query Editor goes through the
  same API, so pasting a whole file into it does not work either.
- `002_tables.sql` is ~96 KB of several hundred statements; `db/` totals ~135 KB.
- The cluster is `PRIVATE_ISOLATED` with no NAT and no public access, so `psql` is not an
  alternative. Reaching it would need a bastion or VPN, and a NAT Gateway is ~$43/month — which would
  defeat the architecture.

So a small one-off runner is required: split each file into statements, strip comments, and issue one
`rds-data` `ExecuteStatement` per statement against `DbClusterArn` / `DbSecretArn`. It can run from a
laptop, since `rds-data` is a public endpoint reached with SigV4.

Two things will bite whoever writes it:

- **Do not split naively on `;`.** `004_rollup.sql` has semicolons inside `--` comments (the
  illustrative `DO $$ … END $$;` block around line 209). Strip comments first.
- Statements must keep their order, and `001` must complete before `002`.

A CDK custom resource (`cr.Provider`) running the same logic at deploy time is the better long-term
home for this, so that a fresh stage bootstraps itself.

### Ad-hoc queries

```bash
aws rds-data execute-statement \
  --resource-arn "<DbClusterArn>" \
  --secret-arn "<DbSecretArn>" \
  --database neotms \
  --sql "SELECT count(*) FROM project"
```

A paused cluster answers the first statement with `DatabaseResumingException` and takes a few seconds
to wake. The application retries this correctly (`withResumeRetry` in `RdsDataUtils.ts`); the CLI does
not, so just run it again.

---

## 6. Local development

```bash
cp frontend/.env.example frontend/.env.local
# set NEOTMS_DEV_API_TARGET to the ConsoleUrl output of a dev deploy
npm run dev            # Vite on http://localhost:5173, proxying /api/* to that target
npm run lint:site
```

`http://localhost:5173` is the dev stage's only extra allowed origin, and the dev OIDC redirect URIs
point there — which is why local development works against a deployed dev backend with no further
configuration.

`frontend/.env.local` is the console's entire configuration, and it is dev-only. There is deliberately
no client id, no issuer and no API base URL in the bundle: the Lambda runs the whole PKCE flow, and
the API is same-origin so every call is a relative path. The practical consequence is that a build
made on a laptop cannot be pointed at the wrong backend, because it carries no backend address at all.

---

## 7. Day-to-day commands

| Command | What it does |
|---|---|
| `npm run build` | Type-check against `tsconfig.app.json` — the same gate every `cdk` command runs. |
| `npm run watch` | The same, in watch mode. |
| `npm test` | jest. 46 tests, mostly CDK assertions against the synthesized template. |
| `npx cdk diff` | Compare the deployed stack with local state. Add `-c stage=prod` for prod. |
| `npx cdk synth` | Emit the CloudFormation template. |
| `npm run build:site` | Install and build the console only. |

---

## 8. Operational notes

**The ACU floor in the template is not the floor that is running.** Two EventBridge Scheduler
schedules move the cluster's minimum capacity between `0.5` (06:00 KST) and `0` (00:00 KST), every
day, by calling `rds:ModifyDBCluster` directly. They are the *only* thing that sets the floor after
deployment, so `serverlessV2MinCapacity` in `NeotmsDatabase.ts` is the creation value and drifts
thereafter. A `cdk deploy` between 00:00 and 06:00 briefly resets the floor to `0.5` until the next
midnight schedule fires. The console and the template will disagree — expected, not a fault.

The reasoning: a floor of `0` lets Aurora pause and bill nothing, but the first statement after a
pause answers `DatabaseResumingException` and stalls the person who clicked for several seconds. The
backend retries correctly, so nothing breaks — but the stall is indistinguishable from a broken
system to whoever is waiting. The window is therefore the envelope of when any human might be
working, not the official day: PMs arrive as early as 06:30, work as late as 23:00, and do pick up
weekend deliveries. At Seoul's $0.20/ACU-hour:

| Floor window | Compute | Who stalls |
| --- | --- | --- |
| 09:00–18:00 Mon–Fri *(replaced)* | ~$20/mo | every early, late and weekend session |
| **06:00–00:00 daily** *(current)* | ~$55/mo | nobody who could be working |
| Flat `0.5` 24/7 | ~$73/mo | nobody, including nobody |

Add roughly $7/month of storage, backup and I/O to each. The six hours given up, 00:00–06:00, contain
no human and no scheduled job — the 02:00 KST backup window and the 03:00 KST Monday maintenance
window both fall inside it deliberately, so the cluster is woken by those rather than by a user, and
the 06:00 schedule is itself the first connection of the morning.

To change the window, edit `CAPACITY` in `infra/config/NeotmsConfig.ts`; both schedules and their
descriptions derive from it. Hours are integers 0–23 — **midnight is `0`, not `24`**, and
`NeotmsAcuScheduler` throws at synth time if you write `24`, because CloudFormation would otherwise
reject it at deploy time with an error naming a cron expression rather than the field.

**Never attach the Lambda to the VPC.** CDK will add a NAT Gateway (~$43/month) and the Data API's
entire cost advantage disappears. The `natGateways: 0` line in `NeotmsDatabase.ts` is load-bearing.

**Keyset pagination, not `OFFSET`.** The Data API caps a single result set at 1 MiB. Anything larger
has to bypass the Data API via `aws_s3.query_export_to_s3()` — the IAM role, the SSE-KMS export bucket
and the key policy are all wired up in CDK, but nothing in the application calls it yet.

**Mail is wired but not finished.** `NEOTMS_MG_SECRET_NAME` and friends are passed to the Lambda from
`config.mail`, but the Secrets Manager secret (`neotms-dev/mailgun` / `neotms/mailgun`) is neither
created by CDK nor granted to the function's role, `mailgunEmailDomain` and `mailFromAddress` are
empty, and no application code reads them. Creating the secret and adding the grant are both
outstanding.

**`prod` retains data on destroy.** `protectData: true` sets deletion protection and `RETAIN` on the
data resources, so `cdk destroy` leaves the cluster and buckets behind by design.

**One stack, not a data stack plus an app stack.** Cross-stack references become CloudFormation
exports, and an export cannot change while anything imports it — so renaming a bucket would turn into
a three-deploy dance. For a system two people maintain, one-step deploys are worth more than the
blast-radius isolation, particularly since the data resources carry `RETAIN` in production anyway.
