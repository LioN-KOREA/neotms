// SPDX-License-Identifier: MIT
//
// 대시보드 endpoint.
//
// Two routes, `GET /api/v0/dashboard/sales` and `GET /api/v0/dashboard/pm`, for the same aggregate
// over two different definitions of "mine" - see NeotmsDashboard.dbops.ts.
//
// ## Why the role is in the path and not a query parameter
//
// It was `GET /api/v0/dashboard?as=sales|pm` first, and the role moved into the path when the two
// screens got a menu id each (NeotmsMenus.ts). That is not cosmetic: **the route table is the only
// place this API declares authorization**, and it declares it per path. A gate that had to depend on
// `?as=` would have to live inside this manager instead, where no audit of the route table can see
// it - and a route whose permission check is somewhere else is the thing NeotmsMenus.ts's header
// warns about.
//
// Two consequences worth naming, both improvements:
//
//   * **The 400 branch is gone.** The role no longer arrives as text to be validated against
//     `DASHBOARD_ROLES`; each handler passes a literal, so `OWNER_COLUMN[role]` is reached only with
//     a value the type checker proved. A closed list validated at runtime was the second-best way to
//     make a value-that-becomes-a-column-name safe; not accepting the value at all is the first.
//   * **The role cannot be forged into the other book.** Previously a caller past the PROJECT gate
//     could flip `?as=`. Now asking for the other dashboard means asking for a path whose menu they
//     may not hold.
//
// Row-level scope is still applied inside the query, as everywhere: the menu check decides whether
// the request may run, the ownership filter and `scopeClause` decide which rows it touches. The menu
// gate is emphatically not a substitute for that - a 영업 grant does not mean "see every project's
// sales figures", it means "see the 영업 view of your own".

import { pgQuery } from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { ok, runDb } from "../NeotmsResult.js";
import {
  DashboardSummaryOps,
  type DashboardRole,
  type DashboardSummary,
} from "./NeotmsDashboard.dbops.js";

/**
 * Read the dashboard for one of the two roles.
 *
 * `role` comes from the caller's route, not from the request, so there is no default to guess at and
 * no ambiguity to resolve. That matters because the two answers are different numbers under the same
 * heading: a person who is 영업담당자 on some projects and PM on others would read whichever set a
 * default happened to pick and have no way to tell which it was.
 */
export async function getDashboard(
  caller: NeotmsCaller,
  role: DashboardRole,
): Promise<ResponseData<DashboardSummary | string>> {
  return runDb("dashboard summary", async () => {
    const summary = (await pgQuery(DashboardSummaryOps(caller, role))).data;
    return ok(summary);
  });
}
