// SPDX-License-Identifier: MIT
//
// Pure DynamoDB operation builders for mail attachments. No I/O.
//
// Keys follow the LKAuthData single-table convention:
//   PK   lkAuthDataKey        = "LKMAILATTACHMENT#<itemKey>"
//   SK   lkAuthDataIdentifier = "METADATA"
//   GSI1 lkAuthDataKey2        = "LKMAILATTACHMENT#OWNER#<ownerSub>"
//   GSI1 lkAuthDataIdentifier2 = "CREATEDMS#<ISO8601>"
//
// The GSI sort key is an ISO string rather than the raw epoch number because DynamoDB sorts
// strings lexicographically: a fixed-width ISO timestamp sorts chronologically, while
// "9" > "10" would not. This matches LKAccountsDynamoDBOps' REGTIMEMS# convention.

import { AttributeValue } from "@aws-sdk/client-dynamodb";
import { LpxEnv } from "../../configs/LpxEnv.js";
import {
    type DeleteOps,
    type GetOps,
    objToDynamoDBItem,
    type PutOps,
    type QueryOps,
} from "../../utils/DynamoDBUtils.js";
import { LKMailAttachment, LKMailAttachmentSchema } from "./LKMailAttachmentObjects.js";
import * as v from "valibot";

const LPX_TABLE = LpxEnv.LPX_TABLE_NAME;
const LPX_TABLE_GSI1 = LpxEnv.LPX_TABLE_GSI1_NAME;

const PK = (itemKey: string) => `LKMAILATTACHMENT#${itemKey}`;
const SK = "METADATA";
const GSI1_PK = (ownerSub: string) => `LKMAILATTACHMENT#OWNER#${ownerSub}`;
const GSI1_SK = (createdOn: number | Date) =>
    `CREATEDMS#${(createdOn instanceof Date ? createdOn : new Date(createdOn)).toISOString()}`;

// -------- Mapper ----------------------------------------------------------

export function itemToLKMailAttachment(item: Record<string, AttributeValue> | undefined): LKMailAttachment | null {
    if (!item) return null;
    const partitionKey = item["lkAuthDataKey"]?.S;
    if (!partitionKey || !partitionKey.startsWith("LKMAILATTACHMENT#")) {
        console.error("The specified LKMailAttachment item is invalid: unexpected partition key");
        return null;
    }
    const parsed = v.safeParse(LKMailAttachmentSchema, {
        // The item key lives in the partition key, so it is never stored twice.
        itemKey: partitionKey.substring("LKMAILATTACHMENT#".length),
        itemName: item["itemName"]?.S,
        itemContentType: item["itemContentType"]?.S,
        itemS3Key: item["itemS3Key"]?.S,
        itemSize: Number(item["itemSize"]?.N ?? "0"),
        itemCreatedOn: Number(item["itemCreatedOn"]?.N ?? "0"),
        itemExpiresOn: Number(item["itemExpiresOn"]?.N ?? "0"),
        itemOwner: item["itemOwner"]?.S,
        itemMailRecordId: item["itemMailRecordId"]?.S ?? "",
        itemDelivery: item["itemDelivery"]?.S,
    });
    if (parsed.success) return parsed.output;
    console.error("An error occurred while parsing an LKMailAttachment item: " + JSON.stringify(parsed.issues));
    return null;
}

// -------- Writes ----------------------------------------------------------

export const putLKMailAttachmentOps = (item: LKMailAttachment): PutOps => ({
    input: {
        TableName: LPX_TABLE,
        Item: {
            ...objToDynamoDBItem({
                lkAuthDataKey: PK(item.itemKey),
                lkAuthDataIdentifier: SK,
                lkAuthDataKey2: GSI1_PK(item.itemOwner),
                lkAuthDataIdentifier2: GSI1_SK(item.itemCreatedOn),
                itemName: item.itemName,
                itemContentType: item.itemContentType,
                itemS3Key: item.itemS3Key,
                itemSize: item.itemSize,
                itemCreatedOn: item.itemCreatedOn,
                itemExpiresOn: item.itemExpiresOn,
                itemOwner: item.itemOwner,
                itemMailRecordId: item.itemMailRecordId,
                itemDelivery: item.itemDelivery,
            }),
            // The TTL attribute is SECONDS — the only place a seconds value is allowed. Everything
            // the application reads stays in milliseconds, which is why itemExpiresOn is stored
            // separately rather than reusing this one.
            ...objToDynamoDBItem({ lkAuthDataTtl: Math.floor(item.itemExpiresOn / 1000) }),
        },
        // A new item key is a fresh UUID, so a collision means a bug, not a retry.
        ConditionExpression: "attribute_not_exists(lkAuthDataKey) AND attribute_not_exists(lkAuthDataIdentifier)",
    },
});

export const deleteLKMailAttachmentOps = (itemKey: string): DeleteOps => ({
    input: {
        TableName: LPX_TABLE,
        Key: {
            lkAuthDataKey: { S: PK(itemKey) },
            lkAuthDataIdentifier: { S: SK },
        },
    },
});

// -------- Reads -----------------------------------------------------------

export const getLKMailAttachmentOps = (itemKey: string): GetOps<LKMailAttachment | null> => ({
    input: {
        TableName: LPX_TABLE,
        Key: {
            lkAuthDataKey: { S: PK(itemKey) },
            lkAuthDataIdentifier: { S: SK },
        },
    },
    mapper: itemToLKMailAttachment,
});

/**
 * Every attachment belonging to one owner, newest first, optionally within a date range.
 *
 * A one-sided range is honoured: the caller may give a start, an end, both or neither. Requiring
 * both (as the imported code did) silently ignores "everything since last Monday".
 */
export const queryLKMailAttachmentsByOwnerOps = (
    ownerSub: string,
    createdOnStart?: number,
    createdOnEnd?: number,
): QueryOps<LKMailAttachment[]> => {
    const hasStart = createdOnStart != null;
    const hasEnd = createdOnEnd != null;
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
                ":pk": { S: GSI1_PK(ownerSub) },
                ...(hasStart && { ":skS": { S: GSI1_SK(createdOnStart) } }),
                ...(hasEnd && { ":skE": { S: GSI1_SK(createdOnEnd) } }),
            },
        },
        mapper: (items) => (items ?? []).map(itemToLKMailAttachment).filter((i): i is LKMailAttachment => !!i),
    };
};
