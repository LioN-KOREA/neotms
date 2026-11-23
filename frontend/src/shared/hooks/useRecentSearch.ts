import { useMemo } from 'react'
import { useForgetSearch, useRecordSearch } from '@/apis/queries/neotms.mutation'
import { useRecentSearches } from '@/apis/queries/neotms.query'

/**
 * 한 목록 화면의 최근 검색어, 그리고 그걸 기록·삭제하는 두 동작.
 *
 * ## `scope` 는 그 화면의 라우트 경로다
 *
 * 'projects', 'payment/invoices' 처럼. 이름 체계를 둘로 두지 않기 위한 선택이다 — 서버의
 * `RECENT_SEARCH_SCOPES` 와 DB 의 CHECK 가 같은 일곱 값을 쓰고, 테스트가 그 셋이 같은 집합인지
 * 확인한다. 서버가 모르는 scope 를 보내면 400 이고, DB 까지 갔다면 23514 다.
 *
 * ## 언제 기록하는가 — 호출하는 쪽이 정한다
 *
 * 이 훅은 `record` 를 주기만 하고 스스로 부르지 않는다. 검색창은 글자마다 조회하지 않고 **폼
 * 제출**로 검색하므로(`onSearch`), 기록할 시점은 그 제출 한 번이다. 입력 중에 기록하면 '현',
 * '현대', '현대차' 가 모두 남아서 제안 목록이 한 단어의 접두사들로 가득 찬다 — 다섯 칸짜리
 * 목록에서는 그게 목록 전체다.
 *
 * 그래서 각 화면의 `onSearch` 안에서 한 줄로 부른다. 훅이 몰래 폼 submit 을 가로채게 만들 수도
 * 있었지만, 그러면 "검색어가 언제 기록되는가" 가 코드에서 보이지 않게 된다.
 */
export interface RecentSearch {
  /** 최신순, 최대 5개. 아직 안 읽혔거나 이 화면에서 검색한 적이 없으면 빈 배열. */
  terms: readonly string[]
  /** 검색 한 번을 기록한다. 빈 문자열은 서버가 무시한다. 실패해도 조용하다. */
  record: (term: string) => void
  /** 이 화면의 검색어 전체를 지운다. */
  forgetAll: () => void
}

export function useRecentSearch(scope: string): RecentSearch {
  const query = useRecentSearches()
  const recordMutation = useRecordSearch()
  const forgetMutation = useForgetSearch()

  const terms = useMemo(
    () => query.data?.items.find((item) => item.scope === scope)?.terms ?? [],
    [query.data, scope],
  )

  return useMemo(
    () => ({
      terms,
      record: (term: string) => {
        const trimmed = term.trim()
        if (trimmed.length === 0) return
        /*
         * 이미 맨 위에 있는 말을 다시 보내지 않는다. 같은 검색을 두 번 하면 서버는 `used_at` 만
         * 올려서 결과가 같은데, 요청과 그에 따른 목록 무효화는 일어난다 — 같은 검색어로 F5 를
         * 누르는 흔한 동작에서 그 왕복이 매번 생긴다.
         */
        if (terms[0] === trimmed) return
        recordMutation.mutate({ scope, term: trimmed })
      },
      forgetAll: () => forgetMutation.mutate({ scope }),
    }),
    [forgetMutation, recordMutation, scope, terms],
  )
}
