import { useMemo, useState } from 'react'
import {
  ReactGrid,
  type Cell,
  type CellChange,
  type CellStyle,
  type CellTemplate,
  type Column,
  type Compatible,
  type DefaultCellTypes,
  type DropdownCell,
  type Id,
  type Range,
  type Row,
  type TextCell,
  type Uncertain,
} from '@silevis/reactgrid'
import '@silevis/reactgrid/styles.css'
import { useCodeNames, useCodeOptions } from '@/apis/queries/neotms.query'
import {
  useSetWorkspaceLayout,
  useUpdateJob,
  useUpdatePurchaseOrder,
  useWriteWorkspaceCell,
} from '@/apis/queries/neotms.mutation'
import { CODE_DOMAIN, isLinguistic, PO_STATES } from '@/apis/neotms.codes'
import type { WorkspaceColumnDef, WorkspaceRow, WorkspaceStyle } from '@/apis/neotms.types'
import { formatDateField, parseDateField } from '@/shared/utils/format'
import { isDecimalString } from '@/shared/utils/money'
import { mayChangeTranslator, translatorLockReason } from '@/features/purchaseorders/TranslatorSwapModal'
import {
  customColumnKey,
  defaultCellText,
  mergeColumns,
  resolveStyle,
  type SheetColumn,
} from './workspaceColumns'
import grid from './WorkspaceGrid.module.css'

/**
 * 번역가 칸. 이 앱이 더한 칸 종류이고, **고르는 일을 자기가 하지 않는다.**
 *
 * ReactGrid 의 드롭다운 칸은 받은 목록에서 고르게 한다. 번역가는 그럴 수 없다 — 후보가 서버의 한
 * 페이지 상한을 넘으므로 목록이 조용히 잘리고, 잘린 목록은 "그 번역가는 없다" 로 읽힌다. 그래서
 * 이 칸은 PO 화면이 쓰는 **같은 대화상자**를 열기만 한다(`TranslatorSwapModal`).
 *
 * `onOpen` 을 칸에 실어 보내는 것이 ReactGrid 에서 이런 칸을 만드는 방법이다. 칸은 값이 아니라
 * 객체이고, 템플릿은 그 객체를 그대로 받는다.
 */
interface PickerCell extends Cell {
  type: 'picker'
  text: string
  onOpen?: () => void
  lockReason?: string
}

/**
 * 머리글 칸 — 정렬 화살표가 붙을 수 있다.
 *
 * 기본 `header` 칸을 쓰지 않는 이유는 **누를 것이 필요하기** 때문이다. 정렬은 이제 시트 위의
 * 드롭다운이 아니라 열 머리글에 있고, 그러려면 머리글이 글자 말고 단추도 그려야 한다.
 *
 * 화살표는 정렬 중인 열에만 **방향**으로 나타나고, 정렬할 수 있는 다른 열에는 흐린 `⇅` 로
 * 나타난다. 아무 표시도 없으면 어느 열을 누를 수 있는지 알 수 없고, 모든 열에 진한 화살표를
 * 그리면 어느 열로 정렬 중인지가 묻힌다.
 */
interface SortHeaderCell extends Cell {
  type: 'sortHeader'
  text: string
  direction?: 'asc' | 'desc' | null
  sortable?: boolean
  onSort?: () => void
}

class SortHeaderCellTemplate implements CellTemplate<SortHeaderCell> {
  getCompatibleCell(uncertain: Uncertain<SortHeaderCell>): Compatible<SortHeaderCell> {
    const text = typeof uncertain.text === 'string' ? uncertain.text : ''
    return { ...uncertain, type: 'sortHeader', text, value: Number.NaN }
  }

  /** 기본 머리글과 같은 클래스를 단다 — 고정 행의 배경과 글꼴이 거기서 온다. */
  getClassName = () => 'rg-header-cell'

  isFocusable = () => false

  render(cell: Compatible<SortHeaderCell>) {
    return (
      <div className={grid.headerCell}>
        <span className={grid.headerText}>{cell.text}</span>
        {cell.sortable ? (
          <button
            type="button"
            className={`${grid.sortBtn} ${cell.direction ? grid.sortOn : ''}`}
            title={cell.direction === 'asc' ? '오름차순 — 눌러서 반대로' : cell.direction === 'desc' ? '내림차순 — 눌러서 반대로' : '이 열로 정렬'}
            /*
             * `pointerdown` 도 멈춘다. ReactGrid 의 선택과 끌기는 click 이 아니라 pointerdown
             * 에서 시작하므로, click 만 막으면 정렬 단추를 누를 때마다 열이 함께 선택된다.
             */
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              cell.onSort?.()
            }}
          >
            {cell.direction === 'asc' ? '▲' : cell.direction === 'desc' ? '▼' : '⇅'}
          </button>
        ) : null}
      </div>
    )
  }
}

class PickerCellTemplate implements CellTemplate<PickerCell> {
  getCompatibleCell(uncertain: Uncertain<PickerCell>): Compatible<PickerCell> {
    const text = typeof uncertain.text === 'string' ? uncertain.text : ''
    return {
      ...uncertain,
      type: 'picker',
      text,
      // 복사·붙여넣기용. 숫자가 아니므로 NaN 이고, 그게 ReactGrid 가 "숫자가 아님" 을 읽는 방법이다.
      value: Number.NaN,
    }
  }

  /** 칸 안에서 고치지 않는다. 편집 모드로 들어갈 일이 없으므로 `isFocusable` 만 남긴다. */
  isFocusable = () => true

  render(cell: Compatible<PickerCell>) {
    return (
      <div className={grid.pickerCell} title={cell.lockReason}>
        <span className={grid.pickerText}>{cell.text || '미지정'}</span>
        {cell.onOpen ? (
          <button type="button" className={grid.pickerBtn} onClick={cell.onOpen}>
            변경
          </button>
        ) : null}
      </div>
    )
  }
}

/** 고칠 수 없는 칸을 눈에 보이게 한다. 왜 못 고치는지는 머리글의 `title` 이 말한다. */
const READONLY_STYLE: CellStyle = { background: 'rgba(127, 127, 127, 0.06)' }

type GridCell = DefaultCellTypes | PickerCell | SortHeaderCell

interface Props {
  rows: readonly WorkspaceRow[]
  columns: readonly WorkspaceColumnDef[]
  /** 작업을 고칠 수 있는지(`JOB:update`). 출발어·도착어 두 칸을 연다. */
  mayEditJob: boolean
  /** PO 를 고칠 수 있는지(`PO:update`). 번역가·분량·납품일·진행상태를 연다. */
  mayEditPo: boolean
  /** 번역가 변경 대화상자를 열어 달라는 요청. 화면이 모달을 들고 있다. */
  onChangeTranslator: (row: WorkspaceRow) => void
  onError: (message: string) => void
  /** 지금 정렬 중인 키와 방향. 머리글의 화살표가 이것을 그린다. */
  sort: string
  dir: 'asc' | 'desc'
  /** 머리글의 화살표를 눌렀다. 같은 열이면 방향을 뒤집는 것은 화면의 몫이다. */
  onSort: (key: string) => void
  /**
   * 지금 고른 범위. 꾸밈 도구막대가 이것을 보고 어디에 칠할지 정한다.
   *
   * 시트가 들고 화면에 올려 보내는 이유는, 선택은 **그리드의 상태**이고 도구막대는 그 상태를
   * 읽기만 하기 때문이다. 반대로 두면 선택할 때마다 화면 전체가 다시 그려진다.
   */
  onSelectionChange: (selection: WorkspaceSelection) => void
}

/** 고른 범위를, 꾸밈을 보낼 수 있는 모양으로. */
export interface WorkspaceSelection {
  /** 고른 칸들. 열 참조와 PO id 의 쌍. */
  cells: { key?: string; id?: string; poId: string }[]
  /** 머리글째 고른 열. */
  columns: { key?: string; id?: string }[]
  /** 통째로 고른 행의 PO id. */
  rows: string[]
}

/**
 * 시트.
 *
 * ## 고친 값을 저장하는 길이 세 가지다
 *
 * 한 화면에서 세 엔드포인트로 나간다. 그게 이 기능의 설계이고 실수가 아니다.
 *
 *   * 출발어·도착어 → `PATCH /api/v0/jobs/{id}`
 *   * 번역가·분량·납품일·진행상태 → `PATCH /api/v0/purchase-orders/{id}`
 *   * 추가 열 → `PUT /api/v0/workspace/cells`
 *
 * 앞의 둘은 **폼이 쓰는 그 엔드포인트**다. 시트 전용 쓰기 경로를 만들면 행 범위 검사, 이름
 * 복제 컬럼(`po_tran_name`), 승인·정산 잠금, 업무 구분 제약, 그리고 그 모든 것의 오류 번역이
 * 두 번째 구현을 갖게 된다 — 서버의 `NeotmsWorkspaceManager` 머리말에 같은 말이 있다.
 *
 * ## 고친 값을 바로 보여 준다
 *
 * `overrides` 가 그 일을 한다. 작업·PO 수정은 성공하면 시트를 무효화하므로 몇백 ms 뒤 서버 값이
 * 도착하는데, 그 사이에 옛 값이 그려지면 **고친 사람은 저장이 안 된 것으로 읽고 한 번 더 고친다.**
 * 실패하면 그 항목을 지워서 서버 값으로 되돌린다 — 저장되지 않은 값이 저장된 것처럼 남아 있는
 * 것이 이 화면에서 가장 비싼 거짓말이다.
 *
 * 새 데이터가 도착하면 **값이 같아진 항목만** 버린다. 전부 버리면 아직 날아가는 중인 저장이
 * 되돌아가 보이고, 아무것도 버리지 않으면 다른 탭에서 바뀐 값을 영원히 가린다.
 */
export function WorkspaceGrid({
  rows,
  columns,
  mayEditJob,
  mayEditPo,
  onChangeTranslator,
  onError,
  sort,
  dir,
  onSort,
  onSelectionChange,
}: Props) {
  /* 프로젝트종류 = `project.prj_field`, and that column reads the PRJCAT list. */
  const fieldName = useCodeNames(CODE_DOMAIN.PRJCAT)
  const setLayout = useSetWorkspaceLayout()
  const langs = useCodeOptions(CODE_DOMAIN.LANG)
  const updateJob = useUpdateJob()
  const updatePo = useUpdatePurchaseOrder()
  const writeCell = useWriteWorkspaceCell()

  /** 열려 있는 드롭다운. ReactGrid 의 드롭다운 칸은 열림 상태를 **쓰는 쪽이** 들고 있어야 한다. */
  const [openDropdown, setOpenDropdown] = useState<string | null>(null)

  /**
   * 끌어서 바꾼 순서와 너비. **서버보다 앞서 있는 화면의 상태다.**
   *
   * 저장이 끝나기를 기다렸다 그리면 끌어 놓은 열이 제자리로 한 번 튕겼다가 옮겨간다. 그 한 번의
   * 튕김은 "안 됐나" 로 읽히고, 사람은 같은 열을 한 번 더 끈다. 저장이 실패하면 그때 비운다 —
   * 그러면 서버가 말하는 배치가 다시 보인다.
   */
  const [dragged, setDragged] = useState<string[] | null>(null)
  const [widths, setWidths] = useState<Record<string, number>>({})

  /**
   * 아직 서버 값과 다른, 사람이 방금 고친 값. 키는 `행|열`.
   *
   * 렌더 중에 정리한다 — 효과(`useEffect`)로 하면 **이미 옛 값이 그려진 렌더가 한 번 지나간
   * 뒤에** 정리되고, 그 한 프레임이 바로 "저장이 안 됐다" 로 읽히는 프레임이다. 이 화면의
   * `useRowSelection` 쪽 주석과 같은 판단이다.
   */
  const [edits, setEdits] = useState<{ source: readonly WorkspaceRow[]; values: Map<string, string> }>(
    { source: rows, values: new Map() },
  )
  if (edits.source !== rows) {
    const next = new Map(edits.values)
    for (const [key, value] of edits.values) {
      const [poId, columnId] = key.split('|')
      const row = rows.find((r) => r.poId === poId)
      if (!row || serverText(row, columnId ?? '', fieldName) === value) next.delete(key)
    }
    setEdits({ source: rows, values: next })
  }

  const put = (poId: string, columnId: string, value: string) => {
    setEdits((prev) => {
      const values = new Map(prev.values)
      values.set(`${poId}|${columnId}`, value)
      return { source: prev.source, values }
    })
  }

  const revert = (poId: string, columnId: string) => {
    setEdits((prev) => {
      const values = new Map(prev.values)
      values.delete(`${poId}|${columnId}`)
      return { source: prev.source, values }
    })
  }

  const shown = (row: WorkspaceRow, columnId: string): string =>
    edits.values.get(`${row.poId}|${columnId}`) ?? serverText(row, columnId, fieldName)

  /* ---------------------------------------------------------------- */
  /* Saving                                                           */
  /* ---------------------------------------------------------------- */

  const saveJob = async (row: WorkspaceRow, columnId: string, value: string) => {
    const field = columnId === 'jobSlang' ? 'jobSlang' : 'jobElang'
    try {
      await updateJob.mutateAsync({ id: row.jobId, input: { [field]: value || null } })
    } catch (err) {
      revert(row.poId, columnId)
      onError(messageOf(err))
    }
  }

  const savePo = async (row: WorkspaceRow, columnId: string, value: string) => {
    /*
     * 분량과 납품일은 **보낼 수 있는 값인지 여기서 본다.** 서버도 거절하지만, 거절 이유가
     * 'numeric 형식 오류' 로 돌아오면 담당자는 자기가 적은 `1,200 단어` 의 무엇이 문제인지
     * 알 수 없다. 날짜 해석은 이 앱의 `parseDateField` 를 그대로 쓴다 — `2026-02-30` 을
     * 3월 2일로 **고쳐 주지 않는** 쪽이 중요하다.
     */
    let input: Record<string, string | null>
    if (columnId === 'poVolume') {
      const cleaned = value.replace(/,/g, '').trim()
      if (cleaned.length > 0 && !isDecimalString(cleaned)) {
        revert(row.poId, columnId)
        onError(`분량은 숫자로 적어 주세요. ('${value}' 는 숫자가 아닙니다)`)
        return
      }
      input = { poVolume: cleaned.length > 0 ? cleaned : null }
    } else if (columnId === 'poEday') {
      const parsed = parseDateField(value)
      if (!parsed.ok) {
        revert(row.poId, columnId)
        onError(parsed.reason)
        return
      }
      input = { poEday: parsed.value || null }
      // 해석된 형태로 다시 적어 둔다. 적은 글자가 `261111` 이었어도 칸은 저장된 날짜를 보여야 한다.
      put(row.poId, columnId, parsed.value)
    } else {
      input = { poState: value || null }
    }
    try {
      await updatePo.mutateAsync({ id: row.poId, input })
    } catch (err) {
      revert(row.poId, columnId)
      onError(messageOf(err))
    }
  }

  const saveCustom = async (row: WorkspaceRow, columnId: string, columnDbId: string, value: string) => {
    try {
      await writeCell.mutateAsync({ columnId: columnDbId, poId: row.poId, value })
    } catch (err) {
      revert(row.poId, columnId)
      onError(messageOf(err))
    }
  }

  const onCellsChanged = (changes: CellChange<GridCell>[]) => {
    for (const change of changes) {
      const row = rows.find((r) => r.poId === String(change.rowId))
      if (!row) continue
      const columnId = String(change.columnId)

      /*
       * 드롭다운 한 번의 변경에 **두 가지가 같이 들어 있다** — 열림/닫힘과 고른 값.
       *
       * 항목을 고르는 순간 ReactGrid 는 `selectedValue` 와 `isOpen`(true → false)을 **함께**
       * 바꾼 칸을 보낸다. 그래서 둘을 양자택일로 읽으면 안 된다. 처음에 그렇게 썼고(열림이
       * 바뀌었으면 거기서 끝), 그 결과는 **고른 값이 조용히 버려지는 것**이었다 — 드롭다운은
       * 닫히고 칸은 옛 값으로 남으므로, 쓰는 사람에게는 "언어를 고를 수 없다" 로 보인다.
       * 단위 테스트로는 보이지 않고 브라우저에서 한 번 골라 보면 즉시 보이는 종류의 결함이다.
       */
      if (change.newCell.type === 'dropdown') {
        const next = change.newCell as DropdownCell
        const prev = change.previousCell as DropdownCell
        if (next.isOpen !== prev.isOpen) {
          setOpenDropdown(next.isOpen ? `${row.poId}|${columnId}` : null)
        }
        const value = next.selectedValue ?? ''
        if (value === (prev.selectedValue ?? '')) continue
        put(row.poId, columnId, value)
        if (columnId === 'poState') void savePo(row, columnId, value)
        else void saveJob(row, columnId, value)
        continue
      }

      if (change.newCell.type !== 'text') continue
      const value = (change.newCell as TextCell).text
      if (value === (change.previousCell as TextCell).text) continue

      const custom = customColumnKey(columnId)
      put(row.poId, columnId, value)
      if (custom) void saveCustom(row, columnId, custom, value)
      else void savePo(row, columnId, value)
    }
  }

  /* ---------------------------------------------------------------- */
  /* Dragging                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 너비를 바꿨다. ReactGrid 는 **끌기가 끝났을 때** 한 번만 부른다.
   *
   * 끄는 동안 부르지 않으므로 저장 요청도 한 번이다. 만약 매 픽셀마다 불린다면 여기서 모아
   * 보내야 했을 것이다.
   */
  const onColumnResized = (columnId: Id, width: number) => {
    const next = { ...widths, [String(columnId)]: Math.round(width) }
    setWidths(next)
    persistLayout(sheetColumns, next, dragged)
  }

  /**
   * 열을 끌어 옮겼다.
   *
   * ReactGrid 는 **옮겨진 열들**과 **어느 열 위에 놓았는지**를 준다. 새 순서는 여기서 만든다 —
   * 옮긴 열들을 먼저 빼고, 목표 열의 자리에 다시 끼워 넣는다. `dropPosition` 이 'before' 인지
   * 'on'/'after' 인지로 그 자리가 한 칸 달라진다.
   */
  const onColumnsReordered = (targetColumnId: Id, columnIds: Id[], dropPosition: string) => {
    const moving = columnIds.map(String)
    const rest = sheetColumns.map((c) => c.columnId).filter((id) => !moving.includes(id))
    const target = rest.indexOf(String(targetColumnId))
    // 목표 열까지 함께 옮겨진 경우(있을 수 없지만) 뒤에 붙인다.
    const at = target < 0 ? rest.length : dropPosition === 'before' ? target : target + 1
    const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)]
    setDragged(order)
    const byId = new Map(sheetColumns.map((c) => [c.columnId, c]))
    const next = order.map((id) => byId.get(id)).filter((c): c is SheetColumn => !!c)
    persistLayout(next, widths, order)
  }

  /**
   * 고른 범위를 화면에 올려 보낸다. 도구막대가 이것을 보고 어디에 칠할지 정한다.
   *
   * **열 전체인지 행 전체인지는 범위의 모양으로 판단한다.** ReactGrid 는 선택 '방식' 을 알려
   * 주지 않지만, 머리글을 눌러 고른 열은 모든 행을 포함하고 행 머리를 눌러 고른 행은 모든 열을
   * 포함한다. 그래서 그 둘을 세어 보면 사람이 무엇을 골랐는지 알 수 있고, 그 판단은 도구막대가
   * "열 2개" 라고 적어 사람에게 되돌려 보여 준다 — 틀렸으면 칠하기 전에 보인다.
   */
  const onSelectionChanged = (ranges: Range[]) => {
    const cells: { key?: string; id?: string; poId: string }[] = []
    const columns: { key?: string; id?: string }[] = []
    const selectedRows = new Set<string>()
    const byId = new Map(sheetColumns.map((c) => [c.columnId, c]))

    for (const range of ranges) {
      const poIds = range.rows.map((r) => String(r.rowId)).filter((id) => id !== 'header')
      const cols = range.columns
        .map((c) => byId.get(String(c.columnId)))
        .filter((c): c is SheetColumn => !!c)
      if (poIds.length === 0 || cols.length === 0) continue

      const wholeColumns = poIds.length === rows.length
      const wholeRows = cols.length === sheetColumns.length

      if (wholeColumns && !wholeRows) {
        for (const column of cols) columns.push(refOf(column))
        continue
      }
      if (wholeRows) {
        for (const poId of poIds) selectedRows.add(poId)
        continue
      }
      for (const column of cols) {
        for (const poId of poIds) cells.push({ ...refOf(column), poId })
      }
    }
    onSelectionChange({ cells, columns, rows: [...selectedRows] })
  }

  /* ---------------------------------------------------------------- */
  /* Building the grid                                                */
  /* ---------------------------------------------------------------- */

  /**
   * 코드가 가진 열 + 이 사람의 설정. 순서도 너비도 꾸밈도 여기서 합쳐진다.
   *
   * 끌어 놓은 직후에는 **화면이 들고 있는 순서**가 서버보다 앞선다(`dragged`). 서버 응답을
   * 기다렸다 그리면 끌어 놓은 열이 원래 자리로 한 번 튕겼다가 옮겨가고, 그 한 번의 튕김이
   * "안 됐나?" 로 읽혀 사람을 한 번 더 끌게 만든다.
   *
   * `useMemo` 를 쓰지 않는다. 이 앱은 React Compiler 를 쓰므로 기억은 컴파일러가 하고, 손으로
   * 감싸면 컴파일러가 그 기억을 **보존할 수 없다고 판단해 경고**한다(오류가 아니라 경고이므로
   * 조용히 두 벌이 된다). 기억이 의미상 필요한 자리도 아니다 — 여기서 나온 배열의 동일성에
   * 기대는 코드가 없다.
   */
  const sheetColumns: SheetColumn[] = ((): SheetColumn[] => {
    const merged = mergeColumns(columns)
    const placed = dragged
      ? (() => {
          const byId = new Map(merged.map((column) => [column.columnId, column]))
          const ordered = dragged
            .map((id) => byId.get(id))
            .filter((c): c is SheetColumn => !!c)
          // 서버에만 있는 열(다른 탭에서 추가한 열)이 사라지지 않게 뒤에 붙인다.
          for (const column of merged) {
            if (!dragged.includes(column.columnId)) ordered.push(column)
          }
          return ordered
        })()
      : merged
    return placed.map((column) => ({ ...column, width: widths[column.columnId] ?? column.width }))
  })()

  /**
   * 배치를 통째로 저장한다. 끌기와 너비 조정이 같은 요청인 이유는 `setWorkspaceLayout` 주석에.
   *
   * 방금 바꾼 값을 인자로 받는다 — 상태로 읽으면 같은 렌더의 옛 값을 보내게 되고, 너비를 바꾼
   * 직후의 저장이 바꾸기 전 너비를 적어 보낸다.
   */
  const persistLayout = (
    next: SheetColumn[],
    nextWidths: Record<string, number>,
    nextOrder: string[] | null,
  ) => {
    setLayout
      .mutateAsync(
        next.map((column, index) => ({
          ...(column.key ? { key: column.key } : { id: column.customId ?? undefined }),
          ordNo: index,
          width: Math.round(nextWidths[column.columnId] ?? column.width),
        })),
      )
      .catch((err: unknown) => {
        /*
         * 되돌린다. 저장되지 않은 배치를 그대로 두면 새로 고쳤을 때 열이 제자리로 돌아가고,
         * 그 사이에 사람은 이미 그 순서를 기준으로 일하고 있다.
         */
        if (nextOrder) setDragged(null)
        setWidths({})
        onError(messageOf(err))
      })
  }

  const gridColumns: Column[] = useMemo(
    () =>
      sheetColumns.map((column) => ({
        columnId: column.columnId,
        width: column.width,
        resizable: true,
        // 기본 열도 옮길 수 있다. 지울 수 없는 것과 움직일 수 없는 것은 다른 이야기다.
        reorderable: true,
      })),
    [sheetColumns],
  )

  const headerRow: Row<GridCell> = useMemo(
    () => ({
      rowId: 'header',
      cells: sheetColumns.map((column): SortHeaderCell => {
        const key = column.key ? SORTABLE[column.key] : undefined
        return {
          type: 'sortHeader',
          text: column.label,
          sortable: !!key,
          direction: key && key === sort ? dir : null,
          onSort: key ? () => onSort(key) : undefined,
          // 열에 건 꾸밈은 머리글에도 보인다 — 그러지 않으면 어느 열이 칠해져 있는지 알 수 없다.
          style: toCellStyle(column.style),
        }
      }),
    }),
    [sheetColumns, sort, dir, onSort],
  )

  const dataRows: Row<GridCell>[] = rows.map((row) => {
    /*
     * 두 가지 구분을 따로 본다. 작업의 구분은 출발어·도착어를 열고(그 둘은
     * `job_detail_linguistic` 의 컬럼이다), PO 의 구분은 분량을 연다
     * (`po_detail_linguistic`). 둘은 **일부러 독립**이다 — MICE 행사에 통역 PO 가 달린다.
     *
     * 하나로 묶으면 비언어 PO 의 분량 칸이 숫자를 받고, 서버는 쓸 컬럼이 없어 아무것도
     * 저장하지 않고, 다음 조회에서 칸이 빈 값으로 되돌아간다. 오류가 나지 않으므로
     * 적은 사람은 자기가 잘못 적었다고 생각한다.
     */
    const jobLinguistic = isLinguistic(row.jobType)
    const poLinguistic = isLinguistic(row.poType)
    const translatorChangeable = mayEditPo && mayChangeTranslator(row)

    const cells: GridCell[] = sheetColumns.map((column): GridCell => {
      const resolved = resolveStyle(
        row.cellStyles[columnStyleKey(column)],
        row.rowStyle,
        column.style,
      )
      const style = toCellStyle(resolved)
      const className = toCellClass(resolved)

      // 추가 열. 값은 언제나 글자이고, 고칠 수 있는지는 권한과 무관하다 — 내 메모다.
      if (!column.spec) {
        return { type: 'text', text: shown(row, column.columnId), style, className }
      }

      const spec = column.spec
      const text = shown(row, spec.key)

      if (spec.source === 'readonly') {
        return {
          type: 'text',
          text,
          nonEditable: true,
          style: { ...READONLY_STYLE, ...style },
          className,
        }
      }

      if (spec.key === 'translator') {
        return {
          type: 'picker',
          text,
          nonEditable: true,
          onOpen: translatorChangeable ? () => onChangeTranslator(row) : undefined,
          lockReason: mayEditPo ? translatorLockReason(row) : 'PO 수정 권한이 없습니다.',
          style: translatorChangeable ? style : { ...READONLY_STYLE, ...style },
          className,
        } satisfies PickerCell
      }

      const editable = spec.source === 'job' ? mayEditJob : mayEditPo

      if (spec.kind === 'dropdown') {
        /*
         * 언어 칸은 **언어 작업에서만** 열린다. MICE·IMC 작업에는 언어쌍 자체가 없고
         * (`job_detail_linguistic` 행이 없다) 거기에 출발어를 쓰면 서버가 제약으로 거절한다.
         */
        const open = spec.source === 'job' ? editable && jobLinguistic : editable
        if (!open) {
          return {
            type: 'text',
            text,
            nonEditable: true,
            style: { ...READONLY_STYLE, ...style },
            className,
          }
        }
        const values =
          spec.key === 'poState'
            ? PO_STATES.map((o) => ({ label: o.label, value: o.value }))
            : langs.options.map((o) => ({ label: o.label, value: o.value }))
        return {
          type: 'dropdown',
          selectedValue: text || undefined,
          values,
          isOpen: openDropdown === `${row.poId}|${spec.key}`,
          style,
          className,
        }
      }

      // 분량·납품일. 글자로 적는다 — 날짜 칸이 글자인 이유는 `DateField` 머리말에 있다.
      // 분량만 PO 의 업무 구분을 함께 본다(위 주석).
      const open = spec.key === 'poVolume' ? editable && poLinguistic : editable
      return {
        type: 'text',
        text: spec.key === 'poEday' ? formatDateField(text) : text,
        nonEditable: !open,
        style: open ? style : { ...READONLY_STYLE, ...style },
        className,
      }
    })

    return { rowId: row.poId, cells }
  })

  return (
    <div className={grid.wrap}>
      <ReactGrid
        rows={[headerRow, ...dataRows]}
        columns={gridColumns}
        customCellTemplates={{
          picker: new PickerCellTemplate(),
          sortHeader: new SortHeaderCellTemplate(),
        }}
        onCellsChanged={onCellsChanged as (changes: CellChange[]) => void}
        onColumnResized={onColumnResized}
        onColumnsReordered={onColumnsReordered}
        onSelectionChanged={onSelectionChanged}
        stickyTopRows={1}
        /*
         * 왼쪽 고정을 **끈다.** 열을 옮길 수 있게 된 순간 고정 칸수는 "맨 왼쪽 네 칸" 이라는
         * 뜻이 되고, 그 네 칸은 사람이 옮겨 놓은 아무 열이나가 된다 — 코드 칸을 붙박아 두려던
         * 원래 의도와 정반대다. 고정이 다시 필요하면 '어느 열을 고정할지' 를 저장해야 한다.
         */
        enableRangeSelection
        enableColumnSelection
        enableRowSelection
        enableColumnResizeOnAllHeaders
        // 엔터로 아래가 아니라 **오른쪽**으로. 시트에 적는 사람은 한 행을 가로로 채운다.
        moveRightOnEnter
      />
    </div>
  )
}

/** 서버가 말하는 값. 추가 열은 `cells`, 기본 열은 `defaultCellText`. */
function serverText(
  row: WorkspaceRow,
  columnId: string,
  codeName: (code: string | null | undefined) => string,
): string {
  const custom = customColumnKey(columnId)
  if (custom) return row.cells[custom] ?? ''
  return defaultCellText(row, columnId, codeName)
}

/** 오류 메시지. 서버가 보낸 말이 있으면 그것을 쓴다 — 번역하지 않는다. */
function messageOf(err: unknown): string {
  if (err instanceof Error && err.message.trim().length > 0) return err.message
  return '저장하지 못했습니다.'
}

/**
 * 색만 ReactGrid 의 칸 스타일로 간다.
 *
 * `CellStyle` 이 받는 것은 `color`·`background`·`overflow`·`paddingLeft`·테두리뿐이다 —
 * **글꼴 굵기와 크기는 없다.** 그래서 그 둘은 아래 `toCellClass` 가 클래스로 건다. 타입이
 * 막아 주지 않았다면 `fontWeight` 를 넣고 아무 일도 일어나지 않는 것을 화면에서 발견했을 것이다.
 */
function toCellStyle(style: WorkspaceStyle): CellStyle {
  const out: { background?: string; color?: string } = {}
  if (style.bgColor) out.background = style.bgColor
  if (style.textColor) out.color = style.textColor
  return out
}

/**
 * 굵기와 크기를 담은 클래스 이름.
 *
 * 크기는 **미리 만들어 둔 클래스**를 고른다(8~24px, 17개). 숫자를 CSS 로 흘려 넣는 방법도
 * 있지만, 만들어 둔 클래스는 주입할 것이 없고 빌드 시점에 전부 보인다. 범위를 벗어난 값은
 * 클래스가 없어 무시되므로, 서버의 CHECK 가 뚫리더라도 화면은 평소 크기로 그린다.
 */
function toCellClass(style: WorkspaceStyle): string | undefined {
  const classes: string[] = []
  if (style.bold === true) classes.push(grid.bold)
  if (style.bold === false) classes.push(grid.notBold)
  if (style.italic === true) classes.push(grid.italic)
  /*
   * 밑줄과 취소선은 **함께 걸릴 수 있다.** `text-decoration` 은 한 속성이므로 클래스를 둘 다
   * 걸면 나중 것이 이기고 하나가 조용히 사라진다 — 그래서 '둘 다' 를 위한 클래스를 따로 둔다.
   */
  if (style.underline === true && style.strike === true) classes.push(grid.underStrike)
  else if (style.underline === true) classes.push(grid.underline)
  else if (style.strike === true) classes.push(grid.strike)
  if (style.textAlign) {
    const aligned = grid[`align${style.textAlign[0]?.toUpperCase() ?? ''}${style.textAlign.slice(1)}`]
    if (aligned) classes.push(aligned)
  }
  if (style.textSize) {
    const named = grid[`sz${String(style.textSize)}`]
    if (named) classes.push(named)
  }
  return classes.length > 0 ? classes.join(' ') : undefined
}

/**
 * 정렬할 수 있는 열과, 그 열이 서버에게 말하는 정렬 키.
 *
 * 열 넷뿐이다. 서버가 그 네 컬럼으로만 정렬할 수 있기 때문이고(`WORKSPACE_SORTS`), 그 제약은
 * 임의가 아니다 — 커서 정렬은 **실제 컬럼**을 가리켜야 한다. 인계일처럼 LATERAL 에서 나오는
 * 값으로 정렬하면 커서가 조용히 멈춰 같은 페이지를 영원히 돌려준다(`sortAlias` 주석).
 */
const SORTABLE: Record<string, string> = {
  prjCode: 'project',
  jobCode: 'job',
  poCode: 'code',
  poEday: 'due',
}

/** 꾸밈 맵의 키 — 서버의 열 행 id. 그 행이 없으면 이 열에는 칸 꾸밈도 있을 수 없다. */
function columnStyleKey(column: SheetColumn): string {
  return column.styleId ?? ''
}

/** 한 열을 꾸밈 요청이 받는 참조로. 고정 열은 키, 추가 열은 id — 둘 중 하나만. */
function refOf(column: SheetColumn): { key?: string; id?: string } {
  return column.key ? { key: column.key } : { id: column.customId ?? undefined }
}
