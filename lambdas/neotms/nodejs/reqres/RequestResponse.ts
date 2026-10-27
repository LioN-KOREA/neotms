// SPDX-License-Identifier: MIT
//
// The boundary between API Gateway and the rest of this function.
//
// Everything past this file deals in `RequestData` / `ResponseData` and knows nothing about Lambda.
// That is what lets the router and every manager be exercised in a unit test with a plain object
// instead of a hand-built API Gateway event - and the legacy system's lack of that seam is why
// nothing in it was ever tested.
//
// Two details here are load-bearing rather than incidental:
//
//   * `Set-Cookie` goes in the payload-format-2.0 `cookies` array, NOT in `headers`. A header map
//     cannot hold two values for one name, so a response that clears the flow cookie and sets the
//     session cookie would silently lose one of them.
//   * The JSON replacer stringifies `bigint`. Ids arrive from the Data API as strings and stay
//     strings, but `JSON.stringify` throws on a bigint rather than skipping it, and a throw here
//     would turn a correct response into a 500.

import type {
  APIGatewayEventRequestContextV2WithAuthorizer,
  APIGatewayProxyEventV2WithRequestContext,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";

export interface RRSetCookie {
  key: string;
  value: string;
  maxAge: number;
  sameSite: "none" | "lax" | "strict";
  path: string;
  httpOnly: boolean;
  secure: boolean;
}

export const SetCookie = (input: RRSetCookie): string =>
  `${input.key}=${input.value}; Path=${input.path}; Max-Age=${input.maxAge}; SameSite=${
    input.sameSite === "none" ? "None" : input.sameSite === "lax" ? "Lax" : "Strict"
  };${input.secure ? " Secure;" : ""}${input.httpOnly ? " HttpOnly;" : ""}`;

export type RequestMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS"
  | "QUERY"
  | "CONNECT"
  | "TRACE";

export interface ResponseData<T> {
  body: T;
  status: number;
  headers?: Record<string, string | number | boolean>;
  cookies?: Array<RRSetCookie>;
}

export interface RequestData {
  path: string;
  /** Uppercase HTTP method, e.g. "GET", "POST". */
  method: RequestMethod;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  queryParams: Record<string, string>;
  pathParams: Record<string, string>;
  /** Raw body - a parsed JSON value, a string, or null. Domain-specific schemas validate it. */
  body: unknown;
  /**
   * Scratch space for things the router works out and a handler needs.
   *
   * NEOTMS puts the authenticated caller here under `"caller"` (see NeotmsAuthGuard): the role
   * matrix and the row-level view scope are resolved once, by the guard, and every handler reads
   * the result rather than asking again. A Map rather than a typed field because the set of things
   * worth carrying grows, and widening an interface used by every handler to add one is friction
   * that encourages handlers to re-derive it instead.
   */
  context: Map<string, unknown>;
}

export type RRHandler = (req: RequestData) => Promise<ResponseData<unknown>>;

export function responseDataToApiGatewayResult(
  resultData: ResponseData<unknown>,
  additionalHeaders?: Record<string, string | number | boolean>,
  additionalCookies?: string[],
): APIGatewayProxyResultV2 {
  return {
    statusCode: resultData.status,
    headers:
      resultData.headers || additionalHeaders
        ? { ...(resultData.headers ?? {}), ...(additionalHeaders ?? {}) }
        : undefined,
    body: JSON.stringify(resultData.body, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
    cookies:
      resultData.cookies || additionalCookies
        ? [...(resultData.cookies?.map((c) => SetCookie(c)) ?? []), ...(additionalCookies ?? [])]
        : undefined,
  };
}

const KNOWN_METHODS: RequestMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "QUERY",
  "CONNECT",
  "TRACE",
];

export function apiGatewayRequestEventToRouterRequest(
  event: APIGatewayProxyEventV2WithRequestContext<
    APIGatewayEventRequestContextV2WithAuthorizer<unknown>
  >,
  context: Context,
): RequestData {
  const rawMethod = event.requestContext.http.method.toUpperCase();
  const method = (KNOWN_METHODS as string[]).includes(rawMethod)
    ? (rawMethod as RequestMethod)
    : "GET";

  const ctx = new Map<string, unknown>();
  ctx.set("authorizer", event.requestContext["authorizer"]);
  ctx.set("aws-context", context);
  // Logged on every refusal and every slow query, so that one line in CloudWatch Logs Insights can
  // be joined back to the API Gateway access log entry for the same call.
  ctx.set("request-id", context.awsRequestId);

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (v !== undefined) headers[k.toLowerCase()] = String(v);
  }
  const queryParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.queryStringParameters ?? {})) {
    if (v !== undefined) queryParams[k] = String(v);
  }
  const pathParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.pathParameters ?? {})) {
    if (v !== undefined) pathParams[k] = String(v);
  }

  let body: unknown = null;
  if (event.body) {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw; // The domain decides what to make of it.
    }
  }

  const cookies: Record<string, string> = {};
  for (const entry of event.cookies ?? []) {
    // split("=", 2) would lose everything after the second "=", and a base64url cookie value can
    // contain one. The name is up to the first "=" and the value is the rest, verbatim.
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    cookies[entry.slice(0, eq).trim()] = entry.slice(eq + 1);
  }

  return {
    path: event.requestContext.http.path,
    method,
    headers,
    cookies,
    queryParams,
    pathParams,
    body,
    context: ctx,
  };
}
