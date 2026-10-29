# NEOTMS — infrastructure

AWS CDK app for the NEOTMS console and API. One stack, four constructs, deployed to
**ap-northeast-2 (Seoul)**. The database is **not** in AWS: it is a Supabase Postgres project,
reached over the Supavisor connection pooler.

```
CloudFront ──┬── /*      → S3 (private, OAC)        the React console
             └── /api/*  → HTTP API → Lambda        one bundled function, rou3 router
                                        │
                                        ├── Supabase Postgres ── Supavisor :6543 (node-postgres)
                                        ├── DynamoDB                                    sessions
                                        └── S3                            attachments + exports
```

Three things about this shape drive most of the instructions below:

- **The database is outside AWS, and the only credential is a static password.** The Lambda reads it
  from Secrets Manager at first use. There is no IAM auth and no short-lived credential, so
  **rotation is a manual act somebody has to remember** — see §5.
- **The Lambda is not attached to the VPC, and there is no VPC at all.** Nothing in the stack needs
  one, so there is no NAT Gateway (~$43/month) and no VPC endpoint to pay for. A test asserts that no
  VPC and no RDS resource exists, because re-adding either is a plausible-looking one-line change.
- **The API is a behaviour on the console's own CloudFront distribution**, not a separate hostname.
  That is what keeps the SPA and the API same-origin, which is what keeps the `SameSite=Lax` session
  cookie working. It also means the console carries no backend address at all.

> **If you are coming from the `dev/neotms-a` branch:** that variant runs Aurora Serverless v2 behind
> the RDS Data API. Everything about connections, pooling, the schema bootstrap, report exports and
> the ACU schedule differs here. The application layer above `SqlOps` is unchanged between the two.

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

This is deliberate: the stack is **not** environment-agnostic — bucket names carry the account id, so
synth cannot produce a template without knowing it. See the header of `infra/NeotmsApp.ts`.

You also need a **Supabase project** before the database works. Create one, then note two values
from the dashboard's *Connect* dialog (§3 explains why they cannot be derived):

| Value | Where it is | Example |
|---|---|---|
| Project ref | The 20 characters in the dashboard URL | `abcdefghijklmnopqrst` |
| Pooler host | *Connect → Transaction pooler* | `aws-0-ap-northeast-2.pooler.supabase.com` |

Pick the region closest to `ap-northeast-2`. Every request crosses from Lambda to Supabase and back,
so the round trip is in the latency budget of every page in the app.

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

Everything except seven values. Log retention, resource prefixes, mail settings, origins, the pooler
port and the database name are decisions this repo owns, so changing them is a reviewed commit in
`infra/config/NeotmsConfig.ts` — not a flag somebody typed once.

`bootstrapAuthorityId` belongs to this group and is the one you are most likely to want to change:
it holds `lpx.admin.access`, which lets an LPX superuser log in and bootstrap an empty NEOTMS. Setting
it to `""` removes that path. See §6.1 — and note that it is *not* a `-c` override, so attempting one
is silently ignored.

### What you pass at deploy time

Exactly seven keys may be overridden with `-c key=value`. Five are **registered on the LPX account
system** rather than chosen here; two identify a **Supabase project** that does not exist until
somebody creates it:

```
authClientId   appAuthorityId   oidcIssuer   oidcRedirectUri   oidcPostLogoutRedirectUri
supabaseProjectRef   supabasePoolerHost
```

Both stages ship the Supabase pair **empty**, and `supabasePoolerHost` is the reason it is an
override rather than a committed value: **the pooler hostname cannot be derived from the region.**
The `aws-0-` / `aws-1-` prefix is assigned per project, so it has to be copied out of the dashboard.
Committing a guess produces an `ENOTFOUND` at runtime, which reads like an outage rather than a
configuration error. Fill them in in `NeotmsConfig.ts` once the projects are permanent.

`prod` also deliberately ships `authClientId`, `oidcRedirectUri` and `oidcPostLogoutRedirectUri`
**empty**, because they depend on a hostname that only exists after the first deploy.
`isAuthConfigComplete()` fails closed, so a prod deploy without them comes up and refuses every login
rather than half-working. `isDatabaseConfigComplete()` does the same for a missing project ref or
pooler host.

```bash
npm run deploy -- \
  -c stage=prod \
  -c supabaseProjectRef=<20-char-project-ref> \
  -c supabasePoolerHost=aws-0-ap-northeast-2.pooler.supabase.com \
  -c authClientId=<client-id-from-LPX> \
  -c oidcRedirectUri=https://<console-host>/auth/callback \
  -c oidcPostLogoutRedirectUri=https://<console-host>/auth/logout
```

What is **not** overridable, and why it matters: `poolerPort` is fixed at **6543**, the
transaction-mode port. Session mode (5432 on the pooler) pins a server connection for the whole life
of a client connection, which a Lambda exhausts under load; the direct endpoint, also 5432, resolves
to IPv6 only without the paid add-on, and a Lambda outside a VPC has no IPv6 egress. The price of
6543 is paid in `PostgresUtils.ts`: **no prepared statements and no session state.** Changing the
port means changing that file too, which is why it is not a flag.

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
| `DbSecretArn` | The database password's secret. **Deployed as a placeholder** — see §5. |
| `DbPsqlCommand` | A ready-made `psql` invocation with the right host, port, user and database. The password is left to the environment, because a stack output is plaintext. |
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

Login still will not work after step 3 until the credential is in place (§5) and the schema has been
applied **through `006_bootstrap.sql`** (§6.1) — until then the database has no staff rows and the
guard has nobody to let in. `006` is where *logging in* starts working; the console is not fully
functional until `010` — and in particular **nothing can be created until `010`** — with all four
files in between failing silently rather than visibly (§6.2).

---

## 5. Database credential

**The deployed secret is a placeholder. Nothing will connect until you overwrite it.**

CDK cannot generate this password: the authoritative copy lives at Supabase, so anything generated
here would simply be wrong. What gets deployed is a random string of the right shape, and the deploy
is not finished until a human replaces it. Take the project's database password from the Supabase
dashboard (*Project Settings → Database*; reset it there if nobody wrote it down) and:

```bash
# --stack-name is NeotmsStack for prod, NeotmsStack-dev for dev (see §2).
aws secretsmanager put-secret-value \
  --secret-id "$(aws cloudformation describe-stacks --stack-name NeotmsStack \
      --query 'Stacks[0].Outputs[?OutputKey==`DbSecretArn`].OutputValue' --output text)" \
  --secret-string '{"password":"<the-supabase-password>"}'
```

The secret is named `<prefix>/db/supabase` — `neotms/db/supabase` for prod, `neotms-dev/db/supabase`
for dev — so `--secret-id neotms/db/supabase` works just as well if you would rather not pipe ARNs.

The JSON shape matters: the key must be exactly `password`, which is
`NEOTMS_DB_SECRET_PASSWORD_KEY` in `NeotmsSupabase.ts`. A bare string, or any other key, fails at
runtime as an authentication error rather than as a parse error.

No redeploy is needed. `PostgresUtils.ts` discards its connection pool and re-reads the secret when
PostgreSQL answers `28P01`, so a password change takes effect within one request instead of
presenting as a multi-hour intermittent outage.

> **Why `cdk deploy` does not clobber it:** `generateSecretString` is only evaluated when
> CloudFormation *creates or replaces* the secret, so repeated deploys leave the real password alone.
> **Editing that block is an update that regenerates it**, which would look like the database
> suddenly rejecting every request after a deploy that changed nothing visible. Treat it as frozen
> once the stack is live — a test asserts its template is `{}` for exactly this reason.

### ⚠ This is a static credential, and that is a real risk

Be clear about what has been accepted here. The database is on the public internet behind TLS, and
**the only thing protecting it is a long-lived password**:

- There is **no IAM authentication, no SigV4 and no short-lived credential.** Anyone who obtains the
  password has the database — all of it, read and write — until a human changes it.
- **Nothing in this stack will notice.** There is no rotation schedule, no anomaly detection, and no
  audit trail of who read the secret beyond CloudTrail's `GetSecretValue` events.
- Unlike the Aurora variant, **there is no network boundary as a second line of defence.** A leaked
  Aurora password is useless without VPC access; a leaked Supabase password is sufficient on its own,
  from anywhere in the world.
- The realistic leak paths are mundane: the password pasted into a terminal during the bootstrap
  below and left in shell history, a developer's `.env` file, a screenshot in a ticket, or a CI log.

Two mitigations are in place and **neither is sufficient on its own.** The password is never an
environment variable (those are readable by anyone with console access to the function, and changing
one needs a redeploy), and the `28P01` pool reset above makes a rotation cheap to perform.

**Recommendation: rotate this password on a schedule, at least every 90 days, and immediately
whenever anyone who has seen it leaves the team or changes role.** The secret carries a
`RotationPolicy: manual-90-days` tag, which exists solely so the intent is machine-readable and
searchable — Secrets Manager's "Rotation" column says "Disabled" for a secret rotated by hand every
quarter and for one that has never been touched, so the tag is the only trace of the difference.
Rotation is three steps and causes no downtime:

1. Reset the password in the Supabase dashboard.
2. `put-secret-value` with the new one, exactly as above.
3. Nothing else. The next request that hits `28P01` re-reads the secret by itself.

Worth doing properly when there is time: a Secrets Manager rotation Lambda calling the Supabase
Management API would make this automatic, and pinning `caCertPem` in `NeotmsConfig.ts` would add
certificate verification on top of TLS. Both are deliberately deferred, not overlooked.

---

## 6. Schema bootstrap

The SQL in `db/` must be applied **once per project, in order**, after the first deploy. The database
is `postgres` (Supabase does not create a per-application database; schemas separate concerns) and
the user is `postgres.<project-ref>` — the bare `postgres` is only valid on the direct endpoint,
because Supavisor routes on the tenant encoded in the username.

| File | Contents |
|---|---|
| `001_extensions.sql` | `pgroonga`, `pg_trgm` |
| `002_tables.sql` | schema |
| `003_indexes.sql` | 16 PGroonga indexes plus the trigram ones |
| `004_rollup.sql` | the `report_daily_rollup` table and `report_rollup_recompute(date)` — see below |
| `004_verify_search.sql` | **asserts the search plan and fails loudly** — see below |
| `005_code_sequences.sql` | code sequences |
| `006_bootstrap.sql` | the six business menus, the 시스템관리자 superuser role, and the way back into an empty NEOTMS — **required, see §6.1** |
| `007_codes.sql` | the `sys_code` dropdown domains: 분야, 작업 종류, 단가 단위, 언어, 사용 프로그램 — **see §6.2** |
| `008_admin.sql` | the two administrative menus (유지보수, 사용자 관리) and the re-grant that makes them usable — **see §6.2** |
| `009_selfservice.sql` | `staff_self_register()`, the function behind the sign-up form — **see §6.2** |
| `010_currency.sql` | the five currencies the console can submit. Without it **every create in the system fails** — **see §6.2** |

Every file in `db/` is applicable **as-is**: plain DDL, no placeholders. That matters because the
application's dbops modules write `:name` parameters (rewritten to `$1` by `toPositional` in
`PostgresUtils.ts`), and `psql` and the Supabase SQL editor have no such rewrite — they answer
`42601 syntax error at or near ":"`. If you ever hit that while applying something from `db/`, the
file is wrong, not your invocation. A test now reads every one of these files and fails on a stray
`:name` or a `\`-prefixed `psql` meta-command, so it cannot come back; `004_verify_search.sql` is the
one deliberate exception, and it is psql-only by name in that test.

Unlike the Aurora variant there is **no runner to write.** The Data API's one-statement-per-call
limit is gone, so `psql` applies each file directly. Use the `DbPsqlCommand` output, which already
has the four values that are easy to get wrong:

```bash
export NEOTMS_DB_PASSWORD='<the-supabase-password>'
PGPASSWORD=$NEOTMS_DB_PASSWORD psql \
  -h aws-0-ap-northeast-2.pooler.supabase.com -p 6543 \
  -U postgres.<project-ref> -d postgres \
  -v ON_ERROR_STOP=1 -f db/001_extensions.sql
```

Repeat for `002` … `010` **in order**; `001` must complete before `002`. Pass
`-v ON_ERROR_STOP=1` every time — without it `psql` reports a failed statement and carries on, so a
half-applied schema looks like a successful run.

**The last five files are not pure schema, and none of them is optional.** `001`…`005` leave a
database that is structurally correct and cannot be used by anybody; `006`…`010` are what turn it
into a running system, and each one is the sole source of something the application assumes exists.
Stopping early does not raise an error on apply — it produces a specific, silent symptom later, and
the five symptoms are listed in §6.1 and §6.2.

A note on failure messages, since none of them name the field that is wrong: a bad host is
`ENOTFOUND`, a bare `postgres` username is `Tenant or user not found`, and port 5432 on the direct
endpoint simply hangs, because that endpoint is IPv6-only without the paid add-on.

### 6.1 The first login, and the 시스템관리자 role

`002`…`005` create a **correct and completely unusable** database. There are no `staff` rows, so the
guard cannot match any LPX identity to a NEOTMS person and every sign-in is refused with

> This account is not registered as NEOTMS staff. Please contact an administrator.

including the sign-in of the administrator who would have created the staff rows. NEOTMS has no route
that writes one, because staff administration is itself behind the guard. `006_bootstrap.sql` is what
breaks that circle, and it does two things.

**A default superuser role.** One `sys_role` row, `role_code = 'NEOTMS_SYSADMIN'`, labelled
**시스템관리자**, granted every action on every active menu. The code is namespaced rather than the
obvious `SYSADMIN` because the legacy `SY_ROLE` ids have not been profiled yet and `role_code` is
`UNIQUE` — a collision would not create a second row, it would hand every permission in the system to
whoever already held the legacy role, silently.

It is a **real role with real rows**, not a flag the code special-cases. There is no superuser bypass
anywhere in `hasPermission`, which keeps the property this rewrite exists for: one server-side source
for every permission decision, auditable with a `SELECT`.

**A way in for LPX administrators.** An account holding LPX's own superuser authority
`lpx.admin.access` is allowed past the coarse gate, and if its NEOTMS staff row is missing, inactive,
or has no role, `staff_bootstrap_superuser()` provisions or repairs one and assigns 시스템관리자. Then
the ordinary path takes over: the role is read back out of the database like everybody else's. In
practice, **an LPX superuser just logs in and it works.**

The function repairs before it creates, which is the behaviour to know about if you are watching the
table:

1. a row already carrying this OIDC subject is **reactivated**, and only its blanks are filled —
   an explicitly assigned role or a `view_scope` of `'N'` is never overwritten;
2. otherwise an **unclaimed legacy row with a matching email** is adopted. Adopting beats creating
   because `mgr_id` is what every legacy `REG_ID` points at, so a duplicate row would split one
   person's project history in two;
3. only if neither applies is a row **created**, with `mgr_id` derived from the email local part and
   `created_by = 'lpx-bootstrap'`.

It is one SQL statement, so it is atomic without a transaction — which matters here specifically,
because Supavisor's transaction mode hands the connection back at `COMMIT` and a read-then-write
sequence from the Lambda could be spread across backends. Two administrators signing in at the same
second cannot produce two staff rows for one person.

Every bootstrap writes one `console.warn` to CloudWatch beginning `NEOTMS BOOTSTRAP:`, carrying the
identity, the staff row, the role and what was wrong before. **That log is the authoritative audit
record**, because the adopt-and-repair branches leave no trace in `staff` that is distinguishable from
ordinary use. To review what the door has been used for:

```sql
SELECT s.mgr_id, s.mgr_name, s.mgr_email, r.role_code, s.view_scope, s.active,
       s.created_by, s.created_at, s.updated_at
  FROM staff s
  LEFT JOIN sys_role r ON r.id = s.role_id
 WHERE s.created_by = 'lpx-bootstrap'      -- created by the bootstrap
    OR r.role_code  = 'NEOTMS_SYSADMIN'    -- superuser, however acquired
 ORDER BY s.created_at;
```

#### ⚠ What this means, stated plainly

**A holder of `lpx.admin.access` cannot be locked out of NEOTMS from inside NEOTMS.** Deactivating
their staff row does not work — the next sign-in repairs it. Revocation is removing the authority on
LPX, or closing the door as below.

It grants nothing that authority did not already confer: its holder can rewrite LPX's authority
tables, including who holds the NEOTMS app authority, so they could already grant themselves access
and be adopted by the ordinary path. This only saves the step. It is deliberately **on in production**
as well as dev, because the failure it prevents — an empty database nobody can log into — is otherwise
recoverable only with the database password and a `psql` client.

**To close it** once real administrators exist, set `bootstrapAuthorityId: ""` for the stage in
`infra/config/NeotmsConfig.ts` and redeploy. Nothing in the database needs changing, and the staff
rows already created keep working normally.

It is **not** a `-c` override, on purpose — and the trap is worth knowing: `-c bootstrapAuthorityId=`
is *silently ignored*, not rejected, so a deploy that appears to have closed the door has not.
Removing an administrative bypass should be a reviewed commit, not a flag somebody typed once.

#### Re-run the grant after the ETL

`006` seeds the **six** menus the API currently gates on. The legacy `SY_MENU` has ~48, and grants
written once do not cover menus added later — the symptom is a silent refusal, not an error. So after
anything that adds `sys_menu` rows:

```sql
SELECT sys_role_grant_all_menus('NEOTMS_SYSADMIN');
```

Idempotent, returns the number of menus granted, and safe to run any time.

### 6.2 `007`, `008`, `009`, `010` — the files whose absence is silent

`006` gets one administrator in. These four are what the console assumes about the database once
somebody is in, and they share a property worth stating before the detail: **skipping one produces no
error anywhere a user or an operator would look.** The apply succeeds (they were never run), the
deploy succeeds (CDK knows nothing about the database's contents), the Lambda starts, and the console
loads. What changes is that one part of the UI is quietly inert, and in each case the natural reading
of the symptom points away from the cause.

| File | The only source of | Symptom if skipped |
|---|---|---|
| `007_codes.sql` | the five `sys_code` dropdown domains | every dropdown on the project, customer and translator forms is empty — `GET /api/v0/codes` answers `200 []` |
| `008_admin.sql` | the `sys_menu` rows for 유지보수 and 사용자 관리 | both administrative screens are unreachable **by everyone, including the superuser**; the sidebar just has six entries |
| `009_selfservice.sql` | `staff_self_register()` | the sign-up form submits and answers **500**, with the cause visible only in CloudWatch |
| `010_currency.sql` | the `currency` rows every `*_coin` / `coin_code` foreign key points at | **every create in the system fails**, on a field nobody touched, reporting a constraint name |

#### `007_codes.sql` — the dropdowns

`sys_code` is self-referencing: `code_parent` points at another row's `code`, so the five domain rows
(`FIELD`, `WORK`, `UNIT`, `LANG`, `UPRO`, each with `code_parent` NULL) must exist before anything can
belong to them. That is why the file has two INSERT sections and must be applied whole — a domain
showing zero children means the second section ran without the first.

Expected after applying: **FIELD 18, LANG 17, UPRO 11, WORK 6, UNIT 5**, plus the 5 domain rows. The
file's section 4 prints exactly that, and also prints the `WORK` and `UNIT` code lists, because those
two must agree **by string** with `frontend/src/apis/neotms.codes.ts` — the console renders a stored
`work_type` by looking it up in that constant, so a code that exists in the database and not in the
constant renders as blank rather than as itself. Eyeball them; `번역 감수 편집 DTP 감리 기타` and
`단어 글자 매 시간 건`.

The file's section 3 also rewrites the `COMMENT ON COLUMN` of `customer.cus_upro` and
`translator.tran_upro`, which is the one part of it that is not seeding. The old comments described
those columns as a grade or rate tier. They are not: `UPRO` is 사용 프로그램, the CAT tool, and the
column holds the string `Trados`. A wrong comment on a column that *looks* like it selects a rate
band is worse than no comment — the next person designs a pricing rule on top of it. The comments are
restated here rather than only fixed in `002_tables.sql`, because an existing database never re-reads
`002`.

While on that column: `cus_upro` is **retained but no longer written by the application.** The
customer registration screen dropped the field — most of this company's clients do not send
translation work and have no answer to give — so it is gone from the write schema, the dbops and the
UI, and the column stays only as the ETL's landing place for legacy values. `translator.tran_upro` is
the live one, and it matters for dispatch rather than for pricing: a Trados package sent to somebody
who does not run Trados comes back unopened.

The reason an empty dropdown is worse than an error: the request succeeds. `GET /api/v0/codes` is the
one `anyStaff` route, it reads whatever is in the table, and an empty table is a legitimate answer —
there is nothing for it to fail on. So a form with no 분야 options looks to the user like a field that
is simply optional, and they save a project without one. The data is then wrong in a way no validation
will ever flag.

#### `008_admin.sql` — the administrative menus, and why the grant is in the file

Two rows: `MAINTENANCE` / 유지보수 / `ord_no 7` and `STAFF` / 사용자 관리 / `ord_no 8`, both flat
(`menu_depth 1`, `menu_parent NULL`) like the six from `006`.

Permissions are granted **on `sys_menu` rows**, which makes a missing row doubly invisible:
`GET /api/v0/me` returns one entry per active row, so the sidebar omits the menu, *and* every route
gated on it answers 403. There is no state in which the screen exists but is refused — it does not
exist.

The file ends with `SELECT sys_role_grant_all_menus('NEOTMS_SYSADMIN')`, and that line is not
decoration. It is the rule from the end of §6.1 applied to this file itself: grants written in `006`
do not cover menus inserted in `008`. Without it the bootstrap superuser gets the worst of both —
`sys_menu` has the rows so the sidebar *shows* 유지보수 and 사용자 관리, `sys_role_auth` does not so
every request either screen makes answers 403. Two menus that are visible and entirely dead.

**`008` is also a prerequisite for `009` being useful**, which is easy to miss because the two files
look unrelated. 사용자 관리 is the only screen where a sign-up request is approved. Apply `009` without
`008` and requests accumulate in `staff` with `role_id` NULL and nobody with a way to act on them —
every applicant sits on the waiting notice indefinitely, and the administrator has no screen to
discover that they are waiting.

#### `009_selfservice.sql` — self-registration, and the 500 nobody can diagnose

One function, `staff_self_register(p_lpx_sub, p_name, p_name_eng, p_email, p_phone, p_position, p_ip)`.
It is the only writer in the system that creates a `staff` row NEOTMS itself did not approve, and it
writes `role_id` NULL deliberately: that is what makes the row a **request** rather than an account.
The permission matrix for a NULL role is empty, so every menu-gated route refuses exactly as it did
before the row existed. The single thing that changes is `GET /api/v0/me`, which starts answering
`registration: "pending"` instead of `"unregistered"`.

**This file is the one with a real trap, and it is the sharpest in `db/`:**

The sign-up form is driven entirely by `/api/v0/me`, which needs no function — it reports
`"unregistered"` from the absence of a `staff` row. So without `009` the console happily shows a new
employee the form, prefilled from their LPX profile, and they fill it in and submit. `POST
/api/v0/registration` then answers **500** with the generic body, and the actual cause

> `42883 function staff_self_register(text, text, text, text, text, text, text) does not exist`

appears **only in the Lambda's CloudWatch log**. From the outside this is a form that refuses to
submit and will not say why — and the first diagnosis anybody reaches for is the form, the browser, or
the user's permissions, none of which is wrong. It is a missing migration, and nothing on screen says
so. Confirm the function is there before anybody is told to sign up:

```sql
SELECT p.oid::regprocedure AS signature
  FROM pg_proc p
 WHERE p.proname = 'staff_self_register';
```

**Expect exactly one row**, reading
`staff_self_register(text,text,text,text,text,text,text)`. Zero rows is the 500 above. *Two* rows is
the subtler failure and the reason this query asks for the signature rather than a count: the
application sends every parameter **untyped** (transaction mode forbids prepared statements, so there
is no parse step to infer from), which means PostgreSQL resolves the call by name and arity alone and
**cannot choose between two overloads of the same arity.** The symptom is
`42725 function staff_self_register(unknown, …) is not unique` — a different error, the same
log-only invisibility, and it means an earlier edit changed the argument list and left the old
version behind. `DROP FUNCTION` the one that does not match, by its full signature.

This is also why every argument is cast at the call site — `:sub::text`, `:name::text`, … in
`StaffSelfRegisterOps` — and why the file's own `COMMENT ON FUNCTION` names the seven-`text`
signature. The casts pin which function is meant.

#### The three registration states

Worth knowing as a set, because they are what `006`…`009` together produce, and two of the three are
screens rather than application:

| `/api/v0/me` says | In the database | What the user sees |
|---|---|---|
| `unregistered` | no `staff` row carries this OIDC subject, and no unclaimed row matched by email | the sign-up form, prefilled from LPX `/userInfo` |
| `pending` | a `staff` row exists with `role_id` NULL | the waiting notice |
| `active` | a `staff` row with a role | the console |

A **deactivated** account is deliberately not in this table. `active = false` makes `/api/v0/me`
itself answer 403, so it surfaces as an error screen carrying the server's wording rather than as a
registration state — the distinction matters because the one thing a deactivated person must not be
shown is a sign-up form, which would invite them to re-apply past a decision somebody made.

**Approval is a human opening 사용자 관리 and assigning a role. Nothing else moves `pending`
forward.** NEOTMS sends no mail, so the pending request sorting to the top of that list is the entire
notification mechanism. That is also why the waiting screen has no refresh button: the profile is
held with a 10-minute `staleTime` and refetched when the tab regains focus, so approval takes effect
on its own, and a button would invite somebody to press it repeatedly at a state only another person
can change.

#### `010_currency.sql` — the seed whose absence breaks every create

The same wall `007` tore down, standing one table over, and the most expensive of the four to skip.

`currency` is a lookup table with one row per currency, keyed on `coin_code` — and `coin_code`, not
`id`, is what **ten columns across nine tables** reference with `ON DELETE RESTRICT`:

| | |
|---|---|
| `customer.cus_coin` | `translator.tran_coin` |
| `customer_rate.cus_co_coin` | `translator_rate.tran_la_coin` |
| `project.coin_code` | `invoice_customer.coin_code` |
| `job.coin_code` | `invoice_customer_payment.coin_code` |
| `purchase_order.po_coin_code` | `invoice_translator.coin_code` |

Nothing in `001`…`009` ever put a row in it, which is why this file exists.

**Why this is worse than the empty `sys_code` that `007` fixed.** Every `sys_code` column is
something a user *chooses*, so an empty parent table produced an empty dropdown — visibly nothing to
pick, and a warning under it saying so (`CodeSelect`). Currency is **defaulted**: all five
registration forms open with `'KRW'` already selected (`?? 'KRW'` in `CustomerFormModal`,
`JobFormModal`, `ProjectFormModal`, `PurchaseOrderFormModal`, `TranslatorFormModal`) and send it
whether or not anybody touched the field. So the symptom was not "fill this in and it still won't
save". It was

> **every create in the system failed, on a field nobody touched, naming a constraint instead of a
> field.**

```
ERROR:  insert or update on table "customer" violates foreign key constraint "customer_cus_coin_fkey"
DETAIL:  Key (cus_coin)=(KRW) is not present in table "currency".
```

On screen that is "저장에 실패했습니다" with no indication of which box was wrong — and since the
request body does carry Korean strings in other fields (`cus_field` holds `'의학·제약'`, which *reads*
like a display label and is in fact the code: for the FIELD domain `007` seeds `code = code_name`),
the field a reader suspects first is innocent. If you are looking at a failing create, check this
table before reading any frontend code.

**The invariant.** Every currency the console can submit must exist here. There is no `GET` endpoint
for currencies — unlike `sys_code`, the list is hardcoded in `frontend/src/apis/neotms.codes.ts` as
`COIN_CODES` — so the two lists are a matched pair, and the seed is exactly its five values: `KRW`
`USD` `JPY` `EUR` `CNY`. A test asserts the agreement **in both directions**, plus that no form
defaults to a currency the seed lacks, because the failure mode of drift is a dropdown that offers a
value which cannot be saved. Adding more rows here is harmless but invisible (nothing reads the table
to build a dropdown); adding fewer breaks a save.

`ON CONFLICT (coin_code) DO NOTHING`, never `DO UPDATE`: a pre-existing `USD` came from the ETL and
carries the company's own wording in `coin_name`, and a re-runnable seed must not quietly relabel
migrated data to match a guess. Rows the file did not create are marked by `created_by` being
anything other than `'seed-010'` — after the ETL that is the list of legacy house codes from
`COINTB_MAIN`, and any of them users should be able to pick needs adding to `COIN_CODES` too.

The file's section 2 prints the five rows, then the check that actually matters:

```sql
SELECT c.code AS console_offers_but_db_lacks
  FROM (VALUES ('KRW'), ('USD'), ('JPY'), ('EUR'), ('CNY')) AS c(code)
 WHERE NOT EXISTS (SELECT 1 FROM currency cur WHERE cur.coin_code = c.code);
```

**Expect zero rows.** Anything it returns is selectable in the UI and unsaveable in the database, and
a count below five means the file was not applied in full — which is harder to recognise than the
original fault, because then saving only fails for whoever picks the missing currency.

### Rehearsing the bootstrap locally

Worth doing before touching the real project, and worth repeating after any change to `db/`. The
`groonga/pgroonga` image is PostgreSQL with PGroonga already built in, so the whole sequence runs
offline against a throwaway database:

```bash
docker run -d --name neotms-sqlcheck -e POSTGRES_PASSWORD=pw -p 55432:5432 \
  groonga/pgroonga:latest-alpine-17
docker cp db neotms-sqlcheck:/db
for f in 001_extensions 002_tables 003_indexes 004_rollup 005_code_sequences 006_bootstrap \
         007_codes 008_admin 009_selfservice 010_currency; do
  docker exec -e PGPASSWORD=pw neotms-sqlcheck \
    psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -f /db/$f.sql || echo "FAILED: $f"
done
docker exec -e PGPASSWORD=pw neotms-sqlcheck \
  psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /db/004_verify_search.sql
docker rm -f neotms-sqlcheck
```

This is not a formality either. Doing it found three defects that the unit tests could not see and
that would each have stopped a real bootstrap dead: the unqualified operator classes described above,
an `E'…'` string continuation in `004_verify_search.sql` that PostgreSQL rejects (only the *first*
literal of an implicit concatenation may carry the `E` prefix), and the `:business_date` placeholder
in `004_rollup.sql`. The schema is not large enough for any of these to be slow to find — the
expensive part was not knowing they were there.

**For the PL/pgSQL files — `006` and `009` — this is the only place the function bodies are ever
executed before production.** The jest suite reads them as text: it can assert that
`staff_self_register` writes a literal `NULL` into `role_id` and has no adopt-by-email branch, and it
does, but it cannot execute a line of either function. PL/pgSQL also defers most of its errors to
call time rather than `CREATE` time — a `column reference "mgr_id" is ambiguous`, an unhandled cast,
a variable that shadows a column — so a file that applies without complaint can still fail on its
first real call. Apply the file, then actually call the function with the cases that matter. For
`009` those are: a fresh sign-up (expect `role_id` NULL, `view_scope 'N'`, `active true`,
`created_by 'self-registration'`), the same subject twice (expect the same id back and no second
row), a blank name, a malformed `p_ip` (expect it stored as NULL and the registration to *succeed*),
an email local part that collides with an existing `mgr_id` (expect a numeric suffix), one with no
Latin characters at all (expect the `user` fallback), and a deactivated or soft-deleted unclaimed row
whose email matches (expect it **not** adopted). Each of those is a branch whose only other test is
a comment.

**And once it is applied, insert a row.** `010_currency.sql` exists because every file in `db/`
applied cleanly, every test passed, and the first customer anybody tried to register failed on a
foreign key — an empty lookup table is not a schema error, so nothing up to that point could have
found it. The cheap check is one INSERT per registration form, with the values the console actually
sends (which for currency means `'KRW'`, because the form sends it whether or not the user touched
the field). Or, to catch the whole class at once, list the lookup tables that are still empty:

```sql
SELECT 'currency' AS t, count(*) FROM currency
UNION ALL SELECT 'sys_code', count(*) FROM sys_code
UNION ALL SELECT 'cat_tool', count(*) FROM cat_tool
UNION ALL SELECT 'corp',     count(*) FROM corp;
```

A zero is only a fault where the UI can submit a value for that column: `currency` is guaranteed to
break because the forms default it, `sys_code` shows an empty dropdown (§`007`), while `cat_tool` is
reachable only through a join table nothing writes yet and `corp`'s referencing columns are nullable
with no default — so those two are expected to be empty until the ETL runs.

Two differences from the real target to keep in mind: this image's PGroonga version is not
necessarily Supabase's, and there is no Supavisor in front, so it proves the SQL is valid but not
that transaction-mode pooling is being respected.

### Confirm `pgroonga` before building anything on it

A **blocking** check, documented at the top of `001_extensions.sql`:

```sql
SELECT * FROM pg_available_extensions WHERE name = 'pgroonga';
```

PGroonga rather than `pg_trgm` is the substantive point. Korean search terms here are very often
exactly two characters (삼성, 번역, 계약), and `pg_trgm`'s GIN operator class cannot index a pattern
shorter than three. The index is skipped, the planner falls back to a sequential scan, and **no error
is raised** — which is precisely the legacy performance defect this rebuild exists to remove. If
`pgroonga` is unavailable, stop and redesign the index plan rather than substituting `pg_trgm`.

Two landmines in this area, both of which fail **silently**:

- **`LIKE` on a `varchar` column is always a sequential scan**, and `CREATE INDEX … USING pgroonga`
  on one *succeeds* — no error at build time, none at query time, nothing in `\d` to say the index is
  dead. PGroonga even ships `pgroonga_varchar_regexp_ops_v2`, so the obvious "use the varchar
  operator class" fix also builds cleanly and also does nothing. The reason is that PostgreSQL
  resolves `LIKE` on varchar by casting first — the plan reads
  `Filter: ((name)::text ~~ '%삼성%'::text)` — and `(name)::text` is an expression, not the indexed
  column, so the rewrite has nothing to attach to. Measured on 30,000 rows with the index present
  and `ANALYZE`d. Every indexed column is therefore declared `text`, and a test parses
  `db/002_tables.sql` and `db/003_indexes.sql` to assert it stays that way. The legacy schema is full
  of `nvarchar`, so "tidy this column up to match the old system" is a realistic, completely silent
  regression.
- **`USING pgroonga (col)` with no operator class does not serve `LIKE`.** The default class answers
  `&@` and `&@~`. Every index names `extensions.pgroonga_text_regexp_ops_v2` explicitly, and the
  same test asserts it.
- **Operator classes must be schema-qualified.** `001` installs both extensions `WITH SCHEMA
  extensions` (Supabase's convention), so an unqualified class name depends on the role's
  `search_path`. Without `extensions` on it, the **first** index statement fails with
  `operator class "pgroonga_text_regexp_ops_v2" does not exist for access method "pgroonga"` — which
  reads as "PGroonga is broken" and says nothing about `search_path`. All 21 index definitions
  qualify the class, and a test enforces it.

### After `003`: run `004_verify_search.sql`

```bash
PGPASSWORD=$NEOTMS_DB_PASSWORD psql … -v ON_ERROR_STOP=1 -f db/004_verify_search.sql
```

**Do not skip this, and do not treat a failure as a formality.** The whole search design rests on one
PGroonga behaviour: it rewrites `column LIKE '%KEYWORD%'` into `column %% 'KEYWORD'` internally, so
the ~20 dbops modules can keep emitting plain `LIKE`. PGroonga's documentation describes that rewrite
for a LIKE against a *literal*, and every search term in this application arrives as a **bind
parameter** (`$1`, via `toPositional` in `PostgresUtils.ts`) — which that wording does not cover.

If the rewrite does not fire for a parameter, nothing errors: the query returns the right rows and
PostgreSQL quietly does a sequential scan. On the ~20 rows of a freshly seeded dev database a Seq
Scan is also the *correct* plan, so checking by hand shows nothing wrong. It surfaces on 310,000
production rows, after go-live. The script therefore builds its own 30,000-row table, big enough that
the planner has a real choice, `ANALYZE`s it, inspects the plan, and `RAISE`s if the choice is wrong.
It checks four cases: a literal pattern, `LIKE … ESCAPE '\'`, a bound parameter on a custom plan, and
a bound parameter forced onto a **generic** plan (which is built without seeing any parameter value,
so an optimisation that depends on the pattern would be lost there and nowhere else).

> **Result on PGroonga 4.1.0 / PostgreSQL 17: all four pass.** The rewrite *does* fire for a bound
> parameter, on both a custom and a forced generic plan. This was the largest open risk in the search
> design and it is now measured rather than assumed. It is still worth re-running against the real
> project, because the number above is the version this was verified on, not necessarily the version
> Supabase has provisioned for you.

If it ever fails, the fix is in `searchClause` in `PostgresUtils.ts` — emit the `%%` operator
directly instead of relying on the rewrite. It is a contained change, but only if you know it is
needed. (Case 4 failing is a warning rather than an error: `PostgresUtils` never sets `name` on a
query, so production always gets custom plans. It would mean that *naming* a searching query — to
make a hot path cheaper — would silently destroy its performance from the fifth execution onward.)

### `004_rollup.sql`, and the recompute it does *not* run

Applying the file creates the `report_daily_rollup` table, its indexes and the function
`report_rollup_recompute(date)`. It does not populate anything, and on a fresh project there is
nothing to populate — the report screens will show zeros until the ETL has loaded `job` and
`purchase_order` and the rollup has been built.

The rollup is derived data: revenue is `SUM(job.job_price_ksum)`, cost is
`SUM(purchase_order.po_price_ksum)`, margin is `revenue - cost` computed on read and never stored.
Nothing in the application writes the table — `NeotmsReport.dbops.ts` only reads it — so this
function is the single definition of revenue for reporting. **Do not copy the aggregation into a
scheduled job**; call the function.

```sql
SELECT report_rollup_recompute(current_date - 1);   -- yesterday
```

It is idempotent — it deletes the date before re-inserting it, so a dimension combination that
disappeared between runs (a job reassigned to another PM, or soft-deleted) does not survive as a
stale row inflating revenue. It returns the number of rows written, which is how a scheduler
distinguishes "that date had no jobs" from "the job never ran". Re-run it over a trailing window to
pick up back-dated edits:

```sql
SELECT d::date, report_rollup_recompute(d::date)
  FROM generate_series(current_date - 30, current_date - 1, interval '1 day') AS d;
```

For the initial load after the ETL, `004_rollup.sql` ends with a commented-out `DO` block that loops
the function over every distinct `job_eday`. It is left commented deliberately: during the bootstrap
there is no data for it to find, and after the ETL it runs for minutes — longer than both the API
Gateway and Lambda timeouts. Paste it into `psql` when you want it, then reconcile against the
verification anchor documented at the top of the file (expected total revenue **₩8,870,363,824**).

> **Still open:** nothing schedules the nightly call yet. The intended arrangement is 23:30 KST, and
> the function exists precisely so that whatever ends up invoking it — EventBridge plus a small
> Lambda, or `pg_cron` inside Supabase — is a one-line call rather than a second copy of the
> aggregation.

### Ad-hoc queries

```bash
PGPASSWORD=$NEOTMS_DB_PASSWORD psql -h <pooler-host> -p 6543 \
  -U postgres.<project-ref> -d postgres -c "SELECT count(*) FROM project"
```

No resume stall to work around: Supabase bills a flat monthly compute price and the project does not
pause, so the first query of the day is as fast as any other. Note that on port 6543 you are in
transaction mode — no prepared statements, no `SET` that outlives a statement, no advisory locks held
across one.

---

## 7. Local development

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

## 8. Day-to-day commands

| Command | What it does |
|---|---|
| `npm run build` | Type-check against `tsconfig.app.json` — the same gate every `cdk` command runs. |
| `npm run watch` | The same, in watch mode. |
| `npm test` | jest. 78 tests: CDK assertions against the synthesized template, plus ones that parse `db/*.sql`, the routing table and a few frontend files as text — see below. |
| `npx cdk diff` | Compare the deployed stack with local state. Add `-c stage=prod` for prod. |
| `npx cdk synth` | Emit the CloudFormation template. |
| `npm run build:site` | Install and build the console only. |

### Why a third of the suite reads source files as text

Unusual enough to explain, because it looks like laziness and is not. There is no database in CI and
no browser, so the properties most worth protecting here are not reachable by executing anything:

- **A `db/*.sql` file is applied by a human pasting it into the Supabase SQL editor.** So the tests
  assert the house rules that make that work — no `:name` placeholders (that is this application's
  own query-layer convention, and `psql` answers `42601 syntax error at or near ":"`), no
  `\`-prefixed meta-commands, no `BEGIN`/`COMMIT`, and `SET search_path` pinned on every function.
  `004_verify_search.sql` is the one deliberate exception and is named as such in that test.
- **Security properties that are true by *absence*.** `staff_self_register` is safe because it has no
  parameter that could carry a role and no branch that adopts a row by email; `SelfProfileSchema` is
  safe because it has no field named `roleId`, `viewScope`, `active` or `lpxSub`. A test can check
  that something is missing from a file. Nothing else can — and both of these are exactly the kind of
  thing a well-meaning refactor adds back ("let the bootstrap reuse this function").
- **The routing table's tiers.** Precisely two routes carry `account: true` — the one that explains
  why there is no staff row and the one that creates it. That count is the security boundary for
  unregistered callers, so the test asserts the number, which makes growing the list a deliberate
  act with a failing test attached rather than one more line in a table.
- **Branch ordering in the console, and Korean notice text.** `NeotmsApp.tsx` must test
  `registration` *before* `nav.length === 0`, because `menus` is `[]` before approval and the reverse
  order shows somebody who has never signed up a screen telling them to request permissions they
  cannot be given yet. No type error, no runtime error, just the wrong screen. Likewise the two
  approval notices are asserted character-for-character, including a spacing difference between them
  that is intentional, because reflowing JSX is the sort of edit nobody re-reads.
- **Lists in two files that have to stay equal.** The seed in `010_currency.sql` and the hardcoded
  `COIN_CODES` in `frontend/src/apis/neotms.codes.ts` are a matched pair with no endpoint between
  them to reconcile them, so a test parses both and compares them **in both directions**, and a
  third reads the `?? 'KRW'` default out of each of the five registration modals and requires the
  seed to contain it. Drift in one direction makes a dropdown entry unsaveable; in the other it adds
  a currency that appears nowhere. Neither is a type error, and neither surfaces until somebody
  picks the wrong row.

The tests that do this read whole files and match on statements rather than fragments — a lesson from
writing them, since the prose comments in this codebase quote the code they are explaining, and an
`indexOf` on a bare condition cheerfully finds the comment above the branch instead of the branch.

---

## 9. Operational notes

**The connection budget is 40, and it is the binding constraint.** `reservedConcurrentExecutions: 20`
(in `NeotmsApi.ts`) times a pool `max` of 2 (in `PostgresUtils.ts`) is the ceiling on Supavisor
client connections this function can hold. Raise either number without checking the Supabase
project's connection limit and a traffic spike presents as **connection exhaustion rather than as
slowness** — requests fail instead of queueing, which is a much worse failure for a user to meet.

This is also why **sessions are in DynamoDB, not in Postgres.** A cookie check on every authenticated
request would spend that budget on requests that end in a 401 and read nothing. On the Aurora variant
the argument was cost (a session read on every request would have held the cluster awake, ~$48/month
in ACU floor to check cookies); Supabase bills flat compute, so the cost argument is gone and the
connection argument carries the decision on its own. See `NeotmsSession.dbops.ts`.

**Transaction mode means no prepared statements and no session state.** Port 6543 hands back a
different server connection per transaction, so anything that outlives one statement is unsafe:
`PREPARE`, session-level `SET`, `LISTEN`/`NOTIFY`, advisory locks, temp tables. node-postgres only
prepares a query that has a `name`, so the rule in practice is **never give a query a name.**

**Never attach the Lambda to a VPC.** CDK will create a NAT Gateway (~$43/month) to give it egress,
which is close to half the project's monthly budget for no benefit — the database is reached over the
public internet either way. Two tests guard this (no NAT Gateway, no EIP) plus a third asserting the
function has no `VpcConfig` and a fourth asserting no VPC exists at all.

**Keyset pagination, not `OFFSET`.** The reason has changed but the conclusion has not. The Data
API's 1 MiB result cap is gone, but Lambda still caps a response at 6 MB, and `OFFSET` on a large
table makes the database count rows it then throws away. `NEOTMS_PAGE_SIZE_MAX` is 200; a report too
large for the response payload spills to the export bucket and the caller gets a presigned URL.

**Report exports no longer involve the database.** On the Aurora variant the 1 MiB cap forced them
out through `aws_s3.query_export_to_s3()`, which refuses any bucket that is not SSE-KMS — hence a
customer-managed key, its alias, its rotation and an IAM role the *cluster* assumed. Over a socket
the Lambda renders the XLSX itself and writes it, so the export bucket is plain SSE-S3 and the key
and role are deleted. A test asserts the bucket is `AES256` and that the stack contains no KMS key.

**There is no SLA on the database, and no multi-AZ failover.** Supabase's uptime commitment on the
paid tier is not an AWS-style SLA with credits, and a project restart is a few minutes of total
outage. This was an accepted trade — the legacy system it replaces has no SLA either — but it should
be a known trade rather than a discovered one.

**Mail is wired but not finished.** `NEOTMS_MG_SECRET_NAME` and friends are passed to the Lambda from
`config.mail`, but the Secrets Manager secret (`neotms-dev/mailgun` / `neotms/mailgun`) is neither
created by CDK nor granted to the function's role, `mailgunEmailDomain` and `mailFromAddress` are
empty, and no application code reads them. Creating the secret and adding the grant are both
outstanding.

**`prod` retains data on destroy — but "data" no longer means the database.** `protectData: true`
sets `RETAIN` on the buckets, the session table and the password secret. The database itself is at
Supabase and is **completely unaffected by `cdk destroy`**, which cuts both ways: the stack is safe to
tear down, and tearing it down protects nothing. Deleting the Supabase project is a separate,
irreversible act performed in a different console.

**One stack, not a data stack plus an app stack.** Cross-stack references become CloudFormation
exports, and an export cannot change while anything imports it — so renaming a bucket would turn into
a three-deploy dance. For a system two people maintain, one-step deploys are worth more than the
blast-radius isolation, particularly since the data resources carry `RETAIN` in production anyway.
