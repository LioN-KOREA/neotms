import { neotmsApi } from './neotms.client'
import type {
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
