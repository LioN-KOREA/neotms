import { useMemo, useState } from 'react'
import { useCustomers } from '@/apis/queries/neotms.query'
import type { CustomerRow } from '@/apis/neotms.types'
import { RecordPicker, type PickerOption } from '@/shared/ui/RecordPicker'

/** 고객사 한 건을 `PickerOption` 으로. 코드를 보조 정보로 붙인다 — 같은 이름의 법인이 둘 있다. */
export function customerOption(row: CustomerRow): PickerOption {
  return {
    id: row.id,
    title: row.cusName || row.cusCode,
    subtitle: [row.cusCode, row.cusNation, row.cusCoin].filter(Boolean).join(' · '),
  }
}

interface Props {
  value: PickerOption | null
  onChange: (option: PickerOption | null) => void
  required?: boolean
  disabled?: boolean
}

/** 몇 건을 보여 줄지. 고르는 화면이므로 짧아야 한다 — 길면 고르지 않고 훑기 시작한다. */
const PICK_LIMIT = 20

/**
 * 고객사를 검색해서 고른다.
 *
 * 검색어를 입력하는 동안에는 쿼리가 나가지 않는다. `submitted` 가 '검색' 을 누른 시점의 값이고,
 * 쿼리는 그 값에만 반응한다 — 한 글자마다 요청하면 "강"·"강원"·"강원도" 로 세 번 간다.
 *
 * 비활성 상태(`enabled`)를 검색어 유무로 정하는 것도 같은 이유다. 빈 검색어로 호출하면 서버는
 * 전체 목록의 첫 페이지를 주는데, 그건 사용자가 요청한 적 없는 조회다.
 */
export function CustomerPicker({ value, onChange, required = false, disabled = false }: Props) {
  const [keyword, setKeyword] = useState('')
  const [submitted, setSubmitted] = useState('')

  const customersQuery = useCustomers(
    { limit: PICK_LIMIT, q: submitted || undefined },
    submitted.trim().length > 0 && !value,
  )

  const options = useMemo(
    () => (customersQuery.data?.pages.flatMap((p) => p.items) ?? []).map(customerOption),
    [customersQuery.data],
  )

  return (
    <RecordPicker
      id="prj-customer"
      label="고객사"
      required={required}
      disabled={disabled}
      selected={value}
      options={options}
      isLoading={customersQuery.isLoading}
      error={customersQuery.error}
      keyword={keyword}
      onKeywordChange={setKeyword}
      onSearch={() => setSubmitted(keyword.trim())}
      onSelect={(option) => {
        onChange(option)
        // 선택을 비웠을 때 이전 검색 결과가 남아 있지 않게 한다.
        if (!option) setSubmitted('')
      }}
      placeholder="고객사명 또는 코드"
      hint={
        submitted && !value && options.length === 0 && !customersQuery.isLoading
          ? `'${submitted}' 로 찾은 고객사가 없습니다. 고객사 화면에서 먼저 등록해 주세요.`
          : undefined
      }
    />
  )
}
