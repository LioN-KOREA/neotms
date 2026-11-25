/**
 * 메일 주소 입력 — 지메일 받는 사람 칸처럼 (팀장님 2026-11-25).
 *
 * - 쉼표·세미콜론·Enter·Tab, 또는 칸을 벗어나면 적은 글이 칩이 된다. 여러 개를 한꺼번에 붙여 넣어도 된다.
 * - `이름 <주소>` 는 이름으로 보이는 칩(마우스를 올리면 주소), `주소` 만 있으면 주소가 칩.
 * - 주소 모양이 아닌 글은 빨간 칩 — 그런 칩이 있으면 `invalid` 로 알려서 창이 보내기를 막는다.
 * - 빈 칸에서 Backspace 는 마지막 칩을 지운다. 칩의 × 로 하나씩 지운다.
 */
import { useRef, useState } from 'react'
import ui from './ui.module.css'

import { parseEmailList, type EmailChip } from './emailChipParse'

export type { EmailChip }

export function EmailChips(props: {
  id?: string
  value: EmailChip[]
  onChange: (next: EmailChip[]) => void
  disabled?: boolean
  placeholder?: string
}) {
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)

  const commit = (more = text) => {
    const added = parseEmailList(more)
    setText('')
    if (added.length === 0) return
    const seen = new Set(props.value.map((c) => c.email.toLowerCase()))
    props.onChange([...props.value, ...added.filter((c) => !seen.has(c.email.toLowerCase()))])
  }

  return (
    <div
      className={`${ui.input} ${ui.chipBox}`}
      onClick={() => input.current?.focus()}
      aria-disabled={props.disabled}
    >
      {props.value.map((c, i) => (
        <span
          key={`${c.raw}-${String(i)}`}
          className={`${ui.mailChip} ${c.valid ? '' : ui.mailChipBad}`}
          title={c.valid ? (c.name ? `${c.name} <${c.email}>` : c.email) : `메일 주소가 아닙니다: ${c.raw}`}
        >
          {c.valid ? (c.name ?? c.email) : c.raw}
          {!props.disabled ? (
            <button
              type="button"
              className={ui.mailChipX}
              aria-label={`${c.name ?? c.email} 빼기`}
              onClick={(e) => {
                e.stopPropagation()
                props.onChange(props.value.filter((_, j) => j !== i))
              }}
            >
              ×
            </button>
          ) : null}
        </span>
      ))}
      <input
        id={props.id}
        ref={input}
        className={ui.chipInput}
        value={text}
        disabled={props.disabled}
        placeholder={props.value.length === 0 ? props.placeholder : undefined}
        onChange={(e) => {
          const v = e.target.value
          if (/[,;]\s*$/.test(v)) commit(v)
          else setText(v)
        }}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || (e.key === 'Tab' && text.trim())) && !e.nativeEvent.isComposing) {
            e.preventDefault()
            commit()
          } else if (e.key === 'Backspace' && text === '' && props.value.length > 0) {
            props.onChange(props.value.slice(0, -1))
          }
        }}
        onBlur={() => commit()}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData('text')
          if (/[,;\n]/.test(pasted)) {
            e.preventDefault()
            commit(text + pasted)
          }
        }}
      />
    </div>
  )
}
