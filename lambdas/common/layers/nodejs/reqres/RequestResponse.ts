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