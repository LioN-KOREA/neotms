import { useState } from 'react'
import { useCreateJob, useUpdateJob } from '@/apis/queries/neotms.mutation'
import { useFxRate } from '@/apis/queries/neotms.query'
import {
  CODE_DOMAIN,
  codeOptions,
  COIN_CODES,
  isLinguistic,
  JOB_STATES,
  JOB_TYPE_LINGUISTIC,
} from '@/apis/neotms.codes'
import type { JobInput, JobRow, JobUpdate } from '@/apis/neotms.types'
import { CodeSelect } from '@/shared/ui/CodeSelect'
import { ErrorNotice, InfoNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import type { PickerOption } from '@/shared/ui/RecordPicker'
import { formatDate, toDateInputValue } from '@/shared/utils/format'
import {
  decimalCompare,
  decimalMultiply,
  decimalSubtract,
  formatMoney,
  toDecimalInput,
} from '@/shared/utils/money'
import ui from '@/shared/ui/ui.module.css'
import { ProjectPicker } from '@/features/projects/ProjectPicker'

interface Props {
  /** null 이면 신규. */
  job: JobRow | null
  /**
   * 소속 프로젝트가 이미 정해진 경우(프로젝트 상세에서 '작업 추가'). 주면 선택란 대신 고정
   * 표시가 된다.
   */
  fixedProject?: PickerOption | null
  onClose: () => void
  onSaved: (message: string) => void
}

/**
 * 작업(JOB) 등록·수정. **이 시스템의 매출이 여기서 입력된다.**
 *
 * ## 합계를 화면이 계산한다
 *
 * `jobPriceSum`(외화 합계)과 `jobPriceKsum`(원화 환산 합계)은 서버가 다시 계산해 주지 않고 받은
 * 값을 그대로 저장한다(백엔드 `JOB_FIELDS`). 의도된 설계다 — 레거시 데이터에는 손으로 조정한
 * 합계가 들어 있고, 그 금액으로 이미 세금계산서가 발행되었다. 서버가 `물량 × 단가` 로 덮어쓰면
 * 발행된 계산서와 장부가 어긋난다.
 *
 * 그래서 화면이 계산하고, **사용자가 고칠 수 있게** 둔다. 계산은 `shared/utils/money.ts` 의
 * `BigInt` 10진 연산으로 한다 — `numeric(18,2)` 금액에 `numeric(18,6)` 환율을 곱하면 중간값이
 * 24자리이고, `Number` 로는 정상적인 입력에서도 값이 틀린다.
 *
 * 한 번 직접 고친 합계는 그 뒤로 자동 갱신하지 않는다. 고쳐 놓은 값을 단가를 만지는 순간
 * 덮어쓰면, 사용자는 자기가 조정한 금액이 사라진 것을 모른 채 저장한다.
 *
 * ## 환율은 입력란이 아니다 — 환전은 동작이다
 *
 * 환율을 손으로 적는 칸이 여기 있었다. 그 칸은 두 가지를 섞고 있었다 — "이 외화 금액을 원화로
 * 얼마로 볼 것인가"(시세, 계속 변한다)와 "이 건은 얼마에 환전되었나"(사실, 변하지 않는다).
 * 섞어 두면 둘 다 틀린다. 아직 환전하지 않은 작년 USD 미수금이 작년 환율로 굳어 있고, 이미
 * 환전한 건은 환율을 고쳐 쓰면 발행된 계산서와 어긋난다.
 *
 * 그래서 `coinRate` 는 **값이 붙은 정산 플래그**가 되었다(db/014_fx_rates.sql, NeotmsMoney.ts).
 *
 * | 통화 | `coinRate` | 뜻 | 원화 금액 |
 * |---|---|---|---|
 * | KRW | 1 | 애초에 원화 | 합계 그대로 |
 * | 외화 | 값 있음 | **정산됨** — 환전이 끝났다 | 저장된 금액. 영구히 고정 |
 * | 외화 | 비어 있음 | **미정산** — 아직 환전 전 | 합계 × **현 시세** |
 *
 * 세 번째 줄이 이 화면에서 환율 입력란을 없앤 이유다. 환전하지 않은 외화 채권의 원화 가치는
 * 고정된 값이 아니라 지금 시세로 계산되는 값이고, 그건 사람이 적을 것이 아니라 화면이 읽어
 * 보여 줄 것이다(`useFxRate`). 그 자리에 대신 **원화로 환산** 버튼이 있다 — 누르면 통화가 KRW 로,
 * 합계가 환산 금액으로, 환율이 1 로 한 번에 바뀐다. 즉 행이 세 번째 줄에서 첫 번째 줄로 옮겨
 * 간다. 환전과 고정이 한 동작인 것은 실제 업무가 그렇기 때문이다.
 *
 * 그래서 **원화 환산 합계는 읽기 전용**이다. 타이핑할 수 있는 칸으로 두면 위 세 경우 중 어디에
 * 있는지와 무관하게 아무 숫자나 들어갈 수 있고, 리포트가 읽는 매출이 그 숫자가 된다.
 */
/**
 * 금액을 바꾸는 칸. 바뀌면 저장된 원화 금액은 더 이상 그 금액에 대한 사실이 아니다.
 *
 * 통화가 여기 있는 것이 중요하다 — 통화를 고치면 금액의 숫자는 그대로라도 그것이 **얼마인지**가
 * 달라지므로, 저장된 원화 금액은 더 이상 이 금액을 설명하지 않는다.
 */
const MONEY_KEYS = ['jobVolume', 'jobPrice', 'jobPriceDis', 'jobPriceSum', 'coinCode']

export function JobFormModal({ job, fixedProject = null, onClose, onSaved }: Props) {
  const isEdit = !!job
  const createJob = useCreateJob()
  const updateJob = useUpdateJob()
  const pending = createJob.isPending || updateJob.isPending

  /**
   * 소속 프로젝트.
   *
   * 수정 화면에서는 고를 수 없다. `JobUpdate` 에 `projectId` 가 없는 것이 그 이유이고, 그
   * 제약은 의미가 있다 — 작업을 다른 프로젝트로 옮기는 것은 **매출을 다른 고객사로 옮기는**
   * 일이고, 그건 집계가 이미 나간 뒤에 조용히 할 수 있어서는 안 된다.
   */
  const [project, setProject] = useState<PickerOption | null>(
    job
      ? { id: job.projectId, title: job.prjName || job.prjCode || job.projectId, subtitle: job.cusCodeName }
      : fixedProject,
  )

  const [form, setForm] = useState({
    jobName: job?.jobName ?? '',
    workCode: job?.workCode ?? '번역',
    jobType: job?.jobType ?? JOB_TYPE_LINGUISTIC,
    jobSlang: job?.jobSlang ?? '',
    jobElang: job?.jobElang ?? '',
    jobCategory: job?.jobCategory ?? '',
    jobVolume: job?.jobVolume ?? '',
    unitCode: job?.unitCode ?? '단어',
    jobPrice: job?.jobPrice ?? '',
    jobPriceDis: job?.jobPriceDis ?? '',
    coinCode: job?.coinCode ?? 'KRW',
    /**
     * 비어 있는 것이 **미정산**이라는 뜻이다. 그래서 `?? '1'` 이 아니다.
     *
     * 1 로 채우면 환전하지 않은 USD 작업을 열었을 때 "1 USD = 1 KRW 로 정산된 건" 이 되고,
     * 환산 버튼 대신 그 거짓말이 그려지고 저장하면 그대로 박힌다. 신규는 통화가 KRW 로
     * 시작하므로 빈 값이어도 문제가 없다 — 원화 여부는 `coinCode` 가 답하고, 이 칸은
     * "환전되었는가" 만 답한다(파일 머리말의 표).
     */
    coinRate: job?.coinRate ?? '',
    jobPriceSum: job?.jobPriceSum ?? '',
    jobPriceKsum: job?.jobPriceKsum ?? '',
    jobSday: toDateInputValue(job?.jobSday),
    jobSdayTime: job?.jobSdayTime ?? '',
    jobEday: toDateInputValue(job?.jobEday),
    jobEdayTime: job?.jobEdayTime ?? '',
    jobState: job?.jobState ?? '대기',
    jobMemo: job?.jobMemo ?? '',
  })
  const [dirty, setDirty] = useState(false)

  /**
   * 합계를 사람이 직접 고쳤는지. 수정 화면은 **처음부터 고쳐진 것으로 취급한다** — 저장된
   * 합계가 손으로 조정된 값일 수 있고, 그 가능성이 이 플래그가 존재하는 이유 전부다.
   */
  const [sumEdited, setSumEdited] = useState(isEdit)

  /**
   * 금액에 영향을 주는 칸을 이 화면에서 건드렸는지. **저장된 원화 금액을 지키는 자물쇠다.**
   *
   * 정산이 끝난 행(통화가 KRW 이거나 환율이 박힌 행)의 `jobPriceKsum` 은 계산 결과가 아니라
   * **사실**이다 — 그 금액으로 계산서가 나갔고, 손으로 조정된 값일 수도 있다. 그런 행을 열어
   * 메모만 고치고 저장했을 때 화면이 `합계 × 환율` 을 다시 계산해 넣으면, 아무도 금액을 건드리지
   * 않았는데 장부가 몇 원 움직인다. 실제로 그런 차이가 생긴다 — db/014 가 레거시 행의 환율을
   * `round(ksum / sum, 6)` 으로 복원했으므로 다시 곱하면 반올림만큼 어긋난다.
   *
   * 그래서 정산된 행은 **금액 칸을 실제로 건드릴 때까지** 저장된 값을 그대로 돌려보낸다.
   * 미정산 외화 행에는 이 자물쇠가 걸리지 않는다. 그 행의 원화 금액은 애초에 사실이 아니라
   * 현 시세로 계산되는 값이고(파일 머리말의 세 번째 줄), 목록·리포트도 그렇게 보여 준다 —
   * 여기서만 저장된 옛 값을 보여 주면 같은 작업의 금액이 화면마다 다르다.
   */
  const [moneyTouched, setMoneyTouched] = useState(false)

  /**
   * 합계를 만든다. **어디서 출발하는지가 업무 구분에 따라 다르다.**
   *
   * 언어 업무: `물량 × 단가 − 할인` 이 합계다.
   * 비언어 업무: 합계는 **사용자가 직접 넣는 값**이다. MICE·IMC 작업은 단어 수로 팔지 않으므로
   * 곱할 물량이 없고(db/012_job_pricing.sql), 계산해 줄 것이 없다.
   *
   * 레거시 TMS 에서 비언어 작업을 기록하던 방법이 바로 이 분기가 없을 때의 모습이다 — 한국어 →
   * 한국어 라는 가짜 언어쌍에 물량 1, 단가에 전체 금액. 금액은 맞지만 "1 단어" 라는 거짓이 함께
   * 저장되고, 리포트의 언어쌍별 집계가 그 가짜 쌍을 진짜로 센다.
   *
   * **원화 환산은 여기 없다.** 그건 이 폼의 상태가 아니라 통화·환율·시세에서 나오는 파생값이고,
   * 아래 `ksum` 이 렌더마다 계산한다 — 시세는 `set()` 이 불리지 않아도 도착한다.
   */
  const computeSum = (f: typeof form) => {
    if (!isLinguistic(f.jobType)) return toDecimalInput(f.jobPriceSum)
    // 할인이 비어 있으면 `decimalSubtract` 가 곱셈 결과를 그대로 돌려준다(money.ts).
    return decimalSubtract(decimalMultiply(f.jobVolume, f.jobPrice), f.jobPriceDis)
  }

  const suggestedSum = computeSum(form)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setDirty(true)
    if (MONEY_KEYS.includes(key as string)) setMoneyTouched(true)
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      /*
       * 합계를 아직 손대지 않았다면 자동으로 따라오게 한다.
       *
       * `useEffect` 로 하지 않는다. 이펙트로 만들면 렌더가 한 번 더 돌고, 그 사이 상태에서
       * 사용자가 타이핑하면 입력이 되돌아가는 종류의 버그가 생긴다. 계산은 원인이 되는
       * 입력이 바뀌는 그 자리에서 한 번만 하면 된다.
       *
       * 무엇이 계산을 촉발하는지도 업무 구분에서 갈린다. **다음 상태의 구분**으로 판단한다 —
       * `linguistic` 은 이 렌더 시점의 값이고, 구분 자체가 지금 바뀌는 중일 수 있다.
       *
       * 비언어 업무에서 합계는 사용자가 넣는 값이므로 따라올 것이 없다 — 아래 분기가 언어
       * 업무에만 있는 이유다. 전에는 환율이 촉발 목록에 있었지만 환율 입력란이 없어졌고,
       * 원화 금액은 이제 상태가 아니라 파생값이다(파일 머리말).
       */
      const nextLinguistic = isLinguistic(next.jobType)
      if (!sumEdited && nextLinguistic && ['jobVolume', 'jobPrice', 'jobPriceDis'].includes(key)) {
        next.jobPriceSum = computeSum(next) ?? ''
      }
      /*
       * 통화를 바꾸면 환율을 **같이 정리한다.** 섞이면 조용히 틀리는 자리다.
       *
       * KRW 로 바꾸면 환율은 1 이다 — 원화 금액을 원화로 환산할 것이 없다. 외화로 바꾸면 환율을
       * 비운다, 즉 **미정산**으로 돌린다. 직전 통화의 환율을 남겨 두면 USD 로 정산된 행을 JPY 로
       * 바꿨을 때 USD 환율이 JPY 금액에 곱해진다 — 통화가 바뀌는 순간 이전 환율은 이 금액에
       * 대한 사실이 아니다.
       *
       * 합계는 건드리지 않는다. 통화를 고치는 흔한 이유는 **처음에 잘못 골랐다**는 것이고(금액은
       * 맞다), 그때 금액까지 환산해 버리면 고칠 수 없는 쪽이 망가진다. 환전은 금액을 바꾸는
       * 동작이고, 그건 드롭다운이 아니라 `convertToKrw` 버튼이 한다.
       */
      if (key === 'coinCode') {
        next.coinRate = (next.coinCode.trim().toUpperCase() || 'KRW') === 'KRW' ? '1' : ''
      }
      /*
       * 업무 구분을 바꾸면 **안 쓰는 쪽을 여기서 비운다.** 이펙트로 미루면 안 되는 자리다.
       *
       * 숨겨진 입력란의 값은 화면에 없어도 `form` 에 남아 있고, `onSubmit` 은 그 `form` 을 읽는다.
       * 이펙트는 렌더가 끝난 뒤에 돌므로, 구분을 바꾸고 바로 저장을 누르면 이미 보이지 않는
       * 출발어가 그대로 실려 나간다 — 그러면 서버가 400(업무 구분 불일치)으로 거절하거나, 더 나쁘게는
       * MICE 작업에 언어쌍이 붙은 상태로 남는다. 원인이 되는 입력이 바뀌는 그 자리에서 비우면
       * 중간 상태가 아예 존재하지 않는다.
       *
       * 비우는 쪽만 건드린다. MICE 로 바꿨다가 다시 언어로 되돌리면 출발어는 비어 있는데, 그게
       * 맞다 — 서버도 구분이 바뀔 때 반대쪽 상세 행을 지우므로, 되살아나는 것처럼 보이는 값이
       * 실제로는 저장되지 않은 값이 되는 상황을 만들지 않는다.
       *
       * 비언어로 바꿀 때 **물량·단가·할인도 같이 비운다.** 그 세 칸은 언어 상세 행의 컬럼이고
       * (db/012_job_pricing.sql), 서버는 구분이 바뀌면 그 행을 지운다. 즉 남겨 두면 화면에만
       * 있다가 저장과 함께 사라지는 값이 된다.
       *
       * **합계와 원화 합계는 비우지 않는다.** 그 둘은 구분과 무관하게 `job` 에 그대로 있고, 이
       * 동작이 레거시 정리를 무손실로 만드는 지점이다 — 한국어 → 한국어 / 1 단어 로 기록된 행을
       * MICE 로 바꾸면 가짜 언어쌍과 가짜 물량만 사라지고, 리포트가 읽는 금액은 손대지 않은
       * 상태로 남는다. 금액을 다시 타이핑하게 만들면 거기서 오타가 생긴다.
       */
      if (key === 'jobType') {
        if (nextLinguistic) next.jobCategory = ''
        else {
          next.jobSlang = ''
          next.jobElang = ''
          next.jobVolume = ''
          next.jobPrice = ''
          next.jobPriceDis = ''
        }
      }
      return next
    })
  }

  /** 자동 계산으로 되돌린다. 직접 고친 뒤 "원래 값이 뭐였지" 가 되는 경우가 실제로 많다. */
  const applySuggestion = () => {
    setDirty(true)
    setSumEdited(false)
    setMoneyTouched(true)
    setForm((prev) => ({ ...prev, jobPriceSum: suggestedSum ?? '' }))
  }

  const name = form.jobName.trim()
  const canSave = name.length > 0 && !!project && !pending

  /** 이 작업이 언어쌍을 가지는지. 입력란과 저장 본문이 모두 이 한 값에서 갈린다. */
  const linguistic = isLinguistic(form.jobType)

  /* ------------------------------------------------------------------------ */
  /* 원화 환산 — 파일 머리말의 세 경우가 여기서 갈린다                           */
  /* ------------------------------------------------------------------------ */

  /** 통화 코드. 빈 값은 원화로 읽는다 — 서버의 `COALESCE(coin_code, 'KRW')` 와 같은 규칙이다. */
  const coin = form.coinCode.trim().toUpperCase() || 'KRW'
  const isKrw = coin === 'KRW'
  /** 환전된 환율. 있으면 그 자체가 "정산 끝" 이라는 뜻이다. */
  const storedRate = toDecimalInput(form.coinRate)
  /** 원화 금액이 **사실로 고정**되었는지. 아니면 시세에 따라 움직이는 값이다. */
  const settled = isKrw || storedRate !== null

  /**
   * 현 시세. 미정산 외화일 때만 쓰인다.
   *
   * 통화가 KRW 이면 훅이 `canConvert: false` 를 돌려주므로 호출을 조건부로 만들 필요가 없다 —
   * 애초에 훅은 조건부로 부를 수 없고(규칙), `useFxRates` 의 캐시는 이 모달의 수명과 무관하게
   * 5분이므로 모달을 여닫는 비용도 없다.
   */
  const fx = useFxRate(form.coinCode)

  /** 합계를 원화로 만드는 환율. `null` 은 "아직 알 수 없다" 이지 0 이 아니다. */
  const effectiveRate = isKrw ? '1' : settled ? storedRate : fx.rate

  /**
   * 원화 환산 합계. **이 화면이 저장하는 매출이고, 사람이 타이핑하지 않는다.**
   *
   * 다시 계산할지 말지가 `moneyTouched` 와 `settled` 에서 갈린다(위 자물쇠 주석). 그리고 시세를
   * 모를 때는 저장된 값을 그대로 쓴다 — 서버의 `COALESCE(sum * rate, ksum)` 과 **같은 선택**이고
   * (NeotmsMoney.ts), 그래야 수집기가 한 번도 돌지 않은 날에도 금액이 0 으로 꺼지지 않는다.
   */
  const product =
    effectiveRate !== null && (!settled || !isEdit || moneyTouched)
      ? decimalMultiply(form.jobPriceSum, effectiveRate)
      : null

  /**
   * 미정산 외화에서 **합계가 0 이면 환산 결과를 주장하지 않는다.** 서버의 `NULLIF(sum, 0)` 과
   * 같은 선택이다(NeotmsMoney.ts).
   *
   * 이 분기가 없으면 레거시 행 하나가 조용히 망가진다 — 원화 금액은 적혀 있는데 원통화 합계가
   * nvarchar `''` 에서 0 으로 들어온 행이다. 그 행은 db/014 의 백필이 환율을 못 박아 주지
   * 못한다(0 으로 나눌 수 없으니), 그래서 미정산으로 남고, `0 × 시세 = 0` 이 **이미 청구된
   * 원화 금액을 0 으로 덮어쓴다.** 목록은 서버가 막아 주지만 저장하는 건 이 화면이다.
   *
   * 정산된 행과 원화 행에는 이 보호를 걸지 않는다. 그쪽에서 합계 0 은 레거시 사고가 아니라
   * 사용자가 방금 입력한 값이고(무상 작업), 0 을 그대로 저장하는 것이 맞다.
   */
  const ksum =
    !settled && decimalCompare(toDecimalInput(form.jobPriceSum), '0') === 0
      ? toDecimalInput(form.jobPriceKsum)
      : (product ?? toDecimalInput(form.jobPriceKsum))

  /**
   * 환전하고 고정한다. **한 번의 `setForm` 으로 네 값을 같이 바꾼다.**
   *
   * 나눠 쓰면 중간 상태가 생긴다 — 통화만 KRW 가 되고 합계는 아직 USD 인 렌더가 한 번 존재하고,
   * 그 사이에 저장을 누르면 USD 금액이 원화로 기록된다. `set()` 을 네 번 부르는 것도 같은 문제다.
   *
   * `sumEdited` 를 참으로 올리는 것이 함께 필요하다. 합계는 이제 원화고 단가는 외화인데, 그
   * 플래그가 거짓이면 사용자가 물량을 고치는 순간 `물량 × 외화 단가` 가 원화 합계를 덮어쓴다.
   * 물량·단가·할인은 **그대로 남긴다** — 그 세 값은 "단어당 0.12 USD 로 합의했다" 는 기록이고,
   * 환전은 그 합의를 바꾸지 않는다. 그래서 환산 뒤에는 `물량 × 단가 ≠ 합계` 가 되고, 아래
   * 안내가 그 사실을 숨기지 않고 말한다.
   */
  /**
   * 환산 버튼을 누를 수 있는지.
   *
   * 시세가 있어도 환산할 금액이 없으면 눌러도 아무 일이 없다. 반응 없는 버튼은 고장으로 읽히므로,
   * 누를 수 없는 이유를 버튼이 비활성으로 먼저 말하게 한다.
   */
  const convertible = fx.canConvert && toDecimalInput(form.jobPriceSum) !== null

  const convertToKrw = () => {
    if (!convertible || fx.rate === null) return
    const converted = decimalMultiply(form.jobPriceSum, fx.rate)
    if (converted === null) return
    setDirty(true)
    setSumEdited(true)
    setMoneyTouched(true)
    setForm((prev) => ({
      ...prev,
      coinCode: 'KRW',
      coinRate: '1',
      jobPriceSum: converted,
      jobPriceKsum: converted,
    }))
  }

  const onSubmit = async () => {
    if (!project || name.length === 0) return

    /*
     * 업무 구분에 맞는 쪽만 보낸다.
     *
     * 반대쪽을 `null` 로 보내도 서버는 무시한다(상세 테이블이 다르므로 그 컬럼이 아예 없다).
     * 그래도 보내지 않는 쪽이 낫다 — 요청 본문만 보고도 이 작업이 무엇인지 읽히고, 언젠가 서버가
     * 모르는 필드를 거절하게 되더라도 그대로 통한다.
     *
     * 물량·단위·단가·할인이 **언어 쪽에 함께 있는** 것이 이번 변경의 핵심이다. 그 네 값은
     * `job_detail_linguistic` 의 컬럼이고(db/012_job_pricing.sql), 비언어 작업에는 보낼 자리가
     * 없다 — 비언어 작업이 보내는 금액은 아래 `jobPriceSum`·`jobPriceKsum` 둘뿐이고, 그 둘은
     * 구분과 무관하게 `job` 에 있다.
     */
    const detail: Partial<JobUpdate> = linguistic
      ? {
          jobSlang: form.jobSlang.trim() || null,
          jobElang: form.jobElang.trim() || null,
          jobVolume: toDecimalInput(form.jobVolume),
          unitCode: form.unitCode.trim() || null,
          jobPrice: toDecimalInput(form.jobPrice),
          jobPriceDis: toDecimalInput(form.jobPriceDis),
        }
      : { jobCategory: form.jobCategory.trim() || null }

    const common: JobUpdate = {
      jobName: name,
      workCode: form.workCode.trim() || null,
      jobType: form.jobType.trim() || null,
      ...detail,
      coinCode: form.coinCode.trim() || null,
      /*
       * 환율은 **정산 여부**로 결정된다. 사람이 적은 값을 그대로 보내던 자리다.
       *
       * 미정산 외화는 `null` 을 보낸다. 그 `null` 이 "이 금액은 아직 환전되지 않았으니 읽을 때마다
       * 현 시세로 계산하라" 는 지시이고(NeotmsMoney.ts 의 세 번째 경우), 여기서 대신 오늘 시세를
       * 숫자로 박아 보내면 **그 행은 정산된 것이 된다** — 환전하지도 않은 채권이 오늘 시세로
       * 영구히 굳고, 다음 주에 환율이 움직여도 리포트는 오늘 값을 계속 답한다.
       */
      coinRate: settled ? effectiveRate : null,
      jobPriceSum: toDecimalInput(form.jobPriceSum),
      /*
       * 원화 금액은 폼 상태가 아니라 위에서 계산된 파생값을 보낸다.
       *
       * 미정산 행에서는 서버가 읽을 때마다 다시 계산하므로 이 값은 **시세를 모를 때의 대비책**일
       * 뿐이다. 그래도 보낸다 — 보내지 않으면 수집기가 아직 돌지 않은 통화에서 금액이 빈 값이 되고,
       * 그건 "조용한 분기" 로 보인다(db/004_rollup.sql 이 경고하는 실패 양상).
       */
      jobPriceKsum: ksum,
      jobSday: form.jobSday || null,
      jobSdayTime: form.jobSdayTime || null,
      jobEday: form.jobEday || null,
      jobEdayTime: form.jobEdayTime || null,
      jobState: form.jobState.trim() || null,
      jobMemo: form.jobMemo.trim() || null,
    }

    if (job) {
      await updateJob.mutateAsync({ id: job.id, input: common })
      onSaved(`${name} 작업을 수정했습니다.`)
    } else {
      const input: JobInput = { ...common, projectId: project.id, jobName: name }
      const created = await createJob.mutateAsync(input)
      onSaved(`${name} 작업을 등록했습니다. (코드: ${created.jobCode})`)
    }
    onClose()
  }

  /**
   * 입력한 합계가 `물량 × 단가 − 할인` 과 다른지. 다르면 그 사실을 숨기지 않고 보여 준다.
   *
   * **언어 업무에만 있는 비교다.** 비언어 업무의 합계는 계산 결과가 아니라 입력값이므로 견줄
   * 상대가 자기 자신이고, 전에 그 자리에 있던 `합계 × 환율` 비교는 원화 금액이 파생값이 된 지금
   * 구조적으로 어긋날 수 없다 — 경고로 둘 이유가 없어졌다.
   *
   * 환산 버튼을 누른 뒤에는 이 경고가 **거의 항상 켜진다.** 그게 맞다: 합계는 원화가 되었고
   * 단가는 외화로 남아 있으므로 둘은 정말로 더 이상 곱해서 맞지 않는다(`convertToKrw` 주석).
   */
  const differs =
    linguistic &&
    suggestedSum !== null &&
    toDecimalInput(form.jobPriceSum) !== null &&
    decimalSubtract(toDecimalInput(form.jobPriceSum), suggestedSum) !== '0.00'

  return (
    <Modal
      title={isEdit ? '작업 수정' : '작업 등록'}
      onClose={onClose}
      isDirty={dirty && !pending}
      width={820}
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
      <ErrorNotice error={createJob.error ?? updateJob.error} />

      {isEdit ? (
        <p className={ui.hint}>
          작업 코드 <strong>{job.jobCode}</strong> — 코드와 소속 프로젝트는 변경할 수 없습니다.
        </p>
      ) : null}

      <div className={ui.formGrid}>
        <div className={ui.fieldWide}>
          {/* 수정·고정 상태에서는 선택란을 그리지 않는다. 위 `project` 주석 참고. */}
          {isEdit || fixedProject ? (
            <div className={ui.field}>
              <span className={ui.label}>프로젝트</span>
              <div className={ui.pickerSelected}>
                <span className={ui.pickerSelectedText}>
                  <span className={ui.pickerItemTitle}>{project?.title ?? '-'}</span>
                  {project?.subtitle ? (
                    <span className={ui.pickerItemSub}>{project.subtitle}</span>
                  ) : null}
                </span>
              </div>
            </div>
          ) : (
            <ProjectPicker
              value={project}
              onChange={(option) => {
                setDirty(true)
                setProject(option)
              }}
              required
              disabled={pending}
            />
          )}
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="job-name">
            작업명 <span className={ui.required}>*</span>
          </label>
          <input
            id="job-name"
            className={ui.input}
            value={form.jobName}
            onChange={(e) => set('jobName', e.target.value)}
            required
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="job-work">
            작업 종류
          </label>
          {/*
           * `sys_code` 에서 온다. 전에는 이 파일에 하드코딩된 `WORK_CODES` 를 썼고, 그 목록이
           * DB 의 코드 테이블과 어긋나면 고를 수는 있지만 저장은 23503 으로 거절되는 선택지가
           * 되었다 — `job.work_code` 가 `sys_code (code)` 를 참조하는 외래키다.
           */}
          <CodeSelect
            id="job-work"
            domain={CODE_DOMAIN.WORK}
            value={form.workCode}
            onChange={(v) => set('workCode', v)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="job-state">
            진행 상태
          </label>
          <select
            id="job-state"
            className={ui.select}
            value={form.jobState}
            onChange={(e) => set('jobState', e.target.value)}
          >
            <option value="">선택 없음</option>
            {codeOptions(JOB_STATES, form.jobState).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/*
         * 업무 구분. 아래 두 칸이 무엇이 될지를 이 값이 결정한다.
         *
         * 언어쌍 입력란 위에 두는 것은 순서 이상의 의미가 있다 — 담당자는 작업을 등록할 때 그것이
         * 번역인지 행사인지부터 알고 있고, 그걸 먼저 고르게 하면 쓰지 않을 칸을 보지 않는다.
         * MICE 작업을 출발어·도착어를 비워 둔 번역 작업으로 기록하던 것이 이 변경 전의 방식이었고,
         * 그렇게 들어간 행은 '담당자가 언어를 안 적은 번역 작업' 과 구별되지 않았다.
         */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="job-type">
            업무 구분
          </label>
          <CodeSelect
            id="job-type"
            domain={CODE_DOMAIN.JOBTYPE}
            value={form.jobType}
            onChange={(v) => set('jobType', v)}
          />
        </div>

        {/*
         * 언어쌍, 혹은 업무 분류. 둘 중 하나만 그린다.
         *
         * 언어쌍은 자유 입력이었고, 그래서 **어떤 값도 저장되지 않았다.** `job_slang`·`job_elang` 은
         * `sys_code (code)` 를 참조하는 언어 컬럼이다. 입력란에 "한국어" 라는 placeholder 를 띄워
         * 두고 그대로 받았으니, 코드 테이블이 비어 있던 동안에는 작업 등록 자체가 불가능했다.
         * 리포트의 언어쌍별 집계가 이 값으로 묶이므로 드롭다운이 된 것은 집계 품질에도 직접 영향이
         * 있다 — 자유 입력에서는 '영어' 와 '영어 ' 와 'English' 가 서로 다른 언어쌍이 된다.
         *
         * 어느 쪽도 필수가 아니다. 언어를 비워 둔 작업이 이미 수천 건 있고, 업무 분류를 아직 모르는
         * MICE 작업도 저장될 수 있어야 한다 — DB 의 제약은 "틀린 조합을 금지" 할 뿐 "값을 요구" 하지
         * 않는다(db/011_job_types.sql).
         */}
        {linguistic ? (
          <>
            <div className={ui.field}>
              <label className={ui.label} htmlFor="job-slang">
                출발어
              </label>
              <CodeSelect
                id="job-slang"
                domain={CODE_DOMAIN.LANG}
                value={form.jobSlang}
                onChange={(v) => set('jobSlang', v)}
              />
            </div>

            <div className={ui.field}>
              <label className={ui.label} htmlFor="job-elang">
                도착어
              </label>
              <CodeSelect
                id="job-elang"
                domain={CODE_DOMAIN.LANG}
                value={form.jobElang}
                onChange={(v) => set('jobElang', v)}
              />
            </div>
          </>
        ) : (
          <div className={ui.field}>
            <label className={ui.label} htmlFor="job-category">
              업무 분류
            </label>
            <CodeSelect
              id="job-category"
              domain={CODE_DOMAIN.JOBCAT}
              value={form.jobCategory}
              onChange={(v) => set('jobCategory', v)}
            />
          </div>
        )}

        {/*
         * 물량·단위·단가·할인 — **언어 업무에만 그린다.**
         *
         * 네 칸 모두 `job_detail_linguistic` 의 컬럼이다(db/012_job_pricing.sql). MICE·IMC 작업은
         * 단어나 시간으로 팔지 않으므로 곱할 물량이 없고, 아래 합계 칸에 금액을 직접 넣는다.
         *
         * 레거시에서는 이 칸들을 숨길 수 없었기 때문에 비언어 작업도 물량 1 / 단가 = 전체 금액으로
         * 적어 넣었고, 그 행은 "1 단어 번역" 과 생긴 것이 같아졌다. 칸을 없애는 것이 그 관행을
         * 없애는 유일한 방법이다 — 비워 두라고 안내하는 것으로는 안 된다.
         */}
        {linguistic ? (
          <>
            <div className={ui.field}>
              <label className={ui.label} htmlFor="job-volume">
                물량
              </label>
              <div className={ui.inputRow}>
                <input
                  id="job-volume"
                  className={`${ui.input} ${ui.inputNum}`}
                  inputMode="decimal"
                  value={form.jobVolume}
                  onChange={(e) => set('jobVolume', e.target.value)}
                />
                {/* 가로로 붙는 자리라 설명을 그리지 않는다 — CodeSelect 의 `silent` 주석 참고. */}
                <CodeSelect
                  ariaLabel="단위"
                  domain={CODE_DOMAIN.UNIT}
                  value={form.unitCode}
                  onChange={(v) => set('unitCode', v)}
                  placeholder="단위"
                  silent
                />
              </div>
            </div>

            <div className={ui.field}>
              <label className={ui.label} htmlFor="job-price">
                단가
              </label>
              <input
                id="job-price"
                className={`${ui.input} ${ui.inputNum}`}
                inputMode="decimal"
                value={form.jobPrice}
                onChange={(e) => set('jobPrice', e.target.value)}
              />
            </div>

            <div className={ui.field}>
              <label className={ui.label} htmlFor="job-dis">
                할인
              </label>
              <input
                id="job-dis"
                className={`${ui.input} ${ui.inputNum}`}
                inputMode="decimal"
                value={form.jobPriceDis}
                onChange={(e) => set('jobPriceDis', e.target.value)}
              />
              <span className={ui.hint}>합계에서 빼는 금액입니다.</span>
            </div>
          </>
        ) : null}

        <div className={ui.field}>
          <label className={ui.label} htmlFor="job-coin">
            통화
          </label>
          <select
            id="job-coin"
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
        </div>

        {/*
         * 환율 칸이 있던 자리. 이제 **상태를 보여 주고, 할 수 있는 동작을 준다.**
         *
         * 세 모습이 파일 머리말의 세 경우와 일대일로 대응한다. 원화면 할 것이 없고, 정산된
         * 외화면 박힌 환율을 읽기만 하고, 미정산 외화면 환산 버튼이 나온다.
         */}
        <div className={ui.field}>
          <span className={ui.label}>환율</span>
          {isKrw ? (
            <span className={ui.hint}>원화 금액입니다. 환산할 것이 없습니다.</span>
          ) : settled ? (
            <>
              <output className={ui.hint} htmlFor="job-coin">
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
              {/*
               * 누를 수 없을 때 **왜 없는지**를 쓴다. 이유가 셋이고 전부 오류가 아니다 —
               * 시세를 읽는 중, 수집기가 아직 그 통화를 받아 오지 못함, 환산할 금액이 없음.
               * "환산할 수 없습니다" 한 줄로 뭉치면 담당자는 셋 중 무엇인지 알 수 없고,
               * 그중 둘은 기다리면 해결되는 것인데 고장으로 보고된다.
               */}
              <span className={fx.canConvert ? ui.hint : ui.hintWarn}>
                {fx.isLoading
                  ? '시세를 읽고 있습니다…'
                  : !fx.canConvert
                    ? `${coin} 시세가 아직 수집되지 않아 환산할 수 없습니다. 금액은 ${coin} 기준으로 그대로 저장됩니다.`
                    : toDecimalInput(form.jobPriceSum) === null
                      ? '환산할 합계를 먼저 입력하세요.'
                      : `현 시세 1 ${coin} = ${formatMoney(fx.rate)} KRW 기준`}
              </span>
            </>
          )}
        </div>

        {/*
         * 합계. 언어 업무에서는 계산 결과이고, 비언어 업무에서는 **출발점**이다.
         *
         * 그래서 비언어일 때는 `setSumEdited(true)` 를 부르지 않는다. 그 플래그의 뜻은 "계산된
         * 합계를 사람이 덮어썼다" 인데, 여기서는 덮어쓸 계산값이 애초에 없다. 불러 버리면 금액을
         * 먼저 넣고 환율을 나중에 넣는 흔한 순서에서 원화 환산이 멈춘다 — 그 상태로 저장하면
         * 리포트가 읽는 매출만 빈 값으로 남는다.
         */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="job-sum">
            합계 ({form.coinCode || '외화'})
          </label>
          <input
            id="job-sum"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            readOnly={form.jobType === JOB_TYPE_LINGUISTIC}
            value={form.jobPriceSum}
            onChange={(e) => {
              if (linguistic) setSumEdited(true)
              set('jobPriceSum', e.target.value)
            }}
          />
          {linguistic ? null : (
            <span className={ui.hint}>
              물량·단가 없이 전체 금액을 직접 넣습니다. 원화 환산 합계는 환율을 곱해 따라옵니다.
            </span>
          )}
        </div>

        {/*
         * 원화 환산 합계. **읽기 전용이다** — 타이핑하던 칸이었다.
         *
         * 이 값이 리포트의 매출이고, 폼이 보내는 금액 중 유일하게 사람이 적지 않는 값이다.
         * 입력란으로 두면 통화·환율과 무관한 숫자가 들어갈 수 있었고, 그렇게 들어간 행은
         * 어느 화면에서도 틀려 보이지 않았다 — 합계와 환율은 그대로니까.
         *
         * 서식을 입혀 보여 준다(`formatMoney`). 입력란이 아니므로 타이핑 중인 글자를 고칠 걱정이
         * 없고, 천 단위 구분이 있는 쪽이 자리수를 눈으로 셀 수 있다.
         */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="job-ksum">
            원화 환산 합계 = 매출
          </label>
          <input
            id="job-ksum"
            className={`${ui.input} ${ui.inputNum}`}
            value={formatMoney(ksum)}
            readOnly
          />
          <span className={ui.hint}>
            리포트의 매출은 이 값의 합입니다.
            {settled ? null : effectiveRate === null ? null : (
              <>
                {' '}
                합계 × {formatMoney(effectiveRate)}
                {fx.effectiveDate ? ` (${formatDate(fx.effectiveDate)} 기준)` : ''}
              </>
            )}
          </span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="job-sday">
            시작일
          </label>
          <div className={ui.inputRow}>
            <input
              id="job-sday"
              className={ui.input}
              type="date"
              value={form.jobSday}
              onChange={(e) => set('jobSday', e.target.value)}
            />
            <input
              className={ui.input}
              type="time"
              aria-label="시작 시각"
              value={form.jobSdayTime}
              onChange={(e) => set('jobSdayTime', e.target.value)}
            />
          </div>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="job-eday">
            납기
          </label>
          <div className={ui.inputRow}>
            <input
              id="job-eday"
              className={ui.input}
              type="date"
              value={form.jobEday}
              onChange={(e) => set('jobEday', e.target.value)}
            />
            <input
              className={ui.input}
              type="time"
              aria-label="납기 시각"
              value={form.jobEdayTime}
              onChange={(e) => set('jobEdayTime', e.target.value)}
            />
          </div>
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="job-memo">
            메모
          </label>
          <textarea
            id="job-memo"
            className={ui.textarea}
            rows={2}
            value={form.jobMemo}
            onChange={(e) => set('jobMemo', e.target.value)}
          />
        </div>
      </div>

      {/*
       * 미정산 외화라는 사실을 저장 전에 말한다.
       *
       * 담당자가 보고 있는 원화 금액은 **지금 시세로 계산된 값**이고, 다음 주에 같은 작업을 열면
       * 다른 숫자가 보인다. 그걸 말하지 않으면 그 차이가 버그로 보고된다 — 아무도 금액을 고치지
       * 않았는데 금액이 달라졌으니, 그렇게 보이는 것이 당연하다.
       *
       * 고정하고 싶으면 방법도 같은 화면에 있다: 위 환산 버튼이 그 동작이다.
       */}
      {!settled && effectiveRate !== null ? (
        <InfoNotice>
          표시된 원화 환산 값은 현 시점의 환율이 적용된 값이며, 추후 환율에 따라 변동이 생길 수
          있습니다. 금액을 고정하려면 <strong>원화로 환산</strong>을 누르세요.
        </InfoNotice>
      ) : null}

      {/*
       * 계산값과 입력값이 다르면 그 사실을 말한다.
       *
       * 조용히 두면 두 가지 실수가 똑같이 보인다 — 의도한 조정과 오타. 조정은 정당하므로 막지
       * 않고, 대신 계산값을 함께 보여 주고 되돌릴 버튼을 준다.
       */}
      {differs ? (
        <InfoNotice>
          입력한 합계가 <strong>물량 × 단가 − 할인</strong> 계산값({formatMoney(suggestedSum)}{' '}
          {form.coinCode})과 다릅니다. 의도한 조정이면 그대로 저장하세요.{' '}
          <button type="button" className={ui.btnLink} onClick={applySuggestion}>
            계산값으로 되돌리기
          </button>
        </InfoNotice>
      ) : null}
    </Modal>
  )
}
