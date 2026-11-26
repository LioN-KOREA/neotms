/**
 * 언어 고르기 — 입력하며 좁혀 고르는 칸 (팀장님 2026-11-25).
 *
 * - 칸을 누르면 목록이 열린다. 언어명을 치면 그 글자가 들어간 언어로 좁혀진다(앞이 맞는 것 먼저).
 * - 맨 위 후보는 입력한 글자 뒤에 회색으로 미리 보이고, Tab 이나 Enter 로 확정한다.
 * - ▾ 단추는 전체 목록을 연다. ↑↓ 로 후보를 옮긴다. Esc 는 닫고 원래 값으로.
 * - 즐겨찾기: 목록의 줄마다 오른쪽 끝에 별표(팀장님 2026-11-26). ☆ 를 누르면 즐겨찾기, ★ 를 누르면 해제 —
 *   언어를 고르는 것과는 별개라 칸 값은 그대로이고, 목록도 닫히지 않는다. 즐겨찾기는 목록 맨 위로 바로
 *   올라간다. 목록은 개인 설정(`prefs.view.langFav.langs`) 하나를 모든 언어 칸이 함께 쓴다.
 */
import { useMemo, useRef, useState } from 'react'
import { CODE_DOMAIN } from '@/apis/neotms.codes'
import { useCodeOptions } from '@/apis/queries/neotms.query'
import { useMyPmPrefs, useSaveLangFav } from '@/apis/pmsheet.api'
import ui from './ui.module.css'

type Opt = { value: string; label: string; star: boolean }

export function LangCombo(props: {
  id?: string
  ariaLabel?: string
  value: string
  onChange: (code: string) => void
  /** 빈 값 항목의 이름. null 이면 빈 값을 고를 수 없다. */
  placeholder?: string | null
  disabled?: boolean
}) {
  const { options: raw } = useCodeOptions(CODE_DOMAIN.LANG, props.value)
  const prefs = useMyPmPrefs()
  const saveFav = useSaveLangFav()
  const fav = prefs.data?.view?.langFav
  const pinned = useMemo(() => fav?.langs ?? [], [fav])
  const favReady = !prefs.isLoading && !prefs.isError
  const toggleFav = (code: string) => {
    if (!favReady) return
    saveFav.mutate({ ...(fav ?? {}), langs: pinned.includes(code) ? pinned.filter((x) => x !== code) : [...pinned, code] })
  }
  const options: Opt[] = useMemo(
    () => [
      ...pinned.flatMap((v) => raw.filter((o) => o.value === v).map((o) => ({ value: o.value, label: o.label, star: true }))),
      ...raw.filter((o) => !pinned.includes(o.value)).map((o) => ({ value: o.value, label: o.label, star: false })),
    ],
    [raw, pinned],
  )
  const labelOf = (code: string) => options.find((o) => o.value === code)?.label ?? code
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<string | null>(null) // null = 입력 중이 아님 (값의 이름을 보인다)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  const query = (text ?? '').trim().toLowerCase()
  const list: Opt[] = useMemo(() => {
    if (!query) return options
    const hit = options.filter((o) => o.label.toLowerCase().includes(query) || o.value.toLowerCase().includes(query))
    const starts = hit.filter((o) => o.label.toLowerCase().startsWith(query))
    return [...starts, ...hit.filter((o) => !starts.includes(o))]
  }, [options, query])
  const withEmpty = props.placeholder != null && !query
  const rows: (Opt | null)[] = withEmpty ? [null, ...list] : list
  const top = query ? list[0] : undefined
  const ghost = top && text ? (top.label.toLowerCase().startsWith(query) ? top.label.slice(text.trimStart().length) : ` → ${top.label}`) : ''

  const choose = (code: string) => {
    props.onChange(code)
    setText(null)
    setOpen(false)
  }
  const close = () => {
    setText(null)
    setOpen(false)
  }

  return (
    <div className={ui.comboWrap}>
      <div className={ui.comboField}>
        {ghost ? (
          <div className={`${ui.input} ${ui.comboGhost}`} aria-hidden="true">
            <span style={{ visibility: 'hidden' }}>{text}</span>
            {ghost}
          </div>
        ) : null}
        <input
          id={props.id}
          ref={input}
          className={`${ui.input} ${ui.comboInput}`}
          aria-label={props.ariaLabel}
          role="combobox"
          aria-expanded={open}
          autoComplete="off"
          disabled={props.disabled}
          placeholder={props.placeholder ?? undefined}
          value={text ?? (props.value ? labelOf(props.value) : '')}
          onFocus={(e) => {
            setOpen(true)
            setActive(0)
            e.currentTarget.select()
          }}
          onChange={(e) => {
            setText(e.target.value)
            setOpen(true)
            setActive(0)
          }}
          onBlur={() => {
            // 정확히 같은 이름을 쳤으면 그 언어로, 아니면 원래 값으로 돌아간다.
            if (text !== null) {
              const exact = options.find((o) => o.label.toLowerCase() === text.trim().toLowerCase())
              if (exact) props.onChange(exact.value)
            }
            close()
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setOpen(true)
              setActive((a) => Math.min(a + 1, rows.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Tab' && top) {
              choose(top.value) // 기본 동작(다음 칸으로)은 그대로 — 확정하고 넘어간다.
            } else if (e.key === 'Enter' && open && rows.length > 0) {
              e.preventDefault()
              const row = rows[Math.min(active, rows.length - 1)]
              choose(row ? row.value : '')
            } else if (e.key === 'Escape' && open) {
              e.preventDefault()
              e.stopPropagation()
              close()
            }
          }}
        />
        <button
          type="button"
          className={ui.comboCaret}
          tabIndex={-1}
          disabled={props.disabled}
          aria-label="목록 열기"
          onMouseDown={(e) => {
            e.preventDefault()
            if (open) close()
            else {
              setText(null)
              setOpen(true)
              input.current?.focus()
            }
          }}
        >
          ▾
        </button>
      </div>
      {open && !props.disabled ? (
        <div className={ui.comboList} role="listbox">
          {rows.length === 0 ? <div className={ui.comboEmpty}>맞는 언어가 없습니다</div> : null}
          {rows.map((o, i) => (
            <div
              key={o ? o.value : '__empty'}
              role="option"
              aria-selected={(o?.value ?? '') === props.value}
              className={`${ui.comboItem} ${i === active ? ui.comboActive : ''} ${(o?.value ?? '') === props.value ? ui.comboCurrent : ''}`}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(o ? o.value : '')
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className={ui.comboLabel}>{o ? o.label : props.placeholder}</span>
              {o ? (
                <button
                  type="button"
                  tabIndex={-1}
                  className={`${ui.comboStar} ${o.star ? ui.comboStarOn : ''}`}
                  title={o.star ? '즐겨찾기 해제' : '즐겨찾기 (목록 맨 위로)'}
                  aria-label={`${o.label} ${o.star ? '즐겨찾기 해제' : '즐겨찾기'}`}
                  aria-pressed={o.star}
                  disabled={!favReady}
                  onMouseDown={(e) => {
                    // 줄을 고르지도, 칸에서 포커스를 빼지도 않는다 — 별만 바뀐다.
                    e.preventDefault()
                    e.stopPropagation()
                    toggleFav(o.value)
                  }}
                >
                  {o.star ? '★' : '☆'}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
