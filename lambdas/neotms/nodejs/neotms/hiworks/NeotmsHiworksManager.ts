// SPDX-License-Identifier: MIT
//
// The caller's own Hiworks sign-in: store it, forget it, and resolve it for a send.
//
// ## What changed, and what deliberately did not
//
// Before this module the id and password were typed into the send dialog every time and kept
// nowhere - `NeotmsHandoverManager`'s header says so at length, and that was the right design while
// there was nowhere safe to put them. Storing them is now possible, OPTIONAL, and per person: no
// row means the dialog asks, which is exactly the old behaviour. Nobody is required to opt in and
// nothing degrades for somebody who does not.
//
// Three properties from the old design are kept, because they are what made it defensible:
//
//   * The mail still goes out from the CALLER'S OWN Hiworks account. There is no shared company
//     sender, so this endpoint is still "do on my behalf what I could do by signing in myself"
//     rather than the authority to mail anybody under the company's name.
//   * The password is never returned, never logged, and never put in a response body. It leaves
//     this process only towards Hiworks, and it reaches the database only sealed.
//   * A credential belongs to one person. Nothing here takes a staff id from a request - it comes
//     from the guard - so there is no shape of request that reads a colleague's row.
//
// ## Why saving verifies against Hiworks first
//
// A save calls `hiworksLogin` once and refuses the credential if Hiworks does. The reason is where
// the error would otherwise surface: a password stored with a typo is silent until the day somebody
// sends a 인계메일 under a deadline, and at that point the failure looks like the mail feature being
// broken rather than like a setting that was wrong from the start. `neotms.schemas.ts` already makes
// this argument for the send path - "Hiworks is the authority on them, and it answers in one round
// trip" - and it applies with more force here, because this value is going to be reused.
//
// The cost is that saving needs Hiworks to be reachable. That is accepted: the alternative is
// storing credentials nobody has checked.
//
// ## What this module logs, and the one thing it must never log
//
// Every failure path logs one line tagged `[hiworks]`, naming the CAUSE. That tag exists so the
// question this feature actually raises - "was it the key, or was it Hiworks?" - can be answered by
// grepping rather than by reasoning, which matters because the non-production deployments share one
// database and a key that one of them cannot use is the expected kind of breakage there.
//
// `KmsEnvelopeUtils` logs the KMS side underneath, naming the operation, the key and the AWS error.
// Two lines for one event is deliberate: one says what KMS said, the other says what it meant for
// this feature.
//
// NOTHING here formats a message from `input` or from a resolved credential. The id and the
// password never appear in a log line, in any branch - a log is the easiest place in a system to
// leak a password, and these lines are written on exactly the paths where one is in scope. The
// staff id is logged instead: it identifies the person for support without being a secret.

import { hiworksLogin } from "../handover/HiworksClient.js";
import { isHiworksVaultConfigured, NeotmsEnv } from "../../env/NeotmsEnv.js";
import { openSecret, sealSecret, type KmsEncryptionContext } from "../../utils/KmsEnvelopeUtils.js";
import { pgExecute, pgQuery } from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { badRequest, ok, runDb } from "../NeotmsResult.js";
import type { HiworksCredentialSave } from "../neotms.schemas.js";
import {
  HiworksCredentialDeleteOps,
  HiworksCredentialSaveOps,
  HiworksCredentialSealedOps,
  HiworksCredentialStatusOps,
} from "./NeotmsHiworks.dbops.js";

/**
 * The pairs KMS must be given to unwrap a data key, and refuses to unwrap without.
 *
 * `staffId` is the load-bearing one: it binds each data key to its owner's row, so a wrapped key
 * copied into somebody else's row cannot be unwrapped. `app` and `purpose` cost nothing and keep
 * the key usable for this one thing, which matters if the CMK is ever shared with a second feature.
 *
 * Changing any of these three strings makes every stored credential unreadable - they are part of
 * the ciphertext's identity, not configuration. That is why they are a literal here rather than a
 * value anybody can set.
 */
const encryptionContextFor = (staffId: string): KmsEncryptionContext => ({
  app: "neotms",
  purpose: "hiworks",
  staffId,
});

/** What goes inside the sealed blob. Both halves of one credential, and nothing else. */
interface HiworksSecretPayload {
  id: string;
  password: string;
}

export interface HiworksCredentials {
  readonly id: string;
  readonly password: string;
}

/**
 * The masked id the settings screen shows.
 *
 * Two characters of the local part, then `***`, then the domain as it is: `ab***@lionkorea.co.kr`.
 * Enough to recognise which of your own accounts is stored, not enough to be an account name
 * somebody can try passwords against.
 *
 * The `***` is unconditional, including for ids too short to have anything to keep. db/013's
 * verification query leans on that - a hint with no `*` in it is how you would notice that a whole
 * id had been written here by mistake.
 */
export function maskHiworksId(hiworksId: string): string {
  const id = hiworksId.trim();
  const at = id.lastIndexOf("@");
  const local = at > 0 ? id.slice(0, at) : id;
  const domain = at > 0 ? id.slice(at) : "";
  const kept = local.length > 2 ? local.slice(0, 2) : "";
  return `${kept}***${domain}`;
}

export type HiworksCredentialView = {
  /**
   * Whether storing is possible at all on this deployment - `NEOTMS_HIWORKS_KMS_KEY_ID` is set.
   *
   * Sent so the screen can say "this is not configured" instead of offering a form whose save
   * would fail. A blank key is a supported mode, not a fault; see the environment variable.
   */
  vaultConfigured: boolean;
  registered: boolean;
  hiworksIdHint: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

/** Whether the caller has stored a Hiworks account, and which one - masked. */
export async function getHiworksCredential(
  caller: NeotmsCaller,
): Promise<ResponseData<HiworksCredentialView | string>> {
  return runDb("read the stored Hiworks credential", async () => {
    const stored = (await pgQuery(HiworksCredentialStatusOps(caller.staffId))).data;
    return ok({
      vaultConfigured: isHiworksVaultConfigured(),
      registered: stored !== null,
      hiworksIdHint: stored?.hiworksIdHint ?? null,
      createdAt: stored?.createdAt ?? null,
      updatedAt: stored?.updatedAt ?? null,
    });
  });
}

/**
 * Store, or replace, the caller's Hiworks sign-in.
 *
 * Order of operations, and each step is a refusal rather than a best effort: the deployment must
 * have a key, Hiworks must accept the credential, KMS must seal it, and only then is a row written.
 * A failure at any point leaves whatever was stored before untouched - there is no window in which
 * the old credential is gone and the new one is not yet there.
 */
export async function saveHiworksCredential(
  caller: NeotmsCaller,
  input: HiworksCredentialSave,
): Promise<ResponseData<HiworksCredentialView | string>> {
  if (!isHiworksVaultConfigured()) {
    console.warn(
      "[hiworks] save refused: no CMK is configured for this deployment " +
        "(NEOTMS_HIWORKS_KMS_KEY_ID is blank). This is the default for a stage that shares its " +
        "database; pass -c hiworksEncKeyArn=<shared key arn> to enable storing.",
    );
    return badRequest(
      "이 시스템에는 Hiworks 계정 저장이 설정되어 있지 않습니다. 메일을 보낼 때 직접 입력해 주세요.",
    );
  }

  /*
   * Hiworks decides, not a regex here. A sign-in id is whatever Hiworks accepts as one, and the
   * one authority on the pair answers in a single round trip - so the check that matters is the
   * real one, and there is no local rule to drift away from it.
   */
  const login = await hiworksLogin(input.hiworksId, input.hiworksPassword);
  if (!login.result) {
    /*
     * Same split the send path makes: Hiworks answers a wrong password with a 200 carrying no
     * session cookie, which `hiworksLogin` turns into a 500, so the status alone cannot separate
     * "wrong password" from "Hiworks is down". 200 and 4xx are read as a credential problem.
     */
    if (login.status === 200 || (login.status >= 400 && login.status < 500)) {
      console.warn(
        `[hiworks] save refused for staff ${caller.staffId}: Hiworks rejected the sign-in ` +
          `(status ${String(login.status)}). Not a key problem - the credential itself is wrong.`,
      );
      return badRequest("Hiworks 로그인에 실패했습니다. 아이디와 비밀번호를 확인해 주세요.");
    }
    console.error(
      `[hiworks] save failed for staff ${caller.staffId}: Hiworks is unreachable ` +
        `(status ${String(login.status)}). Not a key problem.`,
    );
    return { status: 502, body: "Hiworks 서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요." };
  }

  const payload: HiworksSecretPayload = { id: input.hiworksId, password: input.hiworksPassword };
  const sealed = await sealSecret(
    NeotmsEnv.NEOTMS_HIWORKS_KMS_KEY_ID,
    encryptionContextFor(caller.staffId),
    JSON.stringify(payload),
  );
  if (!sealed) {
    /*
     * THE KEY, not Hiworks - and the distinction is why this line exists. The sign-in above just
     * succeeded, so the credential is known good; what failed is this deployment's ability to use
     * its CMK. `sealSecret` has already logged the KMS operation, the key ARN and the AWS error
     * name directly above this line.
     */
    console.error(
      `[hiworks] save failed for staff ${caller.staffId}: the CMK could not be used - see the KMS ` +
        `error logged immediately above. Hiworks accepted the credential, so this is a key or ` +
        `grant problem, not a credential one.`,
    );
    return { status: 502, body: "암호화 키를 사용할 수 없어 저장하지 못했습니다. 관리자에게 알려 주세요." };
  }

  return runDb("store the Hiworks credential", async () => {
    await pgExecute(
      HiworksCredentialSaveOps(caller.staffId, maskHiworksId(input.hiworksId), sealed),
    );
    const stored = (await pgQuery(HiworksCredentialStatusOps(caller.staffId))).data;
    return ok({
      vaultConfigured: true,
      registered: stored !== null,
      hiworksIdHint: stored?.hiworksIdHint ?? null,
      createdAt: stored?.createdAt ?? null,
      updatedAt: stored?.updatedAt ?? null,
    });
  });
}

/**
 * Forget the caller's Hiworks sign-in.
 *
 * 204 whether or not a row was there. "Forget this" is satisfied by the row being absent, and
 * answering 404 to somebody who has already removed it would report a failure for a state they
 * asked for.
 */
export async function forgetHiworksCredential(
  caller: NeotmsCaller,
): Promise<ResponseData<string>> {
  return runDb("forget the Hiworks credential", async () => {
    await pgExecute(HiworksCredentialDeleteOps(caller.staffId));
    return { status: 204, body: "" };
  });
}

/** Either the pair to sign in with, or the response to answer the send request with. */
export type ResolvedHiworks =
  | { ok: true; credentials: HiworksCredentials }
  | { ok: false; response: ResponseData<string> };

/**
 * Work out which Hiworks account a send should use.
 *
 * The one place this decision is made, called by both mail managers, because "typed credentials
 * win over stored ones" is a rule that must not be able to differ between two screens.
 *
 * Typed credentials take precedence deliberately. The stored pair is a convenience; sending one
 * mail from a different account is a real need (a shared team account, somebody covering for a
 * colleague), and it must not require deleting and re-storing a credential to do it once.
 */
export async function resolveHiworksCredentials(
  caller: NeotmsCaller,
  typed: { hiworksId?: string; hiworksPassword?: string },
): Promise<ResolvedHiworks> {
  const id = typed.hiworksId?.trim() ?? "";
  const password = typed.hiworksPassword ?? "";

  if (id.length > 0 && password.length > 0) {
    return { ok: true, credentials: { id, password } };
  }

  /*
   * Half a credential is a mistake worth naming rather than quietly falling back on. Silently
   * using the stored pair when somebody typed an id and left the password blank would send from an
   * account they did not choose - and the success notice names the recipient, not the sender, so
   * they would have no way to notice.
   */
  if (id.length > 0 || password.length > 0) {
    return {
      ok: false,
      response: badRequest("Hiworks 아이디와 비밀번호를 모두 입력해 주세요."),
    };
  }

  const sealed = (await pgQuery(HiworksCredentialSealedOps(caller.staffId))).data;
  if (!sealed) {
    return {
      ok: false,
      response: badRequest(
        "저장된 Hiworks 계정이 없습니다. 아이디와 비밀번호를 입력하거나, 내 정보에서 계정을 저장해 주세요.",
      ),
    };
  }

  const opened = await openSecret(encryptionContextFor(caller.staffId), sealed);
  if (!opened) {
    /*
     * The CMK is gone, the key was rotated destructively, the row was tampered with, or the
     * encryption context no longer matches. Four causes, one honest answer: the stored credential
     * cannot be used, so ask for it again rather than reporting a server fault the sender can do
     * nothing about.
     */
    /*
     * The expected failure in the shared-database arrangement: this row was wrapped by ANOTHER
     * deployment, under a key this one may not use. `openSecret` has logged which of the two it
     * was - the key being unusable, or the key working and the bytes being wrong - directly above.
     */
    console.error(
      `[hiworks] send fell back to manual entry for staff ${caller.staffId}: the stored ` +
        `credential could not be opened. See the KMS error logged immediately above to tell a key ` +
        `problem from a damaged row.`,
    );
    return {
      ok: false,
      response: badRequest(
        "저장된 Hiworks 계정을 열 수 없습니다. 직접 입력하거나, 내 정보에서 다시 저장해 주세요.",
      ),
    };
  }

  const parsed = parsePayload(opened);
  if (!parsed) {
    // Decrypted cleanly and still is not what we wrote. Neither the key nor Hiworks - the row.
    console.error(
      `[hiworks] send fell back to manual entry for staff ${caller.staffId}: the stored credential ` +
        `decrypted but did not parse. The key is fine; the payload is not what this application writes.`,
    );
    return {
      ok: false,
      response: badRequest(
        "저장된 Hiworks 계정을 읽을 수 없습니다. 내 정보에서 다시 저장해 주세요.",
      ),
    };
  }
  return { ok: true, credentials: parsed };
}

/**
 * Read the decrypted JSON back, defensively.
 *
 * The blob was written by `saveHiworksCredential` and cannot be anything else - GCM's tag
 * guarantees that much. This still checks, because the alternative to a null here is a `JSON.parse`
 * throwing inside a send that has already been authorised, and an empty string being handed to a
 * login form as a password.
 */
function parsePayload(json: string): HiworksCredentials | null {
  try {
    const raw: unknown = JSON.parse(json);
    if (
      typeof raw !== "object" || raw === null ||
      !("id" in raw) || typeof raw.id !== "string" || raw.id.length === 0 ||
      !("password" in raw) || typeof raw.password !== "string" || raw.password.length === 0
    ) {
      return null;
    }
    return { id: raw.id, password: raw.password };
  } catch {
    return null;
  }
}
