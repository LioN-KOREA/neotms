import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import {
  fetchAdminCodes,
  fetchCodes,
  fetchCustomer,
  fetchCustomers,
  fetchDashboard,
  fetchFxRates,
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
import type { DashboardRole, ListPage, ListQuery, ReportQuery } from '../neotms.types'
import { isDecimalString } from '../../shared/utils/money'
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

/**
 * 코드 → 이름. **표에서 쓴다.**
 *
 * `useCodeOptions` 의 라벨과 다른 두 가지: 코드를 괄호로 덧붙이지 않고, 모르는 코드는 끼워 넣는
 * 대신 코드 자체를 돌려준다. 드롭다운에서는 "등록되지 않은 값" 이라는 꼬리표가 담당자에게 할 말이
 * 있지만, 표의 한 칸에서는 자리만 차지한다.
 *
 * 이름이 없으면 코드로 떨어지는 것이 중요하다 — 은퇴한 코드가 `online_marketing` 으로 읽히는 것은
 * 사실의 보고이고, 빈 칸이나 '(없음)' 으로 읽히는 것은 거짓이다. 서버의 리포트 라벨도 같은 순서로
 * 떨어진다(NeotmsReport.dbops.ts 의 `jobCategory`).
 *
 * `useCodes` 를 쓰므로 같은 캐시를 공유한다. 표의 모든 행이 이 훅을 각자 부르지 않도록 화면에서
 * 한 번 부르고 함수를 내려 주는 쪽이 낫다.
 */
export function useCodeNames(domain: CodeDomainId): (code: string | null | undefined) => string {
  const codesQuery = useCodes()
  const items = codesQuery.data?.items
  return (code) => {
    const value = code?.trim()
    if (!value) return ''
    const row = items?.find((r) => r.codeParent === domain && r.code === value)
    return row?.codeName?.trim() || value
  }
}

/* -------------------------------------------------------------------------- */
/* 환율                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 통화별 최신 고시 환율.
 *
 * `staleTime` 이 5분이고, 이 앱에서 **가장 짧은 값이 아니라 가장 짧은 축**인 이유가 숫자 자체에
 * 있다: 수집기 람다가 5분마다 도므로 그보다 짧게 잡아도 새 값이 있을 수 없다. 즉 이 5분은
 * "얼마나 자주 확인할까" 가 아니라 **상류의 주기를 그대로 옮긴 값**이다.
 *
 * `refetchOnWindowFocus` 를 따로 켜지 않는다. 환산 버튼을 누르는 순간의 환율이 중요한 것이
 * 맞지만, 그 순간에 다시 읽어도 5분 전 값일 확률이 높고(상류가 영업일마다 한 번 바뀐다), 무엇보다
 * **사용자가 본 숫자와 저장되는 숫자가 같아야** 한다 — 버튼 바로 밑에서 환율이 갈리면 미리 본
 * 금액과 저장된 금액이 달라진다. 화면은 `effectiveDate` 를 같이 보여 주므로 어느 날 환율인지는
 * 숨지 않는다.
 */
export function useFxRates(enabled = true) {
  return useQuery({
    queryKey: neotmsKeys.fxRates,
    queryFn: ({ signal }) => fetchFxRates(signal),
    enabled,
    staleTime: 1000 * 60 * 5,
  })
}

/**
 * 한 통화의 환산 상태. 폼이 쓰는 형태다.
 *
 * `canConvert` 를 따로 돌려주는 것이 이 훅의 요점이다. 환산할 수 없는 경우가 **세 가지**이고 셋 다
 * 오류가 아니다:
 *
 *   * 이미 KRW 다 — 환산이 항등이므로 버튼이 할 일이 없다. `rate` 는 `'1'` 로 둔다.
 *   * 수집기가 아직 한 번도 성공하지 못했다 — 목록이 비어 있다. 시스템의 정상적인 초기 상태다.
 *   * 그 통화를 수집하지 않는다 — 영구히 없다(레거시 사내 통화 코드 등).
 *
 * 세 경우 모두 화면이 할 일은 같다: 버튼을 비활성화하고, 사용자가 **원래 통화로 금액을 기록하게**
 * 둔다. 그것이 열린 포지션 모델이 있는 이유이고, 리포트는 그런 행을 저장된 원화 금액으로 집계해
 * 어제와 같은 숫자를 보여 준다(db/014_fx_rates.sql). 그래서 오류 문구를 띄우지 않는다.
 *
 * `isLoading` 과 "없다" 를 구분해 주는 이유: 불러오는 중에 '환산 불가' 라고 적어 두면 통화를
 * 바꾸는 순간 1초쯤 그 문구가 깜빡이고, 그걸 본 사용자는 통화 선택이 잘못된 줄 안다.
 */
export function useFxRate(coinCode: string | null | undefined): {
  rate: string | null
  effectiveDate: string | null
  canConvert: boolean
  isKrw: boolean
  isLoading: boolean
} {
  const fxQuery = useFxRates()
  const code = coinCode?.trim().toUpperCase() || 'KRW'
  const isKrw = code === 'KRW'
  const row = fxQuery.data?.items.find((r) => r.currencyCode === code)
  const rate = isKrw ? '1' : (row?.rate ?? null)
  return {
    rate,
    effectiveDate: isKrw ? null : (row?.effectiveDate ?? null),
    canConvert: !isKrw && isDecimalString(rate),
    isKrw,
    isLoading: fxQuery.isLoading,
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

/* -------------------------------------------------------------------------- */
/* 대시보드                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 내 프로젝트 현황. 리포트와 달리 **화면을 열면 바로 읽는다.**
 *
 * `enabled` 를 받지 않는 것이 위의 `useReportSummary` 와의 유일한 차이이고, 이유는 비용이다:
 * 리포트는 기간이 없으면 전체 스캔이 되는 쿼리라 '조회' 를 누를 때까지 미뤘지만, 여기는 집합이
 * 소유 조건으로 이미 한 사람 몫으로 묶여 있다. 열자마자 읽어도 싼 쿼리이고, 대시보드는 열면
 * 숫자가 보여야 하는 화면이다 — 조회 버튼을 눌러야 채워지는 대시보드는 대시보드가 아니다.
 *
 * `staleTime` 은 리포트와 같은 5분. 프로젝트·작업·발주를 고치면 `neotmsKeys.dashboards` 가
 * 무효화되므로(neotms.mutation.ts), 내가 한 변경은 5분을 기다리지 않고 바로 반영된다. 5분은
 * **다른 사람이** 바꾼 것이 늦게 보이는 창일 뿐이다.
 */
export function useDashboard(role: DashboardRole) {
  return useQuery({
    queryKey: neotmsKeys.dashboard(role),
    queryFn: ({ signal }) => fetchDashboard(role, signal),
    staleTime: 1000 * 60 * 5,
  })
}

export type { JobListQuery, ProjectListQuery, PurchaseOrderListQuery, TranslatorListQuery }
