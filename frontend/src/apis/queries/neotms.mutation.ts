import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  createCustomer,
  createJob,
  createProject,
  createPurchaseOrder,
  createTranslator,
  deleteCustomer,
  deleteJob,
  deleteProject,
  deletePurchaseOrder,
  deleteTranslator,
  updateCustomer,
  updateJob,
  updateProject,
  updatePurchaseOrder,
  updateTranslator,
} from '../neotms.api'
import type {
  CustomerInput,
  JobInput,
  JobUpdate,
  ProjectInput,
  PurchaseOrderInput,
  PurchaseOrderUpdate,
  TranslatorInput,
} from '../neotms.types'
import { neotmsKeys } from './neotms.keys'

/**
 * 쓰기 훅.
 *
 * ## 무효화 범위를 넓게 잡는다
 *
 * `CUSTOMER → PROJECT → JOB → PO` 체인의 각 단계가 상위 단계의 이름을 **들고 온다**
 * (`JobRow.prjName`, `PurchaseOrderRow.jobName`, `ProjectRow.cusCodeName`). 서버가 조인해서
 * 내려주는 값이므로, 고객사 이름을 고치면 고객사 목록만이 아니라 프로젝트·작업·발주 목록의
 * 글자도 전부 낡는다.
 *
 * 그래서 영향 범위를 **좁히지 않는다**. 이게 비싸 보이지만 실제로는 그렇지 않다:
 * `invalidateQueries` 는 화면에 **떠 있는** 쿼리만 즉시 다시 읽고, 나머지는 '낡음' 으로
 * 표시만 해 둔다. 떠 있는 목록은 보통 하나이므로 호출 수는 1~2 회 늘어난다. 반대로 범위를
 * 좁히다가 틀리면 "고객사 이름을 바꿨는데 프로젝트 목록에는 옛 이름" 이 되고, 그건 사용자가
 * 버그로 인식하지 않는다 — **저장이 안 된 것으로** 인식해서 한 번 더 저장한다.
 *
 * ## 리포트는 금액이 바뀌는 모든 쓰기에서 무효화한다
 *
 * 작업은 매출, 발주는 원가다. 둘 중 하나라도 손대면 그 기간의 집계가 달라진다. 리포트는
 * staleTime 이 5분이고 `enabled` 로 수동 조회하므로, 무효화하지 않으면 방금 고친 금액이
 * 반영되지 않은 집계를 '조회' 버튼이 캐시에서 그대로 꺼내 준다.
 */

/** 이 쓰기가 영향을 주는 캐시 접두사들을 한 번에 무효화한다. */
function invalidateAll(qc: QueryClient, prefixes: readonly (readonly unknown[])[]): void {
  for (const queryKey of prefixes) void qc.invalidateQueries({ queryKey })
}

/* -------------------------------------------------------------------------- */
/* 고객사                                                                      */
/* -------------------------------------------------------------------------- */

/** 고객사는 프로젝트·작업·발주 목록에 이름으로 나타난다. 리포트도 고객사별 집계를 한다. */
const CUSTOMER_AFFECTS = [
  neotmsKeys.customers,
  neotmsKeys.projects,
  neotmsKeys.jobs,
  neotmsKeys.purchaseOrders,
  neotmsKeys.reports,
] as const

export function useCreateCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CustomerInput) => createCustomer(input),
    onSuccess: () => invalidateAll(qc, CUSTOMER_AFFECTS),
  })
}

export function useUpdateCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<CustomerInput> }) =>
      updateCustomer(id, input),
    onSuccess: () => invalidateAll(qc, CUSTOMER_AFFECTS),
  })
}

export function useDeleteCustomer() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteCustomer(id),
    onSuccess: () => invalidateAll(qc, CUSTOMER_AFFECTS),
  })
}

/* -------------------------------------------------------------------------- */
/* 번역가                                                                      */
/* -------------------------------------------------------------------------- */

/** 번역가 이름은 발주 목록에 나타난다(`poTranName`). */
const TRANSLATOR_AFFECTS = [neotmsKeys.translators, neotmsKeys.purchaseOrders] as const

export function useCreateTranslator() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: TranslatorInput) => createTranslator(input),
    onSuccess: () => invalidateAll(qc, TRANSLATOR_AFFECTS),
  })
}

export function useUpdateTranslator() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<TranslatorInput> }) =>
      updateTranslator(id, input),
    onSuccess: () => invalidateAll(qc, TRANSLATOR_AFFECTS),
  })
}

export function useDeleteTranslator() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteTranslator(id),
    onSuccess: () => invalidateAll(qc, TRANSLATOR_AFFECTS),
  })
}

/* -------------------------------------------------------------------------- */
/* 프로젝트                                                                    */
/* -------------------------------------------------------------------------- */

const PROJECT_AFFECTS = [
  neotmsKeys.projects,
  neotmsKeys.jobs,
  neotmsKeys.purchaseOrders,
  neotmsKeys.reports,
] as const

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ProjectInput) => createProject(input),
    onSuccess: () => invalidateAll(qc, PROJECT_AFFECTS),
  })
}

export function useUpdateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<ProjectInput> }) =>
      updateProject(id, input),
    onSuccess: () => invalidateAll(qc, PROJECT_AFFECTS),
  })
}

export function useDeleteProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: () => invalidateAll(qc, PROJECT_AFFECTS),
  })
}

/* -------------------------------------------------------------------------- */
/* 작업(JOB) — 매출                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 작업을 고치면 프로젝트 목록도 낡는다 — 프로젝트 화면이 소속 작업의 합계를 보여 주기 때문이다.
 * 발주 목록도 작업명을 들고 있다.
 */
const JOB_AFFECTS = [
  neotmsKeys.jobs,
  neotmsKeys.projects,
  neotmsKeys.purchaseOrders,
  neotmsKeys.reports,
] as const

export function useCreateJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: JobInput) => createJob(input),
    onSuccess: () => invalidateAll(qc, JOB_AFFECTS),
  })
}

export function useUpdateJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<JobUpdate> }) => updateJob(id, input),
    onSuccess: () => invalidateAll(qc, JOB_AFFECTS),
  })
}

export function useDeleteJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteJob(id),
    onSuccess: () => invalidateAll(qc, JOB_AFFECTS),
  })
}

/* -------------------------------------------------------------------------- */
/* 발주(PO) — 원가                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 발주를 만들면 그 작업의 '발주 없음' 상태가 사라진다(`WorkloadCounts.jobsWithoutPo`). 그 숫자는
 * 리포트 키 아래에 있으므로 `reports` 무효화가 같이 처리한다.
 */
const PO_AFFECTS = [
  neotmsKeys.purchaseOrders,
  neotmsKeys.jobs,
  neotmsKeys.projects,
  neotmsKeys.reports,
] as const

export function useCreatePurchaseOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: PurchaseOrderInput) => createPurchaseOrder(input),
    onSuccess: () => invalidateAll(qc, PO_AFFECTS),
  })
}

export function useUpdatePurchaseOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<PurchaseOrderUpdate> }) =>
      updatePurchaseOrder(id, input),
    onSuccess: () => invalidateAll(qc, PO_AFFECTS),
  })
}

export function useDeletePurchaseOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deletePurchaseOrder(id),
    onSuccess: () => invalidateAll(qc, PO_AFFECTS),
  })
}
