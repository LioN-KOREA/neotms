/**
 * 도구막대의 아이콘 메뉴 — 구글 시트처럼 가로 정렬 / 세로 정렬 / 텍스트 줄바꿈.
 * 단추에는 지금 칸의 설정 아이콘이 보이고, 누르면 고를 수 있는 아이콘 셋이 펼쳐진다.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import css from './PmSheet.module.css'

const LABELS: Record<string, string> = {
  left: '왼쪽', center: '가운데', right: '오른쪽',
  top: '위쪽', middle: '가운데', bottom: '아래쪽',
  overflow: '넘치기', wrap: '자동 줄바꿈', clip: '자르기',
}

export function IconMenu<K extends string>(props: {
  title: string
  icons: Record<K, ReactNode>
  value: K
  onPick: (key: K) => void
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <span ref={box} className={css.paletteWrap}>
      <button type="button" className={css.tool} title={props.title} onClick={() => setOpen((o) => !o)} style={{ display: 'inline-flex', alignItems: 'center' }}>
        {props.icons[props.value]}
        <span className={css.caretSm}>▾</span>
      </button>
      {open ? (
        <div className={css.iconMenu}>
          {(Object.keys(props.icons) as K[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`${css.tool} ${k === props.value ? css.toolOn : ''}`}
              title={`${props.title}: ${LABELS[k] ?? k}`}
              onClick={() => {
                props.onPick(k)
                setOpen(false)
              }}
            >
              {props.icons[k]}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  )
}

/**
 * 고정 메뉴 (팀장님 2026-11-25) — 아이콘 단추 하나. 누르면 '열 고정 ▸' · '행 고정 ▸', 마우스를 올리면
 * 없음 · 1개 · 2개 … 가 옆에 펼쳐진다. 행 고정 '없음' 은 머리행만 고정.
 */
export function FreezeMenu(props: {
  icon: ReactNode
  cols: number
  rows: number
  onCols: (n: number) => void
  onRows: (n: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState<'cols' | 'rows' | null>(null)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  const label = [props.cols > 0 ? `열 ${String(props.cols)}` : '', props.rows > 0 ? `행 ${String(props.rows)}` : ''].filter(Boolean).join('·')
  const section = (key: 'cols' | 'rows', title: string, unit: string, max: number, value: number, pick: (n: number) => void) => (
    <div className={css.freezeItem} onMouseEnter={() => setSub(key)} onClick={() => setSub(key)}>
      <span>{title}</span>
      <span className={css.freezeArrow}>▸</span>
      {sub === key ? (
        <div className={css.freezeSub}>
          {Array.from({ length: max + 1 }, (_, n) => (
            <button
              key={n}
              type="button"
              className={`${css.freezeOpt} ${n === value ? css.freezeOn : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                pick(n)
                setOpen(false)
              }}
            >
              {n === value ? '✓ ' : ''}
              {n === 0 ? '없음' : `${unit} ${String(n)}개`}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
  return (
    <span ref={box} className={css.paletteWrap}>
      <button
        type="button"
        className={css.iconTool}
        title="행·열 고정"
        onClick={() => {
          setOpen((o) => !o)
          setSub(null)
        }}
      >
        {props.icon}고정{label ? ` (${label})` : ''}
        <span className={css.caretSm}>▾</span>
      </button>
      {open ? (
        <div className={css.freezeMenu}>
          {section('cols', '열 고정', '열', 6, props.cols, props.onCols)}
          {section('rows', '행 고정', '행', 5, props.rows, props.onRows)}
        </div>
      ) : null}
    </span>
  )
}
