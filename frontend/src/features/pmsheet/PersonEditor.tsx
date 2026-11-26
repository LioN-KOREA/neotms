/**
 * 번역가·감수자 칸의 입력기 (팀장님 2026-11-26).
 *
 * PO 창의 번역가 칸과 같은 방식 — 치는 대로 후보 목록, 맨 위 후보는 회색 글자로 미리 보이고 Tab 으로 완성.
 * 다른 점: 목록에 없는 이름도 그대로 적을 수 있고(Enter·칸 밖 누르기), 입력은 더블클릭으로 켠다.
 * 아직 아무것도 고치지 않았을 때는 '추천 번역가'(같은 업체·같은 언어쌍) 를 보여 준다.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslators } from '@/apis/queries/neotms.query'
import { useTranslatorSuggestions } from '@/apis/pmsheet.api'
import { formatSheetDate } from './sheetFormat'
import { isoToYmd } from './sheetModel'
import css from './PmSheet.module.css'

interface Option {
  id: string
  title: string
  sub: string
}

function useSettled(value: string, ms = 200): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return settled
}

export function PersonEditor(props: {
  initial: string
  /** 추천 번역가를 찾을 작업 (빈 줄이면 없음). */
  jobId: string | null
  which: 'tr' | 'rv'
  onCommit: (name: string, id: string | null) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(props.initial)
  const [active, setActive] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null)
  const done = useRef(false)

  const typed = text.trim()
  const edited = text !== props.initial
  const q = useSettled(typed)
  const search = useTranslators({ limit: 12, q: q || undefined }, edited && q.length > 0)
  const suggest = useTranslatorSuggestions(props.jobId)

  const found: Option[] = (search.data?.pages.flatMap((p) => p.items) ?? []).map((r) => ({
    id: r.id,
    title: r.tranName || r.tranCode,
    sub: [
      (r.tranLangs ?? '')
        .split(',')
        .filter(Boolean)
        .map((p) => p.split('>').filter(Boolean).join('→'))
        .join(', ') || '언어 미등록',
      r.tranEmail || '',
    ]
      .filter(Boolean)
      .join(' · '),
  }))
  const recommended: Option[] = (suggest.data ?? []).map((s) => ({
    id: s.translatorId,
    title: s.name,
    sub: `이전 인계일 ${s.lastHandoverAt ? formatSheetDate(isoToYmd(s.lastHandoverAt)) : '-'} · ${s.prjCode ?? ''} · ${String(s.times)}회`,
  }))
  const showRecommended = !edited || typed === ''
  const options = showRecommended ? recommended : found
  const top = options[0]
  const ghost = !showRecommended && typed && top && top.title.toLowerCase().startsWith(text.toLowerCase()) ? top.title.slice(text.length) : ''

  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    const r = el.getBoundingClientRect()
    setBox({ left: r.left, top: r.bottom + 1, width: r.width })
  }, [])

  const commit = (name: string, id: string | null) => {
    if (done.current) return
    done.current = true
    props.onCommit(name, id)
  }
  /** 적은 글자 그대로 — 목록에 정확히 같은 이름이 하나 있으면 그 번역가로. */
  const commitTyped = () => {
    const same = options.filter((o) => o.title.trim() === typed)
    commit(typed, same.length === 1 ? same[0]!.id : null)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      e.preventDefault()
      done.current = true
      props.onCancel()
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      const pick = active >= 0 ? options[active] : ghost ? top : undefined
      if (pick) commit(pick.title, pick.id)
      else commitTyped()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const pick = active >= 0 ? options[active] : undefined
      if (pick) commit(pick.title, pick.id)
      else commitTyped()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(-1, Math.min(options.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1))))
    }
  }

  const label = props.which === 'tr' ? '번역가' : '감수자'
  return (
    <div className={css.personWrap}>
      <input
        ref={input}
        className={css.cellInput}
        value={text}
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value)
          setActive(-1)
        }}
        onKeyDown={onKeyDown}
        onBlur={() => commitTyped()}
        onPointerDown={(e) => e.stopPropagation()}
        onCopy={(e) => e.stopPropagation()}
        onCut={(e) => e.stopPropagation()}
        onPaste={(e) => e.stopPropagation()}
      />
      {ghost ? (
        <div className={css.personGhost} aria-hidden="true">
          <span style={{ color: 'transparent' }}>{text}</span>
          <span>{ghost}</span>
          <span className={css.personTab}>Tab</span>
        </div>
      ) : null}
      {box
        ? createPortal(
            <div
              className={css.personList}
              style={{ left: box.left, top: Math.min(box.top, window.innerHeight - 280), minWidth: Math.max(box.width, 260) }}
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
              // 포털이어도 React 이벤트는 시트(ReactGrid)까지 올라간다 — 목록을 누른 것이 칸 고르기로 읽히지 않게.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <div className={css.personHead}>
                {showRecommended ? `💡 추천 ${label} — 같은 업체·같은 언어쌍` : `${label} 찾기 — 목록에 없는 이름도 Enter 로 그대로 넣습니다`}
              </div>
              {options.length === 0 ? (
                <div className={css.personEmpty}>
                  {showRecommended
                    ? suggest.isLoading
                      ? '찾는 중…'
                      : '추천할 사람이 없습니다. 이름을 입력해 찾으세요.'
                    : search.isLoading
                      ? '찾는 중…'
                      : '맞는 번역가가 없습니다 — Enter 로 적은 이름 그대로 넣습니다.'}
                </div>
              ) : null}
              {options.map((o, i) => (
                <button
                  key={o.id}
                  type="button"
                  className={`${css.personItem} ${i === active ? css.personItemOn : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(o.title, o.id)}
                >
                  <b>{o.title}</b>
                  {o.sub ? <span className={css.suggestSub}>{o.sub}</span> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
