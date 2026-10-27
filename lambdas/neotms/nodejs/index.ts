// SPDX-License-Identifier: MIT
//
// Lambda entry point.
//
// API Gateway (HTTP API, payload format 2.0) hands the event here; the router in
// `neotms/neotms.handler.ts` does the rest. Keeping the translation in this one file is what lets
// every other module deal in plain `RequestData` / `ResponseData` - the router, the guard and all
// twenty-odd handlers can be exercised in a unit test with an object literal instead of a hand-built
// gateway event, and that seam is the thing the legacy system never had.
//
// Nothing else belongs in here. In particular there is no initialisation: the environment is parsed
// at module load (NeotmsEnv) and every client is created lazily and cached in its own module, so a
// cold start does the minimum and a warm one does nothing at all.

import type {
  APIGatewayEventRequestContextV2WithAuthorizer,
  APIGatewayProxyEventV2WithRequestContext,
  APIGatewayProxyResultV2,
  Context,
} from "aws-lambda";
import {
  apiGatewayRequestEventToRouterRequest,
  responseDataToApiGatewayResult,
} from "./reqres/RequestResponse.js";
import { handleRequest } from "./neotms/neotms.handler.js";

export async function handler(
  event: APIGatewayProxyEventV2WithRequestContext<
    APIGatewayEventRequestContextV2WithAuthorizer<unknown>
  >,
  context: Context,
): Promise<APIGatewayProxyResultV2> {
  try {
    const request = apiGatewayRequestEventToRouterRequest(event, context);
    return responseDataToApiGatewayResult(await handleRequest(request));
  } catch (err) {
    /*
     * Anything that reaches here is a bug, not a condition.
     *
     * Every expected failure already has a status: a refused origin is a 403 from the router, a
     * refused caller a 401 or 403 from the guard, a failed query a 500 or 503 from `runDb`. So this
     * catch exists for the unexpected - and it does two things deliberately:
     *
     *   * logs the AWS request id, which is the only value that joins this line to the API Gateway
     *     access log entry for the same call;
     *   * returns a fixed sentence. An exception message can contain a SQL fragment, a bind value or
     *     part of a request body, and an error page is not a place to publish any of those.
     */
    console.error(`[neotms] an unhandled error occurred (${context.awsRequestId}) : ${err}`);
    return responseDataToApiGatewayResult({ status: 500, body: "An unexpected error occurred" });
  }
}
