// SPDX-License-Identifier: MIT
//
// Mail sending: Mailgun transport plus the orchestration around it (attachment retention, body
// archival, and the record of what was sent).
//
// NOTE ON LOGGING: this module lives in the `common` layer, which must not depend on a service
// layer, so it cannot use lpxWriteLogToQueue (that lives in the lpxauth layer and writes through
// the log queue). Everything here logs to console, which lands in CloudWatch. A caller that wants
// mail activity in the LPX log table should log around its own call.

import { randomUUID } from "node:crypto";
import * as v from "valibot";

import { LpxEnv } from "../configs/LpxEnv.js";
import type { ResponseBody } from "../interfaces/RequestResponse.js";
import { dynamoDBPut } from "../utils/DynamoDBUtils.js";
import { createS3Object, getS3Object, headS3Object } from "../utils/S3Utils.js";
import { getSecretField, getSecretString } from "../utils/SecretsUtils.js";
import { retainAttachment } from "./attachments/LKMailAttachmentManager.js";
import type { LKMailAttachment } from "./attachments/LKMailAttachmentObjects.js";
import {
    isOwnStagingKey,
    LK_MAIL_S3_PREFIX_BODIES,
    LK_MAIL_SYSTEM_OWNER,
    LKMailgunSendResultSchema,
    LKMailSendRequestSchema,
    type LKMailSendResult,
} from "./LKMailObjects.js";
import { putLKMailRecordOps } from "./records/LKMailRecordDynamoDBOps.js";
import type { LKMailRecord, LKMailRecordStatus } from "./records/LKMailRecordObjects.js";
import { buildLargeAttachmentLinks } from "./resources/LKNotificationEmailTemplate.js";

const MAIL_BUCKET = LpxEnv.LPX_MAIL_BUCKET_NAME;
const MAILGUN_DOMAIN = LpxEnv.LPX_MG_EMAIL_DOMAIN;
const INLINE_MAX_BYTES = Number(LpxEnv.LPX_MAIL_INLINE_ATTACHMENT_MAX_BYTES);
const ATTACHMENT_RETENTION_MS = Number(LpxEnv.LPX_MAIL_ATTACHMENT_RETENTION_DAYS) * 86_400_000;

/**
 * Mailgun rejects a message whose total size exceeds 25MB. The inline budget is deliberately below
 * that: the body, the headers and MIME base64 overhead all count towards Mailgun's limit, and an
 * attachment that pushes past it fails the whole send rather than one attachment.
 */
const INLINE_TOTAL_BUDGET_BYTES = 20 * 1024 * 1024;

export interface S3StreamData {
    stream: ReadableStream<Uint8Array>;
    name: string;
    type: string;
}

/**
 * The Mailgun API key, from Secrets Manager.
 *
 * There is deliberately NO environment-variable fallback. A fallback means a misconfigured deploy
 * silently sends mail with the wrong credentials — or, as in the code this was adapted from, with
 * a key committed to the repository.
 */
async function getMailgunApiKey(): Promise<string | null> {
    const secretName = LpxEnv.LPX_MG_SECRET_NAME;
    if (!secretName) {
        console.error("Mail: LPX_MG_SECRET_NAME is not configured; refusing to send.");
        return null;
    }
    // A secret created through the Secrets Manager console is a JSON document; one created by the
    // CLI with --secret-string is a bare string. Accept either rather than making the operator
    // guess which form this code wants.
    return (await getSecretField(secretName, "apiKey")) ?? (await getSecretString(secretName));
}

// -------- Multipart construction -----------------------------------------

type MultipartField =
    | { kind: "text"; name: string; value: string }
    | { kind: "stream"; name: string; filename: string; contentType: string; stream: ReadableStream<Uint8Array> };

/**
 * Build a streaming multipart body.
 *
 * Streaming rather than buffering matters on Lambda: a buffered 10MB attachment is 10MB of heap on
 * top of the base64 copy the runtime makes, and several at once is how a mail send OOMs a function
 * that looks adequately sized.
 */
function buildStreamingMultipart(fields: MultipartField[]): { body: ReadableStream<Uint8Array>; contentType: string } {
    const boundary = "----lpxBoundary" + randomUUID();
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for (const f of fields) {
                    if (f.kind === "text") {
                        controller.enqueue(encoder.encode(
                            `--${boundary}\r\n` +
                            `Content-Disposition: form-data; name="${f.name}"\r\n\r\n` +
                            `${f.value}\r\n`
                        ));
                    } else {
                        controller.enqueue(encoder.encode(
                            `--${boundary}\r\n` +
                            `Content-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n` +
                            `Content-Type: ${f.contentType}\r\n\r\n`
                        ));
                        const reader = f.stream.getReader();
                        try {
                            while (true) {
                                const { done, value } = await reader.read();
                                if (done) break;
                                if (value) controller.enqueue(value);
                            }
                        } finally {
                            reader.releaseLock();
                        }
                        controller.enqueue(encoder.encode("\r\n"));
                    }
                }
                controller.enqueue(encoder.encode(`--${boundary}--\r\n`));
                controller.close();
            } catch (err) {
                controller.error(err);
            }
        },
    });
    return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

// -------- Transport -------------------------------------------------------

/**
 * Post one message to Mailgun. Transport only — no records, no attachments bookkeeping.
 *
 * Exported for callers that genuinely want a bare send (a connectivity check, a one-off). Normal
 * callers want sendMail, which records what it sent.
 */
export async function sendEmailUsingMailgun(options: {
    senderName: string;
    senderEmail: string;
    recipients: string[];
    cc?: string[];
    bcc?: string[];
    replyTo?: string;
    subject: string;
    htmlContents: string;
    attachments?: S3StreamData[];
}): Promise<ResponseBody<string>> {
    if (!MAILGUN_DOMAIN) {
        console.error("Mail: LPX_MG_EMAIL_DOMAIN is not configured; refusing to send.");
        return { status: 500, message: "Mail is not configured", data: "" };
    }
    const apiKey = await getMailgunApiKey();
    if (!apiKey) {
        return { status: 500, message: "Mail is not configured", data: "" };
    }

    const url = `https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`;
    const auth = "Basic " + Buffer.from(`api:${apiKey}`).toString("base64");

    const fields: MultipartField[] = [
        { kind: "text", name: "from", value: `${options.senderName} <${options.senderEmail}>` },
        { kind: "text", name: "subject", value: options.subject },
        { kind: "text", name: "html", value: options.htmlContents },
    ];
    for (const to of options.recipients) fields.push({ kind: "text", name: "to", value: to });
    // Empty cc/bcc fields are omitted rather than sent blank: Mailgun treats an empty recipient
    // field as a malformed address on some plans.
    for (const cc of options.cc ?? []) fields.push({ kind: "text", name: "cc", value: cc });
    for (const bcc of options.bcc ?? []) fields.push({ kind: "text", name: "bcc", value: bcc });
    if (options.replyTo) fields.push({ kind: "text", name: "h:Reply-To", value: options.replyTo });
    for (const a of options.attachments ?? []) {
        fields.push({ kind: "stream", name: "attachment", filename: a.name, contentType: a.type, stream: a.stream });
    }

    const { body, contentType } = buildStreamingMultipart(fields);

    let resp: Response;
    try {
        resp = await fetch(url, {
            method: "POST",
            headers: { Authorization: auth, "Content-Type": contentType },
            body,
            // Required by undici whenever the request body is a stream.
            duplex: "half",
        } as RequestInit & { duplex: "half" });
    } catch (err) {
        console.error("Mail: the request to Mailgun failed: " + (err as Error).message);
        return { status: 502, message: "Could not reach the mail provider", data: "" };
    }

    // Mailgun answers errors with JSON too, but a gateway failure can return HTML. Parse
    // defensively so a 502 from in front of Mailgun does not surface as a JSON syntax error.
    let parsedBody: unknown = null;
    try {
        parsedBody = await resp.json();
    } catch {
        parsedBody = null;
    }
    const parsed = v.safeParse(LKMailgunSendResultSchema, parsedBody);

    if (resp.status === 200) {
        if (!parsed.success) {
            console.warn("Mail: Mailgun accepted the message but returned an unexpected body shape.");
            return { status: 200, message: "Mail accepted; the provider's message id is unknown", data: "" };
        }
        return { status: 200, message: parsed.output.message, data: parsed.output.id };
    }

    const detail = parsed.success ? parsed.output.message : `provider returned ${resp.status}`;
    console.error(`Mail: Mailgun rejected the message (${resp.status}): ${detail}`);
    // 4xx from Mailgun is our fault (bad address, bad domain, over size) and retrying is pointless;
    // 5xx is theirs and may be worth one retry by the caller.
    return { status: resp.status >= 500 ? 502 : 400, message: detail, data: "" };
}

// -------- Orchestration ---------------------------------------------------

async function openAttachmentStream(attachment: LKMailAttachment): Promise<S3StreamData | null> {
    const obj = await getS3Object(attachment.itemS3Key, MAIL_BUCKET);
    if (!obj?.Body) {
        console.error(`Mail: attachment "${attachment.itemKey}" has no object body in S3.`);
        return null;
    }
    return {
        stream: obj.Body.transformToWebStream(),
        name: attachment.itemName,
        type: attachment.itemContentType,
    };
}

/**
 * Send one mail, retaining its attachments and recording what was sent.
 *
 * Order of operations, and why: attachments are retained and recorded BEFORE the send, because a
 * large attachment has to have an item key before a link to it can go in the body. A send that
 * then fails leaves retained attachments and a record marked "failed" — which is the honest
 * outcome, and the bucket's lifecycle rule reclaims the objects either way. The alternative
 * (send first) cannot produce the links at all.
 */
export async function sendMail(input: unknown): Promise<ResponseBody<LKMailSendResult | null>> {
    const parsedReq = v.safeParse(LKMailSendRequestSchema, input);
    if (!parsedReq.success) {
        console.error("sendMail: invalid request: " + JSON.stringify(parsedReq.issues));
        return { status: 400, message: "Invalid request", data: null };
    }
    const req = parsedReq.output;

    const senderEmail = LpxEnv.LPX_MAIL_FROM_ADDRESS;
    if (!senderEmail) {
        console.error("sendMail: LPX_MAIL_FROM_ADDRESS is not configured; refusing to send.");
        return { status: 500, message: "Mail is not configured", data: null };
    }
    // A send with no attachments works without a bucket (only the body archival is skipped), but
    // attachments cannot. Checking here turns a confusing SDK error deep in headS3Object into a
    // configuration message.
    if (req.attachmentKeys.length > 0 && !MAIL_BUCKET) {
        console.error("sendMail: attachments were supplied but LPX_MAIL_BUCKET_NAME is not configured.");
        return { status: 500, message: "Attachments are not available", data: null };
    }

    const senderName = req.senderName || LpxEnv.LPX_MAIL_FROM_NAME;
    const ownerSub = req.senderSub || LK_MAIL_SYSTEM_OWNER;
    const mailRecordId = randomUUID();
    const sentOn = Date.now();

    // ---- Classify the staged attachments ----------------------------------
    //
    // Each key is checked against the caller's own staging prefix first. The send path takes keys
    // from the caller, so without this a caller could name another user's object and have its
    // contents mailed to an address of their choosing.
    const inlineKeys: string[] = [];
    const linkKeys: string[] = [];
    let inlineBudgetLeft = INLINE_TOTAL_BUDGET_BYTES;

    for (const key of req.attachmentKeys) {
        if (!isOwnStagingKey(key, ownerSub)) {
            console.warn(`sendMail: rejecting attachment key outside the sender's staging prefix.`);
            return { status: 403, message: "An attachment does not belong to the sender", data: null };
        }
        const head = await headS3Object(key, MAIL_BUCKET);
        if (!head) {
            // The staged upload never landed, or already expired. Dropping it is better than
            // failing a send the user believes is ready; the record shows what was attached.
            console.warn("sendMail: a staged attachment is missing; it will be skipped.");
            continue;
        }
        const size = head.ContentLength ?? 0;
        if (size <= INLINE_MAX_BYTES && size <= inlineBudgetLeft) {
            inlineBudgetLeft -= size;
            inlineKeys.push(key);
        } else {
            linkKeys.push(key);
        }
    }

    // ---- Retain and record them -------------------------------------------
    const inlineAttachments: LKMailAttachment[] = [];
    for (const key of inlineKeys) {
        const retained = await retainAttachment(key, ownerSub, mailRecordId, "inline");
        if (retained) inlineAttachments.push(retained);
    }
    const linkedAttachments: LKMailAttachment[] = [];
    for (const key of linkKeys) {
        const retained = await retainAttachment(key, ownerSub, mailRecordId, "link");
        if (retained) linkedAttachments.push(retained);
    }

    // ---- Compose ----------------------------------------------------------
    const htmlBody = req.htmlContents + buildLargeAttachmentLinks(
        LpxEnv.LPX_MAIL_DOWNLOAD_BASE_URL,
        linkedAttachments,
        sentOn + ATTACHMENT_RETENTION_MS,
    );

    // The rendered body is archived so the record can show what was actually sent. A failure here
    // is not fatal — the mail still goes out, and the record simply carries no content key.
    let mailContentKey = "";
    if (MAIL_BUCKET) {
        try {
            mailContentKey = await createS3Object(`${LK_MAIL_S3_PREFIX_BODIES}/${mailRecordId}-`, htmlBody, MAIL_BUCKET);
        } catch (err) {
            console.error("sendMail: could not archive the mail body: " + (err as Error).message);
        }
    }

    const streams: S3StreamData[] = [];
    for (const attachment of inlineAttachments) {
        const stream = await openAttachmentStream(attachment);
        if (stream) streams.push(stream);
    }

    const formatted = (list: { name: string; email: string }[]) =>
        list.map((r) => (r.name ? `${r.name} <${r.email}>` : r.email));

    // ---- Send -------------------------------------------------------------
    const sendResult = await sendEmailUsingMailgun({
        senderName,
        senderEmail,
        recipients: formatted(req.recipients),
        cc: formatted(req.cc),
        bcc: formatted(req.bcc),
        ...(req.replyTo && { replyTo: req.replyTo }),
        subject: req.subject,
        htmlContents: htmlBody,
        attachments: streams,
    });

    // ---- Record -----------------------------------------------------------
    const status: LKMailRecordStatus = sendResult.status === 200 ? "accepted" : "failed";
    const record: LKMailRecord = {
        mailRecordId,
        mailSubject: req.subject,
        mailSenderSub: ownerSub,
        mailSenderEmail: senderEmail,
        mailRecipients: req.recipients.map((r) => r.email),
        mailCc: req.cc.map((r) => r.email),
        // Bcc addresses are recorded: the point of the record is that the sender can see what they
        // sent, and a bcc is only hidden from the other recipients.
        mailBcc: req.bcc.map((r) => r.email),
        mailAttachments: [...inlineAttachments, ...linkedAttachments].map((a) => a.itemKey),
        mailContentKey,
        mailgunId: sendResult.data,
        mailStatus: status,
        mailFailureReason: status === "failed" ? sendResult.message : "",
        mailSentOn: sentOn,
    };
    const put = await dynamoDBPut(putLKMailRecordOps(record));
    if (put.status !== 200) {
        // The mail may already be on its way. Failing the call now would invite a retry that sends
        // it twice, so the send result stands and the lost record is logged loudly.
        console.error(`sendMail: the mail record ${mailRecordId} could not be stored: ${put.status} ${put.message}`);
    }

    if (status === "failed") {
        return { status: sendResult.status, message: sendResult.message, data: null };
    }
    return {
        status: 200,
        message: "Mail accepted",
        data: { mailRecordId, mailgunId: sendResult.data },
    };
}
