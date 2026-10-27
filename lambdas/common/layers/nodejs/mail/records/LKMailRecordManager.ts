// SPDX-License-Identifier: MIT
//
// Reading back what was sent.

import type { ResponseBody } from "../../interfaces/RequestResponse.js";
import { dynamoDBGet, dynamoDBQuery } from "../../utils/DynamoDBUtils.js";
import { getS3TextObject } from "../../utils/S3Utils.js";
import { LpxEnv } from "../../configs/LpxEnv.js";
import { getLKMailRecordOps, queryLKMailRecordsByOwnerOps } from "./LKMailRecordDynamoDBOps.js";
import type { LKMailRecord } from "./LKMailRecordObjects.js";

const MAIL_BUCKET = LpxEnv.LPX_MAIL_BUCKET_NAME;

/** One owner's sent mail, newest first. */
export async function listMailRecordsForOwner(
    senderSub: string,
    sentOnStart?: number,
    sentOnEnd?: number,
    limit = 50,
    paginationKey?: string,
): Promise<ResponseBody<LKMailRecord[]>> {
    const res = await dynamoDBQuery(
        queryLKMailRecordsByOwnerOps(senderSub, sentOnStart, sentOnEnd),
        limit,
        // Newest first — the GSI sort key ascends by send time.
        false,
        paginationKey,
    );
    if (res.status !== 200) {
        return { status: res.status, message: "Failed to list the mail records", data: [] };
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
 * One mail record.
 *
 * `requesterSub` is checked against the record's sender. Pass null only from trusted internal
 * callers — a record id is a UUID, but an unguessable id is not an access control.
 */
export async function getMailRecord(
    mailRecordId: string,
    requesterSub: string | null,
): Promise<ResponseBody<LKMailRecord | null>> {
    const found = await dynamoDBGet(getLKMailRecordOps(mailRecordId));
    if (found.status !== 200) {
        return { status: 500, message: "An error occurred while looking up the mail record", data: null };
    }
    if (!found.data || (requesterSub !== null && found.data.mailSenderSub !== requesterSub)) {
        return { status: 404, message: "No mail record with the requested id was found", data: null };
    }
    return { status: 200, message: "OK", data: found.data };
}

/**
 * The rendered body of one mail, as stored at send time.
 *
 * Returned as a string rather than a presigned URL: the body is HTML written by this system, and
 * handing out a URL to a bucket object invites rendering it as a page on our own origin.
 */
export async function getMailRecordBody(
    mailRecordId: string,
    requesterSub: string | null,
): Promise<ResponseBody<string>> {
    const record = await getMailRecord(mailRecordId, requesterSub);
    if (record.status !== 200 || !record.data) {
        return { status: record.status, message: record.message, data: "" };
    }
    if (!record.data.mailContentKey || !MAIL_BUCKET) {
        return { status: 404, message: "This mail has no archived body", data: "" };
    }
    try {
        const body = await getS3TextObject(record.data.mailContentKey, MAIL_BUCKET);
        if (!body) {
            return { status: 404, message: "This mail's archived body is no longer available", data: "" };
        }
        return { status: 200, message: "OK", data: body };
    } catch (err) {
        console.error("getMailRecordBody: could not read the archived body: " + (err as Error).message);
        return { status: 500, message: "An error occurred while reading the mail body", data: "" };
    }
}
