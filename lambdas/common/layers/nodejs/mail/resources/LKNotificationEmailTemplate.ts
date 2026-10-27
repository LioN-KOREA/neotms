// SPDX-License-Identifier: MIT
//
// The bilingual notification body this system sends on its own behalf.

/**
 * Escape text destined for an HTML mail body.
 *
 * Every caller-supplied line goes through this. A notification line routinely carries a name, a
 * filename or an account email that came from a user, and an unescaped "<" turns the rest of the
 * mail into markup — or smuggles a link into a message the recipient trusts because it came from
 * the account system.
 */
export function escapeHtml(text: string): string {
    return text.replace(/[&<>"']/g, (c) => (
        c === "&" ? "&amp;" :
            c === "<" ? "&lt;" :
                c === ">" ? "&gt;" :
                    c === '"' ? "&quot;" : "&#39;"
    ));
}

/** One paragraph, or a blank line when the text is empty. */
const LINE = (text?: string | null) =>
    text
        ? `<p style="margin: 0px;"><span style="font-size: 14px;">${escapeHtml(text)}</span></p>`
        : '<p style="margin: 0px;"><span style="font-size: 14px;"><br></span></p>';

/**
 * Render the standard notification mail.
 *
 * Both language blocks are always present: recipients include non-Korean speakers, and a single
 * template avoids deciding per-recipient which language to send.
 *
 * Note the `.join("")` on each block — interpolating an array into a template literal stringifies
 * it with commas, which is how a rendered mail ends up with stray "," between every paragraph.
 */
export function buildNotificationEmail(
    koreanContents: Array<string | null | undefined>,
    englishContents: Array<string | null | undefined>,
): string {
    return `
<div class="se-contents" role="textbox" style="box-sizing: content-box; font-family: &quot;맑은 고딕&quot;; font-size: 16px; line-height: 1.6;" data-document-fixed-width="false">
	<p style="margin: 0px;"><span style="font-size: 14px;">안녕하세요,</span></p>
	<p style="margin: 0px;"><span style="font-size: 14px;">라이온코리아 IT서비스 통합계정 관리 시스템 입니다.</span></p>
	<p style="margin: 0px;"><span style="font-size: 14px;"><br></span></p>
${koreanContents.map((line) => LINE(line)).join("")}
	<p style="margin: 0px;"><span style="font-size: 14px;"><br></span></p>
	<p style="margin: 0px;"><span style="font-size: 14px;">감사합니다.</span></p>
	<p style="margin: 0px;"><span style="font-size: 14px;">라이온코리아 IT서비스 관리자</span></p>
	<p style="margin: 0px;"><span style="font-size: 14px;"><br></span></p>
	<p style="margin: 0px;"><span style="font-size: 14px;">Hello,</span></p>
	<p style="margin: 0px;"><span style="font-size: 14px;">This E-mail has been sent to you by LioN Korea's integrated IT Service Accounts Management System.</span></p>
	<p style="margin: 0px;"><span style="font-size: 14px;"><br></span></p>
${englishContents.map((line) => LINE(line)).join("")}
	<p style="margin: 0px;"><span style="font-size: 14px;"><br></span></p>
	<p style="margin: 0px;"><span style="font-size: 14px;">Best regards,</span></p>
	<p style="margin: 0px;"><span style="font-size: 14px;">LioN Korea IT Services Administrator.</span></p>
</div>
`;
}

/**
 * The block appended to a body for attachments too large to send inline.
 *
 * The link points at this system's download endpoint rather than a presigned S3 URL: a presigned
 * URL would be minted now and embedded in a mail that may be read days later, long after it
 * expired — and anyone forwarded the mail could use it without authenticating.
 */
export function buildLargeAttachmentLinks(
    downloadBaseUrl: string,
    attachments: Array<{ itemKey: string; itemName: string }>,
    expiresOnMs: number,
): string {
    if (attachments.length === 0 || !downloadBaseUrl) return "";
    const expiry = new Date(expiresOnMs).toISOString().slice(0, 10);
    const links = attachments
        .map((a) => {
            const href = `${downloadBaseUrl}?id=${encodeURIComponent(a.itemKey)}`;
            return `<p style="margin: 0px;"><span style="font-size: 14px;"><a href="${escapeHtml(href)}">${escapeHtml(a.itemName)}</a></span></p>`;
        })
        .join("");
    return `
<div style="margin-top: 16px; padding-top: 12px; border-top: 1px solid #dddddd;">
	<p style="margin: 0px;"><span style="font-size: 14px;">첨부파일 / Attachments (${expiry} 까지 / until ${expiry}):</span></p>
${links}
</div>
`;
}
