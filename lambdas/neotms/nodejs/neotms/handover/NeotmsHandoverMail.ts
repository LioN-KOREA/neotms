// SPDX-License-Identifier: MIT
//
// 인계메일의 제목과 본문을 짠다. 데이터베이스도 네트워크도 모르는 **순수 함수** 하나다.
//
// 그렇게 떼어 놓은 이유는 이 파일이 요구사항 문서(인계 기능_261111.docx 3쪽)를 코드로 옮긴
// 유일한 자리이기 때문이다. 양식의 칸 하나하나가 "어디서 가져와 어떤 모양으로 적는다" 는 규칙을
// 달고 있고, 그 규칙은 메일을 실제로 보내 보지 않고 검사할 수 있어야 한다. 전송과 섞여 있으면
// 쉼표 하나를 고칠 때마다 Hiworks 에 로그인해야 한다.
//
// ## 문서가 정한 것, 그대로
//
//   * 제목은 `고객사 / 담당자 / 언어`. 언어는 `출발어-도착어, 도착어` 형식이고, **도착어가 4개
//     이상이면 '다국어'** 로 줄인다.
//   * 본문의 언어 칸은 `출발어 → 도착어`, 여럿이면 `, ` 로 잇는다. 제목과 이음표가 다른 것은
//     오타가 아니라 문서가 두 곳을 다르게 적은 것이다.
//   * 납품요청일은 `mm/dd(요일)`. 언어별 납기가 다르면 줄을 나눠 `언어: 납기` 로 적고, 오전/오후
//     까지 다르면 줄마다 `(오전)` 을 붙인다.
//   * 편집포맷과 레이아웃은 선택지를 **전부 적고 고른 것만 칠한다**(문서의 "클릭으로 색/색없음
//     토글"). 고른 것만 남기면 "WORD" 라고만 적힌 칸이 되는데, 그건 HWP 를 검토했다가 뺀 것인지
//     애초에 묻지 않은 것인지 구분되지 않는다.
//
// ## 문서와 다르게 한 것, 그리고 이유
//
//   * **담당자(거래처 PIC)와 경로는 비운다.** 요청자가 지금은 비워 두라고 했다. `cus_mgr_name`
//     컬럼은 프로젝트에 있으므로 담당자는 한 줄로 되살릴 수 있고, 경로에 해당하는 칸은 이
//     스키마에 아예 없다.
//   * **기타요청에 프로젝트의 내용(`prj_content`)을 넣는다.** 문서는 "비워두고 PM이 쓸 수 있도록"
//     이라고 적었지만, 그건 메일을 **복사해서 붙여넣는** 설계였기 때문이다. 여기서는 메일이 바로
//     나가므로 비워 두면 아무도 채우지 못한다.
//   * **언어쌍에 `?` 를 쓰지 않는다.** 보고서의 `langPair` 는 한쪽이 비면 `?` 를 넣는데(집계는
//     버킷이 필요하다), 메일은 사람이 읽는다. 한쪽만 있으면 있는 쪽만 적는다 - 화면의
//     `jobTypeSummary` 와 같은 처리이고, 메일과 화면이 같은 작업을 같은 글자로 부르는 쪽이
//     메일과 보고서가 같은 글자를 쓰는 것보다 쓸모 있다.

import { isLinguistic } from "../NeotmsJobTypes.js";
import type { ProjectRow } from "../projects/NeotmsProject.dbops.js";
import type { HandoverJob } from "./NeotmsHandover.dbops.js";

/* -------------------------------------------------------------------------- */
/* 선택지                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 편집포맷과 레이아웃. 문서의 양식에 적힌 그대로이고, 순서도 그대로다.
 *
 * `sys_code` 가 아니라 여기 상수인 것이 의도다. 이 일곱 낱말은 **이 메일 양식의 일부**이지
 * 회사의 분류 체계가 아니다 - 유지보수 화면에서 'DTP' 를 지우면 양식의 칸 하나가 사라지고,
 * 이미 보낸 메일들과 모양이 달라진다. 반대로 거래처가 새 포맷을 요구하면 이 배열과 양식을 같이
 * 고치는 것이 맞다.
 *
 * 스키마(`HandoverMailSchema`)의 picklist 가 이 두 배열을 읽으므로, 서버가 받는 값의 집합과
 * 메일에 그려지는 칸은 정의상 같다.
 */
export const HANDOVER_FORMATS = ["WORD", "HWP", "PPT", "EXCEL"] as const;
export const HANDOVER_LAYOUTS = ["보기좋게", "표 병기", "DTP"] as const;

export type HandoverFormat = (typeof HANDOVER_FORMATS)[number];
export type HandoverLayout = (typeof HANDOVER_LAYOUTS)[number];

/** 사용자가 대화상자에서 고른 것. 둘 다 비어 있을 수 없다 - 스키마가 거른다. */
export type HandoverChoices = {
  formats: readonly HandoverFormat[];
  layouts: readonly HandoverLayout[];
};

/** 보낼 메일 한 통. */
export type HandoverMail = { subject: string; html: string };

/* -------------------------------------------------------------------------- */
/* 글자 다루기                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * HTML 로 들어가는 모든 값은 여기를 거친다.
 *
 * 프로젝트명·고객사명·내용은 전부 사용자가 입력한 글자다. `내용` 칸에 `<b>` 를 적어 둔 사람의
 * 메일이 굵게 나오는 정도는 사소하지만, 같은 통로로 `</td><td>` 가 들어오면 양식의 표가 무너져
 * 받는 사람이 다른 칸의 값을 엉뚱한 이름으로 읽는다. 양식의 칸 경계는 이 함수가 지킨다.
 */
const esc = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** 여러 줄짜리 값. 줄바꿈은 살리고 나머지는 이스케이프한다. */
const escLines = (value: string): string => esc(value).replace(/\r?\n/g, "<br>");

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/**
 * `2026-11-13` → `11/13 (금)`.
 *
 * `Date.UTC` 로 만드는 것이 요점이다. `new Date("2026-11-13")` 는 UTC 자정으로 읽히고, 거기에
 * 로컬 시간대를 적용해 요일을 구하면 **UTC 보다 뒤쪽 시간대에서 하루 전 요일**이 나온다. Lambda 가
 * UTC 로 돌아도 개발자 노트북은 KST 이므로, 그런 버그는 테스트에서만 통과한다. 날짜에는 시간대가
 * 없다는 것이 이 스키마의 전제이고(neotms.schemas 머리말), 여기서도 그 전제대로 센다.
 */
function shortDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, y, m, d] = match;
  const day = WEEKDAYS[new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).getUTCDay()];
  return `${m}/${d} (${day})`;
}

/**
 * `13:00:00` → `오후`. 시각이 없으면 null.
 *
 * 없을 때 '오후' 로 때우지 않는다. 문서의 작업 목록 UI 에는 "오후 디폴트" 라는 말이 있지만 그건
 * 사람이 고르는 토글의 기본값이고, 여기는 **기록된 값을 옮기는** 자리다. 적히지 않은 시각을
 * 오후로 적어 보내면 받는 사람에게는 오후로 합의된 것과 구별되지 않는다.
 */
function halfOfDay(time: string | null): string | null {
  const match = /^(\d{2}):/.exec(time ?? "");
  if (!match) return null;
  return Number(match[1]) < 12 ? "오전" : "오후";
}

/* -------------------------------------------------------------------------- */
/* 언어                                                                        */
/* -------------------------------------------------------------------------- */

/** 출발어 하나와 그 출발어에서 나가는 도착어들. 등장 순서를 지킨다. */
type LanguageGroup = { source: string; targets: string[] };

/**
 * 작업들에서 언어쌍을 모은다.
 *
 * 비언어 작업(MICE·IMC)은 **건너뛴다**. 그 작업들에는 언어쌍이 없고, `job_detail_linguistic` 에
 * 행이 없으므로 두 칸 다 null 이다 - 세었다면 빈 쌍이 하나 생겨 언어 칸이 쉼표로 시작했을 것이다.
 *
 * 중복은 없앤다. 한 프로젝트에 같은 언어쌍의 작업이 다섯 건 있는 것은 흔한 일이고(문서 다섯 개를
 * 같은 쌍으로 번역한다), 제목에 같은 언어를 다섯 번 적을 이유는 없다.
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

/** 본문의 언어 칸. `한국어 → 영어, 중국어(간체)`, 출발어가 여럿이면 줄을 나눈다. */
function bodyLanguage(groups: readonly LanguageGroup[]): string {
  const lines = groups.map((g) =>
    [g.source, g.targets.join(", ")].filter((part) => part.length > 0).join(" → "),
  );
  return lines.length > 0 ? lines.map(esc).join("<br>") : "-";
}

/**
 * 제목의 언어 칸. `한국어-영어, 중국어(간체)`.
 *
 * 도착어가 **전부 합쳐** 4개 이상이면 `한국어-다국어` 로 줄인다. 출발어별로 세지 않는 이유는
 * 문서가 "타깃언어가 4개국어 이상일 경우" 라고만 적었기 때문이고, 그 판단이 제목의 길이를
 * 줄이려는 것이므로 - 세 출발어가 각각 셋씩이면 아홉 개가 제목에 들어간다 - 전체로 세는 쪽이
 * 그 목적에 맞는다.
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
/* 납기                                                                        */
/* -------------------------------------------------------------------------- */

/** 납품요청일 칸에 들어가는 것: 날짜 줄(들)과, 전부 같을 때만 정해지는 오전/오후. */
type Deadline = { lines: string[]; half: string | null };

/**
 * 작업들의 납기를 한 칸으로 접는다.
 *
 * 세 가지 모양이 나온다. 전부 같으면 날짜 한 줄 - 가장 흔한 경우다. 날짜가 갈리면 언어별로 줄을
 * 나누고, 거기서 오전/오후까지 갈리면 줄마다 괄호로 붙인다. 문서가 정한 세 단계 그대로다.
 *
 * ## 왜 작업이 아니라 '언어별' 인가
 *
 * 문서가 "언어별 납기" 라고 적었고, 실제로 납기를 가르는 것은 언어다 - 같은 언어의 문서 세 개는
 * 같은 날 나가고, 영어와 베트남어는 다른 날 나간다. 그래서 같은 (언어, 날짜, 시각) 은 한 줄로
 * 합친다. 합치지 않으면 문서가 다섯 개인 프로젝트의 납기 칸이 똑같은 다섯 줄이 된다.
 *
 * 언어가 없는 작업(MICE·IMC)은 작업명으로 적는다. 이름마저 없으면 그 줄은 라벨 없이 날짜만
 * 남는데, 그래도 날짜는 맞다.
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
   * 작업에 납기가 하나도 없으면 프로젝트의 납기로 돌아간다. 문서의 양식도 "프로젝트 정보에서
   * 내역 가져와서" 를 기본값으로 삼으므로, 이건 대체가 아니라 같은 규칙의 바깥쪽 고리다.
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
/* 양식                                                                        */
/* -------------------------------------------------------------------------- */

/*
 * 표의 스타일은 전부 인라인이다. 메일 클라이언트는 `<style>` 블록을 자주 떼어내고(Gmail 은
 * 본문을 다시 쓴다), 떨어져 나가면 칸 선이 사라져 양식이 그냥 줄글이 된다. 보기 싫은 정도가
 * 아니라, 선이 없으면 어느 값이 어느 이름의 것인지 알 수 없다.
 */
const CELL = "border:1px solid #c9ccd4;padding:6px 10px;font-size:13px;vertical-align:middle";
const HEAD = `${CELL};background:#eef0f5;font-weight:700;white-space:nowrap`;
/** 고른 칸. 문서의 "색칠" 이다. 글자색까지 바꾸는 것은 흑백 인쇄에서도 구분되게 하려는 것이다. */
const PICKED = `${CELL};background:#3b57c4;color:#ffffff;font-weight:700;text-align:center`;
const UNPICKED = `${CELL};color:#9aa0ad;text-align:center`;

/** 선택지 한 줄: 전부 적고 고른 것만 칠한다. */
const choiceCells = (all: readonly string[], picked: readonly string[]): string =>
  all
    .map((option) =>
      picked.includes(option)
        ? `<td style="${PICKED}">${esc(option)}</td>`
        : `<td style="${UNPICKED}">${esc(option)}</td>`,
    )
    .join("");

/**
 * 메일 한 통. 인계 기능_261111.docx 3쪽의 양식이 이 함수의 사양이다.
 *
 * 받는 사람은 운영 PM 한 명이고, 보내는 사람은 영업담당자 자신의 Hiworks 계정이다 - 그래서
 * 본문에 서명이나 발신자 정보가 없다. 메일 클라이언트가 이미 둘 다 보여 주고 있다.
 */
export function composeHandoverMail(
  project: ProjectRow,
  jobs: readonly HandoverJob[],
  choices: HandoverChoices,
): HandoverMail {
  const groups = languageGroups(jobs);
  const due = deadlines(jobs, project);

  /*
   * 담당PM 은 작업들의 담당 PM 을 모은 것이고, 하나도 없을 때만 프로젝트의 PM 으로 돌아간다.
   * 문서가 "선택한 건에서 해당되는 PM명" 이라고 적은 그대로다 - 인계는 작업 단위로 일어나므로
   * 프로젝트 헤더의 PM 한 명보다 실제로 그 일을 받는 사람들의 이름이 맞다.
   */
  const jobPms = [...new Set(jobs.map((j) => (j.jobPmName ?? "").trim()).filter(Boolean))];
  const pmNames = jobPms.length > 0 ? jobPms : [(project.prjPmName ?? "").trim()].filter(Boolean);

  /*
   * 제목은 `고객사 / 담당자 / 언어`. 빈 칸은 **빼고** 잇는다 - 담당자를 비워 두기로 했으므로
   * 그대로 이으면 `메타바이오메드 /  / 한국어-영어` 가 되고, 그건 글자가 빠진 제목처럼 보인다.
   *
   * 셋 다 비는 경우가 있다(고객사 이름이 없고 작업에 언어도 없는 프로젝트). 제목 없는 메일은
   * 받은메일함에서 찾을 수 없으므로 프로젝트명으로, 그마저 없으면 코드로 돌아간다.
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
   * 표는 **여섯 열**이다. 가장 넓은 줄이 편집포맷 줄이고(이름 + 소제목 + 선택지 넷), 나머지 줄은
   * 거기에 맞춰 colspan 을 더한다. 줄마다 열 수가 어긋나면 메일 클라이언트가 칸 너비를 제멋대로
   * 잡아 양식이 계단처럼 어긋나 보인다 - 선은 남아 있는데 세로줄이 맞지 않는 표가 된다.
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
