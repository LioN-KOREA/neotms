// SPDX-License-Identifier: MIT
//
// 인계 비고 — 인계정보 입력 창의 답을 받는 PM 의 '나의 업무' 비고 칸 글로 (팀장님 2026-11-25).
//
//   * WORD, HWP / 보기좋게
//   * 분량 3,000단어
//   <abc@lion-korea.com>
//
// - 첫 줄: 편집포맷(고른 것 + 직접 입력) / 레이아웃(고른 것 + 직접 입력). 한쪽이 비면 다른 쪽만.
// - 기타요청은 줄마다 '* ' 항목 하나. 빈 줄은 버린다.
// - 이메일 주소는 < > 로 감싼다. 주소만 있는 줄에는 '*' 를 붙이지 않는다.
//
// 인계가 받아지면(재인계는 '확인') 비고에 들어간다 — 새 인계는 이 글로, 재인계는 기존 비고 아래에
// '<재인계 비고>' 머리를 달고 덧붙인다 (`appendRehandoverRemark`).

const EMAIL = /<?([^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+)>?/g;

/** 줄 안의 이메일 주소를 모두 `<주소>` 로. 이미 괄호가 있으면 그대로. */
export function bracketEmails(line: string): string {
  return line.replace(EMAIL, (_m, addr: string) => `<${addr}>`);
}

/** 주소(`<…>`)와 구분 기호만 있는 줄인가. */
function onlyEmails(line: string): boolean {
  const rest = line.replace(/<[^\s<>@]+@[^\s<>]+>/g, "").replace(/[\s,;]/g, "");
  return rest.length === 0 && line.includes("@");
}

export function composeHandoverRemark(input: {
  formats: readonly string[];
  formatText?: string;
  layouts: readonly string[];
  layoutText?: string;
  note?: string;
}): string {
  const join = (picked: readonly string[], typed?: string) =>
    [...picked, (typed ?? "").trim()].filter((s) => s.length > 0).join(", ");
  const head = [join(input.formats, input.formatText), join(input.layouts, input.layoutText)]
    .filter((s) => s.length > 0)
    .join(" / ");
  const lines: string[] = head ? [`* ${head}`] : [];
  for (const raw of (input.note ?? "").split(/\r?\n/)) {
    // 사용자가 직접 붙인 글머리(*, -, •)는 떼고 우리 것 하나만.
    const text = raw.trim().replace(/^[*\-•·]\s*/, "").trim();
    if (!text) continue;
    const line = bracketEmails(text);
    lines.push(onlyEmails(line) ? line : `* ${line}`);
  }
  return lines.join("\n");
}

export const REHANDOVER_HEAD = "<재인계 비고>";

/** 재인계 확인 때 — 기존 비고 아래에 머리 한 줄과 새 비고. 새 비고가 비면 그대로. */
export function appendRehandoverRemark(current: string | null | undefined, added: string | null | undefined): string | null {
  const next = (added ?? "").trim();
  if (!next) return null;
  const before = (current ?? "").replace(/\s+$/, "");
  return before ? `${before}\n${REHANDOVER_HEAD}\n${next}` : `${REHANDOVER_HEAD}\n${next}`;
}
