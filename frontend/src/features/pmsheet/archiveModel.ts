/**
 * '완료 업무' 시트의 묶음 줄 (팀장님 2026-11-26).
 *
 *   * 행은 인계일 순(인계일이 없으면 옮긴 때).
 *   * 'yyyy년 mm월' 라벨 줄이 그 달의 행을 묶는다 — 그 달의 행이 들어오면 저절로 생긴다.
 *   * 올해가 지난 해는 'yyyy년 상반기 / 하반기' 줄이 한 단계 위에서 1~6월 · 7~12월 라벨을 묶는다.
 *   * 라벨 줄은 [+]/[−] 로 접고 편다(접힌 줄의 아래는 보이지 않는다).
 *
 * 이 파일은 화면 코드를 가져오지 않는다 — 서버 테스트가 그대로 시험한다.
 */

export interface ArchiveLike {
  id: string
  handoverAt: string | null
  archivedAt: string
}

export type ArchiveLine<T extends ArchiveLike> =
  | { kind: 'half'; id: string; label: string; count: number; depth: 0 }
  | { kind: 'month'; id: string; label: string; count: number; depth: 0 | 1; parent: string | null }
  | { kind: 'row'; id: string; row: T; no: number; parents: string[] }

/** ISO 시각의 한국 날짜의 연·월. */
export function kstYearMonth(iso: string): { year: number; month: number } | null {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const d = new Date(t + 9 * 3600_000)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }
}

export const halfId = (year: number, month: number) => `h:${String(year)}-${month <= 6 ? '1' : '2'}`
export const monthId = (year: number, month: number) => `m:${String(year)}-${String(month).padStart(2, '0')}`

/** 줄 목록을 만든다. `thisYear` 보다 앞선 해만 반기 줄이 생긴다. */
export function archiveLines<T extends ArchiveLike>(rows: readonly T[], thisYear: number): ArchiveLine<T>[] {
  const dated = rows
    .map((row) => ({ row, ym: kstYearMonth(row.handoverAt ?? row.archivedAt) ?? { year: thisYear, month: 1 }, at: row.handoverAt ?? row.archivedAt }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.row.id < b.row.id ? -1 : 1))
  const out: ArchiveLine<T>[] = []
  const counts = new Map<string, number>()
  for (const { ym } of dated) {
    const m = monthId(ym.year, ym.month)
    counts.set(m, (counts.get(m) ?? 0) + 1)
    if (ym.year < thisYear) {
      const h = halfId(ym.year, ym.month)
      counts.set(h, (counts.get(h) ?? 0) + 1)
    }
  }
  let half: string | null = null
  let month: string | null = null
  let no = 0
  for (const { row, ym } of dated) {
    const past = ym.year < thisYear
    const h = past ? halfId(ym.year, ym.month) : null
    if (h && h !== half) {
      half = h
      out.push({ kind: 'half', id: h, label: `${String(ym.year)}년 ${ym.month <= 6 ? '상반기' : '하반기'}`, count: counts.get(h) ?? 0, depth: 0 })
    }
    if (!h) half = null
    const m = monthId(ym.year, ym.month)
    if (m !== month) {
      month = m
      out.push({
        kind: 'month',
        id: m,
        label: `${String(ym.year)}년 ${String(ym.month).padStart(2, '0')}월`,
        count: counts.get(m) ?? 0,
        depth: h ? 1 : 0,
        parent: h,
      })
    }
    no += 1
    out.push({ kind: 'row', id: row.id, row, no, parents: h ? [h, m] : [m] })
  }
  return out
}

/** 접힌 묶음을 빼고 보이는 줄만. */
export function visibleLines<T extends ArchiveLike>(lines: readonly ArchiveLine<T>[], collapsed: ReadonlySet<string>): ArchiveLine<T>[] {
  return lines.filter((line) => {
    if (line.kind === 'half') return true
    if (line.kind === 'month') return !(line.parent && collapsed.has(line.parent))
    return !line.parents.some((p) => collapsed.has(p))
  })
}

/** 처음 열 때 접어 둘 묶음 — 지난해의 반기 줄. 올해의 달은 펼친다. */
export function defaultCollapsed<T extends ArchiveLike>(lines: readonly ArchiveLine<T>[]): Set<string> {
  return new Set(lines.filter((l) => l.kind === 'half').map((l) => l.id))
}
