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

/**
 * 진행 중을 뜻하는 상태값. 화면이 이 값으로 **거르기** 때문에 이름이 붙어 있다.
 *
 * 대시보드의 '나의 진행중인 프로젝트 목록' 이 `state: PROJECT_STATE_ACTIVE` 로 목록을 읽는다.
 * 거기에 `'진행'` 을 직접 적으면 이 파일의 목록과 그 화면이 **서로 독립적인 추측**이 되고, 그
 * 추측이 운영 데이터와 어긋나는 날 목록은 오류 없이 0건이 된다 — 비어 있는 목록은 '없음' 으로
 * 읽히므로 아무도 눈치채지 못한다. 서버가 같은 이유로 NeotmsProjectStates.ts 를 두고 있고, 이
 * 상수는 그 모듈의 `PROJECT_STATE_ACTIVE` 와 같은 값이어야 한다(운영 데이터 확인 시 함께 고친다).
 */
export const PROJECT_STATE_ACTIVE = '진행'

/** 프로젝트 진행 상태. */
export const PROJECT_STATES: readonly CodeOption[] = [
  opt('견적', '견적'),
  opt(PROJECT_STATE_ACTIVE),
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

/*
 * 발주 상태의 다섯 값. 화면이 이 값으로 **거르고 비교하기** 때문에 이름이 붙어 있다.
 *
 * `PROJECT_STATE_ACTIVE` 와 같은 이유다(위 주석 참고): 결제 화면이 `'납품'` 을 직접 적으면 이
 * 파일의 목록과 그 화면이 서로 독립적인 추측이 되고, db/015_payment.sql 이 값을 바꿔 쓰는 순간
 * 목록은 오류 없이 0건이 된다. 서버 쪽 한 벌은 NeotmsPoStates.ts 이고, 테스트가 둘을 맞대어 본다.
 */

/** 미승인 — 발주는 올라갔고, 금액을 승인할 사람을 기다리는 중. (레거시 '발주') */
export const PO_STATE_UNAPPROVED = '미승인'

/** 진행 — 번역가에게 가 있고, 작업 중. (레거시 '수락' 을 흡수했다) */
export const PO_STATE_ACTIVE = '진행'

/** 납품 — 일은 끝났고 돈은 아직. 인보이스를 뽑을 수 있는 칸이자, 일부 지급된 발주가 머무는 칸. */
export const PO_STATE_DELIVERED = '납품'

/** 완료 — 전액 지급됨. `poMoneyState` 가 '정산완료' 일 때만 도달한다. */
export const PO_STATE_DONE = '완료'

/** 취소 — 접힌 발주. 승인도 출력도 지급도 없다. 사다리의 끝이 아니라 사다리 밖이다. */
export const PO_STATE_CANCELLED = '취소'

/**
 * 발주(PO) 진행 상태. **서버의 NeotmsPoStates.ts 와 같은 값·같은 순서다.**
 *
 * ## 이 목록은 한 가지만 답한다 — 일이 어디까지 갔는가
 *
 *     미승인 → 진행 → 납품 → 완료            (그리고 취소, 사다리 옆에)
 *
 * 돈에 관한 두 가지는 각자의 컬럼이 답한다. 금액이 승인되었는가는 `poApproved`, 지급되었는가는
 * `poMoneyState` 다. 전에는 이 한 칸이 셋을 겸했다 — '발주' 와 '수락' 이 사실은 "승인 전/후" 로
 * 읽히고 있었고, 그래서 **승인 없이 진행 중인 발주**를 표현할 방법이 없었다. 승인 관문이 잡아야
 * 하는 바로 그 경우다.
 *
 * ## 완료 = 전액 지급됨
 *
 * 납품도 인보이스 발행도 아니다. 일부만 지급된 발주는 `poMoneyState = '부분정산'` 인 채로 **납품에
 * 머문다**(업무 담당자들이 정한 규칙이다). 그래서 '부분정산' 은 오직 한 칸에만 있다 — 사다리에
 * 따로 칸을 주면 같은 돈에 대해 서로 다른 말을 할 수 있는 칸이 둘이 되고, 어느 쪽이 맞는지는
 * 아무도 적어 두지 않는다.
 *
 * db/015_payment.sql 이 운영 데이터의 발주 → 미승인, 수락 → 진행 을 바꿔 쓴다. 이름이 바뀌는
 * 사건이야말로 어딘가에 추측으로 적힌 리터럴이 아무것과도 맞지 않게 되는 순간이므로, 이 목록과
 * 서버 모듈을 테스트가 맞대어 본다.
 */
export const PO_STATES: readonly CodeOption[] = [
  opt(PO_STATE_UNAPPROVED),
  opt(PO_STATE_ACTIVE),
  opt(PO_STATE_DELIVERED),
  opt(PO_STATE_DONE),
  opt(PO_STATE_CANCELLED),
]

/**
 * 인보이스를 발행할 수 있는 발주 상태. 서버의 `PO_STATES_INVOICEABLE` 과 같아야 한다.
 *
 * 결제 화면의 '발주 고르기' 가 이 값으로 **거른다**. 완료가 들어 있는 것이 의도다 — 이미 정산된
 * 발주의 인보이스도 다시 뽑을 수 있어야 하고(보낸 문서의 사본을 나중에 달라는 요청이 실제로
 * 온다), 한 인보이스에 묶인 발주들이 서로 다른 시점에 정산될 수 있다.
 *
 * 미승인·진행은 아직 청구할 것이 없어서, 취소는 앞으로도 없어서 빠진다.
 */
export const PO_STATES_INVOICEABLE: readonly string[] = [PO_STATE_DELIVERED, PO_STATE_DONE]

/** 세금계산서 발행 상태. 프로젝트와 발주가 같은 집합을 쓴다. */
export const INVOICE_STATES: readonly CodeOption[] = [
  opt('미발행', '미발행'),
  opt('발행', '발행'),
  opt('보류', '보류'),
]

/*
 * 입·출금 상태의 세 값. 위 `PO_STATE_*` 와 같은 이유로 이름이 붙어 있다 — 결제 화면이 이 값으로
 * **비교한다**.
 *
 * 비교하는 내용은 하나다: 발주의 진행 상태를 돈 상태에 맞추는 일. 완료는 전액 지급을 뜻하므로
 * (NeotmsPoStates.ts) 정산완료는 완료로, 부분정산은 납품으로 간다. 그 규칙을 리터럴로 적으면
 * 'ㅈ' 하나만 틀려도 조건이 영원히 거짓이 되고, 화면은 오류 없이 **아무것도 하지 않는다** —
 * 담당자는 상태를 손으로 고치고, 왜 자동으로 안 따라오는지는 아무도 모른다.
 */

/** 미정산 — 아직 한 푼도 나가지 않았다. 모든 발주가 여기서 시작한다. */
export const MONEY_STATE_UNPAID = '미정산'

/** 부분정산 — 일부만 지급됨. 이 값을 가진 발주는 '납품' 에 머문다. */
export const MONEY_STATE_PARTIAL = '부분정산'

/** 정산완료 — 전액 지급됨. 발주가 '완료' 로 갈 수 있는 유일한 조건. */
export const MONEY_STATE_PAID = '정산완료'

/** 입·출금 상태. */
export const MONEY_STATES: readonly CodeOption[] = [
  opt(MONEY_STATE_UNPAID),
  opt(MONEY_STATE_PARTIAL),
  opt(MONEY_STATE_PAID),
]

/**
 * 통화. **이 일곱 개가 전부다.**
 *
 * 다른 목록들과 달리 서버에서 받아오지 않는다 — 통화 조회 엔드포인트는 없다. 이 상수와
 * `db/010_currency.sql` 의 seed, 그리고 람다의 `CURRENCY_CODES`(NeotmsCurrency.ts)가 맞물린
 * 한 벌이고, 세 곳이 어긋나지 않도록 테스트가 비교한다. 어긋나면 **고를 수는 있는데 저장은
 * 안 되는 값**이 드롭다운에 생기고, 사용자는 필드 이름이 아니라 제약 조건 이름을 보게 된다.
 *
 * 환율은 **저장된 값이 아니라 조회 시점의 시세**로 환산된다(`fx_rate_latest`). 단, 한 번
 * 원화로 환산해 정산한 행은 그 금액이 영구히 고정된다 — 두 경우를 가르는 것이 `coinRate` 이고,
 * 전체 규칙은 람다의 `NeotmsMoney.ts` 헤더에 있다.
 *
 * 중국 위안은 `CNY` 가 아니라 **`CNH`(역외 위안)** 다. 한국수출입은행이 고시하는 쪽이 CNH 이고
 * (CNY 는 고시표에 아예 없다), 중국 고객이 국내 결제수단이 아니라 해외송금으로 한국 계좌에
 * 입금하는 거래는 실제로 역외에서 체결된다. 과거 데이터의 `CNY` 행은 남아 있을 수 있는데,
 * 목록에 없는 값은 `codeOptions` 가 `CNY (등록되지 않은 값)` 로 보여 주므로 KRW 로 조용히
 * 바뀌지 않는다.
 */
export const COIN_CODES: readonly CodeOption[] = [
  opt('KRW', 'KRW 원'),
  opt('USD', 'USD 달러'),
  opt('EUR', 'EUR 유로'),
  opt('JPY', 'JPY 엔'),
  opt('CNH', 'CNH 위안(역외)'),
  opt('GBP', 'GBP 파운드'),
  opt('HKD', 'HKD 홍콩 달러'),
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

/**
 * 업무 구분. **db/011_job_types.sql 의 JOBTYPE 블록과 값이 같아야 한다** — `UNIT_CODES` 주석 참고.
 *
 * 다른 하드코딩 목록들보다 어긋났을 때의 피해가 크다. 업무 구분은 어느 상세 테이블에 출발어·도착어
 * 혹은 업무 분류를 넣을지 결정하는 값이고, `job.job_type` 은 NOT NULL 이다. 그래서 이 목록은
 * `CODE_FALLBACKS` 에 들어가 있다 — 서버가 JOBTYPE 도메인을 비워 보내면 작업 등록 자체가 막히므로,
 * 빈 드롭다운을 사실대로 보여주는 것이 답이 되지 않는 유일한 도메인이다.
 */
export const JOBTYPE_CODES: readonly CodeOption[] = [
  opt('LINGUISTICS', '언어 및 통번역 (LINGUISTICS)'),
  opt('MICE', 'MICE'),
  opt('IMC', 'IMC'),
]

/** 언어쌍을 가지는 업무 구분의 코드. `job.job_type`·`purchase_order.po_type` 의 DEFAULT 이기도 하다. */
export const JOB_TYPE_LINGUISTIC = 'LINGUISTICS'

/**
 * 이 업무 구분이 언어쌍을 가지는가(아니라면 업무 분류를 가진다).
 *
 * 서버의 NeotmsJobTypes.ts 와 **같은 방향으로** 판정한다 — '언어 및 통번역' 인지를 묻고, 나머지는
 * 모두 비언어로 본다. 반대로 비언어 목록을 열거하면, 유지보수 화면에서 네 번째 구분이 추가되는 순간
 * 그 작업에 쓸데없는 언어쌍 입력란이 나오고 업무 분류는 입력할 수 없게 된다. 모르는 구분은 비언어로
 * 두는 쪽이 피해가 작고, DB 의 CHECK 제약(`job_type <> 'LINGUISTICS'`)도 그 방향이다.
 *
 * 빈 값·`null` 은 'LINGUISTICS' 로 본다. 서버에서 NOT NULL DEFAULT 인 컬럼이라, 값이 없다는 것은
 * 아직 아무것도 고르지 않았다는 뜻이고 그때 저장되는 값이 'LINGUISTICS' 다.
 */
export const isLinguistic = (jobType: string | null | undefined): boolean =>
  (jobType?.trim() || JOB_TYPE_LINGUISTIC) === JOB_TYPE_LINGUISTIC

/** 리포트 집계 기준. 서버의 ReportQuerySchema 의 picklist 와 **정확히** 같아야 한다. */
export const REPORT_GROUPS: readonly CodeOption[] = [
  opt('date', '일자별'),
  opt('customer', '고객사별'),
  opt('pm', 'PM별'),
  opt('salesManager', '영업담당자별'),
  opt('corp', '법인별'),
  opt('category', '분야별'),
  opt('langPair', '언어쌍별'),
  opt('jobType', '업무 구분별'),
  opt('jobCategory', '업무 분류별'),
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
 * 도메인 코드는 모두 ASCII 이고 자식 코드는 대부분 한국어다. 의도된 비대칭이고, 이유는 쓰임이
 * 다르기 때문이다 — 도메인 코드는 이렇게 상수와 비교되는 식별자이고, 자식 코드는 `job.work_code`
 * 에 실제로 저장되는 값이자 레거시 데이터에 이미 한국어로 들어 있는 값이다. 규칙은 "그 값이 실제로
 * 불리는 이름을 쓴다" 이므로 `JOBTYPE`·`JOBCAT` 의 자식 코드들(`MICE`, `online_marketing`)처럼
 * ASCII 인 자식 코드도 있다 — `UPRO` 의 `Trados`, `memoQ` 와 같은 경우다.
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
  /**
   * 업무 구분. `job.job_type`·`purchase_order.po_type` 에 저장된다.
   *
   * 작업과 발주의 폼이 출발어·도착어를 물을지 업무 분류를 물을지 결정하는 값이다. 'LINGUISTICS'
   * 하나만 언어쌍을 가지고, 나머지는 모두 업무 분류를 가진다 — 목록에 없는 네 번째 구분이 유지보수
   * 화면에서 추가되더라도 그렇다(서버의 NeotmsJobTypes.ts 의 `isLinguistic` 과 같은 규칙).
   */
  JOBTYPE: 'JOBTYPE',
  /** 업무 분류. MICE·IMC 작업의 `job_category`·`po_category`. 두 구분이 같은 목록을 공유한다. */
  JOBCAT: 'JOBCAT',
} as const

export type CodeDomainId = (typeof CODE_DOMAIN)[keyof typeof CODE_DOMAIN]

/** 도메인별 화면 표기. 유지보수 화면의 그룹 제목으로도 쓴다. */
export const CODE_DOMAIN_LABELS: Readonly<Record<CodeDomainId, string>> = {
  FIELD: '분야',
  WORK: '작업 종류',
  UNIT: '단가 단위',
  LANG: '언어',
  UPRO: '사용 프로그램',
  JOBTYPE: '업무 구분',
  JOBCAT: '업무 분류',
}

/** 서버가 그 도메인에 대해 아무 행도 주지 않았을 때 쓰는 대비책. 없는 도메인은 빈 목록이다. */
const CODE_FALLBACKS: Readonly<Partial<Record<CodeDomainId, readonly CodeOption[]>>> = {
  WORK: WORK_CODES,
  UNIT: UNIT_CODES,
  // 작업을 등록하는 데 반드시 필요한 도메인만 여기 둔다 — `JOBTYPE_CODES` 주석 참고.
  JOBTYPE: JOBTYPE_CODES,
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
 * ## 비어 있으면 하드코딩 목록으로 떨어진다 (작업 종류·단가 단위·업무 구분만)
 *
 * `sys_code` 가 비어 있는 것은 가상의 상황이 아니다. db/007_codes.sql 을 적용하기 전까지 이
 * 시스템이 정확히 그 상태였고, 그 상태에서 분야를 자유 입력으로 받던 화면은 **어떤 값을 넣어도
 * 저장되지 않았다.** 그러니 빈 드롭다운은 거짓말이 아니라 사실의 보고다 — 고를 것이 없으면
 * 저장될 것도 없다.
 *
 * 그래도 `CODE_FALLBACKS` 의 세 도메인에만 대비책을 두는 이유는 이들이 작업·발주 등록의
 * **필수** 값이라는 것이다. 분야가 비면 분야 없는 고객사가 저장되지만, 작업 종류가 비면 작업을
 * 아예 만들 수 없고, 업무 구분이 비면 언어쌍과 업무 분류 중 어느 칸을 보여 줄지조차 고를 수
 * 없다. 대비책의 값은 씨드 파일과 같으므로, 씨드를 적용하면 같은 목록이 서버에서 온다.
 *
 * 업무 분류(`JOBCAT`)는 일부러 빼 두었다. 비언어 작업에서도 **필수가 아니고**(db/011 의
 * "금지하되 요구하지 않는다"), 분류 없이도 저장된다. 대비책이 있으면 서버에 없는 코드를 고를
 * 수 있게 되고, 그 저장은 외래키에서 거절된다.
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
      return opt(row.code, name === row.code ? name : `${name}`)
    })
  // 서버 쪽에서 이미 ord_no, code 순으로 정렬해서 보내므로 여기서 다시 정렬하지 않는다.
  return inDomain.length > 0 ? inDomain : (CODE_FALLBACKS[domain] ?? [])
}
