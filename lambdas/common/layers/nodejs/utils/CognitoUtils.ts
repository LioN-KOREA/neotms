import { AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminDeleteUserCommand, AdminDisableUserCommand, AdminEnableUserCommand, AdminGetUserCommand, AdminInitiateAuthCommand, AdminListGroupsForUserCommand, AdminRemoveUserFromGroupCommand, AdminSetUserPasswordCommand, AdminUserGlobalSignOutCommand, AuthFlowType, CognitoIdentityProviderClient, CreateGroupCommand, CreateUserPoolClientCommand, DeleteGroupCommand, DeleteUserPoolClientCommand, DescribeUserPoolClientCommand, ExplicitAuthFlowsType, FeatureType, GetTokensFromRefreshTokenCommand, ListUserPoolClientsCommand, MessageActionType, OAuthFlowType, RevokeTokenCommand, TimeUnitsType, UpdateUserPoolClientCommand } from "@aws-sdk/client-cognito-identity-provider";
import { LPXCognitoErrorInfo, cognitoCall, LPXCognitoErrorCode, LPXLogSeverity } from "./CognitoErrors";

let singletonCognitoClient : CognitoIdentityProviderClient | null = null;

function getCognitoClient() : CognitoIdentityProviderClient  {
    if (singletonCognitoClient) return singletonCognitoClient;
    singletonCognitoClient = new CognitoIdentityProviderClient();
    return singletonCognitoClient;
}

/**
 * Every function in this file returns this envelope. `status`/`message`/`data` are unchanged
 * from before so existing callers keep compiling; the new optional fields carry the
 * classification so callers can branch on a stable code instead of parsing a message.
 *
 * `message` is always safe to hand back to an API caller — the technical detail goes to
 * CloudWatch inside cognitoCall and is exposed here only via `errorDetail`.
 */
export interface CognitoResponse<T> {
  data : T,
  message : string,
  status : number,
  /** Present on failure only. Branch on this, never on `message`. */
  code? : LPXCognitoErrorCode,
  /** Recommended log severity for this failure (1=ALERT … 4=WARN). */
  severity? : LPXLogSeverity,
  /** AWS request id, for CloudTrail correlation. */
  requestId? : string,
  /** Log-only technical detail. Never put this in a response body. */
  errorDetail? : string,
}

/** Collapse a classified error into the response envelope. */
function fail<T>(error: LPXCognitoErrorInfo, data: T): CognitoResponse<T> {
    return {
        status: error.status,
        message: error.publicMessage,
        data,
        code: error.code,
        severity: error.severity,
        requestId: error.requestId,
        errorDetail: error.internalMessage,
    };
}

/**
 * A 2xx response that nonetheless lacks the field we needed. Distinct from a thrown
 * exception: it means Cognito and our expectations disagree, which is always our bug.
 */
function malformed<T>(op: string, detail: string, data: T): CognitoResponse<T> {
    const line = `[${op}] Unexpected response shape: ${detail}`;
    console.error(line);
    return { status: 500, message: "Internal error", data, code: "UPSTREAM_ERROR", severity: 3, errorDetail: line };
}

export interface CognitoAppClientSummary {
    userPoolId : string;
    clientId : string;
    clientName : string;
}

export interface CognitoAppClient extends CognitoAppClientSummary {
    callbackURLs : string[],
    logoutURLs : string[],
    // Token validity is fixed at creation and surfaced read-only in the UI.
    accessTokenValidity : number,
    idTokenValidity : number,
    refreshTokenValidity : number,
    isOAuth2Enabled : boolean,
    // Locked to ["code"] / ["openid"] if OAuth2 is enabled; empty otherwise. Surfaced so the UI can render them as read-only proof
    allowedOAuthFlows : string[],
    allowedOAuthScopes : string[],
}

/**
 * Explicit auth flows for every app client we create.
 *
 * ALLOW_REFRESH_TOKEN_AUTH is deliberately ABSENT. Cognito rejects it outright when
 * RefreshTokenRotation is enabled ("ALLOW_REFRESH_TOKEN_AUTH is not a permitted
 * ExplicitAuthFlow when refresh token rotation is enabled"), and that rejection is protecting
 * the invariant this system relies on: the legacy flow it gates — InitiateAuth /
 * AdminInitiateAuth with AuthFlow=REFRESH_TOKEN_AUTH — does NOT rotate the refresh token.
 * Allowing both would let a stolen refresh token be replayed forever through the legacy path,
 * silently bypassing rotation and with it the reuse detection in LKAuthManager.
 *
 * Refresh is therefore NOT broken by its absence: performTokenRefresh calls
 * GetTokensFromRefreshToken, a separate API introduced alongside rotation that this flag does
 * not gate. Nothing in this codebase uses AuthFlow=REFRESH_TOKEN_AUTH. CDK reaches the same
 * conclusion for the CDK-managed home client — it drops ALLOW_REFRESH_TOKEN_AUTH from
 * explicitAuthFlows exactly when refreshTokenRotationGracePeriod is set — and that client's
 * refresh works in the deployed stack.
 */
const LPX_APP_CLIENT_EXPLICIT_AUTH_FLOWS = [
    ExplicitAuthFlowsType.ALLOW_ADMIN_USER_PASSWORD_AUTH,
];

/**
 * Rotation settings shared by create and update.
 *
 * The grace period keeps the previous refresh token usable for a short while after rotation, so
 * a response lost in flight does not lock the user out. Matches the 30s the CDK-managed home
 * client uses; Cognito caps it at 60s. Token revocation must stay enabled — rotation depends on
 * it, and revokeRefreshToken would otherwise fail with UnsupportedTokenTypeException.
 */
const LPX_APP_CLIENT_REFRESH_TOKEN_ROTATION = {
    Feature: FeatureType.ENABLED,
    RetryGracePeriodSeconds: 30,
};

export async function createAppClient(
    userPoolId : string, appClientName : string,
    accessTokenValidity : number, idTokenValidity : number, refreshTokenValidity : number,
    enableOAuth2 : boolean = false, callbackURLs? : string[], logoutURLs? : string[]
) : Promise<CognitoResponse<CognitoAppClientSummary | null>> {
    const out = await cognitoCall("CreateUserPoolClient", `clientName=${appClientName}`, () =>
        getCognitoClient().send(new CreateUserPoolClientCommand({
            UserPoolId : userPoolId,
            ClientName : appClientName,
            AllowedOAuthFlows : enableOAuth2 ? [OAuthFlowType.code] : undefined,
            ExplicitAuthFlows : LPX_APP_CLIENT_EXPLICIT_AUTH_FLOWS,
            AllowedOAuthFlowsUserPoolClient : enableOAuth2,
            EnableTokenRevocation : true,
            CallbackURLs : enableOAuth2 ? callbackURLs : undefined,
            AllowedOAuthScopes : enableOAuth2 ? ["openid"] : undefined,
            LogoutURLs : enableOAuth2? logoutURLs : undefined,
            AccessTokenValidity : accessTokenValidity,
            IdTokenValidity : idTokenValidity,
            RefreshTokenValidity : refreshTokenValidity,
            RefreshTokenRotation : LPX_APP_CLIENT_REFRESH_TOKEN_ROTATION,
            TokenValidityUnits : { AccessToken : TimeUnitsType.SECONDS, IdToken : TimeUnitsType.SECONDS, RefreshToken : TimeUnitsType.SECONDS }
        })));
    if (!out.ok) return fail(out.error, null);
    const created = out.value.UserPoolClient;
    if (!created?.ClientId) {
        return malformed("CreateUserPoolClient", "UserPoolClient.ClientId missing", null);
    }
    return { status : 200, message : "User pool client created successfully", data : { clientId : created.ClientId, clientName : created.ClientName ?? "", userPoolId } };
}

export async function listAppClientInfo(userPoolId : string) : Promise<CognitoResponse<CognitoAppClientSummary[]>> {
    const out = await cognitoCall("ListUserPoolClients", `userPoolId=${userPoolId}`, () =>
        getCognitoClient().send(new ListUserPoolClientsCommand({ UserPoolId : userPoolId })));
    if (!out.ok) return fail(out.error, []);
    return {
        status : 200,
        message : "Success",
        data : out.value.UserPoolClients?.map(x => ({
            clientId : x.ClientId ?? "", clientName : x.ClientName ?? "", userPoolId : userPoolId,
        })) ?? []
    };
}

export async function getAppClientInfo(userPoolId : string, appClientId : string) : Promise<CognitoResponse<CognitoAppClient | null>> {
    const out = await cognitoCall("DescribeUserPoolClient", `clientId=${appClientId}`, () =>
        getCognitoClient().send(new DescribeUserPoolClientCommand({ UserPoolId : userPoolId, ClientId : appClientId })));
    if (!out.ok) return fail(out.error, null);
    const c = out.value.UserPoolClient;
    if (!c) {
        return { status : 404, message : "No app client with the specified ID was found", data : null, code : "RESOURCE_NOT_FOUND", severity : 4 };
    }
    return {
        status : 200,
        message : "App client found",
        data : {
            clientId : c.ClientId ?? "",
            clientName : c.ClientName ?? "",
            userPoolId : userPoolId,
            isOAuth2Enabled : c.AllowedOAuthFlowsUserPoolClient ?? false,
            callbackURLs : c.CallbackURLs ?? [],
            logoutURLs : c.LogoutURLs ?? [],
            accessTokenValidity : c.AccessTokenValidity ?? 0,
            idTokenValidity : c.IdTokenValidity ?? 0,
            refreshTokenValidity : c.RefreshTokenValidity ?? 0,
            allowedOAuthFlows : c.AllowedOAuthFlows ?? [],
            allowedOAuthScopes : c.AllowedOAuthScopes ?? [],
        }
    };
}

/**
 * Update an app client. Only the mutable fields (clientName, callbackURLs, logoutURLs) are
 * accepted as arguments — token validities and OAuth flow type stay locked to whatever the
 * client was created with. UpdateUserPoolClient is a full-overwrite call, so we read the
 * current state first and replay the immutable fields verbatim to avoid clobbering them.
 */
export async function updateAppClient(
    userPoolId : string, appClientId : string, clientName : string,
    accessTokenValidity : number, idTokenValidity : number, refreshTokenValidity : number,
    enableOAuth2 : boolean = false, callbackURLs? : string[], logoutURLs? : string[]
) : Promise<CognitoResponse<CognitoAppClientSummary | null>> {
    const current = await getAppClientInfo(userPoolId, appClientId);
    if (current.status !== 200 || !current.data) {
        return { ...current, data : null };
    }
    const c = current.data;
    const out = await cognitoCall("UpdateUserPoolClient", `clientId=${appClientId}`, () =>
        getCognitoClient().send(new UpdateUserPoolClientCommand({
            UserPoolId : userPoolId,
            ClientId : appClientId,
            ClientName : clientName || c.clientName,
            AllowedOAuthFlows : enableOAuth2 ? [OAuthFlowType.code] : undefined,
            // UpdateUserPoolClient replaces the whole client: any field left out is reset to its
            // default. Omitting ExplicitAuthFlows here silently dropped
            // ALLOW_ADMIN_USER_PASSWORD_AUTH, so an app client stopped being able to log in the
            // first time anyone edited it.
            ExplicitAuthFlows : LPX_APP_CLIENT_EXPLICIT_AUTH_FLOWS,
            AllowedOAuthFlowsUserPoolClient : enableOAuth2,
            EnableTokenRevocation : true,
            CallbackURLs : enableOAuth2 ? callbackURLs : undefined,
            AllowedOAuthScopes : enableOAuth2 ? ["openid"] : undefined,
            LogoutURLs : enableOAuth2? logoutURLs : undefined,
            AccessTokenValidity : accessTokenValidity,
            IdTokenValidity : idTokenValidity,
            RefreshTokenValidity : refreshTokenValidity,
            RefreshTokenRotation : LPX_APP_CLIENT_REFRESH_TOKEN_ROTATION,
            TokenValidityUnits : { AccessToken : TimeUnitsType.SECONDS, IdToken : TimeUnitsType.SECONDS, RefreshToken : TimeUnitsType.SECONDS }
        })));
    if (!out.ok) return fail(out.error, null);
    // Re-read so the caller always gets the canonical Cognito view back.
    return await getAppClientInfo(userPoolId, appClientId);
}

export async function deleteAppClient(userPoolId : string, appClientId : string) : Promise<CognitoResponse<Omit<CognitoAppClientSummary, "clientName"> | null>> {
    const out = await cognitoCall("DeleteUserPoolClient", `clientId=${appClientId}`, () =>
        getCognitoClient().send(new DeleteUserPoolClientCommand({ UserPoolId : userPoolId, ClientId : appClientId })));
    if (!out.ok) return fail(out.error, null);
    return { status : 200, message : "App client deleted", data : { clientId : appClientId, userPoolId } };
}

/**
 * Create a user and, by default, promote the supplied password to a permanent one.
 *
 * AdminCreateUser only accepts a TemporaryPassword and always leaves the account in
 * FORCE_CHANGE_PASSWORD; AdminInitiateAuth then answers with a NEW_PASSWORD_REQUIRED
 * challenge instead of tokens. AdminSetUserPassword({Permanent:true}) is the second call that
 * moves the user to CONFIRMED. Pass isPasswordPermanent=false to keep the invite flow.
 *
 * The two calls are not atomic: if the promotion fails the user exists but cannot log in, so
 * the failure is reported with USER_STATE_CONFLICT and the caller is expected to roll back.
 */
export async function createCognitoAccount(userPoolId : string, lkAccountEmail : string, password : string, isPasswordPermanent : boolean = true, resendMessage : boolean = false) : Promise<CognitoResponse<string>> {
    const created = await cognitoCall("AdminCreateUser", `email=${lkAccountEmail}`, () =>
        getCognitoClient().send(new AdminCreateUserCommand({
            Username : lkAccountEmail,
            TemporaryPassword : password,
            UserPoolId : userPoolId,
            MessageAction : resendMessage ? MessageActionType.RESEND : MessageActionType.SUPPRESS,
            UserAttributes : [
                { Name : "email", Value : lkAccountEmail }
            ]
        })));
    if (!created.ok) return fail(created.error, "");

    const userSubId = created.value.User?.Attributes?.find(x => x.Name == "sub")?.Value;
    if (!userSubId) {
        return malformed("AdminCreateUser", `no 'sub' attribute returned for email=${lkAccountEmail}`, "");
    }

    if (isPasswordPermanent) {
        const promoted = await setCognitoAccountPassword(userPoolId, lkAccountEmail, password, true);
        if (promoted.status !== 200) {
            // The user exists but is still in FORCE_CHANGE_PASSWORD — unusable. Surface the
            // sub so the caller can roll the Cognito user back.
            return { ...promoted, data : userSubId };
        }
    }
    return { status : 200, message : "Account has been created successfully.", data : userSubId };
}

/** Set (and optionally permanently commit) an account's password. */
export async function setCognitoAccountPassword(userPoolId : string, usernameOrSub : string, password : string, permanent : boolean = true) : Promise<CognitoResponse<string>> {
    const out = await cognitoCall("AdminSetUserPassword", `username=${usernameOrSub} permanent=${permanent}`, () =>
        getCognitoClient().send(new AdminSetUserPasswordCommand({
            Permanent : permanent, Password : password, UserPoolId : userPoolId, Username : usernameOrSub,
        })));
    if (!out.ok) return fail(out.error, "");
    return { status : 200, message : "Password set successfully.", data : usernameOrSub };
}

/**
 * Revoke every refresh token the user holds, across every app client and device.
 *
 * Used after a password reset. A reset is the one moment when an existing session is most likely
 * to belong to whoever caused the reset to be needed, and Cognito does NOT invalidate sessions
 * when a password changes — a stolen refresh token keeps minting access tokens for its full
 * lifetime otherwise.
 *
 * Already-issued ACCESS tokens stay valid until they expire (5 minutes here); that is inherent to
 * stateless JWTs and is why the access-token lifetime is short.
 */
export async function globalSignOutCognitoAccount(userPoolId : string, usernameOrSub : string) : Promise<CognitoResponse<string>> {
    const out = await cognitoCall("AdminUserGlobalSignOut", `username=${usernameOrSub}`, () =>
        getCognitoClient().send(new AdminUserGlobalSignOutCommand({ UserPoolId : userPoolId, Username : usernameOrSub })));
    if (!out.ok) return fail(out.error, "");
    return { status : 200, message : "All sessions revoked.", data : usernameOrSub };
}

/**
 * Read a user's live Cognito state. Diagnostics only — used to explain a NotAuthorizedException
 * in the logs (disabled? still FORCE_CHANGE_PASSWORD?) without ever changing what the caller
 * is told, which would reintroduce a user-enumeration oracle.
 */
export async function getCognitoAccountState(userPoolId : string, usernameOrSub : string) : Promise<CognitoResponse<{ status : string, enabled : boolean } | null>> {
    const out = await cognitoCall("AdminGetUser", `username=${usernameOrSub}`, () =>
        getCognitoClient().send(new AdminGetUserCommand({ UserPoolId : userPoolId, Username : usernameOrSub })));
    if (!out.ok) return fail(out.error, null);
    return {
        status : 200,
        message : "OK",
        data : { status : out.value.UserStatus ?? "UNKNOWN", enabled : out.value.Enabled ?? false },
    };
}

export async function createCognitoGroup(userPoolId : string, groupId : string) : Promise<CognitoResponse<string>> {
    const out = await cognitoCall("CreateGroup", `groupId=${groupId}`, () =>
        getCognitoClient().send(new CreateGroupCommand({ UserPoolId : userPoolId, GroupName : groupId })));
    if (!out.ok) return fail(out.error, "");
    return { status : 200, message : "Group has been created successfully.", data : out.value.Group?.RoleArn ?? "" };
}

export async function getCognitoGroupsForUser(userPoolId : string, lkAccountSub : string) : Promise<CognitoResponse<string[]>> {
    const out = await cognitoCall("AdminListGroupsForUser", `sub=${lkAccountSub}`, () =>
        getCognitoClient().send(new AdminListGroupsForUserCommand({ UserPoolId : userPoolId, Username : lkAccountSub })));
    if (!out.ok) return fail(out.error, []);
    return { status : 200, message : "OK", data : out.value.Groups?.map(g => g.GroupName).filter((g) : g is string => !!g) ?? [] };
}

export async function addUserToCognitoGroup(userPoolId : string, groupId : string, lkAccountSub : string) : Promise<CognitoResponse<string>> {
    const out = await cognitoCall("AdminAddUserToGroup", `sub=${lkAccountSub} groupId=${groupId}`, () =>
        getCognitoClient().send(new AdminAddUserToGroupCommand({ UserPoolId : userPoolId, Username : lkAccountSub, GroupName : groupId })));
    if (!out.ok) return fail(out.error, "");
    return { status : 200, message : "The user has been successfully added to the group.", data : "" };
}

export async function removeUserFromCognitoGroup(userPoolId : string, groupId : string, lkAccountSub : string) : Promise<CognitoResponse<string>> {
    const out = await cognitoCall("AdminRemoveUserFromGroup", `sub=${lkAccountSub} groupId=${groupId}`, () =>
        getCognitoClient().send(new AdminRemoveUserFromGroupCommand({ UserPoolId : userPoolId, Username : lkAccountSub, GroupName : groupId })));
    if (!out.ok) return fail(out.error, "");
    return { status : 200, message : "The user has been successfully removed from the group.", data : "" };
}

export async function deleteCognitoGroup(userPoolId : string, groupId : string) : Promise<CognitoResponse<string>> {
    const out = await cognitoCall("DeleteGroup", `groupId=${groupId}`, () =>
        getCognitoClient().send(new DeleteGroupCommand({ UserPoolId : userPoolId, GroupName : groupId })));
    if (!out.ok) return fail(out.error, "");
    return { status : 200, message : "The group has been successfully deleted.", data : "" };
}

export async function disableCognitoAccount(userPoolId : string, lkAccountSub : string) : Promise<CognitoResponse<string>> {
    // Cognito APIs allow the sub to be used as the identifier when calling APIs
    const out = await cognitoCall("AdminDisableUser", `sub=${lkAccountSub}`, () =>
        getCognitoClient().send(new AdminDisableUserCommand({ Username : lkAccountSub, UserPoolId : userPoolId })));
    if (!out.ok) return fail(out.error, "");
    return { status : 200, message : "The user has been successfully disabled.", data : out.value.$metadata.requestId ?? "" };
}

export async function enableCognitoAccount(userPoolId : string, lkAccountSub : string) : Promise<CognitoResponse<string>> {
    const out = await cognitoCall("AdminEnableUser", `sub=${lkAccountSub}`, () =>
        getCognitoClient().send(new AdminEnableUserCommand({ Username : lkAccountSub, UserPoolId : userPoolId })));
    if (!out.ok) return fail(out.error, "");
    return { status : 200, message : "The user has been successfully enabled.", data : out.value.$metadata.requestId ?? "" };
}

export async function deleteCognitoAccount(userPoolId : string, lkAccountSub : string) : Promise<CognitoResponse<string>> {
    const out = await cognitoCall("AdminDeleteUser", `sub=${lkAccountSub}`, () =>
        getCognitoClient().send(new AdminDeleteUserCommand({ Username : lkAccountSub, UserPoolId : userPoolId })));
    if (!out.ok) return fail(out.error, "");
    return { status : 200, message : "The user has been successfully deleted.", data : out.value.$metadata.requestId ?? "" };
}

export interface CognitoTokenSet {
    accessToken : string;
    idToken : string;
    refreshToken : string;
    expiresIn : number;
    tokenType : string;
}

/**
 * A challenge is NOT an error — Cognito returns 200 with a ChallengeName and no
 * AuthenticationResult. The old code tested `!AuthenticationResult` first and so reported every
 * challenge as "Invalid credentials", which is what made a FORCE_CHANGE_PASSWORD account
 * indistinguishable from a wrong password.
 */
export interface CognitoAuthChallenge {
    challengeName : string;
    session? : string;
}

export async function initiateAuthEmailPassword(
    email : string, password : string, userPoolId : string, clientId : string,
) : Promise<CognitoResponse<CognitoTokenSet | null> & { challenge? : CognitoAuthChallenge }> {
    const out = await cognitoCall("AdminInitiateAuth", `email=${email} clientId=${clientId}`, () =>
        getCognitoClient().send(new AdminInitiateAuthCommand({
            UserPoolId: userPoolId,
            ClientId: clientId,
            AuthFlow: AuthFlowType.ADMIN_USER_PASSWORD_AUTH,
            AuthParameters: { USERNAME: email, PASSWORD: password },
        })));

    if (!out.ok) {
        const failed = fail(out.error, null);
        // Diagnostics only: NotAuthorizedException covers wrong-password, disabled and revoked
        // alike. Read the live state so the log line says which, while the response stays
        // identical for every case.
        if (out.error.code === "BAD_CREDENTIALS") {
            const state = await getCognitoAccountState(userPoolId, email);
            const detail = state.status === 200 && state.data
                ? `userStatus=${state.data.status} enabled=${state.data.enabled}`
                : `state lookup failed (${state.code ?? state.status})`;
            console.warn(`[AdminInitiateAuth] BAD_CREDENTIALS for email=${email} — ${detail}`);
            return { ...failed, errorDetail : `${failed.errorDetail} | ${detail}` };
        }
        return failed;
    }

    const challengeName = out.value.ChallengeName;
    if (challengeName) {
        // e.g. NEW_PASSWORD_REQUIRED (account still in FORCE_CHANGE_PASSWORD), SMS_MFA,
        // SOFTWARE_TOKEN_MFA. The caller decides which challenges it supports.
        console.warn(`[AdminInitiateAuth] Challenge ${challengeName} for email=${email}`);
        return {
            status : 409,
            message : "Additional authentication step required",
            data : null,
            code : "CHALLENGE_REQUIRED",
            severity : 4,
            errorDetail : `[AdminInitiateAuth] email=${email} → CHALLENGE_REQUIRED | ${challengeName}`,
            challenge : { challengeName, session : out.value.Session },
        };
    }

    const r = out.value.AuthenticationResult;
    if (!r?.AccessToken || !r.IdToken || !r.RefreshToken) {
        // No tokens and no challenge: Cognito violated its own contract, or the client is
        // configured in a way that withholds a token we require.
        return malformed("AdminInitiateAuth", `no challenge and incomplete AuthenticationResult for email=${email} (access=${!!r?.AccessToken} id=${!!r?.IdToken} refresh=${!!r?.RefreshToken})`, null);
    }
    return {
        status : 200,
        message : "OK",
        data : {
            accessToken : r.AccessToken,
            idToken : r.IdToken,
            refreshToken : r.RefreshToken,
            expiresIn : r.ExpiresIn ?? 3600,
            tokenType : r.TokenType ?? "Bearer",
        },
    };
}

/*
 * RETAINED, with no caller.
 *
 * Its only caller was the legacy POST /lpx/auth/token, removed on 2026-10-26. It is kept because
 * this module is the one place that knows how to talk to the user pool, and that knowledge is
 * still wanted while Cognito verifies passwords — deleting a working wrapper to re-derive it later
 * is a poor trade for a few unused lines.
 *
 * Nothing in this system issues or accepts a Cognito token any more, so if this is ever called
 * again it will be for a new reason rather than the old one.
 */
export async function performTokenRefresh(clientId : string, refreshToken : string) : Promise<CognitoResponse<CognitoTokenSet | null>> {
    const out = await cognitoCall("GetTokensFromRefreshToken", `clientId=${clientId}`, () =>
        getCognitoClient().send(new GetTokensFromRefreshTokenCommand({ ClientId: clientId, RefreshToken : refreshToken })));
    if (!out.ok) return fail(out.error, null);

    const r = out.value.AuthenticationResult;
    if (!r?.AccessToken || !r.IdToken) {
        return malformed("GetTokensFromRefreshToken", `incomplete AuthenticationResult for clientId=${clientId} (access=${!!r?.AccessToken} id=${!!r?.IdToken})`, null);
    }

    // Cognito returns a rotated RefreshToken ONLY when refresh token rotation is enabled on the
    // app client. With rotation off, omitting it is correct protocol, not an error — the caller
    // is meant to keep using the token it already holds. Reuse the incoming one so both
    // configurations work, and warn, because a client we intended to rotate silently not
    // rotating is worth knowing about.
    const rotatedRefreshToken = r.RefreshToken ?? "";
    if (!rotatedRefreshToken) {
        console.warn(
            `[GetTokensFromRefreshToken] clientId=${clientId} returned no rotated refresh token; ` +
            `reusing the existing one. Refresh token rotation appears to be DISABLED on this app client. ` +
            `Note the sectoken replay-detection in LKAuthManager depends on rotation, so it cannot ` +
            `distinguish a replay from a legitimate reuse while rotation is off.`);
    }

    return {
        status : 200,
        message : "OK",
        data : {
            accessToken : r.AccessToken,
            idToken : r.IdToken,
            refreshToken : rotatedRefreshToken || refreshToken,
            expiresIn : r.ExpiresIn ?? 3600,
            tokenType : r.TokenType ?? "Bearer",
        },
    };
}

export async function revokeRefreshToken(clientId : string, refreshToken : string) : Promise<CognitoResponse<string>> {
    const out = await cognitoCall("RevokeToken", `clientId=${clientId}`, () =>
        getCognitoClient().send(new RevokeTokenCommand({ ClientId: clientId, Token : refreshToken })));
    if (!out.ok) return { ...fail(out.error, refreshToken) };
    return { status : 200, message : "The token has been successfully revoked", data : refreshToken };
}
