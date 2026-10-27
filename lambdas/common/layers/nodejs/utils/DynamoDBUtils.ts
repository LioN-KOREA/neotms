import { type AttributeValue, BatchGetItemCommand, type BatchGetItemCommandInput, type BatchGetItemCommandOutput, BatchWriteItemCommand, type BatchWriteItemCommandInput, DeleteItemCommand, type DeleteItemCommandInput, DynamoDBClient, DynamoDBServiceException, GetItemCommand, type GetItemCommandInput, type GetItemCommandOutput, type KeysAndAttributes, PutItemCommand, type PutItemCommandInput, QueryCommand, type QueryCommandInput, TransactWriteItemsCommand, type TransactWriteItemsCommandInput, UpdateItemCommand, type UpdateItemCommandInput } from "@aws-sdk/client-dynamodb";

/**
 * DynamoDB exception name → the status this codebase should report.
 *
 * These are OUR API's semantics, not AWS's, and the question each entry answers is "can the caller
 * do anything about it?" rather than "what did AWS call it". AWS marks most of these `$fault:
 * "client"` because WE are the client of DynamoDB — that says nothing about whether the person
 * calling our API is at fault, which is why `$fault` is only a last-resort fallback below.
 *
 * Anything absent falls through to the fallback chain in exceptionToErrorResponse.
 */
const DYNAMODB_EXCEPTION_TO_ERROR_CODE: Record<string, number> = {
  // The condition did not hold. Not a failure — a control: single-use codes and refresh tokens
  // depend on exactly this. 409 so callers can tell it from both a bad request and an outage.
  ConditionalCheckFailedException: 409,
  // A write inside a transaction lost. Also a conflict rather than a fault.
  TransactionConflictException: 409,
  ReplicatedWriteConflictException: 409,

  // Out of capacity. The SDK has already retried (maxAttempts: 10), so reaching here means it kept
  // failing — 429 tells the caller to back off rather than implying their request was wrong.
  ProvisionedThroughputExceededException: 429,
  ThrottlingException: 429,
  RequestLimitExceeded: 429,
  LimitExceededException: 429,

  // OUR bugs and OUR misconfiguration, deliberately 500.
  //
  // Reporting any of these as 4xx would blame the API caller for something they cannot influence:
  // a malformed expression, a table name that does not exist, or an IAM policy we failed to grant.
  // Every caller validates its input with valibot before reaching DynamoDB, so a ValidationException
  // here means the item or the expression this codebase built is wrong.
  ValidationException: 500,
  ResourceNotFoundException: 500,
  AccessDeniedException: 500,
  ResourceInUseException: 500,
  // An LSI partition has exceeded its 10GB ceiling. Nothing the caller can do, and it needs a
  // schema change rather than a retry.
  ItemCollectionSizeLimitExceededException: 500,

  // Theirs.
  InternalServerError: 503,
  ServiceUnavailable: 503,
  // Network-level failures the SDK surfaces by these names. Not service exceptions, so they have
  // no $fault and would otherwise fall all the way through.
  TimeoutError: 503,
  NetworkingError: 503,
  RequestTimeout: 503,
  RequestTimeoutException: 503,
};

/** Status for a write whose ConditionExpression did not hold. See the map entry above. */
export const DDB_CONDITION_FAILED_STATUS = 409;

/**
 * Did this error come from a ConditionExpression that did not hold?
 *
 * Matched on `name`, deliberately NOT with `instanceof`: a Lambda bundle can end up with two copies
 * of the AWS SDK (one bundled, one from a layer), and across copies `instanceof` is silently always
 * false. This is the same hazard that made Cognito error handling unreliable — see CognitoErrors.
 *
 * Two shapes have to be recognised. A plain conditional write throws
 * `ConditionalCheckFailedException`. A condition inside a TransactWriteItems throws
 * `TransactionCanceledException` instead, with the real reason buried in `CancellationReasons` —
 * so a transaction whose condition failed looks nothing like the single-item case.
 */
export function isConditionalCheckFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; CancellationReasons?: unknown };
  if (e.name === "ConditionalCheckFailedException") return true;
  if (e.name === "TransactionCanceledException" && Array.isArray(e.CancellationReasons)) {
    return e.CancellationReasons.some(
      (reason) => reason && typeof reason === "object"
        && (reason as { Code?: unknown }).Code === "ConditionalCheckFailed");
  }
  return false;
}

/**
 * Turn any thrown value into a classified response.
 *
 * The fallback chain is explicit because the original one-liner had a precedence bug worth not
 * repeating: `a ?? b ?? c === "client" ? 400 : 500` parses as `(a ?? b ?? (c === "client")) ? 400 :
 * 500`, because `===` binds tighter than `??` and `??` tighter than `?:`. That returned 400 for
 * every real exception — never the mapped status, never 500.
 */
export type DynamoDBExceptionDetail = { status : number, name : string, message : string }
export function exceptionToErrorResponse(err: unknown): DynamoDBExceptionDetail {
  // `name` must be a STRING, not merely present. Something that is thrown with a non-string name
  // would otherwise reach the fallbacks below and come back with a non-string `message`, and a
  // caller doing `res.message.length` would then throw inside its own error handling — turning a
  // handled failure back into a crash, which is the exact thing this module exists to prevent.
  if (!err || typeof err !== "object" || typeof (err as { name?: unknown }).name !== "string") {
    return { status : 500, name : "UnknownError", message: "An unknown exception occurred" };
  }
  // A condition inside a transaction has to be recognized before the name is looked up, because
  // its name is TransactionCanceledException and the real reason is nested.
  if (isConditionalCheckFailure(err)) {
    return {
      status: DDB_CONDITION_FAILED_STATUS,
      name: "ConditionalCheckFailedException",
      message: "The request's condition was not met",
    };
  }
  const ex = err as { name: string; message?: string; $fault?: string; $response?: { statusCode?: number } };
  const mapped = DYNAMODB_EXCEPTION_TO_ERROR_CODE[ex.name];
  // In order: our own mapping, then the HTTP status AWS returned, then $fault as a coarse guess.
  const status = mapped
    ?? ex.$response?.statusCode
    ?? (ex.$fault === "client" ? 400 : 500);
  return {
    status,
    name: ex.name,
    message: typeof ex.message === "string" && ex.message ? ex.message : ex.name,
  };
}

// A singleton client for all
let dynamoDBClient: DynamoDBClient | null = null;

export function getClient(): DynamoDBClient {
  if (dynamoDBClient) {
    return dynamoDBClient;
  }
  dynamoDBClient = new DynamoDBClient({
    maxAttempts: 10,

  });
  return dynamoDBClient;
}

export function objToDynamoDBItem(input: Record<string, unknown>, handleNullish: "null" | "stringify" | "throw" | "ignore" = "null") {
  const valueToAttributeValue
    : (input: unknown, handleNullish: "null" | "stringify" | "throw" | "ignore")
      => (AttributeValue | null) =
    (input, handleNullish) => {
      if (input != null) {
        if (Array.isArray(input)) {
          const convertedListAttrs: Array<AttributeValue | null> = input.map(x => valueToAttributeValue(x, handleNullish));
          let normalizedListAttrs: Array<AttributeValue> | null = null;
          if (handleNullish === "null") {
            normalizedListAttrs = convertedListAttrs.map(x => x != null ? x : { NULL: true })
          } else if (handleNullish === "ignore") {
            normalizedListAttrs = convertedListAttrs.filter(x => !!x);
          } else if (handleNullish === "stringify") {
            normalizedListAttrs = convertedListAttrs.map(x => x != null ? x : { S: "null" });
          } else if (handleNullish === "throw") {
            if (convertedListAttrs.every(x => x != null)) {
              normalizedListAttrs = convertedListAttrs;
            }
          }
          if (normalizedListAttrs == null) {
            throw new Error("An array contained a null value!")
          }
          return { L: normalizedListAttrs };
        } else if (input instanceof Set) {
          const setToArray = Array.from(input);
          if (setToArray.length > 0) {
            if (typeof setToArray[0] === "number" || typeof setToArray[0] === "bigint") {
              return { NS: setToArray.map(x => x.toString()) };
            } else if (setToArray[0] instanceof Uint8Array) {
              return { BS: setToArray.filter(bs => (bs instanceof Uint8Array)) };
            } else {
              return { SS: setToArray.map(x => x.toString()) };
            }
          } else {
            return { L: [] };
          }
        } else if (input instanceof Uint8Array) {
          return { B: input };
        }
        switch (typeof input) {
          case "string":
            return { S: input };
          case "number":
          case "bigint":
            return { N: input.toString() };
          case "boolean":
            return { BOOL: input };
          case "symbol":
            return { S: input.toString() }
          case "function":
            return { S: `FUNCTION: ${input.name}` }
          case "object":
            const inputRecord = input as Record<string, unknown>
            const reducedAttrValues = Object.keys(inputRecord).reduce((pv, cv) => {
              let currentValue = valueToAttributeValue(inputRecord[cv], handleNullish);
              if (currentValue == null) {
                if (handleNullish === "ignore") {
                  return pv;
                } else if (handleNullish === "throw") {
                  throw new Error(`A nullish value was found for the nested object's key: ${cv}`);
                } else if (handleNullish === "stringify") {
                  currentValue = { S: currentValue === null ? "null" : "undefined" }
                } else { // handleNullish === null
                  currentValue = { NULL: true }
                }
              }
              pv[cv] = currentValue;
              return pv;
            }, {} as Record<string, AttributeValue>);
            return { M: reducedAttrValues };
        }
      }
      return null;
    }

  const returnObject: Record<string, AttributeValue> = {}
  Object.keys(input).forEach(x => {
    let currentValue = valueToAttributeValue(input[x], handleNullish);
    if (currentValue == null) {
      if (handleNullish === "ignore") {
        return;
      } else if (handleNullish === "throw") {
        throw new Error(`A nullish value was found for the provided object's key: ${x}`);
      } else if (handleNullish === "stringify") {
        currentValue = { S: currentValue === null ? "null" : "undefined" }
      } else { // handleNullish === "null"
        currentValue = { NULL: true }
      }
    }
    returnObject[x] = currentValue
  });
  return returnObject;
}

export const dynamoDBItemToObj: (item: Record<string, AttributeValue>) => Record<string, unknown> = (item) => {
  const extractAttributes: (currentAttribute: AttributeValue) => unknown = (currentAttribute) => {
    if (currentAttribute.B) {
      return currentAttribute.B;
    } else if (currentAttribute.BOOL) {
      return currentAttribute.BOOL;
    } else if (currentAttribute.BS) {
      return currentAttribute.BS;
    } else if (currentAttribute.L) {
      const mappedToValues = currentAttribute.L.map(x => extractAttributes(x));
      if (mappedToValues.some(x => typeof x === "number") && !mappedToValues.every(x => typeof x === "number")) {
        return mappedToValues.map(x => String(x))
      }
      return mappedToValues;
    } else if (currentAttribute.M) {
      return Object.keys(currentAttribute.M).reduce((pv, cv) => { pv[cv] = currentAttribute.M[cv] ? extractAttributes(currentAttribute.M[cv]) : undefined; return pv; }, {} as Record<string, unknown>)
    } else if (currentAttribute.N) {
      currentAttribute.N >= Number.MAX_SAFE_INTEGER.toString() ? currentAttribute.N : Number(currentAttribute.N);
    } else if (currentAttribute.NS) {
      return currentAttribute.NS.some(x => x >= Number.MAX_SAFE_INTEGER.toString()) ? currentAttribute.NS : currentAttribute.NS.map(x => Number(x));
    } else if (currentAttribute.NULL) {
      return null;
    } else if (currentAttribute.S) {
      return currentAttribute.S;
    } else if (currentAttribute.SS) {
      return currentAttribute.SS;
    }
    return undefined; // probably should NEVER happen, since all dynamoDB objects are required to have a value
  }
  const returnObject: Record<string, unknown> = {};
  Object.keys(item).forEach(fe => {
    returnObject[fe] = item[fe] ? extractAttributes(item[fe]) : undefined;
  });
  return returnObject;
}

export const encodeKey: (key: Record<string, AttributeValue> | Record<string, KeysAndAttributes> | Record<number, Record<string, AttributeValue>> | null | undefined) => string | null = (key) => {
  if (!key) return null;
  const jsonStr = JSON.stringify(key);
  return Buffer.from(jsonStr).toString('base64url');
}

/**
 * Decodes a URL-safe Base64 token back into a DynamoDB key object
 */
export const decodeUnprocessedKeys: (token: string | null | undefined) => Record<string, KeysAndAttributes> | null = (token) => {
  if (!token) return null;
  try {
    const jsonStr = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(jsonStr);
    const parsedkeys = Object.keys(parsed);
    if (parsedkeys.length == 0) return null;
    for (const parsedkey of parsedkeys) {
      if (!parsed[parsedkey].Keys || !Array.isArray(parsed[parsedkey].Keys)) {
        return null;
      }
    }
    return parsed as Record<string, KeysAndAttributes>
  } catch (error) {
    console.error('Invalid pagination or identification token provided.');
    return null;
  }
}

export const decodeShardedLastEvaluatedKey: (token: string | null | undefined) => Record<number, Record<string, AttributeValue>> | null = (token) => {
  if (!token) return null;
  try {
    const jsonStr = Buffer.from(token, 'base64url').toString('utf8');
    const parsedShardedKey = JSON.parse(jsonStr);
    const parsedShards = Object.keys(parsedShardedKey).map(Number);
    if (parsedShards.length == 0) return null;
    for (const shardNo of parsedShards) {
      const currentShardKey = parsedShardedKey[shardNo];
      if (!currentShardKey) return null;
      const eachShardKeyObjKeys = Object.keys(currentShardKey);
      if (eachShardKeyObjKeys.length === 0) return null;
      for (const eachParsedKey of eachShardKeyObjKeys) {
        if (!currentShardKey[eachParsedKey].S
          && !currentShardKey[eachParsedKey].N
          && !currentShardKey[eachParsedKey].B
          && !currentShardKey[eachParsedKey].SS
          && !currentShardKey[eachParsedKey].NS
          && !currentShardKey[eachParsedKey].BS
          && !currentShardKey[eachParsedKey].M
          && !currentShardKey[eachParsedKey].L
          && !currentShardKey[eachParsedKey].NULL
          && !currentShardKey[eachParsedKey].BOOL
        ) {
          return null;
        }
      }
    }
    return parsedShardedKey as Record<number, Record<string, AttributeValue>>;
  } catch (error) {
    console.error('Invalid pagination or identification token provided.');
    return null;
  }
}

export const decodeLastEvaluatedKey: (token: string | null | undefined) => Record<string, AttributeValue> | null = (token) => {
  if (!token) return null;
  try {
    const jsonStr = Buffer.from(token, 'base64url').toString('utf8');
    const parsed = JSON.parse(jsonStr);
    const parsedkeys = Object.keys(parsed);
    if (parsedkeys.length == 0) return null;
    for (const parsedkey of parsedkeys) {
      if (!parsed[parsedkey].S
        && !parsed[parsedkey].N
        && !parsed[parsedkey].B
        && !parsed[parsedkey].SS
        && !parsed[parsedkey].NS
        && !parsed[parsedkey].BS
        && !parsed[parsedkey].M
        && !parsed[parsedkey].L
        && !parsed[parsedkey].NULL
        && !parsed[parsedkey].BOOL
      ) {
        return null;
      }
    }
    return parsed as Record<string, AttributeValue>
  } catch (error) {
    console.error('Invalid pagination or identification token provided.');
    return null;
  }
}

export interface DynamoDBResponse<T> {
  data: T,
  message: string,
  status: number,
  lastEvaluatedKey?: string,
  unprocessedKeys?: string,
  /**
   * The DynamoDB exception name, when the call failed with one. Present only on failures.
   *
   * Callers that need to branch on a specific failure should use this rather than parsing
   * `message`, and `DDB_CONDITION_FAILED_STATUS` rather than either when all they need is
   * "the condition did not hold".
   */
  exception?: DynamoDBExceptionDetail,
}

export interface DynamoDBShardedQueryResponse<T> {
  data: T,
  message: string,
  status: number,
  lastEvaluatedKey?: string,
  /**
   * The DynamoDB exception name, when the call failed with one. Present only on failures.
   *
   * Callers that need to branch on a specific failure should use this rather than parsing
   * `message`, and `DDB_CONDITION_FAILED_STATUS` rather than either when all they need is
   * "the condition did not hold".
   */
  exception?: DynamoDBExceptionDetail,
}


/** Pure descriptor produced by per-domain DBOps. */
export interface QueryOps<T> {
  input: QueryCommandInput;
  mapper: (items: Record<string, AttributeValue>[] | undefined) => T;
}

export interface QueryOpsSharded<T> {
  input: { shardNo: number, input: QueryCommandInput }[];
  /* 
    Note : When querying on a GSI, 
    BOTH the base table's PK/SK AND the GSI's PK/SK MUST be extracted. 
    Failure to do so will result in validation errors.
   */
  keyExtractor: (item: Record<string, AttributeValue>) => Record<string, AttributeValue>
  /* 
    a > b : 1, a == b : 0, a < b : -1 
    NOTE: make sure that you compare ALL the applicable keys (PK, SK) to make sure
    that the items are sorted properly.
    Failure to do so will result in unexpected behaviors. 
   */
  itemKeyComparator: (a: Record<string, AttributeValue>, b: Record<string, AttributeValue>) => -1 | 0 | 1;
  mapper: (items: Record<string, AttributeValue>[] | undefined) => T[];
}

export interface GetOps<T> {
  input: GetItemCommandInput;
  mapper: (item: Record<string, AttributeValue> | undefined) => T;
}

export interface BatchGetOps<T> {
  input: BatchGetItemCommandInput;
  mapper: (item: Record<string, Record<string, AttributeValue>[]> | undefined) => T;
}

export type BatchWriteOps = { input: BatchWriteItemCommandInput };
export type PutOps = { input: PutItemCommandInput };
export type PutOpsWithMapper<T> = { input: Omit<PutItemCommandInput, "ReturnValues"> & { ReturnValues: "ALL_OLD" }; mapper: (item: Record<string, AttributeValue> | undefined) => T; };
export type UpdateOps = { input: UpdateItemCommandInput };
export type UpdateOpsWithMapper<T> = { 
  input: Omit<UpdateItemCommandInput, "ReturnValues"> & { ReturnValues: "ALL_OLD" | "UPDATED_OLD" | "ALL_NEW" | "UPDATED_NEW" }; 
  /*
   * IMPORTANT : Know what you are mapping
   *
   * If the ReturnValues is set to UPDATED_OLD or UPDATED_NEW, it does not return the keys or the attributes that were not updated.
   * Because of this, using the mapper that is used for mapping the entire item will result in errors or the item being dropped
   * if the ReturnValues is set to UPDATED_(sth).
   * 
   * Therefore, please make sure that you are aware of the specified ReturnValues parameter, 
   * and choose the correct mapper for the return values.
   */
  mapper: (item: Record<string, AttributeValue> | undefined) => T; 
};
export type DeleteOps = { input: DeleteItemCommandInput };
export type TransactWriteOps = { input: TransactWriteItemsCommandInput };

export async function dynamoDBGet<T>(ops: GetOps<T>): Promise<DynamoDBResponse<T>> {
  let out;
  try {
    out = await getClient().send(new GetItemCommand(ops.input));
  } catch (err) {
    const exceptionDetail = exceptionToErrorResponse(err);
    console.error(`An exception occurred while processing the DynamoDB Get command: ${JSON.stringify(exceptionDetail)}`);
    return {
      status : exceptionDetail.status,
      message : "An exception was thrown while processing the request",
      exception : exceptionDetail,
      data : ops.mapper(undefined)
    }
  }
  return {
    data: ops.mapper(out.Item),
    status: out.$metadata.httpStatusCode ?? 500,
    message: out.$metadata.httpStatusCode == 200 ? "Get request successful" : "An error occurred while processing get request"
  };
}

export async function dynamoDBBatchGet<T>(ops: BatchGetOps<T>, unprocessedKeys?: string): Promise<DynamoDBResponse<T>> {
  const duk = unprocessedKeys ? decodeUnprocessedKeys(unprocessedKeys) : null;
  let out;
  try {
    out = await getClient().send(new BatchGetItemCommand(duk ? { RequestItems: duk } : ops.input));
  } catch (err) {
    const exceptionDetail = exceptionToErrorResponse(err);
    console.error(`An exception occurred while processing the DynamoDB Batch Get command: ${JSON.stringify(exceptionDetail)}`);
    return {
      status : exceptionDetail.status,
      message : "An exception was thrown while processing the request",
      exception : exceptionDetail,
      data : ops.mapper(undefined)
    }
  }
  const uek = out.UnprocessedKeys ? encodeKey(out.UnprocessedKeys) : null;
  if (out.$metadata.attempts == undefined) {
    console.error("The number of retry attempts is undefined!");
  } else if (out.$metadata.attempts > 5) {
    console.warn("More than 5 attempts (" + out.$metadata.attempts + ") were made in this DynamoDB update request. Please check the DynamoDB table for hot partition issues.");
  }
  return {
    data: ops.mapper(out.Responses),
    status: out.$metadata.httpStatusCode ?? 500,
    message: out.$metadata.httpStatusCode == 200 ? "Batch get request successful" : "An error occurred while processing batch get request",
    ...(uek && { unprocessedKeys: uek }),
  };
}

export async function dynamoDBQuery<T>(ops: QueryOps<T>, limit?: number, scanIndexForward?: boolean, lastEvaluatedKey?: string): Promise<DynamoDBResponse<T>> {
  const exStartKey = lastEvaluatedKey ? decodeLastEvaluatedKey(lastEvaluatedKey) : null;
  let out;
  try {
    out = await getClient().send(new QueryCommand({ ...ops.input, ScanIndexForward: scanIndexForward, Limit: limit, ...(exStartKey && { ExclusiveStartKey: exStartKey }) }));
  } catch (err) {
    const exceptionDetail = exceptionToErrorResponse(err);
    console.error(`An exception occurred while processing the DynamoDB Query command: ${JSON.stringify(exceptionDetail)}`);
    return {
      status : exceptionDetail.status,
      message : "An exception was thrown while processing the request",
      exception : exceptionDetail,
      data : ops.mapper(undefined)
    }
  }
  const lek = out.LastEvaluatedKey ? encodeKey(out.LastEvaluatedKey) : null;
  if (out.$metadata.attempts == undefined) {
    console.error("The number of retry attempts is undefined!");
  } else if (out.$metadata.attempts > 5) {
    console.warn("More than 5 attempts (" + out.$metadata.attempts + ") were made in this DynamoDB update request. Please check the DynamoDB table for hot partition issues.");
  }
  return {
    data: ops.mapper(out.Items),
    status: out.$metadata.httpStatusCode ?? 500,
    message: out.$metadata.httpStatusCode == 200 ? "Query request successful" : "An error occurred while processing query request",
    ...(lek && { lastEvaluatedKey: lek })
  };
}

export async function dynamoDBQuerySharded<T>(ops: QueryOpsSharded<T>, targetLimit?: number, scanIndexForward: boolean = true, lastEvaluatedKeys?: string): Promise<DynamoDBShardedQueryResponse<T[]>> {
  const shardNumbers = ops.input.length;
  const parsedLastEvaluatedKeys: Record<number, Record<string, AttributeValue>> | null = decodeShardedLastEvaluatedKey(lastEvaluatedKeys);
  const eachShardLimit = (targetLimit && shardNumbers > 0) ? Math.ceil(targetLimit / shardNumbers) : undefined;
  try {
    const outSharded = await Promise.all(ops.input.map(async (es) => ({ shardNo: es.shardNo, result: await getClient().send(new QueryCommand({ ...es.input, ScanIndexForward: scanIndexForward, Limit: eachShardLimit, ExclusiveStartKey: parsedLastEvaluatedKeys ? parsedLastEvaluatedKeys[es.shardNo] ?? undefined : undefined })) })));
    let boundaryKey: Record<string, AttributeValue> | null = null;
    let boundaryShardNo: number | null = null;
    const failedShards: Map<number, number> = new Map<number, number>();
    outSharded.forEach(x => {
      if (x.result.$metadata.attempts == undefined) {
        console.error("The number of retry attempts is undefined!");
      } else if (x.result.$metadata.attempts > 5) {
        console.warn("More than 5 attempts (" + x.result.$metadata.attempts + ") were made in this DynamoDB put request. Please check the DynamoDB table for hot partition issues.");
      }
      if (x.result.$metadata.httpStatusCode != 200) {
        failedShards.set(x.shardNo, x.result.$metadata.httpStatusCode ?? 500);
        return;
      }
      if (x.result.LastEvaluatedKey) {
        if (!boundaryKey) {
          boundaryKey = x.result.LastEvaluatedKey;
          boundaryShardNo = x.shardNo;
        } else {
          const cmp = ops.itemKeyComparator(x.result.LastEvaluatedKey, boundaryKey);
          if (scanIndexForward) {
            if (cmp < 0) {
              boundaryKey = x.result.LastEvaluatedKey;
              boundaryShardNo = x.shardNo;
            }
          } else {
            if (cmp > 0) {
              boundaryShardNo = x.shardNo;
              boundaryKey = x.result.LastEvaluatedKey;
            }
          }
        }
      }
    });
    const resultLastEvaluatedKeys: Record<number, Record<string, AttributeValue>> = {}
    const resultItems: Record<string, AttributeValue>[] = []
    const preserveLastEvaluatedKeyForShard = (sn: number) => {
      const k = parsedLastEvaluatedKeys?.[sn];
      if (k) resultLastEvaluatedKeys[sn] = k;
    }
    outSharded.forEach(shard => {
      if (failedShards.get(shard.shardNo) != null) {
        // A failed shard makes the whole page inconsistent; all advancement is
        // discarded in the Option-A return below, so nothing to preserve here.
        return;
      }
      if (!boundaryKey) {
        resultItems.push(...shard.result.Items ?? []);
      } else {
        if (boundaryShardNo === shard.shardNo) {
          resultItems.push(...shard.result.Items ?? []);
          if (boundaryKey) resultLastEvaluatedKeys[shard.shardNo] = boundaryKey;
        } else {
          const bk = boundaryKey;
          if (!shard.result.Items || shard.result.Items.length == 0) {
            preserveLastEvaluatedKeyForShard(shard.shardNo);
            return;
          }
          const firstIndexToExclude = shard.result.Items.findIndex((x => scanIndexForward ? ops.itemKeyComparator(x, bk) > 0 : ops.itemKeyComparator(x, bk) < 0))
          const itemsSliced = firstIndexToExclude < 0 ? shard.result.Items : shard.result.Items.slice(0, firstIndexToExclude);
          if (itemsSliced.length < 1) {
            // Every item this shard returned sits beyond the boundary. Nothing is
            // surfaced from it this page, so hold its previous position (if any)
            // rather than rewinding it to the start on the next page.
            preserveLastEvaluatedKeyForShard(shard.shardNo);
            return;
          }
          // Always emit a resume token from the last kept item — even when this
          // shard is already exhausted (no LastEvaluatedKey). The cursor is
          // stateless, so an omitted shard is indistinguishable from one that
          // never started: the next page would re-scan it from the beginning and
          // re-emit these same items as duplicates. Resuming past the last item
          // instead simply yields an empty result next page, terminating cleanly.
          const lastItem = itemsSliced[itemsSliced.length - 1]
          if (!lastItem) return;
          resultLastEvaluatedKeys[shard.shardNo] = ops.keyExtractor(lastItem);
          resultItems.push(...itemsSliced)
        }
      }
    })
    const itemsResolved = ops.mapper(resultItems.sort((a, b) => scanIndexForward ? ops.itemKeyComparator(a, b) : ops.itemKeyComparator(a, b) * -1));
    if (failedShards.size > 0) {
      // One or more shards failed, so this page can't be trusted:
      // the successful shards may have advanced past the failed shards' unknown
      // positions, which would skip items. Instead of persisting that advance,
      // hand back the SAME pagination keys we were called with so the caller
      // re-fetches this exact page once the transient failure clears. The items
      // are returned best-effort (partial) for display only; status 207 signals
      // the caller should treat the page as incomplete and retry.
      const carriedKeys = parsedLastEvaluatedKeys ? (Object.keys(parsedLastEvaluatedKeys).length > 0 ? encodeKey(parsedLastEvaluatedKeys) : null) : null;
      return {
        status: 207,
        message: `Some shards failed to be queried : ${Array.from(failedShards.entries()).map((fe) => `[Shard ${fe[0]} : ${fe[1]}]`).join(", ")}`,
        data: itemsResolved,
        ...(carriedKeys && { lastEvaluatedKey: carriedKeys }),
      }
    }
    const resultLastEvaluatedKeysEncoded = resultLastEvaluatedKeys ? (Object.keys(resultLastEvaluatedKeys).length > 0 ? encodeKey(resultLastEvaluatedKeys) : null) : null;
    return {
      status: 200,
      message: "Query successful",
      data: itemsResolved,
      ...(resultLastEvaluatedKeysEncoded && { lastEvaluatedKey: resultLastEvaluatedKeysEncoded }),
    }
  } catch (err) {
    // Classified like every other operation rather than flattened to 500: one shard being
    // throttled should surface as 429 so the caller backs off, not as "the server is broken".
    // Interpolating the error into the message also leaked whatever the SDK put in it.
    const classified = exceptionToErrorResponse(err);
    console.error(`DynamoDB sharded query failed: ${classified.name}(${classified.status}) ${classified.message}`);
    return {
      status: classified.status,
      message: classified.message,
      data: [],
      exception : classified
    }
  }
}

export async function dynamoDBPut<T>(ops: PutOps | PutOpsWithMapper<T>): Promise<DynamoDBResponse<T | null>> {
  let res;
  try {
    res = await getClient().send(new PutItemCommand(ops.input));
  } catch (err) {
    const exceptionDetail = exceptionToErrorResponse(err);
    console.error(`An exception occurred while processing the DynamoDB Put command: ${JSON.stringify(exceptionDetail)}`);
    return {
      status : exceptionDetail.status,
      message : "An exception was thrown while processing the request",
      exception : exceptionDetail,
      data : null
    }
  }
  if (res.$metadata.attempts == undefined) {
    console.error("The number of retry attempts is undefined!");
  } else if (res.$metadata.attempts > 5) {
    console.warn("More than 5 attempts (" + res.$metadata.attempts + ") were made in this DynamoDB put request. Please check the DynamoDB table for hot partition issues.");
  }
  const retItem = ("mapper" in ops) ? ops.mapper(res.Attributes) : null
  return { status: res.$metadata.httpStatusCode ?? 500, message: res.$metadata.httpStatusCode == 200 ? "PUT request successful" : "An error occurred while processing put request", data: retItem }
}

export async function dynamoDBUpdate<T>(ops: UpdateOps | UpdateOpsWithMapper<T>): Promise<DynamoDBResponse<T | null>> {
  let res;
  try {
    res = await getClient().send(new UpdateItemCommand(ops.input));
  } catch (err) {
    const exceptionDetail = exceptionToErrorResponse(err);
    console.error(`An exception occurred while processing the DynamoDB Update command: ${JSON.stringify(exceptionDetail)}`);
    return {
      status : exceptionDetail.status,
      message : "An exception was thrown while processing the request",
      exception : exceptionDetail,
      data : null
    }
  }
  if (res.$metadata.attempts == undefined) {
    console.error("The number of retry attempts is undefined!");
  } else if (res.$metadata.attempts > 5) {
    console.warn("More than 5 attempts (" + res.$metadata.attempts + ") were made in this DynamoDB update request. Please check the DynamoDB table for hot partition issues.");
  }
  const retItem = ("mapper" in ops) ? ops.mapper(res.Attributes) : null
  return { status: res.$metadata.httpStatusCode ?? 500, message: res.$metadata.httpStatusCode == 200 ? "Update request successful" : "An error occurred while processing update request", data: retItem }
}

export async function dynamoDBDelete(ops: DeleteOps): Promise<DynamoDBResponse<null>> {
  let res;
  try {
    res = await getClient().send(new DeleteItemCommand(ops.input));
  } catch (err) {
    const exceptionDetail = exceptionToErrorResponse(err);
    console.error(`An exception occurred while processing the DynamoDB Delete command: ${JSON.stringify(exceptionDetail)}`);
    return {
      status : exceptionDetail.status,
      message : "An exception was thrown while processing the request",
      exception : exceptionDetail,
      data : null
    }
  }
  if (res.$metadata.attempts == undefined) {
    console.error("The number of retry attempts is undefined!");
  } else if (res.$metadata.attempts > 5) {
    console.warn("More than 5 attempts (" + res.$metadata.attempts + ") were made in this DynamoDB delete request. Please check the DynamoDB table for hot partition issues.");
  }
  return { status: res.$metadata.httpStatusCode ?? 500, message: res.$metadata.httpStatusCode == 200 ? "Delete request successful" : "An error occurred while processing delete request", data: null }
}

export async function dynamoDBBatchWrite(ops: BatchWriteOps): Promise<DynamoDBResponse<null>> {
  let res;
  try {
    res = await getClient().send(new BatchWriteItemCommand(ops.input));
  } catch (err) {
    const exceptionDetail = exceptionToErrorResponse(err);
    console.error(`An exception occurred while processing the DynamoDB Batch Write command: ${JSON.stringify(exceptionDetail)}`);
    return {
      status : exceptionDetail.status,
      message : "An exception was thrown while processing the request",
      exception : exceptionDetail,
      data : null
    }
  }
  if (res.$metadata.attempts == undefined) {
    console.error("The number of retry attempts is undefined!");
  } else if (res.$metadata.attempts > 5) {
    console.warn("More than 5 attempts (" + res.$metadata.attempts + ") were made in this DynamoDB transact write request. Please check the DynamoDB table for hot partition issues.");
  }
  return { status: res.$metadata.httpStatusCode ?? 500, message: res.$metadata.httpStatusCode == 200 ? "Transact Write request successful" : "An error occurred while processing transact write request", data: null }
}


export async function dynamoDBTransactWrite(ops: TransactWriteOps): Promise<DynamoDBResponse<null>> {
  let res;
  try {
    res = await getClient().send(new TransactWriteItemsCommand(ops.input));
  } catch (err) {
    const exceptionDetail = exceptionToErrorResponse(err);
    console.error(`An exception occurred while processing the DynamoDB Transact Write command: ${JSON.stringify(exceptionDetail)}`);
    return {
      status : exceptionDetail.status,
      message : "An exception was thrown while processing the request",
      exception : exceptionDetail,
      data : null
    }
  }
  if (res.$metadata.attempts == undefined) {
    console.error("The number of retry attempts is undefined!");
  } else if (res.$metadata.attempts > 5) {
    console.warn("More than 5 attempts (" + res.$metadata.attempts + ") were made in this DynamoDB transact write request. Please check the DynamoDB table for hot partition issues.");
  }
  return { status: res.$metadata.httpStatusCode ?? 500, message: res.$metadata.httpStatusCode == 200 ? "Transact Write request successful" : "An error occurred while processing transact write request", data: null }
}

/** Test-only: drop the cached client. */
export function _resetClient(): void {
  dynamoDBClient = null;
}