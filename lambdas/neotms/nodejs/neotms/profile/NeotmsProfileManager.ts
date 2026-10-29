// SPDX-License-Identifier: MIT
//
// `/api/v0/me` - who the caller is inside NEOTMS, and what their role lets them do.
//
// This is the endpoint the UI builds its navigation and its buttons from, and it is deliberately
// NOT part of `SessionView`. Two reasons, and the second is the expensive one:
//
//   * A session is about identity; this is about authorization. They change for different reasons -
//     a role edited by an administrator should take effect without the browser signing in again.
//   * `/api/auth/refresh` runs on a timer in every open tab, all day. If it carried the permission
//     matrix it would have to read Postgres, which means taking a Supavisor connection for every
//     idle tab in the building. On the Aurora variant that traffic would also have kept the cluster
//     from ever pausing, which was the single largest saving in the project; Supabase bills flat
//     compute so that part no longer applies, but the connection budget does - see
//     NeotmsSession.dbops.ts. A refresh that reads nothing from Postgres costs nothing to scale.
//
// Nothing here is a permission check. The guard has already decided the caller may be here at all;
// this just reports what it found. The UI uses it to hide what cannot be used, and every route
// checks for itself regardless - a hidden button is a courtesy, not a control.
//
// THIS IS THE ONE ROUTE THAT RUNS WITHOUT A STAFF ROW, and the reason is a deadlock the earlier
// version of this file had. Behind the full guard, an employee with no staff row got a bare 403 from
// every endpoint including this one - so the SPA had nothing to render but "not registered, contact
// an administrator", on a system where self-registration is the way to become registered. The person
// able to fix it was shown the one screen that did not mention the fix. So this route takes the
// account-only tier (`requireLpxAccountOnly`) and does the staff lookup itself, which lets it answer
// "you are not registered yet" as a 200 the UI can act on instead of a 403 it can only display.

import { pgQuery } from "../../utils/PostgresUtils.js";
import {
  resolveRegistration,
  type LpxIdentity,
  type MenuAction,
  type NeotmsCaller,
} from "../../auth/NeotmsAuthGuard.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { ok, runDb } from "../NeotmsResult.js";
import { MenuTreeOps, type MenuNode } from "./NeotmsProfile.dbops.js";

/** One menu as the UI needs it: where it sits in the tree, and what may be done in it. */
export type MenuGrant = MenuNode & {
  /**
   * The five flags, named.
   *
   * Named rather than sent as the raw `role_1..role_5` array on purpose: the mapping from column to
   * action is UNCONFIRMED (see `MenuAction`), so if it turns out to be wrong it has to be correctable
   * in one place. A client that received the array would have baked the guess into its own code.
   */
  may: Record<MenuAction, boolean>;
};

/**
 * How far this identity has got into NEOTMS. The SPA renders a different screen for each.
 *
 *   * `unregistered` - a verified LPX account with no staff row. Gets the sign-up form, prefilled
 *     from `prefill` below.
 *   * `pending`      - a staff row exists and `role_id IS NULL`. Gets the waiting notice. There is
 *     no mail in this system, so the only thing that moves this forward is an administrator seeing
 *     the request at the top of 사용자 관리.
 *   * `active`       - a role is assigned. Gets the application.
 *
 * `inactive` is deliberately not in this list. A deactivated row is a refusal (403), not a state
 * with a screen: offering it the sign-up form would let somebody an administrator switched off mint
 * a second staff row and walk back in under a new `mgr_id`.
 */
export type RegistrationStatus = "unregistered" | "pending" | "active";

/**
 * What the sign-up form starts with, straight from LPX's `/userInfo`.
 *
 * Sent on every response, not only the unregistered one, so the form can be reached from the
 * waiting screen too - the most likely correction somebody makes while waiting is their own name.
 * Empty strings rather than nulls when `/userInfo` omitted them, because these land in text inputs
 * and `value={null}` makes a React input uncontrolled.
 */
export type ProfilePrefill = {
  name: string;
  email: string;
};

/**
 * `/api/v0/me`.
 *
 * `registration` is the discriminator, and everything below `sub` is absent when there is no staff
 * row to read it from. Optional rather than zero-valued: `staffId: ""` would be a value that looks
 * like an id and is not one, and it would flow into `created_by` comparisons on the client as a
 * silent never-match. Absent makes the consumer handle it.
 */
export type ProfileView = {
  registration: RegistrationStatus;
  prefill: ProfilePrefill;
  /** The OIDC subject. The one field that is known before registration. */
  sub: string;
  staffId?: string;
  /** Legacy `MGR_ID`. Shown because it is the identifier colleagues and old documents use. */
  mgrId?: string;
  name?: string;
  email?: string;
  corpCode?: string | null;
  roleCode?: string | null;
  roleName?: string | null;
  /**
   * Whether this person sees every row or only their own.
   *
   * Sent so the UI can say "showing your projects" rather than leaving a PM to wonder why the list
   * is short. It is reported, not obeyed: the scope is applied inside every query on the server.
   */
  seesEveryRow?: boolean;
  /**
   * Every active menu, each carrying this caller's rights on it.
   *
   * Always present, and `[]` for the two pre-approval states. An empty array is the honest answer
   * there - no role, therefore no grants - and keeping the field present means the client's
   * permission helpers need no special case to fail closed.
   */
  menus: MenuGrant[];
};

const NO_RIGHTS: Record<MenuAction, boolean> = {
  read: false,
  create: false,
  update: false,
  delete: false,
  export: false,
};

/**
 * The whole menu tree, each entry carrying this caller's rights on it.
 *
 * Menus the role holds no rights on are returned with every flag false rather than omitted. The UI
 * needs the full tree to render a disabled entry and to keep the navigation order stable, and a menu
 * silently missing from this response is indistinguishable from a menu that was deleted.
 */
async function grantsFor(caller: NeotmsCaller): Promise<MenuGrant[]> {
  const menus = (await pgQuery(MenuTreeOps())).data;
  return menus.map((menu) => {
    const flags = caller.permissions.get(menu.menuId);
    return {
      ...menu,
      may: flags
        ? {
            read: flags[0],
            create: flags[1],
            update: flags[2],
            delete: flags[3],
            export: flags[4],
          }
        : NO_RIGHTS,
    };
  });
}

/**
 * The caller's registration state, and - once approved - their profile and permission matrix.
 *
 * Takes an `LpxIdentity` rather than a `NeotmsCaller` because there may not be a caller yet; see the
 * file header. The staff lookup it does is the same one the full guard does, through the same
 * function and the same cache, so an answer here and a refusal on the next request cannot disagree.
 *
 * The menu tree is read only for an approved caller. Not an optimisation worth much on its own - it
 * is 48 small rows - but it is the difference between an unapproved employee's open browser tab
 * costing a Supavisor connection per poll and costing none, and the whole company is unapproved on
 * the first morning.
 */
export async function getProfile(
  identity: LpxIdentity,
): Promise<ResponseData<ProfileView | string>> {
  return runDb("read profile", async () => {
    const state = await resolveRegistration(identity);
    const prefill: ProfilePrefill = {
      name: identity.account.name.trim(),
      email: identity.account.email.trim(),
    };

    if (state.kind === "inactive") {
      /*
       * A 403 and not a described state, which is why it is handled before the `ok` cases.
       *
       * Worth saying what happened, though - unlike "not registered", a deactivated account is a
       * decision somebody made, and the person affected can usefully be told that rather than left
       * to conclude the system is broken. Nothing here says who deactivated it or when.
       */
      return {
        status: 403,
        body: "This account has been deactivated in NEOTMS. Please contact an administrator.",
      } satisfies ResponseData<string>;
    }

    if (state.kind === "unregistered") {
      return ok<ProfileView>({
        registration: "unregistered",
        prefill,
        sub: identity.sub,
        menus: [],
      });
    }

    const caller = state.caller;
    const approved = caller.roleId !== null;
    return ok<ProfileView>({
      registration: approved ? "active" : "pending",
      prefill,
      sub: caller.sub,
      staffId: caller.staffId,
      mgrId: caller.mgrId,
      name: caller.name,
      email: caller.email,
      corpCode: caller.corpCode,
      roleCode: caller.roleCode,
      roleName: caller.roleName,
      seesEveryRow: caller.seesEveryRow,
      menus: approved ? await grantsFor(caller) : [],
    });
  });
}
