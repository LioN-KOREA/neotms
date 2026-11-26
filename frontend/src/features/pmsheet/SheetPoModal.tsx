/**
 * '나의 업무' 시트 번역가·감수자 칸의 [발행] · [보기] · [변경] — 시트 위에 바로 뜨는 PO 창 (팀장님 2026-11-26).
 *
 * 처음에는 프로젝트 화면으로 넘어가서 PO 창을 열었는데, 시트를 떠나지 않도록 바꿨다. 창은 프로젝트 화면의
 * PO 등록·수정 창과 같은 것이다. 보기·변경은 그 PO 를 불러온 뒤에 뜬다.
 */
import { usePurchaseOrder } from '@/apis/queries/neotms.query'
import { PurchaseOrderFormModal } from '@/features/purchaseorders/PurchaseOrderFormModal'
import type { PoAction } from '@/features/purchaseorders/poDraft'
import { ErrorNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'

export function SheetPoModal(props: { action: PoAction; projectId: string; onClose: () => void; onSaved: (message: string) => void }) {
  const { action, projectId, onClose, onSaved } = props
  const po = usePurchaseOrder(action.mode === 'edit' ? action.poId : null)

  if (action.mode === 'new') {
    return (
      <PurchaseOrderFormModal
        purchaseOrder={null}
        fixedJob={{ id: action.jobId, title: action.jobTitle }}
        jobScopeProjectId={projectId}
        draft={action.draft}
        onClose={onClose}
        onSaved={onSaved}
      />
    )
  }
  if (po.data) {
    return <PurchaseOrderFormModal purchaseOrder={po.data} jobScopeProjectId={projectId} draft={action.draft ?? null} onClose={onClose} onSaved={onSaved} />
  }
  return (
    <Modal title="PO" onClose={onClose} width={420}>
      {po.error ? <ErrorNotice error={po.error} /> : <p>PO 를 불러오는 중…</p>}
    </Modal>
  )
}
