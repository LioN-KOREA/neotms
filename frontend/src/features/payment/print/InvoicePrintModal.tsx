import { useMemo } from 'react'
import { usePurchaseOrders } from '@/apis/queries/neotms.query'
import type { InvoiceRow, PurchaseOrderRow } from '@/apis/neotms.types'
import { ErrorNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'
import { pdfFileName } from './exportPdf'
import { InvoicePrintDoc } from './InvoicePrintDoc'
import { PrintDocModal } from './PrintDocModal'

/**
 * 인보이스 출력 창. **PO 문서 쪽과 달리 조회가 하나 있다.**
 *
 * 인보이스 서식의 본체는 명세 표이고, 그 표의 행은 `invoice_translator` 가 아니라 **거기에 묶인
 * PO 들**이다(`InvoiceRow` 에는 금액 합계만 있고 명세가 없다). 그러므로 이 창은 읽어 와야 한다.
 *
 * ## 한 페이지로 다 읽는다 — 페이지네이션이 없다
 *
 * `limit` 을 200 으로 둔 것이 그 장치다. 서버의 한 페이지 상한이 200행이고(`NEOTMS_PAGE_SIZE_MAX`),
 * 인보이스가 가질 수 있는 PO 도 200건이다(`InvoiceInput.poIds`). 두 숫자가 같으므로 **어떤
 * 인보이스든 한 페이지에 전부 들어온다** — 우연이 아니라 그 상한을 그렇게 맞춰 둔 것이다.
 *
 * 이 자리에 '더 보기' 를 둘 수는 없었다. 서식은 종이 한 장이고, 담당자가 버튼을 몇 번 눌렀는지에
 * 따라 명세 행 수가 달라지는 정산 문서는 틀린 문서다.
 *
 * ## 다 읽기 전에는 서식을 그리지 않는다
 *
 * 조회 중에 `InvoicePrintDoc` 을 그리면 `pos` 가 빈 배열이고, 그 서식은 **빈 행 열 개짜리 멀쩡한
 * 인보이스처럼 보인다** — 합계만 있고 명세가 없는 종이다. 그 상태에서 PDF저장을 누르는 데는 아무
 * 장애물이 없고, 저장된 파일에는 "고장" 이라고 적혀 있지 않다.
 *
 * 그래서 로딩 중에는 `PrintDocModal` 자체를 **띄우지 않는다**. 버튼만 잠그는 방법도 있지만, 그러면
 * 잠긴 버튼 뒤로 백지 서식이 보이고 그것이 결과물처럼 읽힌다. 읽는 동안에는 읽고 있다고만 말한다.
 */
export function InvoicePrintModal({
  invoice,
  onClose,
}: {
  invoice: InvoiceRow
  onClose: () => void
}) {
  const posQuery = usePurchaseOrders({ limit: 200, invoiceTranslatorId: invoice.id })

  /**
   * 명세에 찍을 PO. 한 페이지로 끝나므로 `pages` 는 길이 1 이지만, 훅이 무한 조회인 이상
   * 형태를 맞춰 펼쳐 둔다 — 다른 목록 화면과 같은 모양이어야 다음 사람이 여기만 다르다고
   * 의심하지 않는다.
   */
  const pos = useMemo<readonly PurchaseOrderRow[]>(
    () => posQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [posQuery.data],
  )

  const title = `인보이스 ${invoice.invTranCode}`

  if (!posQuery.isSuccess) {
    return (
      <Modal
        title={title}
        onClose={onClose}
        width={520}
        footer={
          <button type="button" className={`${ui.btn} ${ui.btnGhost}`} onClick={onClose}>
            닫기
          </button>
        }
      >
        <ErrorNotice error={posQuery.error} />
        {posQuery.isLoading ? (
          <p className={ui.pageHint}>인보이스 명세에 들어갈 PO 를 읽고 있습니다…</p>
        ) : null}
      </Modal>
    )
  }

  return (
    <PrintDocModal
      title={title}
      fileName={pdfFileName(invoice.invTranCode, invoice.tranName)}
      onClose={onClose}
    >
      {/*
        * `initialLang` 을 넘기지 않는다 — 기본값 국문이다. PO 문서와 다른 점이고, 이유는
        * `InvoiceInput` 의 주석에 있다: 인보이스에는 문서 언어 칸이 없다. PO 문서는 보내는
        * 문서이므로 "이 번역가에게는 영문" 이 PO 에 적혀 있지만, 인보이스는 필요할 때 다시
        * 뽑는 문서여서 어느 서식을 원하는지는 **지금 고를 질문**이다.
        */}
      {(lang) => <InvoicePrintDoc invoice={invoice} pos={pos} lang={lang} />}
    </PrintDocModal>
  )
}
