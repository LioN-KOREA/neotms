// SPDX-License-Identifier: MIT
//
// Attachment lifecycle: presign an upload, promote a staged object once its mail is sent, record
// it, and hand out short-lived download URLs.

import { randomUUID } from "node:crypto";
import * as v from "valibot";

import { LpxEnv } from "../../configs/LpxEnv.js";
import type { ResponseBody } from "../../interfaces/RequestResponse.js";
import { dynamoDBDelete, dynamoDBGet, dynamoDBPut, dynamoDBQuery } from "../../utils/DynamoDBUtils.js";
import {
    generateS3PresignedGetURL,
    generateS3PresignedUploadURL,
    headS3Object,
    moveS3Object,
    type S3PresignedURLObject,
} from "../../utils/S3Utils.js";
import {
    isOwnStagingKey,
    LK_MAIL_S3_PREFIX_ATTACHMENTS,
    LK_MAIL_S3_PREFIX_STAGING,
    LKMailAttachmentUploadRequestSchema,
    originalFileNameFromKey,
} from "../LKMailObjects.js";
import {
    deleteLKMailAttachmentOps,
    getLKMailAttachmentOps,
    putLKMailAttachmentOps,
    queryLKMailAttachmentsByOwnerOps,
} from "./LKMailAttachmentDynamoDBOps.js";
import type { LKMailAttachment } from "./LKMailAttachmentObjects.js";

const MAIL_BUCKET = LpxEnv.LPX_MAIL_BUCKET_NAME;
const ATTACHMENT_RETENTION_MS = Number(LpxEnv.LPX_MAIL_ATTACHMENT_RETENTION_DAYS) * 86_400_000;

/**
 * Presign an upload into the caller's own staging prefix.
 *
 * The owner sub is part of the key, which is what makes the send path able to verify that a caller
 * only attaches objects it uploaded itself (see isOwnStagingKey). Objects here are deleted by the
 * bucket's staging lifecycle rule within a day, so an upload that is never attached to a mail —
 * an abandoned compose, a failed send — cleans itself up without any reconciliation job.
 */
export async function createAttachmentUploadURL(
    input: unknown,
    ownerSub: string,
): Promise<ResponseBody<S3PresignedURLObject | null>> {
    if (!MAIL_BUCKET) {
        console.error("createAttachmentUploadURL: LPX_MAIL_BUCKET_NAME is not configured.");
        return { status: 500, message: "Attachments are not available", data: null };
    }
    const parsed = v.safeParse(LKMailAttachmentUploadRequestSchema, input);
    if (!parsed.success) {
        return { status: 400, message: "Invalid request", data: null };
    }
    if (!ownerSub) {
        return { status: 401, message: "Unauthenticated", data: null };
    }
    try {
        // The filename is NOT taken from the client verbatim: a key is built from a fresh UUID plus
        // the sanitized name, so a name containing "/" or ".." cannot reach outside the prefix the
        // ownership check relies on.
        const safeName = parsed.output.fileName.replace(/[^\p{L}\p{N}._-]/gu, "_");
        const fileKey = `${LK_MAIL_S3_PREFIX_STAGING}/${ownerSub}/${randomUUID()}-${safeName}`;
        const presigned = await generateS3PresignedUploadURL(
            safeName,
            parsed.output.fileType,
            MAIL_BUCKET,
            fileKey,
        );
        return { status: 200, message: "Upload URL generated", data: presigned };
    } catch (err) {
        console.error("createAttachmentUploadURL: presign failed: " + (err as Error).message);
        return { status: 500, message: "Failed to generate an upload URL", data: null };
    }
}

/**
 * Move a staged object into the retained prefix and write its attachment record.
 *
 * Called by the send path once a mail has actually been sent, which is what distinguishes a real
 * attachment from an abandoned upload. The move is what changes the object's retention from the
 * staging rule (1 day) to the attachment rule (21 days by default).
 */
export async function retainAttachment(
    stagingKey: string,
    ownerSub: string,
    mailRecordId: string,
    delivery: "inline" | "link",
): Promise<LKMailAttachment | null> {
    const head = await headS3Object(stagingKey, MAIL_BUCKET);
    if (!head) {
        console.warn(`retainAttachment: no object at "${stagingKey}"; skipping.`);
        return null;
    }

    const itemKey = randomUUID();
    const fileName = originalFileNameFromKey(stagingKey);
    const retainedKey = `${LK_MAIL_S3_PREFIX_ATTACHMENTS}/${ownerSub}/${itemKey}-${fileName}`;

    try {
        await moveS3Object(stagingKey, retainedKey, MAIL_BUCKET);
    } catch (err) {
        console.error(`retainAttachment: could not move "${stagingKey}": ${(err as Error).message}`);
        return null;
    }

    const createdOn = Date.now();
    const attachment: LKMailAttachment = {
        itemKey,
        itemName: fileName,
        itemContentType: head.ContentType ?? "application/octet-stream",
        itemS3Key: retainedKey,
        itemSize: head.ContentLength ?? 0,
        itemCreatedOn: createdOn,
        itemExpiresOn: createdOn + ATTACHMENT_RETENTION_MS,
        itemOwner: ownerSub,
        itemMailRecordId: mailRecordId,
        itemDelivery: delivery,
    };

    const put = await dynamoDBPut(putLKMailAttachmentOps(attachment));
    if (put.status !== 200) {
        console.error(`retainAttachment: could not record "${itemKey}": ${put.status} ${put.message}`);
        // The object is already retained. Returning null keeps it off the mail record, and the
        // lifecycle rule will reclaim it — better than a record pointing at an unrecorded object.
        return null;
    }
    return attachment;
}

/**
 * A short-lived download URL for one attachment.
 *
 * `requesterSub` is checked against the record's owner: the item key is a UUID, but an opaque id
 * is not an authorisation decision. Pass null to bypass the check only from trusted internal
 * callers, never from a request handler.
 */
export async function getAttachmentDownloadURL(
    itemKey: string,
    requesterSub: string | null,
): Promise<ResponseBody<string>> {
    if (!MAIL_BUCKET) {
        console.error("getAttachmentDownloadURL: LPX_MAIL_BUCKET_NAME is not configured.");
        return { status: 500, message: "Attachments are not available", data: "" };
    }
    const found = await dynamoDBGet(getLKMailAttachmentOps(itemKey));
    if (found.status !== 200) {
        return { status: 500, message: "An error occurred while looking up the attachment", data: "" };
    }
    const attachment = found.data;
    // A missing record, an expired one and someone else's are all reported identically: a
    // distinguishable "exists but not yours" would confirm the id to whoever is probing.
    if (!attachment
        || attachment.itemExpiresOn <= Date.now()
        || (requesterSub !== null && attachment.itemOwner !== requesterSub)) {
        return { status: 404, message: "No attachment with the requested key was found", data: "" };
    }

    try {
        const presigned = await generateS3PresignedGetURL(attachment.itemS3Key, MAIL_BUCKET, {
            fileName: attachment.itemName,
            contentType: attachment.itemContentType,
            disposition: "attachment",
        });
        return { status: 200, message: "Download URL generated", data: presigned.url };
    } catch (err) {
        console.error("getAttachmentDownloadURL: presign failed: " + (err as Error).message);
        return { status: 500, message: "An error occurred while generating a download URL", data: "" };
    }
}

/** One owner's attachments, newest first. */
export async function listAttachmentsForOwner(
    ownerSub: string,
    createdOnStart?: number,
    createdOnEnd?: number,
    limit = 50,
    paginationKey?: string,
): Promise<ResponseBody<LKMailAttachment[]>> {
    const res = await dynamoDBQuery(
        queryLKMailAttachmentsByOwnerOps(ownerSub, createdOnStart, createdOnEnd),
        limit,
        // Newest first: the GSI sort key is an ascending ISO timestamp, so the listing reads
        // backwards.
        false,
        paginationKey,
    );
    if (res.status !== 200) {
        return { status: res.status, message: "Failed to list the attachments", data: [] };
    }
    return {
        status: 200,
        message: "OK",
        data: res.data,
        size: res.data.length,
        ...(res.lastEvaluatedKey && { paginationKey: res.lastEvaluatedKey }),
    };
}

/**
 * Forget an attachment record.
 *
 * The S3 object is left to its lifecycle rule rather than deleted here: a delete that half-succeeds
 * is worse than one that is late, and the object is unreachable without its record anyway.
 */
export async function deleteAttachmentRecord(itemKey: string, requesterSub: string): Promise<ResponseBody<null>> {
    const found = await dynamoDBGet(getLKMailAttachmentOps(itemKey));
    if (found.status !== 200) {
        return { status: 500, message: "An error occurred while looking up the attachment", data: null };
    }
    if (!found.data || found.data.itemOwner !== requesterSub) {
        return { status: 404, message: "No attachment with the requested key was found", data: null };
    }
    const res = await dynamoDBDelete(deleteLKMailAttachmentOps(itemKey));
    if (res.status !== 200) {
        return { status: 500, message: "Failed to remove the attachment", data: null };
    }
    return { status: 200, message: "Attachment removed", data: null };
}
