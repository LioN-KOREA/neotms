// SPDX-License-Identifier: MIT
//
// Cognito error taxonomy + call wrapper.
//
// Why this exists: the JS SDK v3 types a caught error as `unknown`, so every call site used to
// collapse every distinct failure into one generic message. The SDK *does* ship ~60 typed
// exception classes, but we deliberately discriminate on `err.name` rather than `instanceof`:
// this code runs from Lambda layers AND from esbuild bundles, so two copies of
// @aws-sdk/client-cognito-identity-provider can be loaded at once. When that happens there are
// two distinct `NotAuthorizedException` classes and `instanceof` is silently always false.
// `err.name` is a plain string off the wire and is what the SDK itself dispatches on.
//
// Layer boundary: `common` must not depend on `lpxauth`, so nothing here touches the SQS log
// queue. CloudWatch gets the technical detail via console.*, and the structured
// `CognitoErrorInfo` is returned so the domain managers can enqueue their own business-level
// log line at the severity this module recommends.

import { CognitoIdentityProviderServiceException } from "@aws-sdk/client-cognito-identity-provider";

/**
 * Stable internal error vocabulary. Decoupled from Cognito's exception names on purpose — an
 * SDK upgrade that renames an exception should touch only the mapper below, not the callers.
 */
export type LPXCognitoErrorCode =
    // --- authentication ---
    | "BAD_CREDENTIALS"
    | "USER_NOT_FOUND"
    | "USER_DISABLED"
    | "USER_NOT_CONFIRMED"
    | "PASSWORD_RESET_REQUIRED"
    | "CHALLENGE_REQUIRED"
    | "TOKEN_REVOKED"
    | "REFRESH_TOKEN_REUSED"
    | "TOKEN_NOT_REVOCABLE"
    // --- account administration ---
    | "EMAIL_ALREADY_EXISTS"
    | "PASSWORD_POLICY"
    | "PASSWORD_REUSED"
    | "USER_STATE_CONFLICT"
    | "CODE_DELIVERY_FAILED"
    // --- roles / groups / app clients ---
    | "GROUP_EXISTS"
    | "RESOURCE_NOT_FOUND"
    // --- our own fault ---
    | "AUTH_FLOW_DISABLED"
    | "MISCONFIGURED"
    | "PERMISSION_DENIED"
    | "LAMBDA_TRIGGER_FAILED"
    | "FEATURE_NOT_IN_TIER"
    // --- transient / capacity ---
    | "THROTTLED"
    | "QUOTA_EXCEEDED"
    | "CONFLICT_RETRYABLE"
    // --- catch-all ---
    | "BAD_REQUEST"
    | "UPSTREAM_ERROR";

/** Severity levels match lpxWriteLogToQueue: 1=ALERT, 2=CRIT, 3=ERROR, 4=WARN. */
export type LPXLogSeverity = 1 | 2 | 3 | 4;

export interface LPXCognitoErrorInfo {
    code: LPXCognitoErrorCode;
    /** HTTP status this failure should surface as. */
    status: number;
    /** Safe to return to the API caller. Never contains Cognito internals. */
    publicMessage: string;
    /** Recommended log severity — domain managers may raise it with business context. */
    severity: LPXLogSeverity;
    /** True only for failures where a *later* retry could plausibly succeed. */
    retryable: boolean;
    /** Cognito exception name, e.g. "NotAuthorizedException". "" if not a service exception. */
    exceptionName: string;
    /** Full technical detail. For logs only — do not put this in a response body. */
    internalMessage: string;
    /** AWS request id, for CloudTrail correlation / support cases. */
    requestId?: string;
    /** Attempts the SDK's own retry strategy already burned before giving up. */
    attempts?: number;
}

/**
 * Name-based type guard. `CognitoIdentityProviderServiceException.isInstance` is itself
 * name/shape-based rather than prototype-based, so it survives the duplicate-module case
 * described at the top of this file.
 */
export function asCognitoException(err: unknown): CognitoIdentityProviderServiceException | null {
    return CognitoIdentityProviderServiceException.isInstance(err) ? err : null;
}

interface LPXCognitoErrorRule {
    code: LPXCognitoErrorCode;
    status: number;
    publicMessage: string;
    severity: LPXLogSeverity;
    retryable?: boolean;
}

/**
 * Default mapping by exception name.
 *
 * Note the deliberate asymmetry on the login path: USER_NOT_FOUND and BAD_CREDENTIALS carry
 * distinct codes (so logs can tell them apart) but the *same* publicMessage. Returning
 * different messages would turn /lpx/auth/login into a user-enumeration oracle.
 */
const BY_NAME: Record<string, LPXCognitoErrorRule> = {
    // --- authentication ---
    UserNotFoundException:          { code: "USER_NOT_FOUND",          status: 401, publicMessage: "Invalid credentials",        severity: 4 },
    UserNotConfirmedException:      { code: "USER_NOT_CONFIRMED",      status: 409, publicMessage: "Account not confirmed",      severity: 4 },
    PasswordResetRequiredException: { code: "PASSWORD_RESET_REQUIRED", status: 409, publicMessage: "Password reset required",    severity: 4 },
    RefreshTokenReuseException:     { code: "REFRESH_TOKEN_REUSED",    status: 403, publicMessage: "Session invalid",            severity: 2 },
    UnsupportedTokenTypeException:  { code: "TOKEN_NOT_REVOCABLE",     status: 500, publicMessage: "Internal error",             severity: 3 },

    // --- account administration ---
    UsernameExistsException:                  { code: "EMAIL_ALREADY_EXISTS",  status: 409, publicMessage: "Email already registered",  severity: 4 },
    AliasExistsException:                     { code: "EMAIL_ALREADY_EXISTS",  status: 409, publicMessage: "Email already registered",  severity: 4 },
    InvalidPasswordException:                 { code: "PASSWORD_POLICY",       status: 400, publicMessage: "Password does not meet the password policy", severity: 4 },
    PasswordHistoryPolicyViolationException:  { code: "PASSWORD_REUSED",       status: 400, publicMessage: "Password was used recently", severity: 4 },
    UnsupportedUserStateException:            { code: "USER_STATE_CONFLICT",   status: 409, publicMessage: "Account is in a state that does not allow this operation", severity: 4 },
    CodeDeliveryFailureException:             { code: "CODE_DELIVERY_FAILED",  status: 502, publicMessage: "Could not deliver the verification message", severity: 3 },

    // --- roles / groups ---
    GroupExistsException: { code: "GROUP_EXISTS", status: 409, publicMessage: "Role already exists", severity: 4 },

    // --- our own misconfiguration: never leak detail, always alarm ---
    InvalidOAuthFlowException:             { code: "MISCONFIGURED",         status: 500, publicMessage: "Internal error", severity: 3 },
    ScopeDoesNotExistException:            { code: "MISCONFIGURED",         status: 500, publicMessage: "Internal error", severity: 3 },
    InvalidUserPoolConfigurationException: { code: "MISCONFIGURED",         status: 500, publicMessage: "Internal error", severity: 2 },
    InvalidEmailRoleAccessPolicyException: { code: "MISCONFIGURED",         status: 500, publicMessage: "Internal error", severity: 2 },
    FeatureUnavailableInTierException:     { code: "FEATURE_NOT_IN_TIER",   status: 500, publicMessage: "Internal error", severity: 2 },
    InvalidLambdaResponseException:        { code: "LAMBDA_TRIGGER_FAILED", status: 500, publicMessage: "Internal error", severity: 2 },
    UnexpectedLambdaException:             { code: "LAMBDA_TRIGGER_FAILED", status: 500, publicMessage: "Internal error", severity: 2 },
    UserLambdaValidationException:         { code: "LAMBDA_TRIGGER_FAILED", status: 400, publicMessage: "Request rejected by a validation rule", severity: 4 },
    AccessDeniedException:                 { code: "PERMISSION_DENIED",     status: 500, publicMessage: "Internal error", severity: 2 },
    ForbiddenException:                    { code: "PERMISSION_DENIED",     status: 500, publicMessage: "Internal error", severity: 2 },
    UnauthorizedException:                 { code: "PERMISSION_DENIED",     status: 500, publicMessage: "Internal error", severity: 2 },

    // --- transient / capacity. The SDK already exhausted its own retries before we see these. ---
    TooManyRequestsException:       { code: "THROTTLED",          status: 429, publicMessage: "Too many requests",     severity: 3, retryable: true },
    TooManyFailedAttemptsException: { code: "THROTTLED",          status: 429, publicMessage: "Too many attempts",     severity: 4, retryable: true },
    LimitExceededException:         { code: "QUOTA_EXCEEDED",     status: 503, publicMessage: "Service limit reached", severity: 2, retryable: true },
    ServiceQuotaExceededException:  { code: "QUOTA_EXCEEDED",     status: 503, publicMessage: "Service limit reached", severity: 2, retryable: true },
    ConcurrentModificationException:{ code: "CONFLICT_RETRYABLE", status: 409, publicMessage: "Conflicting concurrent change", severity: 3, retryable: true },
    InternalErrorException:         { code: "UPSTREAM_ERROR",     status: 502, publicMessage: "Internal error",        severity: 3, retryable: true },
    InternalServerException:        { code: "UPSTREAM_ERROR",     status: 502, publicMessage: "Internal error",        severity: 3, retryable: true },
};

/**
 * Three exceptions are genuinely ambiguous and only the calling operation can disambiguate
 * them, so they are resolved here instead of in the table above.
 */
function resolveAmbiguous(name: string, message: string, op: string): LPXCognitoErrorRule | null {
    switch (name) {
        case "NotAuthorizedException": {
            // Cognito overloads this one heavily. The message is the only discriminator it
            // gives us, so match defensively and fall through to the safe default.
            if (/disabled/i.test(message)) {
                return { code: "USER_DISABLED", status: 403, publicMessage: "Account disabled", severity: 4 };
            }
            if (/revoked/i.test(message)) {
                return { code: "TOKEN_REVOKED", status: 401, publicMessage: "Session expired", severity: 4 };
            }
            if (/client is not enabled|not enabled for admin/i.test(message)) {
                // Our own config problem masquerading as an auth failure — exactly the class of
                // bug that hid behind the old generic 401.
                return { code: "AUTH_FLOW_DISABLED", status: 500, publicMessage: "Internal error", severity: 2 };
            }
            return { code: "BAD_CREDENTIALS", status: 401, publicMessage: "Invalid credentials", severity: 4 };
        }
        case "ResourceNotFoundException": {
            // On an auth call this means a bad user-pool/client id — i.e. we are misconfigured.
            // On a group call it means the caller named a group that does not exist.
            if (op.startsWith("AdminInitiateAuth") || op.startsWith("GetTokensFromRefreshToken") || op.startsWith("RevokeToken")) {
                return { code: "MISCONFIGURED", status: 500, publicMessage: "Internal error", severity: 2 };
            }
            return { code: "RESOURCE_NOT_FOUND", status: 404, publicMessage: "The referenced resource does not exist", severity: 4 };
        }
        case "InvalidParameterException": {
            // The specific case that produced the original "invalid credentials" mystery:
            // ADMIN_USER_PASSWORD_AUTH not present in the client's ExplicitAuthFlows.
            if (/auth flow/i.test(message)) {
                return { code: "AUTH_FLOW_DISABLED", status: 500, publicMessage: "Internal error", severity: 2 };
            }
            return { code: "BAD_REQUEST", status: 400, publicMessage: "Invalid request", severity: 4 };
        }
        default:
            return null;
    }
}

/**
 * Translate any thrown value into a classified, loggable, safely-returnable error.
 *
 * @param op  the Cognito operation, e.g. "AdminInitiateAuth" — used to disambiguate and to tag logs
 * @param ctx non-secret context for the log line, e.g. `email=a@b.com` or `clientId=xxx`
 */
export function exceptionToLPXCognitoError(err: unknown, op: string, ctx = ""): LPXCognitoErrorInfo {
    const e = asCognitoException(err);
    if (!e) {
        // Not a service exception at all: a network/DNS failure, an SDK bug, a TypeError in our
        // own response handling, or a non-Error throw. Never a client's fault.
        const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        return {
            code: "UPSTREAM_ERROR",
            status: 500,
            publicMessage: "Internal error",
            severity: 3,
            retryable: false,
            exceptionName: "",
            internalMessage: `[${op}] ${ctx} non-service error → ${detail}`,
        };
    }

    const name = e.name;
    const message = e.message ?? "";
    const rule =
        resolveAmbiguous(name, message, op) ??
        BY_NAME[name] ??
        // Unknown exception: trust the SDK's own fault attribution rather than guessing.
        ({
            code: "UPSTREAM_ERROR",
            status: e.$fault === "client" ? 400 : 502,
            publicMessage: e.$fault === "client" ? "Invalid request" : "Internal error",
            severity: e.$fault === "client" ? 4 : 3,
        } satisfies LPXCognitoErrorRule);

    return {
        code: rule.code,
        status: rule.status,
        publicMessage: rule.publicMessage,
        severity: rule.severity,
        retryable: rule.retryable ?? e.$retryable != null,
        exceptionName: name,
        internalMessage: `[${op}] ${ctx} → ${rule.code} | ${name}: ${message}`,
        requestId: e.$metadata?.requestId,
        attempts: e.$metadata?.attempts,
    };
}

export type CognitoOutcome<T> =
    | { ok: true; value: T }
    | { ok: false; error: LPXCognitoErrorInfo };

/**
 * Run one Cognito command with classification and logging applied once, centrally.
 *
 * `send()` throws on every non-2xx response — it never returns one — so this try/catch is the
 * only place a Cognito failure can be observed. Checking `$metadata.httpStatusCode !== 200`
 * on a resolved response is dead code.
 */
export async function cognitoCall<T>(op: string, ctx: string, fn: () => Promise<T>): Promise<CognitoOutcome<T>> {
    try {
        return { ok: true, value: await fn() };
    } catch (err) {
        const error = exceptionToLPXCognitoError(err, op, ctx);
        const line = `${error.internalMessage} | requestId=${error.requestId ?? "(none)"} attempts=${error.attempts ?? "(unknown)"}`;
        if (error.severity <= 2) console.error(line);
        else if (error.severity === 3) console.error(line);
        else console.warn(line);
        // The SDK retries throttling internally; reaching us means those retries were exhausted.
        if (error.code === "THROTTLED" || error.code === "QUOTA_EXCEEDED") {
            console.warn(`[${op}] Cognito retries exhausted after ${error.attempts ?? "?"} attempts. Consider raising maxAttempts on the client.`);
        }
        return { ok: false, error };
    }
}
