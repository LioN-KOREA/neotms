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
  PM_STATES,
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
  mergeProblem,
  type DataEntry,
  type Filters,
  type SortState,
} from './sheetModel'
import { CondFormatModal, ColumnsModal, NoteModal, ShortcutsModal } from './PmSheetModals'
import { ACTIONS, comboOf, effectiveShortcuts } from './shortcuts'
import css from './PmSheet.module.css'

const FILLS = ['#FFF2CC', '#D9EAD3', '#CFE2F3', '#F4CCCC', '#FCE5CD', '#EAD1DC', '#EFEFEF', '#FF9900', '#3271EA', '#990000']
const INKS = ['#000000', '#CC0000', '#1155CC', '#38761D', '#B45F06', '#777777', '#FFFFFF']
const SIZES = [9, 10, 11, 12, 13, 14, 16, 18, 20]
const GROUP_COLOR = '#990000'
const MONTH_COLOR = '#FF6D01'
const DONE_STATES = new Set(['납품 완료', '홀딩/캔슬'])

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
  const [modal, setModal] = useState<'cf' | 'shortcuts' | 'columns' | 'note' | null>(null)
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

  const entries = buildEntries({ rows: sheet.rows, columns, cells, sort, filters, overrides, decimalsOf })

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
    if (column.key === 'pmState' && text && !(PM_STATES as readonly string[]).includes(text)) {
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
          { bg: null, fg: null, size: null, bold: null, italic: null, underline: null, strike: null, align: null, valign: null, border: null, borderSides: null, decimals: null },
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
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
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
    for (const change of changes) {
      const row = rowById.get(String(change.rowId))
      const column = columnOf(String(change.columnId))
      if (!row || !column || (change.newCell as { type: string }).type !== 'sheet') continue
      const next = change.newCell as unknown as SheetCell
      list.push({ row, column, text: next.raw ?? next.text })
    }
    if (list.length > 0) void applyValues(list)
  }

  const onSelectionChanged = (ranges: Range[]) => {
    const sel: Target[] = []
    const rowsSel = new Set<string>()
    const colsSel = new Set<string>()
    const dataRowCount = entries.filter((e) => e.kind === 'data').length
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

  /** 행 끌어 옮기기 — 정렬하지 않을 때만. 별도 관리 묶음 안으로 옮기는 방법이다. */
  const onRowsReordered = (targetRowId: Id, rowIds: Id[], dropPosition: string) => {
    const dataIds = entries.filter((e): e is DataEntry => e.kind === 'data').map((e) => e.row.jobId)
    const moving = rowIds.map(String).filter((id) => rowById.has(id))
    const rest = dataIds.filter((id) => !moving.includes(id))
    let target = rest.indexOf(String(targetRowId))
    if (target < 0) {
      // 월별 머리행 위에 놓았으면 그 다음 데이터 행 자리.
      const idx = entries.findIndex((e) => e.kind === 'month' && e.id === String(targetRowId))
      const nextData = entries.slice(idx + 1).find((e): e is DataEntry => e.kind === 'data')
      target = nextData ? rest.indexOf(nextData.row.jobId) : rest.length
    }
    const at = dropPosition === 'before' ? target : target + 1
    const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)]
    void (async () => {
      try {
        await Promise.all(order.map((jobId, i) => (rowById.get(jobId)?.ordNo === i ? null : patchPmRow({ staffId: ownerId, jobId, ordNo: i }))))
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
        onSort: () =>
          setSort((s) => (s?.key === c.key ? (s.dir === 'asc' ? { key: c.key, dir: 'desc' } : null) : { key: c.key, dir: 'asc' })),
        onFilter: (x, y) => setFilterPop({ key: c.key, x, y }),
        inner: innerStyle(c.style),
        style: toCellStyle(c.style),
      }),
    ),
  }

  const today = todayYmd(now)

  const renderRows: Row<GridCell>[] = entries.map((entry): Row<GridCell> => {
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
    const doneRow = DONE_STATES.has(row.pmState ?? '')
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
        let style = mergeStyle(cf, manual)
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
          choices: column.key === 'pmState' ? [...PM_STATES] : column.key === 'task' ? TASK_OPTIONS : undefined,
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
        }
      }),
    }
  })

  const highlights: Highlight[] = focus && flash ? [{ rowId: flash, columnId: focus.colKey, borderColor: '#FF6D01' }] : []

  /* ----------------------------------------------------------------------- */
  /* Today                                                                   */
  /* ----------------------------------------------------------------------- */

  const todayItems = sheet.rows
    .filter((r) => !r.mergedInto && !DONE_STATES.has(r.pmState ?? ''))
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
        <span className={css.group} title="글자색">
          가
          {INKS.map((c) => <button key={c} type="button" className={css.swatch} style={{ background: c }} title={c} onClick={() => void applyStyle({ fg: c }, '글자색')} />)}
          <button type="button" className={css.tool} title="글자색 지우기" onClick={() => void applyStyle({ fg: null }, '글자색 지우기')}>✕</button>
        </span>
        <span className={css.group} title="칸 색">
          칸
          {FILLS.map((c) => <button key={c} type="button" className={css.swatch} style={{ background: c }} title={c} onClick={() => void applyStyle({ bg: c }, '칸 색')} />)}
          <input type="color" className={css.swatch} title="다른 색" onChange={(e) => void applyStyle({ bg: e.target.value.toUpperCase() }, '칸 색')} />
          <button type="button" className={css.tool} title="칸 색 지우기" onClick={() => void applyStyle({ bg: null }, '칸 색 지우기')}>✕</button>
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
          <select className={css.toolSelect} title="좌우 정렬" value={focusStyle.align ?? ''} onChange={(e) => void applyStyle({ align: (e.target.value || null) as PmStyle['align'] }, '좌우 정렬')}>
            <option value="">좌우</option>
            <option value="left">왼쪽</option>
            <option value="center">가운데</option>
            <option value="right">오른쪽</option>
          </select>
          <select className={css.toolSelect} title="상하 정렬" value={focusStyle.valign ?? ''} onChange={(e) => void applyStyle({ valign: (e.target.value || null) as PmStyle['valign'] }, '상하 정렬')}>
            <option value="">상하</option>
            <option value="top">위</option>
            <option value="middle">가운데</option>
            <option value="bottom">아래</option>
          </select>
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
      <div className={css.gridWrap}>
        {entries.length === 0 ? (
          <p style={{ padding: 16 }}>
            {sheet.rows.length === 0 ? '이 시트에 아직 작업이 없습니다. "인계" 탭에서 인계를 받으면 여기에 들어옵니다.' : '필터에 맞는 행이 없습니다.'}
          </p>
        ) : null}
        <ReactGrid
          rows={[headerRow, ...renderRows]}
          columns={gridColumns}
          customCellTemplates={{ sheet: new SheetCellTemplate(), sheetHeader: new SheetHeaderTemplate() }}
          onCellsChanged={onCellsChanged as unknown as (changes: CellChange[]) => void}
          onSelectionChanged={onSelectionChanged}
          onFocusLocationChanged={onFocusLocationChanged}
          onColumnResized={onColumnResized}
          onColumnsReordered={onColumnsReordered}
          onRowsReordered={onRowsReordered}
          canReorderRows={(target) => !sort && rowById.has(String(target)) || String(target).startsWith('m:')}
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
          onSort={(dir) => {
            setSort({ key: filterPop.key, dir })
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
  onSort: (dir: 'asc' | 'desc') => void
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
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" className={css.tool} onClick={() => props.onSort('asc')}>오름차순 ▲</button>
          <button type="button" className={css.tool} onClick={() => props.onSort('desc')}>내림차순 ▼</button>
        </div>
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
            이전 인계일 {s.lastHandoverAt ? formatSheetDate(s.lastHandoverAt.slice(0, 10)) : '-'} · {s.prjCode ?? ''} · {s.times}회
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
