export interface CorsHeaders {
  "Access-Control-Allow-Origin": string;
  "Access-Control-Allow-Headers": string;
  "Access-Control-Allow-Methods": string;
  "Access-Control-Allow-Credentials": boolean;
  "Access-Control-Max-Age": number;
  "Access-Control-Expose-Headers": string;
  "Vary": string;
}

export const CORS_HEADERS_REJECTED = {
  "Vary": "Origin",
  "Cache-Control": "no-store"
}

export interface CorsHeadersActualRequest {
  "Access-Control-Allow-Origin": string;
  "Vary": string;
  "Access-Control-Allow-Credentials"?: boolean;
  "Access-Control-Expose-Headers"?: string;
}

export function generateCorsHeadersPreflight(
  allowedOrigin: string = "", allowedHeaders: string[] = [],
  allowedMethods: string[] = [], allowCredentials: boolean = false,
  exposeAllowHeaders: string[] = [], maxAge: number = 600, corsVary: string = "Origin"): CorsHeaders {
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
  allowedOrigin: string = "", allowCredentials: boolean = false,
  exposeAllowHeaders: string[] = [], corsVary: string = "Origin"): CorsHeadersActualRequest {
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    ...(allowCredentials === true && { "Access-Control-Allow-Credentials": true }),
    ...(exposeAllowHeaders.length > 0 && { "Access-Control-Expose-Headers": exposeAllowHeaders.join(", ") }),
    Vary: corsVary,
  };
}