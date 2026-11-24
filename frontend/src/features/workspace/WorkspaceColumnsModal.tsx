import { useState } from 'react'
import {
  useCreateWorkspaceColumn,
  useDeleteWorkspaceColumn,
  useRenameWorkspaceColumn,
  useReorderWorkspaceColumns,
} from '@/apis/queries/neotms.mutation'
import type { WorkspaceColumnDef } from '@/apis/neotms.types'
import { ErrorNotice, InfoNotice } from '@/shared/ui/Feedback'
import { Icon } from '@/shared/ui/Icon'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'
import { customColumnsOf, DEFAULT_COLUMNS } from './workspaceColumns'

interface Props {
  columns: readonly WorkspaceColumnDef[]
  onClose: () => void
  onSaved: (message: string) => void
}

/**
 * 추가 열을 만들고, 이름을 고치고, 순서를 바꾸고, 지운다.
 *
 * ## 왜 시트 안에서 하지 않는가
 *
 * 열 관리는 **되돌릴 수 없는 조작을 하나 포함한다** — 열을 지우면 그 열에 적힌 모든 값이 함께
 * 사라진다. 시트의 머리글을 오른쪽 눌러 메뉴를 띄우는 방식이 자연스럽지만, 그 메뉴에는 "이 열에
 * 값이 몇 건 적혀 있습니다" 를 적을 자리가 없고, 지우기는 바로 옆 항목이 '이름 바꾸기' 인 메뉴에서
 * 한 번의 클릭으로 일어난다.
 *
 * 순서도 같은 자리에 있어야 한다. ReactGrid 의 열 끌기는 **그 화면에서만** 순서를 바꾸므로,
 * 사람마다 저장되는 순서를 끌기로 바꾸게 하면 새로 고쳤을 때 되돌아간다.
 *
 * ## 기본 열을 함께 보여 준다
 *
 * 지울 수도 옮길 수도 없는 열이지만 목록에 적는다. 적지 않으면 이 대화상자는 "열 관리" 라는
 * 이름으로 **열의 절반만** 보여 주는 화면이 되고, 처음 여는 사람은 기본 열이 사라진 줄 안다.
 */
export function WorkspaceColumnsModal({ columns: stored, onClose, onSaved }: Props) {
  /*
   * 추가 열만. 서버의 열 목록에는 **기본 열의 설정 행**도 들어 있다 — 사람이 납품일을 끌거나
   * 칠하면 그 열에도 행이 생긴다. 그 행들을 걸러내지 않으면 이 화면이 '납품일' 을 사람이 만든
   * 열처럼 보여 주고, 이름 없는 행으로 그리고, 삭제 버튼까지 달아 준다.
   */
  const columns = customColumnsOf(stored)
  const create = useCreateWorkspaceColumn()
  const rename = useRenameWorkspaceColumn()
  const remove = useDeleteWorkspaceColumn()
  const reorder = useReorderWorkspaceColumns()

  const [label, setLabel] = useState('')
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null)

  const pending =
    create.isPending || rename.isPending || remove.isPending || reorder.isPending
  const error = create.error ?? rename.error ?? remove.error ?? reorder.error

  const onAdd = async () => {
    const trimmed = label.trim()
    if (trimmed.length === 0 || pending) return
    await create.mutateAsync(trimmed)
    setLabel('')
    onSaved(`'${trimmed}' 열을 추가했습니다.`)
  }

  const onRename = async () => {
    if (!editing || pending) return
    const trimmed = editing.label.trim()
    if (trimmed.length === 0) return
    await rename.mutateAsync({ id: editing.id, label: trimmed })
    setEditing(null)
    onSaved(`열 이름을 '${trimmed}' 로 바꿨습니다.`)
  }

  /**
   * 한 칸 옮긴다. **전체 순서를 보낸다** — 일부만 보내면 빠진 열이 낡은 위치에 남는다.
   *
   * 화살표 두 개로 옮기는 것이 끌기보다 나은 자리다. 열이 서른 개까지 늘어날 수 있고, 좁은
   * 대화상자 안에서 끌기는 스크롤과 싸운다.
   */
  const onMove = async (index: number, delta: number) => {
    const next = [...columns]
    const target = index + delta
    if (target < 0 || target >= next.length || pending) return
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(target, 0, moved)
    await reorder.mutateAsync(next.map((column) => column.id))
  }

  const onDelete = async (column: WorkspaceColumnDef) => {
    /*
     * `window.confirm` 이 이 앱의 삭제 확인 방식이다. 문구가 **값이 사라진다**는 말을 반드시
     * 담아야 한다 — 열 하나를 지우는 조작이 실제로 지우는 것은 그 열에 적힌 모든 행의 메모이고,
     * 되돌릴 방법이 없다.
     */
    if (
      !window.confirm(
        `'${column.label}' 열을 삭제할까요?\n` +
          '이 열에 적어 둔 모든 값이 함께 사라지고, 되돌릴 수 없습니다.',
      )
    ) {
      return
    }
    await remove.mutateAsync(column.id)
    onSaved(`'${column.label}' 열을 삭제했습니다.`)
  }

  return (
    <Modal
      title="열 관리"
      onClose={onClose}
      isDirty={label.trim().length > 0 || editing !== null}
      width={560}
      footer={
        <button type="button" className={ui.btn} onClick={onClose} disabled={pending}>
          닫기
        </button>
      }
    >
      <ErrorNotice error={error} />

      <InfoNotice>
        추가한 열은 <strong>나에게만</strong> 보입니다. 값은 PO 한 건에 붙으므로, 그 PO 가
        사라지면 적어 둔 값도 함께 사라집니다.
      </InfoNotice>

      <div className={ui.field}>
        <label className={ui.label} htmlFor="ws-new-column">
          열 추가
        </label>
        <div className={ui.inputRow}>
          <input
            id="ws-new-column"
            className={ui.input}
            value={label}
            maxLength={40}
            placeholder="열 이름 (예: 1차 검수, 비고)"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void onAdd()
              }
            }}
            disabled={pending}
          />
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void onAdd()}
            disabled={pending || label.trim().length === 0}
          >
            <Icon name="plus" size={13} />
            추가
          </button>
        </div>
      </div>

      <div className={`${ui.cardBodyFlush} ${ui.tableWrap}`}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>열</th>
              <th>종류</th>
              <th>순서</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {DEFAULT_COLUMNS.map((spec) => (
              <tr key={spec.key}>
                <td>{spec.label}</td>
                <td className={ui.cellMuted}>
                  {spec.source === 'readonly' ? '기본 · 읽기 전용' : '기본 · 수정 가능'}
                </td>
                <td className={ui.cellMuted}>고정</td>
                <td />
              </tr>
            ))}
            {columns.map((column, index) => (
              <tr key={column.id}>
                <td>
                  {editing?.id === column.id ? (
                    <div className={ui.inputRow}>
                      <input
                        className={ui.input}
                        value={editing.label}
                        maxLength={40}
                        autoFocus
                        onChange={(e) => setEditing({ id: column.id, label: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            void onRename()
                          }
                          if (e.key === 'Escape') setEditing(null)
                        }}
                        disabled={pending}
                      />
                      <button
                        type="button"
                        className={`${ui.btn} ${ui.btnSm} ${ui.btnPrimary}`}
                        onClick={() => void onRename()}
                        disabled={pending || editing.label.trim().length === 0}
                      >
                        확인
                      </button>
                    </div>
                  ) : (
                    column.label
                  )}
                </td>
                <td className={ui.cellMuted}>추가 · 나만 보임</td>
                <td>
                  <div className={ui.rowActions}>
                    <button
                      type="button"
                      className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
                      onClick={() => void onMove(index, -1)}
                      disabled={pending || index === 0}
                      aria-label={`${column.label} 왼쪽으로`}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
                      onClick={() => void onMove(index, 1)}
                      disabled={pending || index === columns.length - 1}
                      aria-label={`${column.label} 오른쪽으로`}
                    >
                      →
                    </button>
                  </div>
                </td>
                <td>
                  <div className={ui.rowActions}>
                    <button
                      type="button"
                      className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
                      onClick={() => setEditing({ id: column.id, label: column.label ?? '' })}
                      disabled={pending}
                    >
                      이름
                    </button>
                    <button
                      type="button"
                      className={`${ui.btn} ${ui.btnDanger} ${ui.btnSm}`}
                      onClick={() => void onDelete(column)}
                      disabled={pending}
                    >
                      삭제
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
