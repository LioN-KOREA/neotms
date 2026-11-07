import { useState } from 'react'
import { useSettlePurchaseOrder } from '@/apis/queries/neotms.mutation'
import {
  codeOptions,
  INVOICE_STATES,
  MONEY_STATE_PAID,
  MONEY_STATE_PARTIAL,
  MONEY_STATE_UNPAID,
  MONEY_STATES,
  PO_STATE_CANCELLED,
  PO_STATE_DELIVERED,
  PO_STATE_DONE,
  PO_STATES,
} from '@/apis/neotms.codes'
import type { PoSettlementInput, PurchaseOrderRow } from '@/apis/neotms.types'
import { ErrorNotice, InfoNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import { Amount } from '@/shared/ui/Amount'
import { toDateInputValue } from '@/shared/utils/format'
import { decimalCompare, formatMoney, krwToShow, toDecimalInput } from '@/shared/utils/money'
import ui from '@/shared/ui/ui.module.css'

interface Props {
  purchaseOrder: PurchaseOrderRow
  onClose: () => void
  onSaved: (message: string) => void
}

/**
 * PO 정산 입력 — 여섯 칸만 있는 PO 수정 화면.
 *
 * ## 왜 PO 수정 모달을 쓰지 않는가
 *
 * `PurchaseOrderFormModal` 은 같은 여섯 칸을 포함해 스무 칸이 넘는 입력을 가지고 있고, 그래서
 * 열 수 있는 사람이 금액·물량·단가·납기·번역가를 전부 바꿀 수 있다. 결제 권한은 그런 권한이
 * 아니다 — **지급이 일어났다는 사실을 적는 권한**이고, 얼마가 약정되었는지를 고치는 권한과 같은
 * 사람에게 있어야 할 이유가 없다. 서버가 `PATCH /purchase-orders/{id}/settlement` 를 따로 두고
 * 본문을 여섯 칸으로 좁힌 이유가 그것이며(`PoSettlementSchema`), 입력란도 그만큼이어야 그
 * 좁힘이 화면에서도 사실이 된다.
 *
 * ## 승인되지 않은 PO는 열리지 않는다
 *
 * 서버가 400 으로 거절한다("승인되지 않은 PO는 정산할 수 없습니다"). 여기서도 막는 이유는
 * 보안이 아니라 순서다 — 금액을 다 적고 저장을 누른 다음에 거절당하면, 사용자는 자기가 적은
 * 숫자가 틀렸다고 생각한다. 승인이 선행 조건이라는 사실은 **입력 전에** 말해야 한다.
 *
 * ## 돈 상태가 진행 상태를 끌고 간다
 *
 * 완료는 전액 지급을 뜻한다(NeotmsPoStates.ts). 그러므로 정산완료를 고르면 진행 상태도 완료로,
 * 부분정산을 고르면 납품으로 같이 움직인다 — `PurchaseOrderFormModal` 이 통화를 바꿀 때 환율을
 * 정리하는 것과 같은 자리, 같은 이유다(`set()` 안에서 함께 바꾼다. `useEffect` 로 하면 그
 * 사이의 한 렌더가 이미 저장 가능한 상태다).
 *
 * 미정산은 끌고 가지 않는다. 지급이 없다는 사실은 그 PO가 진행 중인지 납품되었는지에 대해
 * 아무것도 말하지 않으므로, 추측해서 바꾸면 담당자가 적어 둔 진행 상태를 지우게 된다.
 *
 * 그리고 **강제하지는 않는다.** 두 칸 모두 그 뒤에 손으로 바꿀 수 있고, 어긋난 조합은 아래
 * 안내로만 알린다. 서버도 같은 선택을 했고 이유가 적혀 있다 — db/015_payment.sql 11c 절의
 * 레거시 행들은 정산완료 없이 완료다. 실제로 지급되었는지는 회계가 답할 질문이므로 고치지 않고
 * 남겼고, 그 조합을 저장할 수 없게 만들면 그 행들은 **수정 자체가 불가능해진다**.
 */
export function SettlementModal({ purchaseOrder: po, onClose, onSaved }: Props) {
  const settle = useSettlePurchaseOrder()

  const [form, setForm] = useState({
    poState: po.poState ?? '',
    poInvoiceState: po.poInvoiceState ?? '',
    poMoneyState: po.poMoneyState ?? MONEY_STATE_UNPAID,
    poMoneyDay: toDateInputValue(po.poMoneyDay),
    poMoneyPrice: po.poMoneyPrice ?? '',
    poMoneyGubun: po.poMoneyGubun ?? '',
  })
  const [dirty, setDirty] = useState(false)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setDirty(true)
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      // 위 주석 참고. 미정산은 의도적으로 빠져 있다.
      if (key === 'poMoneyState') {
        if (next.poMoneyState === MONEY_STATE_PAID) next.poState = PO_STATE_DONE
        else if (next.poMoneyState === MONEY_STATE_PARTIAL) next.poState = PO_STATE_DELIVERED
      }
      return next
    })
  }

  /**
   * 이 PO의 원가. 지급액을 적을 때 견줄 상대이고, 사용자가 고칠 수 없다.
   *
   * `krwToShow` 를 거친다 — 금액을 보여 주는 모든 자리가 그래야 한다(money.ts). 미환전 외화
   * PO에서는 저장된 금액이 아니라 **지금 시점의 가치**가 견줄 상대다. 그 PO의 번역가에게
   * 오늘 송금할 원화는 등록 시점의 환율이 아니라 오늘의 환율로 계산되기 때문이다.
   */
  const owed = krwToShow(po.poPriceKrw, po.poPriceKsum)

  /**
   * 적은 지급액이 원가에 미치지 못하는지. **경고가 아니라 확인이다** — 환율 차이, 원천징수,
   * 수수료 때문에 실제 지급액이 원가와 다른 것은 정상이다. 그래서 저장을 막지 않고, 돈 상태가
   * 정산완료일 때만 말한다: 전액 지급이라고 적으면서 금액이 모자란 조합이야말로 둘 중 하나가
   * 오타인 경우다.
   */
  const paid = toDecimalInput(form.poMoneyPrice)
  const shortOfOwed =
    form.poMoneyState === MONEY_STATE_PAID && (decimalCompare(paid, owed) ?? 0) < 0

  /**
   * 돈 상태와 진행 상태가 서로 다른 말을 하는지. 위 주석의 "강제하지 않는다" 의 다른 반쪽이다.
   *
   * 취소는 견주지 않는다 — 취소된 PO는 사다리 밖이고, 서버가 아예 정산을 거절한다.
   */
  const contradiction =
    form.poState === PO_STATE_CANCELLED
      ? null
      : form.poState === PO_STATE_DONE && form.poMoneyState !== MONEY_STATE_PAID
        ? '진행 상태가 완료인데 지급이 끝나지 않았습니다. 완료는 전액 지급을 뜻합니다 — 일부만 지급되었다면 납품으로 두세요.'
        : form.poMoneyState === MONEY_STATE_PAID && form.poState !== PO_STATE_DONE
          ? '전액 지급되었는데 진행 상태가 완료가 아닙니다. 의도한 것이 아니면 완료로 바꿔 주세요.'
          : null

  const onSubmit = async () => {
    const input: PoSettlementInput = {
      poState: form.poState.trim() || null,
      poInvoiceState: form.poInvoiceState.trim() || null,
      poMoneyState: form.poMoneyState.trim() || null,
      poMoneyDay: form.poMoneyDay || null,
      poMoneyPrice: toDecimalInput(form.poMoneyPrice),
      poMoneyGubun: form.poMoneyGubun.trim() || null,
    }
    await settle.mutateAsync({ id: po.id, input })
    onSaved(`${po.poName || po.poCode} PO의 정산 내용을 저장했습니다.`)
    onClose()
  }

  return (
    <Modal
      title="PO 정산"
      onClose={onClose}
      isDirty={dirty && !settle.isPending}
      width={620}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose} disabled={settle.isPending}>
            취소
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void onSubmit()}
            disabled={!po.poApproved || settle.isPending}
          >
            {settle.isPending ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      <ErrorNotice error={settle.error} />

      {/* 승인이 선행 조건이라는 사실은 입력 전에 말한다 — 위 주석 참고. */}
      {!po.poApproved ? (
        <div className={`${ui.alert} ${ui.alertWarn}`} role="alert">
          이 PO는 아직 <strong>승인되지 않았습니다</strong>. 금액을 승인한 뒤에 정산을 기록할 수
          있습니다. 승인은 이 화면을 닫고 목록의 <strong>승인</strong> 버튼으로 합니다.
        </div>
      ) : null}

      <p className={ui.hint}>
        <strong>{po.poCode}</strong> · {po.poName || '(이름 없음)'} ·{' '}
        {po.poTranName || '번역가 미지정'} — 원가 <Amount value={owed} kind="cost" />
      </p>

      <div className={ui.formGrid}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="st-money-state">
            지급
          </label>
          <select
            id="st-money-state"
            className={ui.select}
            value={form.poMoneyState}
            onChange={(e) => set('poMoneyState', e.target.value)}
          >
            <option value="">선택 없음</option>
            {codeOptions(MONEY_STATES, form.poMoneyState).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className={ui.hint}>
            고르면 아래 진행 상태가 따라옵니다. 그 뒤에 직접 바꿀 수 있습니다.
          </span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="st-state">
            진행 상태
          </label>
          <select
            id="st-state"
            className={ui.select}
            value={form.poState}
            onChange={(e) => set('poState', e.target.value)}
          >
            <option value="">선택 없음</option>
            {codeOptions(PO_STATES, form.poState).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="st-money-day">
            지급일
          </label>
          <input
            id="st-money-day"
            className={ui.input}
            type="date"
            value={form.poMoneyDay}
            onChange={(e) => set('poMoneyDay', e.target.value)}
          />
          <span className={ui.hint}>실제로 송금한 날입니다. 인보이스의 예정일과 다를 수 있습니다.</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="st-money-price">
            지급액
          </label>
          <input
            id="st-money-price"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.poMoneyPrice}
            onChange={(e) => set('poMoneyPrice', e.target.value)}
          />
          <span className={ui.hint}>
            원가 {formatMoney(owed)} 원. 원천징수·수수료 때문에 다를 수 있습니다.
          </span>
        </div>

        {/*
         * 지급 구분. 레거시 `po_money_gubun` 을 자유 입력으로 둔다 — 운영 데이터에서 어떤 값들이
         * 쓰이는지 확인되지 않았고, 지금 드롭다운으로 고정하면 목록에 없는 값으로 저장된 기존
         * 행들이 수정할 때마다 조용히 다른 값으로 바뀐다. `po_tax` 와 같은 판단이다.
         */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="st-money-gubun">
            지급 구분
          </label>
          <input
            id="st-money-gubun"
            className={ui.input}
            value={form.poMoneyGubun}
            onChange={(e) => set('poMoneyGubun', e.target.value)}
          />
          <span className={ui.hint}>계좌이체·페이팔 등. 레거시 값을 그대로 보관합니다.</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="st-invoice-state">
            계산서
          </label>
          <select
            id="st-invoice-state"
            className={ui.select}
            value={form.poInvoiceState}
            onChange={(e) => set('poInvoiceState', e.target.value)}
          >
            <option value="">선택 없음</option>
            {codeOptions(INVOICE_STATES, form.poInvoiceState).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {contradiction ? <InfoNotice>{contradiction}</InfoNotice> : null}

      {shortOfOwed ? (
        <InfoNotice>
          지급액이 원가({formatMoney(owed)} 원)보다 적은데 <strong>정산완료</strong>로 적혀
          있습니다. 환율·원천징수 때문이라면 그대로 저장하시고, 아직 남은 금액이 있다면{' '}
          <strong>부분정산</strong>으로 두세요.
        </InfoNotice>
      ) : null}
    </Modal>
  )
}
