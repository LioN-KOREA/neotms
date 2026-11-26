/**
 * 작업 등록 — 출발어 · 도착어(여러 개) · 언어별 설정 표 (팀장님 2026-11-25, 참고: 세부작업 UI
 * task_form.py 의 다중 도착어).
 *
 * - 출발어: 하나. 아래 '출발어 바로가기' 단추.
 * - 도착어: 골라서 '추가' 하거나 '도착어 바로가기' 단추를 누르면 아래 표에 한 줄씩 생긴다.
 *   ☆ 는 목록 맨 위로, 바로가기 단추는 우클릭으로 이름 바꾸기·삭제. 모두 나만 적용(`prefs.view.langFav`).
 * - 언어별 설정 표: 언어명 · 담당PM · 물량 · 기준 · 단가 · 액면 물량 · 합산. 위에 '모두적용' 줄.
 *   담당PM 아래 한 글자 빠른 단추는 머리글 '커스텀' 에서 정한다(나만 적용).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CODE_DOMAIN } from '@/apis/neotms.codes'
import { ASSIGNABLE_ATTRIBUTES } from '@/apis/neotms.types'
import { useAssignableStaff, useCodeOptions } from '@/apis/queries/neotms.query'
import { useMyPmPrefs, useSaveLangFav, type LangFav, type LangTemplate } from '@/apis/pmsheet.api'
import { CodeSelect } from '@/shared/ui/CodeSelect'
import { Modal } from '@/shared/ui/Modal'
import { LangCombo } from '@/shared/ui/LangCombo'
import { NumberInput } from '@/shared/ui/NumberInput'
import ui from '@/shared/ui/ui.module.css'
import { formatMoney } from '@/shared/utils/money'
import {
  basisOptions,
  centsText,
  faceVolume,
  fitBasis,
  lineSubtotal,
  PRICE_MODES,
  refreshFace,
  type PriceMode,
  type TargetLine,
} from './targetPricing'

const PM_ATTRIBUTE = ASSIGNABLE_ATTRIBUTES[1]

/* -------------------------------------------------------------------------- */
/* 나만의 설정 (☆ · 바로가기 · PM 빠른 단추)                                    */
/* -------------------------------------------------------------------------- */

function useFav() {
  const prefs = useMyPmPrefs()
  const save = useSaveLangFav()
  const fav: LangFav = prefs.data?.view?.langFav ?? {}
  return { fav, save: (next: LangFav) => save.mutate(next), ready: !prefs.isError && !prefs.isLoading, failed: prefs.isError }
}

function useLangNames() {
  const { options } = useCodeOptions(CODE_DOMAIN.LANG, null)
  return (code: string) => options.find((o) => o.value === code)?.label ?? code
}

/* -------------------------------------------------------------------------- */
/* 출발어 · 도착어 고르기                                                        */
/* -------------------------------------------------------------------------- */

export function LanguagePickers(props: {
  source: string
  onSource: (code: string) => void
  /** 도착어 한 개를 표에 추가. 수정 창에서는 없다 (도착어는 표의 한 줄에서 바꾼다). */
  onAddTarget?: (code: string) => void
  /** 도착어 한 개만 (PO 등록 창 — 팀장님 2026-11-25). 있으면 표에 추가하지 않고 이 값을 바꾼다. */
  target?: string
  onTarget?: (code: string) => void
  sourcePlaceholder?: string
  disabled?: boolean
}) {
  const { fav, save, ready, failed } = useFav()
  const nameOf = useLangNames()
  const [pending, setPending] = useState('')

  // 즐겨찾기 ☆ 는 언어 목록의 줄 안으로 옮겼다 (LangCombo, 팀장님 2026-11-26).

  return (
    <div className={ui.formRow} style={{ gridTemplateColumns: '1fr 1fr' }}>
      <div className={ui.field}>
        <label className={ui.label} htmlFor="job-slang">
          출발어
        </label>
        <LangCombo id="job-slang" ariaLabel="출발어" value={props.source} onChange={props.onSource} placeholder={props.sourcePlaceholder ?? null} disabled={props.disabled} />
        <Shortcuts
          title="출발어 바로가기"
          scope="src"
          current={props.source}
          fav={fav}
          save={save}
          ready={ready}
          nameOf={nameOf}
          disabled={props.disabled}
          onPick={props.onSource}
        />
      </div>

      {props.onTarget ? (
        <div className={ui.field}>
          <label className={ui.label} htmlFor="po-elang">
            도착어
          </label>
          <LangCombo id="po-elang" ariaLabel="도착어" value={props.target ?? ''} onChange={props.onTarget} placeholder="도착어 고르기" disabled={props.disabled} />
          <Shortcuts
            title="도착어 바로가기"
            scope="tgt"
            current={props.target ?? ''}
            fav={fav}
            save={save}
            ready={ready}
            nameOf={nameOf}
            disabled={props.disabled}
            onPick={props.onTarget}
          />
        </div>
      ) : props.onAddTarget ? (
        <div className={ui.field}>
          <label className={ui.label} htmlFor="job-elang-pick">
            도착어 <span className={ui.hint}>(여러 개 — 고르거나 바로가기를 누르면 아래 표에 바로 들어갑니다)</span>
          </label>
          {/* 고르면 바로 표에 추가 — 칸은 비우지 않는다 (팀장님 2026-11-25). */}
          <LangCombo
              id="job-elang-pick"
              ariaLabel="도착어"
              value={pending}
              onChange={(code) => {
                setPending(code)
                if (code) props.onAddTarget?.(code)
              }}
              placeholder="도착어 고르기"
              disabled={props.disabled}
            />
          <Shortcuts
            title="도착어 바로가기"
            scope="tgt"
            current={pending}
            fav={fav}
            save={save}
            ready={ready}
            nameOf={nameOf}
            disabled={props.disabled}
            onPick={(code) => props.onAddTarget?.(code)}
          />
        </div>
      ) : null}
      {failed ? <span className={ui.hint}>즐겨찾기를 불러오지 못했습니다 (언어는 그대로 고를 수 있습니다).</span> : null}
    </div>
  )
}

function Shortcuts(props: {
  title: string
  scope: 'src' | 'tgt'
  current: string
  fav: LangFav
  save: (next: LangFav) => void
  ready: boolean
  nameOf: (code: string) => string
  disabled?: boolean
  onPick: (code: string) => void
}) {
  const list = props.fav[props.scope] ?? []
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null)
  const labelOf = (s: { code: string; label?: string | null }) => s.label || props.nameOf(s.code)
  const write = (next: { code: string; label?: string | null }[]) => props.save({ ...props.fav, [props.scope]: next })

  return (
    <div className={ui.langFavBar}>
      <span className={ui.langFavTitle}>{props.title}</span>
      {list.map((s, i) => (
        <button
          key={s.code}
          type="button"
          className={ui.langChip}
          disabled={props.disabled}
          title={`${props.nameOf(s.code)} (우클릭: 이름 바꾸기·삭제)`}
          onClick={() => props.onPick(s.code)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ index: i, x: e.clientX, y: e.clientY })
          }}
        >
          {labelOf(s)}
        </button>
      ))}
      <button
        type="button"
        className={ui.langChipAdd}
        disabled={props.disabled || !props.current || !props.ready || list.some((s) => s.code === props.current)}
        title={props.current ? `${props.nameOf(props.current)} 을(를) 바로가기 단추로` : '언어를 먼저 고르세요'}
        onClick={() => write([...list, { code: props.current }])}
      >
        + 현재 언어 추가
      </button>
      {menu && list[menu.index] ? (
        <NameMenu
          x={menu.x}
          y={menu.y}
          label={labelOf(list[menu.index]!)}
          onClose={() => setMenu(null)}
          onRename={(label) => {
            write(list.map((s, i) => (i === menu.index ? { ...s, label: label.trim() || null } : s)))
            setMenu(null)
          }}
          onDelete={() => {
            write(list.filter((_, i) => i !== menu.index))
            setMenu(null)
          }}
        />
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* 언어·PM 템플릿 (팀장님 2026-11-26)                                           */
/* -------------------------------------------------------------------------- */

/** 템플릿 단추의 기본 이름 — `고객사명·언어명`, 도착어가 둘 이상이면 `고객사명·23L`. 고객사가 없으면 뒷부분만. */
function templateName(customer: string | null | undefined, targetNames: readonly string[]): string {
  const langs = targetNames.length === 1 ? targetNames[0]! : `${String(targetNames.length)}L`
  const cus = (customer ?? '').trim()
  return cus ? `${cus}·${langs}` : langs
}

/**
 * 작업 등록 창의 '언어·PM 템플릿' 줄. [+ 현재 언어·PM 설정 저장] 으로 지금의 출발어 · 도착어 · 도착어별
 * 담당PM 을 단추로 저장하고, 단추를 누르면 그대로 채운다(표의 도착어 줄은 템플릿 내용으로 **바뀐다**).
 * 우클릭: 이름 바꾸기 · 삭제. 나만 보는 개인 설정(`langFav.templates`).
 */
export function LangTemplates(props: {
  source: string
  targets: readonly { lang: string; pmId: string | null; pmName: string | null }[]
  customer: string | null | undefined
  onApply: (t: LangTemplate) => void
  disabled?: boolean
}) {
  const { fav, save, ready } = useFav()
  const nameOf = useLangNames()
  const list = fav.templates ?? []
  const [menu, setMenu] = useState<{ index: number; x: number; y: number } | null>(null)
  const write = (next: LangTemplate[]) => save({ ...fav, templates: next })
  const targets = props.targets.filter((t) => t.lang)
  const canSave = ready && targets.length > 0 && !props.disabled
  const labelOf = (t: LangTemplate) => t.label || t.auto

  const add = () => {
    if (!canSave) return
    write([
      ...list,
      {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        auto: templateName(props.customer, targets.map((t) => nameOf(t.lang))),
        src: props.source,
        targets: targets.map((t) => ({ lang: t.lang, pmId: t.pmId, pmName: t.pmName })),
      },
    ])
  }
  const describe = (t: LangTemplate) =>
    `${t.src ? `${nameOf(t.src)} → ` : ''}${t.targets.map((x) => `${nameOf(x.lang)}${x.pmName ? `(${x.pmName})` : ''}`).join(', ')}`

  return (
    <div className={ui.langFavBar}>
      <span className={ui.langFavTitle}>언어·PM 템플릿</span>
      {list.map((t, i) => (
        <button
          key={t.id}
          type="button"
          className={ui.langChip}
          disabled={props.disabled}
          title={`${describe(t)} (우클릭: 이름 바꾸기·삭제)`}
          onClick={() => props.onApply(t)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ index: i, x: e.clientX, y: e.clientY })
          }}
        >
          {labelOf(t)}
        </button>
      ))}
      <button
        type="button"
        className={ui.langChipAdd}
        disabled={!canSave}
        title={targets.length > 0 ? '지금의 출발어 · 도착어 · 도착어별 담당PM 을 단추로 저장합니다' : '도착어를 먼저 고르세요'}
        onClick={add}
      >
        + 현재 언어·PM 설정 저장
      </button>
      {menu && list[menu.index] ? (
        <NameMenu
          x={menu.x}
          y={menu.y}
          label={labelOf(list[menu.index]!)}
          defaultHint="고객사명·언어명 으로"
          onClose={() => setMenu(null)}
          onRename={(label) => {
            write(list.map((t, i) => (i === menu.index ? { ...t, label: label.trim() || null } : t)))
            setMenu(null)
          }}
          onDelete={() => {
            write(list.filter((_, i) => i !== menu.index))
            setMenu(null)
          }}
        />
      ) : null}
    </div>
  )
}

/** 바로가기 단추 우클릭 — 이름 바꾸기(비우면 언어 이름) · 삭제. */
function NameMenu(props: {
  x: number
  y: number
  label: string
  onClose: () => void
  onRename: (label: string) => void
  onDelete: () => void
  /** '기본 이름' 단추의 안내. */
  defaultHint?: string
}) {
  const [text, setText] = useState(props.label)
  const box = useRef<HTMLDivElement>(null)
  const { onClose } = props
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    // 캡처 단계에서 듣는다 — 모달이 mousedown 을 막아서(stopPropagation) 창 밖을 눌러도 닫히지 않던 문제
    // (팀장님 2026-11-26).
    window.addEventListener('mousedown', onDown, true)
    return () => window.removeEventListener('mousedown', onDown, true)
  }, [onClose])
  return (
    <div ref={box} className={ui.langMenu} style={{ left: Math.min(props.x, window.innerWidth - 240), top: Math.min(props.y, window.innerHeight - 120) }} onContextMenu={(e) => e.preventDefault()}>
      <label className={ui.label} htmlFor="lang-short-name">
        단추 이름
      </label>
      <input
        id="lang-short-name"
        className={ui.input}
        autoFocus
        maxLength={30}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            props.onRename(text)
          }
        }}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <button type="button" className={`${ui.btn} ${ui.btnPrimary} ${ui.btnSm}`} onClick={() => props.onRename(text)}>
          이름 저장
        </button>
        <button type="button" className={`${ui.btn} ${ui.btnSm}`} onClick={() => props.onRename('')} title={props.defaultHint ?? '언어 이름으로'}>
          기본 이름
        </button>
        <span className={ui.spacer} />
        <button type="button" className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`} onClick={props.onDelete}>
          삭제
        </button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* 언어별 설정 표                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 담당PM 고르기 — 목록과 그 아래 한 글자 빠른 단추. 언어별 설정 표의 칸과 같은 모양이고, 인계의
 * 작업 선택 창에서도 쓴다 (팀장님 2026-11-25).
 */
export function PmPickCell(props: {
  pmId: string | null
  pmName: string | null
  onChange: (pmId: string | null, pmName: string | null) => void
  ariaLabel: string
  disabled?: boolean
}) {
  const { fav } = useFav()
  const staff = useAssignableStaff(PM_ATTRIBUTE)
  const people = staff.data?.items ?? []
  const presets = fav.pmPresets ?? []
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, width: '100%' }}>
      <select
        className={ui.select}
        aria-label={props.ariaLabel}
        value={props.pmId ?? ''}
        disabled={props.disabled}
        onChange={(e) => {
          const p = people.find((x) => x.id === e.target.value)
          props.onChange(p?.id ?? null, p ? p.name || p.mgrId : null)
        }}
      >
        <option value="">(지정 안 함)</option>
        {props.pmId && !people.some((p) => p.id === props.pmId) ? <option value={props.pmId}>{props.pmName ?? props.pmId}</option> : null}
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name || p.mgrId}
          </option>
        ))}
      </select>
      {presets.length > 0 ? (
        <div className={ui.tgPresets}>
          {presets.map((p) => (
            <button
              key={`${p.label}${p.staffId}`}
              type="button"
              className={`${ui.tgPreset} ${props.pmId === p.staffId ? ui.tgPresetOn : ''}`}
              title={p.name}
              disabled={props.disabled}
              onClick={() => props.onChange(p.staffId, p.name)}
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function TargetTable(props: {
  lines: TargetLine[]
  onChange: (lines: TargetLine[]) => void
  coin: string
  /** 수정 창: 한 줄, 언어를 표에서 바꾼다. */
  editMode: boolean
  /** 수정 창 도착어 칸의 빈 선택지 — 저장된 값이 있으면 없음(null), 원래 비어 있던 작업만 '지정 없음'. */
  langPlaceholder?: string | null
  disabled?: boolean
}) {
  const { lines, onChange, coin, editMode, disabled } = props
  const nameOf = useLangNames()
  const { fav, save, ready } = useFav()
  const staff = useAssignableStaff(PM_ATTRIBUTE)
  const people = staff.data?.items ?? []
  const presets = fav.pmPresets ?? []
  const [customOpen, setCustomOpen] = useState(false)
  const [bulk, setBulkRaw] = useState({ raw: '', unit: '단어', basis: '250', price: '', face: '', faceManual: false })
  /** 모두적용 줄의 액면 물량은 물량·기준으로 자동 계산 — 직접 고치면 그 값을 쓴다 (팀장님 2026-11-25). */
  const setBulk = (next: typeof bulk) =>
    setBulkRaw(next.faceManual ? next : { ...next, face: faceVolume(next.raw, next.basis) ?? '' })

  const update = (key: string, patch: Partial<TargetLine>, refresh = false) =>
    onChange(lines.map((l) => (l.key === key ? (refresh ? refreshFace({ ...l, ...patch }) : { ...l, ...patch }) : l)))

  const applyAll = (what: 'raw' | 'basis' | 'price' | 'face') =>
    onChange(
      lines.map((l) => {
        if (what === 'raw') return refreshFace({ ...l, rawVolume: bulk.raw, unit: bulk.unit, basis: fitBasis(bulk.unit, l.basis) })
        if (what === 'basis') return refreshFace({ ...l, basis: fitBasis(l.unit, bulk.basis) })
        if (what === 'price') return { ...l, price: bulk.price }
        return { ...l, face: bulk.face, faceManual: true }
      }),
    )

  /** 줄 머리의 '모두적용' — 물량·기준·단가·액면 물량을 한꺼번에. 비워 둔 칸은 건너뛴다. */
  const applyEverything = () =>
    onChange(
      lines.map((l) => {
        let next: TargetLine = { ...l, basis: fitBasis(bulk.raw.trim() ? bulk.unit : l.unit, bulk.basis) }
        if (bulk.raw.trim()) next = { ...next, rawVolume: bulk.raw, unit: bulk.unit }
        if (bulk.price.trim()) next = { ...next, price: bulk.price }
        if (bulk.faceManual && bulk.face.trim()) next = { ...next, face: bulk.face, faceManual: true }
        else next = refreshFace({ ...next, faceManual: false })
        return next
      }),
    )

  const cell = (children: ReactNode, extra?: string) => <div className={`${ui.tgCell} ${extra ?? ''}`}>{children}</div>

  return (
    <div className={ui.fieldWide}>
      <div className={ui.tgPanel}>
        <div className={ui.tgTitle}>
          언어별 설정 <span className={ui.hint}>도착어 {lines.length}개 · {coin || 'KRW'}{editMode ? '' : ' — 저장하면 도착어마다 작업이 하나씩 만들어집니다'}</span>
        </div>

        {!editMode ? (
          <div className={ui.tgBulk}>
            <div className={ui.tgBulkHead}>
              <button
                type="button"
                className={`${ui.btn} ${ui.btnPrimary} ${ui.btnSm}`}
                disabled={disabled || lines.length === 0}
                onClick={applyEverything}
                title="아래 물량·기준·단가·액면 물량을 모든 언어 줄에 한꺼번에 넣습니다 (비워 둔 칸은 건너뜀)"
              >
                모두적용 (전체)
              </button>
              <span className={ui.hint}>칸 옆의 '이 칸만' 은 그 칸만 모든 줄에 넣습니다.</span>
            </div>
            <span className={ui.tgBulkGroup}>
              물량
              <NumberInput aria-label="모두적용 물량" className={ui.tgNarrow} value={bulk.raw} onValueChange={(v) => setBulk({ ...bulk, raw: v })} />
              <CodeSelect ariaLabel="모두적용 단위" domain={CODE_DOMAIN.UNIT} value={bulk.unit} onChange={(v) => setBulk({ ...bulk, unit: v, basis: fitBasis(v, bulk.basis) })} placeholder={null} silent />
              <button type="button" className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm} ${ui.tgOnly}`} disabled={disabled || lines.length === 0} onClick={() => applyAll('raw')} title="이 칸의 값만 모든 언어 줄에 넣습니다">이 칸만</button>
            </span>
            <span className={ui.tgBulkGroup}>
              기준
              <select className={ui.select} aria-label="모두적용 기준" value={bulk.basis} onChange={(e) => setBulk({ ...bulk, basis: e.target.value })}>
                {basisOptions(bulk.unit).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <button type="button" className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm} ${ui.tgOnly}`} disabled={disabled || lines.length === 0} onClick={() => applyAll('basis')} title="이 칸의 값만 모든 언어 줄에 넣습니다">이 칸만</button>
            </span>
            <span className={ui.tgBulkGroup}>
              단가
              <NumberInput aria-label="모두적용 단가" className={ui.tgNarrow} value={bulk.price} onValueChange={(v) => setBulk({ ...bulk, price: v })} />
              <button type="button" className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm} ${ui.tgOnly}`} disabled={disabled || lines.length === 0} onClick={() => applyAll('price')} title="이 칸의 값만 모든 언어 줄에 넣습니다">이 칸만</button>
            </span>
            <span className={ui.tgBulkGroup}>
              액면 물량
              <NumberInput aria-label="모두적용 액면 물량" className={ui.tgNarrow} value={bulk.face} onValueChange={(v) => setBulk({ ...bulk, face: v, faceManual: v.trim().length > 0 })} />
              <button type="button" className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm} ${ui.tgOnly}`} disabled={disabled || lines.length === 0} onClick={() => applyAll('face')} title="이 칸의 값만 모든 언어 줄에 넣습니다">이 칸만</button>
            </span>
          </div>
        ) : null}

        <div className={ui.tgGrid}>
          {cell('언어명', ui.tgHead)}
          {cell(
            <>
              담당PM
              <button type="button" className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`} style={{ marginLeft: 6 }} disabled={!ready} onClick={() => setCustomOpen(true)} title="한 글자 빠른 단추 정하기 (나만 적용)">
                커스텀
              </button>
            </>,
            ui.tgHead,
          )}
          {cell('물량', ui.tgHead)}
          {cell('기준', ui.tgHead)}
          {cell('단가', ui.tgHead)}
          {cell('액면 물량', ui.tgHead)}
          {cell('합산', ui.tgHead)}

          {lines.length === 0 ? (
            <div className={ui.tgEmpty}>도착어를 고르거나 도착어 바로가기를 눌러 주세요.</div>
          ) : null}

          {lines.map((l) => {
            const sub = lineSubtotal(l.face, l.price, l.mode)
            return (
              <div key={l.key} className={ui.tgLine}>
                {cell(
                  editMode ? (
                    <LangCombo ariaLabel="도착어" value={l.lang} onChange={(v) => update(l.key, { lang: v })} placeholder={props.langPlaceholder ?? null} disabled={disabled} />
                  ) : (
                    <>
                      <span className={ui.tgLang}>{nameOf(l.lang)}</span>
                      <button type="button" className={ui.tgRemove} disabled={disabled} title={`${nameOf(l.lang)} 빼기`} onClick={() => onChange(lines.filter((x) => x.key !== l.key))}>
                        ×
                      </button>
                    </>
                  ),
                )}
                {cell(
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, width: '100%' }}>
                    <select
                      className={ui.select}
                      aria-label={`${nameOf(l.lang)} 담당PM`}
                      value={l.pmId ?? ''}
                      disabled={disabled}
                      onChange={(e) => {
                        const p = people.find((x) => x.id === e.target.value)
                        update(l.key, { pmId: p?.id ?? null, pmName: p?.name ?? null })
                      }}
                    >
                      <option value="">(지정 안 함)</option>
                      {l.pmId && !people.some((p) => p.id === l.pmId) ? <option value={l.pmId}>{l.pmName ?? l.pmId}</option> : null}
                      {people.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name || p.mgrId}
                        </option>
                      ))}
                    </select>
                    {presets.length > 0 ? (
                      <div className={ui.tgPresets}>
                        {presets.map((p) => (
                          <button
                            key={`${p.label}${p.staffId}`}
                            type="button"
                            className={`${ui.tgPreset} ${l.pmId === p.staffId ? ui.tgPresetOn : ''}`}
                            title={p.name}
                            disabled={disabled}
                            onClick={() => update(l.key, { pmId: p.staffId, pmName: p.name })}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>,
                )}
                {cell(
                  <div className={ui.tgPair}>
                    <NumberInput aria-label={`${nameOf(l.lang)} 물량`} value={l.rawVolume} disabled={disabled} onValueChange={(v) => update(l.key, { rawVolume: v }, true)} />
                    <CodeSelect ariaLabel={`${nameOf(l.lang)} 단위`} domain={CODE_DOMAIN.UNIT} value={l.unit} onChange={(v) => update(l.key, { unit: v, basis: fitBasis(v, l.basis) }, true)} placeholder={null} disabled={disabled} silent />
                  </div>,
                )}
                {cell(
                  <select className={ui.select} aria-label={`${nameOf(l.lang)} 기준`} value={fitBasis(l.unit, l.basis)} disabled={disabled} onChange={(e) => update(l.key, { basis: e.target.value }, true)}>
                    {basisOptions(l.unit).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>,
                )}
                {cell(
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, width: '100%' }}>
                    <NumberInput aria-label={`${nameOf(l.lang)} 단가`} value={l.mode === 'free' ? '' : l.price} disabled={disabled || l.mode === 'free'} placeholder={l.mode === 'fixed' ? '금액' : ''} onValueChange={(v) => update(l.key, { price: v })} />
                    {/* 단가 · 고정가격 · 무료 중 하나 — 고른 것은 포인트 색 (팀장님 2026-11-25). 기본은 단가. */}
                    <div className={ui.tgModes} role="radiogroup" aria-label={`${nameOf(l.lang)} 가격 방식`}>
                      {PRICE_MODES.map((m) => (
                        <button
                          key={m.value}
                          type="button"
                          role="radio"
                          aria-checked={l.mode === m.value}
                          className={`${ui.tgMode} ${l.mode === m.value ? ui.tgModeOn : ''}`}
                          disabled={disabled}
                          onClick={() => update(l.key, { mode: m.value as PriceMode })}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>,
                )}
                {cell(
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, width: '100%' }}>
                    <NumberInput aria-label={`${nameOf(l.lang)} 액면 물량`} value={l.face} disabled={disabled} onValueChange={(v) => update(l.key, { face: v, faceManual: true })} />
                    <span className={ui.hint}>
                      {l.faceManual ? (
                        <>
                          직접 입력{' '}
                          <button type="button" className={ui.btnLink} onClick={() => update(l.key, { faceManual: false }, true)}>
                            자동으로
                          </button>
                        </>
                      ) : (
                        '자동 (물량 ÷ 기준)'
                      )}
                    </span>
                  </div>,
                )}
                {cell(<output className={ui.tgSum}>{sub === null ? '—' : formatMoney(centsText(sub))}</output>)}
              </div>
            )
          })}
        </div>
      </div>

      {customOpen ? (
        <PmCustomModal
          presets={presets}
          people={people.map((p) => ({ id: p.id, name: p.name || p.mgrId }))}
          onClose={() => setCustomOpen(false)}
          onSave={(next) => {
            save({ ...fav, pmPresets: next })
            setCustomOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}

/** 담당PM 빠른 단추 정하기 — 한 글자 이름과 사람. 나만 적용. */
function PmCustomModal(props: {
  presets: { label: string; staffId: string; name: string }[]
  people: { id: string; name: string }[]
  onClose: () => void
  onSave: (next: { label: string; staffId: string; name: string }[]) => void
}) {
  const [rows, setRows] = useState(props.presets.length > 0 ? props.presets : [{ label: '', staffId: '', name: '' }])
  const valid = rows.filter((r) => r.label.trim() && r.staffId)
  return (
    <Modal
      title="담당PM 빠른 단추 (나만 적용)"
      width={460}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className={`${ui.btn} ${ui.btnGhost}`} onClick={props.onClose}>
            취소
          </button>
          <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => props.onSave(valid.map((r) => ({ ...r, label: r.label.trim() })))}>
            저장
          </button>
        </>
      }
    >
      <p className={ui.hint} style={{ marginTop: 0 }}>
        단추에 보일 짧은 이름(한두 글자)과 사람을 고르세요. 언어별 설정 표의 담당PM 칸 아래에 단추로 나옵니다.
      </p>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'grid', gridTemplateColumns: '70px 1fr auto', gap: 6, marginBottom: 6 }}>
          <input className={ui.input} aria-label="단추 이름" maxLength={4} placeholder="예: 윤" value={r.label} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
          <select
            className={ui.select}
            aria-label="사람"
            value={r.staffId}
            onChange={(e) => {
              const p = props.people.find((x) => x.id === e.target.value)
              setRows(rows.map((x, j) => (j === i ? { ...x, staffId: p?.id ?? '', name: p?.name ?? '' } : x)))
            }}
          >
            <option value="">(사람 고르기)</option>
            {props.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button type="button" className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`} onClick={() => setRows(rows.filter((_, j) => j !== i))} title="빼기">
            ×
          </button>
        </div>
      ))}
      <button type="button" className={`${ui.btn} ${ui.btnSm}`} onClick={() => setRows([...rows, { label: '', staffId: '', name: '' }])}>
        + 단추 추가
      </button>
    </Modal>
  )
}
