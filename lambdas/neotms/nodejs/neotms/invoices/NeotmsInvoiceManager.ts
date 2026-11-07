// SPDX-License-Identifier: MIT
//
// 결제 - translator-invoice endpoints, and the two PO money actions that belong with them.
//
// Everything in this file is reached through the `PAYMENT` menu rather than `PURCHASE_ORDER`, and
// NeotmsMenus.ts records why: raising a PO is a PM's daily work, signing off the amount on it is a
// different authority, and one menu id cannot say both. Concretely - `create` here issues an
// invoice, `update` approves a PO and records money, `delete` voids an invoice.
//
// ## The one invariant this module defends
//
// An invoice must cover exactly the POs it was asked to cover. Every other rule in here follows from
// that, because the failure it prevents is silent: a translator who sent one invoice for four jobs
// and was paid for three does not find out from this system, and neither does anybody else.
//
// So `PoInvoiceAssignOps` returns a COUNT, and a count short of the number of ids asked for aborts
// the whole request rather than issuing the document. The transaction is what makes "aborts" mean
// anything - without it the invoice row would already exist, holding a code and a total, with some
// of its lines attached.

import {
  paginate,
  pgExecute,
  pgExecuteCount,
  pgQuery,
  pgTransaction,
  type SqlRow,
} from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { RequestData, ResponseData } from "../../reqres/RequestResponse.js";
import { readListQuery, sortAlias } from "../NeotmsQuery.js";
import { PO_STATES_INVOICEABLE, PO_STATE_CANCELLED } from "../NeotmsPoStates.js";
import { TranslatorNameOps } from "../translators/NeotmsTranslator.dbops.js";
import { badRequest, created, notFound, ok, runDb, type ListPage } from "../NeotmsResult.js";
import type { WriteContext } from "../NeotmsWrite.js";
import type {
  InvoiceTranslatorCreate,
  InvoiceTranslatorUpdate,
  PoApproval,
  PoSettlement,
} from "../neotms.schemas.js";
import {
  PoApprovalOps,
  PoGetOps,
  PoInvoiceAssignOps,
  PoInvoiceDetachOps,
  PoUpdateOps,
  type PurchaseOrderRow,
} from "../purchase-orders/NeotmsPurchaseOrder.dbops.js";
import {
  INVOICE_SORTS,
  InvoiceCreateOps,
  InvoiceGetOps,
  InvoiceListOps,
  InvoiceSoftDeleteOps,
  InvoiceUpdateOps,
  toInvoiceRow,
  type InvoiceFilters,
  type InvoiceRow,
} from "./NeotmsInvoice.dbops.js";

/**
 * Thrown inside a transaction to roll it back, caught immediately outside it.
 *
 * `pgTransaction` COMMITs whatever its body RETURNS - returning `null` is a committed transaction
 * that happens to answer null. Only a THROW rolls back. That is the right design for a helper that
 * cannot know whether a null is a failure, and it means a refusal this module wants to undo has to
 * be raised rather than returned.
 *
 * A class of its own rather than a plain `Error`, so the catch can tell this refusal - which is a
 * 400 - from a genuine database failure, which must keep propagating to `runDb` and become a 500 or
 * a 503. Catching `Error` broadly here would turn a dead connection into "some of your POs are
 * already invoiced", which is a wrong answer dressed as a helpful one.
 */
class LinesRefused extends Error {
  constructor() {
    super("purchase orders refused by the invoice assignment");
    this.name = "LinesRefused";
  }
}

/** The one sentence all four assignment refusals share. See `createInvoice`. */
const LINES_REFUSED_MESSAGE =
  "선택한 발주 중 일부를 이 인보이스에 연결할 수 없습니다. " +
  "해당 발주가 이 번역가의 것이 아니거나, 아직 납품되지 않았거나, " +
  "이미 다른 인보이스에 포함되어 있을 수 있습니다.";

function readFilters(request: RequestData): InvoiceFilters {
  const read = (key: string): string | undefined => {
    const raw = (request.queryParams[key] ?? "").trim();
    return raw.length > 0 ? raw : undefined;
  };
  return {
    translatorId: read("translatorId"),
    pmId: read("pmId"),
    coinCode: read("coinCode"),
    invState: read("invState"),
    moneyState: read("moneyState"),
    issuedFrom: read("issuedFrom"),
    issuedTo: read("issuedTo"),
    paidFrom: read("paidFrom"),
    paidTo: read("paidTo"),
  };
}

/* -------------------------------------------------------------------------- */
/* Invoices                                                                   */
/* -------------------------------------------------------------------------- */

export async function listInvoices(
  caller: NeotmsCaller,
  request: RequestData,
): Promise<ResponseData<ListPage<InvoiceRow> | string>> {
  const query = readListQuery(request, INVOICE_SORTS, "created");
  const filters = readFilters(request);
  return runDb("list translator invoices", async () => {
    const rows: SqlRow[] = (await pgQuery(InvoiceListOps(caller, query, filters))).data;
    const page = paginate(
      rows,
      query.limit,
      sortAlias(query.sort.column),
      "invoice_id",
      toInvoiceRow,
    );
    return ok(page);
  });
}

export async function getInvoice(
  caller: NeotmsCaller,
  id: string,
): Promise<ResponseData<InvoiceRow | string>> {
  return runDb("get translator invoice", async () => {
    const row = (await pgQuery(InvoiceGetOps(caller, id))).data;
    return row ? ok(row) : notFound("translator invoice");
  });
}

/**
 * Issue an invoice over a set of POs.
 *
 * ## Order, and why each step is where it is
 *
 *   1. The translator is checked OUTSIDE the transaction. Read-only, and under Supavisor's
 *      transaction mode the pooled backend is unavailable to every other caller between BEGIN and
 *      COMMIT - so the transaction holds the writes and nothing else. A soft-deleted translator
 *      passes the foreign key and fails this check, which is the difference between "no such
 *      translator" and an invoice addressed to somebody nobody can open.
 *   2. The duplicate ids are collapsed. `[7, 7]` asking for two lines is one PO, and the assign
 *      statement would move one row - so the count check below would reject a request that is
 *      actually fine. Collapsing first makes "how many were asked for" mean what it says.
 *   3. The invoice row, then the assignment, inside ONE transaction.
 *   4. The count is compared. Short means at least one PO was refused - wrong translator, not yet
 *      delivered, already on another invoice, or out of scope - and every one of those would print
 *      a wrong document. `PoInvoiceAssignOps` lists them.
 *
 * A short count THROWS `LinesRefused`, which is what rolls the transaction back - see that class for
 * why returning would not. So a rejected request leaves no invoice row and burns only a sequence
 * number, which is the trade the sequence exists to make (NeotmsCodes.ts): a gap in the codes is
 * invisible, a half-issued invoice is not.
 *
 * The refusal is deliberately one message for all four causes. Naming which PO and why would be
 * friendlier, and it would also tell a caller which PO ids exist and which translator they belong
 * to - the enumeration oracle `notFound` exists to avoid. The 결제 screen only offers POs that pass
 * all four tests, so a caller reaching this message has either raced somebody else or built the
 * request by hand.
 */
export async function createInvoice(
  caller: NeotmsCaller,
  input: InvoiceTranslatorCreate,
  ctx: WriteContext,
): Promise<ResponseData<InvoiceRow | string>> {
  const assigned: InvoiceTranslatorCreate = input.invPmId
    ? input
    : { ...input, invPmId: caller.staffId };
  const poIds = [...new Set(assigned.poIds)];

  return runDb("create translator invoice", async () => {
    const tranName = (await pgQuery(TranslatorNameOps(assigned.translatorId))).data;
    if (tranName === null) {
      return badRequest("That translator does not exist or has been deleted");
    }

    let result: InvoiceRow | null;
    try {
      result = await pgTransaction(async (client) => {
        const invoice = (await pgExecute(InvoiceCreateOps(assigned, ctx), client)).data;
        if (!invoice) return null;
        const moved = (
          await pgExecute(
            PoInvoiceAssignOps(
              caller,
              invoice.id,
              invoice.invTranCode,
              assigned.translatorId,
              poIds,
              PO_STATES_INVOICEABLE,
            ),
            client,
          )
        ).data;
        if (moved !== poIds.length) throw new LinesRefused();
        return invoice;
      });
    } catch (err) {
      if (err instanceof LinesRefused) return badRequest(LINES_REFUSED_MESSAGE);
      throw err;
    }
    if (!result) return { status: 500, body: "The invoice was not created" };

    // Re-read for `poCount` and the two PO totals: the POs were attached after the INSERT, so
    // RETURNING saw an invoice with no lines.
    const full = (await pgQuery(InvoiceGetOps(caller, result.id))).data;
    return created(full ?? result);
  });
}

/**
 * Edit an invoice, and optionally replace the set of POs on it.
 *
 * `poIds` is a REPLACEMENT, not an addition - the schema's docstring says so, and the implementation
 * is detach-then-assign so that it cannot be read any other way. A PATCH that omits `poIds`
 * leaves the lines alone; one that sends three ids ends with exactly those three.
 *
 * Detach before assign, and both inside the transaction with the row update. The ordering is
 * forced: `PoInvoiceAssignOps` refuses a PO already on another invoice, and until the detach has run
 * the POs currently on THIS invoice look exactly like that to a re-send of the same list. Doing it
 * the other way round would make the commonest edit - "same POs, corrected total" - fail.
 *
 * `PoInvoiceDetachOps` is unscoped, and the scoped `InvoiceUpdateOps` above it is what authorises
 * it. Hence the update first: if the caller may not see this invoice, nothing has been detached.
 */
export async function updateInvoice(
  caller: NeotmsCaller,
  id: string,
  input: InvoiceTranslatorUpdate,
  ctx: WriteContext,
): Promise<ResponseData<InvoiceRow | string>> {
  if (Object.keys(input).length === 0) {
    return badRequest("No editable field was supplied");
  }
  const poIds = input.poIds ? [...new Set(input.poIds)] : null;

  return runDb("update translator invoice", async () => {
    const current = (await pgQuery(InvoiceGetOps(caller, id))).data;
    if (!current) return notFound("translator invoice");
    if (poIds && current.translatorId === null) {
      return badRequest("이 인보이스에는 번역가가 지정되어 있지 않아 발주를 연결할 수 없습니다.");
    }

    let result: InvoiceRow | null;
    try {
      result = await pgTransaction(async (client) => {
        const row = (await pgExecute(InvoiceUpdateOps(caller, id, input, ctx), client)).data;
        if (!row) return null;
        if (poIds) {
          await pgExecuteCount(PoInvoiceDetachOps(id), client);
          const moved = (
            await pgExecute(
              PoInvoiceAssignOps(
                caller,
                id,
                row.invTranCode,
                row.translatorId ?? "",
                poIds,
                PO_STATES_INVOICEABLE,
              ),
              client,
            )
          ).data;
          if (moved !== poIds.length) throw new LinesRefused();
        }
        return row;
      });
    } catch (err) {
      if (err instanceof LinesRefused) return badRequest(LINES_REFUSED_MESSAGE);
      throw err;
    }
    if (!result) return notFound("translator invoice");

    const full = (await pgQuery(InvoiceGetOps(caller, id))).data;
    return ok(full ?? result);
  });
}

/**
 * Void an invoice and return its POs to the uninvoiced list.
 *
 * The detach is not tidying-up, it is the point: `PoInvoiceAssignOps` refuses a PO that already
 * points at an invoice, so a PO left attached to a voided document could never be billed again. Both
 * statements in one transaction, because an invoice marked deleted with its POs still attached is
 * exactly that dead end.
 */
export async function deleteInvoice(
  caller: NeotmsCaller,
  id: string,
  ctx: WriteContext,
): Promise<ResponseData<{ id: string } | string>> {
  return runDb("delete translator invoice", async () => {
    const deletedId = await pgTransaction(async (client) => {
      const removed = (await pgExecute(InvoiceSoftDeleteOps(caller, id, ctx), client)).data;
      if (!removed) return null;
      await pgExecuteCount(PoInvoiceDetachOps(id), client);
      return removed;
    });
    return deletedId ? ok({ id: deletedId }) : notFound("translator invoice");
  });
}

/* -------------------------------------------------------------------------- */
/* The PO money actions                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Approve, or revoke approval of, the amount on one purchase order.
 *
 * Here rather than in the PO manager because it is reached through `PAYMENT`, not
 * `PURCHASE_ORDER` - and that is the whole gate. `po_approved` has no `PO_FIELDS` spec, so
 * `PATCH /purchase-orders/{id}` cannot write it; `PoApprovalOps` is the only statement that
 * assigns it, and this is the only caller.
 *
 * Idempotent on purpose. Approving an already-approved PO succeeds and re-stamps the approver,
 * because the useful answer to "approve this" is the resulting state, not a 409 about a button
 * pressed twice.
 */
export async function approvePurchaseOrder(
  caller: NeotmsCaller,
  id: string,
  input: PoApproval,
  ctx: WriteContext,
): Promise<ResponseData<PurchaseOrderRow | string>> {
  return runDb("approve purchase order", async () => {
    const row = (await pgExecute(PoApprovalOps(caller, id, input.approved, ctx))).data;
    if (!row) return notFound("purchase order");
    // Re-read for the job and project columns and the detail row, which an UPDATE's RETURNING
    // cannot reach - the same reason `updatePurchaseOrder` re-reads.
    const full = (await pgQuery(PoGetOps(caller, id))).data;
    return ok(full ?? row);
  });
}

/**
 * Record the settlement of a purchase order: its state, its money state, and the payment figures.
 *
 * ## Why this is a separate route and not just `PATCH /purchase-orders/{id}`
 *
 * It writes the same six columns that endpoint already writes - `PoSettlementSchema` is literally
 * `v.pick`ed from the PO create schema - and it reuses `PoUpdateOps`. What differs is the authority:
 * this one is gated on `PAYMENT:update`. So a PM may record that a PO is 진행 on the PO screen, and
 * deciding that the money went out is somebody else's grant. Narrowing the BODY is what makes that
 * meaningful; a route with the same gate and the full body would be the PO endpoint under another
 * name.
 *
 * ## The approval gate
 *
 * A PO that has not been approved cannot be settled. The sign-off is what authorises the money, so
 * paying without it is the exact event the gate exists to prevent - and unlike the printable
 * document, which simply does not render, this one has to be refused in words because the caller is
 * trying to record that it already happened.
 *
 * 취소 is refused for the same reason from the other end: a cancelled PO was never approved and
 * never will be, so there is nothing to settle.
 *
 * Nothing here cross-checks 완료 against `po_money_state`. It is tempting - 완료 MEANS PAID IN FULL
 * (NeotmsPoStates.ts) - and it is wrong to enforce here: section 11c of db/015_payment.sql lists the
 * legacy rows that are 완료 without 정산완료, deliberately uncorrected because whether each was
 * really paid is a question for the accounts. A rule that refuses to SAVE those rows would make them
 * uneditable, which is the migration hazard the whole free-text `po_state` decision exists to avoid.
 */
export async function settlePurchaseOrder(
  caller: NeotmsCaller,
  id: string,
  input: PoSettlement,
  ctx: WriteContext,
): Promise<ResponseData<PurchaseOrderRow | string>> {
  if (Object.keys(input).length === 0) {
    return badRequest("No editable field was supplied");
  }
  return runDb("settle purchase order", async () => {
    const current = (await pgQuery(PoGetOps(caller, id))).data;
    if (!current) return notFound("purchase order");
    if (current.poState === PO_STATE_CANCELLED) {
      return badRequest("취소된 발주는 정산할 수 없습니다.");
    }
    if (!current.poApproved) {
      return badRequest(
        "승인되지 않은 발주는 정산할 수 없습니다. 결제 화면에서 금액을 먼저 승인해 주세요.",
      );
    }

    const row = (await pgExecute(PoUpdateOps(caller, id, input, ctx))).data;
    if (!row) return notFound("purchase order");

    const full = (await pgQuery(PoGetOps(caller, id))).data;
    return ok(full ?? row);
  });
}
