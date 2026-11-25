/**
 * 빈 줄(자유 입력 행)과 행 자리.
 *
 * 시트는 스프레드시트처럼 '자리(0, 1, 2 …)' 가 줄지어 있고, 각 자리에는 작업 행·글을 적은 빈 줄·
 * 아무것도 없는 빈 줄 중 하나가 있다 (팀장님 2026-11-25).
 *   * 작업 행의 자리는 `pm_sheet_row.ord_no`.
 *   * 글을 적은 빈 줄은 개인 설정 `prefs.view.freeRows` ({ pos, values }) — 작업이 아니라 DB 의
 *     칸 표(job_id 필수)에는 넣을 수 없다. 그래서 DB 구조는 바꾸지 않았다.
 *   * 새로 인계 받은 작업(ord_no 없음)은 **아무것도 적히지 않은 첫 자리**에 들어간다.
 *
 * 이 파일은 화면 코드를 가져오지 않는다 — 서버 테스트가 그대로 시험한다.
 */
import type { PmFreeRow } from '../../apis/pmsheet.types'

/** 맨 아래에 늘 보이는 빈 줄 수. */
export const BLANK_TAIL = 30

export const freeRowId = (pos: number) => `f:${String(pos)}`
export const isFreeRowId = (id: string) => id.startsWith('f:')
export const freePosOf = (id: string) => Number(id.slice(2))

/** 값이 하나라도 적힌 빈 줄만. */
export const liveFreeRows = (rows: readonly PmFreeRow[] | undefined): PmFreeRow[] =>
  (rows ?? []).filter((r) => Number.isInteger(r.pos) && r.pos >= 0 && Object.values(r.values ?? {}).some((v) => v.trim() !== ''))

/**
 * 작업 행의 자리를 정한다. `jobs` 는 서버 순서(ord_no → 인계일).
 *   1. ord_no 가 있고 그 자리가 비어 있으면 그대로.
 *   2. ord_no 가 없거나 자리가 겹치면, 글이 적힌 빈 줄·다른 작업이 없는 가장 앞 자리로.
 * `moves` 는 서버에 저장해야 할 자리 변경(ord_no 가 달라진 작업).
 */
export function layoutPositions(
  jobs: readonly { jobId: string; ordNo: number | null }[],
  freeRows: readonly PmFreeRow[],
): { posOf: Map<string, number>; moves: { jobId: string; pos: number }[] } {
  const taken = new Set(liveFreeRows(freeRows).map((r) => r.pos))
  const posOf = new Map<string, number>()
  const later: string[] = []
  for (const job of jobs) {
    if (job.ordNo !== null && job.ordNo >= 0 && !taken.has(job.ordNo)) {
      posOf.set(job.jobId, job.ordNo)
      taken.add(job.ordNo)
    } else later.push(job.jobId)
  }
  let cursor = 0
  for (const jobId of later) {
    while (taken.has(cursor)) cursor += 1
    posOf.set(jobId, cursor)
    taken.add(cursor)
  }
  const moves = jobs.filter((j) => posOf.get(j.jobId) !== j.ordNo).map((j) => ({ jobId: j.jobId, pos: posOf.get(j.jobId)! }))
  return { posOf, moves }
}

/** 빈 줄 한 칸을 고친 결과. 값이 다 지워진 줄은 목록에서 뺀다. */
export function setFreeValue(rows: readonly PmFreeRow[], pos: number, colKey: string, value: string): PmFreeRow[] {
  const out = rows.map((r) => ({ pos: r.pos, values: { ...r.values } }))
  let row = out.find((r) => r.pos === pos)
  if (!row) {
    row = { pos, values: {} }
    out.push(row)
  }
  if (value.trim() === '') delete row.values[colKey]
  else row.values[colKey] = value
  return liveFreeRows(out).sort((a, b) => a.pos - b.pos)
}

/**
 * 행 끌어 옮기기. `slots` 는 화면 순서의 자리 목록(작업 id 또는 'f:자리'), `moving` 은 옮기는 행,
 * `target`·`before` 는 놓은 곳. 결과: 작업마다 새 자리, 빈 줄 목록.
 * 빈 자리(글 없는 빈 줄)도 하나의 자리로 센다 — 스프레드시트에서 행을 끼워 넣는 것과 같다.
 */
export function reorderSlots(
  slots: readonly string[],
  moving: readonly string[],
  target: string,
  before: boolean,
  freeRows: readonly PmFreeRow[],
): { jobPos: Map<string, number>; freeRows: PmFreeRow[] } {
  const movingSet = new Set(moving)
  const rest = slots.filter((s) => !movingSet.has(s))
  let at = rest.indexOf(target)
  if (at < 0) at = rest.length
  else if (!before) at += 1
  return applySlots([...rest.slice(0, at), ...slots.filter((s) => movingSet.has(s)), ...rest.slice(at)], freeRows)
}

/* ----------------------------------------------------------------------------------------------- */
/* 자리 편집 — 행 추가·삭제, 통합·해제 (팀장님 2026-11-25)                                              */
/* ----------------------------------------------------------------------------------------------- */

/**
 * 시트의 모든 자리(0 … 마지막 자리)를 순서대로: 그 자리의 작업 id, 아니면 'f:자리'(빈 줄).
 * 필터·정렬과 상관없이 저장된 자리 그대로다 — 자리 편집은 늘 이것으로 한다.
 */
export function slotsOf(posOf: ReadonlyMap<string, number>, freeRows: readonly PmFreeRow[]): string[] {
  const live = liveFreeRows(freeRows)
  const last = Math.max(-1, ...posOf.values(), ...live.map((r) => r.pos))
  const out: string[] = []
  for (let i = 0; i <= last; i += 1) out.push(freeRowId(i))
  for (const [jobId, pos] of posOf) if (pos >= 0 && pos <= last) out[pos] = jobId
  return out
}

/** 자리 목록(`order`)을 그대로 새 자리로 — 작업마다 새 자리, 글이 있는 빈 줄은 새 자리로 옮긴다. */
export function applySlots(order: readonly string[], freeRows: readonly PmFreeRow[]): { jobPos: Map<string, number>; freeRows: PmFreeRow[] } {
  const byPos = new Map(liveFreeRows(freeRows).map((r) => [r.pos, r]))
  const jobPos = new Map<string, number>()
  const nextFree: PmFreeRow[] = []
  order.forEach((id, i) => {
    if (isFreeRowId(id)) {
      const row = byPos.get(freePosOf(id))
      if (row) nextFree.push({ pos: i, values: row.values })
    } else jobPos.set(id, i)
  })
  return { jobPos, freeRows: nextFree }
}

/** `at` 자리에 빈 줄 `count` 개를 끼워 넣는다 (아래 행은 밀려 내려간다). */
export function insertSlots(slots: readonly string[], at: number, count = 1): string[] {
  const i = Math.max(0, Math.min(at, slots.length))
  return [...slots.slice(0, i), ...Array.from({ length: count }, () => 'f:-1'), ...slots.slice(i)]
}

/** 자리들을 지운다 (아래 행이 올라온다). */
export function removeSlots(slots: readonly string[], ids: readonly string[]): string[] {
  const gone = new Set(ids)
  return slots.filter((s) => !gone.has(s))
}

/** `ids` 를 `after` 바로 아래에 차례로 넣는다 (이미 목록에 있으면 그 자리에서 빼고). */
export function placeAfter(slots: readonly string[], after: string, ids: readonly string[]): string[] {
  const rest = removeSlots(slots, ids)
  const at = rest.indexOf(after)
  return at < 0 ? [...rest, ...ids] : [...rest.slice(0, at + 1), ...ids, ...rest.slice(at + 1)]
}

/** 열 이름(엑셀식): 0 → A, 25 → Z, 26 → AA. */
export function columnLetter(index: number): string {
  let n = index + 1
  let s = ''
  while (n > 0) {
    const r = (n - 1) % 26
    s = String.fromCharCode(65 + r) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** 'YYYY-MM-DD' 를 `days` 만큼 옮긴다 (달·해 넘김 포함). 날짜가 아니면 null. */
export function shiftYmd(ymd: string, days: number): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days))
  return d.toISOString().slice(0, 10)
}
