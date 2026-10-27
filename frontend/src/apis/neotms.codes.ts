/**
 * 상태값·구분값 목록.
 *
 * ## 이 목록은 전부 잠정(PROVISIONAL)이다
 *
 * 레거시 LKTMS 의 `PRJ_STATE`, `JOB_STATE`, `PO_STATE` 는 코드 테이블이 없는 `nvarchar` 자유
 * 입력 컬럼이고, 값의 집합은 ASP 페이지 안에 하드코딩되어 있었다. 즉 **실제로 쓰이는 값은
 * 운영 데이터를 읽어야만 알 수 있다.** 백엔드도 그래서 이 컬럼들을 `text(50)` 자유 입력으로
 * 두었다(neotms.schemas.ts) — 지금 집합을 못 박으면 마이그레이션된 행의 절반이 스키마 검증에
 * 걸려 저장이 안 된다.
 *
 * 아래 목록은 화면에 쓸 만한 선택지를 제공하기 위한 것이고, 운영 데이터 확인 후 고쳐야 한다.
 * 고칠 때 기존 행은 건드릴 필요가 없다 — 그게 `codeOptions` 가 존재하는 이유다.
 */

export interface CodeOption {
  readonly value: string
  readonly label: string
}

const opt = (value: string, label?: string): CodeOption => ({ value, label: label ?? value })

/** 프로젝트 진행 상태. */
export const PROJECT_STATES: readonly CodeOption[] = [
  opt('견적', '견적'),
  opt('진행', '진행'),
  opt('완료', '완료'),
  opt('보류', '보류'),
  opt('취소', '취소'),
]

/** 작업(JOB) 진행 상태. */
export const JOB_STATES: readonly CodeOption[] = [
  opt('대기', '대기'),
  opt('진행', '진행'),
  opt('검수', '검수'),
  opt('완료', '완료'),
  opt('취소', '취소'),
]

/** 발주(PO) 진행 상태. */
export const PO_STATES: readonly CodeOption[] = [
  opt('발주', '발주'),
  opt('수락', '수락'),
  opt('진행', '진행'),
  opt('납품', '납품'),
  opt('완료', '완료'),
  opt('취소', '취소'),
]

/** 세금계산서 발행 상태. 프로젝트와 발주가 같은 집합을 쓴다. */
export const INVOICE_STATES: readonly CodeOption[] = [
  opt('미발행', '미발행'),
  opt('발행', '발행'),
  opt('보류', '보류'),
]

/** 입·출금 상태. */
export const MONEY_STATES: readonly CodeOption[] = [
  opt('미정산', '미정산'),
  opt('부분정산', '부분정산'),
  opt('정산완료', '정산완료'),
]

/**
 * 통화. 레거시의 `COIN_CODE` 에 들어 있던 값들.
 *
 * 환율은 저장된 `coinRate` 를 쓴다. 레거시의 환율 자동 조회 기능은 깨져 있었고(§분석), 거래
 * 시점의 환율은 **그 시점에 고정되어야** 하는 값이다 — 오늘 환율로 작년 발주의 원화 환산액이
 * 바뀌면 이미 끝난 정산이 흔들린다.
 */
export const COIN_CODES: readonly CodeOption[] = [
  opt('KRW', 'KRW 원'),
  opt('USD', 'USD 달러'),
  opt('JPY', 'JPY 엔'),
  opt('EUR', 'EUR 유로'),
  opt('CNY', 'CNY 위안'),
]

/** 단가 기준 단위. */
export const UNIT_CODES: readonly CodeOption[] = [
  opt('단어', '단어'),
  opt('글자', '글자'),
  opt('매', '매(장)'),
  opt('시간', '시간'),
  opt('건', '건'),
]

/** 작업 종류. */
export const WORK_CODES: readonly CodeOption[] = [
  opt('번역', '번역'),
  opt('감수', '감수'),
  opt('편집', '편집'),
  opt('DTP', 'DTP'),
  opt('감리', '감리'),
  opt('기타', '기타'),
]

/** 리포트 집계 기준. 서버의 ReportQuerySchema 의 picklist 와 **정확히** 같아야 한다. */
export const REPORT_GROUPS: readonly CodeOption[] = [
  opt('date', '일자별'),
  opt('customer', '고객사별'),
  opt('pm', 'PM별'),
  opt('salesManager', '영업담당자별'),
  opt('corp', '법인별'),
  opt('category', '분야별'),
  opt('langPair', '언어쌍별'),
]

/**
 * 선택지 목록에, 현재 값이 목록에 없으면 그 값을 끼워 넣는다.
 *
 * `<select>` 의 동작을 막기 위해 반드시 필요하다. 어떤 option 의 value 와도 맞지 않는 value 를
 * 주면 브라우저는 **첫 번째 option 을 선택된 것으로 표시한다.** 위 목록이 운영 데이터와 한
 * 글자라도 다르면, 담당자가 행을 열어 다른 필드만 고치고 저장하는 순간 상태값이 조용히
 * 바뀐다 — '검수' 였던 작업이 '대기' 로 돌아가고, 아무 오류도 나지 않는다.
 *
 * 위 목록이 잠정이라는 사실과 이 함수는 한 쌍이다. 목록을 못 박을 수 없으니, 목록이 틀렸을 때
 * 데이터가 망가지지 않게 만드는 쪽을 택했다.
 */
export function codeOptions(
  known: readonly CodeOption[],
  current: string | null | undefined,
): readonly CodeOption[] {
  const value = current?.trim()
  if (!value) return known
  if (known.some((o) => o.value === value)) return known
  return [...known, { value, label: `${value} (등록되지 않은 값)` }]
}
