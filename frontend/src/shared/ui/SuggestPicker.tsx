import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { PickerOption } from './RecordPicker'
import ui from './ui.module.css'

/**
 * 입력하면서 고르는 칸 (팀장님 2026-11-25 — 프로젝트 창의 고객사·총괄PM·영업담당).
 *
 * - 평소에는 한 줄 입력칸. 누르거나 글자를 치면 **바로 아래에 추천 목록이 겹쳐 뜬다** — 다른
 *   칸의 배치는 움직이지 않는다 (`position: fixed`, 모달 스크롤 상자에 잘리지도 않는다).
 * - 글자를 칠 때마다 추천이 좁혀진다. 맨 위 추천의 나머지 글자가 칸 안에 **회색**으로 보이고,
 *   **Tab** 을 누르면 그 추천이 들어간다 (그리고 다음 칸으로 간다).
 * - ↑↓ 로 고르고 Enter 로 확정 — Enter 가 서식 저장으로 새지 않게 막는다.
 * - 칸을 비우고 나가면 선택이 지워진다. 고르지 않고 나가면 원래 선택으로 돌아간다.
 */
export function SuggestPicker(props: {
  id: string
  label: string
  required?: boolean
  disabled?: boolean
  placeholder?: string
  selected: PickerOption | null
  onSelect: (option: PickerOption | null) => void
  /** 지금 검색어의 추천 (위가 먼저). */
  options: readonly PickerOption[]
  keyword: string
  onKeywordChange: (value: string) => void
  isLoading?: boolean
  /** 추천이 없을 때 목록에 보일 글. */
  emptyText?: string
}) {
  const { id, label, required, disabled, placeholder, selected, onSelect, options, keyword, onKeywordChange } = props
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const [box, setBox] = useState<{ left: number; top: number; width: number; above: boolean } | null>(null)

  const place = () => {
    const el = inputRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const above = r.bottom + 260 > window.innerHeight && r.top > 260
    setBox({ left: r.left, top: above ? r.top - 2 : r.bottom + 2, width: r.width, above })
  }
  useLayoutEffect(() => {
    if (!open) return
    place()
    const onMove = () => place()
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open])


  const top = open ? options[active] ?? options[0] : undefined
  const typed = keyword
  const ghost =
    open && typed.trim() && options[0] && options[0].title.toLowerCase().startsWith(typed.toLowerCase())
      ? options[0].title.slice(typed.length)
      : ''
  const ghostAfter = open && typed.trim() && options[0] && !ghost ? `  → ${options[0].title}` : ''

  const pick = (o: PickerOption) => {
    onSelect(o)
    onKeywordChange('')
    setOpen(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      // 맨 위(또는 ↑↓ 로 고른) 추천을 넣는다. 기본 동작(다음 칸으로)은 그대로 둔다.
      if (open && typed.trim() && top) pick(top)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (open && top) pick(top)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) setOpen(true)
      setActive((a) => Math.max(0, Math.min(options.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1))))
    }
  }

  const shownText = open ? typed : (selected?.title ?? '')

  return (
    <div className={ui.field}>
      <label className={`${ui.label} ${required ? ui.required : ''}`} htmlFor={id}>
        {label}
      </label>
      <div className={ui.suggestWrap}>
        <input
          ref={inputRef}
          id={id}
          className={ui.input}
          autoComplete="off"
          disabled={disabled}
          placeholder={open && selected ? selected.title : placeholder}
          value={shownText}
          onFocus={(e) => {
            setOpen(true)
            onKeywordChange(selected?.title ?? '')
            const el = e.currentTarget
            requestAnimationFrame(() => el.select())
          }}
          onChange={(e) => {
            if (!open) setOpen(true)
            setActive(0) // 검색어가 바뀌면 맨 위부터.
            onKeywordChange(e.target.value)
          }}
          onBlur={() => {
            if (!open) return
            setOpen(false)
            if (typed.trim() === '' && selected) onSelect(null)
            onKeywordChange('')
          }}
          onKeyDown={onKeyDown}
          aria-autocomplete="list"
          aria-expanded={open}
        />
        {ghost || ghostAfter ? (
          <div className={`${ui.input} ${ui.suggestGhost}`} aria-hidden="true">
            <span style={{ color: 'transparent' }}>{typed}</span>
            <span>{ghost || ghostAfter}</span>
            <span className={ui.suggestTab}>Tab</span>
          </div>
        ) : null}
        {selected && !open && selected.subtitle ? <span className={ui.suggestSub}>{selected.subtitle}</span> : null}
      </div>

      {open && box ? (
        <div
          className={ui.suggestList}
          style={{
            left: box.left,
            width: Math.max(box.width, 240),
            ...(box.above ? { bottom: window.innerHeight - box.top } : { top: box.top }),
          }}
          onMouseDown={(e) => e.preventDefault()}
          role="listbox"
        >
          {props.isLoading ? <div className={ui.suggestEmpty}>찾는 중…</div> : null}
          {!props.isLoading && options.length === 0 ? <div className={ui.suggestEmpty}>{props.emptyText ?? '맞는 항목이 없습니다.'}</div> : null}
          {options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`${ui.suggestItem} ${i === active ? ui.suggestItemOn : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o)}
            >
              <span className={ui.pickerItemTitle}>{o.title}</span>
              {o.subtitle ? <span className={ui.pickerItemSub}>{o.subtitle}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
