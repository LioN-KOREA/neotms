import { useState } from 'react'
import { useCreateJob, useUpdateJob } from '@/apis/queries/neotms.mutation'
import { CODE_DOMAIN, codeOptions, COIN_CODES, JOB_STATES } from '@/apis/neotms.codes'
import type { JobInput, JobRow, JobUpdate } from '@/apis/neotms.types'
import { CodeSelect } from '@/shared/ui/CodeSelect'
import { ErrorNotice, InfoNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import type { PickerOption } from '@/shared/ui/RecordPicker'
import { toDateInputValue } from '@/shared/utils/format'
import {
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
 * ## 환율은 거래 시점의 값이다
 *
 * `coinRate` 를 오늘 환율로 자동 채우지 않는다. 작년 발주의 원화 환산액이 오늘 환율로 바뀌면
 * 이미 끝난 정산이 흔들린다. 레거시의 환율 자동 조회는 깨진 상태로 방치되어 있었고, 그 기능을
 * 되살리는 것은 MVP 범위가 아니다.
 */
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
    jobSlang: job?.jobSlang ?? '',
    jobElang: job?.jobElang ?? '',
    jobVolume: job?.jobVolume ?? '',
    unitCode: job?.unitCode ?? '단어',
    jobPrice: job?.jobPrice ?? '',
    jobPriceDis: job?.jobPriceDis ?? '',
    coinCode: job?.coinCode ?? 'KRW',
    coinRate: job?.coinRate ?? '1',
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

  /** 물량·단가·할인으로 외화 합계를, 거기에 환율을 곱해 원화 합계를 만든다. */
  const compute = (volume: string, price: string, discount: string, rate: string) => {
    const sum = decimalSubtract(decimalMultiply(volume, price), discount)
    // 할인이 비어 있으면 `decimalSubtract` 가 곱셈 결과를 그대로 돌려준다(money.ts).
    const ksum = sum === null ? null : decimalMultiply(sum, rate)
    return { sum, ksum }
  }

  const suggestion = compute(form.jobVolume, form.jobPrice, form.jobPriceDis, form.coinRate)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setDirty(true)
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      /*
       * 합계를 아직 손대지 않았다면 자동으로 따라오게 한다.
       *
       * `useEffect` 로 하지 않는다. 이펙트로 만들면 렌더가 한 번 더 돌고, 그 사이 상태에서
       * 사용자가 타이핑하면 입력이 되돌아가는 종류의 버그가 생긴다. 계산은 원인이 되는
       * 입력이 바뀌는 그 자리에서 한 번만 하면 된다.
       */
      if (!sumEdited && ['jobVolume', 'jobPrice', 'jobPriceDis', 'coinRate'].includes(key)) {
        const { sum, ksum } = compute(next.jobVolume, next.jobPrice, next.jobPriceDis, next.coinRate)
        next.jobPriceSum = sum ?? ''
        next.jobPriceKsum = ksum ?? ''
      }
      return next
    })
  }

  /** 자동 계산으로 되돌린다. 직접 고친 뒤 "원래 값이 뭐였지" 가 되는 경우가 실제로 많다. */
  const applySuggestion = () => {
    setDirty(true)
    setSumEdited(false)
    setForm((prev) => ({
      ...prev,
      jobPriceSum: suggestion.sum ?? '',
      jobPriceKsum: suggestion.ksum ?? '',
    }))
  }

  const name = form.jobName.trim()
  const canSave = name.length > 0 && !!project && !pending

  const onSubmit = async () => {
    if (!project || name.length === 0) return

    const common: JobUpdate = {
      jobName: name,
      workCode: form.workCode.trim() || null,
      jobSlang: form.jobSlang.trim() || null,
      jobElang: form.jobElang.trim() || null,
      jobVolume: toDecimalInput(form.jobVolume),
      unitCode: form.unitCode.trim() || null,
      jobPrice: toDecimalInput(form.jobPrice),
      jobPriceDis: toDecimalInput(form.jobPriceDis),
      coinCode: form.coinCode.trim() || null,
      coinRate: toDecimalInput(form.coinRate),
      jobPriceSum: toDecimalInput(form.jobPriceSum),
      jobPriceKsum: toDecimalInput(form.jobPriceKsum),
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

  /** 입력한 합계가 계산값과 다른지. 다르면 그 사실을 숨기지 않고 보여 준다. */
  const differs =
    suggestion.sum !== null &&
    toDecimalInput(form.jobPriceSum) !== null &&
    decimalSubtract(toDecimalInput(form.jobPriceSum), suggestion.sum) !== '0.00'

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
         * 언어쌍. 자유 입력이었고, 그래서 **어떤 값도 저장되지 않았다.**
         *
         * `job_slang`·`job_elang` 은 `sys_code (code)` 를 참조하는 8개 언어 컬럼 중 둘이다.
         * 입력란에 "한국어" 라는 placeholder 를 띄워 두고 그대로 받았으니, 코드 테이블이 비어
         * 있던 동안에는 작업 등록 자체가 불가능했다. 리포트의 언어쌍별 집계가 이 값으로
         * 묶이므로, 드롭다운이 된 것은 집계 품질에도 직접 영향이 있다 — 자유 입력에서는
         * '영어' 와 '영어 ' 와 'English' 가 서로 다른 언어쌍이 된다.
         */}
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

        <div className={ui.field}>
          <label className={ui.label} htmlFor="job-rate">
            적용 환율
          </label>
          <input
            id="job-rate"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.coinRate}
            onChange={(e) => set('coinRate', e.target.value)}
          />
          <span className={ui.hint}>원화는 1 입니다. 거래 시점의 환율을 그대로 보관합니다.</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="job-sum">
            합계 ({form.coinCode || '외화'})
          </label>
          <input
            id="job-sum"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.jobPriceSum}
            onChange={(e) => {
              setSumEdited(true)
              set('jobPriceSum', e.target.value)
            }}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="job-ksum">
            원화 환산 합계 = 매출
          </label>
          <input
            id="job-ksum"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.jobPriceKsum}
            onChange={(e) => {
              setSumEdited(true)
              set('jobPriceKsum', e.target.value)
            }}
          />
          <span className={ui.hint}>리포트의 매출은 이 값의 합입니다.</span>
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
       * 계산값과 입력값이 다르면 그 사실을 말한다.
       *
       * 조용히 두면 두 가지 실수가 똑같이 보인다 — 의도한 조정과 오타. 조정은 정당하므로 막지
       * 않고, 대신 계산값을 함께 보여 주고 되돌릴 버튼을 준다.
       */}
      {differs ? (
        <InfoNotice>
          입력한 합계가 <strong>물량 × 단가 − 할인</strong> 계산값(
          {formatMoney(suggestion.sum)} {form.coinCode})과 다릅니다. 의도한 조정이면 그대로
          저장하세요.{' '}
          <button type="button" className={ui.btnLink} onClick={applySuggestion}>
            계산값으로 되돌리기
          </button>
        </InfoNotice>
      ) : null}
    </Modal>
  )
}
