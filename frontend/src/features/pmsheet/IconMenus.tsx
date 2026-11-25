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
