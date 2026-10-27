// SPDX-License-Identifier: MIT
//
// Cross-cutting types and constants used by the Router and every domain.

import * as v from "valibot";
import { CreateResponseData } from "../utils/ResponseDataUtils";
import { APIGatewayEventRequestContextV2WithAuthorizer, APIGatewayProxyEventV2WithRequestContext, APIGatewayProxyResultV2, Context } from "aws-lambda";

export interface RRSetCookie { key : string; value : string; maxAge : number; sameSite : "none" | "lax" | "strict", path : string;  httpOnly : boolean; secure : boolean; }
export const SetCookie = (input : RRSetCookie) => `${input.key}=${input.value}; Path=${input.path}; Max-Age=${input.maxAge}; SameSite=${input.sameSite === "none" ? "None" : input.sameSite === "lax" ? "Lax" : "Strict"};${input.secure ? " Secure;" : ""}${input.httpOnly ? " HttpOnly;" : ""};`

type RequestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "QUERY" | "CONNECT" | "TRACE"
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
    /** Raw body — may be a parsed JSON value, a string, or null. Domain-specific schemas validate. */
    body: unknown;
    context : Map<string, unknown>;
}

export type RRHandler = (req: RequestData) => Promise<ResponseData<unknown>>

export function responseDataToApiGatewayResult(resultData: ResponseData<unknown>, additionalHeaders? : Record<string, string | number | boolean>, additionalCookies? : string[]): APIGatewayProxyResultV2 {
    return {
        statusCode: resultData.status,
        headers : (resultData.headers || additionalHeaders) ? {
            ...(resultData.headers && resultData.headers),
            ...(additionalHeaders && additionalHeaders)
        } : undefined,
        body: JSON.stringify(resultData.body, (_key, value) =>
            typeof value === "bigint" ? value.toString() : value
        ),
        cookies : (resultData.cookies || additionalCookies) && [ ...(resultData.cookies?.map(fi => SetCookie(fi)) ?? []), ...(additionalCookies ?? []) ],
    };
}

export function apiGatewayRequestEventToRouterRequest(
    event: APIGatewayProxyEventV2WithRequestContext<APIGatewayEventRequestContextV2WithAuthorizer<unknown>>, 
    context : Context
): RequestData {
    const reqMethod = event.requestContext.http.method.toUpperCase();
    const path = event.requestContext.http.path;
    const authorizer = event.requestContext['authorizer']
    const headers: Record<string, string> = {};
    const ctx = new Map();
    ctx.set("authorizer", authorizer);
    ctx.set("aws-context", context);

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
        const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
        try {
            body = JSON.parse(raw);
        } catch {
            body = raw; // domain decides
        }
    }

    return {
        path : path,
        method : reqMethod === "GET" || reqMethod === "POST" || reqMethod === "PUT" || reqMethod === "PATCH" || reqMethod === "DELETE" || reqMethod === "OPTIONS" || reqMethod === "QUERY" || reqMethod === "CONNECT" || reqMethod === "TRACE" ? reqMethod : "GET",
        headers : headers,
        body : body,
        cookies: (event.cookies ?? []).reduce((pv, cv) => {
            const cookieKv = cv.split("=", 2);
            if (cookieKv.length < 2) return { ...pv }
            return { ...pv, [cookieKv[0]]: cookieKv[1] }
        }, {}),
        pathParams : pathParams,
        queryParams : queryParams,
        context : ctx
    }
}

export interface ResponseBody<T> {
  data: T;
  status: number;
  message: string;
  size?: number;
  paginationKey?: string;
}

export interface LPXAuthContext {
  isAnonymous: boolean;
  clientId: string;
  accountSubId: string;
  accountEmail: string;
  accountRole: string;
  authorities: string[];
}



/**
 * Accepts string | number | bigint and transforms to bigint.
 * Use this in any schema field that represents an id or other big integer.
 */
export const BigIntSchema = v.pipe(
  v.union([v.string(), v.number(), v.bigint()]),
  v.transform((val) => BigInt(val as string | number | bigint)),
);

export const DEFAULT_INVALID_PATH_RESPONSE: ResponseData<ResponseBody<null>> =
{
  status: 404,
  body: {
    data: null,
    status: 404,
    message: "Unable to find the resource that you requested.",
  }
};

export const DEFAULT_INVALID_METHOD_RESPONSE: ResponseData<ResponseBody<null>> =
{
  status: 405,
  body: {
    data: null,
    status: 405,
    message: "Method not allowed.",
  },
}

export const DEFAULT_UNAUTHENTICATED_RESPONSE: ResponseData<ResponseBody<null>> =
{
  status: 401,
  body: {
    data: null,
    status: 401,
    message: "Unauthenticated.",
  }
}

export const DEFAULT_UNAUTHORIZED_RESPONSE: ResponseData<ResponseBody<null>> =
{
  status: 403,
  body: {
    data: null,
    status: 403,
    message: "Unauthorized.",
  }
};

export const DEFAULT_VALIDATION_FAILED_RESPONSE: ResponseData<ResponseBody<null>> =
{
  status: 400,
  body: {
    data: null,
    status: 400,
    message: "Request validation failed.",
  }
}

/**
 * Build a generic 500 response in the spec-mandated shape.
 * Used by the Router's catch-all only — see (projectName)Router.ts.
 */
export function buildUnknownErrorResponse(
  message?: string,
  headers?: Record<string, string | number | boolean>,
  cookies?: string[]
): ResponseData<ResponseBody<null>> {
  return CreateResponseData({
    data: null,
    status: 500,
    message: `${message ?? "An unknown error occurred while handling the request."} ${Date.now()}`,
  }, 500, headers, cookies);
}
