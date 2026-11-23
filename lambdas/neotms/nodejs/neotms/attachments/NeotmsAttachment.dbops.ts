// SPDX-License-Identifier: MIT
//
// The attachment token table: what a link in an outgoing mail resolves to.
//
// ## Why this exists at all
//
// Hiworks' mail API has no attachment parameter, so files sent to a translator go to S3 and the
// mail carries links. The translator must be able to use those links for 21 days, and an S3
// presigned URL cannot do that: SigV4 caps a presigned URL at 7 days, and one signed with this
// function's own role credentials stops working when those temporary credentials expire - hours,
// not weeks. There is no option that makes a 21-day S3 signature.
//
// So the link points HERE. A row in this table maps an unguessable token to an object key, and the
// download endpoint turns that into a short-lived presigned URL at the moment somebody clicks.
// The link lives exactly as long as the row, which is what makes 21 days expressible - and what
// makes a mistaken send revocable, because deleting the row kills the link. A CloudFront signed
// URL, the other way to get a long-lived link, cannot be withdrawn before it expires.
//
// ## Why DynamoDB and not Postgres
//
// The same argument `NeotmsSession.dbops.ts` makes, and more sharply. A download is served to
// somebody outside the company clicking a link in a mail - traffic this system does not control and
// cannot predict. Spending a pooled Postgres connection on it would put that traffic in competition
// with the staff using the application, and the whole function is budgeted at 40 client connections.
// DynamoDB is a separate, unpooled quota.
//
// It is also the only store here with a TTL, and TTL is how the 21 days are enforced rather than
// checked. The application checks the expiry as well - DynamoDB deletes within ~48h of the
// timestamp, not at it - so a row that has outlived its welcome is refused before it is swept.

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { NeotmsEnv } from "../../env/NeotmsEnv.js";
import {
  objToDynamoDBItem,
  type DeleteOps,
  type GetOps,
  type PutOps,
} from "../../utils/DynamoDBUtils.js";

/** How long a link in a sent mail keeps working. */
export const ATTACHMENT_TTL_DAYS = 21;

export type AttachmentRecord = {
  /** The S3 object key. Never leaves the server - the translator only ever sees the token. */
  objectKey: string;
  /** What the uploader called it. The link text in the mail, and the download's filename. */
  fileName: string;
  /** Sent back on the download so the browser does the right thing with it. */
  contentType: string;
  /** Who uploaded it (`staff.mgr_id`), for answering "where did this link come from" later. */
  createdBy: string;
  /** The PO this file was attached to, for the same reason. */
  poId: string;
  /** Milliseconds. Checked by the application; `NTTTL` is what actually deletes the row. */
  expiresAt: number;
};

const TABLE_NAME = NeotmsEnv.NEOTMS_ATTACHMENT_TABLE_NAME;

/*
 * Keyed by the token itself rather than by a hash of it, which is the opposite of what
 * `NeotmsSession.dbops.ts` does with session ids - so the difference is worth stating.
 *
 * A session id is a credential that identifies a PERSON: anyone holding it can act as them, so the
 * table stores only a hash and a leaked backup hands out nothing. A token here authorises reading
 * ONE file that was deliberately mailed to somebody outside the company, and the token is in that
 * mail in plain text already. Hashing it would protect a secret that has been posted to its
 * intended reader, at the cost of making "which file does this link in my sent mail point at"
 * unanswerable by support.
 *
 * What does matter is that the token is unguessable, which is the generator's job, and that the row
 * expires.
 */
const key = (token: string): Record<string, AttributeValue> => ({
  NTPK: { S: `ATTACHMENT#${token}` },
  NTSK: { S: "META" },
});

/**
 * Record one uploaded file against a token.
 *
 * `NTTTL` is seconds, not milliseconds - DynamoDB reads the attribute as a Unix timestamp in
 * seconds and silently never expires a row whose value is a thousand times too large. That failure
 * is invisible: the row simply stays forever, and nothing in the application notices because the
 * application checks `expiresAt` itself.
 */
export const AttachmentPutOps = (token: string, record: AttachmentRecord): PutOps => ({
  input: {
    TableName: TABLE_NAME,
    Item: {
      ...key(token),
      ...objToDynamoDBItem({ ...record }),
      NTTTL: { N: String(Math.floor(record.expiresAt / 1000)) },
    },
  },
});

export const AttachmentGetOps = (token: string): GetOps<AttachmentRecord | null> => ({
  input: { TableName: TABLE_NAME, Key: key(token), ConsistentRead: false },
  mapper: (item) => {
    if (!item) return null;
    const read = (name: string): string => item[name]?.S ?? "";
    const expiresAt = Number(item["expiresAt"]?.N ?? item["expiresAt"]?.S ?? 0);
    return {
      objectKey: read("objectKey"),
      fileName: read("fileName"),
      contentType: read("contentType"),
      createdBy: read("createdBy"),
      poId: read("poId"),
      expiresAt,
    };
  },
});

/**
 * Withdraw a link.
 *
 * Nothing calls this, and that is now a DECISION rather than a gap: asked for an endpoint, the
 * answer was that expiry is enough for the moment (2026-11-20). It is kept because it is the
 * property that chose this design over CloudFront signed URLs - a file mailed to the wrong
 * translator can be cut off - and because wiring it up later is a route and a permission, not a
 * redesign.
 *
 * Until then nothing has to be swept by hand: `NTTTL` deletes the row at 21 days and the bucket's
 * lifecycle rule deletes the object at 22, so an abandoned upload disappears on its own.
 */
export const AttachmentDeleteOps = (token: string): DeleteOps => ({
  input: { TableName: TABLE_NAME, Key: key(token) },
});
