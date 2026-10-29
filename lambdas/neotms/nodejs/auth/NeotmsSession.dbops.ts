// SPDX-License-Identifier: MIT
//
// A signed-in browser's session: what the backend holds so that the refresh token never reaches the
// browser (연동 안내서 §2, "왜 /token 은 백엔드에서 부르는가").
//
// The browser holds only a random session id, in an HttpOnly cookie. The record is keyed by the
// SHA-256 of that id rather than by the id itself, so a read of the table - a support query, a
// backup, an export - does not hand out working session cookies.
//
// This is the one part of NEOTMS that is not in Postgres. On the Aurora variant the reason was
// cost: a session read on every request would have held the cluster awake all day, at roughly
// $48/month in ACU floor to check cookies. Supabase bills a flat monthly compute price, so that
// argument is gone - but the decision stands on a different one, which is CONNECTIONS.
//
// A session read happens on every authenticated request, before any routing or authorization. Were
// it a Postgres read it would have to go through the Supavisor pooler, so the function would need a
// server connection for requests that are only checking a cookie - including the ones that then
// turn out to be 401s and touch no business data at all. With `reservedConcurrentExecutions: 20`
// and a pool `max` of 2 (see NeotmsApi.ts and PostgresUtils.ts) the whole function is budgeted at
// 40 client connections, and spending that budget on cookie checks is what would make a traffic
// spike present as connection exhaustion rather than as slowness. DynamoDB is a separate, unpooled
// quota, and on-demand pricing for this traffic is cents. See NeotmsStorage.ts.

import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { NeotmsEnv } from "../env/NeotmsEnv.js";
import {
  objToDynamoDBItem,
  type DeleteOps,
  type GetOps,
  type PutOps,
  type UpdateOps,
} from "../utils/DynamoDBUtils.js";

export type NeotmsSession = {
  sub: string;
  /** Rotated on every refresh; the one stored here is always the newest. */
  refreshToken: string;
  /** The newest access token, shared by every tab of this session. */
  accessToken: string;
  /** When accessToken expires, in milliseconds. */
  accessExpiresAt: number;
  created: number;
  /**
   * A refresh in progress holds this lease until the given time (ms).
   *
   * Refreshes must be serialised per session: every refresh rotates the refresh token, and
   * presenting a rotated-away token is treated by the account system as theft and ends the whole
   * session (§4.3). Two tabs - or two Lambda containers serving two tabs - will ask at once, so
   * without the lease the ordinary case of "the user has NEOTMS open twice" would log them out.
   */
  lockUntil: number;
};

const TABLE_NAME = NeotmsEnv.NEOTMS_SESSION_TABLE_NAME;

const sessionKey = (sessionHash: string) => ({
  NTPK: { S: `SESSION#${sessionHash}` },
  NTSK: { S: "SESSION" },
});

/**
 * A record missing any required attribute is treated as absent rather than repaired.
 *
 * A half-written session cannot be refreshed, and guessing at the missing half would mean rotating
 * a token we are not sure of. "Sign in again" is a worse experience and the only correct one.
 */
const itemToSession: (item: Record<string, AttributeValue> | undefined) => NeotmsSession | null = (
  item,
) => {
  if (!item) return null;
  if (item.sub?.S == null || item.refreshToken?.S == null || item.accessToken?.S == null) {
    return null;
  }
  if (item.accessExpiresAt?.N == null || item.created?.N == null) return null;
  return {
    sub: item.sub.S,
    refreshToken: item.refreshToken.S,
    accessToken: item.accessToken.S,
    accessExpiresAt: Number(item.accessExpiresAt.N),
    created: Number(item.created.N),
    lockUntil: Number(item.lockUntil?.N ?? "0"),
  };
};

/**
 * Store a new session.
 *
 * `NTTTL` is the table's TTL attribute, in seconds. TTL is the only thing that deletes a session
 * record - nothing sweeps the table - so the attribute name here and the one in NeotmsStorage must
 * agree. If they ever diverge, sessions accumulate forever and nothing visibly breaks; that is why
 * there is a test asserting the name.
 */
export const NeotmsSessionPutOps: (
  sessionHash: string,
  session: NeotmsSession,
  expiresAtMs: number,
) => PutOps = (sessionHash, session, expiresAtMs) => ({
  input: {
    TableName: TABLE_NAME,
    Item: {
      ...objToDynamoDBItem({ ...session }),
      ...sessionKey(sessionHash),
      NTTTL: { N: Math.ceil(expiresAtMs / 1000).toString() },
    },
  },
});

export const NeotmsSessionGetOps: (sessionHash: string) => GetOps<NeotmsSession | null> = (
  sessionHash,
) => ({
  input: {
    TableName: TABLE_NAME,
    Key: sessionKey(sessionHash),
    // A refresh decides whether to rotate from what it reads here; a stale read could rotate a
    // token another container has just rotated away, which the account system reads as theft.
    ConsistentRead: true,
  },
  mapper: itemToSession,
});

/**
 * Take the refresh lease. Fails (ConditionalCheckFailedException) while another refresh holds it,
 * or when the session no longer exists.
 *
 * `#lk < :now` is what makes the lease self-healing: a container that died mid-refresh leaves the
 * lease set, and after it expires the next caller takes it over rather than the session being stuck
 * until TTL.
 */
export const NeotmsSessionLockOps: (
  sessionHash: string,
  now: number,
  until: number,
) => UpdateOps = (sessionHash, now, until) => ({
  input: {
    TableName: TABLE_NAME,
    Key: sessionKey(sessionHash),
    UpdateExpression: "SET #lk = :until",
    ConditionExpression: "attribute_exists(NTSK) AND (attribute_not_exists(#lk) OR #lk < :now)",
    ExpressionAttributeNames: { "#lk": "lockUntil" },
    ExpressionAttributeValues: { ":until": { N: until.toString() }, ":now": { N: now.toString() } },
  },
});

/** Store a rotated token pair and release the lease, in one write. */
export const NeotmsSessionRotateOps: (
  sessionHash: string,
  refreshToken: string,
  accessToken: string,
  accessExpiresAt: number,
) => UpdateOps = (sessionHash, refreshToken, accessToken, accessExpiresAt) => ({
  input: {
    TableName: TABLE_NAME,
    Key: sessionKey(sessionHash),
    UpdateExpression: "SET #rt = :rt, #at = :at, #ae = :ae, #lk = :zero",
    ConditionExpression: "attribute_exists(NTSK)",
    ExpressionAttributeNames: {
      "#rt": "refreshToken",
      "#at": "accessToken",
      "#ae": "accessExpiresAt",
      "#lk": "lockUntil",
    },
    ExpressionAttributeValues: {
      ":rt": { S: refreshToken },
      ":at": { S: accessToken },
      ":ae": { N: accessExpiresAt.toString() },
      ":zero": { N: "0" },
    },
  },
});

/** Give the lease back without rotating (the refresh failed, or turned out to be unnecessary). */
export const NeotmsSessionUnlockOps: (sessionHash: string) => UpdateOps = (sessionHash) => ({
  input: {
    TableName: TABLE_NAME,
    Key: sessionKey(sessionHash),
    UpdateExpression: "SET #lk = :zero",
    ConditionExpression: "attribute_exists(NTSK)",
    ExpressionAttributeNames: { "#lk": "lockUntil" },
    ExpressionAttributeValues: { ":zero": { N: "0" } },
  },
});

export const NeotmsSessionDeleteOps: (sessionHash: string) => DeleteOps = (sessionHash) => ({
  input: {
    TableName: TABLE_NAME,
    Key: sessionKey(sessionHash),
  },
});
