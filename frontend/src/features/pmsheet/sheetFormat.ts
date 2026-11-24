/**
 * 시트의 값 형식 — 날짜·시각·숫자.
 *
 * 기획서 요구:
 *   * 날짜는 `1113`, `11/13`, `11.13`, `11-13` 등으로 쳐도 `11/13(금)` 으로 보인다.
 *   * 시간 칸은 1~24 숫자.
 *   * 숫자는 기본 `0,000` 형식, 소수 자리는 사용자가 정한다.
 *
 * 저장은 언제나 기계가 읽는 형태(`YYYY-MM-DD`, `HH:MM`, `12000.5`)로 하고, 보이는 형태는 여기서
 * 만든다. 그래야 정렬·조건부 서식·수식이 보이는 글자가 아니라 값을 비교한다.
 */

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

const pad2 = (n: number) => String(n).padStart(2, '0')

/** 오늘 날짜 `YYYY-MM-DD` (브라우저 시간대 = 한국). */
export function todayYmd(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`
}

function validYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const date = new Date(y, m - 1, d)
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null
  return `${y}-${pad2(m)}-${pad2(d)}`
}

/**
 * 월·일만 적었을 때의 연도 — **오늘에서 가장 가까운 해.**
 *
 * 12월에 `0105` 를 적은 사람은 내년 1월을, 1월에 `1228` 을 적은 사람은 작년 12월을 뜻한다.
 * 올해로 고정하면 연말·연초마다 납기가 1년 어긋나고, 그 칸은 "지난 날짜" 파란색으로 칠해진다.
 */
function nearestYear(m: number, d: number, now: Date): number | null {
  const y = now.getFullYear()
  let best: number | null = null
  let bestGap = Infinity
  for (const cand of [y - 1, y, y + 1]) {
    if (!validYmd(cand, m, d)) continue
    const gap = Math.abs(new Date(cand, m - 1, d).getTime() - now.getTime())
    if (gap < bestGap) {
      best = cand
      bestGap = gap
    }
  }
  return best
}

export type Parsed = { ok: true; value: string } | { ok: false; reason: string }

/**
 * 사람이 적은 날짜를 `YYYY-MM-DD` 로. 빈 값은 성공(지우기).
 *
 * 받는 형태: `mmdd`, `m/d`, `mm.dd`, `mm-dd`, `yymmdd`, `yyyymmdd`, `yy-mm-dd`, `yyyy-mm-dd`,
 * 그리고 뒤에 `(금)` 같은 요일이 붙은 것(이 시트가 보여 주는 형태를 그대로 다시 받을 수 있게).
 *
 * `bareDigits` 가 false 이면 구분자 없는 숫자(`1113`)는 날짜로 읽지 않는다 — 날짜 열이 아닌
 * 자유 입력 열에서 `1113` 은 숫자일 가능성이 더 크기 때문이다.
 */
export function parseSheetDate(text: string, bareDigits = true, now: Date = new Date()): Parsed {
  const t = text
    .trim()
    .replace(/\s*\([월화수목금토일]\)\s*$/, '')
    .replace(/\.$/, '')
    .trim()
  if (t.length === 0) return { ok: true, value: '' }

  let m: RegExpExecArray | null
  let y: number | null = null
  let mo: number
  let d: number

  if ((m = /^(\d{4})[-./\s](\d{1,2})[-./\s](\d{1,2})$/.exec(t))) {
    y = Number(m[1])
    mo = Number(m[2])
    d = Number(m[3])
  } else if ((m = /^(\d{2})[-./\s](\d{1,2})[-./\s](\d{1,2})$/.exec(t))) {
    y = 2000 + Number(m[1])
    mo = Number(m[2])
    d = Number(m[3])
  } else if ((m = /^(\d{1,2})[-./](\d{1,2})$/.exec(t))) {
    mo = Number(m[1])
    d = Number(m[2])
  } else if (bareDigits && (m = /^(\d{8})$/.exec(t))) {
    y = Number(t.slice(0, 4))
    mo = Number(t.slice(4, 6))
    d = Number(t.slice(6, 8))
  } else if (bareDigits && (m = /^(\d{6})$/.exec(t))) {
    y = 2000 + Number(t.slice(0, 2))
    mo = Number(t.slice(2, 4))
    d = Number(t.slice(4, 6))
  } else if (bareDigits && (m = /^(\d{3,4})$/.exec(t))) {
    const s = t.padStart(4, '0')
    mo = Number(s.slice(0, 2))
    d = Number(s.slice(2, 4))
  } else {
    return { ok: false, reason: `'${text}' 는 날짜로 읽을 수 없습니다. (예: 1113, 11/13, 2026-11-13)` }
  }

  const year = y ?? nearestYear(mo, d, now)
  const value = year === null ? null : validYmd(year, mo, d)
  if (!value) return { ok: false, reason: `'${text}' 는 없는 날짜입니다.` }
  return { ok: true, value }
}

/** `YYYY-MM-DD` → `11/13(금)`. 올해가 아니면 앞에 연도 두 자리를 붙인다 (`25/11/13(목)`). */
export function formatSheetDate(ymd: string | null | undefined, now: Date = new Date()): string {
  if (!ymd) return ''
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd)
  if (!m) return ymd
  const y = Number(m[1])
  const date = new Date(y, Number(m[2]) - 1, Number(m[3]))
  const head = y === now.getFullYear() ? '' : `${String(y).slice(2)}/`
  return `${head}${m[2]}/${m[3]}(${WEEKDAYS[date.getDay()]})`
}

/** 값이 날짜(`YYYY-MM-DD`)로 저장된 것인지. 자유 입력 열에서 날짜를 알아보는 데 쓴다. */
export const isYmd = (value: string | null | undefined): value is string =>
  !!value && /^\d{4}-\d{2}-\d{2}$/.test(value)

/**
 * 시간 칸: `1`~`24` → `HH:MM`. 24 는 `23:59` 로 저장한다 — 서버의 시각 형식이 00~23 시만
 * 받기 때문이고, 보일 때는 다시 24 로 보인다(`formatHour`). `17:30` 같은 시각도 받는다.
 */
export function parseHour(text: string): Parsed {
  const t = text.trim().replace(/시$/, '')
  if (t.length === 0) return { ok: true, value: '' }
  let m: RegExpExecArray | null
  if ((m = /^(\d{1,2})$/.exec(t))) {
    const h = Number(m[1])
    if (h < 1 || h > 24) return { ok: false, reason: '시간은 1~24 사이 숫자로 적어 주세요.' }
    return { ok: true, value: h === 24 ? '23:59' : `${pad2(h)}:00` }
  }
  if ((m = /^(\d{1,2}):(\d{2})$/.exec(t))) {
    const h = Number(m[1])
    const mi = Number(m[2])
    if (h > 23 || mi > 59) return { ok: false, reason: `'${text}' 는 없는 시각입니다.` }
    return { ok: true, value: `${pad2(h)}:${pad2(mi)}` }
  }
  return { ok: false, reason: '시간은 1~24 사이 숫자로 적어 주세요.' }
}

/** `HH:MM` → `17` (정각이면 시만), `17:30`, `23:59` → `24`. */
export function formatHour(hhmm: string | null | undefined): string {
  if (!hhmm) return ''
  const m = /^(\d{2}):(\d{2})/.exec(hhmm)
  if (!m) return hhmm
  if (m[1] === '23' && m[2] === '59') return '24'
  if (m[2] === '00') return String(Number(m[1]))
  return `${String(Number(m[1]))}:${m[2]}`
}

/** 숫자로 읽히는 글자인지 (`12,000`, `-3.5`). 0 으로 시작하는 여러 자리(전화번호 등)는 숫자가 아니다. */
export function asNumber(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null
  const t = text.trim().replace(/,/g, '')
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null
  if (/^-?0\d/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** `0,000` 형식. `decimals` 가 null 이면 값이 가진 소수 자리를 그대로(최대 6) 보인다. */
export function formatNumber(n: number, decimals: number | null | undefined): string {
  if (decimals === null || decimals === undefined) {
    return n.toLocaleString('ko-KR', { maximumFractionDigits: 6 })
  }
  return n.toLocaleString('ko-KR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

/** 오늘·지난 날짜 판정. 기본 조건부 서식과 '오늘 할 일' 이 쓴다. */
export function dayState(ymd: string | null | undefined, now: Date = new Date()): 'today' | 'past' | 'future' | null {
  if (!isYmd(ymd)) return null
  const today = todayYmd(now)
  if (ymd === today) return 'today'
  return ymd < today ? 'past' : 'future'
}

/**
 * 시간 칸의 '당시/과시'. 날짜 칸과 짝일 때만 뜻이 있다 — 오늘 날짜이면서 그 시각이 지금 시(時)와
 * 같으면 'now', 이미 지났으면 'past'. 날짜가 지난 날이면 시간도 지난 것이다.
 */
export function hourState(
  ymd: string | null | undefined,
  hhmm: string | null | undefined,
  now: Date = new Date(),
): 'now' | 'past' | null {
  if (!hhmm) return null
  const day = dayState(ymd, now)
  if (day === 'past') return 'past'
  if (day !== 'today') return null
  const h = Number(hhmm.slice(0, 2))
  const hour = hhmm === '23:59' ? 24 : h
  const cur = now.getHours()
  if (hour === cur) return 'now'
  if (hour < cur) return 'past'
  return null
}

/** URL 로 보이는 글자인지. 링크 칸 표시에 쓴다. */
export const isUrl = (text: string | null | undefined): text is string =>
  !!text && /^(https?:\/\/|www\.)\S+$/i.test(text.trim())

export const hrefOf = (text: string) => (/^www\./i.test(text.trim()) ? `https://${text.trim()}` : text.trim())
