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
  const order = [...rest.slice(0, at), ...slots.filter((s) => movingSet.has(s)), ...rest.slice(at)]
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
