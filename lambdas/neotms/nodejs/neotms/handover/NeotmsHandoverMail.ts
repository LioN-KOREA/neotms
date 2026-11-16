// SPDX-License-Identifier: MIT
//
// Builds the handover mail's subject and body. A single PURE FUNCTION that knows nothing about the
// database or the network.
//
// It is kept separate because this file is the one place where the requirements document (the
// handover spec, page 3) is transcribed into code. Every cell of that form carries a rule about
// where its value comes from and what shape it takes, and those rules have to be checkable without
// sending a mail. Tangled up with the sending, correcting one comma would mean signing in to
// Hiworks first.
//
// ## What the document fixes, kept exactly
//
//   * The subject is `customer / contact / languages`. The language part reads
//     `source-target, target`, and FOUR OR MORE targets collapse to the single word for
//     "multilingual".
//   * The body's language cell reads `source -> target`, several joined with `, `. The subject and
//     the body using different separators is not a typo: the document specifies the two places
//     separately.
//   * Delivery dates read `mm/dd(day)`. Where languages have different deadlines the cell breaks
//     into one line per language, `language: date`; where their morning/afternoon halves differ as
//     well, each line carries its own half in brackets.
//   * The editing format and the layout list EVERY option and colour only the chosen ones (the
//     document's "click to toggle colour / no colour"). Printing only the chosen ones would leave a
//     cell reading "WORD", which cannot be told apart from a form on which the alternatives were
//     never offered.
//
// ## What differs from the document, and why
//
//   * **The client contact and the file path are left blank.** The requester asked for that for
//     now. The contact is one line away - `cus_mgr_name` is already on the project - while the path
//     has no column anywhere in this schema.
//   * **The remarks cell carries the project's own notes (`prj_content`).** The document says to
//     leave it empty for the PM to fill in, but that was written for a COPY-TO-CLIPBOARD flow. Here
//     the mail goes straight out, so an empty cell would stay empty forever.
//   * **No `?` placeholders in a language pair.** The report's `langPair` substitutes `?` for a
//     missing side because an aggregate needs a bucket; a mail is read by a person, so a pair with
//     one side missing prints the side that exists. That matches `jobTypeSummary` on screen, and
//     the mail agreeing with the screen about what one job is called is worth more here than the
//     mail agreeing with the report.

import { isLinguistic } from "../NeotmsJobTypes.js";
import type { ProjectRow } from "../projects/NeotmsProject.dbops.js";
import type { HandoverJob } from "./NeotmsHandover.dbops.js";

/* -------------------------------------------------------------------------- */
/* The options                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The editing formats and the layouts, exactly as the document's form lists them, in its order.
 *
 * Constants here rather than `sys_code` rows, on purpose. These seven words are PART OF THIS MAIL
 * TEMPLATE, not part of the company's taxonomy - delete 'DTP' from the maintenance screen and a
 * cell disappears from a form that has already been sent to people, so old mails and new ones stop
 * matching. If a client ever asks for a new format, the right move is to change this array and the
 * template together.
 *
 * `HandoverMailSchema`'s picklists are built from these two arrays, so the set of values the server
 * accepts and the set of cells the mail draws are the same set by construction.
 */
export const HANDOVER_FORMATS = ["WORD", "HWP", "PPT", "EXCEL"] as const;
export const HANDOVER_LAYOUTS = ["보기좋게", "표 병기", "DTP"] as const;

export type HandoverFormat = (typeof HANDOVER_FORMATS)[number];
export type HandoverLayout = (typeof HANDOVER_LAYOUTS)[number];

/** What the user picked in the dialog. Neither list can be empty - the schema refuses that. */
export type HandoverChoices = {
  formats: readonly HandoverFormat[];
  layouts: readonly HandoverLayout[];
};

/** One mail, ready to send. */
export type HandoverMail = { subject: string; html: string };

/* -------------------------------------------------------------------------- */
/* Text handling                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Everything that reaches the HTML goes through here.
 *
 * The project name, the customer name and the notes are all typed by people. Somebody whose notes
 * contain a bold tag getting a bold mail is trivial; the same opening admitting a closing cell tag
 * collapses the form's table, and then the reader sees real values sitting under the wrong labels.
 * The cell boundaries of the form are what this function protects.
 */
const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A multi-line value: keep the line breaks, escape everything else. */
const escLines = (value: string): string => esc(value).replace(/\r?\n/g, "<br>");

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/**
 * `2026-11-13` becomes `11/13 (Fri)`, with the day name in Korean.
 *
 * Building the date through `Date.UTC` is the whole point. `new Date("2026-11-13")` is UTC
 * midnight, and asking it for a LOCAL weekday in any zone behind UTC answers with the previous
 * day's name. Lambda runs in UTC and so does CI, so that bug is green everywhere except on the
 * reviewer's own machine. A date has no timezone in this schema (see the header of neotms.schemas),
 * and this counts it the same way.
 */
function shortDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, y, m, d] = match;
  const day = WEEKDAYS[new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).getUTCDay()];
  return `${m}/${d} (${day})`;
}

/**
 * `13:00:00` becomes the word for "afternoon"; no time at all returns null.
 *
 * A missing time is NOT filled in with "afternoon". The document mentions an afternoon default, but
 * that is the default of a toggle a person is about to set, whereas this is transcribing a RECORDED
 * value. A time nobody agreed, printed as if agreed, is indistinguishable from one that was.
 */
function halfOfDay(time: string | null): string | null {
  const match = /^(\d{2}):/.exec(time ?? "");
  if (!match) return null;
  return Number(match[1]) < 12 ? "오전" : "오후";
}

/* -------------------------------------------------------------------------- */
/* Languages                                                                  */
/* -------------------------------------------------------------------------- */

/** One source language and the targets reached from it, in the order they first appear. */
type LanguageGroup = { source: string; targets: string[] };

/**
 * Collects the language pairs off the jobs.
 *
 * Non-linguistic jobs (MICE, IMC) are SKIPPED. They have no `job_detail_linguistic` row, so both
 * columns are null; counting them would add an empty pair and the language cell would open with a
 * comma.
 *
 * Duplicates are dropped. One project holding five jobs on the same pair is ordinary - five
 * documents translated the same way - and there is no reason to print that language five times.
 */
export function languageGroups(jobs: readonly HandoverJob[]): LanguageGroup[] {
  const groups: LanguageGroup[] = [];
  for (const job of jobs) {
    if (!isLinguistic(job.jobType)) continue;
    const source = (job.jobSlang ?? "").trim();
    const target = (job.jobElang ?? "").trim();
    if (!source && !target) continue;
    let group = groups.find((g) => g.source === source);
    if (!group) {
      group = { source, targets: [] };
      groups.push(group);
    }
    if (target && !group.targets.includes(target)) group.targets.push(target);
  }
  return groups;
}

/** The body's language cell: `source -> t1, t2`, one line per source language. */
function bodyLanguage(groups: readonly LanguageGroup[]): string {
  const lines = groups.map((g) =>
    [g.source, g.targets.join(", ")].filter((part) => part.length > 0).join(" → "),
  );
  return lines.length > 0 ? lines.map(esc).join("<br>") : "-";
}

/**
 * The subject's language part: `source-t1, t2`.
 *
 * Four or more targets IN TOTAL collapse to the one word for "multilingual". Counting across all
 * groups rather than per source is deliberate: the document says only "when there are four or more
 * target languages", and the rule exists to keep the subject short - three sources with three
 * targets each would otherwise put nine languages in a subject line.
 */
function subjectLanguage(groups: readonly LanguageGroup[]): string {
  const distinctTargets = new Set(groups.flatMap((g) => g.targets));
  const many = distinctTargets.size >= 4;
  return groups
    .map((g) => {
      const targets = many ? "다국어" : g.targets.join(", ");
      return [g.source, targets].filter((part) => part.length > 0).join("-");
    })
    .join(", ");
}

/* -------------------------------------------------------------------------- */
/* Deadlines                                                                  */
/* -------------------------------------------------------------------------- */

/** What goes in the delivery-date cell: the date line(s), and the half only when it is uniform. */
type Deadline = { lines: string[]; half: string | null };

/**
 * Folds the jobs' deadlines into one cell.
 *
 * Three shapes come out. All identical gives a single date line, which is the common case. Dates
 * differing splits into one line per language. Halves differing on top of that appends each line's
 * own half in brackets. Those are the document's three steps.
 *
 * ## Why per LANGUAGE rather than per job
 *
 * The document says "a deadline per language", and language is what actually splits a deadline in
 * practice - three documents in the same language ship together, while English and Vietnamese do
 * not. So identical (language, date, time) triples collapse into one line. Without that, a project
 * holding five documents would show five identical deadline lines.
 *
 * Jobs with no language (MICE, IMC) are labelled with the job name instead. With no name either,
 * the line keeps the date and loses the label - and the date is still correct.
 */
export function deadlines(
  jobs: readonly HandoverJob[],
  project: Pick<ProjectRow, "prjEday" | "prjEdayTime">,
): Deadline {
  const entries: { label: string; eday: string; time: string | null }[] = [];
  for (const job of jobs) {
    const eday = (job.jobEday ?? "").trim();
    if (!eday) continue;
    const label = isLinguistic(job.jobType)
      ? [job.jobSlang, job.jobElang].filter(Boolean).join(" → ")
      : (job.jobName ?? "").trim();
    const time = job.jobEdayTime ?? null;
    if (entries.some((e) => e.label === label && e.eday === eday && e.time === time)) continue;
    entries.push({ label, eday, time });
  }

  /*
   * With no job carrying a deadline, fall back to the project's. The document's own form takes its
   * defaults "from the project information", so this is the outer ring of one rule rather than a
   * substitute for it.
   */
  if (entries.length === 0) {
    const eday = (project.prjEday ?? "").trim();
    return eday
      ? { lines: [shortDate(eday)], half: halfOfDay(project.prjEdayTime) }
      : { lines: [], half: null };
  }

  const sameDate = entries.every((e) => e.eday === entries[0]!.eday);
  const sameTime = entries.every((e) => e.time === entries[0]!.time);
  if (sameDate && sameTime) {
    return { lines: [shortDate(entries[0]!.eday)], half: halfOfDay(entries[0]!.time) };
  }

  const lines = entries.map((e) => {
    const half = sameTime ? null : halfOfDay(e.time);
    const date = `${shortDate(e.eday)}${half ? `(${half})` : ""}`;
    return e.label ? `${e.label}: ${date}` : date;
  });
  return { lines, half: sameTime ? halfOfDay(entries[0]!.time) : null };
}

/* -------------------------------------------------------------------------- */
/* The form                                                                   */
/* -------------------------------------------------------------------------- */

/*
 * Every style is inline. Mail clients routinely strip a `<style>` block - Gmail rewrites the body -
 * and once it is gone the cell borders go with it and the form reads as a run of prose. That is not
 * merely ugly: without the rules, nothing says which value belongs to which label.
 */
const CELL = "border:1px solid #c9ccd4;padding:6px 10px;font-size:13px;vertical-align:middle";
const HEAD = `${CELL};background:#eef0f5;font-weight:700;white-space:nowrap`;
/**
 * A chosen cell - the document's "coloured". The text colour changes too, so the distinction
 * survives a black-and-white print.
 */
const PICKED = `${CELL};background:#3b57c4;color:#ffffff;font-weight:700;text-align:center`;
const UNPICKED = `${CELL};color:#9aa0ad;text-align:center`;

/** One row of options: print them all, colour the chosen ones. */
const choiceCells = (all: readonly string[], picked: readonly string[]): string =>
  all
    .map((option) =>
      picked.includes(option)
        ? `<td style="${PICKED}">${esc(option)}</td>`
        : `<td style="${UNPICKED}">${esc(option)}</td>`,
    )
    .join("");

/**
 * One mail. Page 3 of the handover spec is this function's specification.
 *
 * It goes to a single operating PM, from the sales manager's own Hiworks account - which is why
 * there is no signature and no sender block in the body. The mail client already shows both.
 */
export function composeHandoverMail(
  project: ProjectRow,
  jobs: readonly HandoverJob[],
  choices: HandoverChoices,
): HandoverMail {
  const groups = languageGroups(jobs);
  const due = deadlines(jobs, project);

  /*
   * The PM cell collects the jobs' own PMs, and falls back to the project's PM only when no job
   * names one. That is what the document means by "the PM names from the selected items": a
   * handover happens per job, so the people actually receiving the work are more use here than the
   * single PM on the project header.
   */
  const jobPms = [...new Set(jobs.map((j) => (j.jobPmName ?? "").trim()).filter(Boolean))];
  const pmNames = jobPms.length > 0 ? jobPms : [(project.prjPmName ?? "").trim()].filter(Boolean);

  /*
   * The subject is `customer / contact / languages`, with EMPTY PARTS DROPPED rather than joined.
   * The contact is deliberately blank for now, and joining regardless would produce
   * `Acme / / ko-en`, which reads as a subject with a word missing rather than as a field left
   * empty on purpose.
   *
   * All three can be empty - a project with no customer name whose jobs carry no language. A mail
   * with no subject cannot be found in an inbox afterwards, so it falls back to the project name
   * and then to the code, which always exists.
   */
  const clientContact = "";
  const subject =
    [(project.cusCodeName ?? "").trim(), clientContact, subjectLanguage(groups)]
      .filter((part) => part.length > 0)
      .join(" / ") ||
    (project.prjName ?? "").trim() ||
    project.prjCode;

  const dueLines = due.lines.length > 0 ? due.lines.map(esc).join("<br>") : "-";
  const half = due.half;

  /*
   * The table is SIX COLUMNS wide. The widest row is the editing-format one (label + sub-heading +
   * four options), and every other row adds colspan to match. Rows whose column counts disagree
   * make the client guess widths, and the form comes out as a staircase - borders present,
   * verticals not lining up.
   */
  const html = `<div style="font-family:'Malgun Gothic',AppleSDGothicNeo-Regular,sans-serif;color:#1b1d22">
<p style="font-size:13px;margin:0 0 12px">아래 프로젝트를 인계합니다.</p>
<table cellspacing="0" cellpadding="0" style="border-collapse:collapse;min-width:520px">
<tr>
  <td style="${HEAD}">거래처 / 담당자</td>
  <td style="${CELL}" colspan="3">${esc((project.cusCodeName ?? "").trim()) || "-"}</td>
  <td style="${CELL}" colspan="2">${esc(clientContact)}</td>
</tr>
<tr>
  <td style="${HEAD}">담당영업 / 담당PM</td>
  <td style="${CELL}" colspan="3">${esc((project.prjMgrName ?? "").trim()) || "-"}</td>
  <td style="${CELL}" colspan="2">${esc(pmNames.join(", ")) || "-"}</td>
</tr>
<tr>
  <td style="${HEAD}">프로젝트코드</td>
  <td style="${CELL}" colspan="5">${esc(project.prjCode)}</td>
</tr>
<tr>
  <td style="${HEAD}">언어</td>
  <td style="${CELL}" colspan="5">${bodyLanguage(groups)}</td>
</tr>
<tr>
  <td style="${HEAD}">경로</td>
  <td style="${CELL}" colspan="5"></td>
</tr>
<tr>
  <td style="${HEAD}">납품요청일</td>
  <td style="${CELL}" colspan="3">${dueLines}</td>
  <td style="${half === "오전" ? PICKED : UNPICKED}">오전</td>
  <td style="${half === "오후" ? PICKED : UNPICKED}">오후</td>
</tr>
<tr>
  <td style="${HEAD}" rowspan="2">납품형태</td>
  <td style="${HEAD}">편집포맷</td>
  ${choiceCells(HANDOVER_FORMATS, choices.formats)}
</tr>
<tr>
  <td style="${HEAD}">레이아웃</td>
  ${choiceCells(HANDOVER_LAYOUTS, choices.layouts)}
  <td style="${CELL}"></td>
</tr>
<tr>
  <td style="${HEAD}">기타요청</td>
  <td style="${CELL}" colspan="5">${escLines((project.prjContent ?? "").trim()) || "-"}</td>
</tr>
</table>
</div>`;

  return { subject, html };
}
