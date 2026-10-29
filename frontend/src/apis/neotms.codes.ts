import type { CodeRow } from './neotms.types'

/**
 * 상태값·구분값 목록.
 *
 * ## 서버에서 오는 코드와 여기 적힌 코드는 다른 것이다
 *
 * 이 파일의 목록은 **코드 테이블이 없는 자유 입력 컬럼**의 선택지다 — 진행 상태, 세금계산서
 * 상태, 통화. DB 에 `sys_code` 행이 없으므로 어딘가에는 적혀 있어야 하고, 그 어딘가가 여기다.
 *
 * 반대로 분야·작업 종류·단가 단위·언어·사용 프로그램은 `sys_code` 에 있고, 22개 컬럼이 그것을
 * 외래키로 참조한다. 그 다섯은 **서버에서 받아야 한다**(`useCodeOptions`) — 여기 적어 두면
 * 유지보수 화면에서 추가한 코드가 드롭다운에 나타나지 않는다. 아래 `WORK_CODES` 와
 * `UNIT_CODES` 가 남아 있는 것은 그 과도기의 대비책이며, 쓰임은 `codesToOptions` 주석에 있다.
 *
 * ## 아래 목록은 전부 잠정(PROVISIONAL)이다
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

/**
 * 단가 기준 단위. **db/007_codes.sql 의 UNIT 블록과 값이 같아야 한다.**
 *
 * 이제 1차 출처는 `sys_code` 이고 이 목록은 서버가 그 도메인에 대해 아무 행도 주지 않을 때만
 * 쓰인다(`codesToOptions`). 그래도 값을 맞춰 두어야 하는 이유는, 어긋나면 그 대비책이 저장할 수
 * 없는 값을 선택지로 내놓기 때문이다 — 고르면 23503 으로 거절된다.
 */
export const UNIT_CODES: readonly CodeOption[] = [
  opt('단어', '단어'),
  opt('글자', '글자'),
  opt('매', '매(장)'),
  opt('시간', '시간'),
  opt('건', '건'),
]

/** 작업 종류. **db/007_codes.sql 의 WORK 블록과 값이 같아야 한다** — `UNIT_CODES` 주석 참고. */
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

/* -------------------------------------------------------------------------- */
/* sys_code — 서버에서 오는 코드                                               */
/* -------------------------------------------------------------------------- */

/**
 * `sys_code` 의 도메인 코드. 서버의 `NeotmsCodeDomain` 과 같은 문자열이어야 한다.
 *
 * 도메인 코드만 ASCII 이고 자식 코드는 한국어다. 의도된 비대칭이고, 이유는 쓰임이 다르기
 * 때문이다 — 도메인 코드는 이렇게 상수와 비교되는 식별자이고, 자식 코드는 `job.work_code` 에
 * 실제로 저장되는 값이자 레거시 데이터에 이미 한국어로 들어 있는 값이다.
 */
export const CODE_DOMAIN = {
  /** 분야. */
  FIELD: 'FIELD',
  /** 작업 종류. */
  WORK: 'WORK',
  /** 단가 단위. */
  UNIT: 'UNIT',
  /** 언어. 출발어·도착어 모두 이 도메인에서 고른다. */
  LANG: 'LANG',
  /** 사용 프로그램(CAT 툴). 번역가에게만 묻는다 — `CustomerRow.cusUpro` 주석 참고. */
  UPRO: 'UPRO',
} as const

export type CodeDomainId = (typeof CODE_DOMAIN)[keyof typeof CODE_DOMAIN]

/** 도메인별 화면 표기. 유지보수 화면의 그룹 제목으로도 쓴다. */
export const CODE_DOMAIN_LABELS: Readonly<Record<CodeDomainId, string>> = {
  FIELD: '분야',
  WORK: '작업 종류',
  UNIT: '단가 단위',
  LANG: '언어',
  UPRO: '사용 프로그램',
}

/** 서버가 그 도메인에 대해 아무 행도 주지 않았을 때 쓰는 대비책. 없는 도메인은 빈 목록이다. */
const CODE_FALLBACKS: Readonly<Partial<Record<CodeDomainId, readonly CodeOption[]>>> = {
  WORK: WORK_CODES,
  UNIT: UNIT_CODES,
}

/**
 * 한 도메인의 코드들을 `<select>` 선택지로 바꾼다.
 *
 * ## 라벨은 이름이고 값은 코드다
 *
 * 저장되는 것은 `code` 이고 보이는 것은 `codeName` 이다. 씨드 데이터에서는 둘이 같아서 차이가
 * 드러나지 않지만, 담당자가 `code='의료기기'`, `codeName='의료기기(MD)'` 처럼 다르게 만들 수
 * 있다. 그럴 때만 라벨에 코드를 덧붙인다 — 같을 때 덧붙이면 모든 항목이 `번역 (번역)` 이 된다.
 *
 * ## 비어 있으면 하드코딩 목록으로 떨어진다 (작업 종류·단가 단위만)
 *
 * `sys_code` 가 비어 있는 것은 가상의 상황이 아니다. db/007_codes.sql 을 적용하기 전까지 이
 * 시스템이 정확히 그 상태였고, 그 상태에서 분야를 자유 입력으로 받던 화면은 **어떤 값을 넣어도
 * 저장되지 않았다.** 그러니 빈 드롭다운은 거짓말이 아니라 사실의 보고다 — 고를 것이 없으면
 * 저장될 것도 없다.
 *
 * 그래도 작업 종류와 단가 단위에만 대비책을 두는 이유는 이 둘이 작업·발주 등록의 **필수**
 * 값이라는 것이다. 분야가 비면 분야 없는 고객사가 저장되지만, 작업 종류가 비면 작업을 아예
 * 만들 수 없다. 대비책의 값은 씨드 파일과 같으므로, 씨드를 적용하면 같은 목록이 서버에서 온다.
 */
export function codesToOptions(
  items: readonly CodeRow[] | undefined,
  domain: CodeDomainId,
): readonly CodeOption[] {
  const inDomain = (items ?? [])
    .filter((row) => row.codeParent === domain)
    .map((row) => {
      const name = row.codeName?.trim()
      if (!name) return opt(row.code)
      return opt(row.code, name === row.code ? name : `${name} (${row.code})`)
    })
  // 서버 쪽에서 이미 ord_no, code 순으로 정렬해서 보내므로 여기서 다시 정렬하지 않는다.
  return inDomain.length > 0 ? inDomain : (CODE_FALLBACKS[domain] ?? [])
}
