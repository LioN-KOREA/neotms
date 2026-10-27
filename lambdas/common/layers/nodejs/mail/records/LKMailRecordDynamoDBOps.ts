// SPDX-License-Identifier: MIT
//
// Pure DynamoDB operation builders for mail records. No I/O.
//
// Keys follow the LKAuthData single-table convention:
//   PK   lkAuthDataKey        = "LKMAILRECORD#<mailRecordId>"
//   SK   lkAuthDataIdentifier = "METADATA"
//   GSI1 lkAuthDataKey2        = "LKMAILRECORD#OWNER#<senderSub>"
//   GSI1 lkAuthDataIdentifier2 = "SENTMS#<ISO8601>"
//
// Records carry NO TTL attribute: a user is meant to be able to look back over what the system
// sent them and on their behalf indefinitely. The attachments they reference do expire, which is
// why an attachment record keeps its own itemExpiresOn.
//
// ⚠️ Scaling note: every system-sent mail shares one GSI partition (OWNER#SYSTEM), and a DynamoDB
// partition tops out near 1,000 writes/sec. That is far above any plausible notification volume
// here, but if system mail ever became high-rate, this partition is what would throttle first —
// the fix is to shard the SYSTEM owner across N partitions and fan the query out with
// dynamoDBQuerySharded, exactly as LKAccountsDynamoDBOps does for account listings.

import { AttributeValue } from "@aws-sdk/client-dynamodb";
import { LpxEnv } from "../../configs/LpxEnv.js";
import {
    type GetOps,
    objToDynamoDBItem,
    type PutOps,
    type QueryOps,
} from "../../utils/DynamoDBUtils.js";
import { LKMailRecord, LKMailRecordSchema } from "./LKMailRecordObjects.js";
import * as v from "valibot";

const LPX_TABLE = LpxEnv.LPX_TABLE_NAME;
const LPX_TABLE_GSI1 = LpxEnv.LPX_TABLE_GSI1_NAME;

const PK = (mailRecordId: string) => `LKMAILRECORD#${mailRecordId}`;
const SK = "METADATA";
const GSI1_PK = (senderSub: string) => `LKMAILRECORD#OWNER#${senderSub}`;
const GSI1_SK = (sentOn: number | Date) =>
    `SENTMS#${(sentOn instanceof Date ? sentOn : new Date(sentOn)).toISOString()}`;

// -------- Mapper ----------------------------------------------------------

export function itemToLKMailRecord(item: Record<string, AttributeValue> | undefined): LKMailRecord | null {
    if (!item) return null;
    const partitionKey = item["lkAuthDataKey"]?.S;
    if (!partitionKey || !partitionKey.startsWith("LKMAILRECORD#")) {
        console.error("The specified LKMailRecord item is invalid: unexpected partition key");
        return null;
    }
    const stringList = (attr: AttributeValue | undefined): string[] =>
        (attr?.L ?? []).map((entry) => entry.S).filter((s): s is string => typeof s === "string");

    const parsed = v.safeParse(LKMailRecordSchema, {
        mailRecordId: partitionKey.substring("LKMAILRECORD#".length),
        mailSubject: item["mailSubject"]?.S,
        mailSenderSub: item["mailSenderSub"]?.S,
        mailSenderEmail: item["mailSenderEmail"]?.S,
        mailRecipients: stringList(item["mailRecipients"]),
        mailCc: stringList(item["mailCc"]),
        mailBcc: stringList(item["mailBcc"]),
        mailAttachments: stringList(item["mailAttachments"]),
        mailContentKey: item["mailContentKey"]?.S ?? "",
        mailgunId: item["mailgunId"]?.S ?? "",
        mailStatus: item["mailStatus"]?.S,
        mailFailureReason: item["mailFailureReason"]?.S ?? "",
        mailSentOn: Number(item["mailSentOn"]?.N ?? "0"),
    });
    if (parsed.success) return parsed.output;
    console.error("An error occurred while parsing an LKMailRecord item: " + JSON.stringify(parsed.issues));
    return null;
}

// -------- Writes ----------------------------------------------------------

export const putLKMailRecordOps = (item: LKMailRecord): PutOps => ({
    input: {
        TableName: LPX_TABLE,
        Item: objToDynamoDBItem({
            lkAuthDataKey: PK(item.mailRecordId),
            lkAuthDataIdentifier: SK,
            lkAuthDataKey2: GSI1_PK(item.mailSenderSub),
            lkAuthDataIdentifier2: GSI1_SK(item.mailSentOn),
            mailSubject: item.mailSubject,
            mailSenderSub: item.mailSenderSub,
            mailSenderEmail: item.mailSenderEmail,
            mailRecipients: item.mailRecipients,
            mailCc: item.mailCc,
            mailBcc: item.mailBcc,
            mailAttachments: item.mailAttachments,
            mailContentKey: item.mailContentKey,
            mailgunId: item.mailgunId,
            mailStatus: item.mailStatus,
            mailFailureReason: item.mailFailureReason,
            mailSentOn: item.mailSentOn,
        }),
    },
});

// -------- Reads -----------------------------------------------------------

export const getLKMailRecordOps = (mailRecordId: string): GetOps<LKMailRecord | null> => ({
    input: {
        TableName: LPX_TABLE,
        Key: {
            lkAuthDataKey: { S: PK(mailRecordId) },
            lkAuthDataIdentifier: { S: SK },
        },
    },
    mapper: itemToLKMailRecord,
});

/** Every mail sent by one owner, optionally within a date range. One-sided ranges are honoured. */
export const queryLKMailRecordsByOwnerOps = (
    senderSub: string,
    sentOnStart?: number,
    sentOnEnd?: number,
): QueryOps<LKMailRecord[]> => {
    const hasStart = sentOnStart != null;
    const hasEnd = sentOnEnd != null;
    const rangeExpr = hasStart && hasEnd ? " AND #sk BETWEEN :skS AND :skE"
        : hasStart ? " AND #sk >= :skS"
            : hasEnd ? " AND #sk <= :skE"
                : "";
    return {
        input: {
            TableName: LPX_TABLE,
            IndexName: LPX_TABLE_GSI1,
            KeyConditionExpression: "#pk = :pk" + rangeExpr,
            ExpressionAttributeNames: {
                "#pk": "lkAuthDataKey2",
                ...((hasStart || hasEnd) && { "#sk": "lkAuthDataIdentifier2" }),
            },
            ExpressionAttributeValues: {
                ":pk": { S: GSI1_PK(senderSub) },
                ...(hasStart && { ":skS": { S: GSI1_SK(sentOnStart) } }),
                ...(hasEnd && { ":skE": { S: GSI1_SK(sentOnEnd) } }),
            },
        },
        mapper: (items) => (items ?? []).map(itemToLKMailRecord).filter((i): i is LKMailRecord => !!i),
    };
};
