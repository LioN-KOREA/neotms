import type { RecentSearch } from '@/shared/hooks/useRecentSearch'
import ui from '@/shared/ui/ui.module.css'

interface Props {
  /** `<input list={...}>` 가 가리키는 id. 화면마다 유일해야 한다. */
  id: string
  recent: RecentSearch
}

/**
 * 검색창의 최근 검색어 제안.
 *
 * ## 왜 `<datalist>` 인가
 *
 * 브라우저가 그리는 자동완성 목록이다. 검색창을 누르거나 글자를 입력하면 나타나고, 입력한
 * 글자로 걸러지고, 위아래 키로 고르고, Enter 로 선택된다 — 그 동작 전부가 공짜다. 직접 만들면
 * 떠 있는 목록의 위치, 포커스 처리, 바깥 클릭, 키보드 이동, 스크린리더 안내를 모두 손으로
 * 써야 하고, 그중 하나를 빼먹으면 키보드로 쓰는 사람에게는 없는 기능이 된다.
 *
 * 대가는 모양을 꾸밀 수 없다는 것이다(브라우저마다 다르게 그린다). 다섯 줄짜리 제안 목록에서는
 * 치를 만한 값이다.
 *
 * ## 지우기 버튼이 전체 삭제인 이유
 *
 * `<datalist>` 의 항목에는 버튼을 넣을 수 없다. 한 줄씩 지우려면 목록 자체를 직접 그려야 하고,
 * 그러면 위의 모든 동작을 다시 만들어야 한다. 잘못 입력한 검색어 하나를 지우는 것과 다섯 개를
 * 한 번에 지우는 것 사이에서, 후자는 한 줄로 되고 전자는 화면 하나가 필요하다 — 다섯 개를
 * 지우고 다시 검색하면 되는 상황이므로 후자를 골랐다.
 *
 * 검색어가 하나도 없으면 아무것도 그리지 않는다. 늘 떠 있는 '지우기' 는 지울 것이 없을 때도
 * 눌러 봐야 하는 버튼이다.
 */
export function RecentSearchHints({ id, recent }: Props) {
  if (recent.terms.length === 0) return <datalist id={id} />

  return (
    <>
      <datalist id={id}>
        {recent.terms.map((term) => (
          <option value={term} key={term} />
        ))}
      </datalist>
      <button
        type="button"
        className={ui.btnLink}
        onClick={recent.forgetAll}
        title="이 화면에서 최근에 쓴 검색어를 모두 지웁니다. 검색 결과에는 영향이 없습니다."
      >
        최근 검색어 지우기 ({recent.terms.length})
      </button>
    </>
  )
}
