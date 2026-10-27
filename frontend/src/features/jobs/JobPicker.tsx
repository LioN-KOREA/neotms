import { useMemo, useState } from 'react'
import { useJobs } from '@/apis/queries/neotms.query'
import type { JobRow } from '@/apis/neotms.types'
import { RecordPicker, type PickerOption } from '@/shared/ui/RecordPicker'

/**
 * 작업 한 건을 `PickerOption` 으로.
 *
 * 부제에 프로젝트와 고객사를 넣는다. 발주를 어느 작업에 달지 고르는 자리이고, 잘못 고르면
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
}

const PICK_LIMIT = 20

/** 작업을 검색해서 고른다. 동작 규칙은 `CustomerPicker` 와 같다. */
export function JobPicker({ value, onChange, required = false, disabled = false }: Props) {
  const [keyword, setKeyword] = useState('')
  const [submitted, setSubmitted] = useState('')

  const jobsQuery = useJobs(
    { limit: PICK_LIMIT, q: submitted || undefined },
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
      placeholder="작업명 · 코드 · 프로젝트"
      hint={
        submitted && !value && options.length === 0 && !jobsQuery.isLoading
          ? `'${submitted}' 로 찾은 작업이 없습니다. 발주는 작업에 달립니다 — 작업을 먼저 등록해 주세요.`
          : undefined
      }
    />
  )
}
