import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'

/**
 * 목록 화면의 필터를 주소에 둔다.
 *
 * ## 왜 useState 가 아닌가
 *
 * 레거시에서 담당자들이 화면을 캡처해서 주고받던 이유가 "내가 보고 있는 이 목록" 을 가리킬
 * 방법이 없었기 때문이다. 필터를 컴포넌트 상태에 두면 이 앱도 똑같아진다 — 라우터를 넣고도
 * `/jobs` 는 언제나 전체 목록이고, "진행 중인 일본어 작업" 을 보여 주려면 상대방에게 클릭
 * 순서를 설명해야 한다.
 *
 * 부수 효과로 새로고침과 뒤로 가기가 공짜로 맞는다. 필터를 상태로 들고 있으면 뒤로 가기가
 * 필터를 되돌리지 않고 **화면을 떠나 버리는데**, 그건 사용자가 기대하는 동작이 아니다.
 *
 * ## 값이 없으면 키를 지운다
 *
 * 빈 문자열을 남기면 주소가 `?q=&state=&pmId=` 가 되고, 그 주소를 공유받은 사람은 무엇이
 * 걸린 목록인지 읽을 수 없다. 서버 쪽에서도 빈 값은 위험하다 — api 레이어가 빈 문자열을
 * 떨어뜨리지만(neotms.client.ts 의 `buildUrl`), 그 방어에 의존하지 않고 여기서도 지운다.
 */
export function useUrlFilters<K extends string>(
  keys: readonly K[],
): {
  filters: Record<K, string>
  setFilters: (patch: Partial<Record<K, string>>) => void
  resetFilters: () => void
  activeCount: number
} {
  const [searchParams, setSearchParams] = useSearchParams()

  const filters = useMemo(() => {
    const out = {} as Record<K, string>
    for (const key of keys) out[key] = searchParams.get(key) ?? ''
    return out
    // searchParams 는 변경 시 새 객체가 되므로 이 의존성으로 충분하다. keys 는 호출하는
    // 쪽에서 모듈 상수로 두는 것을 전제로 한다(렌더마다 새 배열이면 매번 재계산된다).
  }, [searchParams, keys])

  const setFilters = useCallback(
    (patch: Partial<Record<K, string>>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          /*
           * `Object.entries` 를 쓰지 않는다.
           *
           * `patch` 의 타입이 제네릭 매핑 타입(`Partial<Record<K, string>>`)이라 `Object.entries`
           * 의 반환이 `[string, {}][]` 로 추론된다 — 값에 `.trim()` 을 부를 수 없고, 억지로
           * 캐스팅하면 키가 `K` 가 아닌 임의 문자열이어도 통과한다. 키 목록은 이미 알고 있으니
           * 그걸 돌면 둘 다 해결된다.
           */
          for (const key of keys) {
            if (!(key in patch)) continue
            const trimmed = (patch[key] ?? '').trim()
            if (trimmed) next.set(key, trimmed)
            else next.delete(key)
          }
          return next
        },
        /*
         * 히스토리에 쌓지 않는다.
         *
         * 필터를 네 번 고치면 뒤로 가기를 네 번 눌러야 목록을 떠날 수 있게 되는데, 그걸
         * 기대하는 사용자는 없다. 주소는 바뀌므로 공유와 새로고침은 그대로 동작한다.
         */
        { replace: true },
      )
    },
    [setSearchParams, keys],
  )

  const resetFilters = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const key of keys) next.delete(key)
        return next
      },
      { replace: true },
    )
  }, [setSearchParams, keys])

  const activeCount = keys.reduce((n, key) => (filters[key] ? n + 1 : n), 0)

  return { filters, setFilters, resetFilters, activeCount }
}
