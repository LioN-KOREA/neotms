/**
 * 날짜·시각 표시.
 *
 * ## timestamptz 가 ES 표준 형태로 오지 않는다
 *
 * 서버는 `timestamptz` 를 PostgreSQL 의 텍스트 표현 그대로 내려준다(`PostgresUtils` 의
 * `registerTypeParsers` 가 날짜·시각 파서를 전부 항등으로 고정해 둔 결과다). 그 표현은
 * ES 표준의 Date Time String Format 과 두 군데가 다르다:
 *
 *   * 날짜와 시각 사이가 'T' 가 아니라 **공백**이다.
 *   * UTC 오프셋이 분 단위가 0 이면 **시 단위만** 붙는다 — `+00:00` 이 아니라 `+00` 이고,
 *     세션 시간대가 KST 라면 `+09` 다. 분이 0 이 아닌 시간대에서만 `+05:45` 형태가 된다.
 *
 * 두 번째가 조용한 함정이다. `new Date('...+00')` 은 표준 형태가 아니므로 파싱 결과가 엔진
 * 구현에 달린다. V8 은 받아 주지만 받아 준다는 보장이 없고, 'Z' 를 덧붙이면(`+00Z`) 어느
 * 엔진에서도 Invalid Date 다 — 화면의 모든 시각이 '-' 로 보인다.
 *
 * 그래서 공백을 'T' 로 바꾸고, 오프셋을 `+HH:MM` 으로 **채워서** 정규화한다. 오프셋이 아예
 * 없는 문자열(`timestamp without time zone`)만 UTC 로 보고 'Z' 를 붙인다.
 *
 * (ASv2 변종에서는 Data API 가 `timestamptz` 를 UTC 로 변환해 주면서 표시자를 **아무것도**
 * 붙이지 않았기 때문에, 하는 일이 'Z' 를 붙이는 것 하나였다. 그 코드를 그대로 두면 지금은
 * 반대 방향으로 깨진다.)
 *
 * ## 표시는 항상 KST 고정이다
 *
 * 보는 사람의 로케일을 따르지 않는다. 번역가는 해외에 있는 경우가 많고, 담당자와 번역가가
 * 같은 납기를 서로 다른 날짜로 보면 "하루 늦었다/안 늦었다" 분쟁이 그대로 생긴다. 업무 기준
 * 시간대는 KST 하나다(Q11).
 */

const DATE_TIME_KST = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const DATE_KST = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/*
 * 끝에 붙은 UTC 오프셋. PostgreSQL 은 분·초가 0 이면 그만큼 생략하므로 네 가지가 다 온다:
 * `+00`, `+0900`, `+09:00`, `+05:21:10`(아주 오래된 날짜의 LMT).
 *
 * 날짜 부분을 떼어낸 뒤에만 쓴다. `2026-10-27` 에 그대로 대면 끝의 `-27` 이 오프셋으로 읽힌다.
 */
const TRAILING_OFFSET = /([+-])(\d{2}):?(\d{2})?:?(\d{2})?$/

/**
 * PostgreSQL 의 타임스탬프 텍스트를 `new Date` 가 표준으로 해석할 수 있는 형태로 고친다.
 *
 * 오프셋이 있으면 `+HH:MM` 으로 채우고(초 단위는 표준에 없으므로 버린다), 없으면 UTC 로 보고
 * 'Z' 를 붙인다. 'Z' 로 끝나는 문자열은 이미 표준이므로 공백만 치환한다.
 */
function normalizeTimestamp(value: string): string {
  const withT = value.replace(' ', 'T')
  if (/[Zz]$/.test(withT)) return withT

  // 'YYYY-MM-DD' 뒤쪽에서만 오프셋을 찾는다.
  const head = withT.slice(0, 10)
  const tail = withT.slice(10)
  const m = TRAILING_OFFSET.exec(tail)
  if (!m) return `${withT}Z`

  const [, sign, hours, minutes] = m
  return `${head}${tail.slice(0, m.index)}${sign}${hours}:${minutes ?? '00'}`
}

/**
 * 백엔드가 준 타임스탬프 문자열을 Date 로 바꾼다. 해석할 수 없으면 null.
 *
 * `-`, 빈 문자열, 그리고 레거시에서 넘어온 `0000-00-00` 같은 값이 실제로 있으므로 전부
 * null 로 떨어뜨린다. 화면에 'Invalid Date' 를 띄우는 것보다 '-' 를 띄우는 것이 낫다.
 */
function toDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null

  /*
   * 날짜만 있는 값은 그대로 둔다.
   *
   * `prj_sday`·`job_eday`·`tran_reg_day` 는 `date` 컬럼이므로 `2026-10-27` 로 온다. 여기에 'Z'
   * 를 붙이면 `2026-10-27Z` 가 되는데, 이 형태는 ES 표준의 Date Time String Format 에 없다 —
   * 표준은 시각 없이 오프셋만 붙은 문자열을 정의하지 않는다. 즉 파싱 결과가 엔진 구현에
   * 달리고, 어떤 엔진에서는 Invalid Date 가 되어 납기가 전부 '-' 로 보인다.
   *
   * 'YYYY-MM-DD' 는 표준에 따라 **UTC 자정**으로 해석된다. KST 는 UTC+9 이므로 그 순간을
   * 서울 시간대로 포맷하면 같은 날짜의 09:00 이고, 날짜는 바뀌지 않는다. 음수 오프셋
   * 시간대라면 하루 밀리겠지만, 이 시스템의 표시 기준은 KST 하나로 고정이다.
   */
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)

  const d = new Date(dateOnly ? trimmed : normalizeTimestamp(trimmed))
  if (Number.isNaN(d.getTime())) return null
  // 레거시 쓰레기 값 방어. 1990년 이전 날짜는 이 시스템에 존재할 수 없다.
  if (d.getUTCFullYear() < 1990) return null
  return d
}

/** `2026. 10. 27. 12:34` */
export function formatDateTime(value: string | null | undefined): string {
  const d = toDate(value)
  return d ? DATE_TIME_KST.format(d) : '-'
}

/** `2026. 10. 27.` — 납기처럼 시각이 의미 없는 값에 쓴다. */
export function formatDate(value: string | null | undefined): string {
  const d = toDate(value)
  return d ? DATE_KST.format(d) : '-'
}

/**
 * `<input type="date">` 가 요구하는 `YYYY-MM-DD`.
 *
 * KST 기준으로 쪼갠다. UTC 기준으로 자르면 한국 시각 오전 9시 이전에 입력된 날짜가 하루 전으로
 * 표시되고, 사용자가 폼을 열었다 그대로 저장하면 납기가 조용히 하루 당겨진다.
 */
export function toDateInputValue(value: string | null | undefined): string {
  const d = toDate(value)
  if (!d) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
  // en-CA 는 YYYY-MM-DD 로 포맷한다.
  return parts
}

/** 오늘(KST)을 `YYYY-MM-DD` 로. 리포트 기본 기간에 쓴다. */
export function todayKst(): string {
  return toDateInputValue(new Date().toISOString())
}

/** 오늘로부터 n일 뒤(KST)를 `YYYY-MM-DD` 로. 음수면 과거. */
export function dateKstOffsetDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000)
  return toDateInputValue(d.toISOString())
}

/*
 * 현재 시각(KST)을 `<input type="time">` 이 요구하는 `HH:MM` 으로.
 *
 * `hour12: false` 가 아니라 **`hourCycle: 'h23'`** 인 이유가 있다. `hour12: false` 는 어떤
 * 시간 체계를 쓸지 말하지 않으므로 로케일에 따라 h24 로 해석될 수 있고, h24 에서 자정은
 * `00:00` 이 아니라 `24:00` 이다. `<input type="time">` 은 `24:00` 을 유효한 값으로 보지 않아
 * 조용히 빈 칸이 된다 — 하루 중 1분 동안만 재현되는 종류의 버그다. `h23` 은 0–23 을 명시한다.
 */
const TIME_KST = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Seoul',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** 지금(KST)을 `HH:MM` 으로. 새 항목의 시작 시각 기본값에 쓴다. */
export function nowTimeKst(): string {
  return TIME_KST.format(new Date())
}

/**
 * 납기가 지났는지. 이미 지난 납기는 목록에서 눈에 띄어야 한다.
 *
 * 날짜만 비교한다 — `jobEday` 는 날짜이고, 시각은 `jobEdayTime` 에 따로 있다. 시각까지 섞어
 * 비교하면 "오늘이 납기인 작업"이 오전에는 안 지났고 오후에는 지난 것으로 바뀐다.
 */
export function isOverdue(value: string | null | undefined): boolean {
  if (!value) return false
  const due = toDateInputValue(value)
  if (!due) return false
  return due < todayKst()
}

/* ── 날짜 입력칸 ──────────────────────────────────────────────────────────────
 *
 * 아래는 `DateField` 가 쓰는 네 가지 — 사람이 적은 글자를 날짜로 읽기, 날짜를 요일까지 붙여
 * 보여 주기, 날짜에 며칠을 더하기, 달력 한 달을 격자로 만들기.
 *
 * ## 값은 여전히 `YYYY-MM-DD` 다. 글자만 다르다
 *
 * `2026-11-11(수)` 는 **보여 주는 글자**이고, 폼의 상태와 저장 본문에 들어가는 값은 지금까지와
 * 똑같은 `YYYY-MM-DD` 다. 그래서 이 묶음을 넣는 일은 서버·스키마·`patchJob` 어디에도 닿지
 * 않는다 — 표시 형태를 값에 섞으면 `(수)` 가 붙은 문자열이 `date` 컬럼으로 날아가고, 그때
 * 깨지는 것은 입력칸이 아니라 저장이다.
 *
 * ## 모든 계산을 UTC 자정에서 한다
 *
 * `Date.UTC(y, m - 1, d)` 로 만들고 `getUTC*` 로 읽는다. 보는 사람의 시간대를 **한 번도** 거치지
 * 않으므로 결과가 실행 환경에 따라 달라지지 않는다. 지역 시간대로 계산하면 일광절약시간이 있는
 * 곳에서 `+1` 이 23시간이 되어 같은 날짜로 돌아오거나 이틀을 건너뛴다. 한국에는 DST 가 없지만
 * 이 화면을 여는 브라우저는 한국에만 있지 않다.
 *
 * `Date.UTC` 가 월·일의 넘침을 알아서 넘겨 주므로 월말·연말·윤년이 공짜로 맞는다 —
 * `Date.UTC(2026, 11, 32)` 는 2027-01-01 이고 `Date.UTC(2024, 1, 29)` 는 2024-02-29 다.
 */

/**
 * `getUTCDay()` 의 0(일요일)부터. 파이썬 견본의 `"월화수목금토일"` 과 **순서가 다르다** —
 * 그쪽 `weekday()` 는 월요일이 0 이다. 그대로 베끼면 모든 요일이 하루씩 밀려 적히고,
 * 틀렸다는 사실은 "날짜는 맞는데 요일이 이상하다" 는 말로만 돌아온다.
 */
const WEEKDAY_KST = '일월화수목금토'

const pad2 = (n: number) => String(n).padStart(2, '0')

/** `YYYY-MM-DD` 를 연·월·일 숫자로. 형태가 아니면 null. 달이 13월인지까지는 보지 않는다. */
function splitYmd(value: string): [number, number, number] | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** UTC 자정의 밀리초를 `YYYY-MM-DD` 로. */
function ymdFromUtc(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/**
 * `YYYY-MM-DD` 에 `days` 일을 더한다. 음수면 과거. 값이 날짜가 아니면 빈 문자열.
 *
 * `dateKstOffsetDays` 와 **다른 함수**다. 그쪽은 "오늘로부터", 이쪽은 "이 날짜로부터" 다.
 * 둘을 합치지 않은 이유는 두 기준이 쓰이는 자리가 다르기 때문이다 — 리포트 기본 기간은 오늘
 * 기준이어야 하고, 입력칸의 `+3` 은 그 칸에 적힌 날짜 기준이어야 한다(`DateField` 주석).
 */
export function addDays(value: string, days: number): string {
  const ymd = splitYmd(value)
  if (!ymd) return ''
  const [y, m, d] = ymd
  return ymdFromUtc(Date.UTC(y, m - 1, d) + days * 86_400_000)
}

/**
 * `YYYY-MM-DD` 를 `2026-11-11(수)` 로. 날짜가 아니면 빈 문자열.
 *
 * 요일을 붙이는 것이 이 형태의 전부다. 번역 업무의 납기 대화는 "수요일까지" 로 이루어지는데,
 * `2026-11-11` 만 보고 그게 수요일인지 아는 사람은 없다 — 달력을 따로 열어 확인하고, 확인하지
 * 않으면 주말을 납기로 잡는다.
 */
export function formatDateField(value: string): string {
  const ymd = splitYmd(value)
  if (!ymd) return ''
  const [y, m, d] = ymd
  const at = Date.UTC(y, m - 1, d)
  return `${value}(${WEEKDAY_KST[new Date(at).getUTCDay()]})`
}

/** `parseDateField` 의 결과. 성공이면 `YYYY-MM-DD`(빈 입력이면 빈 문자열). */
export type DateFieldParse = { ok: true; value: string } | { ok: false; reason: string }

/**
 * 받아들이는 **다섯** 가지 구분자. 명세가 적은 것은 `-` 하나지만 나머지는 거절할 이유가 없고,
 * 하나는 거절하면 **이 앱 자신의 표시 형태를 되돌려받지 못한다**: `formatDate` 가 표에
 * `2026. 10. 27.` 로 찍으므로, 표에서 날짜를 복사해 입력칸에 붙이는 가장 자연스러운 조작이
 * 오류가 된다. 엑셀에서 붙여 넣는 `2026/10/27` 도 같다.
 *
 * 구분자를 `-` 로 바꾸고 공백과 뒤에 붙은 점을 떼는 일만 한다. 해석은 아래 한 곳에서 한다.
 */
const SEPARATORS = /[./\s]+/g

/**
 * 사람이 적은 글자를 `YYYY-MM-DD` 로 읽는다. 읽을 수 없으면 **이유**를 돌려준다.
 *
 * ## 받는 형태
 *
 * `yymmdd`, `yyyymmdd`, `yy-mm-dd`, `yyyy-mm-dd`, 그리고 그 뒤에 `(수)` 가 붙은 것. 구분자는
 * `-` `.` `/` 공백 아무것이나 된다(위 `SEPARATORS`). 두 자리 연도는 명세대로 `2000`–`2099` 다.
 *
 * `yyyymmdd` 8 자리는 명세에 없지만 받는다. 여섯 자리를 받으면서 여덟 자리를 거절하는 것은
 * 사람에게 설명할 수 없는 규칙이고, 여덟 자리는 두 자리 연도처럼 **해석의 여지가 없으므로**
 * 받아들이는 데 비용이 없다.
 *
 * ## 빈 값은 성공이다
 *
 * 날짜를 **지우는 것**은 정상 조작이다 — 납기가 없는 작업이 있고, `InlineDateCell` 은 빈 값을
 * null 로 보낸다. 빈 입력을 오류로 만들면 지우는 방법이 사라진다.
 *
 * ## 존재하지 않는 날짜는 다른 날짜가 되지 않는다
 *
 * `2026-02-30` 은 오류다. `Date.UTC` 에 그대로 넣으면 3월 2일로 **조용히 넘어가는데**, 그건
 * 사용자가 적지 않은 날짜이고 화면은 그것을 성공으로 보여 준다. 그래서 만든 뒤 다시 쪼개
 * 입력과 같은지 본다 — 넘어갔다면 입력이 실제 날짜가 아니었다는 뜻이다.
 *
 * ## 1990년 이전은 거절한다
 *
 * `toDate` 가 1990년 이전을 레거시 쓰레기 값으로 보고 null 로 떨어뜨린다. 그러니 1989년을
 * 받아 주면 저장은 되고 **표에는 '-' 로 보인다** — 입력칸과 표가 같은 값을 두고 다른 말을 하는
 * 상태이고, 그 불일치를 찾는 사람은 없다.
 */
export function parseDateField(text: string): DateFieldParse {
  const trimmed = text.trim()
  if (trimmed.length === 0) return { ok: true, value: '' }

  // 끝의 `(수)` 를 뗀다. 적힌 요일은 **확인하지 않는다** — 명세대로 실제 날짜에서 다시 계산하므로
  // 날짜만 고치고 요일은 그대로 둔 입력(`2026-11-12(수)`)도 통과해야 한다.
  const bare = trimmed
    .replace(/\([월화수목금토일]\)$/, '')
    .replace(SEPARATORS, '-')
    .replace(/-+$/, '')

  const digits = /^(\d{6}|\d{8})$/.exec(bare)
  const parts = digits
    ? digits[1].length === 6
      ? [bare.slice(0, 2), bare.slice(2, 4), bare.slice(4, 6)]
      : [bare.slice(0, 4), bare.slice(4, 6), bare.slice(6, 8)]
    : /^(\d{2}|\d{4})-(\d{1,2})-(\d{1,2})$/.exec(bare)?.slice(1)

  if (!parts) {
    return {
      ok: false,
      reason: '날짜를 yymmdd, yy-mm-dd 또는 yyyy-mm-dd 형식으로 적어 주세요.',
    }
  }

  const [rawYear, rawMonth, rawDay] = parts
  const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear)
  const month = Number(rawMonth)
  const day = Number(rawDay)

  const value = `${year}-${pad2(month)}-${pad2(day)}`
  // 넘어갔는지 본다 — 위 '존재하지 않는 날짜' 문단.
  if (ymdFromUtc(Date.UTC(year, month - 1, day)) !== value) {
    return { ok: false, reason: '실제로 있는 날짜를 적어 주세요.' }
  }
  if (year < 1990) {
    return { ok: false, reason: '1990년 이후의 날짜만 쓸 수 있습니다.' }
  }
  return { ok: true, value }
}

/** 달력 한 달. `weeks` 는 7칸 × 6줄이고, 그 달에 없는 칸은 null 이다. */
export interface CalendarMonth {
  year: number
  /** 1–12. */
  month: number
  /** `2026년 11월` */
  title: string
  weeks: (string | null)[][]
}

/** `year`-`month` 에서 `offset` 달 옮긴 달. 월 넘침은 `Date.UTC` 가 맞춰 준다. */
export function shiftMonth(
  year: number,
  month: number,
  offset: number,
): { year: number; month: number } {
  const at = new Date(Date.UTC(year, month - 1 + offset, 1))
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1 }
}

/**
 * 달력에 그릴 한 달.
 *
 * ## 월요일로 시작한다
 *
 * 파이썬 견본이 `firstweekday=0`(월요일)이고, 요일 머리글도 `월화수목금토일` 순이다. 견본과
 * 다른 주 시작을 쓰면 같은 명세에서 나온 두 화면이 다르게 생긴 것이 되므로 그대로 따른다.
 *
 * ## 줄 수가 **항상 여섯**이다
 *
 * 달에 따라 다섯 줄이면 되는데도 여섯 줄을 만든다. 세 달을 나란히 두는 달력이기 때문이다 —
 * 줄 수가 달마다 다르면 가운데 달이 다섯 줄, 옆 달이 여섯 줄이 되면서 세 격자의 높이가 달라지고,
 * 달을 옮길 때마다 팝업 전체가 위아래로 늘었다 줄었다 한다. 그러면 방금 누르려던 날짜가 다른
 * 자리로 옮겨 가 있다.
 */
export function calendarMonth(year: number, month: number): CalendarMonth {
  const first = new Date(Date.UTC(year, month - 1, 1))
  // `getUTCDay()` 는 일요일이 0 이므로 월요일 시작으로 바꾼다(일요일은 6번째 칸).
  const lead = (first.getUTCDay() + 6) % 7
  const start = Date.UTC(year, month - 1, 1 - lead)

  const weeks: (string | null)[][] = []
  for (let row = 0; row < 6; row += 1) {
    const week: (string | null)[] = []
    for (let col = 0; col < 7; col += 1) {
      const at = new Date(start + (row * 7 + col) * 86_400_000)
      week.push(at.getUTCMonth() + 1 === month ? ymdFromUtc(at.getTime()) : null)
    }
    weeks.push(week)
  }

  return { year, month, title: `${year}년 ${month}월`, weeks }
}

/** 달력 머리글의 요일 일곱 글자. 월요일 시작 — `calendarMonth` 주석. */
export const WEEKDAY_HEADS = ['월', '화', '수', '목', '금', '토', '일'] as const

/**
 * 시작일이 종료일보다 뒤면 둘을 맞춘다. 바꾼 쪽이 이긴다.
 *
 * 명세의 규칙 그대로다 — "종료일을 시작일보다 앞당기면 시작일도 종료일로 맞춘다. 시작일을
 * 종료일보다 뒤로 옮기면 종료일도 시작일로 맞춘다."
 *
 * ## 막지 않고 **맞춘다**
 *
 * 거꾸로 된 기간을 오류로 막는 쪽이 흔한 구현이지만, 이 업무에서는 그게 막다른 길을 만든다.
 * 11월 기간을 12월로 통째로 옮기려면 두 칸을 다 고쳐야 하는데, 어느 쪽을 먼저 고쳐도 중간
 * 상태는 거꾸로 된 기간이다. 막으면 그 중간 상태에서 멈춰 서고, 사람은 순서를 바꿔 가며
 * 다시 시도한다.
 *
 * 맞추는 쪽은 그 중간 상태를 **지나가게** 한다. 시작일을 12월로 밀면 종료일이 따라오고,
 * 그다음 종료일만 제자리에 놓으면 끝난다.
 *
 * ## 빈 값은 건드리지 않는다
 *
 * 한쪽이 비어 있으면 비교할 것이 없다. 비었다고 다른 쪽 값을 채워 넣으면, 마감일만 적으려던
 * 사람이 **적은 적 없는 시작일**을 함께 저장하게 된다.
 *
 * ## 화면이 아니라 여기에 있는 이유
 *
 * `DateField` 안에 두면 컴포넌트를 띄우지 않고는 확인할 수 없다. 이건 날짜 두 개를 받아 날짜
 * 두 개를 돌려주는 규칙이지 그리는 일이 아니므로, 글자 비교(`YYYY-MM-DD` 는 사전순이 곧
 * 시간순이다)만 아는 자리에 둔다.
 */
export function alignPeriod(
  start: string,
  end: string,
  changed: 'start' | 'end',
): { start: string; end: string } {
  if (!start || !end || start <= end) return { start, end }
  return changed === 'start' ? { start, end: start } : { start: end, end }
}
