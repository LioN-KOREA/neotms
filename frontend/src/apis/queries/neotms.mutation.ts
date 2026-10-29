import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  createCode,
  createCustomer,
  createJob,
  createProject,
  createPurchaseOrder,
  createTranslator,
  deleteCode,
  deleteCustomer,
  deleteJob,
  deleteProject,
  deletePurchaseOrder,
  deleteTranslator,
  registerSelf,
  updateCode,
  updateCustomer,
  updateJob,
  updateProject,
  updatePurchaseOrder,
  updateStaff,
  updateTranslator,
} from '../neotms.api'
import type {
  CodeInput,
  CodeUpdateInput,
  CustomerInput,
  JobInput,
  JobUpdate,
  ProjectInput,
  PurchaseOrderInput,
  PurchaseOrderUpdate,
  SelfProfileInput,
  StaffUpdateInput,
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
/* 회원가입                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 회원가입 요청. 이 파일에서 **가장 좁은** 무효화다 — 프로필 하나뿐이고, 그게 맞다.
 *
 * 만들어지는 것은 역할이 없는 `staff` 행이므로 이 호출로 달라지는 목록이 하나도 없다. 호출한
 * 사람에게는 아직 어떤 목록도 보이지 않고(권한이 없다), 관리자의 사용자 관리 목록에는 새 요청이
 * 생기지만 그건 **다른 브라우저**의 캐시다. 여기서 `neotmsKeys.staff` 를 무효화해도 그 관리자
 * 화면에는 아무 영향이 없다 — 관리자는 자기 쪽 staleTime(30초)이 지나면 읽는다.
 *
 * 프로필 무효화가 하는 일은 하나이고 그게 전부다: `registration` 을 `'unregistered'` 에서
 * `'pending'` 으로 바꿔서 셸이 폼 대신 대기 안내를 그리게 한다.
 *
 * ## `setQueryData` 로 응답을 직접 심는다
 *
 * 서버가 돌려주는 것이 생성된 행이 아니라 완성된 `ProfileView` 이기 때문이다(neotms.api.ts).
 * 그래서 무효화 후의 재조회가 끝나기를 기다릴 필요가 없다 — 그 사이의 몇백 밀리초 동안
 * `registration` 은 여전히 `'unregistered'` 이고, 화면은 **방금 제출한 폼을 다시** 보여준다.
 * 사용자가 그 순간에 보는 것은 "저장이 안 됐다" 이고, 그러면 한 번 더 제출한다(서버는 409 로
 * 거절한다 — 정상이지만 보여줄 이유가 없는 오류다).
 *
 * 심은 뒤에 무효화도 함께 하는 이유는, 이 응답이 **그 시점의** 진실이기 때문이다. 관리자가
 * 그사이에 역할을 배정했다면 다음 재조회가 `'active'` 를 가져온다. 낙관적 갱신이 아니라
 * 서버가 준 값을 그대로 쓰는 것이므로 되돌릴 일도 없다.
 */
export function useRegisterSelf() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SelfProfileInput) => registerSelf(input),
    onSuccess: (profile) => {
      qc.setQueryData(neotmsKeys.profile, profile)
      void qc.invalidateQueries({ queryKey: neotmsKeys.profile })
    },
  })
}

/* -------------------------------------------------------------------------- */
/* 코드 (sys_code) — 유지보수                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 코드를 고치면 **모든** 목록이 낡는다.
 *
 * 이 파일에서 가장 넓은 무효화이고, 다른 것들과 달리 "이름을 들고 온다" 가 이유가 아니다. 분야·
 * 작업 종류·단가 단위·언어는 22개 컬럼에 **값으로** 들어 있고, 목록 화면들은 그 값을 그대로
 * 출력한다. 코드명을 고치면 드롭다운만이 아니라 작업 목록의 '작업 종류' 칸 글자도 달라져야 한다.
 *
 * `codes` 접두사 하나로 활성 목록과 유지보수 목록이 함께 무효화된다(neotms.keys.ts).
 */
const CODE_AFFECTS = [
  neotmsKeys.codes,
  neotmsKeys.customers,
  neotmsKeys.translators,
  neotmsKeys.projects,
  neotmsKeys.jobs,
  neotmsKeys.purchaseOrders,
  neotmsKeys.reports,
] as const

export function useCreateCode() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CodeInput) => createCode(input),
    onSuccess: () => invalidateAll(qc, CODE_AFFECTS),
  })
}

export function useUpdateCode() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: CodeUpdateInput }) => updateCode(id, input),
    onSuccess: () => invalidateAll(qc, CODE_AFFECTS),
  })
}

/**
 * 물리 삭제. 참조가 있으면 서버가 409 로 거절하고, 그 본문이 "비활성화하십시오" 라고 설명한다.
 *
 * 거절이 정상 동작이므로 화면은 이 오류를 **읽을 수 있게** 보여 줘야 한다. `ErrorNotice` 가
 * 서버 본문을 그대로 출력하는 것에 의존한다 — "삭제에 실패했습니다" 로 뭉개면, 담당자는
 * 비활성화라는 대안이 있다는 사실을 알 길이 없다.
 */
export function useDeleteCode() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteCode(id),
    onSuccess: () => invalidateAll(qc, CODE_AFFECTS),
  })
}

/* -------------------------------------------------------------------------- */
/* 직원·역할 — 사용자 관리                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 역할 배정은 이 파일에서 **가장 넓은** 무효화다. 코드 수정보다도 넓다.
 *
 * 이유가 둘인데, 둘 다 "이름이 낡는다" 가 아니다:
 *
 *   1. `profile` — 관리자가 **자기 자신의** 행을 고칠 수 있다(역할 회수와 자기 비활성화만 서버가
 *      막는다). 열람 범위를 바꾸거나 자기 역할을 다른 역할로 바꾸면 사이드바의 메뉴 구성과
 *      `mayDo` 의 답이 그 순간 달라져야 한다. 프로필을 무효화하지 않으면 권한은 이미 바뀌었는데
 *      화면은 옛 메뉴를 그리고, 누르면 서버가 403 을 준다 — 사용자에게는 앱이 고장 난 것으로
 *      보인다.
 *   2. 업무 목록 전부 — `view_scope` 는 목록 쿼리의 **WHERE 절**이다('내 행만' 과 '전부'). 이
 *      값이 바뀌면 같은 조건으로 읽은 목록의 **행 수**가 달라진다. 캐시에 남은 목록은 단순히
 *      낡은 것이 아니라 틀린 범위로 읽힌 것이다.
 *
 * 그래서 담당자 이름이 나타나는 목록들(`projects`·`jobs`)만 고르는 식의 최적화를 하지 않는다.
 */
const STAFF_AFFECTS = [
  neotmsKeys.staff,
  neotmsKeys.profile,
  neotmsKeys.customers,
  neotmsKeys.translators,
  neotmsKeys.projects,
  neotmsKeys.jobs,
  neotmsKeys.purchaseOrders,
  neotmsKeys.reports,
] as const

/**
 * 역할·열람 범위·사용 여부를 쓴다.
 *
 * 서버가 409 로 거절하는 두 경우(자기 역할 회수, 자기 비활성화)가 **정상 동작**이므로, 화면은
 * 이 오류를 읽을 수 있게 보여 줘야 한다 — `useDeleteCode` 와 같은 이유다. 서버 본문이 왜 거절했고
 * 무엇을 하면 되는지("다른 관리자에게 요청하십시오")를 설명하고 있다.
 */
export function useUpdateStaff() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: StaffUpdateInput }) => updateStaff(id, input),
    onSuccess: () => invalidateAll(qc, STAFF_AFFECTS),
  })
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
