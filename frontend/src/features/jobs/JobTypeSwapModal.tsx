import { useState } from 'react'
import { useUpdateJob } from '@/apis/queries/neotms.mutation'
import { CODE_DOMAIN, isLinguistic, unsetPlaceholder } from '@/apis/neotms.codes'
import type { JobRow, JobUpdate } from '@/apis/neotms.types'
import { CodeSelect } from '@/shared/ui/CodeSelect'
import { ErrorNotice, InfoNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'

/**
 * 한 작업의 업무 구분과, 그 구분이 가지는 값(언어쌍 또는 업무 분류)을 요약한 한 줄.
 *
 * 표의 '언어 페어 · 업무 분류' 칸이 쓴다. **두 화면이 같은 칸을 그리므로** 여기 있다 — 작업 목록과
 * 프로젝트 상세가 각각 같은 삼항 연산자를 들고 있었고, 그런 쌍은 한쪽만 고쳐지는 날이 온다.
 *
 * 비언어 작업에는 업무 구분까지 같이 적는다. 업무 분류만으로는 MICE 의 '행사운영' 인지 IMC 의
 * '행사운영' 인지 알 수 없고, 그 둘은 다른 사업이다.
 */
export function jobTypeSummary(
  job: Pick<JobRow, 'jobType' | 'jobSlang' | 'jobElang' | 'jobCategory'>,
  categoryName: (code: string | null | undefined) => string,
): string {
  if (isLinguistic(job.jobType)) {
    return [job.jobSlang, job.jobElang].filter(Boolean).join(' → ') || '-'
  }
  return [job.jobType, categoryName(job.jobCategory)].filter(Boolean).join(' · ') || '-'
}

interface Props {
  job: JobRow
  onClose: () => void
  onSaved: (message: string) => void
}

/**
 * 작업 한 건의 **업무 구분과 그에 딸린 값만** 바꾸는 대화상자.
 *
 * ## 왜 칸 안의 드롭다운이 아닌가
 *
 * 표의 그 칸은 값 하나가 아니다. 업무 구분이 'LINGUISTICS' 면 출발어와 도착어 **두 칸**을 들고
 * 있고, 아니면 업무 분류 한 칸을 들고 있다 — 즉 고쳐야 하는 칸의 개수와 종류가 지금 값에 따라
 * 달라진다. 드롭다운 하나로는 표현할 수 없고, 칸 안에 세 개를 집어넣으면 행 높이가 세 배가 된다
 * (`InlinePickerCell` 머리말이 번역가 칸에 대해 적은 것과 같은 사정이다).
 *
 * 더 중요한 이유는 아래 경고다. 이 수정에는 **되돌릴 수 없는 부작용**이 있고, 고르는 즉시
 * 저장되는 칸에는 경고를 띄울 자리가 없다.
 *
 * ## 언어 작업에서 떠나면 물량·단가가 사라진다
 *
 * 물량·단위·단가·할인은 `job_detail_linguistic` 의 컬럼이다(db/012_job_pricing.sql). 업무 구분을
 * 비언어로 바꾸면 서버가 그 상세 행을 지우므로(`JobDetailClearOps`) 네 값이 **함께 지워지고, 이
 * 작업의 매출이 0 이 된다.** 그게 맞는 동작이다 — MICE 작업은 단어 단위로 팔지 않는다 — 하지만
 * 표의 칸을 두 번 눌러 실수로 일어날 일은 아니다. 그래서 저장 전에 적어 둔다.
 *
 * ## 구분이 바뀌면 바뀌지 않은 값도 함께 보낸다
 *
 * 이 파일에서 가장 틀리기 쉬운 부분이다. 서버는 구분이 바뀔 때 **떠나는 쪽 상세 행을 지운다.**
 * MICE 와 IMC 는 둘 다 `job_detail_non_linguistic` 을 쓰므로(그래서 지우는 대상이 "다른 테이블"
 * 이 아니라 "떠나는 구분의 테이블" 이다), MICE → IMC 에서 `{ jobType }` 만 보내면 행이 지워진
 * 다음 다시 쓸 값이 본문에 없어 **업무 분류가 조용히 사라진다.**
 *
 * 그래서 규칙이 둘이다. 구분이 바뀌었으면 그 구분이 쓰는 값을 **전부** 보낸다. 바뀌지 않았으면
 * 달라진 값만 보낸다(`InlineEditCell` 머리말의 "본문에는 바뀐 필드만").
 */
export function JobTypeSwapModal({ job, onClose, onSaved }: Props) {
  const updateJob = useUpdateJob()

  const [type, setType] = useState(job.jobType ?? '')
  const [slang, setSlang] = useState(job.jobSlang ?? '')
  const [elang, setElang] = useState(job.jobElang ?? '')
  const [category, setCategory] = useState(job.jobCategory ?? '')

  const linguistic = isLinguistic(type)
  const wasLinguistic = isLinguistic(job.jobType)
  const typeChanged = (type.trim() || null) !== (job.jobType?.trim() || null)

  /*
   * 언어 작업에서 떠나면서 값이 든 가격 칸이 있는가. 경고를 **조건부로** 띄우는 이유는, 모든
   * 구분 변경에 대해 띄우면 비어 있는 작업에서도 뜨고 그러면 아무도 읽지 않는다.
   */
  const losesPricing =
    wasLinguistic && !linguistic && Boolean(job.jobVolume || job.jobPrice || job.jobPriceDis)

  const changed =
    typeChanged ||
    (linguistic
      ? (slang.trim() || null) !== (job.jobSlang?.trim() || null) ||
        (elang.trim() || null) !== (job.jobElang?.trim() || null)
      : (category.trim() || null) !== (job.jobCategory?.trim() || null))

  const canSave = changed && !updateJob.isPending

  const onSubmit = async () => {
    if (!canSave) return

    /*
     * 본문을 짠다. 위 머리말의 마지막 문단이 이 열 줄의 이유다 — 구분이 바뀌었으면 값이
     * 그대로여도 함께 보내야 하고, 빈 문자열이 아니라 `null` 로 보내야 한다(`date`·`text` 컬럼이
     * 빈 문자열을 '값 없음' 으로 받지 않는다. db/011 의 `NULLIF` 와 같은 정규화다).
     */
    const input: JobUpdate = { jobName : job.jobName ?? "" }
    if (typeChanged) input.jobType = type.trim() || null
    if (linguistic) {
      if (typeChanged || (slang.trim() || null) !== (job.jobSlang?.trim() || null)) {
        input.jobSlang = slang.trim() || null
      }
      if (typeChanged || (elang.trim() || null) !== (job.jobElang?.trim() || null)) {
        input.jobElang = elang.trim() || null
      }
    } else if (typeChanged || (category.trim() || null) !== (job.jobCategory?.trim() || null)) {
      input.jobCategory = category.trim() || null
    }

    await updateJob.mutateAsync({ id: job.id, input })
    onSaved(`작업 [${job.jobName || job.jobCode}] 의 업무 구분을 바꿨습니다.`)
    onClose()
  }

  return (
    <Modal
      title="업무 구분 변경"
      onClose={onClose}
      isDirty={canSave}
      width={520}
      footer={
        <>
          <button
            type="button"
            className={ui.btn}
            onClick={onClose}
            disabled={updateJob.isPending}
          >
            취소
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void onSubmit()}
            disabled={!canSave}
          >
            {updateJob.isPending ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      <ErrorNotice error={updateJob.error} />

      <p className={ui.hint}>
        작업 <strong>{job.jobCode}</strong> — 업무 구분과 그에 딸린 값만 바뀝니다. 작업명·납기·상태는
        그대로입니다.
      </p>

      <div className={ui.field}>
        <label className={ui.label} htmlFor="jts-type">
          업무 구분
        </label>
        {/*
         * '지정 없음' 을 두지 않는다(`placeholder={null}`). 서버에서 `job.job_type` 은
         * NOT NULL DEFAULT 'LINGUISTICS' 이므로 비어 있는 구분이라는 상태가 존재하지 않고,
         * 항목을 남기면 그걸 고른 사람이 "구분을 지웠다" 고 믿게 된다.
         */}
        <CodeSelect
          id="jts-type"
          domain={CODE_DOMAIN.JOBTYPE}
          value={type}
          onChange={setType}
          placeholder={null}
          disabled={updateJob.isPending}
        />
      </div>

      {/*
       * 쓰지 않는 칸은 **그리지 않는다.** 비활성으로 남겨 두면 MICE 작업의 화면에 영구히 비어
       * 있는 출발어 칸이 생기고, 그건 "아직 안 적었다" 로 읽힌다 — 이 작업에는 적을 것이 없다는
       * 사실과 반대다. 서식(`JobFormModal`)도 같은 판단이다.
       */}
      {linguistic ? (
        <div className={ui.datePair}>
          <div className={ui.field}>
            <label className={ui.label} htmlFor="jts-slang">
              출발어
            </label>
            <CodeSelect
              id="jts-slang"
              domain={CODE_DOMAIN.LANG}
              value={slang}
              onChange={setSlang}
              placeholder={unsetPlaceholder(true, job.jobSlang)}
              disabled={updateJob.isPending}
            />
          </div>
          <div className={ui.field}>
            <label className={ui.label} htmlFor="jts-elang">
              도착어
            </label>
            <CodeSelect
              id="jts-elang"
              domain={CODE_DOMAIN.LANG}
              value={elang}
              onChange={setElang}
              placeholder={unsetPlaceholder(true, job.jobElang)}
              disabled={updateJob.isPending}
            />
          </div>
        </div>
      ) : (
        <div className={ui.field}>
          <label className={ui.label} htmlFor="jts-category">
            업무 분류
          </label>
          {/*
           * 비언어 작업에도 업무 분류는 **필수가 아니다**(db/011 의 "금지하되 요구하지 않는다").
           * 그래서 이미 비어 있으면 '지정 없음' 항목이 남는다.
           */}
          <CodeSelect
            id="jts-category"
            domain={CODE_DOMAIN.JOBCAT}
            value={category}
            onChange={setCategory}
            placeholder={unsetPlaceholder(true, job.jobCategory)}
            disabled={updateJob.isPending}
          />
        </div>
      )}

      {/* 머리말의 "언어 작업에서 떠나면 물량·단가가 사라진다" 가 실제로 걸리는 경우. */}
      {losesPricing ? (
        <InfoNotice>
          이 작업의 <strong>물량·단가·할인</strong>은 언어 작업에만 있는 값입니다. 업무 구분을{' '}
          <strong>{type}</strong> 로 바꾸면 세 값이 함께 지워지고 이 작업의 매출이 0 이 됩니다.
          비언어 작업의 금액을 적는 방법은 아직 정해지지 않았습니다.
        </InfoNotice>
      ) : null}

      {/* 반대 방향. 지워지는 것이 분류 한 칸이므로 경고의 무게가 다르다. */}
      {typeChanged && !wasLinguistic && linguistic && job.jobCategory ? (
        <InfoNotice>
          업무 분류 <strong>{job.jobCategory}</strong> 는 비언어 작업에만 있는 값이므로 함께
          지워집니다.
        </InfoNotice>
      ) : null}
    </Modal>
  )
}
