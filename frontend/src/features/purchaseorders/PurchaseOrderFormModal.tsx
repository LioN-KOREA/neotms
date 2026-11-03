import { useState } from 'react'
import {
  useCreatePurchaseOrder,
  useUpdatePurchaseOrder,
} from '@/apis/queries/neotms.mutation'
import { useJob } from '@/apis/queries/neotms.query'
import {
  CODE_DOMAIN,
  codeOptions,
  COIN_CODES,
  INVOICE_STATES,
  isLinguistic,
  JOB_TYPE_LINGUISTIC,
  MONEY_STATES,
  PO_STATES,
} from '@/apis/neotms.codes'
import type {
  PurchaseOrderInput,
  PurchaseOrderRow,
  PurchaseOrderUpdate,
} from '@/apis/neotms.types'
import { CodeSelect } from '@/shared/ui/CodeSelect'
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
 * ## 업무 구분이 언어쌍인지 업무 분류인지를 가른다
 *
 * 발주의 업무 구분은 **작업의 것과 별개다**. 등록할 때 작업에서 가져와 보여 주지만 거기서
 * 고정되지 않는다 — MICE 행사에 통역 발주를 내는 것이 정상이기 때문이다. 언어 및 통번역이면
 * 출발어·도착어를, 그 밖이면 업무 분류를 받는다. 한쪽을 받는 동안 다른 쪽은 `set()` 안에서
 * 비워진다.
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
    /**
     * 업무 구분. 등록할 때는 **비워 둔 채 시작한다** — 아래 `inheritedType` 주석 참고.
     */
    poType: po?.poType ?? '',
    poSlang: po?.poSlang ?? '',
    poElang: po?.poElang ?? '',
    poCategory: po?.poCategory ?? '',
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

  /**
   * 등록할 때 업무 구분의 출발점이 되는 **작업의** 업무 구분.
   *
   * 발주의 업무 구분은 작업의 것과 별개다 — MICE 행사에 통역 발주를 내는 것이 정상이다. 그래서
   * 고정이 아니라 **출발점**이고, 담당자가 바꾸면 그대로 바뀐다. 서버도 같은 규칙으로 동작하므로
   * (등록 시 `input.poType ?? job.jobType`), 이 조회가 실패하거나 아직 끝나지 않았더라도 결론은
   * 달라지지 않는다. 그래서 담당자가 손대지 않은 업무 구분은 **보내지 않는다** — 서버가 작업에서
   * 가져오게 두는 것이, 여기서 추측한 값을 보내는 것보다 언제나 정확하다.
   *
   * 조회가 필요한 이유는 입력란 쪽이다: 이 발주가 언어쌍을 받을지 업무 분류를 받을지 지금
   * 결정해야 하는데, `JobPicker` 가 주는 것은 id·이름뿐이다.
   *
   * 수정에서는 조회하지 않는다. 발주 자신의 업무 구분이 이미 있고, 그것이 작업의 것보다 우선한다.
   */
  const jobQuery = useJob(!isEdit && job ? job.id : null)
  const inheritedType = jobQuery.data?.jobType?.trim() || JOB_TYPE_LINGUISTIC

  /** 지금 이 발주의 업무 구분. 입력란과 저장 본문이 모두 이 값에서 갈린다. */
  const poType = form.poType.trim() || inheritedType
  const linguistic = isLinguistic(poType)

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
      // 업무 구분을 바꾸면 쓰지 않게 된 쪽을 여기서 비운다 — JobFormModal 의 같은 자리 주석 참고.
      if (key === 'poType') {
        if (isLinguistic(next.poType || inheritedType)) next.poCategory = ''
        else {
          next.poSlang = ''
          next.poElang = ''
        }
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
  /*
   * 작업 조회가 끝나기 전에는 저장할 수 없다.
   *
   * 조회 전의 `inheritedType` 은 `LINGUISTICS` 다. 그 상태로 저장하면 MICE 작업의 발주에
   * 언어쌍을 담아 보내게 되고, 서버는 업무 구분이 `LINGUISTICS` 가 아니라서 그 언어쌍을
   * **조용히 버린다**(언어 상세 테이블에 쓸 일이 없으므로 문장 자체가 만들어지지 않는다).
   * 화면은 저장 성공을 알리고 값은 사라지는 조합이라, 막는 쪽이 맞다.
   */
  const canSave = name.length > 0 && !!job && !pending && !jobQuery.isLoading

  const onSubmit = async () => {
    if (!job || name.length === 0) return

    /*
     * 업무 구분에 맞는 쪽만 보낸다. 반대쪽을 같이 보내면 서버가 거절하거나(23514·23503) 버린다.
     */
    const detail: Partial<PurchaseOrderUpdate> = linguistic
      ? { poSlang: form.poSlang.trim() || null, poElang: form.poElang.trim() || null }
      : { poCategory: form.poCategory.trim() || null }

    /*
     * 담당자가 손대지 않은 업무 구분은 **보내지 않는다** — `inheritedType` 주석 참고.
     *
     * 빈 문자열이나 `null` 을 보내지 않는 것도 중요하다. `po_type` 은 NOT NULL 이고 수정
     * 경로는 `null` 을 "지워라" 로 해석하므로, 보냈다면 23502 로 실패한다.
     */
    const typed: Partial<PurchaseOrderUpdate> = form.poType.trim()
      ? { poType: form.poType.trim() }
      : {}

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
      ...typed,
      ...detail,
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
          <CodeSelect
            id="po-work"
            domain={CODE_DOMAIN.WORK}
            value={form.poWorkCode}
            onChange={(v) => set('poWorkCode', v)}
          />
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

        {/*
         * 업무 구분이 아래 칸들을 결정하므로 먼저 온다.
         *
         * 작업에서 가져온 값이 기본으로 보이지만(`value={poType}`), 고정이 아니다 — MICE 행사에
         * 통역 발주를 내는 것이 정상이고, 그때 담당자는 여기서 '언어 및 통번역' 으로 바꾼다.
         */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-type">
            업무 구분
          </label>
          <CodeSelect
            id="po-type"
            domain={CODE_DOMAIN.JOBTYPE}
            value={poType}
            onChange={(v) => set('poType', v)}
          />
          {!isEdit && form.poType.trim() === '' ? (
            <span className={ui.hint}>작업의 업무 구분을 따릅니다. 바꿀 수 있습니다.</span>
          ) : null}
        </div>

        {/*
         * 언어쌍과 업무 분류는 둘 중 하나만 받는다 — JobFormModal 의 같은 자리 주석 참고.
         *
         * 언어쌍 두 칸은 자유 입력이었다. `po_slang`·`po_elang` 도 `sys_code (code)` 참조이므로
         * 작업 쪽과 같은 이유로 드롭다운이어야 한다.
         *
         * 발주의 언어쌍은 보통 작업의 언어쌍과 같지만 자동으로 채우지 않는다 — 한 작업을 두
         * 언어로 쪼개어 발주하는 경우가 있고, 그때 자동 입력된 값은 **맞아 보이기 때문에**
         * 아무도 고치지 않는다. (업무 구분은 반대다. 그쪽은 둘 중 어느 칸을 보여 줄지를
         * 결정하므로 비워 둘 수가 없다.)
         *
         * 어느 쪽도 필수가 아니다. 언어쌍이 비어 있는 발주가 이미 수천 건 있다.
         */}
        {linguistic ? (
          <>
            <div className={ui.field}>
              <label className={ui.label} htmlFor="po-slang">
                출발어
              </label>
              <CodeSelect
                id="po-slang"
                domain={CODE_DOMAIN.LANG}
                value={form.poSlang}
                onChange={(v) => set('poSlang', v)}
              />
            </div>

            <div className={ui.field}>
              <label className={ui.label} htmlFor="po-elang">
                도착어
              </label>
              <CodeSelect
                id="po-elang"
                domain={CODE_DOMAIN.LANG}
                value={form.poElang}
                onChange={(v) => set('poElang', v)}
              />
            </div>
          </>
        ) : (
          <div className={ui.field}>
            <label className={ui.label} htmlFor="po-category">
              업무 분류
            </label>
            <CodeSelect
              id="po-category"
              domain={CODE_DOMAIN.JOBCAT}
              value={form.poCategory}
              onChange={(v) => set('poCategory', v)}
            />
          </div>
        )}

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
            <CodeSelect
              ariaLabel="단위"
              domain={CODE_DOMAIN.UNIT}
              value={form.poUnitCode}
              onChange={(v) => set('poUnitCode', v)}
              placeholder="단위"
              silent
            />
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
