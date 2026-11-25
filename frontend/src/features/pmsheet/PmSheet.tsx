/**
 * PM 업무 시트 — "내 업무" 시트 한 장 (내 것 또는 타PM 의 것).
 *
 * 한 행 = 작업(JOB) 하나. 칸을 고치면 세 갈래로 저장된다:
 *   * TMS 연동 칸(번역가·분량·도착일·시간·납품일) → 작업·PO 수정 엔드포인트 (폼과 같은 검사)
 *   * 이 시트의 행 값(진행 상태·업무·비고·백업·경로) → /pm-sheet/rows (진행 상태는 프로젝트
 *     진행상태도 바꾼다: 인계 수령~납품 대기 → 진행, 납품 완료 → 완료, 홀딩/캔슬 → 보류)
 *   * 가제 열·꾸밈·메모 → /pm-sheet/cells
 *
 * 1단계(DB 무변경) 기능: 날짜 형식, 시간 1~24, 0,000 숫자, 당일/과일 기본 색, 열 정렬·필터,
 * 행·열 고정, 실행취소·재실행, 엑셀 호환 복사·붙여넣기(ReactGrid), 단축키, 수식, 링크, 오늘 할 일.
 * 2단계: 진행 상태, 서식 확장(테두리·세로정렬·소수 자리·메모), 조건부 서식, 필터 즐겨찾기,
 * 단축키 사용자 지정, 별도 관리 묶음·월별 머리행, 행 통합.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import {
  ReactGrid,
  type CellChange,
  type CellLocation,
  type CellStyle,
  type Column,
  type Highlight,
  type Id,
  type Range,
  type Row,
} from '@silevis/reactgrid'
import '@silevis/reactgrid/styles.css'
import {
  GROUP_END,
  GROUP_START,
  patchPmRow,
  pmKeys,
  useTranslatorSuggestions,
  writePmCells,
  writePmPref,
  type PmCellWrite,
  type PmCondRule,
  type PmPrefs,
  type PmSheetRow,
  type PmSheetView,
  type PmStateDef,
  type PmStyle,
} from '@/apis/pmsheet.api'
import { useUpdateJob, useUpdatePurchaseOrder } from '@/apis/queries/neotms.mutation'
import { TranslatorSwapModal, type SwappableTranslatorPo } from '@/features/purchaseorders/TranslatorSwapModal'
import { conditionalStyle } from './conditional'
import {
  FIXED_COLUMNS,
  ROW_FIELD_KEYS,
  TASK_OPTIONS,
  buildColumns,
  mergeStyle,
  type SheetColumn,
} from './sheetColumns'
import { SheetCellTemplate, SheetHeaderTemplate, type SheetCell, type SheetHeaderCell } from './sheetCells'
import { asNumber, dayState, formatSheetDate, hourState, parseHour, parseSheetDate, todayYmd } from './sheetFormat'
import { isFormula } from './sheetFormula'
import {
  BLANK,
  buildEntries,
  cellKey,
  cellValue,
  distinctValues,
  indexCells,
  isoToYmd,
  mergeProblem,
  type DataEntry,
  type Filters,
  type SortState,
} from './sheetModel'
import { CondFormatModal, ColumnsModal, NoteModal, ShortcutsModal, StatesModal } from './PmSheetModals'
import { ACTIONS, comboOf, effectiveShortcuts } from './shortcuts'
import { ColorPalette } from './ColorPalette'
import { IconMenu } from './IconMenus'
import { ALIGN_ICONS, VALIGN_ICONS, WRAP_ICONS } from './menuIcons'
import { effectiveStates, isClosedState, selectableStates, stateStyleFor } from './pmStates'
import { BLANK_TAIL, freePosOf, isFreeRowId, layoutPositions, liveFreeRows, reorderSlots, setFreeValue } from './freeRows'
import css from './PmSheet.module.css'

const SIZES = [9, 10, 11, 12, 13, 14, 16, 18, 20]
const GROUP_COLOR = '#990000'
const MONTH_COLOR = '#FF6D01'
/** 머리글 색 (팀장님 2026-11-25, 모든 사람의 시트). */
const HEADER_BG = '#FFD966'
const LINE_HEIGHT = 16

interface Props {
  sheet: PmSheetView
  /** 타PM 시트면 그 사람 id. 내 시트면 undefined. */
  ownerId?: string
  onNotice: (message: string) => void
  onError: (message: string) => void
}

type GridCell = SheetCell | SheetHeaderCell
type HistoryEntry = { label: string; undo: () => Promise<void>; redo: () => Promise<void> }
type Target = { jobId: string; colKey: string }

export function PmSheet({ sheet, ownerId, onNotice, onError }: Props) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const updateJob = useUpdateJob()
  const updatePo = useUpdatePurchaseOrder()

  /* ----------------------------------------------------------------------- */
  /* Preferences (optimistic local copy)                                     */
  /* ----------------------------------------------------------------------- */
  const [prefs, setPrefs] = useState<PmPrefs>(sheet.prefs)
  const [prefsSource, setPrefsSource] = useState(sheet.prefs)
  if (prefsSource !== sheet.prefs) {
    setPrefsSource(sheet.prefs)
    setPrefs(sheet.prefs)
  }
  const savePref = async <K extends keyof PmPrefs>(kind: K, data: NonNullable<PmPrefs[K]>) => {
    const before = prefs
    setPrefs({ ...prefs, [kind]: data })
    try {
      await writePmPref(ownerId, kind, data)
      void qc.invalidateQueries({ queryKey: pmKeys.sheet(ownerId ?? null) })
    } catch (err) {
      setPrefs(before)
      onError(messageOf(err))
    }
  }

  const columns = useMemo(() => buildColumns(prefs.columns), [prefs.columns])
  const cells = useMemo(() => indexCells(sheet.cells), [sheet.cells])
  const rules: PmCondRule[] = prefs.cf?.rules ?? []
  const defaultsOn = prefs.cf?.defaults !== false
  const shortcuts = effectiveShortcuts(prefs.shortcuts?.map)
  const stateDefs = effectiveStates(prefs.columns?.states)
  const stateNames = selectableStates(stateDefs)
  const columnOrder = columns.map((c) => c.key)

  /* ----------------------------------------------------------------------- */
  /* Local view state                                                        */
  /* ----------------------------------------------------------------------- */
  const [sort, setSort] = useState<SortState>(null)
  const [filters, setFilters] = useState<Filters>({})
  const [filterPop, setFilterPop] = useState<{ key: string; x: number; y: number } | null>(null)
  const [selection, setSelection] = useState<{ cells: Target[]; rows: string[]; cols: string[]; ranges: Range[] }>({
    cells: [],
    rows: [],
    cols: [],
    ranges: [],
  })
  const [focus, setFocus] = useState<Target | null>(null)
  const [focusLocation, setFocusLocation] = useState<CellLocation | undefined>(undefined)
  const [flash, setFlash] = useState<string | null>(null)
  const [todayOpen, setTodayOpen] = useState(false)
  const [modal, setModal] = useState<'cf' | 'shortcuts' | 'columns' | 'note' | 'states' | null>(null)
  const [stateMenu, setStateMenu] = useState<{ jobId: string; x: number; y: number } | null>(null)
  /** 우클릭 메뉴 — 머리글(jobId null) 또는 칸. */
  /* 시트 창이 화면 아래 끝까지 — 창 크기·위쪽 내용이 바뀌면 다시 잰다. */
  const gridBox = useRef<HTMLDivElement>(null)
  const [gridHeight, setGridHeight] = useState<number | null>(null)
  useEffect(() => {
    const fit = () => {
      const el = gridBox.current
      if (!el) return
      const h = Math.max(320, Math.floor(window.innerHeight - el.getBoundingClientRect().top - 12))
      setGridHeight((old) => (old === h ? old : h))
    }
    fit()
    window.addEventListener('resize', fit)
    const ro = new ResizeObserver(fit)
    if (gridBox.current?.parentElement) ro.observe(gridBox.current.parentElement)
    return () => {
      window.removeEventListener('resize', fit)
      ro.disconnect()
    }
  }, [])
  const [colMenu, setColMenu] = useState<{ key: string; x: number; y: number; jobId: string | null } | null>(null)
  const [swapping, setSwapping] = useState<SwappableTranslatorPo | null>(null)
  const [suggestFor, setSuggestFor] = useState<{ jobId: string; which: 'tr' | 'rv'; x: number; y: number } | null>(null)
  const mouse = useRef({ x: 200, y: 200 })
  /* 오늘/지금 색칠이 시간이 흐르면 바뀌도록 1분마다 시계를 다시 읽는다. */
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  /* 저장 중인 값 — 서버 값이 같아지면 버린다 (WorkspaceGrid 와 같은 방식). */
  const [edits, setEdits] = useState<{ source: PmSheetRow[]; values: Map<string, string> }>({
    source: sheet.rows,
    values: new Map(),
  })
  const overrides = edits.values

  /* 실행취소·재실행 */
  const history = useRef<{ undo: HistoryEntry[]; redo: HistoryEntry[] }>({ undo: [], redo: [] })
  const [histSize, setHistSize] = useState({ undo: 0, redo: 0 })
  const syncHistory = () => setHistSize({ undo: history.current.undo.length, redo: history.current.redo.length })
  const pushHistory = (entry: HistoryEntry) => {
    history.current.undo.push(entry)
    if (history.current.undo.length > 100) history.current.undo.shift()
    history.current.redo = []
    syncHistory()
  }

  const rowById = useMemo(() => new Map(sheet.rows.map((r) => [r.jobId, r])), [sheet.rows])

  const decimalsOf = (row: PmSheetRow, column: SheetColumn) =>
    mergeStyle(cells.get(cellKey(row.jobId, column.key))?.style, row.rowStyle, column.style).decimals

  /* 빈 줄 — 작업 행 사이·아래의 자리. 글을 적을 수 있고, 새 인계 작업은 아무것도 없는 첫 자리에 들어간다. */
  const freeRows = liveFreeRows(prefs.view?.freeRows)
  const topJobs = sheet.rows.filter((r) => !(r.mergedInto && rowById.has(r.mergedInto)))
  const layout = layoutPositions(topJobs.map((r) => ({ jobId: r.jobId, ordNo: r.ordNo })), freeRows)
  const entries = buildEntries({ rows: sheet.rows, columns, cells, sort, filters, overrides, decimalsOf, posOf: layout.posOf, freeRows, blankTail: BLANK_TAIL })
  const dataCount = entries.filter((e) => e.kind === 'data').length

  // 자리가 새로 정해진 작업(새 인계 등)은 그 자리를 저장해 둔다 — 나중에 빈 줄에 글을 적어도 밀리지 않게.
  const movesKey = layout.moves.map((m) => `${m.jobId}:${String(m.pos)}`).join(',')
  const savedMoves = useRef('')
  useEffect(() => {
    if (!movesKey || savedMoves.current === movesKey) return
    savedMoves.current = movesKey
    void (async () => {
      try {
        for (const m of layout.moves) await patchPmRow({ staffId: ownerId, jobId: m.jobId, ordNo: m.pos })
        void qc.invalidateQueries({ queryKey: pmKeys.sheet(ownerId ?? null) })
      } catch {
        // 화면 자리는 이미 맞다 — 다시 시도하지 않는다(볼 권한만 있는 시트 등). 자리가 또 바뀌면 그때 저장한다.
      }
    })()
  })

  /** 빈 줄 글 고치기 (여러 칸 한꺼번에). */
  const writeFree = (changes: { pos: number; colKey: string; text: string }[]) => {
    let next = freeRows
    for (const c of changes) next = setFreeValue(next, c.pos, c.colKey, c.text)
    void savePref('view', { ...(prefs.view ?? {}), freeRows: next })
  }

  if (edits.source !== sheet.rows) {
    const next = new Map(edits.values)
    for (const [key, value] of edits.values) {
      const [jobId, colKey] = key.split('|') as [string, string]
      const row = rowById.get(jobId)
      const column = columns.find((c) => c.key === colKey)
      if (!row || !column) {
        next.delete(key)
        continue
      }
      const server = cellValue(row, column, { columns, cells, merged: [], inGroup: false, rowNo: 0, overrides: new Map() }, null)
      if (server.raw === value) next.delete(key)
    }
    setEdits({ source: sheet.rows, values: next })
  }

  const put = (jobId: string, colKey: string, value: string) =>
    setEdits((prev) => {
      const values = new Map(prev.values)
      values.set(cellKey(jobId, colKey), value)
      return { source: prev.source, values }
    })
  const drop = (jobId: string, colKey: string) =>
    setEdits((prev) => {
      const values = new Map(prev.values)
      values.delete(cellKey(jobId, colKey))
      return { source: prev.source, values }
    })

  const refresh = () => void qc.invalidateQueries({ queryKey: pmKeys.sheet(ownerId ?? null) })

  /* ----------------------------------------------------------------------- */
  /* Writing values                                                          */
  /* ----------------------------------------------------------------------- */

  const columnOf = (key: string) => columns.find((c) => c.key === key) ?? null

  const currentRaw = (row: PmSheetRow, column: SheetColumn): string =>
    cellValue(row, column, { columns, cells, merged: [], inGroup: false, rowNo: 0, overrides }, null).raw

  /** 사람이 적은 글자를 저장할 값으로. 실패면 이유. */
  const normalize = (column: SheetColumn, text: string): { ok: true; value: string } | { ok: false; reason: string } => {
    const kind = column.spec.kind
    if (kind === 'date') return parseSheetDate(text, true)
    if (kind === 'hour') return parseHour(text)
    if (kind === 'number') {
      const t = text.replace(/,/g, '').trim()
      if (t === '') return { ok: true, value: '' }
      return asNumber(t) === null && !/^0(\.\d+)?$/.test(t)
        ? { ok: false, reason: `'${text}' 는 숫자가 아닙니다.` }
        : { ok: true, value: t }
    }
    if (column.spec.source === 'custom') {
      const t = text.trim()
      if (isFormula(t)) return { ok: true, value: t }
      // 구분자가 있는 날짜(11/13, 11.13, 2026-11-13, 11/13(금))만 날짜로 — 1113 은 숫자일 수 있다.
      if (/[-./]/.test(t) && /^\d/.test(t)) {
        const d = parseSheetDate(t, false)
        if (d.ok && d.value) return d
      }
      return { ok: true, value: t }
    }
    if (column.key === 'pmState' && text && !stateDefs.some((d) => d.name === text)) {
      return { ok: false, reason: `'${text}' 는 진행 상태 목록에 없습니다.` }
    }
    return { ok: true, value: text.trim() }
  }

  /** 저장된 값 `value` 를 서버에 쓴다. 실패하면 throw. */
  const writeValue = async (row: PmSheetRow, column: SheetColumn, value: string) => {
    const key = column.key
    const src = column.spec.source
    if (src === 'custom') {
      await writePmCells(ownerId, [{ jobId: row.jobId, colKey: key, value: value || null }])
    } else if (src === 'row') {
      if (key === 'pmState') {
        const r = await patchPmRow({ staffId: ownerId, jobId: row.jobId, pmState: value || null })
        if (r.prjState) onNotice(`프로젝트 ${row.prjCode} 진행상태가 '${r.prjState}' 로 바뀌었습니다.`)
      } else if (ROW_FIELD_KEYS.has(key)) {
        await patchPmRow({ staffId: ownerId, jobId: row.jobId, fields: { [key]: value } })
      }
    } else if (src === 'job') {
      const input = key === 'jobEday' ? { jobEday: value || null } : { jobEdayTime: value || null }
      await updateJob.mutateAsync({ id: row.jobId, input })
    } else if (src === 'tr' || src === 'rv') {
      const po = src === 'tr' ? row.tr : row.rv
      if (!po) throw new Error('이 작업에는 아직 해당 PO 가 없습니다. 작업 화면에서 PO 를 먼저 발행해 주세요.')
      const field = key.endsWith('Volume') ? 'poVolume' : key.endsWith('Eday') ? 'poEday' : 'poEdayTime'
      await updatePo.mutateAsync({ id: po.poId, input: { [field]: value || null } })
    } else {
      throw new Error('이 칸은 고칠 수 없습니다.')
    }
  }

  /**
   * 여러 칸을 한 번에 (붙여넣기·지우기·채우기도 여기로). 한 번의 실행취소로 되돌아간다.
   * 가제 열은 한 요청으로 묶고, 나머지는 칸마다 보낸다.
   */
  const applyValues = async (changes: { row: PmSheetRow; column: SheetColumn; text: string }[], record = true) => {
    const done: { row: PmSheetRow; column: SheetColumn; before: string; after: string }[] = []
    const customBatch: PmCellWrite[] = []
    const customDone: typeof done = []
    const errors: string[] = []

    for (const { row, column, text } of changes) {
      const parsed = normalize(column, text)
      if (!parsed.ok) {
        errors.push(parsed.reason)
        continue
      }
      const before = currentRaw(row, column)
      if (before === parsed.value) continue
      put(row.jobId, column.key, parsed.value)
      if (column.spec.source === 'custom') {
        customBatch.push({ jobId: row.jobId, colKey: column.key, value: parsed.value || null })
        customDone.push({ row, column, before, after: parsed.value })
        continue
      }
      try {
        await writeValue(row, column, parsed.value)
        done.push({ row, column, before, after: parsed.value })
      } catch (err) {
        drop(row.jobId, column.key)
        errors.push(messageOf(err))
      }
    }
    if (customBatch.length > 0) {
      try {
        await writePmCells(ownerId, customBatch)
        done.push(...customDone)
      } catch (err) {
        for (const c of customBatch) drop(c.jobId, c.colKey)
        errors.push(messageOf(err))
      }
    }
    if (done.length > 0) {
      refresh()
      if (record) {
        pushHistory({
          label: done.length === 1 ? `${done[0]!.column.label} 수정` : `칸 ${String(done.length)}개 수정`,
          undo: () => applyValues(done.map((d) => ({ row: d.row, column: d.column, text: d.before })), false),
          redo: () => applyValues(done.map((d) => ({ row: d.row, column: d.column, text: d.after })), false),
        })
      }
    }
    if (errors.length > 0) onError([...new Set(errors)].join(' / '))
  }

  /* ----------------------------------------------------------------------- */
  /* Styles                                                                  */
  /* ----------------------------------------------------------------------- */

  const scopeLabel =
    selection.cols.length > 0
      ? `열 ${String(selection.cols.length)}개`
      : selection.rows.length > 0
        ? `행 ${String(selection.rows.length)}개`
        : selection.cells.length > 0
          ? `칸 ${String(selection.cells.length)}개`
          : '선택 없음'

  /** null 인 속성은 지운다(물려받음). */
  const cleanStyle = (style: PmStyle): PmStyle => {
    const out: PmStyle = {}
    for (const [k, v] of Object.entries(style)) if (v !== null && v !== undefined) (out as Record<string, unknown>)[k] = v
    return out
  }

  type StyleSnapshot = { cells: { jobId: string; colKey: string; style: PmStyle }[]; rows: { jobId: string; style: PmStyle }[]; cols: Record<string, PmStyle> | null }

  const snapshotStyles = (): StyleSnapshot => ({
    cells: selection.cells.map((c) => ({ ...c, style: cells.get(cellKey(c.jobId, c.colKey))?.style ?? {} })),
    rows: selection.rows.map((jobId) => ({ jobId, style: rowById.get(jobId)?.rowStyle ?? {} })),
    cols: selection.cols.length > 0 ? { ...(prefs.columns?.styles ?? {}) } : null,
  })

  const restoreStyles = async (snap: StyleSnapshot) => {
    if (snap.cells.length > 0) await writePmCells(ownerId, snap.cells.map((c) => ({ jobId: c.jobId, colKey: c.colKey, style: c.style })))
    for (const r of snap.rows) await patchPmRow({ staffId: ownerId, jobId: r.jobId, rowStyle: r.style })
    if (snap.cols) await savePref('columns', { ...(prefs.columns ?? {}), styles: snap.cols })
    refresh()
  }

  /** 고른 범위에 꾸밈을 칠한다. `perCell` 은 칸마다 다른 꾸밈(바깥 테두리). */
  const applyStyle = async (patch: PmStyle, label: string, perCell?: (t: Target) => PmStyle) => {
    if (selection.cells.length + selection.rows.length + selection.cols.length === 0) {
      onError('먼저 칸·행·열을 골라 주세요.')
      return
    }
    const before = snapshotStyles()
    try {
      if (selection.cells.length > 0) {
        await writePmCells(
          ownerId,
          selection.cells.map((c) => ({
            jobId: c.jobId,
            colKey: c.colKey,
            style: cleanStyle({ ...(cells.get(cellKey(c.jobId, c.colKey))?.style ?? {}), ...patch, ...(perCell?.(c) ?? {}) }),
          })),
        )
      }
      for (const jobId of selection.rows) {
        await patchPmRow({ staffId: ownerId, jobId, rowStyle: cleanStyle({ ...(rowById.get(jobId)?.rowStyle ?? {}), ...patch }) })
      }
      if (selection.cols.length > 0) {
        const styles = { ...(prefs.columns?.styles ?? {}) }
        for (const key of selection.cols) styles[key] = cleanStyle({ ...(styles[key] ?? {}), ...patch })
        await savePref('columns', { ...(prefs.columns ?? {}), styles })
      }
      refresh()
      const after = snapshotStyles()
      // `after` 는 칠하기 전 상태로 찍히므로, 다시 하기는 같은 칠하기를 다시 보낸다.
      void after
      const sel = selection
      pushHistory({
        label,
        undo: () => restoreStyles(before),
        redo: async () => {
          const saved = selection
          setSelection(sel)
          await applyStyleWith(sel, patch, perCell)
          setSelection(saved)
        },
      })
    } catch (err) {
      onError(messageOf(err))
    }
  }

  const applyStyleWith = async (sel: typeof selection, patch: PmStyle, perCell?: (t: Target) => PmStyle) => {
    if (sel.cells.length > 0) {
      await writePmCells(
        ownerId,
        sel.cells.map((c) => ({
          jobId: c.jobId,
          colKey: c.colKey,
          style: cleanStyle({ ...(cells.get(cellKey(c.jobId, c.colKey))?.style ?? {}), ...patch, ...(perCell?.(c) ?? {}) }),
        })),
      )
    }
    for (const jobId of sel.rows) {
      await patchPmRow({ staffId: ownerId, jobId, rowStyle: cleanStyle({ ...(rowById.get(jobId)?.rowStyle ?? {}), ...patch }) })
    }
    if (sel.cols.length > 0) {
      const styles = { ...(prefs.columns?.styles ?? {}) }
      for (const key of sel.cols) styles[key] = cleanStyle({ ...(styles[key] ?? {}), ...patch })
      await savePref('columns', { ...(prefs.columns ?? {}), styles })
    }
    refresh()
  }

  /** 지금 칸의 꾸밈(도구막대의 켜짐 표시용). */
  const focusStyle: PmStyle = focus
    ? mergeStyle(
        cells.get(cellKey(focus.jobId, focus.colKey))?.style,
        rowById.get(focus.jobId)?.rowStyle,
        columnOf(focus.colKey)?.style,
      )
    : {}

  const toggle = (prop: 'bold' | 'italic' | 'underline' | 'strike', label: string) =>
    void applyStyle({ [prop]: focusStyle[prop] ? null : true }, label)

  /** 바깥 테두리: 각 칸이 범위의 어느 가장자리에 있는지로 변을 정한다. */
  const outerBorder = () => {
    const edge = new Map<string, string>()
    for (const range of selection.ranges) {
      const rowIds = range.rows.map((r) => String(r.rowId)).filter((id) => rowById.has(id))
      const colIds = range.columns.map((c) => String(c.columnId))
      rowIds.forEach((rid, ri) => {
        colIds.forEach((cid, ci) => {
          let s = ''
          if (ri === 0) s += 't'
          if (ri === rowIds.length - 1) s += 'b'
          if (ci === 0) s += 'l'
          if (ci === colIds.length - 1) s += 'r'
          edge.set(cellKey(rid, cid), s)
        })
      })
    }
    void applyStyle({ border: 'thin' }, '바깥 테두리', (t) => ({ borderSides: edge.get(cellKey(t.jobId, t.colKey)) ?? '' }))
  }

  /* ----------------------------------------------------------------------- */
  /* Undo / redo / shortcuts                                                 */
  /* ----------------------------------------------------------------------- */

  const undo = async () => {
    const entry = history.current.undo.pop()
    if (!entry) return
    history.current.redo.push(entry)
    syncHistory()
    await entry.undo()
    onNotice(`실행취소: ${entry.label}`)
  }
  const redo = async () => {
    const entry = history.current.redo.pop()
    if (!entry) return
    history.current.undo.push(entry)
    syncHistory()
    await entry.redo()
    onNotice(`재실행: ${entry.label}`)
  }

  const insertToday = () => {
    if (!focus) return
    const row = rowById.get(focus.jobId)
    const column = columnOf(focus.colKey)
    if (!row || !column) return
    if (column.spec.kind === 'hour') {
      void applyValues([{ row, column, text: String(new Date().getHours() || 24) }])
    } else void applyValues([{ row, column, text: todayYmd() }])
  }

  const runAction = (action: string) => {
    switch (action) {
      case 'undo':
        return void undo()
      case 'redo':
        return void redo()
      case 'bold':
        return toggle('bold', '굵게')
      case 'italic':
        return toggle('italic', '기울임')
      case 'underline':
        return toggle('underline', '밑줄')
      case 'strike':
        return toggle('strike', '취소선')
      case 'note':
        return focus ? setModal('note') : onError('메모를 달 칸을 먼저 골라 주세요.')
      case 'clearFilters':
        setFilters({})
        return onNotice('필터를 모두 풀었습니다.')
      case 'today':
        return insertToday()
      case 'alignLeft':
        return void applyStyle({ align: 'left' }, '왼쪽 정렬')
      case 'alignCenter':
        return void applyStyle({ align: 'center' }, '가운데 정렬')
      case 'alignRight':
        return void applyStyle({ align: 'right' }, '오른쪽 정렬')
      case 'clearFormat':
        return void applyStyle(
          { bg: null, fg: null, size: null, bold: null, italic: null, underline: null, strike: null, align: null, valign: null, border: null, borderSides: null, decimals: null, wrap: null },
          '서식 지우기',
        )
      case 'todayBar':
        return setTodayOpen((o) => !o)
      default:
        return undefined
    }
  }

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement
    // ReactGrid 는 칸을 고를 때 포커스를 숨은 <input class="rg-hidden-element"> 에 둔다. 그 입력칸까지
    // '글자 입력 중' 으로 보고 건너뛰어서 Ctrl+Z 같은 단축키가 시트에서 먹지 않았다 (2026-11-25).
    // 진짜로 글자를 고치는 칸(칸 편집기·대화상자 입력칸)에서만 건너뛴다 — 거기서 Ctrl+Z 는 글자 되돌리기다.
    const typing =
      (t.tagName === 'INPUT' && !t.classList.contains('rg-hidden-element')) || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
    if (typing) return
    const combo = comboOf(e.nativeEvent)
    if (!combo) return
    const action = Object.entries(shortcuts).find(([, c]) => c === combo)?.[0]
    if (!action) return
    e.preventDefault()
    e.stopPropagation()
    runAction(action)
  }

  /* ----------------------------------------------------------------------- */
  /* Grid wiring                                                             */
  /* ----------------------------------------------------------------------- */

  const onCellsChanged = (changes: CellChange<GridCell>[]) => {
    const list: { row: PmSheetRow; column: SheetColumn; text: string }[] = []
    const free: { pos: number; colKey: string; text: string }[] = []
    for (const change of changes) {
      if (isFreeRowId(String(change.rowId))) {
        const next = change.newCell as unknown as SheetCell
        free.push({ pos: freePosOf(String(change.rowId)), colKey: String(change.columnId), text: next.raw ?? next.text ?? '' })
        continue
      }
      const row = rowById.get(String(change.rowId))
      const column = columnOf(String(change.columnId))
      if (!row || !column || (change.newCell as { type: string }).type !== 'sheet') continue
      const next = change.newCell as unknown as SheetCell
      list.push({ row, column, text: next.raw ?? next.text })
    }
    if (list.length > 0) void applyValues(list)
    if (free.length > 0) writeFree(free)
  }

  const onSelectionChanged = (ranges: Range[]) => {
    const sel: Target[] = []
    const rowsSel = new Set<string>()
    const colsSel = new Set<string>()
    const dataRowCount = dataCount
    for (const range of ranges) {
      const rids = range.rows.map((r) => String(r.rowId)).filter((id) => rowById.has(id))
      const cids = range.columns.map((c) => String(c.columnId))
      if (rids.length === 0 || cids.length === 0) continue
      const wholeCols = rids.length === dataRowCount && dataRowCount > 1
      const wholeRows = cids.length === columns.length && columns.length > 1
      if (wholeCols && !wholeRows) cids.forEach((c) => colsSel.add(c))
      else if (wholeRows) rids.forEach((r) => rowsSel.add(r))
      else for (const r of rids) for (const c of cids) sel.push({ jobId: r, colKey: c })
    }
    setSelection({ cells: sel, rows: [...rowsSel], cols: [...colsSel], ranges })
  }

  const onFocusLocationChanged = (loc: CellLocation) => {
    const jobId = String(loc.rowId)
    const colKey = String(loc.columnId)
    if (!rowById.has(jobId)) return
    setFocus({ jobId, colKey })
    if (colKey === 'translator' || colKey === 'reviewer') {
      setSuggestFor({ jobId, which: colKey === 'translator' ? 'tr' : 'rv', x: mouse.current.x + 14, y: mouse.current.y + 8 })
    } else setSuggestFor(null)
  }

  const persistLayout = (order: string[] | null, widths: Record<string, number> | null) => {
    const current = prefs.columns ?? {}
    void savePref('columns', {
      ...current,
      ...(order ? { order } : {}),
      ...(widths ? { widths: { ...(current.widths ?? {}), ...widths } } : {}),
    })
  }

  const onColumnResized = (columnId: Id, width: number) => persistLayout(null, { [String(columnId)]: Math.round(width) })

  const onColumnsReordered = (targetColumnId: Id, columnIds: Id[], dropPosition: string) => {
    const moving = columnIds.map(String)
    const all = buildColumns({ ...(prefs.columns ?? {}), hidden: [] }).map((c) => c.key)
    const rest = all.filter((k) => !moving.includes(k))
    const target = rest.indexOf(String(targetColumnId))
    const at = target < 0 ? rest.length : dropPosition === 'before' ? target : target + 1
    persistLayout([...rest.slice(0, at), ...moving, ...rest.slice(at)], null)
  }

  /** 행 끌어 옮기기 — 정렬하지 않을 때만. 별도 관리 묶음 안으로 옮기는 방법이다. 빈 줄도 자리 하나로 센다. */
  const onRowsReordered = (targetRowId: Id, rowIds: Id[], dropPosition: string) => {
    const slots = entries.filter((e) => e.kind !== 'month').map((e) => (e.kind === 'data' ? e.row.jobId : e.id))
    let target = String(targetRowId)
    if (target.startsWith('m:')) {
      // 월별 머리행 위에 놓았으면 그 다음 행 자리.
      const idx = entries.findIndex((e) => e.kind === 'month' && e.id === target)
      const next = entries.slice(idx + 1).find((e) => e.kind !== 'month')
      target = next ? (next.kind === 'data' ? next.row.jobId : next.id) : ''
    }
    const moving = rowIds.map(String).filter((id) => slots.includes(id))
    const result = reorderSlots(slots, moving, target, dropPosition === 'before' || !target, freeRows)
    void (async () => {
      try {
        const changed = [...result.jobPos].filter(([jobId, pos]) => rowById.get(jobId)?.ordNo !== pos)
        await Promise.all(changed.map(([jobId, pos]) => patchPmRow({ staffId: ownerId, jobId, ordNo: pos })))
        if (JSON.stringify(result.freeRows) !== JSON.stringify(freeRows)) await savePref('view', { ...(prefs.view ?? {}), freeRows: result.freeRows })
        refresh()
      } catch (err) {
        onError(messageOf(err))
      }
    })()
  }

  /* ----------------------------------------------------------------------- */
  /* Rows to render                                                          */
  /* ----------------------------------------------------------------------- */

  const freezeCols = Math.min(prefs.view?.freezeCols ?? 0, columns.length - 1)
  const freezeRows = prefs.view?.freezeRows ?? 0

  const gridColumns: Column[] = columns.map((c) => ({ columnId: c.key, width: c.width, resizable: true, reorderable: true }))

  const headerRow: Row<GridCell> = {
    rowId: 'header',
    cells: columns.map(
      (c): SheetHeaderCell => ({
        type: 'sheetHeader',
        text: c.label,
        hint: c.spec.hint,
        direction: sort?.key === c.key ? sort.dir : null,
        filtered: (filters[c.key]?.length ?? 0) > 0,
        // 정렬·필터는 우클릭 메뉴로 (팀장님 2026-11-25). 시간 열은 메뉴에 정렬이 없다.
        onMenu: (x, y) => setColMenu({ key: c.key, x, y, jobId: null }),
        onSettings: c.key === 'pmState' ? () => setModal('states') : undefined,
        inner: innerStyle(c.style),
        style: { ...toCellStyle(c.style), background: HEADER_BG },
      }),
    ),
  }

  const today = todayYmd(now)

  const renderRows: Row<GridCell>[] = entries.map((entry): Row<GridCell> => {
    if (entry.kind === 'free') {
      return {
        rowId: entry.id,
        reorderable: !sort,
        cells: columns.map(
          (c): SheetCell => ({
            type: 'sheet',
            text: entry.values[c.key] ?? '',
            raw: entry.values[c.key] ?? '',
            nonEditable: false,
            onMenu: (x: number, y: number) => setColMenu({ key: c.key, x, y, jobId: null }),
          }),
        ),
      }
    }
    if (entry.kind === 'month') {
      return {
        rowId: entry.id,
        reorderable: false,
        cells: columns.map(
          (_c, i): SheetCell => ({
            type: 'sheet',
            text: i === 1 || (i === 0 && columns.length === 1) ? entry.label : '',
            nonEditable: true,
            style: { background: MONTH_COLOR, color: '#FFFFFF' },
            inner: { fontWeight: 700 },
          }),
        ),
      }
    }
    const { row } = entry
    const ctx = { columns, cells, merged: entry.merged, inGroup: entry.inGroup, rowNo: entry.rowNo, overrides }
    const doneRow = isClosedState(row.pmState, stateDefs)
    const read = (key: string) => {
      const col = columnOf(key) ?? FIXED_COLUMNS.map((s) => ({ key: s.key, label: s.label, width: s.width, spec: s, style: {} })).find((c) => c.key === key)
      if (!col) return { raw: '', shown: '' }
      const v = cellValue(row, col, ctx, null)
      return { raw: v.raw, shown: v.shown }
    }
    const isGroupMarker = entry.groupRole !== null
    const highlighted = flash === row.jobId

    return {
      rowId: row.jobId,
      reorderable: !sort,
      cells: columns.map((column, ci): SheetCell => {
        const own = cells.get(cellKey(row.jobId, column.key))
        const manual = mergeStyle(own?.style, row.rowStyle, column.style)
        const v = cellValue(row, column, ctx, manual.decimals)
        let found: string | null = null
        if (column.spec.defaultCf === 'date') found = dayState(v.raw, now)
        else if (column.spec.defaultCf === 'hour') found = hourState(read(column.spec.pairDate ?? '').raw, v.raw, now)
        else if (column.spec.source === 'custom') found = dayState(v.raw, now)
        const state = found === 'today' || found === 'past' || found === 'now' ? found : null
        const cf = conditionalStyle({
          rules,
          colKey: column.key,
          read,
          defaultKind: column.spec.defaultCf ?? (column.spec.source === 'custom' ? 'date' : null),
          defaultState: doneRow ? null : state,
          defaults: defaultsOn,
          now,
        })
        let style = mergeStyle(cf, stateStyleFor(row.pmState, column.key, columnOrder, stateDefs), manual)
        if (isGroupMarker) style = mergeStyle({ bg: GROUP_COLOR, fg: '#FFFFFF', bold: true }, style)
        const editable = isEditable(column, row)
        const po = column.spec.source === 'tr' ? row.tr : column.spec.source === 'rv' ? row.rv : null
        const cellStyle = toCellStyle(style, {
          groupEdge: entry.inGroup ? (ci === 0 ? 'l' : ci === columns.length - 1 ? 'r' : null) : null,
          groupTop: entry.groupRole === 'start',
          groupBottom: entry.groupRole === 'end',
        })
        if (highlighted) cellStyle.background = '#fff59d'
        return {
          type: 'sheet',
          text: column.spec.kind === 'picker' ? v.shown : v.shown,
          raw: v.raw,
          href: v.href,
          internal: v.internal,
          onNavigate: (href) => void navigate(href),
          note: own?.note ?? undefined,
          tooltip: v.tooltip ?? (!editable && column.spec.source !== 'readonly' && !po && (column.spec.source === 'tr' || column.spec.source === 'rv') ? 'PO 가 없습니다 — 작업 화면에서 PO 를 발행하면 여기서 고칠 수 있습니다.' : undefined),
          nonEditable: !editable,
          choices: column.key === 'pmState' ? stateNames : column.key === 'task' ? TASK_OPTIONS : undefined,
          // 진행 상태는 한 번 눌러 바로 목록을 연다 (팀장님 2026-11-25).
          onQuickPick:
            column.key === 'pmState' && editable
              ? (x: number, y: number) => setStateMenu({ jobId: row.jobId, x, y })
              : undefined,
          free: column.key === 'task',
          placeholder: column.spec.kind === 'picker' ? (po ? '미지정' : 'PO 없음') : undefined,
          onOpen:
            column.spec.kind === 'picker' && po
              ? () =>
                  setSwapping({
                    id: po.poId,
                    poCode: po.poCode,
                    poTranName: po.tranName,
                    translatorId: po.translatorId,
                    poCoinCode: po.coinCode ?? 'KRW',
                    poApproved: po.approved,
                    poMoneyState: po.moneyState ?? '미정산',
                  } as SwappableTranslatorPo)
              : undefined,
          style: cellStyle,
          inner: innerStyle(style),
          wrap: style.wrap === 'wrap' || style.wrap === 'clip' ? style.wrap : null,
          onMenu: (x: number, y: number) => setColMenu({ key: column.key, x, y, jobId: row.jobId }),
        }
      }),
    }
  })

  /* 자동 줄바꿈 칸이 있는 행은 글자가 다 보이도록 높인다 (글자 폭은 대략 — 한글 12px, 그 밖 7px). */
  const sizedRows: Row<GridCell>[] = renderRows.map((r) => {
    let lines = 1
    r.cells.forEach((cell, ci) => {
      const c = cell as SheetCell
      if (c.wrap !== 'wrap' || !c.text) return
      const width = Math.max(20, (columns[ci]?.width ?? 100) - 12)
      let total = 0
      for (const para of c.text.split('\n')) {
        let w = 0
        for (const ch of para) w += /[ㄱ-힝]/.test(ch) ? 12.5 : 7
        total += Math.max(1, Math.ceil(w / width))
      }
      lines = Math.max(lines, total)
    })
    return lines > 1 ? { ...r, height: Math.min(lines * LINE_HEIGHT + 9, 400) } : r
  })

  const highlights: Highlight[] = focus && flash ? [{ rowId: flash, columnId: focus.colKey, borderColor: '#FF6D01' }] : []

  /* ----------------------------------------------------------------------- */
  /* Today                                                                   */
  /* ----------------------------------------------------------------------- */

  const todayItems = sheet.rows
    .filter((r) => !r.mergedInto && !isClosedState(r.pmState, stateDefs))
    .flatMap((r) => {
      const items: { row: PmSheetRow; colKey: string; what: string }[] = []
      if (r.tr?.eday === today) items.push({ row: r, colKey: 'trEday', what: '번역본 도착' })
      if (r.rv?.eday === today) items.push({ row: r, colKey: 'rvEday', what: '감수본 도착' })
      if (r.jobEday === today) items.push({ row: r, colKey: 'jobEday', what: '납품' })
      return items
    })

  const goTo = (jobId: string, colKey: string) => {
    if (!entries.some((e) => e.kind === 'data' && e.row.jobId === jobId)) {
      setFilters({})
      onNotice('필터에 가려진 행이라 필터를 풀었습니다.')
    }
    setFocusLocation({ rowId: jobId, columnId: colKey })
    setFocus({ jobId, colKey })
    setFlash(jobId)
    window.setTimeout(() => setFlash((f) => (f === jobId ? null : f)), 3000)
  }

  /* ----------------------------------------------------------------------- */
  /* Row operations                                                          */
  /* ----------------------------------------------------------------------- */

  const selectedRowIds = (): string[] => {
    const ids = new Set<string>(selection.rows)
    for (const c of selection.cells) ids.add(c.jobId)
    if (ids.size === 0 && focus) ids.add(focus.jobId)
    return [...ids]
  }

  const mergeRows = async () => {
    const ids = selectedRowIds()
    const ordered = entries.filter((e): e is DataEntry => e.kind === 'data' && ids.includes(e.row.jobId)).map((e) => e.row)
    const problem = mergeProblem(ordered)
    if (problem) return onError(problem)
    const [head, ...rest] = ordered
    try {
      for (const r of rest) await patchPmRow({ staffId: ownerId, jobId: r.jobId, mergedInto: head!.jobId })
      refresh()
      onNotice(`${String(ordered.length)}개 행을 한 행으로 통합했습니다. (번역어: ${ordered.map((r) => r.elang ?? '').join('·')})`)
      pushHistory({
        label: '행 통합',
        undo: async () => {
          for (const r of rest) await patchPmRow({ staffId: ownerId, jobId: r.jobId, mergedInto: null })
          refresh()
        },
        redo: async () => {
          for (const r of rest) await patchPmRow({ staffId: ownerId, jobId: r.jobId, mergedInto: head!.jobId })
          refresh()
        },
      })
    } catch (err) {
      onError(messageOf(err))
    }
  }

  const unmergeRows = async () => {
    const ids = selectedRowIds()
    const members = sheet.rows.filter((r) => r.mergedInto && ids.includes(r.mergedInto))
    if (members.length === 0) return onError('통합된 행을 골라 주세요.')
    try {
      for (const r of members) await patchPmRow({ staffId: ownerId, jobId: r.jobId, mergedInto: null })
      refresh()
      onNotice('통합을 풀었습니다.')
    } catch (err) {
      onError(messageOf(err))
    }
  }

  const focusRow = focus ? rowById.get(focus.jobId) : undefined

  /** 우클릭한 칸의 보이는 값 (빈 칸은 '(빈 칸)'). 머리글에서 열었으면 null. */
  const menuValue = (m: { key: string; jobId: string | null }): string | null => {
    if (!m.jobId) return null
    const row = rowById.get(m.jobId)
    const column = columnOf(m.key)
    if (!row || !column) return null
    const shown = cellValue(row, column, { columns, cells, merged: [], inGroup: false, rowNo: 0, overrides }, decimalsOf(row, column)).shown
    return shown === '' ? BLANK : shown
  }

  const toggleMonthly = async () => {
    if (!focusRow) return
    try {
      await patchPmRow({ staffId: ownerId, jobId: focusRow.jobId, groupMonthly: !focusRow.groupMonthly })
      refresh()
    } catch (err) {
      onError(messageOf(err))
    }
  }

  const hideRows = async () => {
    const ids = selectedRowIds()
    if (ids.length === 0) return
    if (!window.confirm(`고른 ${String(ids.length)}개 행을 이 시트에서 뺄까요? (TMS 의 작업은 그대로이고, 다시 인계 받으면 돌아옵니다)`)) return
    try {
      for (const jobId of ids) await patchPmRow({ staffId: ownerId, jobId, hidden: true })
      refresh()
      pushHistory({
        label: '행 빼기',
        undo: async () => {
          for (const jobId of ids) await patchPmRow({ staffId: ownerId, jobId, hidden: false })
          refresh()
        },
        redo: async () => {
          for (const jobId of ids) await patchPmRow({ staffId: ownerId, jobId, hidden: true })
          refresh()
        },
      })
    } catch (err) {
      onError(messageOf(err))
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Filter favourites                                                       */
  /* ----------------------------------------------------------------------- */

  const favorites = prefs.filters?.favorites ?? []
  const activeFav = favorites.find((f) => JSON.stringify(f.filters) === JSON.stringify(filters))
  const saveFavorite = () => {
    if (Object.values(filters).every((v) => v.length === 0)) return onError('먼저 필터를 걸어 주세요.')
    if (favorites.length >= 3) return onError('필터 즐겨찾기는 3개까지입니다. 하나를 지우고 다시 해 주세요.')
    const label = window.prompt('즐겨찾기 버튼 이름', `필터 ${String(favorites.length + 1)}`)
    if (!label) return
    void savePref('filters', { favorites: [...favorites, { id: String(Date.now()), label: label.slice(0, 20), filters }] })
  }

  /* ----------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ----------------------------------------------------------------------- */

  const can = { undo: histSize.undo > 0, redo: histSize.redo > 0 }
  const focusColumn = focus ? columnOf(focus.colKey) : null

  return (
    <div onKeyDownCapture={onKeyDownCapture} onMouseMove={(e) => (mouse.current = { x: e.clientX, y: e.clientY })}>
      {/* 도구막대 */}
      <div className={css.toolbar}>
        <span className={css.group}>
          <button type="button" className={css.tool} disabled={!can.undo} title={`실행취소 (${shortcuts.undo ?? ''})`} onClick={() => void undo()}>↶</button>
          <button type="button" className={css.tool} disabled={!can.redo} title={`재실행 (${shortcuts.redo ?? ''})`} onClick={() => void redo()}>↷</button>
        </span>
        <span className={css.group}>
          <select className={css.toolSelect} title="글자 크기" value={focusStyle.size ?? ''} onChange={(e) => void applyStyle({ size: e.target.value ? Number(e.target.value) : null }, '글자 크기')}>
            <option value="">크기</option>
            {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button type="button" className={`${css.tool} ${focusStyle.bold ? css.toolOn : ''}`} title={`굵게 (${shortcuts.bold ?? ''})`} onClick={() => toggle('bold', '굵게')}><b>B</b></button>
          <button type="button" className={`${css.tool} ${focusStyle.italic ? css.toolOn : ''}`} title={`기울임 (${shortcuts.italic ?? ''})`} onClick={() => toggle('italic', '기울임')}><i>I</i></button>
          <button type="button" className={`${css.tool} ${focusStyle.underline ? css.toolOn : ''}`} title={`밑줄 (${shortcuts.underline ?? ''})`} onClick={() => toggle('underline', '밑줄')}><u>U</u></button>
          <button type="button" className={`${css.tool} ${focusStyle.strike ? css.toolOn : ''}`} title={`취소선 (${shortcuts.strike ?? ''})`} onClick={() => toggle('strike', '취소선')}><s>S</s></button>
        </span>
        <span className={css.group}>
          <ColorPalette
            title="글자색"
            value={focusStyle.fg}
            noneLabel="자동 (색 지우기)"
            button={<span className={css.inkBar}><b>가</b><i style={{ background: focusStyle.fg ?? '#000000' }} /></span>}
            onPick={(c) => void applyStyle({ fg: c }, c ? '글자색' : '글자색 지우기')}
          />
          <ColorPalette
            title="칸 색"
            value={focusStyle.bg}
            noneLabel="채우기 없음"
            button={<span className={css.inkBar}><span aria-hidden="true">🪣</span><i style={{ background: focusStyle.bg ?? '#FFFFFF', border: '1px solid #d0d0d0' }} /></span>}
            onPick={(c) => void applyStyle({ bg: c }, c ? '칸 색' : '칸 색 지우기')}
          />
        </span>
        <span className={css.group}>
          <select className={css.toolSelect} title="테두리" value="" onChange={(e) => {
            const v = e.target.value
            if (v === 'outer') outerBorder()
            else if (v === 'none') void applyStyle({ border: null, borderSides: null }, '테두리 지우기')
            else if (v) {
              const [weight, sides] = v.split(':') as ['thin' | 'thick', string]
              void applyStyle({ border: weight, borderSides: sides }, '테두리')
            }
          }}>
            <option value="">테두리</option>
            <option value="thin:tblr">모든 테두리</option>
            <option value="outer">바깥 테두리</option>
            <option value="thin:b">아래 테두리</option>
            <option value="thick:tblr">굵은 테두리</option>
            <option value="none">테두리 없음</option>
          </select>
          <IconMenu title="가로 정렬" icons={ALIGN_ICONS} value={focusStyle.align ?? 'left'} onPick={(k) => void applyStyle({ align: k }, '가로 정렬')} />
          <IconMenu title="세로 정렬" icons={VALIGN_ICONS} value={focusStyle.valign ?? 'middle'} onPick={(k) => void applyStyle({ valign: k }, '세로 정렬')} />
          <IconMenu title="텍스트 줄바꿈" icons={WRAP_ICONS} value={focusStyle.wrap ?? 'overflow'} onPick={(k) => void applyStyle({ wrap: k === 'overflow' ? null : k }, '텍스트 줄바꿈')} />
          <select className={css.toolSelect} title="소수 자리" value={focusStyle.decimals ?? ''} onChange={(e) => void applyStyle({ decimals: e.target.value === '' ? null : Number(e.target.value) }, '소수 자리')}>
            <option value="">소수</option>
            {[0, 1, 2, 3, 4].map((d) => <option key={d} value={d}>{d === 0 ? '0,000' : `0,000.${'0'.repeat(d)}`}</option>)}
          </select>
          <button type="button" className={css.tool} title={`메모 (${shortcuts.note ?? ''})`} onClick={() => runAction('note')}>메모</button>
          <button type="button" className={css.tool} title="서식 지우기" onClick={() => runAction('clearFormat')}>서식✕</button>
        </span>
        <span className={css.group}>
          <button type="button" className={css.tool} onClick={() => setModal('cf')}>조건부 서식</button>
          <button type="button" className={css.tool} onClick={() => setModal('columns')}>열 관리</button>
          <button type="button" className={css.tool} onClick={() => setModal('shortcuts')}>단축키</button>
          <select className={css.toolSelect} title="열 고정" value={freezeCols} onChange={(e) => void savePref('view', { ...(prefs.view ?? {}), freezeCols: Number(e.target.value) })}>
            {[0, 1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n === 0 ? '열 고정 없음' : `열 ${String(n)}개 고정`}</option>)}
          </select>
          <select className={css.toolSelect} title="행 고정" value={freezeRows} onChange={(e) => void savePref('view', { ...(prefs.view ?? {}), freezeRows: Number(e.target.value) })}>
            {[0, 1, 2, 3, 5].map((n) => <option key={n} value={n}>{n === 0 ? '머리행만 고정' : `행 ${String(n)}개 더 고정`}</option>)}
          </select>
        </span>
        <span className={css.group}>
          <button type="button" className={css.tool} title="고른 행(같은 프로젝트·업체·담당자·납기·경로, 언어만 다른 행)을 한 행으로" onClick={() => void mergeRows()}>행 통합</button>
          <button type="button" className={css.tool} onClick={() => void unmergeRows()}>통합 해제</button>
          {focusRow?.pmState === GROUP_START ? (
            <label className={css.tool} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title="인계일 기준 월별 머리행을 넣습니다">
              <input type="checkbox" checked={focusRow.groupMonthly} onChange={() => void toggleMonthly()} />
              월별 정리
            </label>
          ) : null}
          <button type="button" className={css.tool} title="고른 행을 이 시트에서 뺍니다" onClick={() => void hideRows()}>행 빼기</button>
        </span>
        <span className={css.group}>
          {favorites.map((f) => (
            <span key={f.id} className={css.fav}>
              <button type="button" className={`${css.favBtn} ${activeFav?.id === f.id ? css.favOn : ''}`} onClick={() => setFilters(activeFav?.id === f.id ? {} : f.filters)}>{f.label}</button>
              <button type="button" className={css.favX} title="즐겨찾기 지우기" onClick={() => void savePref('filters', { favorites: favorites.filter((x) => x.id !== f.id) })}>×</button>
            </span>
          ))}
          <button type="button" className={css.tool} title="지금 걸린 필터를 버튼으로 저장 (최대 3개)" onClick={saveFavorite}>☆ 필터 저장</button>
          {Object.values(filters).some((v) => v.length > 0) ? (
            <button type="button" className={css.tool} onClick={() => setFilters({})}>필터 해제</button>
          ) : null}
        </span>
        <span className={css.scope}>{scopeLabel}{focusColumn ? ` · ${focusColumn.label}` : ''}</span>
      </div>

      {/* 오늘 할 일 */}
      <div className={css.today}>
        <button type="button" className={css.todayHead} onClick={() => setTodayOpen((o) => !o)}>
          <span>{todayOpen ? '▾' : '▸'}</span>
          <b>오늘 할 일</b>
          {todayItems.length > 0 ? <span className={css.badge}>{todayItems.length}</span> : <span className={css.small}>없음</span>}
          <span className={css.small} style={{ marginLeft: 'auto' }}>{formatSheetDate(today)} · 진행 상태가 납품 완료·홀딩/캔슬인 행은 빼고 셉니다</span>
        </button>
        {todayOpen && todayItems.length > 0 ? (
          <div className={css.todayList}>
            {todayItems.map((item) => (
              <button key={`${item.row.jobId}-${item.colKey}`} type="button" className={css.todayItem} onClick={() => goTo(item.row.jobId, item.colKey)}>
                <span className={css.todayWhat}>{item.what}</span>
                <span>{item.row.cusCodeName ?? ''}</span>
                <span>{item.row.jobName ?? ''}</span>
                <span>{[item.row.slang, item.row.elang].filter(Boolean).join('→')}</span>
                <span className={css.small}>{item.row.prjCode}</span>
                <span className={css.small}>{item.row.pmState ?? ''}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {/* 시트 */}
      <div className={css.gridWrap} ref={gridBox} style={gridHeight ? { height: gridHeight, maxHeight: 'none' } : undefined}>
        {dataCount === 0 ? (
          <p style={{ padding: 16 }}>
            {sheet.rows.length === 0 ? '이 시트에 아직 작업이 없습니다. "인계" 탭에서 인계를 받으면 여기에 들어옵니다.' : '필터에 맞는 행이 없습니다.'}
          </p>
        ) : null}
        <ReactGrid
          rows={[headerRow, ...sizedRows]}
          columns={gridColumns}
          customCellTemplates={{ sheet: new SheetCellTemplate(), sheetHeader: new SheetHeaderTemplate() }}
          onCellsChanged={onCellsChanged as unknown as (changes: CellChange[]) => void}
          onSelectionChanged={onSelectionChanged}
          onFocusLocationChanged={onFocusLocationChanged}
          onColumnResized={onColumnResized}
          onColumnsReordered={onColumnsReordered}
          onRowsReordered={onRowsReordered}
          canReorderRows={(target) => !sort && (rowById.has(String(target)) || String(target).startsWith('m:') || isFreeRowId(String(target)))}
          focusLocation={focusLocation}
          highlights={highlights}
          stickyTopRows={1 + Math.min(freezeRows, renderRows.length)}
          stickyLeftColumns={freezeCols}
          enableRangeSelection
          enableRowSelection
          enableColumnSelection
          enableFillHandle
          enableColumnResizeOnAllHeaders
          moveRightOnEnter
        />
      </div>

      {filterPop ? (
        <FilterPopover
          key={filterPop.key}
          x={filterPop.x}
          y={filterPop.y}
          label={columnOf(filterPop.key)?.label ?? ''}
          values={distinctValues(sheet.rows.filter((r) => !r.mergedInto), columnOf(filterPop.key)!, columns, cells, overrides)}
          selected={filters[filterPop.key] ?? []}
          onApply={(vals) => {
            setFilters((f) => ({ ...f, [filterPop.key]: vals }))
            setFilterPop(null)
          }}
          sortable={columnOf(filterPop.key)?.spec.kind !== 'hour'}
          onSort={(dir) => {
            setSort(dir ? { key: filterPop.key, dir } : null)
            setFilterPop(null)
          }}
          onClose={() => setFilterPop(null)}
        />
      ) : null}

      {suggestFor ? (
        <TranslatorSuggest
          jobId={suggestFor.jobId}
          x={suggestFor.x}
          y={suggestFor.y}
          which={suggestFor.which}
          row={rowById.get(suggestFor.jobId)}
          onPick={async (translatorId, name) => {
            const row = rowById.get(suggestFor.jobId)
            const po = suggestFor.which === 'tr' ? row?.tr : row?.rv
            if (!po) return onError('PO 가 없어 번역가를 지정할 수 없습니다. 작업 화면에서 PO 를 먼저 발행해 주세요.')
            try {
              await updatePo.mutateAsync({ id: po.poId, input: { translatorId } })
              onNotice(`${name} 님을 지정했습니다.`)
              setSuggestFor(null)
            } catch (err) {
              onError(messageOf(err))
            }
          }}
          onClose={() => setSuggestFor(null)}
        />
      ) : null}

      {modal === 'cf' ? (
        <CondFormatModal
          columns={columns}
          rules={rules}
          defaults={defaultsOn}
          onClose={() => setModal(null)}
          onSave={(next, defaults) => {
            void savePref('cf', { rules: next, defaults })
            setModal(null)
            onNotice('조건부 서식을 저장했습니다.')
          }}
        />
      ) : null}
      {modal === 'shortcuts' ? (
        <ShortcutsModal
          current={shortcuts}
          onClose={() => setModal(null)}
          onSave={(map) => {
            void savePref('shortcuts', { map })
            setModal(null)
            onNotice('단축키를 저장했습니다.')
          }}
        />
      ) : null}
      {modal === 'states' ? (
        <StatesModal
          states={stateDefs}
          columns={columns}
          onClose={() => setModal(null)}
          onSave={(states) => {
            void savePref('columns', { ...(prefs.columns ?? {}), states })
            setModal(null)
            onNotice('진행 상태 설정을 저장했습니다. (내 시트에만 적용)')
          }}
        />
      ) : null}
      {colMenu ? (
        <ColumnMenu
          x={colMenu.x}
          y={colMenu.y}
          label={columnOf(colMenu.key)?.label ?? ''}
          sortable={columnOf(colMenu.key)?.spec.kind !== 'hour'}
          sort={sort?.key === colMenu.key ? sort.dir : null}
          filtered={(filters[colMenu.key]?.length ?? 0) > 0}
          anyFilter={Object.values(filters).some((v) => v.length > 0)}
          value={menuValue(colMenu)}
          onClose={() => setColMenu(null)}
          onSort={(dir) => {
            setSort(dir ? { key: colMenu.key, dir } : null)
            setColMenu(null)
          }}
          onFilterDialog={() => {
            setFilterPop({ key: colMenu.key, x: colMenu.x, y: colMenu.y })
            setColMenu(null)
          }}
          onOnly={(value) => {
            setFilters((f) => ({ ...f, [colMenu.key]: [value] }))
            setColMenu(null)
          }}
          onExcept={(value) => {
            const column = columnOf(colMenu.key)
            if (column) {
              const all = distinctValues(sheet.rows.filter((r) => !r.mergedInto), column, columns, cells, overrides)
              const current = filters[colMenu.key]?.length ? filters[colMenu.key]! : all
              const next = current.filter((v) => v !== value)
              setFilters((f) => ({ ...f, [colMenu.key]: next.length > 0 ? next : ['\u0000'] }))
            }
            setColMenu(null)
          }}
          onClearThis={() => {
            setFilters((f) => ({ ...f, [colMenu.key]: [] }))
            setColMenu(null)
          }}
          onClearAll={() => {
            setFilters({})
            setColMenu(null)
          }}
        />
      ) : null}
      {stateMenu ? (
        <StateMenu
          x={stateMenu.x}
          y={stateMenu.y}
          defs={stateDefs.filter((d) => !d.hidden)}
          current={rowById.get(stateMenu.jobId)?.pmState ?? null}
          onClose={() => setStateMenu(null)}
          onPick={(name) => {
            const row = rowById.get(stateMenu.jobId)
            const column = columnOf('pmState')
            setStateMenu(null)
            if (row && column) void applyValues([{ row, column, text: name }])
          }}
        />
      ) : null}
      {modal === 'columns' ? (
        <ColumnsModal
          pref={prefs.columns ?? {}}
          onClose={() => setModal(null)}
          onSave={(next) => {
            void savePref('columns', next)
            setModal(null)
            onNotice('열 구성을 저장했습니다.')
          }}
        />
      ) : null}
      {modal === 'note' && focus ? (
        <NoteModal
          title={`${columnOf(focus.colKey)?.label ?? ''} · ${rowById.get(focus.jobId)?.jobName ?? ''}`}
          initial={cells.get(cellKey(focus.jobId, focus.colKey))?.note ?? ''}
          onClose={() => setModal(null)}
          onSave={async (note) => {
            const target = focus
            const before = cells.get(cellKey(target.jobId, target.colKey))?.note ?? ''
            try {
              await writePmCells(ownerId, [{ jobId: target.jobId, colKey: target.colKey, note: note || null }])
              refresh()
              setModal(null)
              pushHistory({
                label: '메모',
                undo: async () => {
                  await writePmCells(ownerId, [{ jobId: target.jobId, colKey: target.colKey, note: before || null }])
                  refresh()
                },
                redo: async () => {
                  await writePmCells(ownerId, [{ jobId: target.jobId, colKey: target.colKey, note: note || null }])
                  refresh()
                },
              })
            } catch (err) {
              onError(messageOf(err))
            }
          }}
        />
      ) : null}
      {swapping ? (
        <TranslatorSwapModal
          purchaseOrder={swapping}
          onClose={() => setSwapping(null)}
          onSaved={(m) => {
            onNotice(m)
            refresh()
          }}
        />
      ) : null}
    </div>
  )

  function isEditable(column: SheetColumn, row: PmSheetRow): boolean {
    const src = column.spec.source
    if (src === 'readonly') return false
    if (column.spec.kind === 'picker') return false
    if (src === 'tr') return !!row.tr
    if (src === 'rv') return !!row.rv
    return true
  }
}

/* -------------------------------------------------------------------------- */
/* Small parts                                                                */
/* -------------------------------------------------------------------------- */

function FilterPopover(props: {
  x: number
  y: number
  label: string
  values: string[]
  selected: string[]
  onApply: (values: string[]) => void
  sortable: boolean
  onSort: (dir: 'asc' | 'desc' | null) => void
  onClose: () => void
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set(props.selected.length > 0 ? props.selected : props.values))
  const [search, setSearch] = useState('')
  const shown = props.values.filter((v) => v.toLowerCase().includes(search.toLowerCase()))
  const left = Math.min(props.x, window.innerWidth - 270)
  return (
    <div className={css.popover} style={{ left, top: props.y + 4 }} onMouseDown={(e) => e.stopPropagation()}>
      <div className={css.popHead}>
        <b>{props.label}</b>
        {props.sortable ? (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <button type="button" className={css.tool} onClick={() => props.onSort('asc')}>오름차순 ▲</button>
            <button type="button" className={css.tool} onClick={() => props.onSort('desc')}>내림차순 ▼</button>
            <button type="button" className={css.tool} onClick={() => props.onSort(null)}>원래대로</button>
          </div>
        ) : null}
        <input className={css.toolSelect} placeholder="값 검색" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className={css.tool} onClick={() => setPicked(new Set(props.values))}>모두 선택</button>
          <button type="button" className={css.tool} onClick={() => setPicked(new Set())}>모두 해제</button>
        </div>
      </div>
      <div className={css.popList}>
        {shown.map((v) => (
          <label key={v} className={css.popItem}>
            <input
              type="checkbox"
              checked={picked.has(v)}
              onChange={() => {
                const next = new Set(picked)
                if (next.has(v)) next.delete(v)
                else next.add(v)
                setPicked(next)
              }}
            />
            <span>{v === BLANK ? <i>{v}</i> : v}</span>
          </label>
        ))}
      </div>
      <div className={css.popFoot}>
        <button type="button" className={css.tool} onClick={props.onClose}>닫기</button>
        <button type="button" className={css.tool} onClick={() => props.onApply([])}>필터 해제</button>
        <button
          type="button"
          className={`${css.tool} ${css.toolOn}`}
          onClick={() => props.onApply(picked.size === props.values.length ? [] : [...picked])}
        >
          적용
        </button>
      </div>
    </div>
  )
}

/** 우클릭 메뉴 — 정렬, 필터, (칸에서 열었으면) 이 값만 보기 / 이 값 빼고 보기. */
function ColumnMenu(props: {
  x: number
  y: number
  label: string
  sortable: boolean
  sort: 'asc' | 'desc' | null
  filtered: boolean
  anyFilter: boolean
  value: string | null
  onClose: () => void
  onSort: (dir: 'asc' | 'desc' | null) => void
  onFilterDialog: () => void
  onOnly: (value: string) => void
  onExcept: (value: string) => void
  onClearThis: () => void
  onClearAll: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const { onClose } = props
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  const left = Math.min(props.x, window.innerWidth - 240)
  const top = Math.min(props.y, window.innerHeight - 330)
  const short = (v: string) => (v.length > 16 ? `${v.slice(0, 16)}…` : v)
  return (
    <div ref={box} className={css.ctxMenu} style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      <div className={css.ctxHead}>{props.label}</div>
      {props.sortable ? (
        <>
          <button type="button" className={`${css.ctxItem} ${props.sort === 'asc' ? css.ctxOn : ''}`} onClick={() => props.onSort('asc')}>▲ 오름차순 정렬</button>
          <button type="button" className={`${css.ctxItem} ${props.sort === 'desc' ? css.ctxOn : ''}`} onClick={() => props.onSort('desc')}>▼ 내림차순 정렬</button>
          <button type="button" className={css.ctxItem} disabled={!props.sort} onClick={() => props.onSort(null)}>↺ 원래 순서로</button>
          <div className={css.ctxSep} />
        </>
      ) : null}
      {props.value !== null ? (
        <>
          <button type="button" className={css.ctxItem} onClick={() => props.onOnly(props.value!)}>이 값만 보기: <b>{short(props.value)}</b></button>
          <button type="button" className={css.ctxItem} onClick={() => props.onExcept(props.value!)}>이 값 빼고 보기: <b>{short(props.value)}</b></button>
        </>
      ) : null}
      <button type="button" className={css.ctxItem} onClick={props.onFilterDialog}>필터…</button>
      <button type="button" className={css.ctxItem} disabled={!props.filtered} onClick={props.onClearThis}>이 열 필터 해제</button>
      <button type="button" className={css.ctxItem} disabled={!props.anyFilter} onClick={props.onClearAll}>모든 필터 해제</button>
    </div>
  )
}

/** 진행 상태 — 한 번 누르면 펼쳐지는 목록. 상태마다 그 색으로 보인다. */
function StateMenu(props: {
  x: number
  y: number
  defs: PmStateDef[]
  current: string | null
  onPick: (name: string) => void
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const { onClose } = props
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  const top = Math.min(props.y + 2, window.innerHeight - 370)
  const left = Math.min(props.x, window.innerWidth - 200)
  return (
    <div ref={box} className={css.stateMenu} style={{ left, top }}>
      <button type="button" className={css.stateItem} style={{ background: '#fff', color: '#6b7280' }} onClick={() => props.onPick('')}>
        (비우기)
      </button>
      {props.defs.map((d) => (
        <button
          key={d.name}
          type="button"
          className={`${css.stateItem} ${d.name === props.current ? css.stateItemOn : ''}`}
          style={{ background: d.bg ?? '#fff', color: d.fg ?? undefined, fontWeight: d.bold ? 700 : undefined }}
          onClick={() => props.onPick(d.name)}
        >
          {d.name}
        </button>
      ))}
    </div>
  )
}

function TranslatorSuggest(props: {
  jobId: string
  which: 'tr' | 'rv'
  x: number
  y: number
  row: PmSheetRow | undefined
  onPick: (translatorId: string, name: string) => Promise<void>
  onClose: () => void
}) {
  const q = useTranslatorSuggestions(props.jobId)
  const items = q.data ?? []
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(props.onClose, 15000)
    return () => window.clearTimeout(t)
  }, [props.onClose])
  if (q.isLoading || items.length === 0) return null
  const left = Math.min(props.x, window.innerWidth - 300)
  const top = Math.min(props.y, window.innerHeight - 260)
  return (
    <div className={css.suggest} style={{ left, top }} onMouseDown={(e) => e.stopPropagation()}>
      <div className={css.suggestHead}>
        <span>💡 추천 {props.which === 'tr' ? '번역가' : '감수자'} — 같은 업체·같은 언어쌍</span>
        <button type="button" className={css.tool} onClick={props.onClose}>×</button>
      </div>
      {items.map((s) => (
        <button
          key={s.translatorId}
          type="button"
          className={css.suggestItem}
          disabled={busy}
          title={(props.which === 'tr' ? props.row?.tr : props.row?.rv) ? '누르면 이 PO 의 번역가로 지정합니다' : 'PO 가 없어 지정할 수 없습니다'}
          onClick={async () => {
            setBusy(true)
            await props.onPick(s.translatorId, s.name)
            setBusy(false)
          }}
        >
          <b>{s.name}</b>
          <span className={css.suggestSub}>
            이전 인계일 {s.lastHandoverAt ? formatSheetDate(isoToYmd(s.lastHandoverAt)) : '-'} · {s.prjCode ?? ''} · {s.times}회
          </span>
        </button>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Style helpers                                                              */
/* -------------------------------------------------------------------------- */

function toCellStyle(
  style: PmStyle,
  group?: { groupEdge: 'l' | 'r' | null; groupTop: boolean; groupBottom: boolean },
): CellStyle & { background?: string } {
  const out: Record<string, unknown> = {}
  if (style.bg) out.background = style.bg
  if (style.fg) out.color = style.fg
  if (style.border && style.border !== 'none' && style.borderSides) {
    const b = { color: style.borderColor ?? '#000000', width: style.border === 'thick' ? '2px' : '1px', style: 'solid' }
    const border: Record<string, unknown> = {}
    if (style.borderSides.includes('t')) border.top = b
    if (style.borderSides.includes('b')) border.bottom = b
    if (style.borderSides.includes('l')) border.left = b
    if (style.borderSides.includes('r')) border.right = b
    out.border = border
  }
  if (group && (group.groupEdge || group.groupTop || group.groupBottom)) {
    const g = { color: GROUP_COLOR, width: '3px', style: 'solid' }
    const border = { ...((out.border as Record<string, unknown>) ?? {}) }
    if (group.groupEdge === 'l') border.left = g
    if (group.groupEdge === 'r') border.right = g
    if (group.groupTop) border.top = g
    if (group.groupBottom) border.bottom = g
    out.border = border
  }
  return out as CellStyle & { background?: string }
}

function innerStyle(style: PmStyle): CSSProperties {
  const out: CSSProperties = {}
  if (style.bold) out.fontWeight = 700
  if (style.italic) out.fontStyle = 'italic'
  const deco = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ')
  if (deco) out.textDecoration = deco
  if (style.size) out.fontSize = `${String(style.size)}px`
  if (style.align) out.justifyContent = style.align === 'left' ? 'flex-start' : style.align === 'center' ? 'center' : 'flex-end'
  if (style.align) out.textAlign = style.align
  if (style.valign) out.alignItems = style.valign === 'top' ? 'flex-start' : style.valign === 'middle' ? 'center' : 'flex-end'
  return out
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message
  return '저장하지 못했습니다.'
}

export { ACTIONS, GROUP_END }
