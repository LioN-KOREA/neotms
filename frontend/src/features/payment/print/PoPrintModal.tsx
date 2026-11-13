import type { PurchaseOrderRow } from '@/apis/neotms.types'
import { pdfFileName } from './exportPdf'
import { PoPrintDoc } from './PoPrintDoc'
import { PrintDocModal, printLangOf, type PrintLang } from './PrintDocModal'

/**
 * PO 문서 출력 창. **조회가 없는 컴포넌트다** — 목록이 이미 들고 있는 행 하나로 다 그린다.
 *
 * PO 문서에 인쇄되는 모든 값이 `PurchaseOrderRow` 에 있다. 번역가 이름·이메일, PM 이름·전화·이메일,
 * 금액·세액·통화, 납기와 시각까지. 그래서 이 창은 `po` 를 받아 넘기는 것 외에 하는 일이 세 가지뿐이고,
 * 셋 다 "레거시가 주소로 표현했던 것" 을 값으로 옮긴 것이다.
 *
 * ## 1. 서식 언어는 `po_lang` 에서 온다 — 누른 버튼이 말해 주지 않는 한
 *
 * 레거시는 `PDF_Po_KOR.asp` 와 `PDF_Po_ENG.asp` 두 주소였고, 어느 쪽을 열지는 PO 목록의 링크가
 * 알고 있었다. 지금은 한 창이 둘을 다 그리므로 **기본값**이 필요하고, 그 기본값은 `po_lang` 이다 —
 * PO 를 올릴 때 담당자가 고른 값, 즉 "이 번역가에게는 영문으로 보낸다" 는 결정이 이미 내려져 있다
 * (`printLangOf` 의 주석).
 *
 * `lang` 을 주면 그 값이 이긴다. PO 목록의 **국 / 영** 두 버튼이 쓰는 길이고(`PoDocButtons`),
 * 레거시의 두 주소를 두 버튼으로 되돌린 것이다 — 그쪽에서는 버튼을 누른 행위 자체가 "이번에는
 * 영문으로 뽑는다" 는 지시이므로, 저장된 기본값보다 우선한다.
 *
 * 어느 쪽으로 열렸든 창 안의 '서식' 드롭다운으로 바꿀 수 있다. 즉 이 값은 **시작점**이고,
 * 잘못 눌렀을 때 창을 닫고 다시 누를 필요는 없다.
 *
 * ## 2. 파일명은 레거시의 것을 그대로 만든다
 *
 * `SPO_071763_이정민.pdf`. PO 코드가 먼저인 것이 중요하다 — 담당자의 다운로드 폴더에서 PO 문서는
 * 코드로 정렬되어야 찾을 수 있고, 이름이 먼저면 같은 번역가의 서로 다른 PO 가 섞인다.
 *
 * ## 3. 창 제목은 인쇄 대화상자의 제목이기도 하다
 *
 * `printElement` 가 `title` 을 iframe 문서의 `<title>` 로 쓰므로, 브라우저에서 "PDF 로 인쇄" 를
 * 고르면 이 문자열이 기본 파일명이 된다. 그래서 모달 머리글로 보기 좋은 말이 아니라 **파일명으로
 * 쓸 수 있는 말**을 넣는다.
 */
export function PoPrintModal({
  po,
  lang,
  onClose,
}: {
  po: PurchaseOrderRow
  /** 열면서 고르는 서식. 생략하면 `po_lang` 을 따른다 — 위 1번 참고. */
  lang?: PrintLang
  onClose: () => void
}) {
  return (
    <PrintDocModal
      title={`PO 문서 ${po.poCode}`}
      fileName={pdfFileName(po.poCode, po.poTranName)}
      initialLang={lang ?? printLangOf(po.poLang)}
      onClose={onClose}
    >
      {(lang) => <PoPrintDoc po={po} lang={lang} />}
    </PrintDocModal>
  )
}
