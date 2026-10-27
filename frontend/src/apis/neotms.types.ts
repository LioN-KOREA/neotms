/**
 * API 가 주고받는 형태.
 *
 * ## 백엔드 타입의 사본이다
 *
 * lambdas/neotms/nodejs/neotms/*&#47;*.dbops.ts 의 `*Row` 타입과 필드가 1:1로 대응한다. 공유
 * 패키지로 묶지 않은 이유는 빌드 구조다 — Lambda 는 CommonJS tsconfig 로, 콘솔은 bundler
 * moduleResolution 으로 컴파일되고, 둘을 하나의 프로젝트 참조로 묶으면 둘 중 하나는 자기
 * 설정이 아닌 설정으로 빌드된다. MVP 단계에서 그 복잡도를 지불할 이유가 없다.
 *
 * 대신 **사본이라는 사실을 아는 상태로** 둔다. 필드가 어긋나면 `tsc` 는 아무 말도 하지 않고
 * (서버가 보내는 JSON 은 런타임 값이다) 화면에 `undefined` 가 뜬다. 필드를 추가할 때는 양쪽을
 * 같이 고쳐야 한다.
 *
 * ## 금액과 물량은 모두 string 이다
 *
 * `number` 가 아닌 것은 타이포가 아니다. PostgreSQL 의 `numeric` 을 JS number 로 받으면 2^53
 * 이상에서 정밀도가 사라지고, 0.1+0.2 가 0.30000000000000004 가 된다. 돈을 다루는 컬럼은
 * 전부 10진 문자열로 오고, 계산은 서버가 한다(shared/utils/money.ts 주석 참고).
 */

/* -------------------------------------------------------------------------- */
/* 공통                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 목록 응답. `total` 이 없는 것은 누락이 아니다.
 *
 * 키셋 페이지네이션을 쓰므로 전체 건수를 세려면 매 페이지마다 `COUNT(*)` 를 한 번 더 돌려야
 * 한다. 수십만 행에서 그 쿼리가 목록 쿼리보다 비싸고, Aurora 의 ACU 상한이 4 인 환경에서는
 * 그 비용이 그대로 응답 시간이 된다. 화면은 "1/37 페이지" 대신 '더 보기' 를 쓴다.
 */
export interface ListPage<T> {
  items: T[]
  /** 다음 페이지 커서. 없으면 마지막 페이지다. */
  cursor?: string
}

/** 목록 공통 질의 파라미터. */
export interface ListQuery {
  limit?: number
  cursor?: string | null
  /** 정렬 키. 엔티티마다 허용 목록이 다르다(서버의 *_SORTS). */
  sort?: string
  dir?: 'asc' | 'desc'
  /** 검색어. 서버가 pg_bigm 으로 2-gram 검색한다 — 두 글자 한국어도 걸린다. */
  q?: string
}

/* -------------------------------------------------------------------------- */
/* 내 정보 / 권한                                                              */
/* -------------------------------------------------------------------------- */

/** 메뉴에 대해 할 수 있는 다섯 가지. 서버의 MenuAction 과 같다. */
export type MenuAction = 'read' | 'create' | 'update' | 'delete' | 'export'

export interface MenuGrant {
  menuId: string
  name: string
  parent: string | null
  depth: number
  url: string | null
  ordNo: number | null
  /** 다섯 가지 동작 각각의 허용 여부. 권한이 하나도 없는 메뉴도 전부 false 로 들어온다. */
  may: Record<MenuAction, boolean>
}

/**
 * `/api/v0/me`. 로그인 후 한 번 읽고, 화면 구성 전체의 기준이 된다.
 *
 * 메뉴를 숨기는 것은 편의일 뿐 보안 장치가 아니다. 모든 API 는 서버에서 같은 권한을 다시
 * 확인한다(NeotmsAuthGuard). 숨겨진 메뉴의 URL 을 직접 입력해도 403 이 온다.
 */
export interface ProfileView {
  staffId: string
  mgrId: string
  sub: string
  name: string
  email: string
  corpCode: string | null
  roleCode: string | null
  roleName: string | null
  /**
   * 모든 행을 볼 수 있는지. false 면 서버가 쿼리에 범위 조건을 붙인다.
   *
   * 화면에서 이 값으로 행을 걸러내지 않는다 — 걸러낼 행이 애초에 오지 않는다. 이 값은
   * "이 목록이 전체인가, 내 담당분인가" 를 **설명하기 위해서만** 쓴다. 그 설명이 없으면
   * 담당자는 자기가 보는 숫자가 회사 전체 숫자라고 착각한다.
   */
  seesEveryRow: boolean
  menus: MenuGrant[]
}

/* -------------------------------------------------------------------------- */
/* 고객사                                                                      */
/* -------------------------------------------------------------------------- */

export interface CustomerRow {
  id: string
  cusCode: string
  cusName: string | null
  cusEmail: string | null
  cusPhone: string | null
  cusZip: string | null
  cusAddr: string | null
  cusNation: string | null
  /** 기본 통화. */
  cusCoin: string | null
  /**
   * 등급(UPRO). **금액이 아니다** — `sys_code` 를 참조하는 코드값이고, 기본 단가 밴드를 고른다.
   * 레거시 컬럼명이 "단가"처럼 읽혀서 금액으로 오해하기 쉽다(db/002_tables.sql 의 COMMENT).
   */
  cusUpro: string | null
  /** 최소 수주 금액. 10진 문자열(`numeric(18,2)`), 통화는 `cusCoin`. */
  cusMincost: string | null
  /** 주요 분야. `sys_code` 참조 코드값. */
  cusField: string | null
  active: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface CustomerInput {
  /** 유일한 필수 항목. 코드(`cusCode`)는 서버가 시퀀스로 발급한다. */
  cusName: string
  cusEmail?: string | null
  cusPhone?: string | null
  cusZip?: string | null
  cusAddr?: string | null
  cusNation?: string | null
  cusCoin?: string | null
  cusUpro?: string | null
  cusMincost?: string | null
  cusField?: string | null
  active?: boolean | null
}

/* -------------------------------------------------------------------------- */
/* 번역가                                                                      */
/* -------------------------------------------------------------------------- */

export interface TranslatorRow {
  id: string
  tranCode: string
  tranName: string | null
  tranPhone: string | null
  tranEmail: string | null
  /** 중복 등록 메모. 레거시 컬럼을 그대로 유지한다. */
  tranDup: string | null
  tranMsg: string | null
  tranWorkCon: string | null
  /** CAT 툴 사용 여부. */
  tranCatUse: boolean
  tranCalc: string | null
  /** 등급(UPRO). 금액이 아니라 `sys_code` 참조 코드값이다 — `CustomerRow.cusUpro` 와 같다. */
  tranUpro: string | null
  /** 가능 분야. `sys_code` 참조 코드값. */
  tranField: string | null
  /** 불가 분야. `sys_code` 참조 코드값. */
  tranUnfield: string | null
  tranCoin: string | null
  tranGive: string | null
  /**
   * 원천징수(ICTAX). 세율(`3.3`)인지 구분 코드인지 **아직 확인되지 않았다.** 그래서 서버도
   * `text` 로 두었다(db/002_tables.sql 의 COMMENT). 숫자로 다루면 안 된다.
   */
  tranIctax: string | null
  tranBank: string | null
  tranAcc: string | null
  tranPaypal: string | null
  tranRegDay: string | null
  active: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface TranslatorInput {
  tranName: string
  tranPhone?: string | null
  tranEmail?: string | null
  tranDup?: string | null
  tranMsg?: string | null
  tranWorkCon?: string | null
  tranCatUse?: boolean | null
  tranCalc?: string | null
  tranUpro?: string | null
  tranField?: string | null
  tranUnfield?: string | null
  tranCoin?: string | null
  tranGive?: string | null
  tranIctax?: string | null
  tranBank?: string | null
  tranAcc?: string | null
  tranPaypal?: string | null
  tranRegDay?: string | null
  active?: boolean | null
}

/* -------------------------------------------------------------------------- */
/* 프로젝트                                                                    */
/* -------------------------------------------------------------------------- */

export interface ProjectRow {
  id: string
  prjCode: string
  prjName: string | null
  corpId: string | null
  coinCode: string | null
  /** 영업담당자. */
  prjMgrId: string | null
  prjMgrName: string | null
  /** PM. */
  prjPmId: string | null
  prjPmName: string | null
  customerId: string | null
  cusCodeName: string | null
  customerContactId: string | null
  cusMgrName: string | null
  prjField: string | null
  prjField2: string | null
  prjState: string | null
  prjInvoiceState: string | null
  prjMoneyState: string | null
  invCode: string | null
  invDt: string | null
  prjSday: string | null
  prjSdayTime: string | null
  prjEday: string | null
  prjEdayTime: string | null
  prjContent: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface ProjectInput {
  prjName: string
  /** 필수. 고객사 없는 프로젝트는 매출 귀속이 불가능하다. */
  customerId: string
  corpId?: string | null
  coinCode?: string | null
  prjMgrId?: string | null
  prjPmId?: string | null
  customerContactId?: string | null
  prjField?: string | null
  prjField2?: string | null
  prjState?: string | null
  prjInvoiceState?: string | null
  prjMoneyState?: string | null
  invCode?: string | null
  invDt?: string | null
  prjSday?: string | null
  prjSdayTime?: string | null
  prjEday?: string | null
  prjEdayTime?: string | null
  prjContent?: string | null
}

/* -------------------------------------------------------------------------- */
/* 작업(JOB) — 매출                                                            */
/* -------------------------------------------------------------------------- */

export interface JobRow {
  id: string
  jobCode: string
  projectId: string
  prjCode: string | null
  prjName: string | null
  cusCodeName: string | null
  jobName: string | null
  workCode: string | null
  jobPmId: string | null
  jobPmName: string | null
  /** 출발어. */
  jobSlang: string | null
  /** 도착어. */
  jobElang: string | null
  /** 물량. 10진 문자열. */
  jobVolume: string | null
  unitCode: string | null
  jobPriceSel: string | null
  /** 단가. 10진 문자열. */
  jobPrice: string | null
  /** 할인. 10진 문자열. */
  jobPriceDis: string | null
  coinCode: string | null
  /** 적용 환율. 10진 문자열. 거래 시점에 고정된 값이다. */
  coinRate: string | null
  /** 외화 기준 합계. 10진 문자열. */
  jobPriceSum: string | null
  /** **원화 환산 합계 = 이 작업의 매출.** 리포트의 revenue 가 이 값의 합이다. */
  jobPriceKsum: string | null
  jobSday: string | null
  jobSdayTime: string | null
  jobEday: string | null
  jobEdayTime: string | null
  jobMemo: string | null
  jobState: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface JobInput {
  /** 필수. 작업은 프로젝트 없이 존재하지 않는다. */
  projectId: string
  jobName: string
  workCode?: string | null
  jobPmId?: string | null
  jobSlang?: string | null
  jobElang?: string | null
  jobVolume?: string | null
  unitCode?: string | null
  jobPriceSel?: string | null
  jobPrice?: string | null
  jobPriceDis?: string | null
  coinCode?: string | null
  coinRate?: string | null
  jobPriceSum?: string | null
  jobPriceKsum?: string | null
  jobSday?: string | null
  jobSdayTime?: string | null
  jobEday?: string | null
  jobEdayTime?: string | null
  jobMemo?: string | null
  jobState?: string | null
}

/** 수정에는 `projectId` 가 없다. 작업을 다른 프로젝트로 옮기는 것은 매출 이동이므로 막혀 있다. */
export type JobUpdate = Omit<JobInput, 'projectId'>

/* -------------------------------------------------------------------------- */
/* 발주(PO) — 원가                                                             */
/* -------------------------------------------------------------------------- */

export interface PurchaseOrderRow {
  id: string
  poCode: string
  jobId: string
  projectId: string
  jobCode: string | null
  jobName: string | null
  prjCode: string | null
  prjName: string | null
  poName: string | null
  poWorkCode: string | null
  /** CAT 분석 사용 여부. */
  poCatUse: boolean
  poCatWord: string | null
  poCatMid: string | null
  poCatStotal: string | null
  poPmId: string | null
  poPmName: string | null
  translatorId: string | null
  poTranName: string | null
  poSlang: string | null
  poElang: string | null
  /** 물량. 10진 문자열. */
  poVolume: string | null
  poUnitCode: string | null
  poPriceSel: string | null
  /** 단가. 10진 문자열. */
  poPrice: string | null
  poCoinCode: string | null
  poCoinRate: string | null
  poPriceSum: string | null
  /** **원화 환산 합계 = 이 발주의 원가.** 리포트의 cost 가 이 값의 합이다. */
  poPriceKsum: string | null
  poTax: string | null
  poTaxPrice: string | null
  poTaxSum: string | null
  poSday: string | null
  poSdayTime: string | null
  poEday: string | null
  poEdayTime: string | null
  poLang: string | null
  poContent: string | null
  poState: string | null
  poStateDt: string | null
  poInvoiceState: string | null
  poMoneyState: string | null
  poMoneyDay: string | null
  poMoneyPrice: string | null
  poMoneyGubun: string | null
  invCode: string | null
  invDt: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface PurchaseOrderInput {
  /** 필수. 발주는 작업에 달린다 — 그래서 원가가 매출에 대응된다. */
  jobId: string
  poName: string
  poWorkCode?: string | null
  poCatUse?: boolean | null
  poCatWord?: string | null
  poCatMid?: string | null
  poCatStotal?: string | null
  poPmId?: string | null
  translatorId?: string | null
  poSlang?: string | null
  poElang?: string | null
  poVolume?: string | null
  poUnitCode?: string | null
  poPriceSel?: string | null
  poPrice?: string | null
  poCoinCode?: string | null
  poCoinRate?: string | null
  poPriceSum?: string | null
  poPriceKsum?: string | null
  poTax?: string | null
  poTaxPrice?: string | null
  poTaxSum?: string | null
  poSday?: string | null
  poSdayTime?: string | null
  poEday?: string | null
  poEdayTime?: string | null
  poLang?: string | null
  poContent?: string | null
  poState?: string | null
  poStateDt?: string | null
  poInvoiceState?: string | null
  poMoneyState?: string | null
  poMoneyDay?: string | null
  poMoneyPrice?: string | null
  poMoneyGubun?: string | null
  invCode?: string | null
  invDt?: string | null
}

/** 수정에는 `jobId` 가 없다. 발주를 다른 작업으로 옮기면 원가 귀속이 바뀐다. */
export type PurchaseOrderUpdate = Omit<PurchaseOrderInput, 'jobId'>

/* -------------------------------------------------------------------------- */
/* 리포트                                                                      */
/* -------------------------------------------------------------------------- */

export type ReportGroupBy =
  | 'date'
  | 'customer'
  | 'pm'
  | 'salesManager'
  | 'corp'
  | 'category'
  | 'langPair'

export interface ReportQuery {
  /** `YYYY-MM-DD`. 필수. */
  from: string
  to: string
  groupBy: ReportGroupBy
  customerId?: string | null
  pmId?: string | null
  salesManagerId?: string | null
  corpId?: string | null
}

/** 집계 한 줄. 세 값 모두 10진 문자열이다. margin = revenue - cost 를 서버가 계산한 값. */
export interface ReportLine {
  key: string
  label: string
  revenue: string
  cost: string
  margin: string
}

export interface ReportTotals {
  revenue: string
  cost: string
  margin: string
  /** 집계에 들어간 행 수. */
  rows: number
}

export interface ReportResult {
  query: ReportQuery
  totals: ReportTotals
  lines: ReportLine[]
  /**
   * 결과가 잘렸는지. 잘렸다면 합계는 **전체 합계가 아니다.**
   *
   * 이 값을 무시하면 화면이 부분 합계를 전체 합계처럼 보여 준다. 금액이 틀린 리포트는 없는
   * 리포트보다 나쁘다 — 그래서 화면은 이 값이 true 일 때 경고를 반드시 띄운다.
   */
  truncated: boolean
  computedAt: string
}

/** 마감 임박 현황. 기본 기간은 오늘부터 7일. */
export interface WorkloadCounts {
  jobsDue: number
  posDue: number
  /** 발주가 아직 없는 작업 수. 원가가 비어 있으니 마진이 과대계상된 상태다. */
  jobsWithoutPo: number
}
