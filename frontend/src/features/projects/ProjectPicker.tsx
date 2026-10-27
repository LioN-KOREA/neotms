import { useMemo, useState } from 'react'
import { useProjects } from '@/apis/queries/neotms.query'
import type { ProjectRow } from '@/apis/neotms.types'
import { RecordPicker, type PickerOption } from '@/shared/ui/RecordPicker'

/**
 * 프로젝트 한 건을 `PickerOption` 으로.
 *
 * 부제에 고객사와 상태를 함께 넣는다. 프로젝트명은 고객사가 정해서 보내 주는 문서 제목인 경우가
 * 많아 **여러 고객사에 같은 이름이 존재한다**("2026년 1분기 매뉴얼"). 고객사가 없으면 어느 쪽을
 * 골라야 하는지 알 수 없다.
 */
export function projectOption(row: ProjectRow): PickerOption {
  return {
    id: row.id,
    title: row.prjName || row.prjCode,
    subtitle: [row.prjCode, row.cusCodeName, row.prjState].filter(Boolean).join(' · '),
  }
}

interface Props {
  value: PickerOption | null
  onChange: (option: PickerOption | null) => void
  required?: boolean
  disabled?: boolean
  label?: string
}

const PICK_LIMIT = 20

/**
 * 프로젝트를 검색해서 고른다. 동작 규칙은 `CustomerPicker` 와 같다 — 쿼리는 '검색' 을 누른
 * 시점에만 나가고, 빈 검색어로는 나가지 않는다.
 */
export function ProjectPicker({
  value,
  onChange,
  required = false,
  disabled = false,
  label = '프로젝트',
}: Props) {
  const [keyword, setKeyword] = useState('')
  const [submitted, setSubmitted] = useState('')

  const projectsQuery = useProjects(
    { limit: PICK_LIMIT, q: submitted || undefined },
    submitted.trim().length > 0 && !value,
  )

  const options = useMemo(
    () => (projectsQuery.data?.pages.flatMap((p) => p.items) ?? []).map(projectOption),
    [projectsQuery.data],
  )

  return (
    <RecordPicker
      id="job-project"
      label={label}
      required={required}
      disabled={disabled}
      selected={value}
      options={options}
      isLoading={projectsQuery.isLoading}
      error={projectsQuery.error}
      keyword={keyword}
      onKeywordChange={setKeyword}
      onSearch={() => setSubmitted(keyword.trim())}
      onSelect={(option) => {
        onChange(option)
        if (!option) setSubmitted('')
      }}
      placeholder="프로젝트명 · 코드 · 고객사"
      hint={
        submitted && !value && options.length === 0 && !projectsQuery.isLoading
          ? `'${submitted}' 로 찾은 프로젝트가 없습니다.`
          : undefined
      }
    />
  )
}
