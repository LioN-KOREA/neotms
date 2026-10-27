// SPDX-License-Identifier: MIT
//
// The record of one sent mail. Metadata lives in DynamoDB; the rendered HTML body lives in S3 and
// is referenced by key, so a long mail does not push the item towards DynamoDB's 400KB limit.

import * as v from "valibot";

/**
 * Delivery outcome as this system saw it.
 *
 * "accepted" means Mailgun took the message, NOT that it reached a mailbox — Mailgun's queue,
 * bounces and the recipient's spam filter all come later. Treating acceptance as delivery is the
 * usual mistake; anything stronger requires consuming Mailgun's event webhooks.
 */
export const LKMailRecordStatusSchema = v.picklist(["accepted", "failed"]);
export type LKMailRecordStatus = v.InferOutput<typeof LKMailRecordStatusSchema>;

export const LKMailRecordSchema = v.object({
    /** Our id for this mail. Generated before the send so a failure is recorded too. */
    mailRecordId: v.string(),
    mailSubject: v.string(),
    /** Account sub of the sender, or LK_MAIL_SYSTEM_OWNER. The GSI partition. */
    mailSenderSub: v.string(),
    /** The envelope sender actually used. */
    mailSenderEmail: v.string(),
    mailRecipients: v.array(v.string()),
    mailCc: v.array(v.string()),
    mailBcc: v.array(v.string()),
    /** Opaque attachment item keys, resolvable through the attachment records. */
    mailAttachments: v.array(v.string()),
    /** S3 key of the rendered HTML body. Empty if the body could not be stored. */
    mailContentKey: v.string(),
    /** Mailgun's message id. Empty on failure. */
    mailgunId: v.string(),
    mailStatus: LKMailRecordStatusSchema,
    /** Why the send failed, for the operator. Empty when accepted. */
    mailFailureReason: v.string(),
    /** Epoch MILLISECONDS. Also the GSI sort key. */
    mailSentOn: v.number(),
});
export type LKMailRecord = v.InferOutput<typeof LKMailRecordSchema>;
