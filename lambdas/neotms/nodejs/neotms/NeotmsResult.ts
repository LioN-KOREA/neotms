// SPDX-License-Identifier: MIT
//
// How a manager turns work into a response, and what happens when the work fails.
//
// Every domain manager in this folder is a function from a request to a `ResponseData`, and every
// one of them touches the database. Without something like this module each would need its own
// try/catch around `rdsQuery`, and the five copies would disagree - which is how a cold cluster
// comes to be reported as a 500 on four screens and a 503 on the fifth.
//
// The distinction being protected is the one the legacy system never made: a request that FAILED is
// not the same as a request that was REFUSED, and neither is the same as a request the client should
// try again. LKTMS answered 500 for all three (and often 200 with an error page), so nobody could
// tell a deploy problem from a cold database from a genuine permission refusal.

import type { ResponseData } from "../reqres/RequestResponse.js";
import { exceptionToErrorResponse } from "../utils/RdsDataUtils.js";
import * as v from "valibot";

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One page of a list.
 *
 * `cursor` absent means this is the last page - that is how the client knows to stop. There is
 * deliberately no `total`: a count over a filtered, row-level-scoped table costs about as much as
 * the page itself, and no screen in this system needs one. See `paginate` in RdsDataUtils.
 */
export type ListPage<T> = {
  items: T[];
  cursor?: string;
};

export const ok = <T>(body: T, status = 200): ResponseData<T> => ({ status, body });

export const created = <T>(body: T): ResponseData<T> => ({ status: 201, body });

export const notFound = (what: string): ResponseData<string> => ({
  status: 404,
  /*
   * Intentionally identical whether the row does not exist or merely is not visible to this caller.
   *
   * A manager applies the caller's row-level scope inside the query, so a project belonging to
   * another PM simply returns no rows. Answering "403 Forbidden" there would confirm the row's
   * existence to someone who may not see it, which turns a list endpoint into an enumeration
   * oracle - the detail-endpoint half of the row-level access control bug this system is fixing.
   */
  body: `No such ${what}, or it is not visible to you.`,
});

export const badRequest = (message: string): ResponseData<string> => ({ status: 400, body: message });

/* -------------------------------------------------------------------------- */
/* Request body validation                                                    */
/* -------------------------------------------------------------------------- */

export type Parsed<T> = { ok: true; value: T } | { ok: false; response: ResponseData<string> };

/**
 * Validate a request body, or produce the 400 to return.
 *
 * The issues are summarised into the response body rather than returned verbatim. Valibot's issue
 * objects carry the received value, and a body echoed back into an error message is how a field
 * someone pasted a credential into ends up in a log aggregator.
 */
export function parseBody<S extends v.GenericSchema>(schema: S, body: unknown): Parsed<v.InferOutput<S>> {
  const result = v.safeParse(schema, body ?? {});
  if (result.success) return { ok: true, value: result.output };
  const fields = result.issues
    .map((issue) => issue.path?.map((p) => String(p.key)).join(".") ?? "(root)")
    .filter((name, index, all) => all.indexOf(name) === index)
    .join(", ");
  return { ok: false, response: badRequest(`These fields are missing or invalid: ${fields}`) };
}

/* -------------------------------------------------------------------------- */
/* Running database work                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Run a manager's database work and translate any failure into the right status.
 *
 * `label` is what goes in the log line, so it should name the operation rather than the table -
 * "list projects" tells an operator which screen is broken; "SELECT project" does not.
 *
 * The 503 path matters more than it looks: the cluster pauses outside business hours by design
 * (that choice is most of the cost saving), so the first request of the morning CAN arrive while it
 * is still resuming even after `withResumeRetry` has spent its budget. `Retry-After` tells the
 * browser to come back rather than show the user an error, which is the difference between the cost
 * model being invisible and being a daily complaint.
 *
 * The type parameter is the whole response rather than its body. A manager's work typically has
 * several exits - `ok(row)`, `notFound(...)`, a 409 with a sentence - so what it returns is a UNION
 * of `ResponseData`s, and `ResponseData<T>` cannot be inferred from a union of different `T`s.
 * Taking `R` and returning `R | ResponseData<string>` says the useful thing instead: whatever the
 * work can answer, plus the failure this function adds.
 */
export async function runDb<R extends ResponseData<unknown>>(
  label: string,
  work: () => Promise<R>,
): Promise<R | ResponseData<string>> {
  try {
    return await work();
  } catch (err) {
    const detail = exceptionToErrorResponse(err);
    // Logged at error level even for a 503, because a resume that gets this far is worth seeing in
    // the aggregate - a sudden rise in them means the ACU schedule no longer matches when people
    // actually work.
    console.error(`[neotms] ${label} failed : ${detail.status} ${detail.name} ${detail.message}`);
    return {
      status: detail.status,
      body: detail.message,
      ...(detail.status === 503 && { headers: { "Retry-After": "2" } }),
    };
  }
}
