import { useEffect, useState } from 'react'
import { fetchTranslators } from '@/apis/neotms.api'
import { fetchLastPoPrice } from '@/apis/pmsheet.api'
import type { PoDraft } from './poDraft'
import {
  useCreatePurchaseOrder,
  useUpdatePurchaseOrder,
} from '@/apis/queries/neotms.mutation'
import { useFxRate, useJob, useProfile } from '@/apis/queries/neotms.query'
import { NEOTMS_USER_ATTRIBUTE_HR_MANAGEMENT, NEOTMS_USER_ATTRIBUTE_SUPERUSER } from '@/apis/neotms.authorities'
import { hasAttribute } from '@/shared/permissions'
import {
  CODE_DOMAIN,
  codeOptions,
  COIN_CODES,
  isLinguistic,
  JOB_TYPE_LINGUISTIC,
  MONEY_STATE_UNPAID,
  MONEY_STATES,
  PO_STATE_UNAPPROVED,
  unsetPlaceholder,
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
import { alignPeriod, formatDate, nowTimeKst, toDateInputValue, todayKst } from '@/shared/utils/format'
import { DateField } from '@/shared/ui/DateField'
import {
  decimalCompare,
  decimalMultiply,
  decimalSubtract,
  formatMoney,
  toDecimalInput,
} from '@/shared/utils/money'
import ui from '@/shared/ui/ui.module.css'
import { LanguagePickers } from '@/features/jobs/TargetLanguages'
import { CatTable } from './CatTable'
import { catDetail, catWeightsFor, CAT_BANDS, DEFAULT_CAT_WEIGHTS } from './catMath'
import { PoJobPicker, PoTranslatorPicker } from './PoPickers'

/**
 * 금액을 바꾸는 칸. 바뀌면 저장된 원화 금액은 더 이상 그 금액에 대한 사실이 아니다 —
 * `JobFormModal` 의 같은 상수 주석 참고.
 */
const MONEY_KEYS = ['poVolume', 'poPrice', 'poPriceSum', 'poCoinCode']

interface Props {
  /** null 이면 신규. */
  purchaseOrder: PurchaseOrderRow | null
  /** 소속 작업이 이미 정해진 경우(프로젝트 상세의 '발주 추가'). */
  fixedJob?: PickerOption | null
  /**
   * 작업 검색을 이 프로젝트로 한정한다(프로젝트 상세의 PO 카드 'PO 추가').
   *
   * `fixedJob` 과 둘 중 하나다 — 작업이 **정해져 있으면** `fixedJob`, 이 프로젝트 안에서
   * **고르게 하려면** 이것. 왜 한정해야 하는지는 `JobPicker` 주석에 있다.
   */
  jobScopeProjectId?: string | null
  /** '나의 업무' 시트의 [발행]·[변경] 이 미리 채운 값 (팀장님 2026-11-26). */
  draft?: PoDraft | null
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
 * `po_price_sum` 도 작업과 똑같이 받은 값을 그대로 저장한다. 이유와 계산 방식은 `JobFormModal`
 * 의 주석과 같다 — 계산은 `BigInt` 10진 연산으로 하고, 한 번 직접 고친 합계는 그 뒤로 자동
 * 갱신하지 않는다.
 *
 * ## 환율은 입력란이 아니다 — 환전은 동작이다
 *
 * `po_price_ksum` 은 예외다. **읽기 전용 파생값**이고, `poCoinRate` 는 사람이 적는 환율이 아니라
 * 값이 붙은 정산 플래그다. 세 경우(원화 / 정산된 외화 / 미정산 외화)와 그 각각의 원화 금액,
 * 그리고 **원화로 환산** 버튼이 왜 입력란을 대신하는지는 `JobFormModal` 의 같은 자리 주석과
 * db/014_fx_rates.sql, NeotmsMoney.ts 에 적혀 있다. 여기서는 그 규칙을 그대로 따른다 — 매출과
 * 원가가 서로 다른 규칙으로 원화가 되면 마진은 어느 쪽도 설명하지 못하는 숫자가 된다.
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
  jobScopeProjectId = null,
  draft = null,
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
    draft?.translatorId
      ? { id: draft.translatorId, title: draft.translatorName ?? draft.translatorId }
      : po?.translatorId
        ? { id: po.translatorId, title: po.poTranName ?? po.translatorId }
        : null,
  )

  const [form, setForm] = useState({
    poWorkCode: po?.poWorkCode ?? draft?.poWorkCode ?? '번역',
    poCatUse: po?.poCatUse ?? false,
    poCatWord: po?.poCatWord ?? '',
    poCatMid: po?.poCatMid ?? '',
    poCatStotal: po?.poCatStotal ?? '',
    /**
     * 업무 구분. 등록할 때는 **비워 둔 채 시작한다** — 아래 `inheritedType` 주석 참고.
     */
    poType: po?.poType ?? draft?.poType ?? '',
    poSlang: po?.poSlang ?? draft?.poSlang ?? '',
    poElang: po?.poElang ?? draft?.poElang ?? '',
    poCategory: po?.poCategory ?? '',
    poVolume: po?.poVolume ?? draft?.poVolume ?? '',
    poUnitCode: po?.poUnitCode ?? '단어',
    poPrice: po?.poPrice ?? '',
    poCoinCode: po?.poCoinCode ?? 'KRW',
    /**
     * 비어 있는 것이 **미정산**이라는 뜻이다. `?? '1'` 이 아닌 이유는 `JobFormModal` 의 같은
     * 자리 주석에 있다 — 1 로 채우면 환전하지 않은 외화 발주가 "1 대 1 로 정산된 건" 이 된다.
     */
    poCoinRate: po?.poCoinRate ?? '',
    poPriceSum: po?.poPriceSum ?? '',
    poPriceKsum: po?.poPriceKsum ?? '',
    poTax: po?.poTax ?? '',
    poTaxPrice: po?.poTaxPrice ?? '',
    poTaxSum: po?.poTaxSum ?? '',
    /*
     * 신규 발주의 시작일은 **지금**이다. `??` 를 쓰지 않는 이유는 `ProjectFormModal` 의 같은
     * 자리에 적어 두었다 — 시작 시각이 비어 있는 기존 발주를 열었다 그대로 저장하면 없던
     * 시각이 생긴다.
     */
    poSday: po ? toDateInputValue(po.poSday) : todayKst(),
    poSdayTime: po ? (po.poSdayTime ?? '') : nowTimeKst(),
    poEday: toDateInputValue(po?.poEday ?? draft?.poEday),
    poEdayTime: po?.poEdayTime ?? draft?.poEdayTime ?? '',
    poState: po?.poState ?? PO_STATE_UNAPPROVED,
    poMoneyState: po?.poMoneyState ?? MONEY_STATE_UNPAID,
    poMoneyDay: toDateInputValue(po?.poMoneyDay),
    poMoneyPrice: po?.poMoneyPrice ?? '',
    poContent: po?.poContent ?? '',
    /** CAT 분량 표의 단어 일곱 칸 (db/013). */
    catWords: CAT_BANDS.map((_, i) => {
      const n = po?.poCatDetail?.words[i]
      return n === null || n === undefined ? '' : String(n)
    }),
  })
  // 시트에서 미리 채워 열었으면 닫을 때 확인을 받는다.
  const [dirty, setDirty] = useState(!!draft)

  /*
   * 시트의 [발행]·[변경] (팀장님 2026-11-26): 번역가를 이름만 알면 그 이름으로 찾아 **하나만** 맞을 때 고른다.
   * 등록이면 이어서 이 번역가가 같은 언어쌍·같은 작업 종류로 받은 최근 단가를 채운다(있을 때만).
   */
  const draftName = draft && !draft.translatorId ? (draft.translatorName ?? '').trim() : ''
  useEffect(() => {
    if (!draftName) return
    let alive = true
    fetchTranslators({ limit: 20, q: draftName })
      .then((page) => {
        const exact = page.items.filter((r) => (r.tranName ?? '').trim() === draftName)
        if (alive && exact.length === 1) setTranslator({ id: exact[0]!.id, title: exact[0]!.tranName ?? draftName })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [draftName])
  const priceFor = draft && !po && translator ? translator.id : null
  useEffect(() => {
    if (!priceFor) return
    let alive = true
    fetchLastPoPrice({ translatorId: priceFor, slang: draft?.poSlang, elang: draft?.poElang, workCode: draft?.poWorkCode })
      .then((hit) => {
        if (!alive || !hit) return
        setForm((prev) => {
          if (prev.poPrice) return prev
          const next = { ...prev, poPrice: hit.price }
          if (hit.unit) next.poUnitCode = hit.unit
          if (hit.coin && hit.coin !== prev.poCoinCode) {
            next.poCoinCode = hit.coin
            next.poCoinRate = hit.coin.toUpperCase() === 'KRW' ? '1' : ''
          }
          next.poPriceSum = decimalMultiply(next.poVolume, next.poPrice) ?? ''
          return next
        })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [priceFor, draft?.poSlang, draft?.poElang, draft?.poWorkCode])

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

  /*
   * 작업 등록 폼과 같은 처방을 같은 칸들에 한다 — '선택 없음' 을 없애고, 신규 등록의 기본값을 빈
   * 값에서 첫 항목으로 옮긴다. 판단은 전부 `unsetPlaceholder` 주석에 있고, 여기서 되풀이할 것은
   * 발주에만 있는 세 가지뿐이다.
   *
   * **통화.** 기본값은 이미 `KRW` 다. 비워 두어도 **고장나지는 않는다** — 서버는
   * `COALESCE(coin_code, 'KRW')` 로 읽고, 통화가 없는 금액은 이미 원화라고 결론 내린다
   * (NeotmsMoney.ts 의 `krwAmount` 가 그 선택을 명시해 두고 있다). 문제는 그 다음이다: 빈 값은
   * `KRW` 와 효과가 완전히 같은데 화면에는 "통화 미지정" 으로 보인다. 같은 사실을 두 가지로 적는
   * 선택지이고, 둘이 다르다고 믿게 만드는 쪽이 비싸다. 번역가의 정산 통화와 같아야 한다는 안내가
   * 아래에 붙어 있는 칸이기도 해서, 여기서 비어 있음은 특히 읽기 어렵다.
   *
   * **지급(`po_money_state`).** 프로젝트의 '입금' 과 같은 축이고 같은 이유로 비울 필요가 없다 —
   * 모든 발주는 미정산에서 시작한다.
   *
   * **업무 구분은 이 목록에 없다.** 아래에서 `placeholder={null}` 을 바로 준다 — 이 폼의 업무
   * 구분은 비어 있을 수가 없기 때문이다. `form.poType` 이 비면 작업에서 상속한 값이
   * 대신 들어가므로(`poType`), '지정 없음' 으로 남을 상태가 존재하지 않는다.
   */
  const unsetWork = unsetPlaceholder(isEdit, form.poWorkCode)
  const unsetCoin = unsetPlaceholder(isEdit, form.poCoinCode)
  const unsetMoney = unsetPlaceholder(isEdit, form.poMoneyState)

  /** 저장된 합계는 손으로 조정된 값일 수 있다 — `JobFormModal` 과 같은 판단. */
  const [sumEdited, setSumEdited] = useState(isEdit)

  /**
   * 금액에 영향을 주는 칸을 건드렸는지. 정산된 발주의 저장된 원화 금액을 지키는 자물쇠다 —
   * 이유는 `JobFormModal` 의 같은 자리 주석에 전부 적혀 있다.
   */
  const [moneyTouched, setMoneyTouched] = useState(false)

  /**
   * 합계를 만든다. 출발점이 업무 구분에 따라 다르다 — `JobFormModal` 과 같은 규칙이다.
   *
   * 언어 발주: `물량 × 단가` 가 합계다. 발주에는 할인 칸이 없다(컬럼 자체가 없다).
   * 비언어 발주: 합계는 담당자가 직접 넣는 값이고, 계산해 줄 것이 없다(db/012_job_pricing.sql).
   *
   * 구분을 `form` 에서 읽지 않고 인자로 받는다. 발주의 구분은 `form.poType` 이 비어 있을 때
   * 작업에서 상속되고(`inheritedType`), 그 값은 비동기 조회에서 온다 — `form` 안에 없다.
   *
   * **원화 환산은 여기 없다.** 아래 `ksum` 이 렌더마다 계산한다 — 시세는 `set()` 이 불리지
   * 않아도 도착하므로, 폼 상태에 담아 두면 늦거나 어긋난다.
   */
  const computeSum = (f: typeof form, isLing: boolean) =>
    isLing ? decimalMultiply(f.poVolume, f.poPrice) : toDecimalInput(f.poPriceSum)

  const suggestedSum = computeSum(form, linguistic)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setDirty(true)
    if (MONEY_KEYS.includes(key as string)) setMoneyTouched(true)
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      /*
       * 무엇이 계산을 촉발하는지가 업무 구분에서 갈린다 — JobFormModal 의 같은 자리 주석에 이유가
       * 전부 적혀 있다. 요약하면: 비언어에서 합계는 입력란이라 따라올 것이 없고, 업무 구분 자체는
       * 촉발 목록에 넣지 않는다(넣으면 구분을 되돌릴 때 금액이 지워진다). 환율도 더 이상 목록에
       * 없다 — 입력란이 아니고, 원화 금액은 상태가 아니라 파생값이다.
       */
      const nextLinguistic = isLinguistic(next.poType || inheritedType)
      if (!sumEdited && nextLinguistic && ['poVolume', 'poPrice'].includes(key)) {
        next.poPriceSum = computeSum(next, true) ?? ''
      }
      /*
       * 통화를 바꾸면 환율을 같이 정리한다 — KRW 면 1, 외화면 비워서 **미정산**으로 돌린다.
       * 합계는 건드리지 않는다. 이유는 `JobFormModal` 의 같은 자리 주석 참고.
       */
      if (key === 'poCoinCode') {
        next.poCoinRate = (next.poCoinCode.trim().toUpperCase() || 'KRW') === 'KRW' ? '1' : ''
      }
      /*
       * 업무 구분을 바꾸면 쓰지 않게 된 쪽을 여기서 비운다 — JobFormModal 의 같은 자리 주석 참고.
       *
       * 물량·단위·단가도 언어 쪽이므로 함께 비운다. 합계와 원화 합계는 `purchase_order` 에 그대로
       * 있으므로 비우지 않는다 — 구분을 바꾼다고 발주 금액이 달라지지는 않는다.
       */
      if (key === 'poType') {
        if (nextLinguistic) next.poCategory = ''
        else {
          next.poSlang = ''
          next.poElang = ''
          next.poVolume = ''
          next.poPrice = ''
        }
      }
      return next
    })
  }

  /**
   * 시작일·납기를 한 번에 넣는다 — 거꾸로 된 기간은 `alignPeriod` 가 맞춘다.
   *
   * 프로젝트 서식의 같은 이름 함수와 같은 이유(그쪽 주석). 이 맞춤은 **발주 안의 두 날짜**만
   * 본다. 발주 납기가 작업 납기보다 뒤인지는 건드리지 않는다 — 칸 아래 문장이 그걸 권하지만
   * 권고이고, 검수 시간을 포기하고 납기를 맞추는 일이 실제로 있다.
   */
  const setPeriod = (start: string, end: string, changed: 'start' | 'end') => {
    const next = alignPeriod(start, end, changed)
    setDirty(true)
    setForm((prev) => ({ ...prev, poSday: next.start, poEday: next.end }))
  }

  /* CAT 분량 표 — 가중치는 번역가로 정해지고(고칠 수 없다), 합계가 물량이 된다. */
  const weights = catWeightsFor(translator?.title)
  const catInfo = catDetail(form.catWords, weights)
  const withCat = (prev: typeof form, words: string[], w: readonly number[]): typeof form => {
    const info = catDetail(words, w)
    const next = { ...prev, catWords: words }
    if (info) {
      next.poVolume = String(info.total)
      next.poUnitCode = '단어'
      if (!sumEdited) next.poPriceSum = computeSum(next, true) ?? ''
    }
    return next
  }
  const setCatWords = (words: string[]) => {
    setDirty(true)
    setMoneyTouched(true)
    setForm((prev) => withCat(prev, words, weights))
  }

  /** 세금·지급 칸은 경영지원부와 시스템관리자에게만 (팀장님 2026-11-25). */
  const { data: profile } = useProfile()
  const mayFinance =
    hasAttribute(profile, NEOTMS_USER_ATTRIBUTE_HR_MANAGEMENT) || hasAttribute(profile, NEOTMS_USER_ATTRIBUTE_SUPERUSER)

  const applySuggestion = () => {
    setDirty(true)
    setSumEdited(false)
    setMoneyTouched(true)
    setForm((prev) => ({ ...prev, poPriceSum: suggestedSum ?? '' }))
  }

  /* ------------------------------------------------------------------------ */
  /* 원화 환산 — 규칙은 JobFormModal 과 같다                                    */
  /* ------------------------------------------------------------------------ */

  /** 통화 코드. 빈 값은 원화로 읽는다 — 서버의 `COALESCE(po_coin_code, 'KRW')` 와 같은 규칙. */
  const coin = form.poCoinCode.trim().toUpperCase() || 'KRW'
  const isKrw = coin === 'KRW'
  /** 환전된 환율. 있으면 그 자체가 "정산 끝" 이라는 뜻이다. */
  const storedRate = toDecimalInput(form.poCoinRate)
  /** 원화 금액이 사실로 고정되었는지. */
  const settled = isKrw || storedRate !== null

  const fx = useFxRate(form.poCoinCode)

  /** 합계를 원화로 만드는 환율. `null` 은 "아직 알 수 없다" 이지 0 이 아니다. */
  const effectiveRate = isKrw ? '1' : settled ? storedRate : fx.rate

  /**
   * 원화 환산 합계. **이 화면이 저장하는 원가이고, 사람이 타이핑하지 않는다.**
   *
   * 시세를 모를 때 저장된 값으로 물러나는 것은 서버의 `COALESCE(sum * rate, ksum)` 과 같은
   * 선택이다(NeotmsMoney.ts). 나머지 판단은 `JobFormModal` 의 같은 자리 주석 참고.
   */
  const product =
    effectiveRate !== null && (!settled || !isEdit || moneyTouched)
      ? decimalMultiply(form.poPriceSum, effectiveRate)
      : null

  /**
   * 미정산 외화에서 합계가 0 이면 환산 결과를 주장하지 않고 저장된 원화 금액으로 물러난다 —
   * 서버의 `NULLIF(sum, 0)` 과 같은 선택이고(NeotmsMoney.ts), 이유는 `JobFormModal` 의 같은
   * 자리 주석에 적혀 있다. 매출과 원가가 서로 다른 규칙으로 원화가 되면 마진이 깨지므로
   * 여기서도 **똑같이** 막는다.
   */
  const ksum =
    !settled && decimalCompare(toDecimalInput(form.poPriceSum), '0') === 0
      ? toDecimalInput(form.poPriceKsum)
      : (product ?? toDecimalInput(form.poPriceKsum))

  /** 시세가 있어도 환산할 금액이 없으면 누를 수 없다 — 반응 없는 버튼은 고장으로 읽힌다. */
  const convertible = fx.canConvert && toDecimalInput(form.poPriceSum) !== null

  /** 환전하고 고정한다. 한 번의 `setForm` 으로 네 값을 같이 바꾼다 — `JobFormModal` 주석 참고. */
  const convertToKrw = () => {
    if (!convertible || fx.rate === null) return
    const converted = decimalMultiply(form.poPriceSum, fx.rate)
    if (converted === null) return
    setDirty(true)
    setSumEdited(true)
    setMoneyTouched(true)
    setForm((prev) => ({
      ...prev,
      poCoinCode: 'KRW',
      poCoinRate: '1',
      poPriceSum: converted,
      poPriceKsum: converted,
    }))
  }

  /*
   * 작업 조회가 끝나기 전에는 저장할 수 없다.
   *
   * 조회 전의 `inheritedType` 은 `LINGUISTICS` 다. 그 상태로 저장하면 MICE 작업의 발주에
   * 언어쌍을 담아 보내게 되고, 서버는 업무 구분이 `LINGUISTICS` 가 아니라서 그 언어쌍을
   * **조용히 버린다**(언어 상세 테이블에 쓸 일이 없으므로 문장 자체가 만들어지지 않는다).
   * 화면은 저장 성공을 알리고 값은 사라지는 조합이라, 막는 쪽이 맞다.
   */
  /*
   * PO명 은 더 이상 입력받지 않으므로 저장 조건에서도 빠졌다.
   *
   * 이전에는 `name.length > 0` 이 첫 조건이었다 — 필수 입력이었기 때문이다. 입력란을 없애면서
   * 그 조건을 남겨 두면 어떤 발주도 저장할 수 없다(`form.poName` 이 늘 빈 문자열이므로).
   * 서버의 `poName` 은 그대로 남아 있고 null 로 보낸다 — 나중에 쓸 자리를 비워 두는 것이다.
   */
  const canSave = !!job && !pending && !jobQuery.isLoading

  const onSubmit = async () => {
    // PO명 의 길이 검사가 여기에도 있었다. `canSave` 와 같은 이유로 빠진다.
    if (!job) return

    /*
     * 업무 구분에 맞는 쪽만 보낸다. 반대쪽을 같이 보내면 서버가 거절하거나(23514·23503) 버린다.
     *
     * 물량·단위·단가가 언어 쪽에 함께 있는 것이 db/012_job_pricing.sql 의 결과다. 비언어 발주가
     * 보내는 금액은 아래 `poPriceSum`·`poPriceKsum` 둘뿐이고, 그 둘은 구분과 무관하게
     * `purchase_order` 에 있다.
     */
    const detail: Partial<PurchaseOrderUpdate> = linguistic
      ? {
          poSlang: form.poSlang.trim() || null,
          poElang: form.poElang.trim() || null,
          poVolume: toDecimalInput(form.poVolume),
          poUnitCode: form.poUnitCode.trim() || null,
          poPrice: toDecimalInput(form.poPrice),
        }
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
      /*
       * 화면에서 뺐지만 **보내기는 한다**, null 로. 서버의 칸은 그대로 남아 있고(나중에 쓸
       * 가능성이 있다고 들었다), 빈 문자열이 아니라 null 인 것이 중요하다 — `settable` 은
       * null 을 "지워라" 로 읽고, `''` 는 모든 `IS NULL` 검사를 빠져나가는 값을 저장한다.
       */
      poName: null,
      poWorkCode: form.poWorkCode.trim() || null,
      /*
       * CAT 칸은 CAT 분량 표에서 채운다 (팀장님 2026-11-25). 표가 비었으면 비운다 — 다만 표가 생기기
       * 전에 저장된 PO(표 값 없이 옛 칸만 있는 것)는 옛 값을 그대로 둔다.
       */
      ...(catInfo
        ? {
            poCatUse: true,
            poCatWord: String(catInfo.newWords),
            poCatMid: String(catInfo.midWords),
            poCatStotal: String(catInfo.total),
            poCatDetail: catInfo.detail,
          }
        : po && !po.poCatDetail
          ? {}
          : { poCatUse: false, poCatWord: null, poCatMid: null, poCatStotal: null, poCatDetail: null }),
      translatorId: translator?.id ?? null,
      ...typed,
      ...detail,
      poCoinCode: form.poCoinCode.trim() || null,
      /*
       * 환율은 **정산 여부**로 결정된다. 미정산 외화는 `null` 을 보낸다 — 그 `null` 이 "읽을
       * 때마다 현 시세로 계산하라" 는 지시이고, 대신 오늘 시세를 숫자로 박으면 환전하지도 않은
       * 미지급금이 오늘 시세로 영구히 굳는다. 자세한 이유는 `JobFormModal` 의 같은 자리 주석 참고.
       */
      poCoinRate: settled ? effectiveRate : null,
      poPriceSum: toDecimalInput(form.poPriceSum),
      /** 폼 상태가 아니라 위에서 계산된 파생값. 미정산 행에서는 시세를 모를 때의 대비책이다. */
      poPriceKsum: ksum,
      poTax: form.poTax.trim() || null,
      poTaxPrice: toDecimalInput(form.poTaxPrice),
      poTaxSum: toDecimalInput(form.poTaxSum),
      poSday: form.poSday || null,
      poSdayTime: form.poSdayTime || null,
      poEday: form.poEday || null,
      poEdayTime: form.poEdayTime || null,
      poState: form.poState.trim() || null,
      /*
       * `poInvoiceState` 와 `invCode` 가 여기 없는 것은 **의도다.** 두 칸을 화면에서 뺐고, 보내지
       * 않으므로 수정 경로에서 기존 값이 지워지지 않는다(부분 수정이다 — 본문에 없는 필드는 서버가
       * 건드리지 않는다). 컬럼과 쓰기 스키마는 그대로 남아 있고, 필요해지면 칸만 되돌리면 된다.
       *
       * 발주 쪽은 빼는 것이 특히 분명했다: `po_invoice_state` 는 결제 화면의 정산 모달이 쓰는
       * 값이고, `inv_code` 는 **인보이스 발행·취소가 유지하는 비정규 사본**이다(`invoiceTranslatorId`
       * 주석). 등록 폼에서 손으로 적을 수 있게 두면 결제 화면이 관리하는 값을 자유 입력이 덮어쓰고,
       * 그 번호가 어느 인보이스를 가리키는지는 아무도 알 수 없게 된다.
       */
      poMoneyState: form.poMoneyState.trim() || null,
      poMoneyDay: form.poMoneyDay || null,
      poMoneyPrice: toDecimalInput(form.poMoneyPrice),
      poContent: form.poContent.trim() || null,
    }

    if (po) {
      await updatePo.mutateAsync({ id: po.id, input: common })
      onSaved(`${po.poCode} PO를 수정했습니다.`)
    } else {
      const input: PurchaseOrderInput = { ...common, jobId: job.id, poName: null }
      const created = await createPo.mutateAsync(input)
      onSaved(`${created.poCode} PO를 등록했습니다.`)
    }
    onClose()
  }

  /**
   * 입력한 합계가 `물량 × 단가` 와 다른지. **언어 발주에만 있는 비교다** — `JobFormModal` 의 같은
   * 자리 주석 참고. 비언어 발주의 합계는 입력값이라 견줄 상대가 자기 자신이고, 전에 그 자리에
   * 있던 `합계 × 환율` 비교는 원화 금액이 파생값이 된 지금 어긋날 수 없다.
   */
  const differs =
    linguistic &&
    suggestedSum !== null &&
    toDecimalInput(form.poPriceSum) !== null &&
    decimalSubtract(toDecimalInput(form.poPriceSum), suggestedSum) !== '0.00'

  return (
    <Modal
      title={isEdit ? 'PO 수정' : 'PO 등록'}
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
          PO 코드 <strong>{po.poCode}</strong> — 코드와 소속 작업은 변경할 수 없습니다.
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
            <PoJobPicker
              value={job}
              projectId={jobScopeProjectId}
              disabled={pending}
              onChange={(option, row) => {
                setDirty(true)
                setJob(option)
                // 고른 작업의 언어를 미리 채운다 — 고칠 수 있다 (팀장님 2026-11-25).
                if (row && (row.jobSlang || row.jobElang)) {
                  setForm((prev) => ({ ...prev, poSlang: row.jobSlang ?? prev.poSlang, poElang: row.jobElang ?? prev.poElang }))
                }
              }}
            />
          )}
        </div>

        {/*
         * 번역가 · 작업 종류 · 업무 구분 — 한 줄 (팀장님 2026-11-26). 번역가 폭은 아래 출발어 칸과 같은 절반
         * (LanguagePickers 의 '1fr 1fr' + gap 14px), 나머지 절반을 작업 종류 · 업무 구분이 나눈다.
         */}
        <div className={ui.formRow} style={{ gridTemplateColumns: 'calc(50% - 7px) repeat(2, minmax(0, 1fr))' }}>
          <div className={ui.field}>
            <PoTranslatorPicker
              value={translator}
              disabled={pending}
              onChange={(option) => {
                setDirty(true)
                setTranslator(option)
                // 번역가에 따라 CAT 가중치가 바뀐다 — 물량도 다시 계산.
                setForm((prev) => withCat(prev, prev.catWords, catWeightsFor(option?.title)))
              }}
            />
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
              placeholder={unsetWork}
            />
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
            {/*
             * `placeholder={null}` 이 `unsetPlaceholder` 가 아닌 이유는 위 주석의 마지막 문단에
             * 있다 — `value` 가 `poType` 이고 그 값은 비어 있을 수가 없다.
             */}
            <CodeSelect
              id="po-type"
              domain={CODE_DOMAIN.JOBTYPE}
              value={poType}
              onChange={(v) => set('poType', v)}
              placeholder={null}
            />
            {!isEdit && form.poType.trim() === '' ? (
              <span className={ui.hint}>작업의 업무 구분을 따릅니다. 바꿀 수 있습니다.</span>
            ) : null}
          </div>
        </div>

        {/* 출발어 · 도착어 — 그 둘만 한 줄, 한 쌍만 (작업 등록 창과 같은 입력 방식, 팀장님 2026-11-25). */}
        {linguistic ? (
          <LanguagePickers
            source={form.poSlang}
            onSource={(v) => set('poSlang', v)}
            target={form.poElang}
            onTarget={(v) => set('poElang', v)}
            sourcePlaceholder="출발어 고르기"
            disabled={pending}
          />
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

        {/* 물량 + CAT 분량 표. 표에 단어를 넣으면 합계가 물량이 되고 단위는 '단어' 로 고정된다. */}
        {linguistic ? (
          <div className={ui.formRow} style={{ gridTemplateColumns: 'minmax(180px, 220px) 1fr' }}>
            <div className={ui.field}>
              <label className={ui.label} htmlFor="po-volume">
                물량
              </label>
              {/* 숫자 칸을 넓게, 단위 드롭다운은 좁게 (팀장님 2026-11-26). */}
              <div className={`${ui.inputRow} ${ui.volRow}`}>
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
                  placeholder={null}
                  disabled={catInfo !== null}
                  silent
                />
              </div>
            </div>
            <div className={ui.field}>
              <span className={ui.label}>
                CAT 분량 <span className={ui.hint}>(단어만 입력 · 시트에서 여러 칸 붙여넣기 가능{weights === DEFAULT_CAT_WEIGHTS ? '' : ' · 이 번역가 전용 가중치'})</span>
              </span>
              <CatTable words={form.catWords} weights={weights} onChange={setCatWords} disabled={pending} />
            </div>
          </div>
        ) : null}

        {/* 단가 · 통화 · 환율 · 합계 — 한 줄 (팀장님 2026-11-25). 원화 환산 합계 칸은 숨긴다(저장은 그대로). */}
        <div className={ui.formRow} style={{ gridTemplateColumns: linguistic ? '1fr 0.9fr 1.5fr 1fr' : '0.9fr 1.5fr 1fr' }}>
          {linguistic ? (
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
          ) : null}
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
            {/* '선택 없음' 이 없다 — 빈 값은 `KRW` 와 효과가 같다. `unsetCoin` 주석 참고. */}
            {unsetCoin ? <option value="">{unsetCoin}</option> : null}
            {codeOptions(COIN_CODES, form.poCoinCode).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className={ui.hint}>번역가의 정산 통화와 같아야 합니다.</span>
        </div>

        {/*
         * 환율 칸이 있던 자리. 세 모습이 파일 머리말의 세 경우에 대응한다 — `JobFormModal` 의
         * 같은 자리 주석 참고.
         */}
        <div className={ui.field}>
          <span className={ui.label}>환율</span>
          {isKrw ? (
            <span className={ui.hint}>원화 금액입니다. 환산할 것이 없습니다.</span>
          ) : settled ? (
            <>
              <output className={ui.hint} htmlFor="po-coin">
                1 {coin} = <strong>{formatMoney(storedRate)}</strong> KRW
              </output>
              <span className={ui.hint}>
                이미 원화로 환산된 건입니다. 이 환율과 아래 원화 금액은 그대로 보존합니다.
              </span>
            </>
          ) : (
            <>
              <button
                type="button"
                className={`${ui.btn} ${ui.btnSm}`}
                onClick={convertToKrw}
                disabled={!convertible || pending}
              >
                원화로 환산
              </button>
              {/* 누를 수 없을 때 **왜 없는지**를 쓴다 — 이유가 셋이고 전부 오류가 아니다. */}
              <span className={fx.canConvert ? ui.hint : ui.hintWarn}>
                {fx.isLoading
                  ? '시세를 읽고 있습니다…'
                  : !fx.canConvert
                    ? `${coin} 시세가 아직 수집되지 않아 환산할 수 없습니다. 금액은 ${coin} 기준으로 그대로 저장됩니다.`
                    : toDecimalInput(form.poPriceSum) === null
                      ? '환산할 합계를 먼저 입력하세요.'
                      : `현 시세 1 ${coin} = ${formatMoney(fx.rate)} KRW${
                          fx.effectiveDate ? ` (${formatDate(fx.effectiveDate)} 기준)` : ''
                        }. 누르면 통화가 KRW 로 바뀌고 금액이 고정됩니다.`}
              </span>
            </>
          )}
        </div>

        {/*
         * 비언어 발주에서는 `setSumEdited(true)` 를 부르지 않는다 — 여기서 합계는 계산 결과가
         * 아니라 출발점이고, 덮어쓸 계산값이 애초에 없다. `JobFormModal` 의 같은 자리 주석 참고.
         */}
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
              if (linguistic) setSumEdited(true)
              set('poPriceSum', e.target.value)
            }}
          />
          {linguistic ? null : (
            <span className={ui.hint}>
              물량·단가 없이 전체 금액을 직접 넣습니다. 원화 환산 합계는 환율을 곱해 따라옵니다.
            </span>
          )}
        </div>
        </div>

        {/* 기간의 두 끝은 한 줄에 묶는다 — 프로젝트 서식과 같은 이유(그쪽 `.datePair` 주석). */}
        <div className={ui.datePair}>
          <DateField
            id="po-sday"
            label="시작일"
            value={form.poSday}
            onChange={(v) => setPeriod(v, form.poEday, 'start')}
            disabled={pending}
            time={{
              value: form.poSdayTime,
              onChange: (v) => set('poSdayTime', v),
              ariaLabel: '시작 시각',
            }}
          />

          <DateField
            id="po-eday"
            label="납기"
            value={form.poEday}
            onChange={(v) => setPeriod(form.poSday, v, 'end')}
            disabled={pending}
            time={{
              value: form.poEdayTime,
              onChange: (v) => set('poEdayTime', v),
              ariaLabel: '납기 시각',
            }}
          >
            <span className={ui.hint}>작업 납기보다 앞서야 검수 시간이 남습니다.</span>
          </DateField>
        </div>

        {/* 세금 · 지급 — 경영지원부(와 시스템관리자)에게만 보인다 (팀장님 2026-11-25). 숨겨도 값은 그대로 저장된다. */}
        {mayFinance ? (
          <>
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

        {/*
         * '계산서' 와 '계산서 번호' 가 있던 자리. 두 칸은 지금 쓰지 않으므로 화면에서 뺐다 —
         * 컬럼·쓰기 스키마·타입은 그대로이고, 저장 본문에서 빠진 이유와 그 안전함은 위 `common`
         * 주석에 적혀 있다. 되돌릴 때는 그 두 곳과 폼 상태 세 줄이 전부다.
         */}
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
            {/* '선택 없음' 이 없다 — 모든 발주가 미정산에서 시작한다. `unsetMoney` 주석 참고. */}
            {unsetMoney ? <option value="">{unsetMoney}</option> : null}
            {codeOptions(MONEY_STATES, form.poMoneyState).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/*
         * 지급일도 같은 칸을 쓴다. 기간이 아니므로 맞춤(`setPeriod`)은 없고 시각 칸도 없다.
         *
         * 한 서식 안에서 이 칸만 기본 날짜 입력으로 남겨 두는 쪽이 더 나쁘다 — `261130` 이
         * 위에서는 되고 여기서는 안 되면, 사람은 "가끔 된다" 를 배우고 **모든 칸에서** 손으로
         * 치기를 그만둔다. 규칙은 전부에 적용되어야 규칙이다.
         */}
        <DateField
          id="po-money-day"
          label="지급일"
          value={form.poMoneyDay}
          onChange={(v) => set('poMoneyDay', v)}
          disabled={pending}
        />

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
          </>
        ) : null}

        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="po-content">
            PO 내용 · 지시사항
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

      {/* 미정산 외화라는 사실을 저장 전에 말한다 — `JobFormModal` 의 같은 자리 주석 참고. */}
      {!settled && effectiveRate !== null ? (
        <InfoNotice>
          표시된 원화 환산 값은 현 시점의 환율이 적용된 값이며, 추후 환율에 따라 변동이 생길 수
          있습니다. 금액을 고정하려면 <strong>원화로 환산</strong>을 누르세요.
        </InfoNotice>
      ) : null}

      {differs ? (
        <InfoNotice>
          입력한 합계가 <strong>물량 × 단가</strong> 계산값({formatMoney(suggestedSum)}{' '}
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
