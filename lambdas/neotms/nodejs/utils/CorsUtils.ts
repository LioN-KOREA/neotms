// SPDX-License-Identifier: MIT
//
// CORS headers, built here rather than configured on the HTTP API.
//
// The reason is in NeotmsApi.ts, but it is worth repeating where the code is: an API Gateway CORS
// configuration answers the preflight before the function runs, so a rejected origin gets a 403
// with no CORS headers and the browser reports an opaque network failure. The UI then cannot tell
// "not signed in" from "the API is down" - and those need different screens. Two mechanisms both
// setting `Access-Control-Allow-Origin` also produce a duplicate header, which browsers reject
// outright.
//
// `Access-Control-Allow-Origin` is always one exact origin echoed back from the allow-list, never
// `*`. With `Allow-Credentials: true` the browser refuses a wildcard anyway, so a wildcard here
// would not be a loose policy - it would be a broken one.

export interface CorsHeaders {
  "Access-Control-Allow-Origin": string;
  "Access-Control-Allow-Headers": string;
  "Access-Control-Allow-Methods": string;
  "Access-Control-Allow-Credentials": boolean;
  "Access-Control-Max-Age": number;
  "Access-Control-Expose-Headers": string;
  Vary: string;
}

/**
 * What a refused origin gets.
 *
 * `Vary: Origin` so no shared cache can serve this refusal to a request from an allowed origin,
 * and `no-store` because an authorization decision is never cacheable.
 */
export const CORS_HEADERS_REJECTED = {
  Vary: "Origin",
  "Cache-Control": "no-store",
};

export interface CorsHeadersActualRequest {
  "Access-Control-Allow-Origin": string;
  Vary: string;
  "Access-Control-Allow-Credentials"?: boolean;
  "Access-Control-Expose-Headers"?: string;
}

export function generateCorsHeadersPreflight(
  allowedOrigin: string = "",
  allowedHeaders: string[] = [],
  allowedMethods: string[] = [],
  allowCredentials: boolean = false,
  exposeAllowHeaders: string[] = [],
  maxAge: number = 600,
  corsVary: string = "Origin",
): CorsHeaders {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Headers": allowedHeaders.join(", "),
    "Access-Control-Allow-Methods": allowedMethods.join(", "),
    "Access-Control-Allow-Credentials": allowCredentials,
    "Access-Control-Expose-Headers": exposeAllowHeaders.join(", "),
    "Access-Control-Max-Age": maxAge,
    Vary: corsVary,
  };
}

export function generateCorsHeadersActual(
  allowedOrigin: string = "",
  allowCredentials: boolean = false,
  exposeAllowHeaders: string[] = [],
  corsVary: string = "Origin",
): CorsHeadersActualRequest {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    ...(allowCredentials === true && { "Access-Control-Allow-Credentials": true }),
    ...(exposeAllowHeaders.length > 0 && {
      "Access-Control-Expose-Headers": exposeAllowHeaders.join(", "),
    }),
    Vary: corsVary,
  };
}
