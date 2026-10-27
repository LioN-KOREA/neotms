import type { KeyboardEvent } from 'react'
import { describeError } from '@/shared/utils/errors'
import ui from './ui.module.css'

/** 고른 결과 한 줄. `subtitle` 은 동명이인·동명 회사를 구분하는 보조 정보다. */
export interface PickerOption {
  id: string
  title: string
  subtitle?: string | null
}

interface Props {
  /** `<label htmlFor>` 와 입력란을 잇는다. 화면 안에서 유일해야 한다. */
  id: string
  label: string
  required?: boolean
  /** 이미 고른 값. null 이면 검색란을 보여 준다. */
  selected: PickerOption | null
  /** 검색 결과. `selected` 가 있으면 그리지 않는다. */
  options: readonly PickerOption[]
  isLoading: boolean
  error: unknown
  /** 검색 입력란의 값. 상위가 들고 있어야 쿼리 실행 시점을 통제할 수 있다. */
  keyword: string
  onKeywordChange: (value: string) => void
  /** '검색' 또는 Enter. 이때만 쿼리가 나간다. */
  onSearch: () => void
  onSelect: (option: PickerOption | null) => void
  placeholder?: string
  hint?: string
  disabled?: boolean
}

/**
 * 부모 레코드를 고르는 칸. 프로젝트의 고객사, 발주의 작업.
 *
 * ## `<select>` 가 아닌 이유
 *
 * 서버의 한 페이지 상한이 200행이다(NEOTMS_PAGE_SIZE_MAX). 고객사는 그보다 많고, 작업은 훨씬
 * 많다. 드롭다운으로 만들면 목록에 **없는 고객사가 생기고**, 사용자는 그 고객사가 등록되지
 * 않았다고 결론 내린 뒤 같은 고객사를 한 번 더 등록한다. 레거시의 중복 고객사 행들이 그렇게
 * 생겼다.
 *
 * 그래서 검색해서 고른다. 검색은 서버가 pg_bigm 으로 하므로 전체에서 찾고, 결과는 짧게 보여
 * 준다 — 긴 목록을 스크롤하는 것은 고르는 동작이 아니라 훑는 동작이다.
 *
 * ## 고른 뒤에는 검색란이 사라진다
 *
 * 고른 값과 검색란이 같이 보이면 "지금 무엇이 선택되어 있는가" 가 모호해진다. 바꾸려면 '변경'
 * 을 눌러 선택을 비우고 다시 검색한다 — 한 번에 하나의 상태만 보이게 하는 것이 목적이다.
 */
export function RecordPicker({
  id,
  label,
  required = false,
  selected,
  options,
  isLoading,
  error,
  keyword,
  onKeywordChange,
  onSearch,
  onSelect,
  placeholder,
  hint,
  disabled = false,
}: Props) {
  /*
   * Enter 를 폼 제출이 아니라 검색으로 쓴다.
   *
   * 이 컴포넌트는 등록 폼 안에 들어가므로, Enter 가 그대로 올라가면 검색 대신 **저장**이
   * 실행된다. 고객사를 고르려고 Enter 를 눌렀는데 프로젝트가 저장되는 동작이다.
   */
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    onSearch()
  }

  if (selected) {
    return (
      <div className={ui.field}>
        <span className={`${ui.label} ${required ? ui.required : ''}`}>{label}</span>
        <div className={ui.pickerSelected}>
          <span className={ui.pickerSelectedText}>
            <span className={ui.pickerItemTitle}>{selected.title}</span>
            {selected.subtitle ? (
              <span className={ui.pickerItemSub}>{selected.subtitle}</span>
            ) : null}
          </span>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
            onClick={() => onSelect(null)}
            disabled={disabled}
          >
            변경
          </button>
        </div>
        {hint ? <span className={ui.hint}>{hint}</span> : null}
      </div>
    )
  }

  return (
    <div className={ui.field}>
      <label className={`${ui.label} ${required ? ui.required : ''}`} htmlFor={id}>
        {label}
      </label>
      <div className={ui.toolbar}>
        <input
          id={id}
          className={ui.input}
          type="search"
          value={keyword}
          placeholder={placeholder}
          onChange={(e) => onKeywordChange(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
        />
        <button
          type="button"
          className={ui.btn}
          onClick={onSearch}
          disabled={disabled || keyword.trim().length === 0}
        >
          검색
        </button>
      </div>

      {error ? <span className={ui.hint}>{describeError(error)}</span> : null}
      {isLoading ? <span className={ui.hint}>찾는 중…</span> : null}

      {!isLoading && options.length > 0 ? (
        <div className={ui.pickerResults}>
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              className={ui.pickerItem}
              onClick={() => onSelect(o)}
              disabled={disabled}
            >
              <span className={ui.pickerItemTitle}>{o.title}</span>
              {o.subtitle ? <span className={ui.pickerItemSub}>{o.subtitle}</span> : null}
            </button>
          ))}
        </div>
      ) : null}

      {hint ? <span className={ui.hint}>{hint}</span> : null}
    </div>
  )
}
