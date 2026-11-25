import { useLayoutEffect, useRef, type InputHTMLAttributes } from 'react'
import { groupNumberText, stripNumberText } from '@/shared/utils/inputText'
import ui from './ui.module.css'

/**
 * 세 자리 쉼표가 보이는 숫자 칸 (팀장님 2026-11-25). 화면에는 `12,000`, 바깥으로는 쉼표 없는
 * `12000` 을 넘긴다 — 계산·저장 코드는 그대로 둔다.
 *
 * 쉼표가 끼어들어도 커서가 튀지 않게, 커서 앞의 숫자 개수를 세어 같은 자리에 다시 놓는다.
 */
export function NumberInput({
  value,
  onValueChange,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string
  onValueChange: (raw: string) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const caretDigits = useRef<number | null>(null)
  const shown = groupNumberText(value)

  useLayoutEffect(() => {
    const el = ref.current
    const want = caretDigits.current
    if (!el || want === null || document.activeElement !== el) return
    caretDigits.current = null
    let pos = 0
    let seen = 0
    while (pos < shown.length && seen < want) {
      if (/[\d.-]/.test(shown[pos]!)) seen += 1
      pos += 1
    }
    el.setSelectionRange(pos, pos)
  })

  return (
    <input
      {...rest}
      ref={ref}
      className={`${ui.input} ${ui.inputNum} ${className ?? ''}`}
      inputMode="decimal"
      value={shown}
      onChange={(e) => {
        const caret = e.target.selectionStart ?? e.target.value.length
        caretDigits.current = e.target.value.slice(0, caret).replace(/[^\d.-]/g, '').length
        onValueChange(stripNumberText(groupNumberText(e.target.value)))
      }}
    />
  )
}
