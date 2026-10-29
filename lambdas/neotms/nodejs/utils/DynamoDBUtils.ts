// SPDX-License-Identifier: MIT
//
// DynamoDB access, in the same Ops-descriptor shape as the rest of the codebase: a `*.dbops` module
// builds a pure `{ input, mapper }` value, and the functions here are the only thing that talks to
// AWS. A dbops module is then testable without a client, and a mapper cannot quietly acquire a
// network call.
//
// NEOTMS uses DynamoDB for exactly one thing: session records. Everything with a foreign key lives
// in Postgres (see PostgresUtils). Sessions are the exception on purpose: a session read happens on
// every authenticated request, so serving it from Postgres would take a Supavisor server connection
// out of the function's small budget just to check a cookie - including on requests that end in a
// 401 and never read business data. On-demand DynamoDB is a separate quota and costs cents at this
// traffic. The reasoning is spelled out in NeotmsSession.dbops.ts.
//
// This file is deliberately narrower than the LPX original: no Query, no BatchGet, no sharding, and
// an item converter that handles only strings, numbers, booleans and null. Sessions need nothing
// else, and an unused code path in a security-relevant file is a liability rather than an asset.

import {
  DeleteItemCommand,
  type DeleteItemCommandInput,
  DynamoDBClient,
  GetItemCommand,
  type GetItemCommandInput,
  PutItemCommand,
  type PutItemCommandInput,
  UpdateItemCommand,
  type UpdateItemCommandInput,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

let dynamoDBClient: DynamoDBClient | null = null;

export function getClient(): DynamoDBClient {
  if (dynamoDBClient) return dynamoDBClient;
  dynamoDBClient = new DynamoDBClient({ maxAttempts: 10 });
  return dynamoDBClient;
}

/** Test-only: drop the cached client. */
export function _resetClient(): void {
  dynamoDBClient = null;
}

/* -------------------------------------------------------------------------- */
/* Item conversion                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Convert a flat record into DynamoDB attribute values.
 *
 * Flat on purpose - no lists, no maps, no sets. A session record is a handful of strings and
 * timestamps; nesting would only invite someone to store something in it that belongs in the
 * cluster.
 *
 * `undefined` is dropped rather than written as NULL. The conditional-update expressions in
 * NeotmsSession.dbops distinguish "absent" from "null" (`attribute_not_exists(#lk)`), so writing a
 * NULL where the caller meant "do not set this" would quietly satisfy a condition meant to fail.
 */
export function objToDynamoDBItem(input: Record<string, unknown>): Record<string, AttributeValue> {
  const out: Record<string, AttributeValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (value === null) {
      out[key] = { NULL: true };
    } else if (typeof value === "string") {
      out[key] = { S: value };
    } else if (typeof value === "number" || typeof value === "bigint") {
      out[key] = { N: value.toString() };
    } else if (typeof value === "boolean") {
      out[key] = { BOOL: value };
    } else {
      throw new Error(`objToDynamoDBItem received an unsupported value for "${key}"`);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Descriptors                                                               */
/* -------------------------------------------------------------------------- */

export interface DynamoDBResponse<T> {
  data: T;
  message: string;
  status: number;
}

export interface GetOps<T> {
  input: GetItemCommandInput;
  mapper: (item: Record<string, AttributeValue> | undefined) => T;
}

export type PutOps = { input: PutItemCommandInput };
export type UpdateOps = { input: UpdateItemCommandInput };
export type DeleteOps = { input: DeleteItemCommandInput };

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A failed condition is a 409, not a 500.
 *
 * It means the record was not in the state the caller assumed - someone else holds the refresh
 * lease, or the session has already ended. That is an expected outcome of a correct optimistic
 * write, and the caller is supposed to handle it rather than treat it as a fault.
 */
export const DDB_CONDITION_FAILED_STATUS = 409;

export function isConditionalCheckFailure(err: unknown): boolean {
  return err instanceof Error && err.name === "ConditionalCheckFailedException";
}

/* -------------------------------------------------------------------------- */
/* Executors                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * More than a handful of retries on a table this small means something structural - a throttle on a
 * hot partition, or a client misconfiguration. Worth a log line, because the request still succeeds
 * and so nothing else would ever mention it.
 */
function warnOnExcessiveAttempts(attempts: number | undefined, label: string): void {
  if (attempts === undefined) {
    console.error(`The number of retry attempts is undefined for the DynamoDB ${label} request.`);
  } else if (attempts > 5) {
    console.warn(
      `More than 5 attempts (${attempts}) were made in this DynamoDB ${label} request. Please check the table for throttling.`,
    );
  }
}

export async function dynamoDBGet<T>(ops: GetOps<T>): Promise<DynamoDBResponse<T>> {
  const out = await getClient().send(new GetItemCommand(ops.input));
  warnOnExcessiveAttempts(out.$metadata.attempts, "get");
  return {
    data: ops.mapper(out.Item),
    status: out.$metadata.httpStatusCode ?? 500,
    message:
      out.$metadata.httpStatusCode === 200
        ? "Get request successful"
        : "An error occurred while processing the get request",
  };
}

export async function dynamoDBPut(ops: PutOps): Promise<DynamoDBResponse<string>> {
  const res = await getClient().send(new PutItemCommand(ops.input));
  warnOnExcessiveAttempts(res.$metadata.attempts, "put");
  return {
    status: res.$metadata.httpStatusCode ?? 500,
    message:
      res.$metadata.httpStatusCode === 200
        ? "Put request successful"
        : "An error occurred while processing the put request",
    data: res.$metadata.requestId ?? "Unknown Request ID",
  };
}

export async function dynamoDBUpdate(ops: UpdateOps): Promise<DynamoDBResponse<string>> {
  const res = await getClient().send(new UpdateItemCommand(ops.input));
  warnOnExcessiveAttempts(res.$metadata.attempts, "update");
  return {
    status: res.$metadata.httpStatusCode ?? 500,
    message:
      res.$metadata.httpStatusCode === 200
        ? "Update request successful"
        : "An error occurred while processing the update request",
    data: res.$metadata.requestId ?? "Unknown Request ID",
  };
}

export async function dynamoDBDelete(ops: DeleteOps): Promise<DynamoDBResponse<string>> {
  const res = await getClient().send(new DeleteItemCommand(ops.input));
  warnOnExcessiveAttempts(res.$metadata.attempts, "delete");
  return {
    status: res.$metadata.httpStatusCode ?? 500,
    message:
      res.$metadata.httpStatusCode === 200
        ? "Delete request successful"
        : "An error occurred while processing the delete request",
    data: res.$metadata.requestId ?? "Unknown Request ID",
  };
}
