/**
 * 엑셀식 색 고르기 — 테마 색 10개 + 밝기 단계 5줄, 표준 색 10개, '다른 색', 색상 코드 입력.
 * 색 값은 팀장님 캡처(2026-11-25, 엑셀 팔레트)에서 그대로 읽었다.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import css from './PmSheet.module.css'

const THEME: string[][] = [
  ['#FFFFFF', '#000000', '#E8E8E8', '#0E2841', '#156082', '#E97132', '#196B24', '#0F9ED5', '#A02B93', '#4EA72E'],
  ['#F2F2F2', '#7F7F7F', '#D0D0D0', '#DBE9F7', '#C1E4F5', '#FAE2D6', '#C1F0C8', '#CAEDFB', '#F1CEEE', '#D9F2D0'],
  ['#D8D8D8', '#595959', '#AEAEAE', '#A6C9EB', '#83CAEB', '#F6C6AC', '#84E291', '#95DCF7', '#E49EDD', '#B3E5A1'],
  ['#BFBFBF', '#3F3F3F', '#747474', '#4D94D8', '#45B0E1', '#F1A984', '#47D45A', '#60CBF3', '#D76DCC', '#8ED873'],
  ['#A5A5A5', '#262626', '#3A3A3A', '#215E99', '#0F4861', '#BF4F14', '#12501B', '#0B769F', '#78206E', '#3A7D22'],
  ['#7F7F7F', '#0C0C0C', '#171717', '#153D64', '#0A3041', '#7F340D', '#0C3512', '#074F6A', '#501549', '#265316'],
]
const STANDARD = ['#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0']

const HEX = /^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/
function normalizeHex(text: string): string | null {
  const m = HEX.exec(text.trim())
  if (!m) return null
  let h = m[1]!
  if (h.length === 3) h = h.split('').map((c) => c + c).join('')
  return `#${h.toUpperCase()}`
}

/**
 * 단추 + 펼쳐지는 팔레트. `onPick(null)` 은 '색 없음'.
 */
export function ColorPalette(props: {
  button: ReactNode
  title: string
  value?: string | null
  noneLabel?: string
  onPick: (color: string | null) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState({ x: 0, y: 0 })
  const [hex, setHex] = useState('')
  const box = useRef<HTMLSpanElement>(null)
  const native = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const pick = (c: string | null) => {
    props.onPick(c)
    setOpen(false)
  }
  const hexOk = normalizeHex(hex)

  return (
    <span ref={box} className={css.paletteWrap}>
      <button type="button" className={props.className ?? css.tool} title={props.title} onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt({ x: Math.min(r.left, window.innerWidth - 280), y: Math.min(r.bottom + 2, window.innerHeight - 330) })
          setOpen((o) => !o)
        }}>
        {props.button}
        <span className={css.caretSm}>▾</span>
      </button>
      {open ? (
        <div className={css.palette} style={{ position: 'fixed', left: at.x, top: at.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" className={css.paletteNone} onClick={() => pick(null)}>
            {props.noneLabel ?? '색 없음'}
          </button>
          <div className={css.paletteHead}>테마 색</div>
          <div className={css.paletteGrid}>
            {THEME[0]!.map((c) => <Swatch key={c} color={c} on={props.value === c} onPick={pick} />)}
          </div>
          <div className={css.paletteGrid} style={{ marginTop: 4 }}>
            {THEME.slice(1).flatMap((row) => row.map((c, i) => <Swatch key={`${c}${String(i)}`} color={c} on={props.value === c} onPick={pick} />))}
          </div>
          <div className={css.paletteHead}>표준 색</div>
          <div className={css.paletteGrid}>
            {STANDARD.map((c) => <Swatch key={c} color={c} on={props.value === c} onPick={pick} />)}
          </div>
          <button type="button" className={css.paletteMore} onClick={() => native.current?.click()}>
            🎨 다른 색…
          </button>
          <input
            ref={native}
            type="color"
            className={css.hiddenColor}
            value={props.value && /^#[0-9A-F]{6}$/i.test(props.value) ? props.value : '#000000'}
            onChange={(e) => setHex(e.target.value.toUpperCase())}
          />
          <div className={css.hexRow}>
            <input
              className={css.hexInput}
              placeholder="#RRGGBB"
              maxLength={7}
              value={hex}
              // 누르면 글자 전체가 선택되어 바로 새 코드를 칠 수 있다 (팀장님 2026-11-25).
              onFocus={(e) => {
                const el = e.currentTarget
                requestAnimationFrame(() => el.select())
              }}
              onChange={(e) => setHex(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && hexOk) pick(hexOk)
              }}
            />
            <span className={css.hexPreview} style={{ background: hexOk ?? 'transparent' }} />
            <button type="button" className={css.tool} disabled={!hexOk} onClick={() => hexOk && pick(hexOk)}>
              적용
            </button>
          </div>
        </div>
      ) : null}
    </span>
  )
}

function Swatch({ color, on, onPick }: { color: string; on: boolean; onPick: (c: string) => void }) {
  return (
    <button
      type="button"
      className={`${css.pswatch} ${on ? css.pswatchOn : ''}`}
      style={{ background: color }}
      title={color}
      onClick={() => onPick(color)}
    />
  )
}
