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
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
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
  confirmPmSeen,
  orderPmRows,
  patchPmRow,
  archivePmRows,
  undoArchivePmRows,
  pmKeys,
  writePmCells,
  writePmPref,
  type PmArchiveCell,
  type PmArchiveItem,
  type PmCellWrite,
  type PmCondRule,
  type PmPrefs,
  type PmSheetRow,
  type PmSheetView,
  type PmStateDef,
  type PmStyle,
} from '@/apis/pmsheet.api'
import { useUpdateJob, useUpdatePurchaseOrder } from '@/apis/queries/neotms.mutation'
import type { PoAction } from '@/features/purchaseorders/poDraft'
import { useCodeOptions } from '@/apis/queries/neotms.query'
import { CODE_DOMAIN } from '@/apis/neotms.codes'
import { ConfirmDialog } from '@/shared/ui/ConfirmDialog'
import { conditionalStyle } from './conditional'
import {
  APPEND_KEYS,
  FIXED_COLUMNS,
  ROW_FIELD_KEYS,
  appendKey,
  buildColumns,
  isCustomKey,
  mergeStyle,
  type SheetColumn,
} from './sheetColumns'
import { SheetCellTemplate, SheetHeaderTemplate, type SheetCell, type SheetHeaderCell } from './sheetCells'
import { asNumber, dayState, formatSheetDate, hourState, isYmd, parseHour, parseSheetDate, todayYmd } from './sheetFormat'
import { isFormula } from './sheetFormula'
import {
  BLANK,
  buildEntries,
  cellKey,
  cellValue,
  distinctValues,
  indexCells,
  fixedRaw,
  mergeProblem,
  personAction,
  poOfGroup,
  PO_GROUP_KEYS,
  sheetOverride,
  shownOf,
  type PoGroup,
  type DataEntry,
  type Filters,
  type SortState,
} from './sheetModel'
import { CondFormatModal, ColumnsModal, NoteModal, ShortcutsModal, StatesModal } from './PmSheetModals'
import { ACTIONS, comboOf, effectiveShortcuts } from './shortcuts'
import { ColorPalette } from './ColorPalette'
import { BorderMenu, type BorderKind } from './BorderMenu'
import { FreezeMenu, IconMenu } from './IconMenus'
import { ALIGN_ICONS, TOOL_ICONS, VALIGN_ICONS, WRAP_ICONS } from './menuIcons'
import { effectiveStates, isClosedState, selectableStates, stateStyleFor } from './pmStates'
import {
  BLANK_TAIL,
  applySlots,
  columnLetter,
  freePosOf,
  freeRowId,
  insertSlots,
  isFreeRowId,
  layoutPositions,
  liveFreeRows,
  placeAfter,
  removeSlots,
  reorderSlots,
  setFreeValue,
  shiftYmd,
  slotsOf,
} from './freeRows'
import css from './PmSheet.module.css'
import { SheetPoModal } from './SheetPoModal'
import { useImeTyping } from './imeTyping'
import { fetchProjects } from '@/apis/neotms.api'

/** 칸 글자 기본 크기(px) — 글자 크기 `− 13 +` 의 기준. */
const DEFAULT_SIZE = 13
/** 행 높이(px, 100%). */
const ROW_H = 25
/** 엑셀식 행 머리(1·2·3) 열과 열 머리(A·B·C) 행의 id. */
const RH = '__rh'
const LETTERS = '__letters'
const HEADER = 'header'
/** 다른 사람이 바꾼 칸 (팀장님 2026-11-25): 빨간 테두리 · 굵게 · 밑줄 · +3 · 노란 칸. */
const CHANGED_BORDER = { color: '#D93025', width: '2px', style: 'solid' }
const CHANGED_BG = '#FFF176'
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
  /** 도구막대 맨 왼쪽에 붙일 것 (타PM 업무의 PM 고르기). */
  toolbarStart?: ReactNode
  /** 시트 아래에 남길 높이 — 아래 탭 줄 자리 (px). */
  bottomGap?: number
}

type GridCell = SheetCell | SheetHeaderCell
type HistoryEntry = { label: string; undo: () => Promise<void>; redo: () => Promise<void> }
type Target = { jobId: string; colKey: string }

export function PmSheet({ sheet, ownerId, onNotice, onError, toolbarStart, bottomGap = 12 }: Props) {
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
  /** 시트 배율 — 100 기준 5 단위, 시트 주인 기준 (팀장님 2026-11-25). */
  const zoom = Math.min(200, Math.max(50, prefs.view?.zoom ?? 100))
  const z = zoom / 100
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
  /** 행 머리 우클릭 메뉴. */
  const [rowMenu, setRowMenu] = useState<{ rowId: string; x: number; y: number } | null>(null)
  /** 바뀐 칸을 눌렀을 때 옆에 뜨는 '확인'. */
  const [confirmAt, setConfirmAt] = useState<{ jobId: string; colKey: string; x: number; y: number } | null>(null)
  /** 데이터 줄이 가리키는 칸 (빈 줄·월 머리행 포함) 과 고치는 중인 글자. */
  const [cellAt, setCellAt] = useState<{ rowId: string; colKey: string } | null>(null)
  const [fxDraft, setFxDraft] = useState<{ key: string; text: string } | null>(null)
  /** 우클릭 메뉴 — 머리글(jobId null) 또는 칸. */
  /* 시트 창이 화면 아래 끝까지 — 창 크기·위쪽 내용이 바뀌면 다시 잰다. */
  const gridBox = useRef<HTMLDivElement>(null)
  const [gridHeight, setGridHeight] = useState<number | null>(null)
  useEffect(() => {
    const fit = () => {
      const el = gridBox.current
      if (!el) return
      const h = Math.max(240, Math.floor(window.innerHeight - el.getBoundingClientRect().top - bottomGap))
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
  }, [bottomGap])
  const [colMenu, setColMenu] = useState<{ key: string; x: number; y: number; jobId: string | null } | null>(null)
  /** 업무 칸 한 번 클릭 — 작업 종류 목록 (팀장님 2026-11-26). */
  const [taskMenu, setTaskMenu] = useState<{ jobId: string; x: number; y: number } | null>(null)
  const workOptions = useCodeOptions(CODE_DOMAIN.WORK).options
  /** [아카이빙] 확인 창. */
  const [archiveAsk, setArchiveAsk] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const mouse = useRef({ x: 200, y: 200 })
  /* 오늘/지금 색칠이 시간이 흐르면 바뀌도록 1분마다 시계를 다시 읽는다. */
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(t)
  }, [])

  /* 저장 중인 값 — 서버 값이 같아지면 버린다. */
  const [edits, setEdits] = useState<{ source: PmSheetRow[]; values: Map<string, string> }>({
    source: sheet.rows,
    values: new Map(),
  })
  const overrides = edits.values

  /*
   * 실행취소·재실행 (2026-11-26 고침): 기록에 담긴 되돌리기 함수는 그 수정을 한 때의 화면을 보고 있어서,
   * '지금 값' 을 수정 전 값으로 읽고 "이미 같다" 며 건너뛰었다 — 그래서 값 수정이 되돌려지지 않았다.
   * 이제 되돌리기는 `latest`(매 화면마다 갱신되는 최신 함수·행)를 거치고, 같은지 비교도 하지 않는다.
   */
  const latest = useRef<{
    applyValues: typeof applyValues
    writeFree: typeof writeFree
    rowById: ReadonlyMap<string, PmSheetRow>
    columnOf: typeof columnOf
  } | null>(null)
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
  /** 행(통합 행이면 합쳐진 행까지)에서 다른 사람이 바꾼 칸. */
  const changedSet = (entry: DataEntry) => new Set([entry.row, ...entry.merged].flatMap((r) => r.changedKeys ?? []))
  const changedRows = sheet.rows.filter((r) => (r.changedKeys?.length ?? 0) > 0)
  const changedCount = changedRows.reduce((n, r) => n + r.changedKeys.length, 0)

  /**
   * 소수 자리 옵션은 없앴다 (팀장님 2026-11-25): 숫자는 늘 천 단위 쉼표, 소수가 있으면 있는 자리까지.
   * 예전에 걸어 둔 소수 자리 꾸밈도 더는 쓰지 않는다.
   */
  const decimalsOf = (_row: PmSheetRow, _column: SheetColumn): null => null

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
  const writeFree = (changes: { pos: number; colKey: string; text: string }[], record = true) => {
    let next = freeRows
    const before = changes.map((c) => ({ ...c, text: freeRows.find((f) => f.pos === c.pos)?.values[c.colKey] ?? '' }))
    for (const c of changes) next = setFreeValue(next, c.pos, c.colKey, c.text)
    void savePref('view', { ...(prefs.view ?? {}), freeRows: next })
    // 직접 입력한 행도 실행취소 (2026-11-26). 되돌릴 때는 그때의 최신 화면 함수로(`latest`).
    if (record && before.some((b, i) => b.text !== changes[i]!.text)) {
      pushHistory({
        label: changes.length === 1 ? '칸 수정' : `칸 ${String(changes.length)}개 수정`,
        undo: async () => latest.current?.writeFree(before, false),
        redo: async () => latest.current?.writeFree(changes, false),
      })
    }
  }

  if (edits.source !== sheet.rows) {
    const next = new Map(edits.values)
    for (const [key, value] of edits.values) {
      const [jobId, colKey] = key.split('|') as [string, string]
      if (colKey.endsWith('+')) {
        if ((cells.get(cellKey(jobId, colKey.slice(0, -1)))?.value ?? '') === value) next.delete(key)
        continue
      }
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

  /**
   * 자리 목록대로 저장한다 — 자리가 바뀐 작업은 한 요청으로, 글이 있는 빈 줄은 개인 설정으로.
   * `base` 는 그 목록을 만들 때의 빈 줄(되돌리기는 예전 것을 넘긴다). `all` 이면 모든 작업의 자리를 보낸다.
   */
  const saveSlots = async (order: string[], base: typeof freeRows, all = false) => {
    const result = applySlots(order, base)
    const items = [...result.jobPos]
      .filter(([jobId, pos]) => all || (layout.posOf.get(jobId) ?? rowById.get(jobId)?.ordNo ?? null) !== pos)
      .map(([jobId, ordNo]) => ({ jobId, ordNo }))
    if (items.length > 0) await orderPmRows(ownerId, items)
    // `all`(실행취소·재실행)이면 늘 저장 — 되돌리는 함수는 예전 화면의 `freeRows` 를 보고 있어서 비교가 틀릴 수 있다.
    if (all || JSON.stringify(result.freeRows) !== JSON.stringify(freeRows)) {
      await savePref('view', { ...(prefs.view ?? {}), freeRows: result.freeRows })
    }
  }

  /** 바뀐 칸 확인 (`keys` 가 없으면 그 행들의 모든 칸). 남은 칸이 없으면 기다리는 재인계도 확인된다. */
  const confirmChanges = async (jobIds: string[], keys?: string[]) => {
    try {
      const r = await confirmPmSeen(ownerId, jobIds, keys)
      setConfirmAt(null)
      refresh()
      void qc.invalidateQueries({ queryKey: ['workspace', 'pm'] })
      if (r.rehandoversConfirmed > 0) onNotice(`재인계 ${String(r.rehandoversConfirmed)}건도 확인했습니다.`)
    } catch (err) {
      onError(messageOf(err))
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Writing values                                                          */
  /* ----------------------------------------------------------------------- */

  const columnOf = (key: string) => columns.find((c) => c.key === key) ?? null

  /** 고칠 수 없는 열에 덧붙인 글 (저장 중이면 그 값). */
  const extraOf = (jobId: string, key: string): string =>
    overrides.get(cellKey(jobId, appendKey(key))) ?? cells.get(cellKey(jobId, key))?.value ?? ''

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
  const writeValue = async (row: PmSheetRow, column: SheetColumn, value: string, tid?: string | null, restore?: Record<string, string>) => {
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
      /*
       * PO 가 있으면 분량·도착일·시간은 그 PO 에 바로 쓴다(예전과 같다). 그 밖 — PO 가 없을 때의 모든 칸,
       * PO 가 있어도 이름(다른 사람으로 바꾸면 [변경])·PO 칸 — 은 시트 값으로 둔다 (팀장님 2026-11-26).
       * 시트 값은 적을 때의 PO 에 묶인다(`trFor`): PO 가 생기거나 바뀌면 PO 값이 다시 보인다.
       */
      const po = poOfGroup(row, src)
      const poField = key.endsWith('Volume') ? 'poVolume' : key.endsWith('Eday') ? 'poEday' : key.endsWith('Time') ? 'poEdayTime' : null
      if (po && poField && !(restore && (restore[key] ?? '') !== '' && (restore[`${src}For`] ?? '') === po.poId)) {
        await updatePo.mutateAsync({ id: po.poId, input: { [poField]: value || null } })
      } else if (restore) {
        // 실행취소: 묶음의 시트 값을 수정 전 그대로.
        await patchPmRow({ staffId: ownerId, jobId: row.jobId, fields: restore })
      } else {
        const bind = po?.poId ?? ''
        const fields: Record<string, string> = { [key]: value, [`${src}For`]: bind }
        if (column.spec.kind === 'picker') fields[`${src}Tid`] = tid ?? ''
        if ((row.fields[`${src}For`] ?? '') !== bind) for (const k of PO_GROUP_KEYS[src]) if (!(k in fields)) fields[k] = ''
        await patchPmRow({ staffId: ownerId, jobId: row.jobId, fields })
      }
    } else {
      throw new Error('이 칸은 고칠 수 없습니다.')
    }
  }

  /** 실행취소·재실행 — 최신 행·함수로 다시 쓴다(같은지 비교하지 않음). */
  const replay = async (items: { jobId: string; colKey: string; text: string; tid?: string | null; restore?: Record<string, string> }[]) => {
    const cur = latest.current
    if (!cur) return
    const list = items.flatMap((it) => {
      const row = cur.rowById.get(it.jobId)
      const column = cur.columnOf(it.colKey)
      return row && column ? [{ row, column, text: it.text, tid: it.tid, restore: it.restore }] : []
    })
    if (list.length > 0) await cur.applyValues(list, false, true)
  }

  /**
   * 여러 칸을 한 번에 (붙여넣기·지우기·채우기도 여기로). 한 번의 실행취소로 되돌아간다.
   * 가제 열은 한 요청으로 묶고, 나머지는 칸마다 보낸다.
   */
  const applyValues = async (
    changes: { row: PmSheetRow; column: SheetColumn; text: string; tid?: string | null; restore?: Record<string, string> }[],
    record = true,
    force = false,
  ) => {
    type Done = { row: PmSheetRow; column: SheetColumn; before: string; after: string; tid?: string | null; beforeFields?: Record<string, string> }
    const done: Done[] = []
    const customBatch: PmCellWrite[] = []
    const customDone: typeof done = []
    const errors: string[] = []

    for (const { row, column, text, tid, restore } of changes) {
      if (APPEND_KEYS.has(column.key)) {
        // 고칠 수 없는 열의 덧붙임 — 시트 칸 값으로만 (프로젝트에는 쓰지 않는다).
        const value = text.trim()
        const before = extraOf(row.jobId, column.key)
        if (!force && before === value) continue
        put(row.jobId, appendKey(column.key), value)
        customBatch.push({ jobId: row.jobId, colKey: column.key, value: value || null })
        customDone.push({ row, column, before, after: value })
        continue
      }
      const parsed = normalize(column, text)
      if (!parsed.ok) {
        errors.push(parsed.reason)
        continue
      }
      const before = currentRaw(row, column)
      if (!force && before === parsed.value && !(column.spec.kind === 'picker' && tid)) continue
      // 번역가·감수자 묶음의 시트 값은 묶음 전체(이름·id·PO 묶임)를 그대로 되돌려야 한다 — 이름만 되돌리면
      // 고른 번역가 id 가 남거나 PO 이름이 시트 값으로 굳는다.
      const src = column.spec.source
      const beforeFields =
        src === 'tr' || src === 'rv'
          ? Object.fromEntries([...PO_GROUP_KEYS[src], `${src}For`].map((k) => [k, row.fields[k] ?? '']))
          : undefined
      put(row.jobId, column.key, parsed.value)
      if (column.spec.source === 'custom') {
        customBatch.push({ jobId: row.jobId, colKey: column.key, value: parsed.value || null })
        customDone.push({ row, column, before, after: parsed.value })
        continue
      }
      try {
        await writeValue(row, column, parsed.value, tid, restore)
        done.push({ row, column, before, after: parsed.value, tid, beforeFields })
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
        for (const c of customBatch) drop(c.jobId, APPEND_KEYS.has(c.colKey) ? appendKey(c.colKey) : c.colKey)
        errors.push(messageOf(err))
      }
    }
    if (done.length > 0) {
      refresh()
      if (record) {
        pushHistory({
          label: done.length === 1 ? `${done[0]!.column.label} 수정` : `칸 ${String(done.length)}개 수정`,
          undo: () => replay(done.map((d) => ({ jobId: d.row.jobId, colKey: d.column.key, text: d.before, restore: d.beforeFields }))),
          redo: () => replay(done.map((d) => ({ jobId: d.row.jobId, colKey: d.column.key, text: d.after, tid: d.tid }))),
        })
      }
    }
    if (errors.length > 0) onError([...new Set(errors)].join(' / '))
  }

  /* ----------------------------------------------------------------------- */
  /* 번역가 칸 [발행]·[보기]·[변경] (팀장님 2026-11-26)                          */
  /* ----------------------------------------------------------------------- */

  /**
   * 시트 위에 PO 창을 띄운다(프로젝트 화면으로 넘어가지 않는다, 2026-11-26). 발행 = 새 PO(이 행의 값을 미리 채움), 보기 = 그 PO,
   * 변경 = 그 PO 의 수정 창에 바꿔 적은 사람을 넣어서. 발행·변경이 저장되면 T·PO 칸·번역가 칸은 PO 를 따라간다.
   */
  /** PRCODE 로 프로젝트를 찾아 연다 — 직접 입력한 행용. 코드가 정확히 같은 프로젝트만. */
  const openProjectByCode = async (code: string) => {
    try {
      const page = await fetchProjects({ q: code, limit: 20 })
      const hit = page.items.find((p) => p.prjCode.trim().toLowerCase() === code.toLowerCase())
      if (hit) void navigate(`/projects/${encodeURIComponent(hit.id)}`)
      else onError(`PRCODE '${code}' 인 프로젝트를 찾지 못했습니다.`)
    } catch (err) {
      onError(messageOf(err))
    }
  }

  /** 경로 칸의 복사 단추 (팀장님 2026-11-26). */
  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text).then(
      () => onNotice('경로를 복사했습니다. 탐색기 주소창에 붙여 넣으세요.'),
      () => onError('복사하지 못했습니다. 칸을 고르고 Ctrl+C 를 눌러 주세요.'),
    )
  }

  /**
   * 진행 상태 ‹ › — 목록 순서대로 이전·다음 상태 (팀장님 2026-11-26). 별도 관리 두 상태는 건너뛰고,
   * 끝에서 › 는 처음(인계 수령)으로, 처음에서 ‹ 는 끝으로. 실행취소는 보통 값 수정과 같다.
   */
  const cycleState = (row: PmSheetRow, dir: 1 | -1) => {
    const column = columnOf('pmState')
    if (!column) return
    const order = stateDefs.filter((d) => !d.hidden && !d.name.startsWith('별도 관리')).map((d) => d.name)
    if (order.length === 0) return
    const at = order.indexOf(currentRaw(row, column))
    const next = order[at < 0 ? (dir === 1 ? 0 : order.length - 1) : (at + dir + order.length) % order.length]!
    void applyValues([{ row, column, text: next }])
  }

  const [sheetPo, setSheetPo] = useState<{ action: PoAction; projectId: string } | null>(null)
  const openPoFor = (row: PmSheetRow, group: PoGroup) => {
    const action = personAction(row, group)
    const po = poOfGroup(row, group)
    const val = (k: string) => fixedRaw(row, k, { merged: [], inGroup: false, rowNo: 0 }).trim()
    const name = val(group === 'tr' ? 'translator' : 'reviewer')
    const tid = sheetOverride(row, `${group}Tid`) ?? null
    let poAction: PoAction
    if (action === 'issue' || !po) {
      poAction = {
        mode: 'new',
        jobId: row.jobId,
        jobTitle: row.jobName || row.jobCode,
        draft: {
          translatorId: tid,
          translatorName: name || null,
          poWorkCode: group === 'tr' ? '번역' : '감수',
          poType: row.jobType,
          poSlang: row.slang,
          poElang: row.elang,
          poVolume: val(`${group}Volume`).replace(/,/g, '') || null,
          poEday: val(`${group}Eday`) || null,
          poEdayTime: val(`${group}Time`) || null,
        },
      }
    } else if (action === 'change') {
      poAction = { mode: 'edit', poId: po.poId, draft: { translatorId: tid, translatorName: name } }
    } else {
      poAction = { mode: 'edit', poId: po.poId }
    }
    setSheetPo({ action: poAction, projectId: row.projectId })
  }

  /** 업무 칸 목록에서 고른 작업 종류 — 프로젝트의 작업(통합 행이면 합쳐진 작업까지)에도 반영. 직접 입력한 글자는 지운다. */
  const pickTask = async (row: PmSheetRow, code: string) => {
    const targets = [row, ...sheet.rows.filter((x) => x.mergedInto === row.jobId)]
    const before = targets.map((r) => ({ id: r.jobId, workCode: r.workCode ?? null }))
    const beforeTask = row.fields.task ?? ''
    const write = async (codes: { id: string; workCode: string | null }[], task: string | null) => {
      for (const c of codes) await updateJob.mutateAsync({ id: c.id, input: { workCode: c.workCode } })
      if (task !== null) await patchPmRow({ staffId: ownerId, jobId: row.jobId, fields: { task } })
      refresh()
    }
    try {
      const after = targets.map((r) => ({ id: r.jobId, workCode: code }))
      await write(after, beforeTask ? '' : null)
      // 업무 목록으로 고른 것도 실행취소 (2026-11-26).
      pushHistory({
        label: '업무 수정',
        undo: () => write(before, beforeTask ? beforeTask : null),
        redo: () => write(after, beforeTask ? '' : null),
      })
    } catch (err) {
      onError(messageOf(err))
    }
  }

  /* ----------------------------------------------------------------------- */
  /* 아카이빙 — 납품 완료 행을 '완료 업무' 시트로 (팀장님 2026-11-26, db/016)      */
  /* ----------------------------------------------------------------------- */

  const DONE_STATE = '납품 완료'
  const archiveHeads = topJobs.filter((r) => (r.pmState ?? '') === DONE_STATE)
  const archiveFrees = freeRows.filter((f) => (f.values.pmState ?? '').trim() === DONE_STATE)
  const archiveCount = archiveHeads.length + archiveFrees.length

  const runArchive = async () => {
    // 숨긴 열까지 — 완료 업무 시트는 나의 업무와 같은 열 구성이다. 행ID 는 그 시트에서 다시 매긴다.
    const all = buildColumns({ ...(prefs.columns ?? {}), hidden: [] }).filter((c) => c.key !== 'rowNo')
    const items: PmArchiveItem[] = []
    const alsoHide: string[] = []
    for (const row of archiveHeads) {
      const merged = sheet.rows.filter((r) => r.mergedInto === row.jobId)
      alsoHide.push(...merged.map((m) => m.jobId))
      const ctx = { columns: all, cells, merged, inGroup: false, rowNo: 0, overrides }
      const out: Record<string, PmArchiveCell> = {}
      for (const column of all) {
        const base = cellValue(row, column, ctx, null).shown
        const add = APPEND_KEYS.has(column.key) ? extraOf(row.jobId, column.key) : ''
        const shown = add ? `${base} ${add}`.trim() : base
        const own = cells.get(cellKey(row.jobId, column.key))?.style
        const hasStyle = !!own && Object.keys(own).length > 0
        if (shown || hasStyle) out[column.key] = hasStyle ? { t: shown, s: own } : { t: shown }
      }
      items.push({ jobId: row.jobId, handoverAt: row.handoverAt, cells: out, rowStyle: row.rowStyle as PmStyle })
    }
    for (const f of archiveFrees) {
      const out: Record<string, PmArchiveCell> = {}
      for (const column of all) {
        const raw = f.values[column.key] ?? ''
        if (raw.trim()) out[column.key] = { t: shownOf(column, raw, null) }
      }
      const h = (f.values.handoverAt ?? '').trim()
      items.push({ jobId: null, handoverAt: isYmd(h) ? `${h}T00:00:00+09:00` : null, cells: out })
    }
    if (items.length === 0) return
    // 옮긴 행이 있던 자리는 지운다 — 아래 행이 올라와 빈 줄이 남지 않게 (팀장님 2026-11-26).
    // 직접 만든 행도 이 자리 목록에서 빠지면서 개인 설정의 빈 줄 목록에서 지워진다.
    const before = slotsOf(layout.posOf, freeRows)
    const baseFree = freeRows
    const jobIds = [...archiveHeads.map((r) => r.jobId), ...alsoHide]
    const after = removeSlots(before, [...jobIds, ...archiveFrees.map((f) => freeRowId(f.pos))])
    const doArchive = async () => {
      const r = await archivePmRows(ownerId, items, alsoHide)
      await saveSlots(after, baseFree, true)
      refresh()
      void qc.invalidateQueries({ queryKey: pmKeys.archive(ownerId ?? null) })
      return r.ids
    }
    setArchiving(true)
    try {
      let made = await doArchive()
      onNotice(`납품 완료 ${String(items.length)}행을 '완료 업무' 시트로 옮겼습니다. (실행취소로 되돌릴 수 있습니다)`)
      setArchiveAsk(false)
      // 실행취소: 그때 만든 보관 행을 지우고, 작업 행을 다시 보이게 한 뒤 자리·빈 줄을 옮기기 전으로.
      pushHistory({
        label: '아카이빙',
        undo: async () => {
          await undoArchivePmRows(ownerId, made, jobIds)
          await saveSlots(before, baseFree, true)
          refresh()
          void qc.invalidateQueries({ queryKey: pmKeys.archive(ownerId ?? null) })
        },
        redo: async () => {
          made = await doArchive()
        },
      })
    } catch (err) {
      onError(messageOf(err))
    } finally {
      setArchiving(false)
    }
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

  /* 테두리 아이콘 판 — 색과 굵기는 다음 칠하기에 쓴다 (화면에서만 기억). */
  const [borderColor, setBorderColor] = useState('#000000')
  const [borderWeight, setBorderWeight] = useState<'thin' | 'thick'>('thin')

  /**
   * 테두리 칠하기. 칸 범위면 각 칸이 범위의 어느 가장자리에 있는지로 변을 정한다(안쪽 · 바깥 · 한쪽).
   * 한쪽(왼·위·오른·아래)은 그 가장자리 칸에 변을 **더하고**, 다른 칸의 테두리는 그대로 둔다.
   * 행·열 전체를 골랐으면 가장자리를 따질 수 없어 모양대로 모든 칸에 같은 변을 준다.
   */
  const applyBorder = (kind: BorderKind) => {
    if (kind === 'clear') {
      void applyStyle({ border: null, borderSides: null, borderColor: null }, '테두리 지우기')
      return
    }
    const flat: Record<Exclude<BorderKind, 'clear'>, string> = {
      all: 'tblr', inner: 'tblr', hInner: 'tb', vInner: 'lr', outer: 'tblr', left: 'l', top: 't', right: 'r', bottom: 'b',
    }
    const pos = new Map<string, { t: boolean; b: boolean; l: boolean; r: boolean }>()
    for (const range of selection.ranges) {
      const rowIds = range.rows.map((r) => String(r.rowId)).filter((id) => rowById.has(id))
      const colIds = range.columns.map((c) => String(c.columnId))
      rowIds.forEach((rid, ri) => {
        colIds.forEach((cid, ci) => {
          pos.set(cellKey(rid, cid), { t: ri === 0, b: ri === rowIds.length - 1, l: ci === 0, r: ci === colIds.length - 1 })
        })
      })
    }
    const label = { all: '모든 테두리', inner: '안쪽 테두리', hInner: '가로 안쪽 테두리', vInner: '세로 안쪽 테두리', outer: '바깥 테두리', left: '왼쪽 테두리', top: '위쪽 테두리', right: '오른쪽 테두리', bottom: '아래쪽 테두리' }[kind]
    const patch: PmStyle = { border: borderWeight, borderColor, borderSides: flat[kind] }
    void applyStyle(patch, label, (t) => {
      const p = pos.get(cellKey(t.jobId, t.colKey))
      if (!p) return {}
      const own = cells.get(cellKey(t.jobId, t.colKey))?.style ?? {}
      const pick = (sides: [boolean, string][]) => sides.filter(([on]) => on).map(([, s]) => s).join('')
      let sides: string
      if (kind === 'all') sides = 'tblr'
      else if (kind === 'inner') sides = pick([[!p.t, 't'], [!p.b, 'b'], [!p.l, 'l'], [!p.r, 'r']])
      else if (kind === 'hInner') sides = pick([[!p.t, 't'], [!p.b, 'b']])
      else if (kind === 'vInner') sides = pick([[!p.l, 'l'], [!p.r, 'r']])
      else if (kind === 'outer') sides = pick([[p.t, 't'], [p.b, 'b'], [p.l, 'l'], [p.r, 'r']])
      else {
        const edge = { left: p.l, top: p.t, right: p.r, bottom: p.b }[kind]
        const side = { left: 'l', top: 't', right: 'r', bottom: 'b' }[kind]
        // 가장자리가 아닌 칸은 원래 테두리 그대로.
        if (!edge) return { border: own.border ?? null, borderColor: own.borderColor ?? null, borderSides: own.borderSides ?? null }
        const merged = [...new Set(((own.borderSides ?? '') + side).split(''))].join('')
        return { borderSides: merged }
      }
      return { borderSides: sides || null, ...(sides ? {} : { border: null, borderColor: null }) }
    })
  }

  /* ----------------------------------------------------------------------- */
  /* 열 숨기기 · 추가 · 삭제 — 열 머리 우클릭 (팀장님 2026-11-25)              */
  /* ----------------------------------------------------------------------- */

  /** 우클릭한 열이 고른 열 안에 있으면 고른 열 모두, 아니면 그 열 하나. 화면 순서대로. */
  const menuCols = (key: string): string[] => {
    const picked = selection.cols.includes(key) ? selection.cols : [key]
    const order = columns.map((c) => c.key)
    return [...picked].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  }
  const fullOrder = () => buildColumns({ ...(prefs.columns ?? {}), hidden: [] }).map((c) => c.key)

  const hideColumns = async (keys: string[]) => {
    if (keys.length >= columns.length) {
      onError('모든 열을 숨길 수는 없습니다.')
      return
    }
    const hidden = [...new Set([...(prefs.columns?.hidden ?? []), ...keys])]
    await savePref('columns', { ...(prefs.columns ?? {}), hidden })
    onNotice(`열 ${String(keys.length)}개를 숨겼습니다. 다시 보려면 열 머리를 우클릭해 '숨긴 열 모두 보이기' 를 누르세요.`)
  }

  const addColumnBeside = async (keys: string[], side: 'left' | 'right') => {
    const pref = prefs.columns ?? {}
    const custom = pref.custom ?? []
    const labels = new Set(buildColumns({ ...pref, hidden: [] }).map((c) => c.label))
    let n = 1
    while (labels.has(n === 1 ? '새 열' : `새 열 ${String(n)}`)) n += 1
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const key = `c:${id}`
    const order = fullOrder()
    const anchor = side === 'left' ? keys[0]! : keys[keys.length - 1]!
    const at = order.indexOf(anchor)
    order.splice(side === 'left' ? Math.max(0, at) : at + 1, 0, key)
    await savePref('columns', { ...pref, custom: [...custom, { id, label: n === 1 ? '새 열' : `새 열 ${String(n)}` }], order })
    onNotice('열을 추가했습니다. 이름은 열 관리에서 바꿀 수 있습니다.')
  }

  const deleteColumns = async (keys: string[]) => {
    const removable = keys.filter(isCustomKey)
    if (removable.length === 0) {
      onError('기본 열은 삭제할 수 없습니다 — 열 숨기기를 쓰세요.')
      return
    }
    const pref = prefs.columns ?? {}
    await savePref('columns', {
      ...pref,
      custom: (pref.custom ?? []).filter((c) => !removable.includes(`c:${c.id}`)),
      order: (pref.order ?? []).filter((k) => !removable.includes(k)),
    })
    const skipped = keys.length - removable.length
    onNotice(`열 ${String(removable.length)}개를 삭제했습니다.${skipped > 0 ? ` 기본 열 ${String(skipped)}개는 삭제할 수 없어 그대로 두었습니다.` : ''}`)
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

  /* 칸에서 바로 한글 치기 — imeTyping.ts 머리말 (팀장님 2026-11-26). */
  const imeActive = useImeTyping(gridBox, {
    canStart: () => {
      if (!cellAt) return false
      if (isFreeRowId(cellAt.rowId)) return true
      const row = rowById.get(cellAt.rowId)
      const column = columnOf(cellAt.colKey)
      if (!row || !column || column.key === 'pmState') return false
      return APPEND_KEYS.has(column.key) || isEditable(column, row)
    },
    commit: (text) => {
      if (!cellAt) return
      if (isFreeRowId(cellAt.rowId)) {
        writeFree([{ pos: freePosOf(cellAt.rowId), colKey: cellAt.colKey, text }])
        return
      }
      const row = rowById.get(cellAt.rowId)
      const column = columnOf(cellAt.colKey)
      if (row && column) void applyValues([{ row, column, text }])
    },
  })

  /** 고른 범위의 칸을 모두 지운다 — 한 번의 실행취소로 돌아간다 (팀장님 2026-11-26: 첫 칸만 지워지던 문제). */
  const clearSelection = (): boolean => {
    const list: { row: PmSheetRow; column: SheetColumn; text: string }[] = []
    const free: { pos: number; colKey: string; text: string }[] = []
    const seen = new Set<string>()
    for (const range of selection.ranges) {
      for (const r of range.rows) {
        const rowId = String(r.rowId)
        for (const c of range.columns) {
          const colKey = String(c.columnId)
          if (colKey === RH || seen.has(`${rowId}|${colKey}`)) continue
          seen.add(`${rowId}|${colKey}`)
          if (isFreeRowId(rowId)) {
            free.push({ pos: freePosOf(rowId), colKey, text: '' })
            continue
          }
          const row = rowById.get(rowId)
          const column = columnOf(colKey)
          if (!row || !column) continue
          if (column.spec.source === 'readonly' && !APPEND_KEYS.has(column.key)) continue
          list.push({ row, column, text: '' })
        }
      }
    }
    if (list.length + free.length <= 1) return false
    if (list.length > 0) void applyValues(list)
    if (free.length > 0) writeFree(free)
    return true
  }

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement
    if (imeActive.current) return
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.altKey && t.classList.contains('rg-hidden-element')) {
      if (clearSelection()) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
    }
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

  useEffect(() => {
    latest.current = { applyValues, writeFree, rowById, columnOf }
    keyRunner.current = (e: KeyboardEvent) => {
      const combo = comboOf(e)
      if (!combo) return
      const action = Object.entries(shortcuts).find(([, c]) => c === combo)?.[0]
      if (!action) return
      e.preventDefault()
      runAction(action)
    }
  })
  /*
   * 우클릭 메뉴·목록을 누르고 나면 그 메뉴가 사라지며 포커스가 페이지(body)로 빠져, Ctrl+Z 같은 시트
   * 단축키가 먹지 않았다 (2026-11-26 점검에서 발견: 행 추가 뒤 Ctrl+Z). 포커스가 아무 데도 없을 때만
   * 시트 단축키로 받는다 — 입력칸·다른 창에 있을 때는 건드리지 않는다.
   */
  const keyRunner = useRef<((e: KeyboardEvent) => void) | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.activeElement && document.activeElement !== document.body) return
      if (document.querySelector('[role="dialog"]')) return
      keyRunner.current?.(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onCellsChanged = (changes: CellChange<GridCell>[]) => {
    const list: { row: PmSheetRow; column: SheetColumn; text: string; tid?: string | null }[] = []
    const free: { pos: number; colKey: string; text: string }[] = []
    for (const change of changes) {
      if (String(change.columnId) === RH) continue
      if (isFreeRowId(String(change.rowId))) {
        const next = change.newCell as unknown as SheetCell
        free.push({ pos: freePosOf(String(change.rowId)), colKey: String(change.columnId), text: next.raw ?? next.text ?? '' })
        continue
      }
      const row = rowById.get(String(change.rowId))
      const column = columnOf(String(change.columnId))
      if (!row || !column || (change.newCell as { type: string }).type !== 'sheet') continue
      const next = change.newCell as unknown as SheetCell
      list.push({ row, column, text: next.raw ?? next.text, tid: next.pickedId ?? null })
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
      const cids = range.columns.map((c) => String(c.columnId)).filter((id) => id !== RH)
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
    if (colKey !== RH && jobId !== HEADER && jobId !== LETTERS) {
      setCellAt({ rowId: jobId, colKey })
      setFxDraft(null)
    }
    if (!rowById.has(jobId) || colKey === RH) {
      setConfirmAt(null)
      return
    }
    setFocus({ jobId, colKey })
    // 다른 사람이 바꾼 칸을 누르면 바로 옆에 '확인' 이 뜬다.
    const entry = entries.find((e): e is DataEntry => e.kind === 'data' && e.row.jobId === jobId)
    if (entry && changedSet(entry).has(colKey)) setConfirmAt({ jobId, colKey, x: mouse.current.x + 14, y: mouse.current.y - 12 })
    else setConfirmAt(null)
  }

  const persistLayout = (order: string[] | null, widths: Record<string, number> | null) => {
    const current = prefs.columns ?? {}
    void savePref('columns', {
      ...current,
      ...(order ? { order } : {}),
      ...(widths ? { widths: { ...(current.widths ?? {}), ...widths } } : {}),
    })
  }

  const onColumnResized = (columnId: Id, width: number) => {
    if (String(columnId) === RH) return
    // 화면 너비는 배율이 곱해진 값 — 100% 기준으로 저장한다.
    persistLayout(null, { [String(columnId)]: Math.round(width / z) })
  }

  const onColumnsReordered = (targetColumnId: Id, columnIds: Id[], dropPosition: string) => {
    const moving = columnIds.map(String).filter((k) => k !== RH)
    if (moving.length === 0) return
    const all = buildColumns({ ...(prefs.columns ?? {}), hidden: [] }).map((c) => c.key)
    const rest = all.filter((k) => !moving.includes(k))
    const target = String(targetColumnId) === RH ? 0 : rest.indexOf(String(targetColumnId))
    const at = String(targetColumnId) === RH ? 0 : target < 0 ? rest.length : dropPosition === 'before' ? target : target + 1
    persistLayout([...rest.slice(0, at), ...moving, ...rest.slice(at)], null)
  }

  /** 행 끌어 옮기기 — 정렬하지 않을 때만. 별도 관리 묶음 안으로 옮기는 방법이다. 빈 줄도 자리 하나로 센다. */
  const onRowsReordered = (targetRowId: Id, rowIds: Id[], dropPosition: string) => {
    const slots = entries.filter((e) => e.kind !== 'month').map((e) => (e.kind === 'data' ? e.row.jobId : e.id))
    let target = String(targetRowId)
    if (target === HEADER || target === LETTERS) return
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

  const rowH = Math.round(ROW_H * z)
  const gridColumns: Column[] = [
    { columnId: RH, width: Math.max(34, Math.round(46 * z)), resizable: false, reorderable: false },
    ...columns.map((c) => ({ columnId: c.key, width: Math.max(24, Math.round(c.width * z)), resizable: true, reorderable: true })),
  ]

  /** 엑셀식 열 머리(A·B·C) — 열 고르기·끌어 옮기기·너비 조정은 여기서. */
  const lettersRow: Row<GridCell> = {
    rowId: LETTERS,
    height: rowH,
    cells: [
      { type: 'sheetHeader', text: '', style: { background: '#E8EAED' } } as SheetHeaderCell,
      ...columns.map(
        (c, i): SheetHeaderCell => ({
          type: 'sheetHeader',
          text: columnLetter(i),
          hint: `${c.label} 열`,
          onMenu: (x, y) => setColMenu({ key: c.key, x, y, jobId: null }),
          inner: { justifyContent: 'center', textAlign: 'center', color: '#5F6368' },
          style: { background: '#F1F3F4' },
        }),
      ),
    ],
  }

  const headerRow: Row<GridCell> = {
    rowId: HEADER,
    height: rowH,
    cells: [{ type: 'sheetHeader', text: '', style: { background: HEADER_BG } } as SheetHeaderCell, ...columns.map(
      (c): SheetHeaderCell => ({
        type: 'sheetHeader',
        text: c.label,
        hint: c.spec.hint,
        direction: sort?.key === c.key ? sort.dir : null,
        filtered: (filters[c.key]?.length ?? 0) > 0,
        // 정렬·필터는 우클릭 메뉴로 (팀장님 2026-11-25). 시간 열은 메뉴에 정렬이 없다.
        onMenu: (x, y) => setColMenu({ key: c.key, x, y, jobId: null }),
        onSettings: c.key === 'pmState' ? () => setModal('states') : undefined,
        // 머리행은 모든 사용자 기본 가운데 정렬 (팀장님 2026-11-25).
        inner: innerStyle({ ...c.style, align: 'center' }),
        style: { ...toCellStyle(c.style), background: HEADER_BG },
      }),
    )],
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
            person: c.spec.kind === 'picker' ? { jobId: null, which: c.spec.source === 'rv' ? 'rv' : 'tr' } : undefined,
            onCopyText: c.key === 'path' && (entry.values.path ?? '').trim() ? () => copyText((entry.values.path ?? '').trim()) : undefined,
            // 직접 입력한 행의 PRCODE 도 그 프로젝트 화면으로 (팀장님 2026-11-26) — 누를 때 코드로 찾는다.
            ...(c.key === 'prjCode' && (entry.values.prjCode ?? '').trim()
              ? {
                  href: `/projects?q=${encodeURIComponent((entry.values.prjCode ?? '').trim())}`,
                  internal: true,
                  onNavigate: () => void openProjectByCode((entry.values.prjCode ?? '').trim()),
                }
              : {}),
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
    const changed = changedSet(entry)

    return {
      rowId: row.jobId,
      reorderable: !sort,
      cells: columns.map((column, ci): SheetCell => {
        const own = cells.get(cellKey(row.jobId, column.key))
        const manual = mergeStyle(own?.style, row.rowStyle, column.style)
        const v = cellValue(row, column, ctx, null)
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
        const appendable = APPEND_KEYS.has(column.key)
        const extra = appendable ? extraOf(row.jobId, column.key) : ''
        const editable = appendable || isEditable(column, row)
        const po = column.spec.source === 'tr' ? row.tr : column.spec.source === 'rv' ? row.rv : null
        const cellStyle = toCellStyle(style, {
          groupEdge: entry.inGroup ? (ci === 0 ? 'l' : ci === columns.length - 1 ? 'r' : null) : null,
          groupTop: entry.groupRole === 'start',
          groupBottom: entry.groupRole === 'end',
        })
        if (highlighted) cellStyle.background = '#fff59d'
        const isChanged = changed.has(column.key)
        if (isChanged) {
          cellStyle.background = CHANGED_BG
          ;(cellStyle as { border?: unknown }).border = { left: CHANGED_BORDER, right: CHANGED_BORDER, top: CHANGED_BORDER, bottom: CHANGED_BORDER }
        }
        const inner = isChanged
          ? {
              ...innerStyle(style),
              fontWeight: 700,
              textDecoration: 'underline',
              fontSize: `calc(${String((style.size ?? DEFAULT_SIZE) + 3)}px * var(--pm-zoom, 1))`,
            }
          : innerStyle(style)
        return {
          type: 'sheet',
          text: v.shown,
          // 덧붙일 수 있는 열은 입력기에 덧붙인 글만 띄운다 — 원래 글자는 고칠 수 없다.
          raw: appendable ? extra : v.raw,
          extra: extra || undefined,
          onCopyText: column.key === 'path' && v.shown.trim() ? () => copyText(v.shown.trim()) : undefined,
          href: v.href,
          internal: v.internal,
          onNavigate: (href) => void navigate(href),
          note: own?.note ?? undefined,
          tooltip: isChanged
            ? '다른 사람이 바꾼 칸입니다 — 눌러서 확인'
            : appendable
              ? `${v.shown}${extra ? `\n덧붙인 글(시트에만): ${extra}` : ''}\n(글을 쳐서 덧붙일 수 있습니다 — 프로젝트에는 반영되지 않습니다)`
              : v.tooltip,
          nonEditable: !editable,
          choices: column.key === 'pmState' ? stateNames : undefined,
          // 진행 상태·업무는 한 번 눌러 바로 목록을 연다 (팀장님 2026-11-25, 업무 2026-11-26). 업무를 더블클릭하면 직접 입력.
          onQuickPick:
            column.key === 'pmState' && editable
              ? (x: number, y: number) => setStateMenu({ jobId: row.jobId, x, y })
              : column.key === 'task' && editable
                ? (x: number, y: number) => setTaskMenu({ jobId: row.jobId, x, y })
                : undefined,
          placeholder: column.spec.kind === 'picker' && po ? '미지정' : undefined,
          // 번역가·감수자: 더블클릭하면 찾기 입력기, 오른쪽 단추는 발행 / 보기 / 변경 (팀장님 2026-11-26).
          person: column.spec.kind === 'picker' ? { jobId: row.jobId, which: column.spec.source === 'rv' ? 'rv' : 'tr' } : undefined,
          onOpen: column.spec.kind === 'picker' ? () => openPoFor(row, column.spec.source === 'rv' ? 'rv' : 'tr') : undefined,
          openLabel:
            column.spec.kind === 'picker'
              ? { issue: '발행', change: '변경', view: '보기' }[personAction(row, column.spec.source === 'rv' ? 'rv' : 'tr')]
              : undefined,
          style: cellStyle,
          inner,
          wrap: style.wrap === 'wrap' || style.wrap === 'clip' ? style.wrap : null,
          onMenu: (x: number, y: number) => setColMenu({ key: column.key, x, y, jobId: row.jobId }),
          // 통합 행: 행ID 숫자 뒤 'M' — 누르면 통합 해제 (팀장님 2026-11-25).
          badge:
            column.key === 'rowNo' && entry.merged.length > 0
              ? {
                  text: 'M',
                  title: `통합 행 — ${[row, ...entry.merged].map((r) => r.elang ?? '').filter(Boolean).join('·')} (누르면 통합 해제)`,
                  onClick: () => void unmergeHeads([row.jobId]),
                }
              : undefined,
          // 납품일: 마우스를 올리면 ‹ › — 실제 작업 납기를 하루씩 옮긴다.
          step:
            column.key === 'jobEday' && editable && v.raw
              ? { title: '납품일', onPrev: () => void shiftDay(row, entry.merged, column, -1), onNext: () => void shiftDay(row, entry.merged, column, 1) }
              : column.key === 'pmState' && editable
                ? { title: '진행 상태', prevTitle: '이전 상태로', nextTitle: '다음 상태로', onPrev: () => cycleState(row, -1), onNext: () => cycleState(row, 1) }
              : (column.key === 'trEday' || column.key === 'rvEday') && editable
                ? // 번역본·감수본 도착일도 ‹ › (팀장님 2026-11-26). 비어 있으면 오늘을 기준으로 하루 앞·뒤.
                  { title: column.label, onPrev: () => void shiftDay(row, [], column, -1, today), onNext: () => void shiftDay(row, [], column, 1, today) }
                : undefined,
          stepShown: focus?.jobId === row.jobId && focus.colKey === column.key,
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
    return { ...r, height: lines > 1 ? Math.min(Math.round((lines * LINE_HEIGHT + 9) * z), 400) : rowH }
  })

  /** 행 머리(1·2·3) — 화면 순서 번호. 행 고르기·끌어 옮기기, 우클릭으로 행 추가·삭제. */
  const gridRows: Row<GridCell>[] = sizedRows.map((r, i) => {
    const id = String(r.rowId)
    const data = rowById.get(id)
    const pending = data?.rehandoverId ? '재인계 확인 대기 — 바뀐 칸을 확인하면 재인계도 확인됩니다' : undefined
    const head: SheetCell = {
      type: 'sheet',
      text: `${String(i + 1)}${data?.rehandoverId ? ' ↻' : ''}`,
      nonEditable: true,
      tooltip: pending ?? '우클릭: 행 추가·삭제',
      style: { background: data?.rehandoverId ? '#FCE8E6' : '#F8F9FA', color: '#5F6368' },
      inner: { justifyContent: 'center', textAlign: 'center', fontSize: `calc(11px * var(--pm-zoom, 1))` },
      onMenu: id.startsWith('m:') ? undefined : (x: number, y: number) => setRowMenu({ rowId: id, x, y }),
    }
    return { ...r, cells: [head, ...r.cells] }
  })
  const gridIndex = new Map(gridRows.map((r, i) => [String(r.rowId), i]))

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
    const before = slotsOf(layout.posOf, freeRows)
    const baseFree = freeRows
    // 통합하면 합쳐진 행의 자리를 지우고 아래 행을 끌어올린다 — 빈 줄이 남지 않게 (팀장님 2026-11-25).
    const merge = async () => {
      for (const r of rest) await patchPmRow({ staffId: ownerId, jobId: r.jobId, mergedInto: head!.jobId })
      await saveSlots(removeSlots(before, rest.map((r) => r.jobId)), baseFree, true)
      refresh()
    }
    try {
      await merge()
      onNotice(`${String(ordered.length)}개 행을 한 행으로 통합했습니다. (번역어: ${ordered.map((r) => r.elang ?? '').join('·')})`)
      pushHistory({
        label: '행 통합',
        undo: async () => {
          for (const r of rest) await patchPmRow({ staffId: ownerId, jobId: r.jobId, mergedInto: null })
          await saveSlots(before, baseFree, true)
          refresh()
        },
        redo: merge,
      })
    } catch (err) {
      onError(messageOf(err))
    }
  }

  /** 통합 해제 — 풀린 행은 통합 행 바로 아래에 새 줄로 끼워 넣는다 (아래 행은 밀려 내려갈 뿐). */
  const unmergeHeads = async (headIds: string[]) => {
    const heads = headIds.filter((id) => sheet.rows.some((r) => r.mergedInto === id))
    if (heads.length === 0) return onError('통합된 행을 골라 주세요.')
    const before = slotsOf(layout.posOf, freeRows)
    const baseFree = freeRows
    const groups = heads.map((head) => ({ head, members: sheet.rows.filter((r) => r.mergedInto === head).map((r) => r.jobId) }))
    let order = before
    for (const g of groups) order = placeAfter(order, g.head, g.members)
    const after = order
    const unmerge = async () => {
      for (const g of groups) for (const id of g.members) await patchPmRow({ staffId: ownerId, jobId: id, mergedInto: null })
      await saveSlots(after, baseFree, true)
      refresh()
    }
    try {
      await unmerge()
      onNotice('통합을 풀었습니다. 풀린 행은 통합 행 바로 아래에 들어갔습니다.')
      // 통합 해제도 실행취소 (팀장님 2026-11-26) — 다시 통합하고 자리를 풀기 전으로.
      pushHistory({
        label: '통합 해제',
        undo: async () => {
          for (const g of groups) for (const id of g.members) await patchPmRow({ staffId: ownerId, jobId: id, mergedInto: g.head })
          await saveSlots(before, baseFree, true)
          refresh()
        },
        redo: unmerge,
      })
    } catch (err) {
      onError(messageOf(err))
    }
  }
  const unmergeRows = () => unmergeHeads(selectedRowIds())

  /* 행 머리 메뉴 — 행 추가·삭제. 작업(프로젝트 연결) 행은 지울 수 없다. */
  const slotOfRow = (rowId: string): number | null =>
    isFreeRowId(rowId) ? freePosOf(rowId) : (layout.posOf.get(rowId) ?? null)

  /** 행 머리에서 고른 행들 (우클릭한 행이 그 안에 있으면 고른 행 모두, 아니면 그 행만). */
  const rowsForMenu = (rowId: string): string[] => {
    const picked = new Set<string>()
    for (const range of selection.ranges) {
      const cols = range.columns.map((c) => String(c.columnId))
      if (!cols.includes(RH) && cols.length < columns.length) continue
      for (const r of range.rows) picked.add(String(r.rowId))
    }
    return picked.has(rowId) ? [...picked].filter((id) => id !== HEADER && id !== LETTERS && !id.startsWith('m:')) : [rowId]
  }

  const slotEditBlocked = () => {
    if (sort || Object.values(filters).some((v) => v.length > 0)) {
      onError('정렬·필터를 푼 뒤에 행을 추가·삭제할 수 있습니다. (자리 순서가 보이는 상태에서만)')
      return true
    }
    return false
  }

  const insertRows = async (rowId: string, below: boolean) => {
    setRowMenu(null)
    if (slotEditBlocked()) return
    const ids = rowsForMenu(rowId)
    const positions = ids.map(slotOfRow).filter((n): n is number => n !== null)
    if (positions.length === 0) return
    const at = below ? Math.max(...positions) + 1 : Math.min(...positions)
    const before = slotsOf(layout.posOf, freeRows)
    const baseFree = freeRows
    try {
      await saveSlots(insertSlots(before, at, ids.length), baseFree)
      refresh()
      pushHistory({
        label: '행 추가',
        undo: async () => {
          await saveSlots(before, baseFree, true)
          refresh()
        },
        redo: async () => {
          await saveSlots(insertSlots(before, at, ids.length), baseFree, true)
          refresh()
        },
      })
    } catch (err) {
      onError(messageOf(err))
    }
  }

  const deleteRows = async (rowId: string) => {
    setRowMenu(null)
    if (slotEditBlocked()) return
    const ids = rowsForMenu(rowId)
    if (ids.some((id) => rowById.has(id))) {
      return onError('프로젝트(작업)에 연결된 행은 지울 수 없습니다. 시트에서 빼려면 "행 빼기" 를 써 주세요.')
    }
    const before = slotsOf(layout.posOf, freeRows)
    const baseFree = freeRows
    try {
      await saveSlots(removeSlots(before, ids), baseFree)
      refresh()
      pushHistory({
        label: '행 삭제',
        undo: async () => {
          await saveSlots(before, baseFree, true)
          refresh()
        },
        redo: async () => {
          await saveSlots(removeSlots(before, ids), baseFree, true)
          refresh()
        },
      })
    } catch (err) {
      onError(messageOf(err))
    }
  }

  /** 납품일 ‹ › — 실제 작업 납기를 하루씩 (통합 행이면 합쳐진 작업도 같이 — 통합은 납기가 같아야 하므로). */
  const shiftDay = async (row: PmSheetRow, merged: PmSheetRow[], column: SheetColumn, days: number, emptyBase?: string) => {
    const cur = currentRaw(row, column)
    const next = shiftYmd(cur || emptyBase || '', days)
    if (!next) return
    await applyValues([row, ...merged].map((r) => ({ row: r, column, text: next })))
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

  /* 데이터 줄 */
  const fxColumn = cellAt ? columnOf(cellAt.colKey) : null
  const fxColIndex = fxColumn ? columns.indexOf(fxColumn) : -1
  const fxRowIndex = cellAt ? (gridIndex.get(cellAt.rowId) ?? -1) : -1
  const fxAddress = fxColIndex >= 0 && fxRowIndex >= 0 ? `${columnLetter(fxColIndex)}${String(fxRowIndex + 1)}` : ''
  const fxKey = cellAt ? `${cellAt.rowId}|${cellAt.colKey}` : ''
  const fxEntry = cellAt ? entries.find((e) => (e.kind === 'data' ? e.row.jobId : e.id) === cellAt.rowId) : undefined
  let fxValue = ''
  let fxEditable = false
  if (fxEntry && fxColumn) {
    if (fxEntry.kind === 'data') {
      fxValue = currentRaw(fxEntry.row, fxColumn)
      fxEditable = isEditable(fxColumn, fxEntry.row)
    } else if (fxEntry.kind === 'free') {
      fxValue = fxEntry.values[fxColumn.key] ?? ''
      fxEditable = true
    } else fxValue = fxEntry.label
  }
  const commitFx = (text: string) => {
    setFxDraft(null)
    if (!fxEntry || !fxColumn || !fxEditable || text === fxValue) return
    if (fxEntry.kind === 'data') void applyValues([{ row: fxEntry.row, column: fxColumn, text }])
    else if (fxEntry.kind === 'free') writeFree([{ pos: fxEntry.pos, colKey: fxColumn.key, text }])
  }

  const can = { undo: histSize.undo > 0, redo: histSize.redo > 0 }
  const focusColumn = focus ? columnOf(focus.colKey) : null

  return (
    <div onKeyDownCapture={onKeyDownCapture} onMouseMove={(e) => (mouse.current = { x: e.clientX, y: e.clientY })}>
      {/* 도구막대 */}
      <div className={css.toolbar}>
        {toolbarStart ? <span className={css.group}>{toolbarStart}</span> : null}
        <span className={css.group}>
          <button type="button" className={css.tool} disabled={!can.undo} title={`실행취소 (${shortcuts.undo ?? ''})`} onClick={() => void undo()}>↶</button>
          <button type="button" className={css.tool} disabled={!can.redo} title={`재실행 (${shortcuts.redo ?? ''})`} onClick={() => void redo()}>↷</button>
        </span>
        <span className={css.group}>
          <Stepper
            title="글자 크기"
            value={focusStyle.size ?? DEFAULT_SIZE}
            min={6}
            max={40}
            step={1}
            onChange={(n) => void applyStyle({ size: n === DEFAULT_SIZE ? null : n }, '글자 크기')}
          />
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
          {/* 테두리 — 구글 시트처럼 아이콘 판 (팀장님 2026-11-25) */}
          <BorderMenu color={borderColor} weight={borderWeight} onColor={setBorderColor} onWeight={setBorderWeight} onPick={applyBorder} />
          <IconMenu title="가로 정렬" icons={ALIGN_ICONS} value={focusStyle.align ?? 'left'} onPick={(k) => void applyStyle({ align: k }, '가로 정렬')} />
          <IconMenu title="세로 정렬" icons={VALIGN_ICONS} value={focusStyle.valign ?? 'middle'} onPick={(k) => void applyStyle({ valign: k }, '세로 정렬')} />
          <IconMenu title="텍스트 줄바꿈" icons={WRAP_ICONS} value={focusStyle.wrap ?? 'overflow'} onPick={(k) => void applyStyle({ wrap: k === 'overflow' ? null : k }, '텍스트 줄바꿈')} />
          <button type="button" className={css.iconTool} title={`메모 (${shortcuts.note ?? ''})`} onClick={() => runAction('note')}>{TOOL_ICONS.note}메모</button>
          <button type="button" className={css.iconTool} title="서식 지우기" onClick={() => runAction('clearFormat')}>{TOOL_ICONS.clearFormat}서식 지우기</button>
        </span>
        <span className={css.group}>
          <button type="button" className={css.iconTool} onClick={() => setModal('cf')}>{TOOL_ICONS.cf}조건부 서식</button>
          <button type="button" className={css.iconTool} onClick={() => setModal('columns')}>{TOOL_ICONS.columns}열 관리</button>
          <button type="button" className={css.iconTool} onClick={() => setModal('shortcuts')}>{TOOL_ICONS.shortcuts}단축키</button>
          <FreezeMenu
            icon={TOOL_ICONS.freeze}
            cols={freezeCols}
            rows={freezeRows}
            onCols={(n) => void savePref('view', { ...(prefs.view ?? {}), freezeCols: n })}
            onRows={(n) => void savePref('view', { ...(prefs.view ?? {}), freezeRows: n })}
          />
        </span>
        <span className={css.group}>
          <button type="button" className={css.iconTool} title="고른 행(같은 프로젝트·같은 납기)을 한 행으로 — 경로 등은 맨 위 행의 값" onClick={() => void mergeRows()}>{TOOL_ICONS.merge}행 통합</button>
          <button type="button" className={css.iconTool} title="풀린 행은 통합 행 바로 아래에 새 줄로 들어갑니다" onClick={() => void unmergeRows()}>{TOOL_ICONS.unmerge}통합 해제</button>
          {focusRow?.pmState === GROUP_START ? (
            <label className={css.tool} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title="인계일 기준 월별 머리행을 넣습니다">
              <input type="checkbox" checked={focusRow.groupMonthly} onChange={() => void toggleMonthly()} />
              월별 정리
            </label>
          ) : null}
          <button type="button" className={css.iconTool} title="고른 행을 이 시트에서 뺍니다" onClick={() => void hideRows()}>{TOOL_ICONS.hide}행 빼기</button>
          <button
            type="button"
            className={css.iconTool}
            title="진행 상태가 '납품 완료' 인 행을 모두 '완료 업무' 시트로 옮깁니다"
            onClick={() => (archiveCount > 0 ? setArchiveAsk(true) : onNotice("진행 상태가 '납품 완료' 인 행이 없습니다."))}
          >
            {TOOL_ICONS.archive}아카이빙
          </button>
        </span>
        <span className={css.group}>
          {favorites.map((f) => (
            <span key={f.id} className={css.fav}>
              <button type="button" className={`${css.favBtn} ${activeFav?.id === f.id ? css.favOn : ''}`} onClick={() => setFilters(activeFav?.id === f.id ? {} : f.filters)}>{f.label}</button>
              <button type="button" className={css.favX} title="즐겨찾기 지우기" onClick={() => void savePref('filters', { favorites: favorites.filter((x) => x.id !== f.id) })}>×</button>
            </span>
          ))}
          <button type="button" className={css.iconTool} title="지금 걸린 필터를 버튼으로 저장 (최대 3개)" onClick={saveFavorite}>{TOOL_ICONS.favSave}필터 저장</button>
          {Object.values(filters).some((v) => v.length > 0) ? (
            <button type="button" className={css.iconTool} onClick={() => setFilters({})}>{TOOL_ICONS.filterClear}필터 해제</button>
          ) : null}
        </span>
        <span className={css.group} title="시트 배율 (5% 단위, 이 시트에 저장)">
          {TOOL_ICONS.zoom}
          <Stepper
            title="시트 배율"
            value={zoom}
            min={50}
            max={200}
            step={5}
            suffix="%"
            wide
            onChange={(n) => void savePref('view', { ...(prefs.view ?? {}), zoom: n })}
          />
        </span>
        {changedCount > 0 ? (
          <span className={css.group}>
            <button
              type="button"
              className={`${css.iconTool} ${css.iconToolAlert}`}
              title="다른 사람이 프로젝트·작업 창에서 바꾼 칸을 모두 확인합니다 (기다리는 재인계도 함께 확인)"
              onClick={() => void confirmChanges(changedRows.map((r) => r.jobId))}
            >
              {TOOL_ICONS.confirm}바뀐 칸 {changedCount}개 · 모두 확인
            </button>
          </span>
        ) : null}
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

      {/* 데이터 줄 — 고른 칸의 주소(A1)와 전체 내용. 고칠 수 있는 칸이면 여기서 고치고 Enter. */}
      <FormulaBar
        address={fxAddress}
        value={fxValue}
        editable={fxEditable}
        draft={fxDraft && fxDraft.key === fxKey ? fxDraft.text : null}
        onDraft={(text) => setFxDraft({ key: fxKey, text })}
        onCancel={() => setFxDraft(null)}
        onCommit={commitFx}
      />

      {/* 시트 */}
      <div
        className={css.gridWrap}
        ref={gridBox}
        style={{ ...(gridHeight ? { height: gridHeight, maxHeight: 'none' } : {}), ['--pm-zoom' as string]: String(z) } as CSSProperties}
      >
        {dataCount === 0 ? (
          <p style={{ padding: 16 }}>
            {sheet.rows.length === 0 ? '이 시트에 아직 작업이 없습니다. "인계" 탭에서 인계를 받으면 여기에 들어옵니다.' : '필터에 맞는 행이 없습니다.'}
          </p>
        ) : null}
        <ReactGrid
          rows={[lettersRow, headerRow, ...gridRows]}
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
          stickyTopRows={2 + Math.min(freezeRows, renderRows.length)}
          stickyLeftColumns={freezeCols + 1}
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

      {taskMenu ? (
        <TaskMenu
          x={taskMenu.x}
          y={taskMenu.y}
          options={workOptions.map((o) => ({ value: o.value, label: o.label }))}
          current={rowById.get(taskMenu.jobId) ? fixedRaw(rowById.get(taskMenu.jobId)!, 'task', { merged: [], inGroup: false, rowNo: 0 }) : ''}
          onClose={() => setTaskMenu(null)}
          onPick={(code) => {
            const row = rowById.get(taskMenu.jobId)
            setTaskMenu(null)
            if (row) void pickTask(row, code)
          }}
          onFree={(text) => {
            const row = rowById.get(taskMenu.jobId)
            const column = columnOf('task')
            setTaskMenu(null)
            if (row && column) void applyValues([{ row, column, text }])
          }}
        />
      ) : null}
      {sheetPo ? (
        <SheetPoModal
          action={sheetPo.action}
          projectId={sheetPo.projectId}
          onClose={() => setSheetPo(null)}
          onSaved={(message) => {
            onNotice(message)
            refresh()
          }}
        />
      ) : null}

      {archiveAsk ? (
        <ConfirmDialog
          title="아카이빙"
          message="완료된 업무를 완료 업무 시트로 보내시겠습니까?"
          detail={`진행 상태가 '납품 완료' 인 ${String(archiveCount)}행(프로젝트 행 ${String(archiveHeads.length)} · 직접 만든 행 ${String(archiveFrees.length)})이 '완료 업무' 시트로 옮겨지고, 이 시트에서는 빠집니다.`}
          confirmLabel="보내기"
          pending={archiving}
          onConfirm={() => void runArchive()}
          onCancel={() => setArchiveAsk(false)}
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
          colCount={menuCols(colMenu.key).length}
          deletable={menuCols(colMenu.key).some(isCustomKey)}
          hiddenCount={(prefs.columns?.hidden ?? []).length}
          onHide={() => {
            void hideColumns(menuCols(colMenu.key))
            setColMenu(null)
          }}
          onAdd={(side) => {
            void addColumnBeside(menuCols(colMenu.key), side)
            setColMenu(null)
          }}
          onDelete={() => {
            void deleteColumns(menuCols(colMenu.key))
            setColMenu(null)
          }}
          copyPath={colMenu.key === 'path' && colMenu.jobId && menuValue(colMenu) !== BLANK ? menuValue(colMenu) : null}
          onCopyPath={() => {
            const v = menuValue(colMenu)
            if (v && v !== BLANK) {
              void navigator.clipboard.writeText(v).then(
                () => onNotice('경로를 복사했습니다. 탐색기 주소창에 붙여 넣으세요.'),
                () => onError('복사하지 못했습니다. 칸을 고르고 Ctrl+C 를 눌러 주세요.'),
              )
            }
            setColMenu(null)
          }}
          onShowHidden={() => {
            void savePref('columns', { ...(prefs.columns ?? {}), hidden: [] })
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
      {rowMenu ? (
        <RowMenu
          x={rowMenu.x}
          y={rowMenu.y}
          linked={rowsForMenu(rowMenu.rowId).some((id) => rowById.has(id))}
          count={rowsForMenu(rowMenu.rowId).length}
          onClose={() => setRowMenu(null)}
          onInsert={(below) => void insertRows(rowMenu.rowId, below)}
          onDelete={() => void deleteRows(rowMenu.rowId)}
        />
      ) : null}
      {confirmAt ? (
        <ConfirmPop
          x={confirmAt.x}
          y={confirmAt.y}
          rowCount={(() => {
            const e = entries.find((x): x is DataEntry => x.kind === 'data' && x.row.jobId === confirmAt.jobId)
            return e ? changedSet(e).size : 0
          })()}
          onCell={() => {
            const e = entries.find((x): x is DataEntry => x.kind === 'data' && x.row.jobId === confirmAt.jobId)
            const ids = e ? [e.row, ...e.merged].filter((r) => r.changedKeys.includes(confirmAt.colKey)).map((r) => r.jobId) : [confirmAt.jobId]
            void confirmChanges(ids, [confirmAt.colKey])
          }}
          onRow={() => {
            const e = entries.find((x): x is DataEntry => x.kind === 'data' && x.row.jobId === confirmAt.jobId)
            void confirmChanges(e ? [e.row, ...e.merged].map((r) => r.jobId) : [confirmAt.jobId])
          }}
          onClose={() => setConfirmAt(null)}
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
    </div>
  )

  function isEditable(column: SheetColumn, row: PmSheetRow): boolean {
    const src = column.spec.source
    void row
    return src !== 'readonly'
  }
}

/* -------------------------------------------------------------------------- */
/* Small parts                                                                */
/* -------------------------------------------------------------------------- */

/** `− 13 +` — 눌러서 한 단계씩, 숫자를 쳐서 Enter 로 바로 (구글 시트의 글자 크기와 같은 모양). */
function Stepper(props: {
  title: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  wide?: boolean
  onChange: (value: number) => void
}) {
  const { value, min, max, step, suffix = '' } = props
  const [text, setText] = useState<string | null>(null)
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n / step) * step))
  const commit = () => {
    if (text === null) return
    const n = Number(text.replace(/[^\d.]/g, ''))
    setText(null)
    if (Number.isFinite(n) && n > 0 && clamp(n) !== value) props.onChange(clamp(n))
  }
  return (
    <span className={`${css.stepper} ${props.wide ? css.stepperWide : ''}`} title={props.title}>
      <button type="button" aria-label={`${props.title} 줄이기`} disabled={value <= min} onClick={() => props.onChange(clamp(value - step))}>−</button>
      <input
        aria-label={props.title}
        value={text ?? `${String(value)}${suffix}`}
        onFocus={(e) => {
          const el = e.currentTarget
          requestAnimationFrame(() => el.select())
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setText(null)
        }}
      />
      <button type="button" aria-label={`${props.title} 키우기`} disabled={value >= max} onClick={() => props.onChange(clamp(value + step))}>+</button>
    </span>
  )
}

function FormulaBar(props: {
  address: string
  value: string
  editable: boolean
  draft: string | null
  onDraft: (text: string) => void
  onCancel: () => void
  onCommit: (text: string) => void
}) {
  const shown = props.draft ?? props.value
  return (
    <div className={css.fxBar}>
      <span className={css.fxAddr} aria-label="칸 주소">{props.address}</span>
      <span className={css.fxMark} aria-hidden="true">fx</span>
      <input
        className={css.fxInput}
        aria-label="칸 내용"
        value={shown}
        readOnly={!props.editable}
        placeholder={props.address ? (props.editable ? '' : '이 칸은 여기서 고칠 수 없습니다') : '칸을 고르면 내용이 여기에 보입니다'}
        onChange={(e) => props.onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            props.onCommit(shown)
          }
          if (e.key === 'Escape') props.onCancel()
        }}
        onBlur={() => {
          if (props.draft !== null) props.onCommit(props.draft)
        }}
      />
    </div>
  )
}

function RowMenu(props: {
  x: number
  y: number
  linked: boolean
  count: number
  onClose: () => void
  onInsert: (below: boolean) => void
  onDelete: () => void
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
  const n = props.count > 1 ? `${String(props.count)}개 ` : ''
  return (
    <div ref={box} className={css.stateMenu} style={{ left: Math.min(props.x, window.innerWidth - 220), top: Math.min(props.y + 2, window.innerHeight - 140), minWidth: 200 }}>
      <button type="button" className={css.stateItem} onClick={() => props.onInsert(false)}>위에 행 {n}추가</button>
      <button type="button" className={css.stateItem} onClick={() => props.onInsert(true)}>아래에 행 {n}추가</button>
      <button
        type="button"
        className={css.stateItem}
        disabled={props.linked}
        style={props.linked ? { color: '#9aa3ae', cursor: 'default' } : { color: '#b3261e' }}
        title={props.linked ? '프로젝트(작업)에 연결된 행은 지울 수 없습니다' : undefined}
        onClick={props.onDelete}
      >
        행 {n}삭제{props.linked ? ' (작업 연결 행 — 불가)' : ''}
      </button>
    </div>
  )
}

function ConfirmPop(props: { x: number; y: number; rowCount: number; onCell: () => void; onRow: () => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const { onClose } = props
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div ref={box} className={css.confirmPop} style={{ left: Math.min(props.x, window.innerWidth - 220), top: Math.max(4, props.y) }} onMouseDown={(e) => e.stopPropagation()}>
      <button type="button" onClick={props.onCell} title="이 칸을 확인 — 서식이 원래대로 돌아갑니다">확인</button>
      {props.rowCount > 1 ? (
        <button type="button" onClick={props.onRow} title="이 행의 바뀐 칸을 모두 확인">행 전체 ({props.rowCount})</button>
      ) : null}
    </div>
  )
}

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
  /** 열 숨기기 · 추가 · 삭제 (팀장님 2026-11-25). count 는 고른 열 수. */
  colCount: number
  deletable: boolean
  hiddenCount: number
  onHide: () => void
  onAdd: (side: 'left' | 'right') => void
  onDelete: () => void
  onShowHidden: () => void
  /** 경로 칸이면 그 경로 — [경로 복사] (팀장님 2026-11-25). */
  copyPath?: string | null
  onCopyPath?: () => void
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
  const top = Math.min(props.y, window.innerHeight - 470)
  const short = (v: string) => (v.length > 16 ? `${v.slice(0, 16)}…` : v)
  return (
    <div ref={box} className={css.ctxMenu} style={{ left, top }} onContextMenu={(e) => e.preventDefault()}>
      <div className={css.ctxHead}>{props.label}</div>
      {props.copyPath ? (
        <>
          <button type="button" className={css.ctxItem} onClick={props.onCopyPath} title="탐색기 주소창에 붙여 넣으세요">📋 경로 복사</button>
          <div className={css.ctxSep} />
        </>
      ) : null}
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
      <div className={css.ctxSep} />
      <button type="button" className={css.ctxItem} onClick={() => props.onAdd('left')}>⇤ 왼쪽에 열 추가</button>
      <button type="button" className={css.ctxItem} onClick={() => props.onAdd('right')}>⇥ 오른쪽에 열 추가</button>
      <button type="button" className={css.ctxItem} onClick={props.onHide}>
        👁 열 숨기기{props.colCount > 1 ? ` (${String(props.colCount)}개)` : ''}
      </button>
      <button
        type="button"
        className={css.ctxItem}
        disabled={!props.deletable}
        title={props.deletable ? undefined : '기본 열은 삭제할 수 없습니다 — 숨기기를 쓰세요. 추가한 열만 삭제됩니다.'}
        onClick={props.onDelete}
      >
        🗑 열 삭제{props.colCount > 1 ? ` (${String(props.colCount)}개)` : ''}
      </button>
      {props.hiddenCount > 0 ? (
        <button type="button" className={css.ctxItem} onClick={props.onShowHidden}>
          숨긴 열 모두 보이기 ({String(props.hiddenCount)}개)
        </button>
      ) : null}
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

/** 업무 칸 목록 — 작업 등록창의 '작업 종류' 와 같은 목록, 맨 아래 '직접 입력' (팀장님 2026-11-26). */
function TaskMenu(props: {
  x: number
  y: number
  options: { value: string; label: string }[]
  current: string
  onPick: (code: string) => void
  onFree: (text: string) => void
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const { onClose } = props
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  const height = Math.min(360, props.options.length * 30 + 44)
  return (
    <div
      ref={box}
      className={css.stateMenu}
      style={{ left: Math.min(props.x, window.innerWidth - 220), top: Math.min(props.y + 2, window.innerHeight - height - 8), minWidth: 180, maxHeight: 360, overflow: 'auto' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`${css.stateItem} ${o.value === props.current ? css.stateItemOn : ''}`}
          onClick={() => props.onPick(o.value)}
          title="프로젝트의 작업에도 반영됩니다"
        >
          {o.label}
        </button>
      ))}
      {typing ? (
        <input
          className={css.taskFree}
          autoFocus
          placeholder="직접 입력 후 Enter (시트에만)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) props.onFree(text.trim())
          }}
        />
      ) : (
        <button type="button" className={css.stateItem} style={{ color: '#1a73e8' }} onClick={() => setTyping(true)} title="시트에만 남고 프로젝트에는 반영되지 않습니다">
          ✎ 직접 입력…
        </button>
      )}
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
  if (style.size) out.fontSize = `calc(${String(style.size)}px * var(--pm-zoom, 1))`
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
