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
