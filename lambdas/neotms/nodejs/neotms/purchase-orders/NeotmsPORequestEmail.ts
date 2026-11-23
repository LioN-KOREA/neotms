// SPDX-License-Identifier: MIT
//
// The PO request mail - the company's form for telling a translator that work is waiting.
//
// ## Why the attachments are links and not attachments
//
// Hiworks' mail API takes a subject and an HTML body and nothing else: there is no attachment
// parameter. So the files go to S3 and the mail carries links. Each link points at THIS system
// (`/api/v0/attachments/{token}`), not at S3 - an S3 presigned URL cannot live for the 21 days the
// translator is given, because SigV4 caps a presigned URL at 7 days and one signed with the
// function's own role credentials dies when those temporary credentials do, hours later. The token
// is resolved to a fresh short-lived presigned URL at the moment the translator clicks it.
//
// ## Everything interpolated here is escaped
//
// The body is HTML assembled by string concatenation, and three of the values in it are typed by a
// person: the remarks, the file names, and the names carried on the PO. `esc` runs over every one.
// Without it a file called `<img src=x onerror=...>.pdf` would be markup in a mail going to someone
// outside the company, and the remarks box would be an open invitation.
//
// The URL is escaped too, and that one is easy to miss: it goes in an `href` attribute, so a quote
// in it would end the attribute and begin a new one.

/**
 * What an original document may be. `OTHERS` is the escape hatch, and it is spelled in English
 * here because this is application logic - the screen renders it as 기타.
 */
export const PO_ORIGINAL_FORMATS = ["PDF", "PPT", "WORD", "HWP", "OTHERS"] as const;

/**
 * What a workspace file (작업파일) may be. The same list plus `SDLPPX`, the Trados package that is
 * the usual answer for a CAT job and the reason this list is not simply the one above.
 */
export const PO_WORKSPACE_FORMATS = ["SDLPPX", "PDF", "PPT", "WORD", "HWP", "OTHERS"] as const;

export type PoOriginalFormat = (typeof PO_ORIGINAL_FORMATS)[number];
export type PoWorkspaceFormat = (typeof PO_WORKSPACE_FORMATS)[number];

/** How a format is written in the mail. The form is Korean; the code is not. */
const FORMAT_LABELS: Record<string, string> = {
  PDF: "PDF",
  PPT: "PPT",
  WORD: "WORD",
  HWP: "HWP",
  SDLPPX: "sdlppx",
  OTHERS: "기타",
};

/** One file the translator can download, as the mail needs it. */
export type PoAttachmentLink = {
  /** The absolute URL of this system's download endpoint, token included. */
  url: string;
  /** What the person uploaded it as. Becomes the link text, so it is escaped. */
  fileName: string;
};

/** What the sender picked and typed in the dialog. */
export type PoRequestChoices = {
  /** At least one - the schema refuses an empty list. */
  originalFormats: readonly PoOriginalFormat[];
  /** May be empty: a job with no CAT package has no workspace file. */
  workspaceFormats: readonly PoWorkspaceFormat[];
  /** The 요청사항 box, typed when sending. Empty is normal and renders as the boilerplate alone. */
  note: string;
  attachments: readonly PoAttachmentLink[];
};

/** The PO's own facts, already formatted for display by the manager. */
export type PoRequestFacts = {
  /** Leads the subject line: what the translator quotes in a reply. */
  poCode: string;
  projectName: string | null;
  translatorName: string;
  pmName: string;
  /** `영어 > 한국어`, or `-` when the PO carries no language pair (MICE and IMC work). */
  languages: string;
  /** `2500자`, or `-`. */
  volume: string;
  /** `12/1(월) 오전 12시`, or `-`. */
  deadline: string;
};

export type PoRequestMail = { subject: string; body: string };

const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A multi-line value: keep the line breaks, escape everything else. */
const escLines = (value: string): string => esc(value).replace(/\r?\n/g, "<br>");

/** `PDF / HWP`, or `-` when nothing was picked. */
const formatList = (formats: readonly string[]): string =>
  formats.length === 0 ? "-" : formats.map((f) => FORMAT_LABELS[f] ?? f).join(" / ");

/*
 * The inline styles are the company's form, pasted from the mail client it was designed in. They
 * are verbose and they are not going to be tidied: a mail body is rendered by Outlook, Hiworks,
 * Gmail and a phone, none of which agree about anything a stylesheet would say, and the only
 * version of this table known to survive all four is this one.
 */
const FONT = '&quot;맑은 고딕&quot;';
const CELL_HEAD =
  'border-color: currentcolor rgb(0, 0, 0) rgb(0, 0, 0); background: rgb(219, 238, 243); ' +
  "padding: 0px 6.6px; border-style: none solid solid; border-width: 3px 1.333px 1.333px;";
const CELL_BODY =
  "border-color: currentcolor rgb(0, 0, 0) rgb(0, 0, 0) currentcolor; padding: 0px 6.6px; " +
  "border-style: none solid solid none; border-width: 3px 1.333px 1.333px 3px;";
const P = `class="MsoNormal" style="font-family: ${FONT}; font-size: 11pt; margin: 0px; word-break: keep-all;"`;
const P_CENTER =
  `class="MsoNormal" style="font-family: ${FONT}; font-size: 11pt; text-align: center; ` +
  "margin: 0px; word-break: keep-all;";
const SPAN = `style="font-family: ${FONT}; font-size: 10pt; color: rgb(0, 0, 0);"`;
const SPAN_BOLD = `style="font-family: ${FONT}; font-size: 10pt; color: rgb(0, 0, 0); font-weight: 700;"`;
const SPAN_RED = `style="font-family: ${FONT}; font-size: 10pt; color: rgb(255, 0, 0); font-weight: 700;"`;

/** The thin spacer row the form puts between every pair of rows. */
const SPACER = `<tr style="height: 20px;">
  <td style="border-color: currentcolor rgb(0, 0, 0) rgb(0, 0, 0); padding: 0px 6.6px; border-style: none solid solid; border-width: 3px 1.333px 1.333px;" colspan="2">
    <p style="line-height: 1px; margin: 0px;"><br></p>
  </td>
</tr>`;

/** One labelled row of the form. `valueHtml` is already escaped by its caller. */
const row = (label: string, valueHtml: string, height = 30): string => `<tr style="height: ${String(height)}px;">
  <td style="${CELL_HEAD}">
    <p ${P_CENTER}><span ${SPAN_BOLD}>${esc(label)}</span></p>
  </td>
  <td style="${CELL_BODY}">
    <p ${P_CENTER}><span ${SPAN}>${valueHtml}</span></p>
  </td>
</tr>`;

/**
 * The attachment cell.
 *
 * Each file is an `<a>` whose text is the file name, which is what the request asked for and is
 * also the only thing that makes a list of links usable - five URLs of random tokens tell the
 * translator nothing about which file is which.
 *
 * `rel="noopener noreferrer"` on a link in a mail is not about window.opener; it is about the
 * referrer. Without it, a mail client that opens the link in a browser can send this system's URL -
 * token and all - to whatever the download redirects to.
 */
const attachmentCell = (attachments: readonly PoAttachmentLink[]): string => {
  if (attachments.length === 0) {
    return `<span ${SPAN}>-</span>`;
  }
  return attachments
    .map(
      (file) =>
        `<a href="${esc(file.url)}" rel="noopener noreferrer" ` +
        `style="font-family: ${FONT}; font-size: 10pt; color: rgb(5, 99, 193);">` +
        `${esc(file.fileName)}</a>`,
    )
    .join("<br>");
};

/**
 * The subject line.
 *
 * The PO code leads, because that is what the translator quotes when they reply and what the PM
 * searches for afterwards. Everything else in the line is for a person skimming an inbox.
 */
export function poRequestSubject(poCode: string, projectName: string | null): string {
  const tail = projectName?.trim() ? ` - ${projectName.trim()}` : "";
  return `[의뢰] ${poCode}${tail}`;
}

/**
 * The whole mail.
 *
 * Every value arrives already decided: the manager formats the dates and the language pair, the
 * schema has refused an empty format list, and the attachment URLs have been minted. This function
 * does no lookups and makes no decisions - it is the form, and keeping it that way is what lets it
 * be checked against the printed version by reading it.
 */
export function composePoRequestMail(
  facts: PoRequestFacts,
  choices: PoRequestChoices,
): PoRequestMail {
  const documentTypes =
    `원본: ${esc(formatList(choices.originalFormats))} / ` +
    `작업파일: ${esc(formatList(choices.workspaceFormats))}`;

  /*
   * The boilerplate requests are part of the form, not something the sender writes. The sender's
   * own words go underneath, and only when there are any - an empty line under three red warnings
   * reads as a sentence somebody forgot to finish.
   */
  const noteHtml = choices.note.trim()
    ? `<p ${P}><span ${SPAN}>${escLines(choices.note.trim())}</span></p>`
    : "";

  const body = `<div class="se-contents" role="textbox" style="box-sizing: content-box; font-family: ${FONT}; font-size: 16px; line-height: 1.6;" data-document-fixed-width="false">
<table class="MsoNormalTable" style="border-collapse: collapse; border-spacing: 0px; font-family: ${FONT}; font-size: 11pt; vertical-align: text-bottom; margin: 0px 0px 10.6667px 11px; width: 472px;" cellpadding="0" data-template-id="0">
  <colgroup><col><col></colgroup>
  <tbody>
    <tr style="height: 40px;">
      <td style="background: rgb(255, 255, 255); padding: 0px 6.6px; border-color: rgb(0, 0, 0); border-style: solid; border-width: 1.333px;" colspan="2">
        <p ${P}><span ${SPAN}>안녕하세요 ${esc(facts.translatorName)} 번역가님,</span></p>
        <p ${P}><span ${SPAN}>라이온코리아 ${esc(facts.pmName)} 입니다.</span></p>
        <p ${P}><span ${SPAN}>&nbsp;</span></p>
        <p ${P}><span ${SPAN}>첨부 문서 의뢰 드립니다. 상세 내용은 아래와 같습니다.</span></p>
        <p ${P}><span ${SPAN}>파일 확인 후 회신 요청드립니다. 감사합니다.</span></p>
        <p ${P}><span ${SPAN}>&nbsp;</span></p>
        <p ${P}><span style="background: rgb(255, 255, 191); font-family: ${FONT}; font-size: 10pt; color: rgb(255, 0, 0); font-weight: 700;">* 어떠한 형태든 번역기(MTPE 포함) 및 ChatGPT 사용은 일체 금지하며, 번역기 사용이 확인될 시 PO 취소 및 번역료를 지급하지 않습니다.</span></p>
      </td>
    </tr>
    ${row("언어", esc(facts.languages))}
    ${SPACER}
    ${row("분량", esc(facts.volume))}
    ${SPACER}
    ${row("납품일정", `<span ${SPAN_RED}>${esc(facts.deadline)}</span>`)}
    ${SPACER}
    ${row("문서형태", `<span ${SPAN_BOLD}>${documentTypes}</span>`)}
    ${SPACER}
    <tr style="height: 40px;">
      <td style="${CELL_HEAD}">
        <p ${P_CENTER}><span ${SPAN_BOLD}>요청사항</span></p>
      </td>
      <td style="${CELL_BODY}">
        <p ${P}><span ${SPAN_RED}>* 원본 파일 반드시 참고 부탁드립니다.</span></p>
        <p ${P}><span ${SPAN_RED}>* 소스의 태그/형식을 타깃에 동일하게 적용 부탁드립니다.</span></p>
        <p ${P}><span ${SPAN_RED}>* 오역, 맞춤법, 오탈자 등은 꼭 확인 후 제출해 주시기 바랍니다.</span></p>
        ${noteHtml}
      </td>
    </tr>
    ${SPACER}
    ${row("대용량 첨부파일", attachmentCell(choices.attachments), 40)}
  </tbody>
</table>
<p style="font-family: ${FONT}; font-size: 9pt; color: rgb(119, 119, 119); margin: 12px 0px 0px 11px;">첨부파일 링크는 발송일로부터 21일간 유효합니다.</p>
</div>`;

  return { subject: poRequestSubject(facts.poCode, facts.projectName), body };
}
