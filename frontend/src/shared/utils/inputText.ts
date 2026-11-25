/**
 * 입력칸 글자 다루기 — 24시간 시각, 세 자리 쉼표 숫자.
 *
 * 화면 코드(DOM)를 가져오지 않는다 — 서버 쪽 테스트가 그대로 시험한다.
 */

/**
 * 적은 글자를 `HH:MM` 으로. 알아볼 수 없으면 null, 비었으면 ''.
 *   23 → 23:00 · 9 → 09:00 · 930 → 09:30 · 2330 → 23:30 · 9:5 → 09:05 · 18.30 → 18:30
 */
export function parseTimeText(text: string): string | null {
  const t = text.trim()
  if (t === '') return ''
  let h: number
  let m: number
  const parts = /^(\d{1,2})\s*[:.\s]\s*(\d{1,2})$/.exec(t)
  if (parts) {
    h = Number(parts[1])
    m = Number(parts[2])
  } else if (/^\d{1,2}$/.test(t)) {
    h = Number(t)
    m = 0
  } else if (/^\d{3,4}$/.test(t)) {
    h = Number(t.slice(0, t.length - 2))
    m = Number(t.slice(-2))
  } else return null
  if (h > 23 || m > 59) return null
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** 한 시간 앞뒤로. 분은 그대로, 00시·23시에서 멈춘다. 비어 있으면 `fallback` 의 시(時)에서 시작. */
export function shiftHour(value: string, delta: number, fallback: string): string {
  const base = parseTimeText(value) || parseTimeText(fallback) || '09:00'
  const h = Math.min(23, Math.max(0, Number(base.slice(0, 2)) + (value ? delta : 0)))
  const m = value ? base.slice(3) : '00'
  return `${String(h).padStart(2, '0')}:${m}`
}

/** 숫자 글자에서 쉼표·공백을 뺀다 (저장·계산용). */
export const stripNumberText = (text: string) => text.replace(/[,\s]/g, '')

/**
 * 세 자리 쉼표를 넣어 보여 준다. 정수 부분만 묶고 소수 부분은 적은 그대로.
 * 숫자가 아닌 글자는 버린다 (부호 `-` 와 소수점 하나는 남김).
 */
export function groupNumberText(text: string): string {
  let raw = stripNumberText(text).replace(/[^\d.-]/g, '')
  const negative = raw.startsWith('-')
  raw = raw.replace(/-/g, '')
  const dot = raw.indexOf('.')
  const int = dot < 0 ? raw : raw.slice(0, dot)
  const frac = dot < 0 ? null : raw.slice(dot + 1).replace(/\./g, '')
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${grouped}${frac === null ? '' : `.${frac}`}`
}
