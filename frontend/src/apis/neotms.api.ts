import { neotmsApi } from './neotms.client'
import type {
  CodeInput,
  CodeListView,
  CodeRow,
  CodeUpdateInput,
  CustomerInput,
  CustomerRow,
  DashboardRole,
  DashboardSummary,
  FxRateListView,
  InvoiceInput,
  InvoiceRow,
  InvoiceUpdate,
  JobInput,
  JobRow,
  JobUpdate,
  ListPage,
  ListQuery,
  PoApprovalInput,
  PoSettlementInput,
  ProfileView,
  ProjectInput,
  ProjectRow,
  PurchaseOrderInput,
  PurchaseOrderRow,
  PurchaseOrderUpdate,
  ReportQuery,
  ReportResult,
  RoleListView,
  SelfProfileInput,
  StaffListView,
  StaffRow,
  StaffUpdateInput,
  TranslatorInput,
  TranslatorRow,
  WorkloadCounts,
} from './neotms.types'

/**
 * `/api/v0/*` 엔드포인트.
 *
 * 전부 얇은 래퍼다 — 재시도·토큰·오류 변환은 neotms.client.ts 가 하고, 캐시와 무효화는
 * queries/ 가 한다. 이 파일에 로직이 생기면 그건 세 레이어 중 하나에 있어야 할 것이 잘못
 * 들어온 것이다.
 *
 * 다섯 엔티티가 완전히 같은 모양(목록·생성·조회·수정·삭제)이라 함수가 반복적으로 보이지만
 * 제네릭으로 묶지 않았다. 묶으면 `resource('customers')` 같은 호출이 되는데, 그러면 경로가
 * 문자열 변수가 되어 "이 화면이 어떤 엔드포인트를 부르는가"를 grep 으로 찾을 수 없다. 두 명이
 * 유지보수하는 시스템에서는 그 검색 가능성이 중복 제거보다 가치 있다.
 */

/* -------------------------------------------------------------------------- */
/* 내 정보                                                                     */
/* -------------------------------------------------------------------------- */

export const fetchProfile = (signal?: AbortSignal) =>
  neotmsApi<ProfileView>('/api/v0/me', { signal })

/**
 * 회원가입 요청. `staff` 행을 만들지만 **역할은 비워 둔 채로** 만든다.
 *
 * 응답은 생성된 행이 아니라 `ProfileView` 다 — `/api/v0/me` 가 잠시 뒤에 줄 것과 같은 값이고,
 * 서버에서 같은 코드가 만든다. 그래서 성공 직후 `registration: 'pending'` 을 이 응답에서 바로
 * 읽을 수 있고, 대기 화면을 그리기 위해 한 번 더 왕복하지 않는다.
 *
 * 이것이 `staff` 행이 없어도 호출할 수 있는 두 엔드포인트 중 하나다(다른 하나는
 * `/api/v0/me`). 나머지 전부는 쓸 수 있는 `staff` 행을 요구하므로, 그 행을 만드는 이 호출이
 * 같은 요구를 하면 아무도 등록할 수 없다.
 */
export const registerSelf = (input: SelfProfileInput) =>
  neotmsApi<ProfileView>('/api/v0/registration', { method: 'POST', body: input })

/* -------------------------------------------------------------------------- */
/* 코드 (sys_code)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 드롭다운용 코드 목록. 활성 코드 전부를 **한 번에** 받는다.
 *
 * 도메인별로 나누어 받지 않는 이유는 수요의 모양이다 — 작업 등록 모달 하나가 작업 종류와 단가
 * 단위와 출발어와 도착어를 동시에 필요로 하므로, 도메인별 호출은 모달 하나를 그리는 데 네 번의
 * 왕복이 되고 그 네 번이 각각 Supavisor 커넥션을 하나씩 가져간다(총 한도 40). 전체가 60행
 * 남짓의 짧은 문자열이라 나눠서 얻을 것이 없다.
 *
 * 메뉴 권한을 보지 않는 `anyStaff` 엔드포인트다. 분야·작업 종류 없이는 어떤 폼도 그려지지
 * 않으므로, 유지보수 권한이 없는 PM 에게 이것을 거절하면 빈 드롭다운을 주는 것이 된다.
 */
export const fetchCodes = (signal?: AbortSignal) =>
  neotmsApi<CodeListView>('/api/v0/codes', { signal })

/**
 * 유지보수 화면용 목록. 비활성 코드까지 포함한다.
 *
 * 위 `fetchCodes` 에 `?includeInactive=true` 를 붙이는 대신 경로를 나눈 것은, "폐기된 코드를
 * 볼 수 있는가" 를 호출자가 넘기는 질의 문자열이 아니라 **도달한 경로**가 결정하게 하기
 * 위해서다. 그러면 그 판단이 `sys_role_auth` 의 유지보수 권한으로 환원된다.
 */
export const fetchAdminCodes = (signal?: AbortSignal) =>
  neotmsApi<CodeListView>('/api/v0/admin/codes', { signal })

export const createCode = (input: CodeInput) =>
  neotmsApi<CodeRow>('/api/v0/admin/codes', { method: 'POST', body: input })

export const updateCode = (id: string, input: CodeUpdateInput) =>
  neotmsApi<CodeRow>(`/api/v0/admin/codes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  })

/**
 * 물리 삭제. 이 API 에서 유일하게 행을 실제로 지우는 삭제다.
 *
 * `sys_code` 에는 `deleted` 컬럼이 없고, 폐기는 `active = false` 로 한다. 참조가 하나라도
 * 있으면 22개 제약 중 하나가 거절하므로 대개 실패하고, 서버가 그 거절을 "비활성화하십시오" 라는
 * 문장으로 바꿔서 돌려준다(NeotmsCodeManager.ts).
 */
export const deleteCode = (id: string) =>
  neotmsApi<{ id: string }>(`/api/v0/admin/codes/${encodeURIComponent(id)}`, { method: 'DELETE' })

/* -------------------------------------------------------------------------- */
/* 환율                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 통화별 최신 고시 환율. 코드 목록과 함께 `anyStaff` 로 열려 있는 둘뿐인 읽기다.
 *
 * `fetchCodes` 와 합치지 않았다. 읽는 쪽이 같고(작업·발주 폼이 둘 다 필요로 한다) 권한도 같아서
 * 합치고 싶어지지만, **캐시 수명이 다르다** — 코드는 1년에 두 번 바뀌고 환율은 영업일마다
 * 바뀐다. 합치면 30분 캐시인 코드 목록이 환율의 주기로 다시 읽히거나, 환율이 코드의 주기로
 * 낡는다. 서버 쪽 판단도 같다(NeotmsFxRateManager.ts).
 *
 * **빈 목록은 오류가 아니다.** 수집기가 아직 한 번도 성공하지 못한 상태가 정상적인 초기 상태이고,
 * 그때 화면이 할 일은 에러를 띄우는 것이 아니라 환산 버튼을 비활성화하는 것이다.
 */
export const fetchFxRates = (signal?: AbortSignal) =>
  neotmsApi<FxRateListView>('/api/v0/fx-rates', { signal })

/* -------------------------------------------------------------------------- */
/* 직원·역할 — 사용자 관리                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 직원 전체. 역할 미배정(가입 요청) 행이 맨 위로 온다.
 *
 * 커서가 없다. `staff` 는 회사 직원이라 수십 행이고, 한 화면에 들어가는 목록에 페이지 처리를
 * 붙이면 클라이언트가 다뤄야 할 상태만 늘어난다.
 *
 * 정렬이 기능이다 — 가입 요청을 알려 주는 알림 경로가 이 시스템에 없으므로(메일을 보내지
 * 않는다), 새 동료가 무한정 기다리지 않게 하는 유일한 장치는 그 행이 이 목록의 첫 줄이라는
 * 사실이다. 그래서 정렬은 서버가 하고 화면은 다시 정렬하지 않는다.
 */
export const fetchStaff = (signal?: AbortSignal) =>
  neotmsApi<StaffListView>('/api/v0/admin/staff', { signal })

/** 배정 가능한 역할. 드롭다운 하나를 채우는 용도다. */
export const fetchRoles = (signal?: AbortSignal) =>
  neotmsApi<RoleListView>('/api/v0/admin/roles', { signal })

/**
 * 역할·열람 범위·사용 여부를 쓴다. **이 앱에서 가장 위험한 호출이다.**
 *
 * `staff.role_id` 가 모든 권한의 출처이므로, 이 PATCH 에 도달할 수 있는 계정은 누구에게든
 * 무엇이든 부여할 수 있다. 그래서 짝이 되는 POST 도 DELETE 도 없다 — 직원 행은 ETL 과 본인
 * 가입으로만 생기고, 접근을 끝내는 방법은 삭제가 아니라 `active: false` 다.
 *
 * 서버는 호출자가 **자기 자신의** 역할을 회수하거나 자기를 비활성화하는 것을 409 로 거절한다.
 * 그 거절을 되돌릴 화면에 스스로 접근할 수 없게 되기 때문이다.
 */
export const updateStaff = (id: string, input: StaffUpdateInput) =>
  neotmsApi<StaffRow>(`/api/v0/admin/staff/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  })

/* -------------------------------------------------------------------------- */
/* 고객사                                                                      */
/* -------------------------------------------------------------------------- */

export const fetchCustomers = (query: ListQuery, signal?: AbortSignal) =>
  neotmsApi<ListPage<CustomerRow>>('/api/v0/customers', { query: { ...query }, signal })

export const fetchCustomer = (id: string, signal?: AbortSignal) =>
  neotmsApi<CustomerRow>(`/api/v0/customers/${encodeURIComponent(id)}`, { signal })

export const createCustomer = (input: CustomerInput) =>
  neotmsApi<CustomerRow>('/api/v0/customers', { method: 'POST', body: input })

export const updateCustomer = (id: string, input: Partial<CustomerInput>) =>
  neotmsApi<CustomerRow>(`/api/v0/customers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  })

/**
 * 삭제. 서버는 실제로 지우지 않고 `deleted = true, active = false` 로 표시한다.
 *
 * 고객사를 물리 삭제하면 그 고객사의 프로젝트·작업이 참조를 잃고, 작년 매출 리포트의 고객사명이
 * 빈칸이 된다. 이미 끝난 회계 기간의 숫자는 바뀌어선 안 된다.
 */
export const deleteCustomer = (id: string) =>
  neotmsApi<void>(`/api/v0/customers/${encodeURIComponent(id)}`, { method: 'DELETE' })

/* -------------------------------------------------------------------------- */
/* 번역가                                                                      */
/* -------------------------------------------------------------------------- */

export interface TranslatorListQuery extends ListQuery {
  /** 가능 분야. */
  field?: string | null
  /** 불가 분야. */
  unfield?: string | null
  /** 단가 기준. */
  upro?: string | null
  workCon?: string | null
  coin?: string | null
}

export const fetchTranslators = (query: TranslatorListQuery, signal?: AbortSignal) =>
  neotmsApi<ListPage<TranslatorRow>>('/api/v0/translators', { query: { ...query }, signal })

export const fetchTranslator = (id: string, signal?: AbortSignal) =>
  neotmsApi<TranslatorRow>(`/api/v0/translators/${encodeURIComponent(id)}`, { signal })

export const createTranslator = (input: TranslatorInput) =>
  neotmsApi<TranslatorRow>('/api/v0/translators', { method: 'POST', body: input })

export const updateTranslator = (id: string, input: Partial<TranslatorInput>) =>
  neotmsApi<TranslatorRow>(`/api/v0/translators/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  })

export const deleteTranslator = (id: string) =>
  neotmsApi<void>(`/api/v0/translators/${encodeURIComponent(id)}`, { method: 'DELETE' })

/* -------------------------------------------------------------------------- */
/* 프로젝트                                                                    */
/* -------------------------------------------------------------------------- */

export interface ProjectListQuery extends ListQuery {
  state?: string | null
  invoiceState?: string | null
  moneyState?: string | null
  customerId?: string | null
  corpId?: string | null
  field?: string | null
  pmId?: string | null
  salesManagerId?: string | null
  /**
   * 기간 검색. `YYYY-MM-DD`, 양끝 포함.
   *
   * 두 쌍이 **서로 독립**이다. `startFrom`/`startTo` 는 "2월에 **시작한** 프로젝트",
   * `dueFrom`/`dueTo` 는 "2월에 **납기인** 프로젝트" 이고, 둘을 같이 보내면 "2월에 시작해서
   * 2월에 끝나는" 프로젝트만 남는다(서버가 AND 로 묶는다). 화면에서는 기준 하나를 골라
   * 한 쌍만 채우지만, 타입에 둘 다 있는 이유는 서버가 둘 다 받기 때문이고 — 쌍을 하나로
   * 줄이고 '기준' 플래그를 두면 "2월에 시작해서 2월에 끝나는" 을 표현할 길이 없어진다.
   */
  startFrom?: string | null
  startTo?: string | null
  dueFrom?: string | null
  dueTo?: string | null
}

export const fetchProjects = (query: ProjectListQuery, signal?: AbortSignal) =>
  neotmsApi<ListPage<ProjectRow>>('/api/v0/projects', { query: { ...query }, signal })

export const fetchProject = (id: string, signal?: AbortSignal) =>
  neotmsApi<ProjectRow>(`/api/v0/projects/${encodeURIComponent(id)}`, { signal })

export const createProject = (input: ProjectInput) =>
  neotmsApi<ProjectRow>('/api/v0/projects', { method: 'POST', body: input })

export const updateProject = (id: string, input: Partial<ProjectInput>) =>
  neotmsApi<ProjectRow>(`/api/v0/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  })

export const deleteProject = (id: string) =>
  neotmsApi<void>(`/api/v0/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })

/* -------------------------------------------------------------------------- */
/* 작업(JOB)                                                                   */
/* -------------------------------------------------------------------------- */

export interface JobListQuery extends ListQuery {
  projectId?: string | null
  state?: string | null
  workCode?: string | null
  /** 업무 구분. `JOBTYPE` 코드 그대로 — 서버가 `j.job_type` 에 등호로 맞춘다. */
  jobType?: string | null
  /**
   * 업무 분류. `jobType` 과 같이 보내면 교집합이다.
   *
   * 업무 분류는 비언어 작업에만 있으니 이것만 보내도 사실상 MICE·IMC 로 좁혀진다. 반대로
   * `slang`·`elang` 은 언어 작업만 고르게 된다 — 상세 테이블이 다르기 때문이고, 그래서 둘을 한꺼번에
   * 보내면 결과가 비는 것이 정상이다.
   */
  jobCategory?: string | null
  slang?: string | null
  elang?: string | null
  pmId?: string | null
  customerId?: string | null
  corpId?: string | null
}

export const fetchJobs = (query: JobListQuery, signal?: AbortSignal) =>
  neotmsApi<ListPage<JobRow>>('/api/v0/jobs', { query: { ...query }, signal })

export const fetchJob = (id: string, signal?: AbortSignal) =>
  neotmsApi<JobRow>(`/api/v0/jobs/${encodeURIComponent(id)}`, { signal })

export const createJob = (input: JobInput) =>
  neotmsApi<JobRow>('/api/v0/jobs', { method: 'POST', body: input })

export const updateJob = (id: string, input: Partial<JobUpdate>) =>
  neotmsApi<JobRow>(`/api/v0/jobs/${encodeURIComponent(id)}`, { method: 'PATCH', body: input })

export const deleteJob = (id: string) =>
  neotmsApi<void>(`/api/v0/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })

/* -------------------------------------------------------------------------- */
/* PO                                                                          */
/* -------------------------------------------------------------------------- */

export interface PurchaseOrderListQuery extends ListQuery {
  jobId?: string | null
  projectId?: string | null
  state?: string | null
  translatorId?: string | null
  pmId?: string | null
  invoiceState?: string | null
  moneyState?: string | null
  /**
   * 승인 여부. `'true'` 또는 `'false'` — **불리언이 아니라 문자열이다.**
   *
   * 질의 문자열은 문자열만 나른다. 여기에 `boolean` 을 두면 `false` 가 쿼리에서 빠지거나
   * `'false'` 로 실려 가고, 서버의 `Boolean('false')` 는 `true` 다. 서버는 그래서 이 값을
   * `=== "true"` 로만 참으로 읽는다 — 즉 **빈 값은 "거르지 않는다"** 이고 `'false'` 는
   * "미승인만" 이다.
   */
  approved?: string | null
  /**
   * `'true'` 면 **아직 어떤 인보이스에도 올라가지 않은** PO만.
   *
   * 결제 화면의 'PO 고르기' 가 `state=납품` 과 함께 쓴다. 등호 필터로는 표현할 수 없는
   * 조건(`invoice_translator_id IS NULL`)이라 따로 있다.
   */
  uninvoiced?: string | null
  /**
   * 이 인보이스에 올라간 PO만.
   *
   * 인보이스의 명세(출력 문서의 PO 목록)를 이것으로 읽는다. 전용 조회를 따로 만들지 않은 것이
   * 의도다 — 인쇄되는 문서가 다른 모든 화면과 **같은 권한 범위의 목록**을 통해 PO를 읽는다.
   */
  invoiceTranslatorId?: string | null
  /**
   * 마감일(`poEday`) 범위. `YYYY-MM-DD`, 양끝 포함.
   *
   * 서버에는 처음부터 있었고(`PO_FILTERS` 의 `dueFrom`/`dueTo`) 이 타입에만 없었다 — 즉 화면이
   * 보낼 수단이 없었다. PO 목록은 날짜로 자르지 않으면 **전 기간**을 읽으므로, 결제 화면은 이
   * 두 칸을 기본값으로 채워서 들어온다(`PoPaymentView` 의 `DEFAULT_*`).
   */
  dueFrom?: string | null
  dueTo?: string | null
  /**
   * 실제 지급일(`poMoneyDay`) 범위. 마감일과 **독립**이다.
   *
   * 서버가 두 범위를 AND 로 묶으므로 네 칸을 다 채우면 "마감이 이 안에 있고 **그리고** 지급도 이
   * 안에 있는" 이라는 다른 질문이 된다. 화면이 기준 선택으로 한 쌍만 보내는 이유다
   * (`ProjectsView` 의 `PERIOD_BASES` 와 같은 규칙).
   */
  paidFrom?: string | null
  paidTo?: string | null
}

export const fetchPurchaseOrders = (query: PurchaseOrderListQuery, signal?: AbortSignal) =>
  neotmsApi<ListPage<PurchaseOrderRow>>('/api/v0/purchase-orders', {
    query: { ...query },
    signal,
  })

export const fetchPurchaseOrder = (id: string, signal?: AbortSignal) =>
  neotmsApi<PurchaseOrderRow>(`/api/v0/purchase-orders/${encodeURIComponent(id)}`, { signal })

export const createPurchaseOrder = (input: PurchaseOrderInput) =>
  neotmsApi<PurchaseOrderRow>('/api/v0/purchase-orders', { method: 'POST', body: input })

export const updatePurchaseOrder = (id: string, input: Partial<PurchaseOrderUpdate>) =>
  neotmsApi<PurchaseOrderRow>(`/api/v0/purchase-orders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  })

export const deletePurchaseOrder = (id: string) =>
  neotmsApi<void>(`/api/v0/purchase-orders/${encodeURIComponent(id)}`, { method: 'DELETE' })

/* -------------------------------------------------------------------------- */
/* 결제 — PO 승인·정산, 번역가 인보이스                                          */
/* -------------------------------------------------------------------------- */

/**
 * PO 금액 승인·승인취소.
 *
 * 경로는 PO에 달려 있지만 **권한은 결제**다(`PAYMENT:update`). 바꾸는 값이 PO의 컬럼이므로
 * 경로가 PO를 가리키고, 그 값을 바꿀 자격은 라우트가 선언하는 메뉴가 정한다 — 이 시스템에서
 * 권한은 언제나 "도달한 경로" 의 성질이다.
 *
 * `/approval` 이라는 부속 경로로 나눈 것이 요점이다. `updatePurchaseOrder` 는 PO 권한으로
 * 들어가고 금액을 바꿀 수 있으므로, 승인이 그 본문의 한 칸이면 PO를 올린 사람이 자기 PO를
 * 스스로 승인할 수 있다. 서버는 그래서 승인 컬럼들을 PO 수정의 필드 목록에서 **빼** 두었다.
 *
 * 멱등이다 — 이미 승인된 PO를 다시 승인해도 오류가 아니다. 두 사람이 같은 목록을 보고 같은
 * PO를 누르는 일이 실제로 있고, 두 번째 사람에게 오류를 보여 줄 이유가 없다.
 */
export const approvePurchaseOrder = (id: string, input: PoApprovalInput) =>
  neotmsApi<PurchaseOrderRow>(
    `/api/v0/purchase-orders/${encodeURIComponent(id)}/approval`,
    { method: 'PATCH', body: input },
  )

/**
 * PO의 입금 기록.
 *
 * 역시 결제 권한이고 본문은 돈에 관한 여섯 칸으로 좁혀져 있다 — `PoSettlementInput` 주석 참고.
 * 서버는 **취소된 PO**와 **승인되지 않은 PO**의 정산을 거절한다. 둘 다 한국어 문장으로
 * 돌아오므로 화면은 본문을 그대로 보여 주면 된다.
 */
export const settlePurchaseOrder = (id: string, input: PoSettlementInput) =>
  neotmsApi<PurchaseOrderRow>(
    `/api/v0/purchase-orders/${encodeURIComponent(id)}/settlement`,
    { method: 'PATCH', body: input },
  )

export interface InvoiceListQuery extends ListQuery {
  translatorId?: string | null
  pmId?: string | null
  coinCode?: string | null
  invState?: string | null
  moneyState?: string | null
  /** 발행일(`invDay`) 범위. `YYYY-MM-DD`, 양끝 포함. */
  issuedFrom?: string | null
  issuedTo?: string | null
  /** 실제 지급일(`invMoDay`) 범위. 발행일과 **독립**이다 — `ProjectListQuery` 의 두 쌍과 같다. */
  paidFrom?: string | null
  paidTo?: string | null
}

export const fetchInvoices = (query: InvoiceListQuery, signal?: AbortSignal) =>
  neotmsApi<ListPage<InvoiceRow>>('/api/v0/invoices', { query: { ...query }, signal })

export const fetchInvoice = (id: string, signal?: AbortSignal) =>
  neotmsApi<InvoiceRow>(`/api/v0/invoices/${encodeURIComponent(id)}`, { signal })

/**
 * 인보이스 발행. `poIds` 가 비어 있으면 서버가 거절한다.
 *
 * 서버는 인보이스 행과 발주 연결을 **한 트랜잭션**에서 만들고, 요청한 발주 중 하나라도 올릴 수
 * 없으면 전부 되돌린다. 그래서 실패한 요청이 발주 절반만 올라간 인보이스를 남기지 않는다 —
 * 그런 인보이스는 번역가가 네 건을 청구했는데 세 건만 지급되는 상태이고, 그 사실을 이 시스템도
 * 알려 주지 못한다.
 */
export const createInvoice = (input: InvoiceInput) =>
  neotmsApi<InvoiceRow>('/api/v0/invoices', { method: 'POST', body: input })

/** `poIds` 를 보내면 **교체**다. 생략하면 묶음을 그대로 둔다 — `InvoiceUpdate` 주석 참고. */
export const updateInvoice = (id: string, input: InvoiceUpdate) =>
  neotmsApi<InvoiceRow>(`/api/v0/invoices/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
  })

/**
 * 인보이스 취소(소프트 삭제).
 *
 * 달려 있던 발주들의 연결이 같은 트랜잭션에서 풀린다. 풀지 않으면 그 발주들은 취소된 문서에
 * 묶인 채로 남아 **다시는 청구할 수 없게** 된다 — 다른 인보이스에 이미 올라간 발주로 보이기
 * 때문이다.
 */
export const deleteInvoice = (id: string) =>
  neotmsApi<{ id: string }>(`/api/v0/invoices/${encodeURIComponent(id)}`, { method: 'DELETE' })

/* -------------------------------------------------------------------------- */
/* 리포트                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 매출·원가·마진 집계.
 *
 * `from`·`to`·`groupBy` 가 모두 필수인 것은 서버 스키마가 강제한 것이고, 그 이유가 이 시스템의
 * 설계와 직결된다 — 레거시의 가장 느린 화면이 기간 제한 없이 전체를 집계하던 이 화면이었다.
 * 기간을 묶으면 롤업 테이블의 인덱스 스캔이 되고, 묶지 않으면 전체 스캔이 된다.
 */
export const fetchReportSummary = (query: ReportQuery, signal?: AbortSignal) =>
  neotmsApi<ReportResult>('/api/v0/reports/summary', { query: { ...query }, signal })

export const fetchWorkload = (
  range: { from?: string; to?: string } = {},
  signal?: AbortSignal,
) => neotmsApi<WorkloadCounts>('/api/v0/reports/workload', { query: { ...range }, signal })

/* -------------------------------------------------------------------------- */
/* 대시보드                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 내 프로젝트 현황 한 장.
 *
 * `role` 이 **경로**에 들어간다. 한동안 `?as=` 였고, 두 화면이 메뉴 권한을 하나씩 갖게 되면서
 * 옮겼다 — 서버는 권한을 경로마다 선언하므로(라우트 표), 질의 문자열에 따라 달라지는 게이트는
 * 그 표에 적을 수가 없다. 그래서 `/api/v0/dashboard/sales` 와 `/api/v0/dashboard/pm` 이다.
 *
 * 기본값도 두지 않는다. 영업과 PM 을 겸하는 사람에게 두 응답은 같은 제목 아래의 **다른 숫자**
 * 이고, 기본값이 있으면 어느 쪽을 보고 있는지 알 방법이 없다. 화면은 경로로 역할을 이미 알고
 * 있으므로 모르는 채로 부르는 경우가 없다.
 *
 * 리포트와 달리 기간 인자가 없다. 기간은 리포트에서 집계 비용을 묶는 장치이고, 여기서는 '내
 * 프로젝트' 라는 소유 조건이 같은 일을 한다(`ix_prj_mgr`·`ix_prj_pm`).
 */
export const fetchDashboard = (role: DashboardRole, signal?: AbortSignal) =>
  neotmsApi<DashboardSummary>(`/api/v0/dashboard/${role}`, { signal })
