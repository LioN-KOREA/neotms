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
  type Row,
  type TextCell,
  type Uncertain,
} from '@silevis/reactgrid'
import '@silevis/reactgrid/styles.css'
import { useCodeNames, useCodeOptions } from '@/apis/queries/neotms.query'
import {
  useUpdateJob,
  useUpdatePurchaseOrder,
  useWriteWorkspaceCell,
} from '@/apis/queries/neotms.mutation'
import { CODE_DOMAIN, isLinguistic, PO_STATES } from '@/apis/neotms.codes'
import type { WorkspaceColumnDef, WorkspaceRow } from '@/apis/neotms.types'
import { formatDateField, parseDateField } from '@/shared/utils/format'
import { isDecimalString } from '@/shared/utils/money'
import { mayChangeTranslator, translatorLockReason } from '@/features/purchaseorders/TranslatorSwapModal'
import {
  customColumnId,
  customColumnKey,
  defaultCellText,
  DEFAULT_COLUMNS,
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

type GridCell = DefaultCellTypes | PickerCell

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
}: Props) {
  /* 프로젝트종류 = `project.prj_field`, and that column reads the PRJCAT list. */
  const fieldName = useCodeNames(CODE_DOMAIN.PRJCAT)
  const langs = useCodeOptions(CODE_DOMAIN.LANG)
  const updateJob = useUpdateJob()
  const updatePo = useUpdatePurchaseOrder()
  const writeCell = useWriteWorkspaceCell()

  /** 열려 있는 드롭다운. ReactGrid 의 드롭다운 칸은 열림 상태를 **쓰는 쪽이** 들고 있어야 한다. */
  const [openDropdown, setOpenDropdown] = useState<string | null>(null)

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
  /* Building the grid                                                */
  /* ---------------------------------------------------------------- */

  const gridColumns: Column[] = useMemo(
    () => [
      ...DEFAULT_COLUMNS.map((spec) => ({
        columnId: spec.key,
        width: spec.width,
        resizable: true,
        // 기본 열은 자리를 바꿀 수 없다 — 요구사항이고, 순서가 `DEFAULT_COLUMNS` 의 것이다.
        reorderable: false,
      })),
      ...columns.map((column) => ({
        columnId: customColumnId(column.id),
        width: 150,
        resizable: true,
        /*
         * 끌어서 옮기지 않는다. ReactGrid 의 열 끌기는 **그 화면에서만** 순서를 바꾸고, 이
         * 기능의 요구는 순서가 사람마다 저장되는 것이다. 저장되지 않는 끌기를 열어 두면 새로
         * 고쳤을 때 순서가 되돌아가고, 그건 고장으로 읽힌다. 순서는 '열 관리' 에서 바꾸고
         * 서버에 남는다.
         */
        reorderable: false,
      })),
    ],
    [columns],
  )

  const headerRow: Row<GridCell> = useMemo(
    () => ({
      rowId: 'header',
      cells: [
        ...DEFAULT_COLUMNS.map((spec) => ({
          type: 'header' as const,
          text: spec.label,
        })),
        ...columns.map((column) => ({ type: 'header' as const, text: column.label })),
      ],
    }),
    [columns],
  )

  const dataRows: Row<GridCell>[] = rows.map((row) => {
    const linguistic = isLinguistic(row.jobType)
    const translatorChangeable = mayEditPo && mayChangeTranslator(row)

    const cells: GridCell[] = DEFAULT_COLUMNS.map((spec): GridCell => {
      const text = shown(row, spec.key)

      if (spec.source === 'readonly') {
        return { type: 'text', text, nonEditable: true, style: READONLY_STYLE }
      }

      if (spec.key === 'translator') {
        return {
          type: 'picker',
          text,
          nonEditable: true,
          onOpen: translatorChangeable ? () => onChangeTranslator(row) : undefined,
          lockReason: mayEditPo ? translatorLockReason(row) : 'PO 수정 권한이 없습니다.',
          style: translatorChangeable ? undefined : READONLY_STYLE,
        } satisfies PickerCell
      }

      const editable = spec.source === 'job' ? mayEditJob : mayEditPo

      if (spec.kind === 'dropdown') {
        /*
         * 언어 칸은 **언어 작업에서만** 열린다. MICE·IMC 작업에는 언어쌍 자체가 없고
         * (`job_detail_linguistic` 행이 없다) 거기에 출발어를 쓰면 서버가 제약으로 거절한다.
         */
        const open = spec.source === 'job' ? editable && linguistic : editable
        if (!open) {
          return { type: 'text', text, nonEditable: true, style: READONLY_STYLE }
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
        }
      }

      // 분량·납품일. 글자로 적는다 — 날짜 칸이 글자인 이유는 `DateField` 머리말에 있다.
      return {
        type: 'text',
        text: spec.key === 'poEday' ? formatDateField(text) : text,
        nonEditable: !editable,
        style: editable ? undefined : READONLY_STYLE,
      }
    })

    for (const column of columns) {
      cells.push({ type: 'text', text: shown(row, customColumnId(column.id)) })
    }

    return { rowId: row.poId, cells }
  })

  return (
    <div className={grid.wrap}>
      <ReactGrid
        rows={[headerRow, ...dataRows]}
        columns={gridColumns}
        customCellTemplates={{ picker: new PickerCellTemplate() }}
        onCellsChanged={onCellsChanged as (changes: CellChange[]) => void}
        stickyTopRows={1}
        // 코드 세 칸이 왼쪽에 붙어 있어야 오른쪽으로 끌고 갔을 때 어느 행인지 알 수 있다.
        stickyLeftColumns={4}
        enableRangeSelection
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
