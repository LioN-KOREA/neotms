/**
 * PM 시트의 대화상자 — 조건부 서식, 단축키, 열 관리, 칸 메모.
 */
import { useState } from 'react'
import type { PmColumnsPref, PmCondClause, PmCondOp, PmCondRule, PmStyle } from '@/apis/pmsheet.api'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'
import { COND_OP_LABELS, isDateOp, needsValue } from './conditional'
import { FIXED_COLUMNS, buildColumns, type SheetColumn } from './sheetColumns'
import { ACTIONS, DEFAULT_SHORTCUTS, comboOf } from './shortcuts'
import css from './PmSheet.module.css'

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/* -------------------------------------------------------------------------- */
/* Conditional formatting                                                     */
/* -------------------------------------------------------------------------- */

export function CondFormatModal(props: {
  columns: SheetColumn[]
  rules: PmCondRule[]
  defaults: boolean
  onClose: () => void
  onSave: (rules: PmCondRule[], defaults: boolean) => void
}) {
  const [rules, setRules] = useState<PmCondRule[]>(props.rules)
  const [defaults, setDefaults] = useState(props.defaults)

  const update = (id: string, patch: Partial<PmCondRule>) => setRules((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  const updateClause = (rule: PmCondRule, i: number, patch: Partial<PmCondClause>) =>
    update(rule.id, { clauses: rule.clauses.map((c, j) => (j === i ? { ...c, ...patch } : c)) })
  const move = (i: number, d: -1 | 1) =>
    setRules((rs) => {
      const j = i + d
      if (j < 0 || j >= rs.length) return rs
      const next = [...rs]
      ;[next[i], next[j]] = [next[j]!, next[i]!]
      return next
    })

  const addRule = () =>
    setRules((rs) => [
      ...rs,
      { id: newId(), name: `규칙 ${String(rs.length + 1)}`, columns: [], join: 'and', clauses: [{ column: null, op: 'contains', value: '' }], style: { bg: '#FFF2CC' }, enabled: true },
    ])

  return (
    <Modal
      title="조건부 서식"
      width={760}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className={`${ui.btn} ${ui.btnGhost}`} onClick={props.onClose}>취소</button>
          <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => props.onSave(rules, defaults)}>저장</button>
        </>
      }
    >
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
        <input type="checkbox" checked={defaults} onChange={(e) => setDefaults(e.target.checked)} />
        <span>
          기본 규칙: 날짜·시간 칸이 <b style={{ background: '#FF9900', color: '#fff', padding: '0 4px' }}>오늘/지금</b> 이면 주황,{' '}
          <b style={{ background: '#3271EA', color: '#fff', padding: '0 4px' }}>지난 날/지난 시각</b> 이면 파랑 (납품 완료·홀딩/캔슬 행은 제외)
        </span>
      </label>
      <p className={css.small}>위에 있는 규칙이 먼저 적용됩니다. 조건부 서식은 손으로 칠한 서식보다 우선합니다.</p>

      {rules.map((rule, i) => (
        <div key={rule.id} className={css.rule}>
          <div className={css.ruleHead}>
            <input type="checkbox" title="사용" checked={rule.enabled !== false} onChange={(e) => update(rule.id, { enabled: e.target.checked })} />
            <input className={css.toolSelect} style={{ width: 140 }} value={rule.name ?? ''} onChange={(e) => update(rule.id, { name: e.target.value.slice(0, 40) })} />
            <button type="button" className={css.tool} onClick={() => move(i, -1)} title="위로">▲</button>
            <button type="button" className={css.tool} onClick={() => move(i, 1)} title="아래로">▼</button>
            <span style={{ marginLeft: 'auto' }} />
            <span className={css.preview} style={previewStyle(rule.style)}>미리보기 11/24(화)</span>
            <button type="button" className={css.tool} onClick={() => setRules((rs) => rs.filter((r) => r.id !== rule.id))}>삭제</button>
          </div>

          <div className={css.small}>적용할 열 (범위)</div>
          <div className={css.colChecks}>
            <label className={css.popItem}>
              <input type="checkbox" checked={!!rule.wholeRow} onChange={(e) => update(rule.id, { wholeRow: e.target.checked })} />
              <b>행 전체</b>
            </label>
            {props.columns.map((c) => (
              <label key={c.key} className={css.popItem}>
                <input
                  type="checkbox"
                  disabled={!!rule.wholeRow}
                  checked={rule.columns.includes(c.key)}
                  onChange={(e) =>
                    update(rule.id, { columns: e.target.checked ? [...rule.columns, c.key] : rule.columns.filter((k) => k !== c.key) })
                  }
                />
                {c.label}
              </label>
            ))}
          </div>

          <div style={{ marginTop: 6 }}>
            {rule.clauses.map((clause, ci) => (
              <div key={ci} className={css.clause}>
                {ci === 0 ? <span style={{ width: 52 }}>조건</span> : (
                  <select className={css.toolSelect} style={{ width: 52 }} value={rule.join} onChange={(e) => update(rule.id, { join: e.target.value as 'and' | 'or' })}>
                    <option value="and">그리고</option>
                    <option value="or">또는</option>
                  </select>
                )}
                <select className={css.toolSelect} value={clause.column ?? ''} onChange={(e) => updateClause(rule, ci, { column: e.target.value || null })}>
                  <option value="">(서식을 칠할 그 칸)</option>
                  {props.columns.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
                <select className={css.toolSelect} value={clause.op} onChange={(e) => {
                  const op = e.target.value as PmCondOp
                  updateClause(rule, ci, { op, value: isDateOp(op) && !isDateOp(clause.op) ? 'today' : clause.value })
                }}>
                  {(Object.keys(COND_OP_LABELS) as PmCondOp[]).map((op) => <option key={op} value={op}>{COND_OP_LABELS[op]}</option>)}
                </select>
                {needsValue(clause.op) ? (
                  <input
                    className={css.toolSelect}
                    style={{ width: 150 }}
                    placeholder={isDateOp(clause.op) ? 'today, today+1, 2026-12-01' : '값'}
                    value={clause.value ?? ''}
                    onChange={(e) => updateClause(rule, ci, { value: e.target.value.slice(0, 200) })}
                  />
                ) : null}
                {rule.clauses.length > 1 ? (
                  <button type="button" className={css.tool} onClick={() => update(rule.id, { clauses: rule.clauses.filter((_, j) => j !== ci) })}>✕</button>
                ) : null}
              </div>
            ))}
            {rule.clauses.length < 8 ? (
              <button type="button" className={css.tool} onClick={() => update(rule.id, { clauses: [...rule.clauses, { column: null, op: 'contains', value: '' }] })}>+ 조건 추가</button>
            ) : null}
          </div>

          <StylePicker style={rule.style} onChange={(style) => update(rule.id, { style })} />
        </div>
      ))}
      {rules.length < 30 ? (
        <button type="button" className={`${ui.btn} ${ui.btnSm}`} onClick={addRule}>+ 규칙 추가</button>
      ) : null}
    </Modal>
  )
}

function StylePicker({ style, onChange }: { style: PmStyle; onChange: (s: PmStyle) => void }) {
  const set = (patch: PmStyle) => {
    const next = { ...style, ...patch }
    for (const k of Object.keys(next) as (keyof PmStyle)[]) if (next[k] === null || next[k] === undefined || next[k] === false) delete next[k]
    onChange(next)
  }
  return (
    <div className={css.clause} style={{ marginTop: 6 }}>
      <span style={{ width: 52 }}>서식</span>
      칸 색 <input type="color" value={style.bg ?? '#FFFFFF'} onChange={(e) => set({ bg: e.target.value.toUpperCase() })} />
      <button type="button" className={css.tool} onClick={() => set({ bg: null })}>✕</button>
      글자색 <input type="color" value={style.fg ?? '#000000'} onChange={(e) => set({ fg: e.target.value.toUpperCase() })} />
      <button type="button" className={css.tool} onClick={() => set({ fg: null })}>✕</button>
      <label><input type="checkbox" checked={!!style.bold} onChange={(e) => set({ bold: e.target.checked })} /> 굵게</label>
      <label><input type="checkbox" checked={!!style.italic} onChange={(e) => set({ italic: e.target.checked })} /> 기울임</label>
      <label><input type="checkbox" checked={!!style.strike} onChange={(e) => set({ strike: e.target.checked })} /> 취소선</label>
    </div>
  )
}

function previewStyle(s: PmStyle): React.CSSProperties {
  return {
    background: s.bg ?? undefined,
    color: s.fg ?? undefined,
    fontWeight: s.bold ? 700 : undefined,
    fontStyle: s.italic ? 'italic' : undefined,
    textDecoration: [s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined,
  }
}

/* -------------------------------------------------------------------------- */
/* Shortcuts                                                                  */
/* -------------------------------------------------------------------------- */

export function ShortcutsModal(props: { current: Record<string, string>; onClose: () => void; onSave: (map: Record<string, string>) => void }) {
  const [map, setMap] = useState<Record<string, string>>(props.current)
  const [recording, setRecording] = useState<string | null>(null)
  const clash = (id: string) => {
    const v = map[id]
    return !!v && ACTIONS.some((a) => a.id !== id && map[a.id] === v)
  }
  const reserved = (v: string | undefined) => !!v && ['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A'].includes(v)
  const bad = ACTIONS.some((a) => clash(a.id) || reserved(map[a.id]))
  return (
    <Modal
      title="단축키 설정"
      width={520}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className={`${ui.btn} ${ui.btnGhost}`} onClick={() => setMap({ ...DEFAULT_SHORTCUTS })}>기본값</button>
          <button type="button" className={`${ui.btn} ${ui.btnGhost}`} onClick={props.onClose}>취소</button>
          <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} disabled={bad} onClick={() => props.onSave(map)}>저장</button>
        </>
      }
    >
      <p className={css.small}>칸을 누른 뒤 원하는 키 조합을 누르세요. Backspace 는 비우기, Esc 는 취소. 복사·붙여넣기(Ctrl+C/V/X)는 바꿀 수 없습니다.</p>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {ACTIONS.map((a) => (
            <tr key={a.id}>
              <td style={{ padding: '4px 0' }}>{a.label}</td>
              <td style={{ textAlign: 'right' }}>
                <span
                  tabIndex={0}
                  role="button"
                  className={`${css.kbd} ${recording === a.id ? css.kbdRec : ''}`}
                  style={clash(a.id) || reserved(map[a.id]) ? { borderColor: '#d93025', color: '#d93025' } : undefined}
                  onClick={() => setRecording(a.id)}
                  onBlur={() => setRecording((r) => (r === a.id ? null : r))}
                  onKeyDown={(e) => {
                    if (recording !== a.id) {
                      if (e.key === 'Enter') setRecording(a.id)
                      return
                    }
                    e.preventDefault()
                    e.stopPropagation()
                    if (e.key === 'Escape') return setRecording(null)
                    if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey) {
                      setMap((m) => ({ ...m, [a.id]: '' }))
                      return setRecording(null)
                    }
                    const combo = comboOf(e.nativeEvent)
                    if (!combo) return
                    setMap((m) => ({ ...m, [a.id]: combo }))
                    setRecording(null)
                  }}
                >
                  {recording === a.id ? '키를 누르세요…' : map[a.id] || '(없음)'}
                </span>
                {clash(a.id) ? <div className={css.small} style={{ color: '#d93025' }}>다른 동작과 겹칩니다</div> : null}
                {reserved(map[a.id]) ? <div className={css.small} style={{ color: '#d93025' }}>복사·붙여넣기 키는 쓸 수 없습니다</div> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */
/* Columns                                                                    */
/* -------------------------------------------------------------------------- */

export function ColumnsModal(props: { pref: PmColumnsPref; onClose: () => void; onSave: (pref: PmColumnsPref) => void }) {
  const [pref, setPref] = useState<PmColumnsPref>(props.pref)
  const [label, setLabel] = useState('')
  const all = buildColumns({ ...pref, hidden: [] })
  const hidden = new Set(pref.hidden ?? [])
  const custom = pref.custom ?? []
  const fixedKeys = new Set(FIXED_COLUMNS.map((c) => c.key))

  const move = (key: string, d: -1 | 1) => {
    const order = all.map((c) => c.key)
    const i = order.indexOf(key)
    const j = i + d
    if (j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j]!, order[i]!]
    setPref({ ...pref, order })
  }
  const add = () => {
    const name = label.trim()
    if (!name) return
    if (all.some((c) => c.label === name)) return window.alert('같은 이름의 열이 이미 있습니다.')
    setPref({ ...pref, custom: [...custom, { id: newId(), label: name.slice(0, 30) }] })
    setLabel('')
  }

  return (
    <Modal
      title="열 관리"
      width={520}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className={`${ui.btn} ${ui.btnGhost}`} onClick={() => setPref({ ...pref, order: [], widths: {}, hidden: [] })}>순서·너비 초기화</button>
          <button type="button" className={`${ui.btn} ${ui.btnGhost}`} onClick={props.onClose}>취소</button>
          <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => props.onSave(pref)}>저장</button>
        </>
      }
    >
      <p className={css.small}>
        추가 열(가제 열)에는 자유롭게 적거나 수식을 쓸 수 있습니다. 수식은 <code>=</code> 으로 시작하고 같은 행의 다른 열을 <code>[열 이름]</code> 으로 가리킵니다.
        예: <code>=[원본 분량]*1.1</code>, <code>=IF([진행 상태]="납품 완료","끝","")</code>
      </p>
      <div style={{ display: 'flex', gap: 6, margin: '8px 0' }}>
        <input className={css.toolSelect} style={{ flex: 1 }} placeholder="새 열 이름" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button type="button" className={`${ui.btn} ${ui.btnSm}`} onClick={add}>+ 열 추가</button>
      </div>
      <div style={{ maxHeight: 380, overflow: 'auto' }}>
        {all.map((c) => (
          <div key={c.key} style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '2px 0' }}>
            <input
              type="checkbox"
              title="보이기"
              checked={!hidden.has(c.key)}
              onChange={(e) => setPref({ ...pref, hidden: e.target.checked ? [...hidden].filter((k) => k !== c.key) : [...hidden, c.key] })}
            />
            {fixedKeys.has(c.key) ? (
              <span style={{ flex: 1 }}>{c.label}</span>
            ) : (
              <input
                className={css.toolSelect}
                style={{ flex: 1 }}
                value={custom.find((x) => `c:${x.id}` === c.key)?.label ?? c.label}
                onChange={(e) => setPref({ ...pref, custom: custom.map((x) => (`c:${x.id}` === c.key ? { ...x, label: e.target.value.slice(0, 30) } : x)) })}
              />
            )}
            <button type="button" className={css.tool} onClick={() => move(c.key, -1)}>▲</button>
            <button type="button" className={css.tool} onClick={() => move(c.key, 1)}>▼</button>
            {!fixedKeys.has(c.key) ? (
              <button
                type="button"
                className={css.tool}
                title="열 지우기 (적어 둔 값은 남아 있다가 같은 열을 되살리면 보입니다)"
                onClick={() => setPref({ ...pref, custom: custom.filter((x) => `c:${x.id}` !== c.key) })}
              >
                삭제
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */
/* Note                                                                       */
/* -------------------------------------------------------------------------- */

export function NoteModal(props: { title: string; initial: string; onClose: () => void; onSave: (note: string) => Promise<void> }) {
  const [note, setNote] = useState(props.initial)
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      title={`메모 — ${props.title}`}
      width={460}
      isDirty={note !== props.initial}
      onClose={props.onClose}
      footer={
        <>
          {props.initial ? (
            <button type="button" className={`${ui.btn} ${ui.btnGhost}`} disabled={busy} onClick={async () => { setBusy(true); await props.onSave(''); setBusy(false) }}>메모 지우기</button>
          ) : null}
          <button type="button" className={`${ui.btn} ${ui.btnGhost}`} onClick={props.onClose}>취소</button>
          <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} disabled={busy} onClick={async () => { setBusy(true); await props.onSave(note.trim()); setBusy(false) }}>저장</button>
        </>
      }
    >
      <textarea autoFocus rows={6} style={{ width: '100%', font: 'inherit' }} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
    </Modal>
  )
}
