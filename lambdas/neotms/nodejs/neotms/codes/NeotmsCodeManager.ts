// SPDX-License-Identifier: MIT
//
// Code-table endpoints: the dropdown feed, and the 유지보수 screen behind it.
//
// Two audiences with very different rights, which is why there are two listings:
//
//   * `GET /api/v0/codes` is `anyStaff`. Every form in the application needs 분야, 작업 종류, 단가
//     단위 and 언어 to render, so refusing this to a signed-in user with no 유지보수 right would
//     mean their customer form has empty dropdowns. Reading a list of category names is not a
//     privilege worth gating.
//   * `GET /api/v0/admin/codes` and the three writes are gated on MAINTENANCE. Deciding what the
//     company's 분야 taxonomy IS is a different authority from using it.
//
// ## Most of this file is error translation, and that is the point
//
// `sys_code` is a parent table with twenty-two restricting foreign keys pointing at it and a
// table-wide unique constraint on `code`. Every interesting failure is therefore a PostgreSQL
// constraint violation, and the raw messages name constraints on tables the administrator was not
// looking at:
//
//   duplicate key value violates unique constraint "sys_code_code_key"
//   update or delete on table "sys_code" violates foreign key constraint
//     "translator_tran_work_con_fkey" on table "translator"
//
// The first does not say "that code is already in a different list". The second does not say "a
// translator still uses it; deactivate it instead" - and it names only ONE of the twenty-two
// constraints, whichever was checked first, so it is not even a complete answer to "what is using
// this?". Translating them here is what makes the screen operable by somebody who did not write
// the schema.
//
// `exceptionToErrorResponse` already turns both into a 409 with a correct generic message - "That
// record already exists." and "A referenced record does not exist." - and for a customer or a job
// that is the right answer. It is not the right answer here, because both of those sentences
// describe a situation the administrator did not create and cannot act on from reading them. So
// these two states, and only these two, are caught per-endpoint; everything else is rethrown and
// gets the shared mapping.

import { pgExecute, pgQuery, sqlState } from "../../utils/PostgresUtils.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { badRequest, notFound, ok, runDb } from "../NeotmsResult.js";
import type { CodeCreate, CodeUpdate } from "../neotms.schemas.js";
import {
  CodeAllIncludingInactiveOps,
  CodeAllOps,
  CodeChildCountOps,
  CodeCreateOps,
  CodeDeleteOps,
  CodeGetOps,
  CodeUpdateOps,
  type CodeRow,
} from "./NeotmsCode.dbops.js";

/**
 * The response shape. A flat list plus the domain rows it contains, not a nested tree.
 *
 * Flat because `sys_code` is one level deep in practice and the client groups by `codeParent`
 * anyway; a nested shape would have to decide what to do with an orphan (a code whose parent the
 * ETL did not load), and the honest answer - show it, in a group of its own, so somebody notices -
 * is easier to express over a flat list than over a tree that has nowhere to put it.
 */
export type CodeListView = { items: CodeRow[] };

/** `sys_code.code` is UNIQUE table-wide. */
const UNIQUE_VIOLATION = "23505";
/** One of twenty-two `ON DELETE RESTRICT` constraints, or the self-referencing parent constraint. */
const FOREIGN_KEY_VIOLATION = "23503";

/** Every active code, for the dropdowns. */
export async function listCodes(): Promise<ResponseData<CodeListView | string>> {
  return runDb("list codes", async () => {
    const items = (await pgQuery(CodeAllOps())).data;
    return ok({ items });
  });
}

/** Every code including the retired ones, for 유지보수. */
export async function listCodesForAdmin(): Promise<ResponseData<CodeListView | string>> {
  return runDb("list codes for maintenance", async () => {
    const items = (await pgQuery(CodeAllIncludingInactiveOps())).data;
    return ok({ items });
  });
}

/**
 * Add a code.
 *
 * The two refusals are caught rather than allowed to surface as a 500, and they say different
 * things:
 *
 *   * 23505 - the code exists somewhere in the table, possibly in another domain. This is the
 *     table-wide unique constraint doing its job, and the message has to explain that the namespace
 *     is shared, because nothing on the screen suggests it would be.
 *   * 23503 - `code_parent` names a domain that does not exist. Only reachable by hand-crafting a
 *     request (the screen picks the parent from the list it was just given), which is precisely why
 *     it must not be a 500: a 500 would send somebody reading function logs for what is a typo in a
 *     field.
 */
export async function createCode(input: CodeCreate): Promise<ResponseData<CodeRow | string>> {
  return runDb("create code", async () => {
    try {
      const row = (await pgExecute(CodeCreateOps(input))).data;
      return row
        ? ok(row, 201)
        : { status: 500 as const, body: "The code was not created" };
    } catch (err) {
      const code = sqlState(err);
      if (code === UNIQUE_VIOLATION) {
        return {
          status: 409 as const,
          body:
            `The code '${input.code}' already exists. Codes are unique across every domain, not ` +
            `within one, so it may be registered under a different list - search for it before ` +
            `adding it again.`,
        };
      }
      if (code === FOREIGN_KEY_VIOLATION) {
        return badRequest(
          `There is no code '${String(input.codeParent)}' to use as the domain. Create the domain ` +
            `row first, or pick an existing one.`,
        );
      }
      throw err;
    }
  });
}

/**
 * Edit a code's labels, domain, order or active flag.
 *
 * An empty body is a 400 rather than a no-op 200, matching every other PATCH in this API: it means
 * the client sent a field this endpoint does not know about - a misspelling, or a frontend built
 * against a different version - and a cheerful 200 would let that go unnoticed until somebody asks
 * why their edits are not saving. `code` itself lands in that category by design, so a request
 * trying to rename a code gets this message rather than silently renaming nothing.
 */
export async function updateCode(
  id: string,
  input: CodeUpdate,
): Promise<ResponseData<CodeRow | string>> {
  if (Object.keys(input).length === 0) {
    return badRequest(
      "No editable field was supplied. A code's `code` value cannot be changed - 22 foreign keys " +
        "reference it - so retire it and add the replacement instead.",
    );
  }
  return runDb("update code", async () => {
    try {
      const row = (await pgExecute(CodeUpdateOps(id, input))).data;
      return row ? ok(row) : notFound("code");
    } catch (err) {
      if (sqlState(err) === FOREIGN_KEY_VIOLATION) {
        return badRequest(
          `There is no code '${String(input.codeParent)}' to use as the domain. Pick an existing one.`,
        );
      }
      throw err;
    }
  });
}

/**
 * Delete a code, if nothing references it.
 *
 * Reads the row first, for the error messages: the 23503 that comes back from the DELETE names a
 * constraint, and turning that into a sentence a person can act on needs the code's own value,
 * which the id alone does not supply.
 *
 * The child check is separate from the reference check because the two have different remedies.
 * Deleting a DOMAIN row that still has children is refused by `sys_code_code_parent_fkey`, and the
 * fix is to move or delete the children - nothing outside this screen is involved. Deleting a code
 * that a job or a translator references is refused by one of twenty-two business-table
 * constraints, and the fix is almost always not to delete it at all.
 *
 * Which is the message this endpoint leads with. `active = false` retires a code properly: it
 * disappears from every dropdown while the rows already referencing it keep resolving. Deletion
 * cannot do that, and an administrator who deletes 분야 codes to "clean up" will find the only
 * thing standing between them and a broken customer list is the constraint that refused them.
 */
export async function deleteCode(id: string): Promise<ResponseData<{ id: string } | string>> {
  return runDb("delete code", async () => {
    const existing = (await pgQuery(CodeGetOps(id))).data;
    if (!existing) return notFound("code");

    const children = (await pgQuery(CodeChildCountOps(existing.code))).data;
    if (children > 0) {
      return {
        status: 409,
        body:
          `'${existing.code}' is a domain with ${children} code(s) in it. Move or remove those ` +
          `first, or set it inactive to hide the whole list.`,
      };
    }

    try {
      const deletedId = (await pgExecute(CodeDeleteOps(id))).data;
      return deletedId ? ok({ id: deletedId }) : notFound("code");
    } catch (err) {
      if (sqlState(err) === FOREIGN_KEY_VIOLATION) {
        return {
          status: 409,
          body:
            `'${existing.code}' is still in use by existing records, so it cannot be deleted - ` +
            `that would leave those records pointing at a code that no longer exists. Set it ` +
            `inactive instead: it will stop appearing in dropdowns, and the records that already ` +
            `use it will keep working.`,
        };
      }
      throw err;
    }
  });
}
