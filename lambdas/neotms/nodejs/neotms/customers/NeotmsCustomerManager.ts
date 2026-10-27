// SPDX-License-Identifier: MIT
//
// Customer endpoints.
//
// The manager layer is where a request becomes a decision: it reads the list parameters, runs the
// statements the dbops module built, and chooses the status. It holds no SQL and no AWS types, so
// the interesting cases - a delete refused because projects still reference the customer, an empty
// PATCH - are testable without a database.

import {
  paginate,
  rdsExecute,
  rdsQuery,
  type SqlRow,
} from "../../utils/RdsDataUtils.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { readListQuery, sortAlias } from "../NeotmsQuery.js";
import { created, notFound, ok, runDb, type ListPage } from "../NeotmsResult.js";
import type { WriteContext } from "../NeotmsWrite.js";
import type { CustomerCreate, CustomerUpdate } from "../neotms.schemas.js";
import {
  CUSTOMER_SORTS,
  CustomerCreateOps,
  CustomerGetOps,
  CustomerLiveProjectCountOps,
  CustomerListOps,
  CustomerSoftDeleteOps,
  CustomerUpdateOps,
  toCustomerRow,
  type CustomerRow,
} from "./NeotmsCustomer.dbops.js";
import type { RequestData } from "../../reqres/RequestResponse.js";

export async function listCustomers(
  request: RequestData,
): Promise<ResponseData<ListPage<CustomerRow> | string>> {
  const query = readListQuery(request, CUSTOMER_SORTS, "created");
  return runDb("list customers", async () => {
    const rows: SqlRow[] = (await rdsQuery(CustomerListOps(query))).data;
    /*
     * The cursor is built from the ALIAS of the sort column, not the qualified name: the row
     * arrived keyed by alias. `sortAlias` derives one from the other so the allow-list stays the
     * single source of truth. If they ever disagree the cursor silently stops advancing - the next
     * page repeats the same rows and nothing errors - which is why this is derived rather than
     * written out here.
     */
    const page = paginate(rows, query.limit, sortAlias(query.sort.column), "customer_id", toCustomerRow);
    return ok(page);
  });
}

export async function getCustomer(id: string): Promise<ResponseData<CustomerRow | string>> {
  return runDb("get customer", async () => {
    const row = (await rdsQuery(CustomerGetOps(id))).data;
    return row ? ok(row) : notFound("customer");
  });
}

export async function createCustomer(
  input: CustomerCreate,
  ctx: WriteContext,
): Promise<ResponseData<CustomerRow | string>> {
  return runDb("create customer", async () => {
    const row = (await rdsExecute(CustomerCreateOps(input, ctx))).data;
    // Unreachable in practice: an INSERT that violated a constraint would have thrown, and
    // RETURNING always produces the inserted row. Reported as a 500 rather than coerced into a
    // success, because "created something and cannot say what" is not a 201.
    return row ? created(row) : { status: 500, body: "The customer was not created" };
  });
}

/**
 * Edit a customer.
 *
 * A body that mentions no writable field is a 400, not a no-op 200. It means the client sent
 * something this API does not understand - a misspelled field name, or a version mismatch - and
 * answering 200 would let that go unnoticed until someone asks why their edits are not saving.
 */
export async function updateCustomer(
  id: string,
  input: CustomerUpdate,
  ctx: WriteContext,
): Promise<ResponseData<CustomerRow | string>> {
  if (Object.keys(input).length === 0) {
    return { status: 400, body: "No editable field was supplied" };
  }
  return runDb("update customer", async () => {
    const row = (await rdsExecute(CustomerUpdateOps(id, input, ctx))).data;
    return row ? ok(row) : notFound("customer");
  });
}

/**
 * Soft-delete a customer, unless live projects still reference it.
 *
 * The check is a courtesy, not a safety mechanism - the safety is `ON DELETE RESTRICT` on every
 * foreign key, and the delete here is a soft one anyway. What the check buys is a message somebody
 * can act on: "3 live projects still reference this customer" tells a user what to do next, where a
 * constraint violation surfaced as a 409 does not.
 *
 * It is deliberately NOT done in a transaction with the update. A project created in the instant
 * between the two statements would be left pointing at a deleted customer, which is untidy and
 * harmless: the project keeps working, the customer simply stops appearing in pickers, and
 * un-deleting is a one-column change. Serialising every customer delete against every project
 * create to prevent that would be a far worse trade.
 */
export async function deleteCustomer(
  id: string,
  ctx: WriteContext,
): Promise<ResponseData<{ id: string } | string>> {
  return runDb("delete customer", async () => {
    const liveProjects = (await rdsQuery(CustomerLiveProjectCountOps(id))).data;
    if (liveProjects > 0) {
      return {
        status: 409,
        body: `This customer still has ${liveProjects} live project(s). Close or reassign them first.`,
      };
    }
    const deletedId = (await rdsExecute(CustomerSoftDeleteOps(id, ctx))).data;
    return deletedId ? ok({ id: deletedId }) : notFound("customer");
  });
}
