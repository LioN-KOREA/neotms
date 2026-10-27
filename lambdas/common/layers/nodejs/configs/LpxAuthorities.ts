// SPDX-License-Identifier: MIT
//
// The registry of SYSTEM authorities — the ones LPX's own code has to name.
//
// Why these have fixed ids while tenant authorities keep UUIDs:
//
// An authority id only needs to be stable if *source code* compares against it. That is true
// only for LPX's own authorities, and those are precisely the ones no user should ever be able
// to define. Tenant authorities created through /lpx/admin/authority/create keep their
// server-generated UUID, because nothing in LPX hardcodes one — only data (the
// LKROLE#<roleId> / AUTHORITY#<authorityId> links) refers to them.
//
// This costs no new input surface: LKAuthorityCreationRequestSchema has no id field and
// createAuthority mints the UUID itself, so a caller cannot supply an authority id at all.
// The only thing users type is lkAuthorityName / lkAuthorityDesc, which are display strings —
// Korean text, punctuation and anything else is fine there because they are never identifiers.
//
// Replaces the previous arrangement, where every system authority needed its random UUID
// threaded through the provisioner → SSM → CustomResource Fn::GetAtt → Lambda env → LpxEnv
// before a handler could compare against it. Authority #8 would have meant eight of those.
//
// This file lives in `common` because both lpxauth (LPXAdminAPIHandlers) and lpxlogger
// (lpxLogApis) need it, and lpxlogger does not import from lpxauth.

/**
 * Reserved id prefix. Nothing created through the admin API may use it; see
 * assertAuthorityIdIsAssignable. A v4 UUID cannot collide with it (hex + dashes only), so the
 * guard exists to catch a future change to the id generator, not present-day input.
 */
export const LPX_SYSTEM_AUTHORITY_PREFIX = "lpx.";

/**
 * Full access to /lpx/admin/* and the log administration APIs.
 * Held by the Admin role the provisioner seeds on the first deploy.
 */
export const LPX_AUTHORITY_ADMIN_ACCESS = "lpx.admin.access";

/**
 * Access limited to the app-client endpoints. Provisioned but not granted to any role by
 * default — it exists so a role can be scoped to app-client management alone.
 */
export const LPX_AUTHORITY_ADMIN_APPCLIENT = "lpx.admin.appclient";

export interface LpxSystemAuthority {
    /** The stable id. Compare against these constants directly in handlers. */
    id: string;
    /** Display name shown in the admin console. */
    name: string;
    description: string;
    /**
     * Whether the provisioner grants this authority to the seeded Admin role.
     * False means "available to assign, but not granted out of the box".
     */
    grantToAdminRole: boolean;
}

export const LPX_SYSTEM_AUTHORITIES: ReadonlyArray<LpxSystemAuthority> = [
    {
        id: LPX_AUTHORITY_ADMIN_ACCESS,
        name: "Global Admin",
        description: "Full access to the LPX administration APIs (/lpx/admin/*) and log administration.",
        grantToAdminRole: true,
    },
    {
        id: LPX_AUTHORITY_ADMIN_APPCLIENT,
        name: "App Client Admin",
        description: "Access limited to the app-client management endpoints.",
        grantToAdminRole: false,
    },
] as const;

const SYSTEM_AUTHORITY_IDS: ReadonlySet<string> = new Set(LPX_SYSTEM_AUTHORITIES.map(a => a.id));

/** True if the id belongs to the code-owned registry above. */
export function isSystemAuthorityId(lkAuthorityId: string): boolean {
    return SYSTEM_AUTHORITY_IDS.has(lkAuthorityId);
}

/** True if the id sits in the reserved namespace, whether or not it is a known system authority. */
export function isReservedAuthorityId(lkAuthorityId: string): boolean {
    return lkAuthorityId.startsWith(LPX_SYSTEM_AUTHORITY_PREFIX);
}
