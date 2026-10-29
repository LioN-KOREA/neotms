import { useMemo, useState } from 'react'
import { useTranslators } from '@/apis/queries/neotms.query'
import type { TranslatorRow } from '@/apis/neotms.types'
import { RecordPicker, type PickerOption } from '@/shared/ui/RecordPicker'

/**
 * 번역가 한 건을 `PickerOption` 으로.
 *
 * 부제에 사용 프로그램·정산 통화를 넣는다. 발주 원가의 통화는 번역가의 정산 통화를 따르므로, 고르는
 * 순간 그 값이 보여야 환율 칸을 채울 때 당황하지 않는다. 불가 분야까지 여기 넣지는 않는다 —
 * 길어지면 읽히지 않고, 그 정보는 번역가 목록 화면이 표로 보여 준다.
 */
export function translatorOption(row: TranslatorRow): PickerOption {
  return {
    id: row.id,
    title: row.tranName || row.tranCode,
    subtitle: [row.tranCode, row.tranUpro, row.tranCoin].filter(Boolean).join(' · '),
  }
}

interface Props {
  value: PickerOption | null
  onChange: (option: PickerOption | null) => void
  required?: boolean
  disabled?: boolean
}

const PICK_LIMIT = 20

/** 번역가를 검색해서 고른다. 동작 규칙은 `CustomerPicker` 와 같다. */
export function TranslatorPicker({ value, onChange, required = false, disabled = false }: Props) {
  const [keyword, setKeyword] = useState('')
  const [submitted, setSubmitted] = useState('')

  const translatorsQuery = useTranslators(
    { limit: PICK_LIMIT, q: submitted || undefined },
    submitted.trim().length > 0 && !value,
  )

  const options = useMemo(
    () => (translatorsQuery.data?.pages.flatMap((p) => p.items) ?? []).map(translatorOption),
    [translatorsQuery.data],
  )

  return (
    <RecordPicker
      id="po-translator"
      label="번역가"
      required={required}
      disabled={disabled}
      selected={value}
      options={options}
      isLoading={translatorsQuery.isLoading}
      error={translatorsQuery.error}
      keyword={keyword}
      onKeywordChange={setKeyword}
      onSearch={() => setSubmitted(keyword.trim())}
      onSelect={(option) => {
        onChange(option)
        if (!option) setSubmitted('')
      }}
      placeholder="번역가명 · 코드 · 이메일"
      hint={
        submitted && !value && options.length === 0 && !translatorsQuery.isLoading
          ? `'${submitted}' 로 찾은 번역가가 없습니다. 번역가 화면에서 먼저 등록해 주세요.`
          : undefined
      }
    />
  )
}
