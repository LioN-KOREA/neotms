import { useState } from 'react'
import { useUpdatePurchaseOrder } from '@/apis/queries/neotms.mutation'
import { MONEY_STATE_PAID } from '@/apis/neotms.codes'
import type { PurchaseOrderRow } from '@/apis/neotms.types'
import { ErrorNotice, InfoNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import type { PickerOption } from '@/shared/ui/RecordPicker'
import ui from '@/shared/ui/ui.module.css'
import { TranslatorPicker } from '@/features/translators/TranslatorPicker'

/**
 * 이 발주의 번역가를 **바꿀 수 있는지**. 표의 칸과 이 대화상자가 같은 답을 써야 하므로 여기 있다.
 *
 * ## 승인된 발주와 정산된 발주에서는 바꿀 수 없다
 *
 * 둘은 서로 다른 이유로 막힌다.
 *
 * **승인**(`po_approved`)은 "이 금액을 이 사람에게 준다" 에 결재가 떨어진 상태다. 승인은 결제
 * 권한의 별도 엔드포인트가 사람과 시각을 적어 남기는데(`po_approved_by`·`po_approved_at`),
 * 번역가만 조용히 갈아치우면 **그 승인 기록이 다른 사람에 대한 결재로 읽힌다.** 승인한 사람은
 * 자기가 승인한 적 없는 지급을 승인한 것이 되고, 그 사실은 어느 화면에도 표시되지 않는다.
 *
 * **정산완료**(`po_money_state`)는 돈이 이미 나간 상태다. 지급 기록 네 칸(금액·날짜·수단·상태)은
 * 그 돈을 받은 사람에 대한 사실이므로, 번역가를 바꾸면 **A 에게 준 돈이 B 의 지급 이력이 된다.**
 * 받지 못한 B 는 미정산 목록에 나타나지 않으므로 아무도 신고하지 않고, A 는 자기 지급 이력에서
 * 그 건이 사라진 것을 발견한다.
 *
 * 부분정산은 막지 않는다 — 선금만 나간 상태에서 사람이 바뀌는 일은 실제로 있고(초벌을 받고
 * 교체), 그때 남은 금액의 지급 대상이 바뀌는 것이 맞다. 그 경우 정산 화면이 이미 나간 금액을
 * 들고 있으므로 사실이 사라지지는 않는다.
 *
 * ## 막는 쪽이 고치는 쪽보다 낫다
 *
 * 두 경우 모두 "승인을 해제하고 바꾼 뒤 다시 승인한다" 는 길이 **열려 있다.** 그 길은 기록을
 * 남긴다(해제한 사람, 다시 승인한 사람). 여기서 바로 바꾸게 해 주는 것은 그 기록을 건너뛰게
 * 해 주는 일이고, 편의가 아니라 감사 기록의 구멍이다.
 */
export function mayChangeTranslator(po: PurchaseOrderRow): boolean {
  return !po.poApproved && po.poMoneyState !== MONEY_STATE_PAID
}

/** 바꿀 수 없는 칸에 띄울 안내. 비활성 칸은 **왜** 비활성인지를 말해야 한다. */
export function translatorLockReason(po: PurchaseOrderRow): string | undefined {
  if (po.poApproved) return '승인된 PO의 번역가는 바꿀 수 없습니다. 승인을 먼저 해제하세요.'
  if (po.poMoneyState === MONEY_STATE_PAID) return '정산이 끝난 PO의 번역가는 바꿀 수 없습니다.'
  return undefined
}

interface Props {
  purchaseOrder: PurchaseOrderRow
  onClose: () => void
  onSaved: (message: string) => void
}

/**
 * 발주 한 건의 **번역가만** 바꾸는 대화상자.
 *
 * ## 왜 수정 모달을 열지 않는가
 *
 * 번역가 교체는 발주에서 가장 흔한 단일 수정이다(원래 맡기려던 사람이 못 받는다, 단가 협의가
 * 깨진다, 초벌만 받고 교체한다). `PurchaseOrderFormModal` 을 열면 20개가 넘는 칸이 함께 열리고,
 * 그중에는 **환산 금액과 환율**이 있다 — 사람만 바꾸려고 열었다가 금액을 건드려 저장하는 사고가
 * 그 자리에서 난다. 제자리 수정이 존재하는 이유와 같다(`InlineEditCell` 머리말).
 *
 * 보내는 것은 `{ translatorId }` 한 칸이다. 서버의 수정은 부분 수정이므로 나머지는 **바뀔 수가
 * 없다.**
 *
 * ## 지금 누구인지와 누구로 바꾸는지를 따로 보여 준다
 *
 * `RecordPicker` 는 고른 값이 있으면 검색란을 숨긴다(그쪽 주석 — 한 번에 한 상태만 보이게 하는
 * 것이 목적이다). 그래서 현재 번역가를 picker 에 **넣지 않는다.** 넣었다면 바꾸려는 사람이 먼저
 * '변경' 을 눌러 비운 뒤 검색해야 하고, 그 한 번은 이 대화상자를 여는 목적 자체를 한 단계
 * 늘린다. 현재 번역가는 위에 글로 적는다.
 *
 * ## 통화는 확인하지 않는다 — 알린다
 *
 * 발주의 통화는 번역가의 정산 통화와 같아야 한다(등록 폼의 안내). 사람이 바뀌면 그 전제가 깨질
 * 수 있는데, 여기서 통화까지 고치게 하면 이 대화상자는 다시 금액을 만지는 창이 된다. 그래서
 * 바꾼 뒤 **금액을 확인하라고 적고**, 고치는 것은 수정 모달에 맡긴다.
 */
export function TranslatorSwapModal({ purchaseOrder: po, onClose, onSaved }: Props) {
  const updatePo = useUpdatePurchaseOrder()
  const [picked, setPicked] = useState<PickerOption | null>(null)
  /** '지정 해제' 를 눌렀는지. `picked === null` 과 구별해야 한다 — 아래 `canSave` 참고. */
  const [clearing, setClearing] = useState(false)

  const current = po.poTranName || (po.translatorId ? po.translatorId : null)

  /*
   * 저장할 수 있는 경우가 둘이다: 누군가를 **골랐고 그 사람이 지금 사람과 다를** 때, 또는
   * '지정 해제' 를 눌렀을 때.
   *
   * 두 경우를 한 상태로 합치지 않는 이유는 `null` 이 "아직 안 골랐다" 와 "비우겠다" 를 동시에
   * 뜻할 수 없기 때문이다. 합쳤다면 대화상자를 열자마자 저장 버튼이 눌리는 상태가 되고, 그
   * 클릭은 멀쩡한 번역가를 지운다.
   */
  const nextId = clearing ? null : (picked?.id ?? null)
  const changed = nextId !== (po.translatorId ?? null)
  const canSave = (clearing || picked !== null) && changed && !updatePo.isPending

  const onSubmit = async () => {
    if (!canSave) return
    await updatePo.mutateAsync({ id: po.id, input: { translatorId: nextId } })
    onSaved(
      nextId === null
        ? `PO [${po.poCode}] 의 번역가 지정을 해제했습니다.`
        : `PO [${po.poCode}] 의 번역가를 ${picked?.title} 로 바꿨습니다.`,
    )
    onClose()
  }

  return (
    <Modal
      title="번역가 변경"
      onClose={onClose}
      /* 고른 것이 있으면 배경 클릭에 한 번 묻는다 — 검색해서 찾은 결과가 사라지는 것은 되돌리기 비싸다. */
      isDirty={canSave}
      width={520}
      footer={
        <>
          <button
            type="button"
            className={ui.btn}
            onClick={onClose}
            disabled={updatePo.isPending}
          >
            취소
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void onSubmit()}
            disabled={!canSave}
          >
            {updatePo.isPending ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      <ErrorNotice error={updatePo.error} />

      <p className={ui.hint}>
        PO <strong>{po.poCode}</strong> — 번역가만 바뀝니다. 금액·납기·상태는 그대로입니다.
      </p>

      <div className={ui.field}>
        <span className={ui.label}>현재 번역가</span>
        <div className={ui.pickerSelected}>
          <span className={ui.pickerSelectedText}>
            <span className={ui.pickerItemTitle}>{current ?? '미지정'}</span>
            {po.poCoinCode ? (
              <span className={ui.pickerItemSub}>이 PO의 통화 {po.poCoinCode}</span>
            ) : null}
          </span>
          {/*
           * '지정 해제'. 번역가가 비어 있는 발주는 정상 상태다(단가 협의 중) — PO 목록이 그
           * 상태를 '미지정' 배지로 드러내는 것도 그래서다. 되돌릴 길이 없으면 잘못 지정한
           * 발주를 고치는 방법이 수정 모달뿐이 된다.
           */}
          {po.translatorId && !clearing ? (
            <button
              type="button"
              className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
              onClick={() => {
                setPicked(null)
                setClearing(true)
              }}
              disabled={updatePo.isPending}
            >
              지정 해제
            </button>
          ) : null}
        </div>
      </div>

      {clearing ? (
        <InfoNotice>
          번역가 지정을 <strong>해제</strong>합니다. 저장하면 이 PO의 지급 대상이 없어집니다.{' '}
          <button
            type="button"
            className={ui.btnLink}
            onClick={() => setClearing(false)}
          >
            되돌리기
          </button>
        </InfoNotice>
      ) : (
        <div className={ui.field}>
          <TranslatorPicker
            value={picked}
            onChange={setPicked}
            disabled={updatePo.isPending}
          />
        </div>
      )}

      {/* 통화는 여기서 고치지 않는다 — 위 머리말의 마지막 문단 참고. */}
      {picked && po.poCoinCode ? (
        <InfoNotice>
          이 PO의 통화는 <strong>{po.poCoinCode}</strong> 입니다. 바꾼 번역가의 정산 통화가 다르면
          PO 수정에서 금액을 확인하세요.
        </InfoNotice>
      ) : null}
    </Modal>
  )
}
