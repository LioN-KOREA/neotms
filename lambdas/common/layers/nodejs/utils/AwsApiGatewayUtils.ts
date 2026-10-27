import { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithLambdaAuthorizer, APIGatewayProxyResultV2, Context } from "aws-lambda";
import { LPXAuthContext, ResponseData } from "../interfaces/RequestResponse";
import { RequestData } from "../interfaces/RouterTypes";

export function responseDataToApiGatewayResult(resultData: ResponseData<unknown>, additionalHeaders? : Record<string, string | number | boolean>, additionalCookies? : string[]): APIGatewayProxyResultV2 {
    return {
        statusCode: resultData.status,
        headers : (resultData.headers || additionalHeaders) ? {
            ...(resultData.headers && resultData.headers),
            ...(additionalHeaders && additionalHeaders)
        } : undefined,
        body: JSON.stringify(resultData.data, (_key, value) =>
            typeof value === "bigint" ? value.toString() : value
        ),
        cookies : (resultData.cookies || additionalCookies) && [ ...(resultData.cookies ?? []), ...(additionalCookies ?? []) ],
    };
}

/**
 * The caller's IP address, from whichever field is trustworthy for the path the request took.
 *
 *  - **Via CloudFront**: API Gateway sees CloudFront's IP, and the viewer's address is the LEFTMOST
 *    entry of X-Forwarded-For. CloudFront appends, so later entries are whatever the client sent.
 *  - **Direct to execute-api**: `sourceIp` is the real TCP peer and cannot be forged.
 *
 * A caller who goes direct gains nothing by forging XFF, because we read `sourceIp` for them
 * anyway — but only because we cannot yet distinguish the two paths. The remaining gap is a caller
 * who goes direct while CLAIMING to have come through CloudFront, so that a forged XFF is believed.
 * Closing it needs a secret origin header from CloudFront; see LPX_SSO_README.md §5.1.
 *
 * Treat the result as advisory: good enough for rate limiting and for telling a user where failed
 * attempts came from, not good enough to make an authorization decision on.
 */
export function extractClientIp(
    headers: Record<string, string>,
    sourceIp: string | undefined,
): string {
    const forwarded = headers["x-forwarded-for"];
    if (forwarded) {
        const first = forwarded.split(",")[0]?.trim();
        if (first) return first;
    }
    return sourceIp ?? "";
}

export function apiGatewayRequestEventToRouterRequest(
    event: APIGatewayProxyEventV2 |
        APIGatewayProxyEventV2WithLambdaAuthorizer<LPXAuthContext>, 
    _context : Context
): RequestData {
    const method = event.requestContext.http.method.toUpperCase();
    const path = event.requestContext.http.path;
    const headers: Record<string, string> = {};
    const cookies : string[] = event.cookies ?? [];

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

    const clientIp = extractClientIp(headers, event.requestContext.http.sourceIp);

    let auth: LPXAuthContext | null = null;
    const authorizer = (event as APIGatewayProxyEventV2WithLambdaAuthorizer<LPXAuthContext>).requestContext
        .authorizer;
    if (authorizer 
        && "lambda" in authorizer 
        && authorizer.lambda
        && !authorizer.lambda.isAnonymous
        && authorizer.lambda.accountEmail != null
        && authorizer.lambda.accountRole != null
        && authorizer.lambda.accountSubId != null
        && authorizer.lambda.clientId != null
        && authorizer.lambda.authorities != null
    ) {
        auth = {
            isAnonymous : false,
            accountEmail : authorizer.lambda.accountEmail,
            accountRole : authorizer.lambda.accountRole,
            accountSubId : authorizer.lambda.accountSubId,
            clientId : authorizer.lambda.clientId,
            authorities : authorizer.lambda.authorities
        }
    } else {
        auth = {
            isAnonymous : true,
            accountEmail : "",
            accountRole : "",
            accountSubId : "",
            clientId : "",
            authorities : [],
        }
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

    return { path, method, auth, cookies, headers, queryParams, pathParams, body, clientIp };
}