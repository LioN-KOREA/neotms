/** 작업별 마지막 인계, 그리고 인계 여부 칸의 일시 모양 (팀장님 2026-11-25). */
export function latestHandoverByJob<H extends { id: string; jobId: string }>(list: readonly H[] | undefined): Map<string, H> {
  const latest = new Map<string, H>()
  for (const h of list ?? []) {
    const prev = latest.get(h.jobId)
    if (!prev || Number(h.id) > Number(prev.id)) latest.set(h.jobId, h)
  }
  return latest
}

const WEEK = ['일', '월', '화', '수', '목', '금', '토']

/** `25/11/25(화) 14:30` — 한국 시간. */
export function handoverStamp(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const k = new Date(t.getTime() + 9 * 3600_000)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(k.getUTCFullYear() % 100)}/${p2(k.getUTCMonth() + 1)}/${p2(k.getUTCDate())}(${WEEK[k.getUTCDay()]}) ${p2(k.getUTCHours())}:${p2(k.getUTCMinutes())}`
}

/** 물량·단가 — 소수점 아래가 모두 0이면 지우고, 세 자리마다 쉼표. 숫자가 아니면 그대로. */
export function tidyNumber(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return ''
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value).trim().replace(/,/g, ''))
  if (!m) return String(value)
  const int = m[2]!.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = m[3] && /[1-9]/.test(m[3]) ? `.${m[3]}` : ''
  return `${m[1]}${int}${frac}`
}
