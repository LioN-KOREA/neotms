// SPDX-License-Identifier: MIT
//
// Sending a system mail (no-reply notifications) through Mailgun.
//
// Nothing calls this yet - the mail NEOTMS sends today goes out from the user's own Hiworks account
// (handover/, purchase-orders/). It is here so that the first feature needing a mail sent on the
// SYSTEM's behalf is one function call, with the credentials, the grant and the sender already
// proven, rather than a configuration project discovered at release time.
//
// Deliberately small: text/HTML body, to/cc/bcc, reply-to. No attachments - the PO request mail
// shows the pattern for large files (S3 + a tokenised link), and a no-reply notification should not
// carry files at all.

import { NeotmsEnv } from "../../env/NeotmsEnv.js";
import { readMailgunCredentials } from "./NeotmsMailgunSecret.js";

const MAILGUN_API_BASE = "https://api.mailgun.net/v3";
const SEND_TIMEOUT_MS = 10_000;

export interface MailgunMessage {
  readonly to: readonly string[];
  readonly subject: string;
  readonly html: string;
  /** Plain-text alternative. Optional; Mailgun derives none on its own. */
  readonly text?: string;
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly replyTo?: string;
}

export type MailgunSendResult =
  | { readonly ok: true; readonly messageId: string }
  | { readonly ok: false; readonly reason: "not-configured" | "invalid-message" | "rejected" | "unreachable"; readonly status?: number };

/**
 * The envelope sender: `NEOTMS_MAIL_FROM_ADDRESS` when set, otherwise `no-reply@<domain>`.
 *
 * The default uses the domain from the secret, so a stage whose secret is populated can send
 * without any further configuration, and the sender can never name a domain the key cannot send for.
 */
export function senderAddress(domain: string): string {
  const configured = NeotmsEnv.NEOTMS_MAIL_FROM_ADDRESS.trim();
  return configured.length > 0 ? configured : `no-reply@${domain}`;
}

/** The form body Mailgun's messages endpoint expects. Exported for tests. */
export function buildMailgunForm(message: MailgunMessage, from: string): URLSearchParams {
  const form = new URLSearchParams();
  form.append("from", from);
  for (const to of message.to) form.append("to", to);
  // Empty cc/bcc are omitted rather than sent blank: Mailgun treats an empty recipient as malformed.
  for (const cc of message.cc ?? []) form.append("cc", cc);
  for (const bcc of message.bcc ?? []) form.append("bcc", bcc);
  form.append("subject", message.subject);
  form.append("html", message.html);
  if (message.text) form.append("text", message.text);
  if (message.replyTo) form.append("h:Reply-To", message.replyTo);
  return form;
}

/**
 * Send one message. Never throws; the result says why a send did not happen.
 *
 * Recipients, subject and body are never logged - only counts, the status and Mailgun's message id.
 */
export async function sendMailgunMail(message: MailgunMessage): Promise<MailgunSendResult> {
  if (message.to.length === 0 || message.subject.trim().length === 0) {
    return { ok: false, reason: "invalid-message" };
  }

  const credentials = await readMailgunCredentials();
  if (!credentials) return { ok: false, reason: "not-configured" };

  const from = `${NeotmsEnv.NEOTMS_MAIL_FROM_NAME} <${senderAddress(credentials.domain)}>`;
  const auth = "Basic " + Buffer.from(`api:${credentials.apiKey}`).toString("base64");

  let resp: Response;
  try {
    resp = await fetch(`${MAILGUN_API_BASE}/${encodeURIComponent(credentials.domain)}/messages`, {
      method: "POST",
      headers: { Authorization: auth },
      body: buildMailgunForm(message, from),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err: unknown) {
    const name = err instanceof Error ? err.name : "UnknownError";
    console.error(`[mail] Mailgun unreachable: ${name}`);
    return { ok: false, reason: "unreachable" };
  }

  if (!resp.ok) {
    // 401 = wrong key for this domain/account, 404 = domain unknown to Mailgun, 400 = bad message.
    console.error(`[mail] Mailgun refused the message: HTTP ${resp.status}`);
    return { ok: false, reason: "rejected", status: resp.status };
  }

  let messageId = "";
  try {
    const body = (await resp.json()) as { id?: unknown };
    if (typeof body.id === "string") messageId = body.id;
  } catch {
    // A 2xx without a JSON body still means accepted; the id is only for correlation.
  }
  console.info(`[mail] sent via Mailgun to ${message.to.length} recipient(s) ${messageId}`);
  return { ok: true, messageId };
}
