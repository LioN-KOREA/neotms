// SPDX-License-Identifier: MIT
//
// The attachment record: what was attached to a mail, by whom, and where the object lives.

import * as v from "valibot";

export const LKMailAttachmentSchema = v.object({
    /** Opaque id handed to clients. Conceals the S3 key, which is never exposed. */
    itemKey: v.string(),
    /** The filename as uploaded, shown to the user and used on the mail attachment. */
    itemName: v.string(),
    /** MIME type as declared at upload time (e.g. image/png). */
    itemContentType: v.string(),
    /** The real S3 key. Server-side only — a client never sees or supplies this. */
    itemS3Key: v.string(),
    /** Size in bytes, as reported by S3 after the upload landed. */
    itemSize: v.number(),
    /** Epoch MILLISECONDS. Also the GSI sort key, so a user can query their items by date. */
    itemCreatedOn: v.number(),
    /**
     * Epoch MILLISECONDS. Mirrors the bucket's lifecycle rule for the attachments prefix: after
     * this moment the object is gone, so a download is refused rather than handing out a
     * presigned URL for a key that no longer resolves.
     */
    itemExpiresOn: v.number(),
    /** Account sub of the uploader, or LK_MAIL_SYSTEM_OWNER. The GSI partition. */
    itemOwner: v.string(),
    /** Record id of the mail this was attached to. Empty until the mail is sent. */
    itemMailRecordId: v.string(),
    /** Was it sent inline in the message, or linked for download? */
    itemDelivery: v.picklist(["inline", "link"]),
});
export type LKMailAttachment = v.InferOutput<typeof LKMailAttachmentSchema>;

/** A client asking for a download URL names only the opaque item key. */
export const LKMailAttachmentDownloadRequestSchema = v.object({
    itemKey: v.pipe(v.string(), v.trim(), v.minLength(1)),
});
export type LKMailAttachmentDownloadRequest = v.InferOutput<typeof LKMailAttachmentDownloadRequestSchema>;
