/**
 * 테두리 — 구글 시트처럼 아이콘 판 (팀장님 2026-11-25).
 *
 * 왼쪽 5×2 아이콘: 모든 / 안쪽 / 가로 안쪽 / 세로 안쪽 / 바깥, 왼쪽 / 위쪽 / 오른쪽 / 아래쪽 / 지우기.
 * 오른쪽: 테두리 색(연필 + 색 막대), 테두리 스타일(얇은 선 · 굵은 선).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import css from './PmSheet.module.css'

export type BorderKind = 'all' | 'inner' | 'hInner' | 'vInner' | 'outer' | 'left' | 'top' | 'right' | 'bottom' | 'clear'

/** 3x3 칸 모양: 옅은 점선 격자 위에 진하게 그을 선. */
function bIcon(lines: string[]): ReactNode {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1" strokeDasharray="1 2" opacity="0.45">
        <path d="M2.5 2.5h13M2.5 9h13M2.5 15.5h13M2.5 2.5v13M9 2.5v13M15.5 2.5v13" />
      </g>
      <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="square">
        {lines.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  )
}
const T = 'M2.5 2.5h13'
const B = 'M2.5 15.5h13'
const L = 'M2.5 2.5v13'
const R = 'M15.5 2.5v13'
const H = 'M2.5 9h13'
const V = 'M9 2.5v13'

const BORDER_ICONS: Record<BorderKind, ReactNode> = {
  all: bIcon([T, B, L, R, H, V]),
  inner: bIcon([H, V]),
  hInner: bIcon([H]),
  vInner: bIcon([V]),
  outer: bIcon([T, B, L, R]),
  left: bIcon([L]),
  top: bIcon([T]),
  right: bIcon([R]),
  bottom: bIcon([B]),
  clear: bIcon([]),
}
const BORDER_LABELS: Record<BorderKind, string> = {
  all: '모든 테두리',
  inner: '안쪽 테두리',
  hInner: '가로 안쪽 테두리',
  vInner: '세로 안쪽 테두리',
  outer: '바깥 테두리',
  left: '왼쪽 테두리',
  top: '위쪽 테두리',
  right: '오른쪽 테두리',
  bottom: '아래쪽 테두리',
  clear: '테두리 지우기',
}
const BORDER_ORDER: BorderKind[][] = [
  ['all', 'inner', 'hInner', 'vInner', 'outer'],
  ['left', 'top', 'right', 'bottom', 'clear'],
]
const BORDER_COLORS = ['#000000', '#5f6368', '#b7b7b7', '#d93025', '#EC9820', '#f6b26b', '#188038', '#1a73e8', '#9334e6']

export function BorderMenu(props: {
  color: string
  weight: 'thin' | 'thick'
  onColor: (c: string) => void
  onWeight: (w: 'thin' | 'thick') => void
  onPick: (kind: BorderKind) => void
}) {
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<'color' | 'weight' | null>(null)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) {
        setOpen(false)
        setSub(null)
      }
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <span ref={box} className={css.paletteWrap}>
      <button type="button" className={css.tool} title="테두리" onClick={() => setOpen((o) => !o)} style={{ display: 'inline-flex', alignItems: 'center' }}>
        {BORDER_ICONS.all}
        <span className={css.caretSm}>▾</span>
      </button>
      {open ? (
        <div className={css.borderMenu}>
          <div className={css.borderGrid}>
            {BORDER_ORDER.map((row, i) => (
              <div key={i} className={css.borderRow}>
                {row.map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={css.tool}
                    title={BORDER_LABELS[k]}
                    onClick={() => {
                      props.onPick(k)
                      setOpen(false)
                      setSub(null)
                    }}
                  >
                    {BORDER_ICONS[k]}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <div className={css.borderSide}>
            <span className={css.paletteWrap}>
              <button
                type="button"
                className={`${css.tool} ${sub === 'color' ? css.toolOn : ''}`}
                title="테두리 색"
                onClick={() => setSub(sub === 'color' ? null : 'color')}
                style={{ display: 'inline-flex', alignItems: 'center' }}
              >
                <span className={css.borderPen}>
                  <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true">
                    <path d="M2 10l1-3 6-6 2 2-6 6z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                  </svg>
                  <span className={css.borderPenBar} style={{ background: props.color }} />
                </span>
                <span className={css.caretSm}>▾</span>
              </button>
              {sub === 'color' ? (
                <div className={css.borderPop}>
                  {BORDER_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`${css.borderSwatch} ${c.toLowerCase() === props.color.toLowerCase() ? css.borderSwatchOn : ''}`}
                      style={{ background: c }}
                      title={c}
                      onClick={() => {
                        props.onColor(c)
                        setSub(null)
                      }}
                    />
                  ))}
                </div>
              ) : null}
            </span>
            <span className={css.paletteWrap}>
              <button
                type="button"
                className={`${css.tool} ${sub === 'weight' ? css.toolOn : ''}`}
                title="테두리 스타일"
                onClick={() => setSub(sub === 'weight' ? null : 'weight')}
                style={{ display: 'inline-flex', alignItems: 'center' }}
              >
                <svg width="16" height="12" viewBox="0 0 16 12" aria-hidden="true">
                  <path d="M1 2h14" stroke="currentColor" strokeWidth="1" />
                  <path d="M1 6h14" stroke="currentColor" strokeWidth="1.8" />
                  <path d="M1 10.5h14" stroke="currentColor" strokeWidth="2.6" />
                </svg>
                <span className={css.caretSm}>▾</span>
              </button>
              {sub === 'weight' ? (
                <div className={css.borderPop} style={{ flexDirection: 'column', width: 120 }}>
                  {(['thin', 'thick'] as const).map((w) => (
                    <button
                      key={w}
                      type="button"
                      className={`${css.borderWeightOpt} ${props.weight === w ? css.toolOn : ''}`}
                      title={w === 'thin' ? '얇은 선' : '굵은 선'}
                      onClick={() => {
                        props.onWeight(w)
                        setSub(null)
                      }}
                    >
                      <span style={{ display: 'block', width: '100%', borderTop: `${w === 'thin' ? 1 : 2}px solid currentColor` }} />
                    </button>
                  ))}
                </div>
              ) : null}
            </span>
          </div>
        </div>
      ) : null}
    </span>
  )
}
