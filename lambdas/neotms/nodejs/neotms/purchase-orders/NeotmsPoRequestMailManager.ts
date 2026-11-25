// SPDX-License-Identifier: MIT
//
// The PO request mail endpoint: tells a translator that work is waiting, with links to the files.
//
// A near-twin of `NeotmsHandoverManager`, and the parts that differ are the parts worth reading:
//
//   * It sends OUTSIDE the company. The handover mail goes to a colleague's address; this one goes
//     to a translator, and it carries links that anyone holding them can use. That is why the
//     attachment tokens are resolved here, from rows this server wrote, rather than accepted as
//     URLs from the client.
//   * It is gated on approval. `purchase_order.po_approved` is what commits the company to an
//     amount, and this mail tells somebody to start work on that amount - so an unapproved PO
//     cannot be sent, the same rule the printable PO already follows (NeotmsMenus.PAYMENT).
//   * It has a permission of its own, `NEOTMS_PERMISSION_PO_EMAIL`, which existed before this
//     feature did and was granted to nobody precisely because nothing stood behind it. It does now.
//
// ## The credentials only pass through
//
// `hiworksId` and `hiworksPassword` arrive in the body, go to `hiworksLogin`, and that is the end
// of them - not stored, not logged, not returned. The mail goes out from the SENDER'S OWN Hiworks
// account, so this endpoint performs on their behalf something they could do by signing in to
// Hiworks directly; there is no shared company sender whose use would need separate authority.

import { pgQuery } from "../../utils/PostgresUtils.js";
import { dynamoDBGet } from "../../utils/DynamoDBUtils.js";
import { NeotmsEnv } from "../../env/NeotmsEnv.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { badRequest, notFound, ok, runDb } from "../NeotmsResult.js";
import type { PoRequestMailSend } from "../neotms.schemas.js";
import { hiworksLogin, hiworksSendEmail } from "../handover/HiworksClient.js";
import { resolveHiworksCredentials } from "../hiworks/NeotmsHiworksManager.js";
import { AttachmentGetOps } from "../attachments/NeotmsAttachment.dbops.js";
import { PoGetOps, type PurchaseOrderRow } from "./NeotmsPurchaseOrder.dbops.js";
import {
  composePoRequestMail,
  type PoAttachmentLink,
  type PoRequestFacts,
} from "./NeotmsPORequestEmail.js";

export type PoRequestMailSent = { subject: string; recipient: string; attachments: number };

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/**
 * `2026-12-01` + `12:00` becomes `12/1(월) 오후 12시`.
 *
 * Built through `Date.UTC` for the reason `NeotmsHandoverMail` gives at length: a date in this
 * schema has no timezone, and `new Date("2026-12-01")` is UTC midnight, so asking it for a LOCAL
 * weekday anywhere behind UTC answers with the previous day's name. That bug is green in Lambda
 * and in CI, both of which run in UTC, and wrong on the reviewer's machine.
 */
function deadline(day: string | null, time: string | null): string {
  if (!day) return "-";
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
  const date = `${String(m)}/${String(d)}(${weekday})`;
  if (!time) return date;

  const [hh, mm] = time.split(":").map(Number);
  if (hh === undefined || Number.isNaN(hh)) return date;
  const half = hh < 12 ? "오전" : "오후";
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  const minutes = mm ? `${String(mm)}분` : "";
  return `${date} ${half} ${String(hour12)}시${minutes}`;
}

/** `영어 > 한국어`, or `-` for work that has no language pair at all (MICE, IMC). */
const languagePair = (po: PurchaseOrderRow): string => {
  if (!po.poSlang && !po.poElang) return "-";
  return `${po.poSlang ?? "?"} > ${po.poElang ?? "?"}`;
};

/** `2500자`, or `-`. The unit code is the company's own label and goes out as written. */
const volume = (po: PurchaseOrderRow): string => {
  const amount = po.poVolume?.trim();
  if (!amount) return "-";
  return po.poUnitCode?.trim() ? `${amount}${po.poUnitCode.trim()}` : amount;
};

/**
 * Turn the tokens the client named into links, refusing any it does not own.
 *
 * Every check here is about one thing: the client may name tokens, and must not be able to name
 * SOMEBODY ELSE'S. A token is unguessable, so this is defence against a token that leaked rather
 * than one that was guessed - but "the file was already mailed to a translator, so its token is
 * out there" is exactly the case, and without the `poId` check a leaked token could be re-mailed
 * against any PO by anyone who could reach this endpoint.
 */
async function resolveAttachments(
  poId: string,
  tokens: readonly string[],
  baseUrl: string,
): Promise<{ links: PoAttachmentLink[] } | { error: string }> {
  const links: PoAttachmentLink[] = [];

  for (const token of tokens) {
    const found = await dynamoDBGet(AttachmentGetOps(token));
    const record = found.data;
    if (!record) {
      return { error: "An uploaded file is no longer available. Upload it again and retry." };
    }
    if (record.poId !== poId) {
      /*
       * Deliberately the same message as "not found". Telling the two apart would confirm to the
       * caller that a token they hold is real but belongs elsewhere, which is more than a refusal
       * needs to say.
       */
      return { error: "An uploaded file is no longer available. Upload it again and retry." };
    }
    if (record.expiresAt <= Date.now()) {
      return { error: "An uploaded file has expired. Upload it again and retry." };
    }
    links.push({
      url: `${baseUrl}/api/v0/attachments/${encodeURIComponent(token)}`,
      fileName: record.fileName,
    });
  }

  return { links };
}

/**
 * One PO request mail.
 *
 * The call order IS the authorization, the same as the handover mail: the PO is read first THROUGH
 * ITS ROW SCOPE, and a PO the caller cannot see ends the request with a 404 - before the approval
 * check, before the attachments are resolved, and before anything is signed in to. Trying the
 * Hiworks credentials first would hand somebody guessing at PO ids two facts instead of none.
 */
export async function sendPoRequestMail(
  caller: NeotmsCaller,
  poId: string,
  input: PoRequestMailSend,
): Promise<ResponseData<PoRequestMailSent | string>> {
  const baseUrl = NeotmsEnv.NEOTMS_PUBLIC_BASE_URL.replace(/\/+$/, "");
  /*
   * Refused rather than sent with broken links. Without the console's own origin the links would be
   * built from nothing and land the translator on a relative URL - and a mail that has already been
   * sent cannot be corrected.
   */
  if (input.attachments.length > 0 && !baseUrl) {
    console.error("NEOTMS_PUBLIC_BASE_URL is not set; refusing to send links that cannot work.");
    return {
      status: 500,
      body:
        "This deployment cannot build attachment links yet (NEOTMS_PUBLIC_BASE_URL is unset). " +
        "Send without attachments, or ask an administrator to set it.",
    };
  }

  const po = await runDb("read purchase order for request mail", async () => {
    const row = (await pgQuery(PoGetOps(caller, poId))).data;
    return row ? ok(row) : notFound("purchase order");
  });
  if (po.status !== 200) return po as ResponseData<string>;
  const row = po.body as PurchaseOrderRow;

  /*
   * Approval, checked after the row is known to be visible. The rule is the printable PO's: the
   * approval is what commits the company to the amount, and this mail tells a translator to start
   * work on it.
   */
  if (!row.poApproved) {
    return {
      status: 409,
      body:
        `${row.poCode} is not approved yet. A request mail tells the translator to start work on ` +
        `an amount the company has not signed off, so it is sent after approval - the same rule ` +
        `the printable purchase order follows.`,
    };
  }

  const resolved = await resolveAttachments(poId, input.attachments, baseUrl);
  if ("error" in resolved) return badRequest(resolved.error);

  const facts: PoRequestFacts = {
    poCode: row.poCode,
    projectName: row.prjName,
    translatorName: row.poTranName?.trim() || "담당",
    pmName: caller.name?.trim() || caller.mgrId,
    languages: languagePair(row),
    volume: volume(row),
    deadline: deadline(row.poEday, row.poEdayTime),
  };

  const mail = composePoRequestMail(facts, {
    originalFormats: input.originalFormats,
    workspaceFormats: input.workspaceFormats,
    note: input.note,
    attachments: resolved.links,
  });

  /*
   * Typed in the dialog, or stored on 내 정보. The same resolver the handover mail uses, so a
   * person who stored an account has it work on both screens or neither (neotms/hiworks/).
   */
  const credentials = await resolveHiworksCredentials(caller, input);
  if (!credentials.ok) return credentials.response;

  const signedIn = await hiworksLogin(credentials.credentials.id, credentials.credentials.password);
  if (!signedIn.result) {
    return {
      status: 502,
      body: "Hiworks refused the sign-in. Check the ID and password and try again.",
    };
  }

  const sent = await hiworksSendEmail(
    signedIn.result,
    [input.recipient],
    [],
    [],
    mail.subject,
    mail.body,
  );
  if (sent.status >= 400) {
    return { status: 502, body: "Hiworks accepted the sign-in but refused to send the mail." };
  }

  return ok({
    subject: mail.subject,
    recipient: input.recipient,
    attachments: resolved.links.length,
  });
}
