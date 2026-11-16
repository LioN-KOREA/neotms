// SPDX-License-Identifier: MIT
//
// Sends Hiworks office mail as the signed-in user. Its only consumer is the handover mail (
// `NeotmsHandoverManager`), and it is the one external integration in this repository with no
// published API to work from - it mirrors, request for request, what the browser actually sends at
// mails.office.hiworks.com. Every header matters as a result: drop `Origin` or `Referer` and the
// call is refused.
//
// ## Why this lives here and not under lambdas/common
//
// It arrived in `lambdas/common/layers/nodejs/hiworks/`. That tree is base code lifted from the LPX
// project, and `tsconfig.app.json` DELIBERATELY excludes it from the typecheck - it imports Cognito
// and KMS packages NEOTMS does not install, and it must not be able to block a NEOTMS deploy (see
// that file's header). Leaving this module there while NEOTMS code imports it breaks two things at
// once: the import drags the file into the typecheck anyway while it sits in a directory marked as
// unchecked, and the next refresh of that base code from LPX would quietly delete a NEOTMS-only
// file along with the feature that depends on it.
//
// ## The credentials belong to the caller and are kept nowhere
//
// The sign-in id and password are collected in the dialog, passed down to this module, exchanged
// for a `PHPSESSID`, and dropped. They are not stored, not logged, and the mail goes out from the
// CALLER'S OWN Hiworks account. There being no shared company sender is the point - with one, this
// endpoint would have become the authority to mail anybody under the company's name.

const REQUEST_HEADERS_BASE = {
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Accept-Language": "ko,en;q=0.9,en-US;q=0.8",
    "Connection": "keep-alive",
    "sec-ch-ua": "\"Chromium\";v=\"142\", \"Microsoft Edge\";v=\"142\", \"Not_A Brand\";v=\"99\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "Windows",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
    "x-skip-session-refresh": "true"
}
export interface HiworksAuthData { sessionId: string; officeId: string; }
export interface HiworksAPIResult<T> { result: T, status: number }
export interface HiworksMailCertKey { mailCertKey: string }

const HIWORKS_LOGIN_ENDPOINT = "https://auth-api.office.hiworks.com/office-web/login";
export async function hiworksLogin(id: string, pw: string): Promise<HiworksAPIResult<HiworksAuthData | null>> {
    const requestData = {
        id: id,
        ip_security_level: "1",
        password: pw
    };
    const response = await fetch(HIWORKS_LOGIN_ENDPOINT, {
        method: "POST",
        headers: {
            ...REQUEST_HEADERS_BASE,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Host": "auth-api.office.hiworks.com",
            "Origin": "https://login.office.hiworks.com",
            "Referer": "https://login.office.hiworks.com/",
        },
        body: JSON.stringify(requestData)
    }).catch(_ => null);
    if (!response || response.status != 200) return { status: response?.status ?? -1, result: null }
    const cookies = response.headers.getSetCookie();
    let sessionId: string | null = null;
    let officeId: string | null = null;
    for (const cookie of cookies) {
        if (cookie.startsWith("PHPSESSID=")) {
            const nameValue = cookie.slice(10).split(";")[0];
            sessionId = nameValue.trim();
        } else if (cookie.startsWith("h_officeid=")) {
            const nameValue = cookie.slice(11).split(";")[0];
            officeId = nameValue.trim();
        }
    }
    if (!sessionId || !officeId) return { status: 500, result: null }
    return { result: { officeId, sessionId }, status: 200 };
}


const HIWORKS_ME_API_ENDPOINT = "https://office-account-api.office.hiworks.com/v3/users/me"
export interface HiworksAccountInfo {
    id: string;
    officeNo: string;
    hiworksAccountNo: string;
    accountId: string;
    name: string;
    email: string;
    isOfficeAdmin: boolean;
    isActive: boolean;
    isDeleted: boolean;
    isRegistered: boolean;
}
export async function fetchHiworksAccountData({ sessionId, officeId }: HiworksAuthData): Promise<HiworksAPIResult<HiworksAccountInfo | null>> {
    const res = await fetch(HIWORKS_ME_API_ENDPOINT, {
        headers: {
            ...REQUEST_HEADERS_BASE,
            "Accept": "application/vnd.api+json",
            "Cookie": `PHPSESSID=${sessionId}; h_officeId=${officeId}`,
            "Host": "auth-api.office.hiworks.com",
            "Origin": "https://groups.office.hiworks.com",
            "Referer": "https://groups.office.hiworks.com/",
        },
    }).catch(_ => null);
    if (!res || res.status !== 200) {
        return { status: res?.status ?? -1, result: null };
    }
    const resData = await res.json().catch(_ => null)
    if (!resData || typeof resData !== "object" ||
        !("id" in resData && typeof resData.id === "string") ||
        !("attributes" in resData && typeof resData.attributes === "object" && resData.attributes !== null) ||
        !("office_no" in resData.attributes && typeof resData.attributes.office_no === "string") ||
        !("hiworks_account_no" in resData.attributes && typeof resData.attributes.hiworks_account_no === "string") ||
        !("account_id" in resData.attributes && typeof resData.attributes.account_id === "string") ||
        !("name" in resData.attributes && typeof resData.attributes.name === "string") ||
        !("email" in resData.attributes && typeof resData.attributes.email === "string") ||
        !("is_office_admin" in resData.attributes && typeof resData.attributes.is_office_admin === "boolean") ||
        !("is_active" in resData.attributes && typeof resData.attributes.is_active === "boolean") ||
        !("is_deleted" in resData.attributes && typeof resData.attributes.is_deleted === "boolean") ||
        !("is_registed" in resData.attributes && typeof resData.attributes.is_registed === "boolean")
    ) return { status: 500, result: null };
    return {
        status: 200,
        result: {
            id: resData.id,
            hiworksAccountNo: resData.attributes.hiworks_account_no,
            officeNo: resData.attributes.office_no,
            accountId: resData.attributes.account_id,
            email: resData.attributes.email,
            name: resData.attributes.name,
            isOfficeAdmin: resData.attributes.is_office_admin,
            isActive: resData.attributes.is_active,
            isDeleted: resData.attributes.is_deleted,
            isRegistered: resData.attributes.is_registed
        }
    }

}

export async function fetchHiworksMailCertKey({ sessionId, officeId }: HiworksAuthData): Promise<HiworksAPIResult<HiworksMailCertKey | null>> {
    const res = await fetch("https://mail-api.office.hiworks.com/v2/mails/cert-key", {
        "headers": {
            ...REQUEST_HEADERS_BASE,
            "Accept": "application/json;charset=UTF-8",
            "Accept-Language": "ko,en;q=0.9,en-US;q=0.8",
            "priority": "u=1, i",
            "Cookie": `PHPSESSID=${sessionId}; h_officeId=${officeId}`,
            "Origin": "https://mails.office.hiworks.com",
            "Referer": "https://mails.office.hiworks.com/"
        },
        "body": null,
        "method": "POST"
    }).catch(_ => null);
    if (!res || res.status !== 200) {
        return { status: res?.status ?? -1, result: null };
    }
    const resData = await res.json().catch(_ => null)
    if (!resData || typeof resData !== "object" ||
        !("data" in resData && typeof resData.data === "string")
    ) return { status: 500, result: null };
    return {
        status: 200,
        result: {
            mailCertKey: resData.data
        }
    }
}

export async function hiworksSendEmail({ sessionId, officeId }: HiworksAuthData, receipients: string[], bcc: string[], cc: string[], subject: string, contentsHtml: string): Promise<HiworksAPIResult<number>> {
    const senderListRes = await fetch("https://mail-api.office.hiworks.com/v2/senders", {
        "headers": {
            ...REQUEST_HEADERS_BASE,
            "Accept": "application/json;charset=UTF-8",
            "Accept-Language": "ko,en;q=0.9,en-US;q=0.8",
            "priority": "u=1, i",
            "Cookie": `PHPSESSID=${sessionId}; h_officeId=${officeId}`,
            "Origin": "https://mails.office.hiworks.com",
            "Referer": "https://mails.office.hiworks.com/"
        },
        "body": null,
        "method": "GET"
    }).catch(_ => null);
    if (!senderListRes || senderListRes.status !== 200) return {
        status: senderListRes?.status ?? -1,
        result: senderListRes?.status ?? -1
    }
    const senderList = await senderListRes.json().catch(_ => null);
    if (!senderList || typeof senderList != "object" || !("data" in senderList) || !(Array.isArray(senderList.data)) ||
        !(senderList.data[0]) || !("no" in senderList.data[0]) || typeof senderList.data[0].no !== "number") {
        return { status: 500, result: 500 }
    }
    const senderNo : number = senderList.data[0].no;
    const mailCertKeyReq = await fetchHiworksMailCertKey({sessionId, officeId});
    if (!mailCertKeyReq.result) return { status : mailCertKeyReq.status, result : mailCertKeyReq.status }
    const mailCertKey = mailCertKeyReq.result.mailCertKey;
    const preRes = await fetch("https://mail-api.office.hiworks.com/v2/mails/verify-send-type", {
        "headers": {
            ...REQUEST_HEADERS_BASE,
            "Accept": "application/json;charset=UTF-8",
            "Accept-Language": "ko,en;q=0.9,en-US;q=0.8",
            "Content-Type" : "application/json;charset=UTF-8",
            "priority": "u=1, i",
            "Cookie": `PHPSESSID=${sessionId}; h_officeId=${officeId}`,
            "Origin": "https://mails.office.hiworks.com",
            "Referer": "https://mails.office.hiworks.com/"
        },
        "referrer": "https://mails.office.hiworks.com/",
        "body": JSON.stringify({
            "cert_key": mailCertKey,
            "sender_no": senderNo,
            "to": receipients,
            "cc": cc,
            "bcc": bcc,
            "subject": subject,
            "content": contentsHtml,
            "is_important": false,
            "original_mail_no": null,
            "original_temp_part_id_list": [],
            "is_encrypt": false,
            "is_separate_send": false,
            "reserve_date": null,
            "is_text_mode": false,
            "is_reply": false,
            "is_forward": false,
            "response_target_mail_no": null,
            "is_receipt_confirm": true,
            "is_save": true
        }),
        "method": "POST",
        "mode": "cors",
        "credentials": "include"
    }).catch(_ => null);
    if (!preRes || preRes.status !== 200) return {
        status: preRes?.status ?? -1,
        result: preRes?.status ?? -1
    }

    const res = await fetch("https://mail-api.office.hiworks.com/v2/mails/send", {
        "headers": {
            ...REQUEST_HEADERS_BASE,
            "Accept": "application/json;charset=UTF-8",
            "Accept-Language": "ko,en;q=0.9,en-US;q=0.8",
            "Content-Type" : "application/json;charset=UTF-8",
            "priority": "u=1, i",
            "Cookie": `PHPSESSID=${sessionId}; h_officeId=${officeId}`,
            "Origin": "https://mails.office.hiworks.com",
            "Referer": "https://mails.office.hiworks.com/"
        },
        "referrer": "https://mails.office.hiworks.com/",
        "body": JSON.stringify({
            "cert_key": mailCertKey,
            "sender_no": senderNo,
            "to": receipients,
            "cc": cc,
            "bcc": bcc,
            "subject": subject,
            "content": contentsHtml,
            "is_important": false,
            "original_mail_no": null,
            "original_temp_part_id_list": [],
            "is_encrypt": false,
            "is_separate_send": false,
            "reserve_date": null,
            "is_text_mode": false,
            "is_reply": false,
            "is_forward": false,
            "response_target_mail_no": null,
            "is_receipt_confirm": true,
            "is_save": true
        }),
        "method": "POST",
        "mode": "cors",
        "credentials": "include"
    }).catch(_ => null);
    return {
        status: res?.status ?? -1,
        result: res?.status ?? -1
    }
}