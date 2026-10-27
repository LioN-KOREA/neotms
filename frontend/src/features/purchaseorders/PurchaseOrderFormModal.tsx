import { useState } from 'react'
import {
  useCreatePurchaseOrder,
  useUpdatePurchaseOrder,
} from '@/apis/queries/neotms.mutation'
import {
  codeOptions,
  COIN_CODES,
  INVOICE_STATES,
  MONEY_STATES,
  PO_STATES,
  UNIT_CODES,
  WORK_CODES,
} from '@/apis/neotms.codes'
import type {
  PurchaseOrderInput,
  PurchaseOrderRow,
  PurchaseOrderUpdate,
} from '@/apis/neotms.types'
import { ErrorNotice, InfoNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import type { PickerOption } from '@/shared/ui/RecordPicker'
import { toDateInputValue } from '@/shared/utils/format'
import { decimalMultiply, decimalSubtract, formatMoney, toDecimalInput } from '@/shared/utils/money'
import ui from '@/shared/ui/ui.module.css'
import { JobPicker } from '@/features/jobs/JobPicker'
import { TranslatorPicker } from '@/features/translators/TranslatorPicker'

interface Props {
  /** null 이면 신규. */
  purchaseOrder: PurchaseOrderRow | null
  /** 소속 작업이 이미 정해진 경우(프로젝트 상세의 '발주 추가'). */
  fixedJob?: PickerOption | null
  onClose: () => void
  onSaved: (message: string) => void
}

/**
 * 발주(PO) 등록·수정. **이 시스템의 원가가 여기서 입력된다.**
 *
 * ## 작업에 달린다는 것이 이 화면의 전부다
 *
 * 매출은 작업에, 원가는 그 작업의 발주에 쌓인다. 그래서 `jobId` 가 필수이고, 수정에서는 바꿀
 * 수 없다(`PurchaseOrderUpdate` 에 `jobId` 가 없다). 발주를 다른 작업으로 옮기는 것은 원가를
 * 다른 매출에 붙이는 일이고, 그러면 **두 작업의 마진이 동시에 틀린다** — 그리고 어느 화면도
 * 틀렸다고 말해 주지 않는다.
 *
 * ## 합계는 화면이 계산하고 사용자가 고칠 수 있다
 *
 * `po_price_sum`·`po_price_ksum` 도 작업과 똑같이 받은 값을 그대로 저장한다. 이유와 계산 방식은
 * `JobFormModal` 의 주석과 같다 — 계산은 `BigInt` 10진 연산으로 하고, 한 번 직접 고친 합계는
 * 그 뒤로 자동 갱신하지 않는다.
 *
 * ## CAT 분석값은 사용 여부를 켤 때만 보인다
 *
 * `poCatWord`·`poCatMid`·`poCatStotal` 은 CAT 툴 분석 결과를 옮겨 적는 칸이다. 쓰지 않는
 * 발주에서는 영원히 비어 있고, 항상 보이면 20개가 넘는 입력란 사이에서 "채워야 하는 칸" 으로
 * 읽힌다.
 */
export function PurchaseOrderFormModal({
  purchaseOrder: po,
  fixedJob = null,
  onClose,
  onSaved,
}: Props) {
  const isEdit = !!po
  const createPo = useCreatePurchaseOrder()
  const updatePo = useUpdatePurchaseOrder()
  const pending = createPo.isPending || updatePo.isPending

  const [job, setJob] = useState<PickerOption | null>(
    po
      ? {
          id: po.jobId,
          title: po.jobName || po.jobCode || po.jobId,
          subtitle: [po.jobCode, po.prjName].filter(Boolean).join(' · '),
        }
      : fixedJob,
  )

  const [translator, setTranslator] = useState<PickerOption | null>(
    po?.translatorId
      ? { id: po.translatorId, title: po.poTranName ?? po.translatorId }
      : null,
  )

  const [form, setForm] = useState({
    poName: po?.poName ?? '',
    poWorkCode: po?.poWorkCode ?? '번역',
    poCatUse: po?.poCatUse ?? false,
    poCatWord: po?.poCatWord ?? '',
    poCatMid: po?.poCatMid ?? '',
    poCatStotal: po?.poCatStotal ?? '',
    poSlang: po?.poSlang ?? '',
    poElang: po?.poElang ?? '',
    poVolume: po?.poVolume ?? '',
    poUnitCode: po?.poUnitCode ?? '단어',
    poPrice: po?.poPrice ?? '',
    poCoinCode: po?.poCoinCode ?? 'KRW',
    poCoinRate: po?.poCoinRate ?? '1',
    poPriceSum: po?.poPriceSum ?? '',
    poPriceKsum: po?.poPriceKsum ?? '',
    poTax: po?.poTax ?? '',
    poTaxPrice: po?.poTaxPrice ?? '',
    poTaxSum: po?.poTaxSum ?? '',
    poSday: toDateInputValue(po?.poSday),
    poSdayTime: po?.poSdayTime ?? '',
    poEday: toDateInputValue(po?.poEday),
    poEdayTime: po?.poEdayTime ?? '',
    poState: po?.poState ?? '발주',
    poInvoiceState: po?.poInvoiceState ?? '미발행',
    poMoneyState: po?.poMoneyState ?? '미정산',
    poMoneyDay: toDateInputValue(po?.poMoneyDay),
    poMoneyPrice: po?.poMoneyPrice ?? '',
    invCode: po?.invCode ?? '',
    poContent: po?.poContent ?? '',
  })
  const [dirty, setDirty] = useState(false)

  /** 저장된 합계는 손으로 조정된 값일 수 있다 — `JobFormModal` 과 같은 판단. */
  const [sumEdited, setSumEdited] = useState(isEdit)

  const compute = (volume: string, price: string, rate: string) => {
    const sum = decimalMultiply(volume, price)
    const ksum = sum === null ? null : decimalMultiply(sum, rate)
    return { sum, ksum }
  }

  const suggestion = compute(form.poVolume, form.poPrice, form.poCoinRate)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setDirty(true)
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      if (!sumEdited && ['poVolume', 'poPrice', 'poCoinRate'].includes(key)) {
        const { sum, ksum } = compute(next.poVolume, next.poPrice, next.poCoinRate)
        next.poPriceSum = sum ?? ''
        next.poPriceKsum = ksum ?? ''
      }
      return next
    })
  }

  const applySuggestion = () => {
    setDirty(true)
    setSumEdited(false)
    setForm((prev) => ({
      ...prev,
      poPriceSum: suggestion.sum ?? '',
      poPriceKsum: suggestion.ksum ?? '',
    }))
  }

  const name = form.poName.trim()
  const canSave = name.length > 0 && !!job && !pending

  const onSubmit = async () => {
    if (!job || name.length === 0) return

    const common: PurchaseOrderUpdate = {
      poName: name,
      poWorkCode: form.poWorkCode.trim() || null,
      poCatUse: form.poCatUse,
      /*
       * CAT 칸은 사용 여부를 끄면 비워서 보낸다.
       *
       * 끈 상태로 값이 남아 있으면, 나중에 "CAT 안 쓴 발주인데 분석 단어수가 있다" 가 되고
       * 그 숫자가 어디서 왔는지 알 방법이 없다.
       */
      poCatWord: form.poCatUse ? toDecimalInput(form.poCatWord) : null,
      poCatMid: form.poCatUse ? toDecimalInput(form.poCatMid) : null,
      poCatStotal: form.poCatUse ? toDecimalInput(form.poCatStotal) : null,
      translatorId: translator?.id ?? null,
      poSlang: form.poSlang.trim() || null,
      poElang: form.poElang.trim() || null,
      poVolume: toDecimalInput(form.poVolume),
      poUnitCode: form.poUnitCode.trim() || null,
      poPrice: toDecimalInput(form.poPrice),
      poCoinCode: form.poCoinCode.trim() || null,
      poCoinRate: toDecimalInput(form.poCoinRate),
      poPriceSum: toDecimalInput(form.poPriceSum),
      poPriceKsum: toDecimalInput(form.poPriceKsum),
      poTax: form.poTax.trim() || null,
      poTaxPrice: toDecimalInput(form.poTaxPrice),
      poTaxSum: toDecimalInput(form.poTaxSum),
      poSday: form.poSday || null,
      poSdayTime: form.poSdayTime || null,
      poEday: form.poEday || null,
      poEdayTime: form.poEdayTime || null,
      poState: form.poState.trim() || null,
      poInvoiceState: form.poInvoiceState.trim() || null,
      poMoneyState: form.poMoneyState.trim() || null,
      poMoneyDay: form.poMoneyDay || null,
      poMoneyPrice: toDecimalInput(form.poMoneyPrice),
      invCode: form.invCode.trim() || null,
      poContent: form.poContent.trim() || null,
    }

    if (po) {
      await updatePo.mutateAsync({ id: po.id, input: common })
      onSaved(`${name} 발주를 수정했습니다.`)
    } else {
      const input: PurchaseOrderInput = { ...common, jobId: job.id, poName: name }
      const created = await createPo.mutateAsync(input)
      onSaved(`${name} 발주를 등록했습니다. (코드: ${created.poCode})`)
    }
    onClose()
  }

  const differs =
    suggestion.sum !== null &&
    toDecimalInput(form.poPriceSum) !== null &&
    decimalSubtract(toDecimalInput(form.poPriceSum), suggestion.sum) !== '0.00'

  return (
    <Modal
      title={isEdit ? '발주 수정' : '발주 등록'}
      onClose={onClose}
      isDirty={dirty && !pending}
      width={860}
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
            {pending ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      <ErrorNotice error={createPo.error ?? updatePo.error} />

      {isEdit ? (
        <p className={ui.hint}>
          발주 코드 <strong>{po.poCode}</strong> — 코드와 소속 작업은 변경할 수 없습니다.
        </p>
      ) : null}

      <div className={ui.formGrid}>
        <div className={ui.fieldWide}>
          {isEdit || fixedJob ? (
            <div className={ui.field}>
              <span className={ui.label}>작업</span>
              <div className={ui.pickerSelected}>
                <span className={ui.pickerSelectedText}>
                  <span className={ui.pickerItemTitle}>{job?.title ?? '-'}</span>
                  {job?.subtitle ? <span className={ui.pickerItemSub}>{job.subtitle}</span> : null}
                </span>
              </div>
            </div>
          ) : (
            <JobPicker
              value={job}
              onChange={(option) => {
                setDirty(true)
                setJob(option)
              }}
              required
              disabled={pending}
            />
          )}
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="po-name">
            발주명 <span className={ui.required}>*</span>
          </label>
          <input
            id="po-name"
            className={ui.input}
            value={form.poName}
            onChange={(e) => set('poName', e.target.value)}
            required
          />
        </div>

        {/*
         * 번역가는 필수가 아니다.
         *
         * 발주서를 먼저 만들고 사람을 나중에 정하는 순서가 실제로 있다(단가 협의 중). 다만
         * 번역가가 비어 있으면 누구에게 지급해야 하는지 알 수 없으므로 안내를 붙인다.
         */}
        <div className={ui.fieldWide}>
          <TranslatorPicker
            value={translator}
            onChange={(option) => {
              setDirty(true)
              setTranslator(option)
            }}
            disabled={pending}
          />
          {!translator ? (
            <span className={ui.hint}>
              비워 둘 수 있습니다. 다만 번역가가 없으면 지급 대상이 정해지지 않습니다.
            </span>
          ) : null}
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-work">
            작업 종류
          </label>
          <select
            id="po-work"
            className={ui.select}
            value={form.poWorkCode}
            onChange={(e) => set('poWorkCode', e.target.value)}
          >
            <option value="">선택 없음</option>
            {codeOptions(WORK_CODES, form.poWorkCode).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-state">
            진행 상태
          </label>
          <select
            id="po-state"
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
          <label className={ui.label} htmlFor="po-slang">
            출발어
          </label>
          <input
            id="po-slang"
            className={ui.input}
            value={form.poSlang}
            onChange={(e) => set('poSlang', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-elang">
            도착어
          </label>
          <input
            id="po-elang"
            className={ui.input}
            value={form.poElang}
            onChange={(e) => set('poElang', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-volume">
            물량
          </label>
          <div className={ui.inputRow}>
            <input
              id="po-volume"
              className={`${ui.input} ${ui.inputNum}`}
              inputMode="decimal"
              value={form.poVolume}
              onChange={(e) => set('poVolume', e.target.value)}
            />
            <select
              className={ui.select}
              aria-label="단위"
              value={form.poUnitCode}
              onChange={(e) => set('poUnitCode', e.target.value)}
            >
              <option value="">단위</option>
              {codeOptions(UNIT_CODES, form.poUnitCode).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-price">
            단가
          </label>
          <input
            id="po-price"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.poPrice}
            onChange={(e) => set('poPrice', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-coin">
            통화
          </label>
          <select
            id="po-coin"
            className={ui.select}
            value={form.poCoinCode}
            onChange={(e) => set('poCoinCode', e.target.value)}
          >
            <option value="">선택 없음</option>
            {codeOptions(COIN_CODES, form.poCoinCode).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className={ui.hint}>번역가의 정산 통화와 같아야 합니다.</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-rate">
            적용 환율
          </label>
          <input
            id="po-rate"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.poCoinRate}
            onChange={(e) => set('poCoinRate', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-sum">
            합계 ({form.poCoinCode || '외화'})
          </label>
          <input
            id="po-sum"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.poPriceSum}
            onChange={(e) => {
              setSumEdited(true)
              set('poPriceSum', e.target.value)
            }}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-ksum">
            원화 환산 합계 = 원가
          </label>
          <input
            id="po-ksum"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.poPriceKsum}
            onChange={(e) => {
              setSumEdited(true)
              set('poPriceKsum', e.target.value)
            }}
          />
          <span className={ui.hint}>리포트의 원가는 이 값의 합입니다.</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-sday">
            시작일
          </label>
          <div className={ui.inputRow}>
            <input
              id="po-sday"
              className={ui.input}
              type="date"
              value={form.poSday}
              onChange={(e) => set('poSday', e.target.value)}
            />
            <input
              className={ui.input}
              type="time"
              aria-label="시작 시각"
              value={form.poSdayTime}
              onChange={(e) => set('poSdayTime', e.target.value)}
            />
          </div>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-eday">
            납기
          </label>
          <div className={ui.inputRow}>
            <input
              id="po-eday"
              className={ui.input}
              type="date"
              value={form.poEday}
              onChange={(e) => set('poEday', e.target.value)}
            />
            <input
              className={ui.input}
              type="time"
              aria-label="납기 시각"
              value={form.poEdayTime}
              onChange={(e) => set('poEdayTime', e.target.value)}
            />
          </div>
          <span className={ui.hint}>작업 납기보다 앞서야 검수 시간이 남습니다.</span>
        </div>

        {/*
         * 세금 세 칸은 레거시 컬럼을 그대로 둔 것이다.
         *
         * `po_tax` 가 세율인지 구분값인지 운영 데이터로 확인되지 않았고(번역가의 `tran_ictax` 와
         * 같은 상황), 그래서 백엔드도 `text` 로 두었다. 지금 세율로 단정해서 금액을 자동
         * 계산하면, 구분값이었던 경우 전 건의 세금액이 틀린다 — 자동 계산하지 않는 쪽이 맞다.
         */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-tax">
            세금 구분 · 세율
          </label>
          <input
            id="po-tax"
            className={ui.input}
            value={form.poTax}
            onChange={(e) => set('poTax', e.target.value)}
          />
          <span className={ui.hint}>레거시 값을 그대로 보관합니다. 자동 계산하지 않습니다.</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-tax-price">
            세액
          </label>
          <input
            id="po-tax-price"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.poTaxPrice}
            onChange={(e) => set('poTaxPrice', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-tax-sum">
            세금 포함 합계
          </label>
          <input
            id="po-tax-sum"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.poTaxSum}
            onChange={(e) => set('poTaxSum', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-invoice-state">
            계산서
          </label>
          <select
            id="po-invoice-state"
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

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-money-state">
            지급
          </label>
          <select
            id="po-money-state"
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
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-money-day">
            지급일
          </label>
          <input
            id="po-money-day"
            className={ui.input}
            type="date"
            value={form.poMoneyDay}
            onChange={(e) => set('poMoneyDay', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-money-price">
            지급액
          </label>
          <input
            id="po-money-price"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.poMoneyPrice}
            onChange={(e) => set('poMoneyPrice', e.target.value)}
          />
          <span className={ui.hint}>실제 지급한 금액입니다. 원가와 다를 수 있습니다.</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-inv-code">
            계산서 번호
          </label>
          <input
            id="po-inv-code"
            className={`${ui.input} ${ui.inputMono}`}
            value={form.invCode}
            onChange={(e) => set('invCode', e.target.value)}
          />
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.check}>
            <input
              type="checkbox"
              checked={form.poCatUse}
              onChange={(e) => set('poCatUse', e.target.checked)}
            />
            <span className={ui.checkText}>
              <span className={ui.checkLabel}>CAT 분석 사용</span>
              <span className={ui.checkDesc}>
                켜면 아래에 CAT 분석값 칸이 나타납니다. 끄면 입력한 분석값은 저장되지 않습니다.
              </span>
            </span>
          </label>
        </div>

        {form.poCatUse ? (
          <>
            <div className={ui.field}>
              <label className={ui.label} htmlFor="po-cat-word">
                신규 단어수
              </label>
              <input
                id="po-cat-word"
                className={`${ui.input} ${ui.inputNum}`}
                inputMode="decimal"
                value={form.poCatWord}
                onChange={(e) => set('poCatWord', e.target.value)}
              />
            </div>

            <div className={ui.field}>
              <label className={ui.label} htmlFor="po-cat-mid">
                부분 일치
              </label>
              <input
                id="po-cat-mid"
                className={`${ui.input} ${ui.inputNum}`}
                inputMode="decimal"
                value={form.poCatMid}
                onChange={(e) => set('poCatMid', e.target.value)}
              />
            </div>

            <div className={ui.field}>
              <label className={ui.label} htmlFor="po-cat-stotal">
                분석 합계
              </label>
              <input
                id="po-cat-stotal"
                className={`${ui.input} ${ui.inputNum}`}
                inputMode="decimal"
                value={form.poCatStotal}
                onChange={(e) => set('poCatStotal', e.target.value)}
              />
            </div>
          </>
        ) : null}

        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="po-content">
            발주 내용 · 지시사항
          </label>
          <textarea
            id="po-content"
            className={ui.textarea}
            rows={3}
            value={form.poContent}
            onChange={(e) => set('poContent', e.target.value)}
          />
        </div>
      </div>

      {differs ? (
        <InfoNotice>
          입력한 합계가 <strong>물량 × 단가</strong> 계산값({formatMoney(suggestion.sum)}{' '}
          {form.poCoinCode})과 다릅니다. 의도한 조정이면 그대로 저장하세요.{' '}
          <button type="button" className={ui.btnLink} onClick={applySuggestion}>
            계산값으로 되돌리기
          </button>
        </InfoNotice>
      ) : null}

      <p className={ui.hint}>
        PM 은 이 화면에서 지정하지 않습니다. 직원 목록 API 가 준비되면 추가됩니다 — 기존에 지정된
        PM 은 저장해도 바뀌지 않습니다.
      </p>
    </Modal>
  )
}
