/**
 * PO 등록 창의 'CAT 분량' 표 (팀장님 2026-11-25).
 *
 * 단어 줄만 입력한다. 가중치는 고정(번역가에 따라 정해짐), 소계·합계는 자동.
 * 스프레드시트에서 여러 칸을 복사해 어느 단어 칸에 붙여 넣어도, 그 칸부터 오른쪽으로 채워진다.
 */
import ui from '@/shared/ui/ui.module.css'
import { CAT_BANDS, catSubtotal, catTotal, parseCatPaste, readWords } from './catMath'

export function CatTable(props: {
  words: readonly string[]
  weights: readonly number[]
  onChange: (words: string[]) => void
  disabled?: boolean
}) {
  const nums = CAT_BANDS.map((_, i) => readWords(props.words[i] ?? ''))
  const total = catTotal(nums, props.weights)
  const put = (from: number, values: string[]) => {
    const next = CAT_BANDS.map((_, i) => props.words[i] ?? '')
    values.forEach((v, k) => {
      if (from + k < next.length) next[from + k] = v.replace(/[^\d.,]/g, '')
    })
    props.onChange(next)
  }

  return (
    <table className={ui.catTable}>
      <thead>
        <tr>
          <th>구분</th>
          {CAT_BANDS.map((b) => (
            <th key={b}>{b}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr>
          <th>단어</th>
          {CAT_BANDS.map((b, i) => (
            <td key={b} className={ui.catInputCell}>
              <input
                className={ui.catInput}
                inputMode="numeric"
                aria-label={`CAT ${b} 단어`}
                disabled={props.disabled}
                value={props.words[i] ?? ''}
                onChange={(e) => put(i, [e.target.value])}
                onPaste={(e) => {
                  const cells = parseCatPaste(e.clipboardData.getData('text'))
                  if (cells.length > 1) {
                    e.preventDefault()
                    put(i, cells)
                  }
                }}
              />
            </td>
          ))}
        </tr>
        <tr className={ui.catFixed}>
          <th>가중치(%)</th>
          {CAT_BANDS.map((b, i) => (
            <td key={b}>{props.weights[i] ?? 0}</td>
          ))}
        </tr>
        <tr className={ui.catFixed}>
          <th>소계</th>
          {CAT_BANDS.map((b, i) => (
            <td key={b}>{nums[i] === null ? '' : catSubtotal(nums[i] ?? null, props.weights[i] ?? 0).toLocaleString('ko-KR')}</td>
          ))}
        </tr>
        <tr className={ui.catTotalRow}>
          <th>합계</th>
          <td colSpan={CAT_BANDS.length}>{nums.some((n) => n !== null) ? total.toLocaleString('ko-KR') : ''}</td>
        </tr>
      </tbody>
    </table>
  )
}
