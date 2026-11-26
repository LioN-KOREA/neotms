/**
 * 인계정보 입력의 '자주쓰는 참조 메일' (팀장님 2026-11-26) — 나만 보는 개인 설정(`prefs.view.ccFav`).
 *
 * [+ 메일 추가] → 메일 입력 창에서 주소를 하나 또는 여럿 넣으면 단추가 생긴다. 단추를 누르면 그 주소들이
 * 메일 참조 칸에 더해진다(이미 있는 주소는 건너뜀). 우클릭: 이름 바꾸기 · 삭제.
 * 기본 이름: `이름 <메일>` 이면 그 이름, 주소만이면 @ 앞 글자, 여럿이면 첫 사람 뒤에 ' 외 n명'.
 */
import { useEffect, useRef, useState } from 'react'
import { useMyPmPrefs, useSaveCcFav, type CcFavorite } from '@/apis/pmsheet.api'
import { EmailChips, type EmailChip } from '@/shared/ui/EmailChips'
import { ccFavName, parseEmailChip } from '@/shared/ui/emailChipParse'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'

export function CcFavorites(props: { value: EmailChip[]; onChange: (next: EmailChip[]) => void; disabled?: boolean }) {
  const prefs = useMyPmPrefs()
  const save = useSaveCcFav()
  const list: CcFavorite[] = prefs.data?.view?.ccFav ?? []
  const [adding, setAdding] = useState(false)
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null)
  const labelOf = (f: CcFavorite) => f.label || f.auto

  const apply = (f: CcFavorite) => {
    const seen = new Set(props.value.map((c) => c.email.toLowerCase()))
    const more = f.mails.map(parseEmailChip).filter((c): c is EmailChip => !!c && !seen.has(c.email.toLowerCase()))
    if (more.length > 0) props.onChange([...props.value, ...more])
  }

  return (
    <div className={ui.langFavBar}>
      <span className={ui.langFavTitle}>자주쓰는 참조 메일</span>
      {list.map((f, i) => (
        <button
          key={f.id}
          type="button"
          className={ui.langChip}
          disabled={props.disabled}
          title={`${f.mails.join(', ')}\n(누르면 메일 참조에 더합니다 · 우클릭: 이름 바꾸기·삭제)`}
          onClick={() => apply(f)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ index: i, x: e.clientX, y: e.clientY })
          }}
        >
          {labelOf(f)}
        </button>
      ))}
      <button type="button" className={ui.langChipAdd} disabled={props.disabled || !prefs.data} onClick={() => setAdding(true)}>
        + 메일 추가
      </button>

      {adding ? (
        <AddModal
          onClose={() => setAdding(false)}
          onAdd={(chips) => {
            save.mutate([
              ...list,
              {
                id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                auto: ccFavName(chips),
                mails: chips.map((c) => (c.name ? `${c.name} <${c.email}>` : c.email)),
              },
            ])
            setAdding(false)
          }}
        />
      ) : null}

      {menu && list[menu.index] ? (
        <RenameMenu
          x={menu.x}
          y={menu.y}
          label={labelOf(list[menu.index]!)}
          auto={list[menu.index]!.auto}
          onClose={() => setMenu(null)}
          onRename={(label) => {
            save.mutate(list.map((f, i) => (i === menu.index ? { ...f, label: label.trim() || null } : f)))
            setMenu(null)
          }}
          onDelete={() => {
            save.mutate(list.filter((_, i) => i !== menu.index))
            setMenu(null)
          }}
        />
      ) : null}
    </div>
  )
}

function AddModal(props: { onClose: () => void; onAdd: (chips: EmailChip[]) => void }) {
  const [chips, setChips] = useState<EmailChip[]>([])
  const bad = chips.some((c) => !c.valid)
  const ok = chips.length > 0 && !bad
  return (
    <Modal
      title="자주쓰는 참조 메일 추가"
      onClose={props.onClose}
      width={480}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={props.onClose}>
            취소
          </button>
          <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} disabled={bad} onClick={() => (ok ? props.onAdd(chips) : undefined)}>
            추가
          </button>
        </>
      }
    >
      <div className={ui.field}>
        <label className={ui.label} htmlFor="ccfav-mails">
          메일 주소 (하나 또는 여럿)
        </label>
        <EmailChips id="ccfav-mails" value={chips} onChange={setChips} placeholder="이름 <주소> 또는 주소 — 쉼표·Enter 로 구분" />
        {bad ? <p className={`${ui.hint} ${ui.hintWarn}`}>메일 주소가 아닌 항목(빨간색)이 있습니다. 고치거나 지워 주세요.</p> : null}
        <p className={ui.hint}>
          단추 이름: {chips.length > 0 ? <strong>{ccFavName(chips)}</strong> : '이름 <주소> 면 그 이름, 주소만이면 @ 앞 글자, 여럿이면 “… 외 n명”'} · 나중에 우클릭으로 바꿀 수 있습니다.
        </p>
      </div>
    </Modal>
  )
}

function RenameMenu(props: {
  x: number
  y: number
  label: string
  auto: string
  onClose: () => void
  onRename: (label: string) => void
  onDelete: () => void
}) {
  const [text, setText] = useState(props.label)
  const box = useRef<HTMLDivElement>(null)
  const { onClose } = props
  useEffect(() => {
    // 캡처 단계 — 모달이 mousedown 을 막아도 창 밖을 누르면 닫힌다.
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [onClose])
  return (
    <div ref={box} className={ui.langMenu} style={{ left: Math.min(props.x, window.innerWidth - 250), top: Math.min(props.y, window.innerHeight - 140) }}>
      <input
        className={ui.input}
        autoFocus
        value={text}
        aria-label="단추 이름"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') props.onRename(text)
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
        <button type="button" className={ui.btn} title={`기본 이름(${props.auto}) 으로`} onClick={() => props.onRename('')}>
          기본 이름
        </button>
        <button type="button" className={ui.btn} style={{ color: '#b3261e' }} onClick={props.onDelete}>
          삭제
        </button>
        <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => props.onRename(text)}>
          저장
        </button>
      </div>
    </div>
  )
}
