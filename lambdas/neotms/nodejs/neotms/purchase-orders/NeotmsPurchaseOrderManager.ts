// SPDX-License-Identifier: MIT
//
// Purchase-order endpoints. Cost is created and edited here.

import {
  paginate,
  pgExecute,
  pgExecuteCount,
  pgQuery,
  pgTransaction,
  sqlConstraint,
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { RequestData, ResponseData } from "../../reqres/RequestResponse.js";
import { JobProjectOps } from "../jobs/NeotmsJob.dbops.js";
import { TranslatorNameOps } from "../translators/NeotmsTranslator.dbops.js";
import { readListQuery } from "../NeotmsQuery.js";
import { JOB_TYPE_LINGUISTIC, poDetailTable, typeMismatchMessage } from "../NeotmsJobTypes.js";
import { badRequest, created, notFound, ok, runDb, type ListPage } from "../NeotmsResult.js";
import type { WriteContext } from "../NeotmsWrite.js";
import type { PurchaseOrderCreate, PurchaseOrderUpdate } from "../neotms.schemas.js";
import {
  PO_SORTS,
  PO_SORT_ALIASES,
  PoCreateOps,
  PoDetailClearOps,
  PoDetailUpsertOps,
  PoGetOps,
  PoListOps,
  PoSoftDeleteOps,
  PoUpdateOps,
  toPurchaseOrderRow,
  type PoFilters,
  type PurchaseOrderRow,
} from "./NeotmsPurchaseOrder.dbops.js";

function readFilters(request: RequestData): PoFilters {
  const read = (key: string): string | undefined => {
    const raw = (request.queryParams[key] ?? "").trim();
    return raw.length > 0 ? raw : undefined;
  };
  return {
    jobId: read("jobId"),
    projectId: read("projectId"),
    translatorId: read("translatorId"),
    state: read("state"),
    invoiceState: read("invoiceState"),
    moneyState: read("moneyState"),
    pmId: read("pmId"),
    workCode: read("workCode"),
    poType: read("poType"),
    slang: read("slang"),
    elang: read("elang"),
    poCategory: read("poCategory"),
    customerId: read("customerId"),
    corpId: read("corpId"),
    dueFrom: read("dueFrom"),
    dueTo: read("dueTo"),
    paidFrom: read("paidFrom"),
    paidTo: read("paidTo"),
  };
}

/**
 * List purchase orders.
 *
 * The cursor key comes from `PO_SORT_ALIASES` rather than from `sortAlias`, because a PO row carries
 * three tables' columns and its own `created_at` had to be prefixed to avoid colliding with the
 * job's. This is the one list in the codebase where the convention does not hold - see the comment
 * on `PO_SORT_ALIASES`.
 */
export async function listPurchaseOrders(
  caller: NeotmsCaller,
  request: RequestData,
): Promise<ResponseData<ListPage<PurchaseOrderRow> | string>> {
  const query = readListQuery(request, PO_SORTS, "created");
  const filters = readFilters(request);
  return runDb("list purchase orders", async () => {
    const rows: SqlRow[] = (await pgQuery(PoListOps(caller, query, filters))).data;
    const page = paginate(
      rows,
      query.limit,
      PO_SORT_ALIASES[query.sort.key],
      "po_id",
      toPurchaseOrderRow,
    );
    return ok(page);
  });
}

export async function getPurchaseOrder(
  caller: NeotmsCaller,
  id: string,
): Promise<ResponseData<PurchaseOrderRow | string>> {
  return runDb("get purchase order", async () => {
    const row = (await pgQuery(PoGetOps(caller, id))).data;
    return row ? ok(row) : notFound("purchase order");
  });
}

/**
 * Create a purchase order against a job.
 *
 * Three things happen before the INSERT, and each closes a different hole:
 *
 *   1. The job is read for its project id. That read is scoped, so it doubles as the authorization
 *      for this write - a PO has no owner of its own until it exists, so the right to add cost to a
 *      job is the right to see that job. The project id is then written from the job rather than
 *      from the request, which is what keeps this cost on the same report line as the revenue it
 *      was incurred against.
 *   2. The translator is checked, when one is named. The foreign key catches an id that does not
 *      exist but not one that has been soft-deleted, and a PO issued to a translator nobody can
 *      open is a payment with no payee.
 *   3. An unspecified PM defaults to the caller, so a scoped PM does not create a PO they cannot
 *      then see.
 *
 * The job read also supplies the 업무 구분 the PO starts with. Defaulted from the job rather than to
 * LINGUISTICS because a PO raised against a MICE job is far more often a MICE PO than not - but
 * only defaulted: a request that names its own `poType` keeps it, which is how an interpretation PO
 * gets raised against a MICE conference.
 */
export async function createPurchaseOrder(
  caller: NeotmsCaller,
  input: PurchaseOrderCreate,
  ctx: WriteContext,
): Promise<ResponseData<PurchaseOrderRow | string>> {
  const assigned: PurchaseOrderCreate = input.poPmId
    ? input
    : { ...input, poPmId: caller.staffId };
  return runDb("create purchase order", async () => {
    const job = (await pgQuery(JobProjectOps(caller, input.jobId))).data;
    if (job === null) return notFound("job");

    if (assigned.translatorId) {
      const tranName = (await pgQuery(TranslatorNameOps(assigned.translatorId))).data;
      if (tranName === null) {
        return { status: 400, body: "That translator does not exist or has been deleted" };
      }
    }

    const poType = assigned.poType ?? job.jobType;
    const typed: PurchaseOrderCreate = { ...assigned, poType };

    // Transactional for the reason `createJob` is: the PO row and its detail row are one fact, and
    // half of it is worse than none of it. The two reads above stay outside - see pgTransaction.
    let row: PurchaseOrderRow | null;
    try {
      row = await pgTransaction(async (client) => {
        const po = (await pgExecute(PoCreateOps(typed, job.projectId, ctx), client)).data;
        if (!po) return null;
        const detail = PoDetailUpsertOps(po.id, poType, typed);
        if (detail) await pgExecuteCount(detail, client);
        return po;
      });
    } catch (err) {
      const mismatch = typeMismatchMessage(sqlConstraint(err));
      if (mismatch) return badRequest(mismatch);
      throw err;
    }
    if (!row) return { status: 500, body: "The purchase order was not created" };

    // Re-read for the job and project columns and for the detail row, none of which RETURNING can
    // reach.
    const full = (await pgQuery(PoGetOps(caller, row.id))).data;
    return created(full ?? row);
  });
}

/**
 * Edit a purchase order.
 *
 * Same ordering obligation as `updateJob`, and for the same reason: each detail row's `po_type` is
 * pinned to its parent's by a composite FK, so the stale table's row has to go before the type on
 * `purchase_order` changes. `PoGetOps` opens the transaction because it is scoped - it authorizes
 * the unscoped clear that follows - and because the current type is what decides whether there is a
 * stale row at all.
 *
 * The table cleared is the one belonging to the type being LEFT, for the reason spelled out on
 * `updateJob` and on `poDetailTable`: MICE to IMC stays in `po_detail_non_linguistic`, so "the
 * other table" is the wrong answer there.
 */
export async function updatePurchaseOrder(
  caller: NeotmsCaller,
  id: string,
  input: PurchaseOrderUpdate,
  ctx: WriteContext,
): Promise<ResponseData<PurchaseOrderRow | string>> {
  if (Object.keys(input).length === 0) {
    return { status: 400, body: "No editable field was supplied" };
  }
  return runDb("update purchase order", async () => {
    if (input.translatorId) {
      const tranName = (await pgQuery(TranslatorNameOps(input.translatorId))).data;
      if (tranName === null) {
        return { status: 400, body: "That translator does not exist or has been deleted" };
      }
    }

    let updated: PurchaseOrderRow | null;
    try {
      updated = await pgTransaction(async (client) => {
        const current = (await pgQuery(PoGetOps(caller, id), client)).data;
        if (!current) return null;

        const currentType = current.poType ?? JOB_TYPE_LINGUISTIC;
        const nextType = input.poType ?? currentType;
        if (nextType !== currentType) {
          await pgExecuteCount(PoDetailClearOps(id, poDetailTable(currentType)), client);
        }

        const row = (await pgExecute(PoUpdateOps(caller, id, input, ctx), client)).data;
        if (!row) return null;

        const detail = PoDetailUpsertOps(id, nextType, input);
        if (detail) await pgExecuteCount(detail, client);
        return row;
      });
    } catch (err) {
      const mismatch = typeMismatchMessage(sqlConstraint(err));
      if (mismatch) return badRequest(mismatch);
      throw err;
    }
    if (!updated) return notFound("purchase order");

    const full = (await pgQuery(PoGetOps(caller, id))).data;
    return ok(full ?? updated);
  });
}

/**
 * Soft-delete a purchase order.
 *
 * Nothing references a PO, so there is no dependency to refuse on - this is the one delete in the
 * chain that is simply allowed. It is still a soft delete: the PO is the record of what was agreed
 * with a translator, and the cost it carried is in every report already run.
 */
export async function deletePurchaseOrder(
  caller: NeotmsCaller,
  id: string,
  ctx: WriteContext,
): Promise<ResponseData<{ id: string } | string>> {
  return runDb("delete purchase order", async () => {
    const deletedId = (await pgExecute(PoSoftDeleteOps(caller, id, ctx))).data;
    return deletedId ? ok({ id: deletedId }) : notFound("purchase order");
  });
}
