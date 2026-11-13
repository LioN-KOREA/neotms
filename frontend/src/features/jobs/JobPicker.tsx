import { useMemo, useState } from 'react'
import { useJobs } from '@/apis/queries/neotms.query'
import type { JobRow } from '@/apis/neotms.types'
import { RecordPicker, type PickerOption } from '@/shared/ui/RecordPicker'

/**
 * 작업 한 건을 `PickerOption` 으로.
 *
 * 부제에 프로젝트와 고객사를 넣는다. PO 를 어느 작업에 달지 고르는 자리이고, 잘못 고르면
 * **원가가 다른 작업의 매출에 붙는다** — 두 작업 모두 마진이 틀리고, 틀렸다는 사실은 어느
 * 화면에도 표시되지 않는다. 작업명만으로는 '번역' 처럼 같은 이름이 흔하므로 맥락이 필요하다.
 */
export function jobOption(row: JobRow): PickerOption {
  return {
    id: row.id,
    title: row.jobName || row.jobCode,
    subtitle: [row.jobCode, row.prjName, row.cusCodeName].filter(Boolean).join(' · '),
  }
}

interface Props {
  value: PickerOption | null
  onChange: (option: PickerOption | null) => void
  required?: boolean
  disabled?: boolean
  /**
   * 이 프로젝트의 작업만 찾는다. 프로젝트 상세에서 PO 를 등록할 때 쓴다 — 아래 주석 참고.
   */
  projectId?: string | null
}

const PICK_LIMIT = 20

/**
 * 작업을 검색해서 고른다. 동작 규칙은 `CustomerPicker` 와 같다.
 *
 * ## `projectId` 를 주면 그 프로젝트 안에서만 찾는다
 *
 * 전체 작업을 검색하는 것이 기본값인 이유는, PO 목록 화면에서 PO 를 등록할 때는 어느 프로젝트의
 * 작업인지가 아직 정해지지 않았기 때문이다.
 *
 * 하지만 **프로젝트 상세에서 열었다면 정해져 있다.** 거기서 전체를 검색하게 두면 '번역' 같은
 * 흔한 작업명으로 다른 프로젝트의 작업이 결과에 섞이고, 고르는 사람은 지금 보고 있는 화면이
 * 그 프로젝트의 것이므로 결과도 그렇다고 읽는다. 잘못 고르면 **이 프로젝트의 원가가 다른
 * 프로젝트의 매출에 붙고**, 두 프로젝트의 마진이 동시에 틀리면서 어느 화면도 틀렸다고 말해 주지
 * 않는다(위 `jobOption` 주석의 같은 사고다 — 부제에 프로젝트명을 넣는 것만으로는 막지 못한다).
 *
 * 걸러 내는 일은 서버가 한다(`projectId` 필터). 받아서 화면에서 거르면 상한 20건이 **거르기
 * 전의** 20건이므로, 다른 프로젝트의 작업이 그 자리를 차지해 찾는 작업이 결과에서 빠진다.
 */
export function JobPicker({
  value,
  onChange,
  required = false,
  disabled = false,
  projectId = null,
}: Props) {
  const [keyword, setKeyword] = useState('')
  const [submitted, setSubmitted] = useState('')

  const jobsQuery = useJobs(
    { limit: PICK_LIMIT, q: submitted || undefined, projectId: projectId || undefined },
    submitted.trim().length > 0 && !value,
  )

  const options = useMemo(
    () => (jobsQuery.data?.pages.flatMap((p) => p.items) ?? []).map(jobOption),
    [jobsQuery.data],
  )

  return (
    <RecordPicker
      id="po-job"
      label="작업"
      required={required}
      disabled={disabled}
      selected={value}
      options={options}
      isLoading={jobsQuery.isLoading}
      error={jobsQuery.error}
      keyword={keyword}
      onKeywordChange={setKeyword}
      onSearch={() => setSubmitted(keyword.trim())}
      onSelect={(option) => {
        onChange(option)
        if (!option) setSubmitted('')
      }}
      placeholder={projectId ? '작업명 · 코드' : '작업명 · 코드 · 프로젝트'}
      hint={
        submitted && !value && options.length === 0 && !jobsQuery.isLoading
          ? projectId
            ? /*
               * 범위를 밝힌다. 밝히지 않으면 "작업이 없습니다" 가 전체에 없다는 뜻으로 읽히고,
               * 담당자는 있는 작업을 다시 등록한다.
               */
              `이 프로젝트에 '${submitted}' 로 찾은 작업이 없습니다. PO 는 작업에 달립니다 — 작업을 먼저 등록해 주세요.`
            : `'${submitted}' 로 찾은 작업이 없습니다. PO 는 작업에 달립니다 — 작업을 먼저 등록해 주세요.`
          : undefined
      }
    />
  )
}
