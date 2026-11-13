import { useCallback, useMemo, useState } from 'react'

/**
 * 표의 체크박스 선택.
 *
 * ## 선택을 목록과 동기화하지 않는다 — 렌더할 때 **교집합**을 낸다
 *
 * 선택된 id 를 `Set` 에 넣어 두기만 하면, 그 id 가 가리키던 행이 사라진 뒤에도 선택은 남는다.
 * 이 화면에서 행은 실제로 사라진다 — 일괄 삭제가 지우고, 필터가 걸러내고, '더 보기' 가 목록을
 * 늘린다. 남은 선택은 조용히 틀린 숫자가 된다: "3건 선택" 이라고 적혀 있는데 체크된 칸은 하나
 * 뿐이고, 일괄 삭제는 이미 없는 행 둘을 지우려 들어 404 를 받는다.
 *
 * `useEffect` 로 목록이 바뀔 때마다 `Set` 을 솎아내는 방법도 있지만, 그러면 **한 번의 렌더
 * 동안은 틀린 상태**가 존재한다(효과는 렌더 뒤에 돈다). 그 렌더에서 일괄 삭제 버튼을 누를 수
 * 있다. 저장하는 쪽을 솎지 않고 읽는 쪽에서 교집합을 내면 틀린 순간이 아예 없다.
 *
 * 대신 저장소에는 지금 화면에 없는 id 가 남는다. 그건 **기능이다**: 필터를 걸어 셋을 고르고,
 * 필터를 바꿔 둘을 더 고르고, 필터를 풀면 다섯이 선택된 상태로 돌아온다.
 *
 * ## `selectedIds` 는 화면 순서를 따른다
 *
 * `Set` 의 순서(= 클릭한 순서)가 아니라 `rows` 의 순서다. 일괄 작업의 진행 상황과 결과 요약이
 * 표에서 보이는 순서와 같아야 읽을 수 있다.
 */
export function useRowSelection<T extends { id: string }>(
  rows: readonly T[],
): {
  /** 지금 화면에 있고 선택된 행. 표 순서. */
  selected: readonly T[]
  selectedIds: readonly string[]
  isSelected: (id: string) => boolean
  toggle: (id: string) => void
  /** 머리글 체크박스. 지금 화면의 행 전부를 켜거나 끈다. */
  toggleAll: () => void
  /** 화면의 행이 **모두** 선택되었는지. 행이 없으면 false. */
  allSelected: boolean
  /** 일부만 선택되었는지. 머리글 체크박스의 `indeterminate` 에 쓴다. */
  someSelected: boolean
  clear: () => void
} {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set())

  const selected = useMemo(() => rows.filter((r) => ids.has(r.id)), [rows, ids])
  const selectedIds = useMemo(() => selected.map((r) => r.id), [selected])

  const isSelected = useCallback((id: string) => ids.has(id), [ids])

  const toggle = useCallback((id: string) => {
    setIds((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  const allSelected = rows.length > 0 && selected.length === rows.length
  const someSelected = selected.length > 0 && !allSelected

  const toggleAll = useCallback(() => {
    setIds((prev) => {
      const next = new Set(prev)
      /*
       * 화면의 행만 건드린다. 화면에 없는 선택은 그대로 둔다 — 위 "기능이다" 문단 참고.
       * `allSelected` 를 의존성으로 받지 않고 여기서 다시 판단하는 이유는 `setIds` 의 갱신
       * 함수가 **가장 최신** 상태를 받기 때문이다. 바깥에서 계산한 불리언은 한 틱 낡아 있을 수
       * 있고, 그러면 전체 선택이 전체 해제로 동작하는 경우가 생긴다.
       */
      const everyOn = rows.length > 0 && rows.every((r) => next.has(r.id))
      for (const r of rows) {
        if (everyOn) next.delete(r.id)
        else next.add(r.id)
      }
      return next
    })
  }, [rows])

  const clear = useCallback(() => setIds(new Set()), [])

  return { selected, selectedIds, isSelected, toggle, toggleAll, allSelected, someSelected, clear }
}
