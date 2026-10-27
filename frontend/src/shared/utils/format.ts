/**
 * 날짜·시각 표시.
 *
 * ## timestamptz 가 'Z' 없이 온다
 *
 * RDS Data API 는 `timestamptz` 를 UTC 로 변환해서 주지만 **표준시 표시자를 붙이지 않는다**:
 * `2026-10-27 03:34:56.789` 같은 문자열이다. 브라우저의 `new Date(...)` 는 그런 문자열을
 * ES 표준에 따라 **로컬 시각**으로 해석한다. 그 결과 한국에서 보면 모든 시각이 9시간 앞으로
 * 밀리고, 아무 오류도 나지 않는다 — 어제 만든 주문이 내일 만들어진 것으로 보인다.
 *
 * 그래서 공백을 'T' 로 바꾸고 'Z' 를 직접 붙인다. 이미 오프셋이 있는 문자열(ISO 형태)은
 * 건드리지 않는다.
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

  // 이미 오프셋이나 'Z' 가 있으면 그대로 믿는다.
  const hasZone = dateOnly || /(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(trimmed)
  const normalized = hasZone ? trimmed.replace(' ', 'T') : `${trimmed.replace(' ', 'T')}Z`

  const d = new Date(normalized)
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
