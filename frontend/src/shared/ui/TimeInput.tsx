import { useState } from 'react'
import { nowTimeKst } from '@/shared/utils/format'
import { parseTimeText, shiftHour } from '@/shared/utils/inputText'
import ui from './ui.module.css'

/**
 * 24시간 시각 칸 (팀장님 2026-11-25). `<input type="time">` 은 컴퓨터 설정에 따라 오전/오후로
 * 보여서 글자칸으로 바꿨다.
 *
 * - 두 자리만 적어도 된다: `23` → `23:00`, `930` → `09:30`.
 * - 양쪽 `<` `>` 는 한 시간씩. 분은 그대로.
 * - 알아볼 수 없는 글자는 칸을 떠날 때 이전 값으로 되돌린다.
 */
export function TimeInput(props: {
  value: string
  onChange: (next: string) => void
  ariaLabel: string
  disabled?: boolean
}) {
  const { value, onChange, ariaLabel, disabled } = props
  const [text, setText] = useState(value)
  const [synced, setSynced] = useState(value)
  if (synced !== value) {
    setSynced(value)
    setText(value)
  }
  const bad = parseTimeText(text) === null

  const commit = () => {
    const next = parseTimeText(text)
    if (next === null) setText(value)
    else {
      setText(next)
      if (next !== value) onChange(next)
    }
  }

  const step = (delta: number) => onChange(shiftHour(parseTimeText(text) ?? value, delta, nowTimeKst()))

  return (
    // 테두리 하나 안에 ‹ 시간 › (팀장님 2026-11-25) — 단추는 칸 안쪽 양 끝, 늘 연하게 보인다.
    <div className={`${ui.timeBox} ${bad ? ui.timeBoxBad : ''}`} aria-disabled={disabled || undefined}>
      <button type="button" className={ui.timeStep} disabled={disabled} aria-label={`${ariaLabel} 한 시간 앞으로`} title="한 시간 앞으로" onClick={() => step(-1)}>
        ‹
      </button>
      <input
        className={ui.timeText}
        aria-label={ariaLabel}
        aria-invalid={bad || undefined}
        inputMode="numeric"
        placeholder="00:00"
        disabled={disabled}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // 서식 저장이 아니라 시각 확정.
            e.preventDefault()
            commit()
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            step(e.key === 'ArrowUp' ? 1 : -1)
          }
        }}
      />
      <button type="button" className={ui.timeStep} disabled={disabled} aria-label={`${ariaLabel} 한 시간 뒤로`} title="한 시간 뒤로" onClick={() => step(1)}>
        ›
      </button>
    </div>
  )
}
