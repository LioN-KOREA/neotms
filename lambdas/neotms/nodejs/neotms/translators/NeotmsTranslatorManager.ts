// SPDX-License-Identifier: MIT
//
// Translator endpoints.
//
// Mirrors the customer manager - see NeotmsCustomerManager.ts for why the cursor is built from the
// sort ALIAS and why an empty PATCH is a 400. The two things specific to translators are both in
// `listTranslators`: the facet parameters, and the default to active-only.

import {
  paginate,
  pgExecute,
  pgQuery,
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import type { RequestData, ResponseData } from "../../reqres/RequestResponse.js";
import { readListQuery, sortAlias } from "../NeotmsQuery.js";
import { created, notFound, ok, runDb, type ListPage } from "../NeotmsResult.js";
import type { WriteContext } from "../NeotmsWrite.js";
import type { TranslatorCreate, TranslatorUpdate } from "../neotms.schemas.js";
import {
  TRANSLATOR_SORTS,
  TranslatorCreateOps,
  TranslatorGetOps,
  TranslatorListOps,
  TranslatorLivePoCountOps,
  TranslatorSoftDeleteOps,
  TranslatorUpdateOps,
  toTranslatorRow,
  type TranslatorFacets,
  type TranslatorRow,
} from "./NeotmsTranslator.dbops.js";

/**
 * Read the facet parameters off a request.
 *
 * Only the five keys the dbops allow-list knows about are looked up, so an unrecognised parameter is
 * ignored rather than reaching the query. An empty-string value is dropped: `?coin=` is what a
 * cleared dropdown sends, and it means "no filter", not "match the empty string" - which in this
 * schema would match most of the table, since these columns are blank far more often than not.
 */
function readFacets(request: RequestData): TranslatorFacets {
  const read = (key: string): string | undefined => {
    const raw = (request.queryParams[key] ?? "").trim();
    return raw.length > 0 ? raw : undefined;
  };
  return {
    field: read("field"),
    unfield: read("unfield"),
    upro: read("upro"),
    workCon: read("workCon"),
    coin: read("coin"),
  };
}

/**
 * List translators.
 *
 * `activeOnly` defaults to TRUE and is turned off by `?inactive=true`. The default is the opposite
 * way round from the customer list on purpose: a customer list is read to find a project, and a
 * dormant customer is still a real one; a translator list is read to assign work, and someone who
 * has left is not a candidate. Making the common case the default means the PM does not have to
 * remember to filter, and the explicit opt-in covers the other case - looking at a two-year-old PO
 * and wanting to know who did it.
 */
export async function listTranslators(
  request: RequestData,
): Promise<ResponseData<ListPage<TranslatorRow> | string>> {
  const query = readListQuery(request, TRANSLATOR_SORTS, "created");
  const facets = readFacets(request);
  const activeOnly = request.queryParams["inactive"] !== "true";
  return runDb("list translators", async () => {
    const rows: SqlRow[] = (await pgQuery(TranslatorListOps(query, facets, activeOnly))).data;
    const page = paginate(
      rows,
      query.limit,
      sortAlias(query.sort.column),
      "translator_id",
      toTranslatorRow,
    );
    return ok(page);
  });
}

export async function getTranslator(id: string): Promise<ResponseData<TranslatorRow | string>> {
  return runDb("get translator", async () => {
    const row = (await pgQuery(TranslatorGetOps(id))).data;
    return row ? ok(row) : notFound("translator");
  });
}

export async function createTranslator(
  input: TranslatorCreate,
  ctx: WriteContext,
): Promise<ResponseData<TranslatorRow | string>> {
  return runDb("create translator", async () => {
    const row = (await pgExecute(TranslatorCreateOps(input, ctx))).data;
    return row ? created(row) : { status: 500, body: "The translator was not created" };
  });
}

export async function updateTranslator(
  id: string,
  input: TranslatorUpdate,
  ctx: WriteContext,
): Promise<ResponseData<TranslatorRow | string>> {
  if (Object.keys(input).length === 0) {
    return { status: 400, body: "No editable field was supplied" };
  }
  return runDb("update translator", async () => {
    const row = (await pgExecute(TranslatorUpdateOps(id, input, ctx))).data;
    return row ? ok(row) : notFound("translator");
  });
}

/**
 * Soft-delete a translator, unless live purchase orders still reference them.
 *
 * As with the customer delete, the count is a courtesy: it turns a constraint violation into a
 * sentence someone can act on. The suggestion in the message is deactivation rather than deletion,
 * because that is almost always what was actually wanted - it removes the translator from the
 * assignment pickers without disturbing the POs that record what they were paid.
 */
export async function deleteTranslator(
  id: string,
  ctx: WriteContext,
): Promise<ResponseData<{ id: string } | string>> {
  return runDb("delete translator", async () => {
    const livePos = (await pgQuery(TranslatorLivePoCountOps(id))).data;
    if (livePos > 0) {
      return {
        status: 409,
        body: `This translator still has ${livePos} live purchase order(s). Deactivate them instead of deleting.`,
      };
    }
    const deletedId = (await pgExecute(TranslatorSoftDeleteOps(id, ctx))).data;
    return deletedId ? ok({ id: deletedId }) : notFound("translator");
  });
}
