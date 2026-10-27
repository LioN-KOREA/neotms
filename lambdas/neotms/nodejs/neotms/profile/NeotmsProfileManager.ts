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
//     matrix it would have to read Aurora, which means the cluster is woken by tabs nobody is
//     looking at - and the ACU schedule (the single largest saving in this project) only works if an
//     idle browser makes no database traffic.
//
// Nothing here is a permission check. The guard has already decided the caller may be here at all;
// this just reports what it found. The UI uses it to hide what cannot be used, and every route
// checks for itself regardless - a hidden button is a courtesy, not a control.

import { rdsQuery } from "../../utils/RdsDataUtils.js";
import type { MenuAction, NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
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

export type ProfileView = {
  staffId: string;
  /** Legacy `MGR_ID`. Shown because it is the identifier colleagues and old documents use. */
  mgrId: string;
  sub: string;
  name: string;
  email: string;
  corpCode: string | null;
  roleCode: string | null;
  roleName: string | null;
  /**
   * Whether this person sees every row or only their own.
   *
   * Sent so the UI can say "showing your projects" rather than leaving a PM to wonder why the list
   * is short. It is reported, not obeyed: the scope is applied inside every query on the server.
   */
  seesEveryRow: boolean;
  /** Every active menu, each carrying this caller's rights on it. */
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
 * The caller's profile and permission matrix.
 *
 * Menus the role holds no rights on are returned with every flag false rather than omitted. The UI
 * needs the full tree to render a disabled entry and to keep the navigation order stable, and a menu
 * silently missing from this response is indistinguishable from a menu that was deleted.
 */
export async function getProfile(caller: NeotmsCaller): Promise<ResponseData<ProfileView | string>> {
  return runDb("read profile", async () => {
    const menus = (await rdsQuery(MenuTreeOps())).data;
    const grants: MenuGrant[] = menus.map((menu) => {
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
    return ok({
      staffId: caller.staffId,
      mgrId: caller.mgrId,
      sub: caller.sub,
      name: caller.name,
      email: caller.email,
      corpCode: caller.corpCode,
      roleCode: caller.roleCode,
      roleName: caller.roleName,
      seesEveryRow: caller.seesEveryRow,
      menus: grants,
    });
  });
}
