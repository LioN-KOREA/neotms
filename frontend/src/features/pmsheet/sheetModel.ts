/**
 * 시트의 '보이는 모양' 을 만드는 순수 함수들 — 칸 값, 정렬, 필터, 별도 관리 묶음, 월별 머리행, 행 통합.
 * 화면(React)과 떼어 둔 이유: 이 규칙들은 테스트로 지켜야 하는 것이고, 렌더 코드 안에 있으면
 * 브라우저를 띄우지 않고는 확인할 수 없다.
 */
import { GROUP_END, GROUP_START, type PmSheetCell, type PmSheetRow, type PmStyle } from '@/apis/pmsheet.api'
import { evaluateFormula, isFormula, type FormulaValue } from './sheetFormula'
import { asNumber, formatHour, formatNumber, formatSheetDate, isYmd, todayYmd } from './sheetFormat'
import { isCustomKey, type SheetColumn } from './sheetColumns'

export interface CellValue {
  /** 저장된 값(편집할 때 보이는 값). 날짜 `YYYY-MM-DD`, 시각 `HH:MM`, 수식 `=...`. */
  raw: string
  /** 보이는 글자. */
  shown: string
  /** 마우스를 올리면 보이는 설명(수식 오류 등). */
  tooltip?: string
  /** 링크로 그릴 주소. */
  href?: string
  /** 앱 안 이동(프로젝트 화면)인지. */
  internal?: boolean
}

export type CellMap = Map<string, PmSheetCell>
export const cellKey = (jobId: string, colKey: string) => `${jobId}|${colKey}`

export function indexCells(cells: readonly PmSheetCell[]): CellMap {
  return new Map(cells.map((c) => [cellKey(c.jobId, c.colKey), c]))
}

/** ISO 시각 → 한국 날짜 `YYYY-MM-DD`. */
export function isoToYmd(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10)
  return todayYmd(d)
}

export interface DisplayContext {
  columns: readonly SheetColumn[]
  cells: CellMap
  /** 이 행에 통합된 다른 행들. */
  merged: readonly PmSheetRow[]
  inGroup: boolean
  rowNo: number
  /** 칸마다 덮어쓸 값(저장 중인 값). 키는 `jobId|colKey`. */
  overrides: Map<string, string>
}

const langOf = (row: PmSheetRow, merged: readonly PmSheetRow[]): string => {
  const all = [row, ...merged]
  const sources = [...new Set(all.map((r) => r.slang ?? ''))]
  const targets = [...new Set(all.map((r) => r.elang ?? ''))].filter(Boolean)
  if (!row.slang && targets.length === 0) return ''
  if (sources.length === 1) return `${sources[0]}→${targets.join('·')}`
  return all.map((r) => `${r.slang ?? ''}→${r.elang ?? ''}`).join(', ')
}

/** 기본 열의 저장된 값. */
export function fixedRaw(row: PmSheetRow, key: string, ctx: Pick<DisplayContext, 'merged' | 'inGroup' | 'rowNo'>): string {
  switch (key) {
    case 'rowNo':
      return String(ctx.rowNo)
    case 'handoverAt':
      return isoToYmd(row.handoverAt)
    case 'cusCodeName':
      // 기획서: 별도 관리 묶음 안으로 옮긴 행은 업체명 자리에 JOB 명칭이 들어간다.
      return ctx.inGroup ? (row.jobName ?? row.cusCodeName ?? '') : (row.cusCodeName ?? '')
    case 'cusMgrName':
      return row.cusMgrName ?? ''
    case 'prjMgrName':
      return row.prjMgrName ?? ''
    case 'lang':
      return langOf(row, ctx.merged)
    case 'task':
      return row.fields.task ?? '번역'
    case 'translator':
      return row.tr?.tranName ?? ''
    case 'trVolume':
      return row.tr?.volume ?? ''
    case 'trPo':
      return row.tr ? '발행' : '-'
    case 'trEday':
      return row.tr?.eday ?? ''
    case 'trTime':
      return row.tr?.edayTime ?? ''
    case 'reviewer':
      return row.rv?.tranName ?? ''
    case 'rvVolume':
      return row.rv?.volume ?? ''
    case 'rvPo':
      return row.rv ? '발행' : '-'
    case 'rvEday':
      return row.rv?.eday ?? ''
    case 'rvTime':
      return row.rv?.edayTime ?? ''
    case 'jobEday':
      return row.jobEday ?? ''
    case 'jobTime':
      return row.jobEdayTime ?? ''
    case 'pmState':
      return row.pmState ?? ''
    case 'remark':
    case 'backup':
    case 'path':
      return row.fields[key] ?? ''
    case 'prjCode':
      return row.prjCode
    default:
      return ''
  }
}

/** 저장된 값을 보이는 글자로. `decimals` 는 이 칸에 걸린 소수 자릿수. */
export function shownOf(column: SheetColumn, raw: string, decimals: number | null | undefined): string {
  const kind = column.spec.kind
  if (kind === 'date') return formatSheetDate(raw)
  if (kind === 'hour') return formatHour(raw)
  if (kind === 'number') {
    const n = asNumber(raw)
    return n === null ? raw : formatNumber(n, decimals)
  }
  if (column.spec.source === 'custom') {
    if (isYmd(raw)) return formatSheetDate(raw)
    const n = asNumber(raw)
    if (n !== null) return formatNumber(n, decimals)
  }
  return raw
}

/**
 * 한 칸의 값. 추가 열의 수식은 같은 행의 `[열 이름]` 을 읽어 계산한다 —
 * 수식이 수식을 가리키면 그 수식을 먼저 계산하고, 돌고 도는 참조는 오류다.
 */
export function cellValue(
  row: PmSheetRow,
  column: SheetColumn,
  ctx: DisplayContext,
  decimals: number | null | undefined,
  visiting: Set<string> = new Set(),
): CellValue {
  const override = ctx.overrides.get(cellKey(row.jobId, column.key))
  const raw =
    override ??
    (isCustomKey(column.key) ? (ctx.cells.get(cellKey(row.jobId, column.key))?.value ?? '') : fixedRaw(row, column.key, ctx))

  if (column.key === 'prjCode') {
    return { raw, shown: raw, href: `/projects/${row.projectId}`, internal: true }
  }

  if (isCustomKey(column.key) && isFormula(raw)) {
    if (visiting.has(column.key)) return { raw, shown: '#오류', tooltip: '수식이 자기 자신을 가리킵니다.' }
    visiting.add(column.key)
    const result = evaluateFormula(raw, (name): FormulaValue => {
      const target = ctx.columns.find((c) => c.label === name)
      if (!target) throw new Error(`열 [${name}] 이 없습니다.`)
      const v = cellValue(row, target, ctx, null, visiting)
      const n = asNumber(v.raw)
      return n !== null ? n : v.shown === '#오류' ? (() => { throw new Error(v.tooltip ?? '참조한 칸이 오류입니다.') })() : v.raw
    })
    visiting.delete(column.key)
    if (!result.ok) return { raw, shown: '#오류', tooltip: result.reason }
    const value = result.value
    const shown =
      typeof value === 'number'
        ? formatNumber(value, decimals ?? (Number.isInteger(value) ? 0 : 2))
        : typeof value === 'boolean'
          ? value ? 'TRUE' : 'FALSE'
          : isYmd(value) ? formatSheetDate(value) : value
    return { raw, shown, tooltip: raw }
  }

  const shown = shownOf(column, raw, decimals)
  const urlLike = /^(https?:\/\/|www\.)\S+$/i.test(raw.trim())
  return urlLike ? { raw, shown, href: /^www\./i.test(raw.trim()) ? `https://${raw.trim()}` : raw.trim() } : { raw, shown }
}

/* -------------------------------------------------------------------------- */
/* Order, filter, groups                                                      */
/* -------------------------------------------------------------------------- */

export type SortState = { key: string; dir: 'asc' | 'desc' } | null
export type Filters = Record<string, string[]>

export const BLANK = '(빈 칸)'

export interface DataEntry {
  kind: 'data'
  row: PmSheetRow
  merged: PmSheetRow[]
  inGroup: boolean
  groupRole: 'start' | 'end' | null
  rowNo: number
}
export interface MonthEntry {
  kind: 'month'
  id: string
  label: string
}
/** 빈 줄 — 작업이 아닌 행. 글을 적을 수 있다 (`values`). */
export interface FreeEntry {
  kind: 'free'
  id: string
  pos: number
  values: Record<string, string>
}
export type Entry = DataEntry | MonthEntry | FreeEntry

const compareValues = (a: string, b: string): number => {
  const na = asNumber(a)
  const nb = asNumber(b)
  if (na !== null && nb !== null) return na - nb
  if (a === '' && b !== '') return 1
  if (b === '' && a !== '') return -1
  return a.localeCompare(b, 'ko')
}

/**
 * 보이는 행 목록을 만든다.
 *   1. 통합된 행(mergedInto)은 대상 행 안으로 들어간다.
 *   2. 필터를 건다(열마다 보이는 값 목록).
 *   3. 정렬이 있으면 그 열로 — 정렬 중에는 묶음·월별 머리행을 만들지 않는다(순서가 뜻을 잃으므로).
 *      정렬이 없으면 저장된 순서(ord_no → 인계일)대로, 별도 관리 묶음과 월별 머리행을 만든다.
 */
export function buildEntries(args: {
  rows: readonly PmSheetRow[]
  columns: readonly SheetColumn[]
  cells: CellMap
  sort: SortState
  filters: Filters
  overrides: Map<string, string>
  decimalsOf: (row: PmSheetRow, column: SheetColumn) => number | null | undefined
  /** 작업 행의 자리 (freeRows.layoutPositions). 없으면 빈 줄 없이 받은 순서대로. */
  posOf?: Map<string, number>
  /** 글을 적은 빈 줄들. */
  freeRows?: readonly { pos: number; values: Record<string, string> }[]
  /** 맨 아래 덧붙일 빈 줄 수. */
  blankTail?: number
}): Entry[] {
  const { rows, columns, cells, sort, filters, overrides, posOf } = args
  const ids = new Set(rows.map((r) => r.jobId))
  const mergedBy = new Map<string, PmSheetRow[]>()
  const visible: PmSheetRow[] = []
  for (const row of rows) {
    if (row.mergedInto && ids.has(row.mergedInto)) {
      const list = mergedBy.get(row.mergedInto) ?? []
      list.push(row)
      mergedBy.set(row.mergedInto, list)
    } else visible.push(row)
  }
  // 자리 순서로 (자리가 정해지지 않은 행은 뒤로 — 받은 순서 그대로).
  if (posOf) visible.sort((a, b) => (posOf.get(a.jobId) ?? Number.MAX_SAFE_INTEGER) - (posOf.get(b.jobId) ?? Number.MAX_SAFE_INTEGER))

  // 묶음 판정은 저장된 순서에서 한다 — 정렬·필터 전.
  const groupInfo = new Map<string, { inGroup: boolean; role: 'start' | 'end' | null }>()
  let open = false
  for (const row of visible) {
    if (row.pmState === GROUP_START) {
      open = true
      groupInfo.set(row.jobId, { inGroup: true, role: 'start' })
    } else if (row.pmState === GROUP_END) {
      groupInfo.set(row.jobId, { inGroup: open, role: 'end' })
      open = false
    } else groupInfo.set(row.jobId, { inGroup: open, role: null })
  }

  const ctxOf = (row: PmSheetRow, rowNo: number): DisplayContext => ({
    columns,
    cells,
    merged: mergedBy.get(row.jobId) ?? [],
    inGroup: groupInfo.get(row.jobId)?.inGroup ?? false,
    rowNo,
    overrides,
  })

  // 행ID = 저장된 순서의 번호. 정렬·필터해도 같은 행은 같은 번호 — 말로 가리킬 수 있게.
  const rowNoOf = new Map(visible.map((r, i) => [r.jobId, i + 1]))

  const shownFor = (row: PmSheetRow, key: string): { raw: string; shown: string } => {
    const column = columns.find((c) => c.key === key)
    if (!column) return { raw: '', shown: '' }
    const v = cellValue(row, column, ctxOf(row, rowNoOf.get(row.jobId) ?? 0), args.decimalsOf(row, column))
    return { raw: v.raw, shown: v.shown }
  }

  const activeFilters = Object.entries(filters).filter(([, allowed]) => allowed.length > 0)
  let list = visible.filter((row) =>
    activeFilters.every(([key, allowed]) => {
      const s = shownFor(row, key).shown
      return allowed.includes(s === '' ? BLANK : s)
    }),
  )

  if (sort) {
    list = [...list].sort((a, b) => {
      const va = shownFor(a, sort.key)
      const vb = shownFor(b, sort.key)
      // 날짜·숫자는 저장된 값으로, 글자는 보이는 글자로.
      const c = compareValues(isYmd(va.raw) || asNumber(va.raw) !== null ? va.raw : va.shown, isYmd(vb.raw) || asNumber(vb.raw) !== null ? vb.raw : vb.shown)
      return sort.dir === 'asc' ? c : -c
    })
  }

  const out: Entry[] = []
  let monthly = false
  let lastMonth = ''
  // 빈 줄은 정렬·필터가 없을 때만 보인다 — 자리 그대로의 시트.
  const withFree = Boolean(posOf) && !sort && activeFilters.length === 0
  const freeByPos = new Map((args.freeRows ?? []).map((f) => [f.pos, f.values]))
  let nextPos = 0
  const fillTo = (pos: number) => {
    for (; nextPos < pos; nextPos += 1) out.push({ kind: 'free', id: `f:${String(nextPos)}`, pos: nextPos, values: freeByPos.get(nextPos) ?? {} })
  }
  for (const row of list) {
    if (withFree) {
      const pos = posOf!.get(row.jobId)
      if (pos !== undefined) {
        fillTo(pos)
        nextPos = pos + 1
      }
    }
    const info = groupInfo.get(row.jobId) ?? { inGroup: false, role: null }
    if (!sort) {
      if (info.role === 'start') {
        monthly = row.groupMonthly
        lastMonth = ''
      } else if (info.inGroup && info.role !== 'end' && monthly) {
        const ymd = isoToYmd(row.handoverAt)
        const month = ymd.slice(0, 7)
        if (month && month !== lastMonth) {
          lastMonth = month
          out.push({ kind: 'month', id: `m:${row.jobId}`, label: `${month.slice(2, 4)}년 ${Number(month.slice(5, 7))}월` })
        }
      }
      if (info.role === 'end') monthly = false
    }
    out.push({
      kind: 'data',
      row,
      merged: mergedBy.get(row.jobId) ?? [],
      inGroup: info.inGroup,
      groupRole: info.role,
      rowNo: rowNoOf.get(row.jobId) ?? 0,
    })
  }
  if (withFree) {
    const lastFree = Math.max(-1, ...freeByPos.keys())
    fillTo(Math.max(lastFree + 1, nextPos) + (args.blankTail ?? 0))
  }
  return out
}

/** 필터 팝업에 보일 값 목록(보이는 글자, 빈 칸은 `(빈 칸)`). */
export function distinctValues(
  rows: readonly PmSheetRow[],
  column: SheetColumn,
  columns: readonly SheetColumn[],
  cells: CellMap,
  overrides: Map<string, string>,
): string[] {
  const set = new Set<string>()
  rows.forEach((row, i) => {
    const v = cellValue(row, column, { columns, cells, merged: [], inGroup: false, rowNo: i + 1, overrides }, null)
    set.add(v.shown === '' ? BLANK : v.shown)
  })
  return [...set].sort((a, b) => (a === BLANK ? 1 : b === BLANK ? -1 : compareValues(a, b)))
}

/**
 * 행 통합 조건(기획서): 같은 프로젝트의 작업이고, 언어 외 업체/담당자/납기/PRCODE/경로가 같을 것.
 * 맞지 않으면 이유를 돌려준다.
 */
export function mergeProblem(rows: readonly PmSheetRow[]): string | null {
  if (rows.length < 2) return '통합할 행을 두 개 이상 골라 주세요.'
  const first = rows[0]!
  for (const row of rows.slice(1)) {
    if (row.projectId !== first.projectId) return '같은 프로젝트의 작업만 통합할 수 있습니다.'
    if ((row.cusCodeName ?? '') !== (first.cusCodeName ?? '')) return '업체가 다른 행이 있습니다.'
    if ((row.cusMgrName ?? '') !== (first.cusMgrName ?? '')) return '업체 담당자가 다른 행이 있습니다.'
    if ((row.jobEday ?? '') !== (first.jobEday ?? '') || (row.jobEdayTime ?? '') !== (first.jobEdayTime ?? '')) {
      return '납기가 다른 행이 있습니다.'
    }
    if ((row.fields.path ?? '') !== (first.fields.path ?? '')) return '경로가 다른 행이 있습니다.'
  }
  return null
}

/** 칸 꾸밈 맵에서 한 칸의 꾸밈. */
export const cellStyleOf = (cells: CellMap, jobId: string, colKey: string): PmStyle =>
  cells.get(cellKey(jobId, colKey))?.style ?? {}
