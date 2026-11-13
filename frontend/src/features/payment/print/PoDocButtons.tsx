import type { PurchaseOrderRow } from '@/apis/neotms.types'
import ui from '@/shared/ui/ui.module.css'
import { PRINT_LANG_ENG, PRINT_LANG_KOR, type PrintLang } from './PrintDocModal'

/**
 * 어느 PO 를 어느 서식으로 뽑으려는지. 쓰는 화면이 이 모양의 상태 하나를 들고 있으면 된다.
 */
export interface PoPrintRequest {
  po: PurchaseOrderRow
  lang: PrintLang
}

interface Props {
  po: PurchaseOrderRow
  /** 누르면 `{ po, lang }` 을 올린다. 창은 쓰는 화면이 띄운다 — 아래 주석 참고. */
  onPick: (request: PoPrintRequest) => void
  disabled?: boolean
}

/**
 * PO 문서를 뽑는 **국 / 영** 두 버튼.
 *
 * ## 레거시의 두 링크를 되돌린 것이다
 *
 * 레거시 PO 목록의 각 행에는 `PDF_Po_KOR.asp` 와 `PDF_Po_ENG.asp` 두 링크가 있었다. 이 앱은 그
 * 둘을 창 하나로 합치면서 서식 선택을 **창 안의 드롭다운**으로 옮겼고, 그 결과 영문 발주서를
 * 뽑는 동작이 한 번 누르기에서 세 번(버튼 → 드롭다운 → 선택)으로 늘었다. 해외 번역가 비중이
 * 높은 담당자에게는 그 두 번이 하루에 수십 번이다.
 *
 * 그래서 버튼을 둘로 되돌린다. 창 안의 드롭다운은 그대로 남아 있으므로, 잘못 눌렀을 때 창을
 * 닫고 다시 누를 필요는 없다(`PoPrintModal` 의 1번).
 *
 * ## 미승인 PO 는 뽑을 수 없다 — 여기서도
 *
 * 이 제약은 결제 화면(`PoPaymentView`)이 먼저 세웠다. 발주서는 **번역가에게 보내는 문서**이고,
 * 승인되지 않은 금액이 적힌 종이가 외부로 나가면 그 금액이 약속으로 읽힌다.
 *
 * 같은 버튼을 PO 목록과 프로젝트 상세에 붙이면서 그 제약을 빼면, 제약이 사라진다. 한 화면에서
 * 막고 다른 두 화면에서 열어 두는 것은 막은 것이 아니라 **막혔다고 믿게 만든 것**이고, 그 믿음은
 * 결제 화면의 경고문이 거짓이 되는 날까지 유지된다. 그래서 세 화면이 같은 컴포넌트를 쓴다 —
 * 판단이 한 군데에 있으면 다음에 바뀔 때도 세 곳이 같이 바뀐다.
 *
 * 비활성 버튼에는 **왜** 못 누르는지를 `title` 로 적는다. 반응 없는 버튼은 고장으로 읽힌다.
 *
 * ## 조회 권한과 무관하다
 *
 * 쓰기 권한도 묻지 않는다. 종이를 뽑는 것은 아무것도 바꾸지 않고, 이 표를 볼 수 있는 사람은
 * 이미 그 금액을 보고 있다 — 결제 화면의 같은 판단이다.
 *
 * ## 창을 스스로 띄우지 않는다
 *
 * `onPick` 으로 올리고 끝난다. `<td>` 안에서 모달을 그리면 `position: fixed` 배경이 표의
 * 스크롤 상자 안쪽에서 시작하게 되고, 행마다 모달 하나씩이 트리에 생긴다. 이 앱의 다른 표는
 * 전부 **모달을 화면 밑단에 하나만** 두고 '지금 무엇을 열었는지' 를 상태로 들고 있다
 * (`setEditing(row)`). 같은 모양을 지킨다.
 */
export function PoDocButtons({ po, onPick, disabled = false }: Props) {
  /*
   * 두 버튼의 비활성 조건과 안내가 같으므로 한 번만 만든다. 두 번 쓰면 한쪽만 고치는 일이 생기고,
   * 그때 화면은 "국문은 막혀 있는데 영문은 눌린다" 가 된다.
   */
  const blocked = !po.poApproved
  const title = blocked ? '승인되지 않은 PO는 출력할 수 없습니다.' : undefined

  const button = (lang: PrintLang, label: string) => (
    <button
      type="button"
      className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
      onClick={() => onPick({ po, lang })}
      disabled={disabled || blocked}
      title={title}
      aria-label={`${po.poCode} ${label}문 PO 문서`}
    >
      {label}
    </button>
  )

  return (
    <>
      {button(PRINT_LANG_KOR, '국')}
      {button(PRINT_LANG_ENG, '영')}
    </>
  )
}
