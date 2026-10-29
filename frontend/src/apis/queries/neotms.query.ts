import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  fetchAdminCodes,
  fetchCodes,
  fetchCustomer,
  fetchCustomers,
  fetchJob,
  fetchJobs,
  fetchProfile,
  fetchProject,
  fetchProjects,
  fetchPurchaseOrder,
  fetchPurchaseOrders,
  fetchReportSummary,
  fetchRoles,
  fetchStaff,
  fetchTranslator,
  fetchTranslators,
  fetchWorkload,
  type JobListQuery,
  type ProjectListQuery,
  type PurchaseOrderListQuery,
  type TranslatorListQuery,
} from '../neotms.api'
import { codeOptions, codesToOptions, type CodeDomainId, type CodeOption } from '../neotms.codes'
import type { ListPage, ListQuery, ReportQuery } from '../neotms.types'
import { neotmsKeys } from './neotms.keys'

/**
 * 읽기 훅.
 *
 * ## 목록은 전부 useInfiniteQuery 다
 *
 * 서버가 키셋 커서를 주고 전체 건수를 주지 않으므로(neotms.types.ts 의 `ListPage` 주석) 페이지
 * 번호를 만들 방법이 없다. 번호를 만들려면 `COUNT(*)` 가 필요하고, 그 쿼리는 용량 고정인
 * 소형 DB 인스턴스에서 목록 쿼리보다 비싸다. '더 보기' 가 설계상의 결론이지 UI 취향이 아니다.
 *
 * ## staleTime 이 2분인 이유
 *
 * 화면을 오갈 때마다 다시 읽으면 람다 호출과 DB 커넥션을 그만큼 더 쓴다 — 람다는 호출 수로
 * 과금되고, DB 는 동시에 열 수 있는 커넥션이 정해져 있어서 둘 다 요청 수가 그대로 한계다.
 * 반대로 너무 길면 옆자리 PM 이 바꾼 납기가 보이지 않는다. 2분은 "회의 중에 한 번
 * 새로고침되는" 정도이고, 쓰기 직후에는 무효화가 즉시 반영하므로 자기가 한 변경이 늦게 보이는
 * 일은 없다.
 */
const LIST_STALE_MS = 1000 * 60 * 2

/** 상세는 더 짧게. 보통 수정하려고 연 화면이다. */
const DETAIL_STALE_MS = 1000 * 30

/**
 * 내 정보와 권한. 로그인당 한 번 읽는 값에 가깝다.
 *
 * `staleTime: Infinity` 는 쓰지 않는다. 권한은 계정관리 시스템에서 바뀔 수 있고, 바뀐 뒤에도
 * 탭을 닫지 않는 한 영원히 옛 권한으로 보이면 "권한을 줬는데 안 보인다"는 문의가 된다. 10분은
 * 그 문의가 "새로고침해 보세요"로 해결되는 선이다.
 */
export function useProfile(enabled = true) {
  return useQuery({
    queryKey: neotmsKeys.profile,
    queryFn: ({ signal }) => fetchProfile(signal),
    enabled,
    staleTime: 1000 * 60 * 10,
  })
}

/* -------------------------------------------------------------------------- */
/* 코드 (sys_code)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 드롭다운용 코드 목록.
 *
 * `staleTime` 이 30분이다 — 이 앱에서 가장 긴 값이고, 가장 자주 읽히는 목록이기 때문이다.
 * 고객사·프로젝트·작업·발주·번역가 폼이 전부 이것을 필요로 하므로, 짧게 잡으면 화면을 오갈
 * 때마다 람다 호출과 DB 커넥션이 하나씩 더 나간다. 반대로 길어도 위험하지 않은 유일한 목록이기도
 * 하다: 분야 목록이 30분에 한 번 늦게 갱신되는 것은 아무 일도 일으키지 않고, 유지보수 화면에서
 * **직접** 코드를 고친 담당자에게는 쓰기 훅의 무효화가 즉시 반영한다(neotms.mutation.ts).
 */
export function useCodes(enabled = true) {
  return useQuery({
    queryKey: neotmsKeys.codesActive,
    queryFn: ({ signal }) => fetchCodes(signal),
    enabled,
    staleTime: 1000 * 60 * 30,
  })
}

/**
 * 유지보수 화면용 목록(비활성 포함).
 *
 * 짧게 잡는다. 이 화면을 보는 사람은 방금 무언가를 고치려고 들어온 사람이고, 목록이 낡아 있으면
 * 옆자리에서 이미 추가한 코드를 한 번 더 추가하려다 23505 로 거절당한다.
 */
export function useAdminCodes(enabled = true) {
  return useQuery({
    queryKey: neotmsKeys.codesAdmin,
    queryFn: ({ signal }) => fetchAdminCodes(signal),
    enabled,
    staleTime: DETAIL_STALE_MS,
  })
}

/* -------------------------------------------------------------------------- */
/* 직원·역할 — 사용자 관리                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 직원 목록.
 *
 * `staleTime` 이 짧다(상세와 같은 30초). 이 화면의 목적이 가입 요청을 **발견하는 것**이기
 * 때문이다 — 알림이 없는 시스템에서 관리자가 요청을 보는 경로는 이 목록 한 곳뿐이고, 그 목록이
 * 2분 동안 낡아 있으면 방금 가입한 동료가 그만큼 더 기다린다.
 */
export function useStaff(enabled = true) {
  return useQuery({
    queryKey: neotmsKeys.staff,
    queryFn: ({ signal }) => fetchStaff(signal),
    enabled,
    staleTime: DETAIL_STALE_MS,
  })
}

/**
 * 배정 가능한 역할.
 *
 * 길게 잡는다. `sys_role` 은 역할을 새로 만들 때만 바뀌고, 그건 이 앱에 화면이 없는 작업이다
 * (SQL 로 한다) — 즉 앱을 쓰는 동안에는 사실상 바뀌지 않는 목록이다.
 */
export function useRoles(enabled = true) {
  return useQuery({
    queryKey: neotmsKeys.roles,
    queryFn: ({ signal }) => fetchRoles(signal),
    enabled,
    staleTime: 1000 * 60 * 30,
  })
}

/**
 * 한 도메인의 선택지와, 그 목록이 비어 있는지.
 *
 * 폼이 쓰는 형태. `current` 를 받아야 하는 이유가 중요하다 — `<select>` 에 어떤 option 과도
 * 맞지 않는 value 를 주면 브라우저는 **첫 번째 option 을 선택된 것으로 표시한다.** 그러면
 * 담당자가 번역가 행을 열어 전화번호만 고치고 저장하는 순간, 레거시에서 넘어온 분야값이
 * 목록의 첫 항목으로 조용히 바뀐다. `codeOptions` 가 현재 값을 '등록되지 않은 값' 으로 끼워
 * 넣어 그것을 막는다.
 *
 * `isEmpty` 를 같이 돌려주는 것은 화면이 빈 드롭다운을 **설명할** 수 있게 하기 위해서다. 설명이
 * 없으면 고를 것이 없는 드롭다운은 고장난 화면으로 읽힌다.
 */
export function useCodeOptions(
  domain: CodeDomainId,
  current?: string | null,
): { options: readonly CodeOption[]; isEmpty: boolean; isLoading: boolean } {
  const codesQuery = useCodes()
  const fromServer = codesToOptions(codesQuery.data?.items, domain)
  return {
    options: codeOptions(fromServer, current),
    isEmpty: fromServer.length === 0,
    isLoading: codesQuery.isLoading,
  }
}

/* -------------------------------------------------------------------------- */
/* 목록                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 목록 훅을 만든다.
 *
 * 다섯 엔티티의 페이지네이션 처리가 완전히 같으므로 여기서만 묶는다 — api 함수를 묶지 않은
 * 것과 다른 판단인데, 이유는 **틀렸을 때의 결과**다. 커서 처리를 다섯 번 쓰면 그중 하나에서
 * `getNextPageParam` 이 빈 커서를 그대로 넘기고, 그 목록은 마지막 페이지를 무한히 다시
 * 읽는다. 경로 문자열이 눈에 보이는 것과 달리, 이 로직은 눈으로 봐서는 틀린 걸 알 수 없다.
 */
function makeListHook<Q extends ListQuery, R>(
  keyOf: (query: unknown) => readonly unknown[],
  fetcher: (query: Q, signal?: AbortSignal) => Promise<ListPage<R>>,
) {
  return function useList(query: Q, enabled = true) {
    return useInfiniteQuery({
      // 커서는 키에 넣지 않는다 — 커서가 바뀌면 같은 목록의 다음 페이지이지 다른 목록이 아니다.
      queryKey: keyOf(query),
      queryFn: ({ pageParam, signal }) =>
        fetcher({ ...query, cursor: pageParam } as Q, signal),
      initialPageParam: null as string | null,
      /*
       * 빈 문자열도 "없음"으로 취급한다.
       *
       * 서버는 마지막 페이지에서 `cursor` 를 빼지만, 빈 문자열이 올 가능성을 열어 두는 쪽이
       * 안전하다. `?? null` 만 쓰면 빈 문자열이 통과해서 `cursor=` 로 다시 요청하고, 서버는
       * 그것을 "처음부터" 로 해석한다 — 첫 페이지를 영원히 반복하는 무한 스크롤이 된다.
       */
      getNextPageParam: (last) => (last.cursor && last.cursor.length > 0 ? last.cursor : null),
      enabled,
      staleTime: LIST_STALE_MS,
    })
  }
}

export const useCustomers = makeListHook(neotmsKeys.customerList, fetchCustomers)
export const useTranslators = makeListHook(neotmsKeys.translatorList, fetchTranslators)
export const useProjects = makeListHook(neotmsKeys.projectList, fetchProjects)
export const useJobs = makeListHook(neotmsKeys.jobList, fetchJobs)
export const usePurchaseOrders = makeListHook(
  neotmsKeys.purchaseOrderList,
  fetchPurchaseOrders,
)

/* -------------------------------------------------------------------------- */
/* 상세                                                                        */
/* -------------------------------------------------------------------------- */

export function useCustomer(id: string | null) {
  return useQuery({
    queryKey: neotmsKeys.customer(id ?? ''),
    queryFn: ({ signal }) => fetchCustomer(id!, signal),
    enabled: !!id,
    staleTime: DETAIL_STALE_MS,
  })
}

export function useTranslator(id: string | null) {
  return useQuery({
    queryKey: neotmsKeys.translator(id ?? ''),
    queryFn: ({ signal }) => fetchTranslator(id!, signal),
    enabled: !!id,
    staleTime: DETAIL_STALE_MS,
  })
}

export function useProject(id: string | null) {
  return useQuery({
    queryKey: neotmsKeys.project(id ?? ''),
    queryFn: ({ signal }) => fetchProject(id!, signal),
    enabled: !!id,
    staleTime: DETAIL_STALE_MS,
  })
}

export function useJob(id: string | null) {
  return useQuery({
    queryKey: neotmsKeys.job(id ?? ''),
    queryFn: ({ signal }) => fetchJob(id!, signal),
    enabled: !!id,
    staleTime: DETAIL_STALE_MS,
  })
}

export function usePurchaseOrder(id: string | null) {
  return useQuery({
    queryKey: neotmsKeys.purchaseOrder(id ?? ''),
    queryFn: ({ signal }) => fetchPurchaseOrder(id!, signal),
    enabled: !!id,
    staleTime: DETAIL_STALE_MS,
  })
}

/* -------------------------------------------------------------------------- */
/* 리포트                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 집계. `enabled` 를 호출하는 쪽이 통제한다.
 *
 * 화면이 열렸다고 바로 조회하지 않는다. 기간을 고르고 '조회' 를 누를 때만 간다 — 기본 기간으로
 * 자동 조회하면, 사용자가 원하는 기간을 입력하는 동안 쓸 일 없는 집계가 이미 한 번 돌아간다.
 * 이 시스템에서 가장 비싼 쿼리이므로 그 한 번이 그냥 비용이다.
 */
export function useReportSummary(query: ReportQuery, enabled: boolean) {
  return useQuery({
    queryKey: neotmsKeys.reportSummary(query),
    queryFn: ({ signal }) => fetchReportSummary(query, signal),
    enabled,
    // 집계는 기간이 고정되면 결과도 고정에 가깝다. 5분 안에 다시 누르면 캐시로 답한다.
    staleTime: 1000 * 60 * 5,
  })
}

export function useWorkload(range: { from?: string; to?: string } = {}, enabled = true) {
  return useQuery({
    queryKey: neotmsKeys.workload(range),
    queryFn: ({ signal }) => fetchWorkload(range, signal),
    enabled,
    staleTime: 1000 * 60 * 5,
  })
}

export type { JobListQuery, ProjectListQuery, PurchaseOrderListQuery, TranslatorListQuery }
