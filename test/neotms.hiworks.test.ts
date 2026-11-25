// SPDX-License-Identifier: MIT
//
// The Hiworks credential vault (db/013): storing one person's own sign-in, and the rules that make
// storing it defensible rather than merely convenient.
//
// This file imports the real modules and builds real statements, like neotms.workspace.test.ts and
// for the same reason: the properties that matter here are not visible as substrings. "The settings
// screen cannot leak ciphertext" is a fact about which columns a SELECT names, and a refactor can
// add one without changing a word of the surrounding code.
//
// The facts these tests keep true:
//
//   1. **One person has one credential, as a key constraint.** `staff_id` is the primary key. The
//      first draft of 013 had a surrogate identity key with staff_id merely a column, which lets a
//      bug leave two rows behind - after which every read is "the most recent one, probably" and a
//      mail can go out from an account the person thought they had replaced.
//   2. **The common read cannot leak the secret.** Opening 내 정보 selects the masked hint and the
//      timestamps and NOT ONE secret column, so the frequent read is safe even if a response shape
//      were wrong.
//   3. **A ciphertext is useless in another row.** The KMS encryption context carries the staff id,
//      so moving a wrapped key between rows makes the unwrap fail instead of yielding somebody
//      else's password. Without it, UPDATE access to this table is read access to any colleague's
//      credential.
//   4. **Storing is optional and nothing degrades without it.** Both mail schemas accept empty
//      credentials and fall back to the dialog, which is how the feature worked before this table
//      existed.
//   5. **The screen is not permissioned.** It shows the caller their own settings, so a grant could
//      only ever be a way to take somebody's access to their own account away.
//
// The AES-GCM round trip at the end is the one test here that computes rather than inspects. It
// does not touch KMS - it exercises the same algorithm, nonce width and tag width the module names,
// against the standard library, so that a change to one of those constants fails here rather than
// at the first Decrypt after a deploy.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "@jest/globals";

import {
  HiworksCredentialDeleteOps,
  HiworksCredentialSaveOps,
  HiworksCredentialSealedOps,
  HiworksCredentialStatusOps,
} from "../lambdas/neotms/nodejs/neotms/hiworks/NeotmsHiworks.dbops.js";
import { maskHiworksId } from "../lambdas/neotms/nodejs/neotms/hiworks/NeotmsHiworksManager.js";
import { param, toPositional } from "../lambdas/neotms/nodejs/utils/PostgresUtils.js";
import { NeotmsMenu } from "../lambdas/neotms/nodejs/neotms/NeotmsMenus.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sql = (file: string) => readFileSync(path.join(here, "..", "db", file), "utf8");
const lambda = (...segments: string[]) =>
  readFileSync(path.join(here, "..", "lambdas", "neotms", "nodejs", ...segments), "utf8");
const client = (...segments: string[]) =>
  readFileSync(path.join(here, "..", "frontend", "src", ...segments), "utf8");
/** Comments stripped, for assertions that a module does NOT do something it discusses. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");

const sealedFixture = {
  ciphertext: Buffer.from([0x01, 0x02, 0xfe, 0xff]),
  iv: Buffer.alloc(12, 0x07),
  tag: Buffer.alloc(16, 0x09),
  wrappedDataKey: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
  kmsKeyId: "arn:aws:kms:ap-northeast-2:123456789012:key/abc",
};

describe("the Hiworks credential vault", () => {
  test("one person has one credential, and that is the primary key", () => {
    /*
     * The structural correction to the first draft of 013, which had
     * `hiworks_credentials_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY` with staff_id as an
     * ordinary column. A transaction does not make one-row-per-person true; a key does.
     *
     * Asserted in BOTH files, because they are two definitions of the same table - 001 builds it
     * fresh, 013 adds it to a database that already has data - and a drift between them is a
     * schema that depends on which path a deployment took.
     */
    for (const file of ["001_schemas.sql", "013_hiworks_credentials.sql"]) {
      const text = sql(file);
      expect(text).toMatch(
        /staff_id\s+bigint PRIMARY KEY REFERENCES staff \(id\) ON DELETE CASCADE/,
      );
      // And no surrogate key sneaking back in beside it.
      expect(text).not.toMatch(/hiworks_credentials?_id/);
    }
  });

  test("the two definitions of the table agree, column for column", () => {
    /*
     * A fresh build and an upgraded database must have the same table. This compares the column
     * lists rather than the whole statement, because 013 writes its CHECKs as separate ALTERs (so
     * the file is re-runnable) while 001 writes them inline (there is nothing to re-run).
     */
    const columnsOf = (file: string) => {
      const body = /CREATE TABLE IF NOT EXISTS staff_hiworks_credential \(([\s\S]*?)\n\);/.exec(
        sql(file),
      )?.[1];
      expect(body).toBeDefined();
      const lines = (body ?? "").split("\n").map((line) => line.replace(/--[^\n]*/g, "").trim());
      /*
       * Everything before the first CONSTRAINT is a column. Cutting there rather than filtering
       * CONSTRAINT lines out matters because 001 writes its CHECKs INLINE and one of them spans
       * four lines - whose continuation lines are not column definitions and do not begin with
       * the word, so a filter lets them through as columns named `AND` and `)`.
       */
      const firstConstraint = lines.findIndex((line) => line.startsWith("CONSTRAINT"));
      return lines
        .slice(0, firstConstraint === -1 ? lines.length : firstConstraint)
        .filter((line) => line.length > 0)
        .map((line) => line.replace(/,$/, "").split(/\s+/).slice(0, 2).join(" "));
    };
    expect(columnsOf("013_hiworks_credentials.sql")).toEqual(columnsOf("001_schemas.sql"));
    // And the shape itself, so a rename has to be deliberate in both places.
    expect(columnsOf("001_schemas.sql")).toEqual([
      "staff_id bigint",
      "hiworks_id_hint text",
      "secret_ciphertext bytea",
      "secret_iv bytea",
      "secret_tag bytea",
      "wrapped_data_key bytea",
      "kms_key_id text",
      "created_at timestamptz",
      "updated_at timestamptz",
    ]);
  });

  test("opening 내 정보 reads no secret column", () => {
    /*
     * The property that makes the FREQUENT read of this table the safe one. Somebody visiting their
     * settings page selects a masked hint and two timestamps; the ciphertext, the nonce, the tag
     * and the wrapped key are not in the result set at all, so no response-shaping mistake can
     * send them.
     *
     * The sealed read exists separately and is called from one place - resolving credentials for a
     * send that is about to happen.
     */
    const status = HiworksCredentialStatusOps("42").sql;
    for (const secret of ["secret_ciphertext", "secret_iv", "secret_tag", "wrapped_data_key"]) {
      expect(status).not.toContain(secret);
    }
    expect(status).toContain("hiworks_id_hint");

    const sealed = HiworksCredentialSealedOps("42").sql;
    for (const secret of ["secret_ciphertext", "secret_iv", "secret_tag", "wrapped_data_key"]) {
      expect(sealed).toContain(secret);
    }
  });

  test("every statement is narrowed by the caller's own staff id", () => {
    /*
     * Not scoped by `staff.view_scope`, and it could not be: view scope widens access to COMPANY
     * data, and a colleague's password is not company data at any scope. The narrowing is identity,
     * in every statement, with no listing op for there to be an exception to.
     */
    for (const ops of [
      HiworksCredentialStatusOps("42"),
      HiworksCredentialSealedOps("42"),
      HiworksCredentialDeleteOps("42"),
      HiworksCredentialSaveOps("42", "ab***@x.com", sealedFixture),
    ]) {
      expect(ops.sql).toMatch(/staff_id = :staff_id|staff_id,|:staff_id/);
      expect(ops.parameters?.some((p) => p.name === "staff_id")).toBe(true);
    }
    // There is no op that reads more than one person's row.
    const dbops = code(lambda("neotms", "hiworks", "NeotmsHiworks.dbops.ts"));
    /*
     * Every read of the table carries its own narrowing. Checked by looking at what follows each
     * FROM rather than by counting them, so a second read added without a WHERE fails here.
     */
    const reads = [...dbops.matchAll(/FROM staff_hiworks_credential([\s\S]{0,160})/g)];
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read[1]).toContain("staff_id = :staff_id");
    }
    expect(dbops).not.toContain("scopeClause");
  });

  test("the ciphertext is bound to its owner through the KMS encryption context", () => {
    /*
     * The quiet one, and the one whose absence would be hardest to notice: without the staff id in
     * the encryption context, every wrapped key in the table is interchangeable. Anybody who can
     * UPDATE this table could copy a colleague's row onto their own staff_id and read the password
     * back through the ordinary send path - no KMS permission of their own required.
     *
     * Asserted as the literal pairs, because this is one of the few things in the system that
     * cannot be changed later: the context is part of the ciphertext's identity, so editing these
     * strings makes every stored credential unreadable.
     */
    const manager = code(lambda("neotms", "hiworks", "NeotmsHiworksManager.ts"));
    expect(manager).toMatch(/app:\s*"neotms"/);
    expect(manager).toMatch(/purpose:\s*"hiworks"/);
    expect(manager).toMatch(/staffId,?\s*\}/);
    // Both directions use the same context - a seal the application cannot open is not a feature.
    expect(manager).toContain("encryptionContextFor(caller.staffId)");
    const envelope = code(lambda("utils", "KmsEnvelopeUtils.ts"));
    expect(envelope).toContain("EncryptionContext: { ...context }");
  });

  test("every failure is logged with its cause, and no log line can carry a credential", () => {
    /*
     * This started as "the manager never logs at all", which is the rule the handover manager
     * follows. It was relaxed deliberately: the non-production deployments share one database, so
     * "this deployment cannot use the key that wrapped this row" is an EXPECTED failure there, and
     * one that is indistinguishable - from the outside - from Hiworks refusing a password. Silence
     * made the common case undiagnosable.
     *
     * So the rule is now narrower and stronger than "no logging": every console call is checked for
     * what it could carry. The password and the id must never reach a log line in ANY branch, and
     * these lines are written on exactly the paths where one is in scope.
     */
    const managerRaw = lambda("neotms", "hiworks", "NeotmsHiworksManager.ts");
    const manager = code(managerRaw);

    // Every log line is tagged, so "was it the key or was it Hiworks" is a grep.
    const calls = [...manager.matchAll(/console\.(?:log|warn|error|info|debug)\(([\s\S]*?)\);/g)];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) {
      const argument = call[1] ?? "";
      expect(argument).toContain("[hiworks]");
      /*
       * The assertion that matters. `caller.staffId` is allowed - an internal row id that
       * identifies the person for support without being a secret. Anything that could hold the
       * credential is not.
       */
      expect(argument).not.toMatch(/password|hiworksId|hiworksPassword|\binput\b|credentials\./i);
    }

    /*
     * `GenerateDataKey` on every save rather than re-using the stored key is what keeps GCM's nonce
     * rule satisfiable: a repeat would need a fresh random nonce AND a fresh random key to collide
     * at once.
     */
    const envelope = code(lambda("utils", "KmsEnvelopeUtils.ts"));
    expect(envelope).toContain("GenerateDataKeyCommand");
    expect(envelope).toContain("randomBytes(GCM_IV_BYTES)");
    // The plaintext key is cleared after use. Best effort, and the module says so.
    expect(envelope).toContain("dataKey?.fill(0)");
    // Never Encrypt directly on the CMK, which would also mean a wider IAM grant.
    expect(envelope).not.toContain("EncryptCommand");

    /*
     * And the envelope module tells the two KMS-side causes apart. An unusable KEY and a damaged
     * ROW are different problems that a single catch would report identically - which is useless
     * exactly when it matters, because "the key is unreachable from this deployment" is the normal
     * failure in a shared-database arrangement. Both messages name the key.
     */
    expect(envelope).toContain("KMS Decrypt of the stored data key failed on");
    expect(envelope).toContain("the data key unwrapped but the payload did not decrypt");
    expect(envelope).toContain("KMS GenerateDataKey failed on ${keyId}");
  });

  test("the save upserts, replacing every secret column together", () => {
    /*
     * "Register" and "change my password" are one request, because `staff_id` is the key. And every
     * secret column is replaced at once: a save mints a new data key and a new nonce, so leaving
     * any one of the five behind would pair new ciphertext with an old key or an old nonce.
     *
     * `created_at` is deliberately NOT updated - it records when this person first stored an
     * account, and changing a password is not a new registration.
     */
    const save = HiworksCredentialSaveOps("42", "ab***@x.com", sealedFixture);
    expect(save.sql).toContain("ON CONFLICT (staff_id) DO UPDATE");
    for (const column of [
      "secret_ciphertext",
      "secret_iv",
      "secret_tag",
      "wrapped_data_key",
      "kms_key_id",
      "hiworks_id_hint",
    ]) {
      // The SET list is column-aligned for reading, so compare with runs of spaces collapsed.
      expect(save.sql.replace(/[ \t]+/g, " ")).toContain(`${column} = EXCLUDED.${column}`);
    }
    expect(save.sql.replace(/[ \t]+/g, " ")).toContain("updated_at = now()");
    expect(save.sql).not.toMatch(/created_at\s*=/);
  });

  test("bytea parameters reach PostgreSQL as bytes, not as text", () => {
    /*
     * `param()`'s default branch is `String(value)`, which on a Buffer is the bytes decoded as
     * UTF-8 with every invalid sequence replaced by U+FFFD. That is lossy and it is NOT an error:
     * the row would store, and the failure would surface later as a credential that will not
     * decrypt. So the `"bytea"` kind passes the buffer through, and this test watches the value
     * that actually reaches node-postgres.
     */
    const save = HiworksCredentialSaveOps("42", "ab***@x.com", sealedFixture);
    const positional = toPositional(save.sql, save.parameters);
    const buffers = positional.values.filter((v): v is Buffer => Buffer.isBuffer(v));
    expect(buffers).toHaveLength(4);
    // 0xfe 0xff are not valid UTF-8; if this came back as a string they would be U+FFFD.
    expect([...(buffers[0] ?? Buffer.alloc(0))]).toEqual([0x01, 0x02, 0xfe, 0xff]);
    expect((positional.text.match(/::bytea/g) ?? [])).toHaveLength(4);
    expect(Buffer.isBuffer(param("x", Buffer.from([5]), "bytea").value)).toBe(true);
  });

  test("the stored id is masked, and the mask never carries the whole local part", () => {
    /*
     * The one part of the credential that lives outside the ciphertext, so the only place a
     * widening mistake would be silent. Two properties: a `*` is always present (db/013's
     * verification query leans on it to spot a whole id written here by accident), and the local
     * part is never reproduced in full.
     */
    const cases: [string, string][] = [
      ["abcdef@lionkorea.co.kr", "ab***@lionkorea.co.kr"],
      ["ab@lionkorea.co.kr", "***@lionkorea.co.kr"],
      ["a@b.com", "***@b.com"],
      ["someuser", "so***"],
      ["ab", "***"],
      ["a", "***"],
      ["", "***"],
    ];
    for (const [input, expected] of cases) {
      const masked = maskHiworksId(input);
      expect(masked).toBe(expected);
      expect(masked).toContain("*");
      const local = input.includes("@") ? input.slice(0, input.lastIndexOf("@")) : input;
      if (local.length > 2) expect(masked).not.toContain(local);
    }
  });

  test("both mail endpoints accept empty credentials, and refuse half of a pair", () => {
    /*
     * Storing is optional, so "both empty" is a normal request body and the schema cannot be the
     * thing that rejects it. The floor moved rather than disappeared: the resolver refuses a
     * half-filled pair, because silently using the stored account when somebody typed an id and
     * left the password blank would send from an account they did not choose - and the success
     * notice names the recipient, not the sender, so they would never know.
     */
    const schemas = code(lambda("neotms", "neotms.schemas.ts"));
    const optional = schemas.match(
      /hiworksId: v\.optional\(v\.pipe\(v\.string\(\), v\.trim\(\), v\.maxLength\(300\)\), ""\)/g,
    );
    expect(optional).toHaveLength(2);
    // The save endpoint is the other way round: there is nothing to fall back to there.
    expect(schemas).toMatch(
      /HiworksCredentialSaveSchema[\s\S]{0,400}hiworksId: v\.pipe\(v\.string\(\), v\.trim\(\), v\.minLength\(1\)/,
    );

    const manager = code(lambda("neotms", "hiworks", "NeotmsHiworksManager.ts"));
    expect(manager).toContain("id.length > 0 || password.length > 0");
  });

  test("both mail managers resolve credentials through the one shared function", () => {
    /*
     * "Typed credentials win over stored ones" must not be able to differ between the two screens,
     * so neither manager reads `input.hiworksId` any more. A copy of the precedence rule in each
     * file is exactly the kind of drift that produces "it works on the PO screen but not on the
     * project screen".
     */
    for (const file of [
      ["neotms", "handover", "NeotmsHandoverManager.ts"],
      ["neotms", "purchase-orders", "NeotmsPoRequestMailManager.ts"],
    ]) {
      const manager = code(lambda(...file));
      expect(manager).toContain("resolveHiworksCredentials(caller, input)");
      expect(manager).not.toContain("hiworksLogin(input.hiworksId");
    }
  });

  test("the three routes are anyStaff, on one path, and name no staff id", () => {
    /*
     * `anyStaff` and NOT a permission: every permission in this system answers "may this person see
     * company data", and this row is the caller's own. A grant could only be a way to take
     * somebody's access to their own account away, and a role created next month would silently
     * not have it.
     *
     * No id in the path is the other half. There is no route that names whose credential to read,
     * which makes reading a colleague's unexpressible rather than merely refused.
     */
    const handler = lambda("neotms", "neotms.handler.ts");
    expect(handler).toContain('const HIWORKS_CREDENTIAL = "/api/v0/me/hiworks-credential"');
    const routes = handler
      .split("\n")
      .filter((line) => line.includes("HIWORKS_CREDENTIAL,") && line.includes("method:"));
    // GET and PUT fit on one line; DELETE is wrapped by the formatter, so it is checked separately.
    expect(routes).toHaveLength(2);
    for (const route of routes) {
      expect(route).toContain("anyStaff: true");
      expect(route).not.toContain("permission:");
    }
    expect(handler).toMatch(
      /path: HIWORKS_CREDENTIAL,\s*\n\s*method: "DELETE",[\s\S]{0,120}anyStaff: true/,
    );
    expect(handler).not.toMatch(/hiworks-credential\/:/);
    // And no permission was invented for it anywhere in the system.
    expect(lambda("auth", "NeotmsAuthorities.ts")).not.toContain("MY_INFO");
  });

  test("내 정보 is a menu with no permission, seeded, and mirrored on the client", () => {
    /*
     * The menu row exists so that somebody reading the database sees the screen and so that the
     * bootstrap test's "every NeotmsMenu id is seeded" assertion holds. What it deliberately does
     * NOT come with is a permission or a re-grant call - unlike 006, 008 and 015, which all end
     * with sys_role_grant_all_permissions because they added one.
     */
    expect(NeotmsMenu.MY_INFO).toBe("MY_INFO");
    expect(sql("002_initial_seeding.sql")).toContain("('MY_INFO', '내 정보'");
    expect(sql("013_hiworks_credentials.sql")).toContain("('MY_INFO', '내 정보'");
    /*
     * Comments stripped, because 013's header DISCUSSES the re-grant call it deliberately omits,
     * and that paragraph is what makes the omission legible rather than looking forgotten. The
     * assertion is about the statements.
     */
    const migration = sql("013_hiworks_credentials.sql")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/--[^\n]*/g, " ");
    expect(migration).not.toContain("sys_role_grant_all_permissions");
    expect(migration).not.toContain("sys_role_permission");

    const config = client("shared", "config.ts");
    expect(config).toContain("MY_INFO: 'MY_INFO'");
  });

  test("the 내 정보 nav entry is gated on registration, and is last so it is nobody's home screen", () => {
    /*
     * `HomeRedirect` sends people to `readableNav(profile)[0]`, and this is the only entry every
     * account can see. Anywhere but last, it becomes EVERY user's screen on sign-in - a settings
     * page nobody opens daily. The order of this array is load-bearing, and the comment in
     * permissions.ts says so; this test is what makes moving it fail.
     */
    const permissions = client("shared", "permissions.ts");
    expect(permissions).toContain("export const NEOTMS_NAV_ANY_STAFF = '*anyStaff' as const");
    expect(permissions).toContain("readPermission: NEOTMS_NAV_ANY_STAFF");
    expect(permissions).toContain("profile?.registration === 'active'");

    // MY_INFO is the final entry of NEOTMS_NAV.
    const navBody = /export const NEOTMS_NAV: readonly NeotmsNavItem\[\] = \[([\s\S]*?)\n\]/.exec(
      permissions,
    )?.[1];
    expect(navBody).toBeDefined();
    const menuIds = [...(navBody ?? "").matchAll(/menuId: NeotmsMenuId\.([A-Z_]+)/g)].map(
      (m) => m[1],
    );
    expect(menuIds.at(-1)).toBe("MY_INFO");
    /*
     * Exactly one entry uses the any-staff gate; a second would be a permission somebody forgot.
     * Counted in CODE, because the comment above the entry names the constant to explain it.
     */
    expect([...code(navBody ?? "").matchAll(/NEOTMS_NAV_ANY_STAFF/g)]).toHaveLength(1);
  });

  test("the screen and the dialogs keep the password out of browser storage", () => {
    /*
     * The rule the handover dialog already followed, extended to the screen that now asks for the
     * same value on purpose. The settings screen also asks the browser's password manager to stay
     * out of it (`autocomplete="new-password"`): what this screen does IS remembering the password,
     * and putting a second copy in the browser is not something the person asked for.
     */
    const view = client("features", "me", "MyInfoView.tsx");
    const viewCode = code(view);
    expect(viewCode).not.toContain("localStorage");
    expect(viewCode).not.toContain("sessionStorage");
    expect(view).toContain('autoComplete="new-password"');
    // The full id is never rendered - only the server's masked hint.
    expect(viewCode).toContain("hiworksIdHint");

    for (const file of [
      ["features", "projects", "HandoverMailModal.tsx"],
      ["features", "purchaseorders", "PoRequestMailModal.tsx"],
    ]) {
      const modal = code(client(...file));
      expect(modal).not.toContain("localStorage");
      expect(modal).not.toContain("sessionStorage");
      // Stored credentials mean the two fields are hidden, not pre-filled or left blank.
      expect(modal).toContain("useStored");
      // And an unused value is not sent at all.
      expect(modal).toContain("useStored ? undefined : hiworksId.trim()");
    }
  });

  test("AES-256-GCM round-trips with the nonce and tag widths the module names", () => {
    /*
     * The one computing test here. It does not call KMS - it takes the algorithm, the 12-byte nonce
     * and the 16-byte tag that `KmsEnvelopeUtils` declares and proves they interoperate, so that
     * editing one of those constants fails here rather than at the first Decrypt after a deploy.
     *
     * It also pins the two properties the code depends on: a tampered ciphertext THROWS rather than
     * decrypting to rubbish, and so does a wrong key. Both are the reason GCM was chosen over CBC.
     */
    const envelope = lambda("utils", "KmsEnvelopeUtils.ts");
    expect(envelope).toContain("const GCM_IV_BYTES = 12");
    expect(envelope).toContain("const GCM_TAG_BYTES = 16");
    expect(envelope).toContain('const GCM_ALGORITHM = "aes-256-gcm"');

    const key = randomBytes(32);
    const iv = randomBytes(12);
    const payload = JSON.stringify({ id: "abc@lionkorea.co.kr", password: "p@ss word " });

    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    const ciphertext = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    expect(tag).toHaveLength(16);

    const open = (c: Buffer, t: Buffer, k: Buffer) => {
      const decipher = createDecipheriv("aes-256-gcm", k, iv, { authTagLength: 16 });
      decipher.setAuthTag(t);
      return Buffer.concat([decipher.update(c), decipher.final()]).toString("utf8");
    };

    // The round trip, including the trailing space in the password that `v.trim()` must not eat.
    expect(JSON.parse(open(ciphertext, tag, key))).toEqual({
      id: "abc@lionkorea.co.kr",
      password: "p@ss word ",
    });

    // A flipped bit in the ciphertext fails, rather than decrypting to something.
    const tampered = Buffer.from(ciphertext);
    tampered[0] ^= 0x01;
    expect(() => open(tampered, tag, key)).toThrow();

    // And so does the right ciphertext under the wrong data key.
    expect(() => open(ciphertext, tag, randomBytes(32))).toThrow();
  });
});
