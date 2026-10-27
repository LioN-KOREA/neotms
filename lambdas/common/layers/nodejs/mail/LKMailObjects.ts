// SPDX-License-Identifier: MIT
//
// Shared types for the mail domain.
//
// Sender identity is a *sub id*, not an address: a mail record and its attachments are queryable
// by the account that produced them, and the address on an account can change. Mail the system
// sends on its own behalf (notifications, password recovery) is owned by LK_MAIL_SYSTEM_OWNER.

import * as v from "valibot";

/**
 * Owner recorded for mail the application sent, as opposed to mail a signed-in user sent.
 *
 * It is a reserved value rather than an empty string so that the GSI partition is always present
 * and a query for system mail is the same query shape as a query for a user's mail. A Cognito sub
 * is a UUID, so this cannot collide with a real account.
 */
export const LK_MAIL_SYSTEM_OWNER = "SYSTEM";

export const LKMailRecipientSchema = v.object({
    name: v.pipe(v.string(), v.trim()),
    email: v.pipe(v.string(), v.trim(), v.email()),
});
export type LKMailRecipient = v.InferOutput<typeof LKMailRecipientSchema>;

/**
 * A request to send one mail.
 *
 * `attachmentKeys` are **staging** S3 keys handed out by createAttachmentUploadURL. They are
 * promoted into the retained prefix when the mail is sent, so a key that is never used in a send
 * is cleaned up by the bucket's short staging lifecycle.
 *
 * The sender's address is NOT taken from the request: it is the configured envelope sender. Mailgun
 * will happily send as any From address on a verified domain, so accepting one from a caller would
 * let a user send mail as anybody in the company.
 */
export const LKMailSendRequestSchema = v.object({
    recipients: v.pipe(v.array(LKMailRecipientSchema), v.minLength(1)),
    cc: v.optional(v.array(LKMailRecipientSchema), []),
    bcc: v.optional(v.array(LKMailRecipientSchema), []),
    subject: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(500)),
    htmlContents: v.string(),
    attachmentKeys: v.optional(v.array(v.string()), []),
    /** Account sub of the sender. Defaults to the system owner when the app is the sender. */
    senderSub: v.optional(v.string(), LK_MAIL_SYSTEM_OWNER),
    /** Display name on the From header. The address itself is always the configured sender. */
    senderName: v.optional(v.string()),
    /** Reply-To, when replies should reach a person rather than the no-reply address. */
    replyTo: v.optional(v.pipe(v.string(), v.trim(), v.email())),
});
export type LKMailSendRequest = v.InferOutput<typeof LKMailSendRequestSchema>;

/** Mailgun's accepted-message response. */
export const LKMailgunSendResultSchema = v.object({
    id: v.string(),
    message: v.string(),
});
export type LKMailgunSendResult = v.InferOutput<typeof LKMailgunSendResultSchema>;

export interface LKMailSendResult {
    /** Our own record id, for looking the mail up afterwards. */
    mailRecordId: string;
    /** Mailgun's message id. Empty when Mailgun accepted the mail but returned an odd body. */
    mailgunId: string;
}

/** Request for a presigned upload URL. */
export const LKMailAttachmentUploadRequestSchema = v.object({
    fileName: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(255)),
    fileType: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(255)),
});
export type LKMailAttachmentUploadRequest = v.InferOutput<typeof LKMailAttachmentUploadRequestSchema>;

// -------- S3 key prefixes ------------------------------------------------
//
// Each prefix has its own lifecycle rule on the mail bucket, so the prefix IS the retention
// policy. Moving an object between prefixes is how its retention changes.

/** Freshly presigned uploads. Expire after LPX_MAIL_STAGING_RETENTION_DAYS (1 day by default). */
export const LK_MAIL_S3_PREFIX_STAGING = "staging";
/** Attachments belonging to a sent mail. Expire after LPX_MAIL_ATTACHMENT_RETENTION_DAYS (21). */
export const LK_MAIL_S3_PREFIX_ATTACHMENTS = "attachments";
/** Rendered mail bodies. Retained for as long as the record they belong to. */
export const LK_MAIL_S3_PREFIX_BODIES = "bodies";

/**
 * Strip the `<uuid>-` that the staging key generator prepends, so the recipient sees the filename
 * they uploaded rather than an S3 key.
 */
export function originalFileNameFromKey(key: string): string {
    const tail = key.substring(key.lastIndexOf("/") + 1);
    const uuidPrefix = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;
    return uuidPrefix.test(tail) ? tail.replace(uuidPrefix, "") : tail;
}

/**
 * Is this key one we handed out for this owner to upload into?
 *
 * The send path accepts attachment keys from the caller, so without this check a caller could name
 * any key in the bucket — including another user's retained attachment — and have its contents
 * mailed to an address of their choosing. The owner segment is what makes the key unguessable-ish
 * AND checkable, so both are enforced.
 */
export function isOwnStagingKey(key: string, ownerSub: string): boolean {
    return key.startsWith(`${LK_MAIL_S3_PREFIX_STAGING}/${ownerSub}/`);
}
