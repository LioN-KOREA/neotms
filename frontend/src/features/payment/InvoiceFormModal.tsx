import { useMemo, useState } from 'react'
import { useCreateInvoice, useUpdateInvoice } from '@/apis/queries/neotms.mutation'
import { usePurchaseOrders } from '@/apis/queries/neotms.query'
import {
  codeOptions,
  COIN_CODES,
  INVOICE_STATES,
  MONEY_STATE_UNPAID,
  MONEY_STATES,
  PO_STATES_INVOICEABLE,
} from '@/apis/neotms.codes'
import type { InvoiceInput, InvoiceRow, PurchaseOrderRow } from '@/apis/neotms.types'
import { Amount } from '@/shared/ui/Amount'
import { ErrorNotice, InfoNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import { StatusChip } from '@/shared/ui/StatusChip'
import { TranslatorPicker } from '@/features/translators/TranslatorPicker'
import type { PickerOption } from '@/shared/ui/RecordPicker'
import { formatDate, todayKst, toDateInputValue } from '@/shared/utils/format'
import { decimalSum, formatMoney, krwToShow, toDecimalInput } from '@/shared/utils/money'
import ui from '@/shared/ui/ui.module.css'

/**
 * 한 번에 읽어 올 PO 수. 인쇄 양식의 칸이 열 개이므로 서른은 충분히 여유롭고, 그보다 많은
 * 번역가는 '더 보기' 로 이어 읽는다. 서버는 200건까지 받는다(`InvoiceTranslatorCreateSchema`).
 */
const PO_PAGE = 30

interface Props {
  /** null 이면 신규 발행. */
  invoice: InvoiceRow | null
  onClose: () => void
  onSaved: (message: string) => void
}

/**
 * 번역가 인보이스 발행·수정.
 *
 * ## 이 화면의 본체는 PO 목록이다
 *
 * 인보이스가 `invoice_translator` 라는 테이블인 이유가 그것이다. 번역가는 네 건의 작업을 한 장에
 * 묶어 청구하고, 그 네 건을 가리킬 수 있는 것은 PO 행 하나가 아니라 인보이스 자신의 코드다.
 * 그래서 위쪽 입력란은 인쇄될 숫자들이고, **아래 체크박스 목록이 실제 명세다**.
 *
 * ## 고를 수 있는 PO와 고를 수 없는 PO를 둘 다 보여 준다
 *
 * 서버는 네 가지 PO를 거절한다 — 다른 번역가의 것, 아직 납품되지 않은 것, 이미 다른 인보이스에
 * 올라간 것, 권한 범위 밖의 것. 그리고 그 거절은 **한 문장으로 뭉쳐져 있다**(어느 PO가 왜
 * 거절되었는지 말하면 PO id 와 그 소유자를 알려 주는 열거 창구가 된다). 그러므로 그 네 조건을
 * 통과하는 PO만 고를 수 있게 만드는 것이 이 화면의 책임이다.
 *
 * 다만 통과하지 못한 PO를 **숨기지는 않는다**. 묶을 PO가 분명히 있는데 목록이 비어 있으면
 * 담당자는 고장을 의심하고, 실제 이유 — 아직 '진행' 이다 — 는 어디에도 적혀 있지 않다. 그래서
 * 체크박스만 끄고 상태 칩을 그대로 보여 준다: 그 칩이 이유다.
 *
 * ## 수정에서는 두 목록을 겹쳐 읽는다
 *
 * 이미 이 인보이스에 올라간 PO는 '청구되지 않은 PO' 가 아니다 — 이 인보이스를 가리키고
 * 있으므로 `uninvoiced` 조회에 나오지 않는다. 그래서 수정할 때는 `invoiceTranslatorId` 로 현재
 * 명세를, `uninvoiced` 로 추가 가능한 PO를 따로 읽어 합친다. 한쪽만 읽으면 흔한 수정 —
 * "같은 PO들, 합계만 정정" — 에서 명세가 통째로 비워진다.
 *
 * `poIds` 는 **교체**다(`InvoiceUpdate` 의 서버 주석). 보내면 그 목록이 전부가 되므로, 체크를
 * 하나도 하지 않은 채로는 저장할 수 없다.
 *
 * ## 금액은 계산해 주지만 덮어쓰지 않는다
 *
 * `inv_sum`·`inv_tax` 는 **인쇄된 값**이고 읽을 때 다시 계산하지 않는다. 번역가가 보낸 종이에
 * 적힌 숫자가 우리 PO 합계와 다를 수 있고(원천징수·수수료·협의), 그때 맞아야 하는 쪽은 종이다.
 * 그래서 PO 합계는 참고선으로만 보여 주고, 옮겨 적는 것은 버튼 한 번으로 둔다.
 */
export function InvoiceFormModal({ invoice, onClose, onSaved }: Props) {
  const isEdit = !!invoice
  const createInvoice = useCreateInvoice()
  const updateInvoice = useUpdateInvoice()
  const pending = createInvoice.isPending || updateInvoice.isPending

  const [translator, setTranslator] = useState<PickerOption | null>(
    invoice?.translatorId
      ? { id: invoice.translatorId, title: invoice.tranName ?? invoice.translatorId }
      : null,
  )

  const [form, setForm] = useState({
    invDay: toDateInputValue(invoice?.invDay) || todayKst(),
    coinCode: invoice?.coinCode ?? 'KRW',
    invSum: invoice?.invSum ?? '',
    invTax: invoice?.invTax ?? '',
    invMoPday: toDateInputValue(invoice?.invMoPday),
    invState: invoice?.invState ?? '발행',
    invMoState: invoice?.invMoState ?? MONEY_STATE_UNPAID,
    invMoGubun: invoice?.invMoGubun ?? '',
    invMoDay: toDateInputValue(invoice?.invMoDay),
    invMoSum: invoice?.invMoSum ?? '',
    invMoTax: invoice?.invMoTax ?? '',
  })
  const [dirty, setDirty] = useState(false)

  /** 체크된 PO. 신규에서는 비어 있고, 수정에서는 아래 조회가 끝난 뒤 한 번 채워진다. */
  const [picked, setPicked] = useState<readonly string[]>([])
  /** 수정 모드에서 현재 명세를 picked 에 한 번만 옮겨 넣기 위한 표시. */
  const [seeded, setSeeded] = useState(!isEdit)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setDirty(true)
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  /*
   * 두 목록. 위 주석 참고.
   *
   * 번역가를 고르기 전에는 둘 다 돌지 않는다 — 번역가 없는 `uninvoiced` 조회는 **다른 번역가의
   * 미청구 PO 전부**이고, 그 목록은 이 화면에서 아무 의미가 없다.
   */
  const addableQuery = usePurchaseOrders(
    { limit: PO_PAGE, translatorId: translator?.id, uninvoiced: 'true' },
    !!translator,
  )
  const currentQuery = usePurchaseOrders(
    { limit: PO_PAGE, invoiceTranslatorId: invoice?.id },
    isEdit,
  )

  /**
   * 합친 PO 목록. 현재 명세를 먼저 둔다 — 수정 화면을 열면 지금 이 인보이스에 올라간 것이
   * 위에 있어야 한다.
   */
  const pos = useMemo<readonly PurchaseOrderRow[]>(() => {
    const seen = new Set<string>()
    const out: PurchaseOrderRow[] = []
    const pages = [
      ...(currentQuery.data?.pages ?? []),
      ...(addableQuery.data?.pages ?? []),
    ]
    for (const page of pages) {
      for (const row of page.items) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        out.push(row)
      }
    }
    return out
  }, [currentQuery.data, addableQuery.data])

  /*
   * 수정 모드의 초기 체크. 조회가 끝나는 시점에 한 번만 한다.
   *
   * `useEffect` 가 아니라 렌더 중에 하는 이유는 `MaintenanceView` 의 첫 탭 보정과 같다 —
   * 효과로 미루면 렌더가 한 번 더 돌고, 그 한 프레임 동안 "명세가 비어 있는 인보이스" 가 그려진다.
   * 저장 버튼이 그 프레임에 눌릴 수 있다는 것이 더 큰 문제다.
   */
  if (!seeded && isEdit && currentQuery.isSuccess) {
    setSeeded(true)
    setPicked((currentQuery.data?.pages ?? []).flatMap((p) => p.items).map((r) => r.id))
  }

  const invoiceable = (row: PurchaseOrderRow) =>
    PO_STATES_INVOICEABLE.includes((row.poState ?? '').trim())

  const toggle = (id: string) => {
    setDirty(true)
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  /**
   * 고른 PO들의 원화 환산 합계. `inv_sum` 의 **참고선**이고, 자동으로 들어가지 않는다 —
   * 위 주석 참고.
   */
  const total = useMemo(
    () =>
      decimalSum(
        pos.filter((r) => picked.includes(r.id)).map((r) => krwToShow(r.poPriceKrw, r.poPriceKsum)),
      ),
    [pos, picked],
  )

  /** 통화가 원화가 아니면 참고선을 옮겨 적을 수 없다 — 단위가 다른 숫자다. */
  const coin = form.coinCode.trim().toUpperCase() || 'KRW'
  const transferable = coin === 'KRW' && total.counted > 0

  const canSave = !!translator && picked.length > 0 && !pending && (seeded || !isEdit)

  const onSubmit = async () => {
    if (!translator || picked.length === 0) return

    const common = {
      poIds: [...picked],
      invDay: form.invDay || null,
      coinCode: form.coinCode.trim() || null,
      invSum: toDecimalInput(form.invSum),
      invTax: toDecimalInput(form.invTax),
      invMoPday: form.invMoPday || null,
      invState: form.invState.trim() || null,
      invMoState: form.invMoState.trim() || null,
      invMoGubun: form.invMoGubun.trim() || null,
      invMoDay: form.invMoDay || null,
      invMoSum: toDecimalInput(form.invMoSum),
      invMoTax: toDecimalInput(form.invMoTax),
    }

    if (invoice) {
      await updateInvoice.mutateAsync({ id: invoice.id, input: common })
      onSaved(`인보이스 ${invoice.invTranCode} 를 수정했습니다. (PO ${picked.length}건)`)
    } else {
      const input: InvoiceInput = { ...common, translatorId: translator.id }
      const made = await createInvoice.mutateAsync(input)
      onSaved(`인보이스 ${made.invTranCode} 를 발행했습니다. (PO ${picked.length}건)`)
    }
    onClose()
  }

  const loadingPos = addableQuery.isLoading || currentQuery.isLoading

  return (
    <Modal
      title={isEdit ? '인보이스 수정' : '인보이스 발행'}
      onClose={onClose}
      isDirty={dirty && !pending}
      width={900}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose} disabled={pending}>
            취소
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void onSubmit()}
            disabled={!canSave}
          >
            {pending ? '저장 중…' : isEdit ? '저장' : '발행'}
          </button>
        </>
      }
    >
      <ErrorNotice error={createInvoice.error ?? updateInvoice.error} />

      {isEdit ? (
        <p className={ui.hint}>
          인보이스 코드 <strong>{invoice.invTranCode}</strong> — 코드와 번역가는 변경할 수 없습니다.
          번역가를 바꾸는 것은 잘못을 고치는 일이 아니라 남의 청구서를 다른 사람에게 돌리는 일이므로,
          잘못 발행했다면 삭제하고 다시 발행해 주세요.
        </p>
      ) : null}

      <div className={ui.formGrid}>
        <div className={ui.fieldWide}>
          {isEdit ? (
            <div className={ui.field}>
              <span className={ui.label}>번역가</span>
              <div className={ui.pickerSelected}>
                <span className={ui.pickerSelectedText}>
                  <span className={ui.pickerItemTitle}>{translator?.title ?? '-'}</span>
                </span>
              </div>
            </div>
          ) : (
            <TranslatorPicker
              value={translator}
              onChange={(option) => {
                setDirty(true)
                setTranslator(option)
                // 번역가가 바뀌면 고른 PO는 전부 남의 것이 된다. 서버도 거절하지만, 그 거절은
                // 저장을 누른 뒤에 온다.
                setPicked([])
              }}
              required
              disabled={pending}
            />
          )}
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="inv-day">
            발행일
          </label>
          <input
            id="inv-day"
            className={ui.input}
            type="date"
            value={form.invDay}
            onChange={(e) => set('invDay', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="inv-coin">
            통화
          </label>
          <select
            id="inv-coin"
            className={ui.select}
            value={form.coinCode}
            onChange={(e) => set('coinCode', e.target.value)}
          >
            <option value="">선택 없음</option>
            {codeOptions(COIN_CODES, form.coinCode).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className={ui.hint}>번역가가 청구한 통화입니다.</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="inv-state">
            발행 상태
          </label>
          <select
            id="inv-state"
            className={ui.select}
            value={form.invState}
            onChange={(e) => set('invState', e.target.value)}
          >
            <option value="">선택 없음</option>
            {codeOptions(INVOICE_STATES, form.invState).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="inv-mo-pday">
            지급 예정일
          </label>
          <input
            id="inv-mo-pday"
            className={ui.input}
            type="date"
            value={form.invMoPday}
            onChange={(e) => set('invMoPday', e.target.value)}
          />
          <span className={ui.hint}>인보이스의 PAYMENT DATE 줄에 인쇄됩니다.</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="inv-sum">
            Sub Total ({coin})
          </label>
          <input
            id="inv-sum"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.invSum}
            onChange={(e) => set('invSum', e.target.value)}
          />
          <span className={ui.hint}>
            번역가가 청구한 금액을 그대로 적습니다. 다시 계산하지 않습니다.
          </span>
        </div>

        {/*
         * 세액은 금액이지 세율이 아니다 — `invoice_translator.inv_tax` 의 DDL 주석. 그래서 Sub
         * Total 에서 자동으로 만들지 않는다. 적용되는 세율이 번역가의 거주지와 계약 형태에 따라
         * 다르고, 그 판단은 이 화면에 없는 정보다.
         */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="inv-tax">
            Tax ({coin})
          </label>
          <input
            id="inv-tax"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.invTax}
            onChange={(e) => set('invTax', e.target.value)}
          />
          <span className={ui.hint}>세율이 아니라 금액입니다.</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="inv-mo-state">
            지급
          </label>
          <select
            id="inv-mo-state"
            className={ui.select}
            value={form.invMoState}
            onChange={(e) => set('invMoState', e.target.value)}
          >
            <option value="">선택 없음</option>
            {codeOptions(MONEY_STATES, form.invMoState).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {/*
           * 이 값은 인보이스 한 장의 지급 상태이고, PO 각각의 `po_money_state` 와 **별개다.**
           * 한 인보이스에 묶인 PO들이 서로 다른 시점에 정산될 수 있으므로(그래서 두 칸이다),
           * PO 쪽은 목록의 '정산' 에서 따로 적는다.
           */}
          <span className={ui.hint}>
            인보이스 전체의 지급 상태입니다. PO별 정산은 승인·정산 탭에서 적습니다.
          </span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="inv-mo-day">
            실지급일
          </label>
          <input
            id="inv-mo-day"
            className={ui.input}
            type="date"
            value={form.invMoDay}
            onChange={(e) => set('invMoDay', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="inv-mo-sum">
            지급액 ({coin})
          </label>
          <input
            id="inv-mo-sum"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.invMoSum}
            onChange={(e) => set('invMoSum', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="inv-mo-tax">
            지급 세액 ({coin})
          </label>
          <input
            id="inv-mo-tax"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.invMoTax}
            onChange={(e) => set('invMoTax', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="inv-mo-gubun">
            지급 구분
          </label>
          <input
            id="inv-mo-gubun"
            className={ui.input}
            value={form.invMoGubun}
            onChange={(e) => set('invMoGubun', e.target.value)}
          />
        </div>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* 명세 — 이 화면의 본체                                             */}
      {/* ---------------------------------------------------------------- */}

      <div className={ui.cardHeader}>
        <span>
          청구할 PO <strong>{picked.length}</strong>건 선택
        </span>
        <span className={ui.spacer} />
        <span className={ui.hint}>
          선택한 PO 원가 합계 <Amount value={total.total} kind="cost" />
          {transferable ? (
            <>
              {' '}
              <button
                type="button"
                className={ui.btnLink}
                onClick={() => set('invSum', total.total ?? '')}
              >
                Sub Total 로 옮기기
              </button>
            </>
          ) : null}
        </span>
      </div>

      {!translator ? (
        <p className={ui.pageHint}>번역가를 먼저 고르면 청구할 수 있는 PO가 나타납니다.</p>
      ) : (
        <div className={ui.tableWrap}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th />
                <th>코드</th>
                <th>PO명 · 작업</th>
                <th>원가(원화)</th>
                <th>마감일</th>
                <th>진행</th>
                <th>승인</th>
              </tr>
            </thead>
            <tbody>
              {loadingPos ? (
                <tr>
                  <td colSpan={7} className={ui.cellMuted}>
                    PO를 읽고 있습니다…
                  </td>
                </tr>
              ) : pos.length === 0 ? (
                <tr>
                  <td colSpan={7} className={ui.cellMuted}>
                    이 번역가에게 청구할 수 있는 PO가 없습니다. 납품된 PO만 인보이스에 올릴 수
                    있고, 이미 다른 인보이스에 올라간 PO는 여기 나오지 않습니다.
                  </td>
                </tr>
              ) : null}
              {pos.map((row) => {
                const ok = invoiceable(row)
                const on = picked.includes(row.id)
                return (
                  <tr key={row.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!ok || pending}
                        aria-label={`${row.poCode} 선택`}
                        onChange={() => toggle(row.id)}
                      />
                    </td>
                    <td className={ui.cellMono}>{row.poCode}</td>
                    <td>
                      <div>{row.poName || '(이름 없음)'}</div>
                      <div className={ui.cellMuted}>{row.jobName || row.jobCode || '-'}</div>
                    </td>
                    <td>
                      <Amount value={krwToShow(row.poPriceKrw, row.poPriceKsum)} kind="cost" />
                    </td>
                    <td className={ui.cellMuted}>{formatDate(row.poEday)}</td>
                    {/* 체크할 수 없는 행에서는 이 칩이 곧 이유다 — 위 주석 참고. */}
                    <td>
                      <StatusChip value={row.poState} />
                    </td>
                    <td>
                      <StatusChip value={row.poMoneyState} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {picked.length === 0 && translator ? (
        <InfoNotice>
          PO를 하나 이상 골라야 인보이스를 발행할 수 있습니다. 아무것도 청구하지 않는 인보이스는
          받는 사람에게 합계 0 원인 문서가 됩니다.
        </InfoNotice>
      ) : null}

      {total.skipped > 0 ? (
        <InfoNotice>
          고른 PO 중 {total.skipped}건은 금액이 입력되어 있지 않아 합계에서 빠졌습니다. PO
          금액을 먼저 채워 주세요 — 인보이스에는 올라가지만 합계에는 잡히지 않습니다.
        </InfoNotice>
      ) : null}

      <p className={ui.hint}>
        발행자(PM)는 지금 로그인한 계정으로 기록되며, 그 이름·연락처가 인보이스 서명란에 인쇄됩니다.
        인보이스 코드는 저장할 때 서버가 부여합니다. 합계 {formatMoney(total.total)} 원은 PO
        원가이고, 위 Sub Total 은 번역가가 청구한 금액입니다 — 두 값이 달라도 됩니다.
      </p>
    </Modal>
  )
}
