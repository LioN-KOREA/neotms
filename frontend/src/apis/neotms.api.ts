import { neotmsApi } from './neotms.client'
import type {
  CodeInput,
  CodeListView,
  CodeRow,
  CodeUpdateInput,
  CustomerInput,
  CustomerRow,
  JobInput,
  JobRow,
  JobUpdate,
  ListPage,
  ListQuery,
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
/* 발주(PO)                                                                    */
/* -------------------------------------------------------------------------- */

export interface PurchaseOrderListQuery extends ListQuery {
  jobId?: string | null
  projectId?: string | null
  state?: string | null
  translatorId?: string | null
  pmId?: string | null
  invoiceState?: string | null
  moneyState?: string | null
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
