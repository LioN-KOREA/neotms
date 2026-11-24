import { useState } from 'react'
import { useUpdateProject } from '@/apis/queries/neotms.mutation'
import { ASSIGNABLE_ATTRIBUTES } from '@/apis/neotms.types'
import { ErrorNotice, InfoNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import type { PickerOption } from '@/shared/ui/RecordPicker'
import ui from '@/shared/ui/ui.module.css'
import { StaffPicker } from '@/features/staff/StaffPicker'

/** Index 1 of the shared list is the PM attribute. See `ASSIGNABLE_ATTRIBUTES`. */
const PM_ATTRIBUTE = ASSIGNABLE_ATTRIBUTES[1]

/**
 * Hand one project to a different PM.
 *
 * ## Why this exists when the project form can already do it
 *
 * Because of where it is used. The sales manager's dashboard lists the projects of theirs that nobody has
 * taken on, and the thing to do with a rejected one is usually to give it to somebody else. Sending
 * them through the full project form for that means a dialog of twenty fields, every one of which
 * they might change by accident, to alter one.
 *
 * It PATCHes the same endpoint with the same field, so there is no second write path: what differs
 * is how much of the project is on screen while you do it.
 *
 * ## Changing the PM resets the acceptance, and that is the point
 *
 * The new PM has not been asked, so `acceptance_status` goes back to 0 and the project appears in
 * THEIR handover panel. The server does that as part of the edit - this dialog does not send
 * an acceptance field and could not: no project write can set that column.
 */
interface Props {
  project: { id: string; prjCode: string; prjName: string | null; prjPmName: string | null }
  onClose: () => void
  onDone: (message: string) => void
}

export function ProjectPmModal({ project, onClose, onDone }: Props) {
  const updateProject = useUpdateProject()
  const [pm, setPm] = useState<PickerOption | null>(null)

  const submit = async () => {
    if (!pm || updateProject.isPending) return
    await updateProject.mutateAsync({ id: project.id, input: { prjPmId: pm.id } })
    onDone(
      `'${project.prjName || project.prjCode}' 프로젝트를 ${pm.title} 님께 배정했습니다. ` +
        '수락 여부를 기다려 주십시오.',
    )
    onClose()
  }

  return (
    <Modal
      title="PM 재배정"
      onClose={onClose}
      isDirty={!updateProject.isPending && !!pm}
      width={520}
      footer={
        <>
          <button
            type="button"
            className={ui.btn}
            onClick={onClose}
            disabled={updateProject.isPending}
          >
            취소
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void submit()}
            disabled={!pm || updateProject.isPending}
          >
            {updateProject.isPending ? '배정 중…' : '배정'}
          </button>
        </>
      }
    >
      <ErrorNotice error={updateProject.error} />

      <InfoNotice>
        배정하면 이 프로젝트는 새 PM 의 '인계받은 프로젝트 목록' 에 올라가고, 수락 여부를 다시
        기다리게 됩니다. 이전 PM 이 남긴 답변과 사유는 프로젝트 상세의 수락 이력에 그대로
        남습니다.
      </InfoNotice>

      <div className={ui.formGrid}>
        <div className={ui.fieldWide}>
          <span className={ui.label}>프로젝트</span>
          <p className={ui.detailValue}>
            {project.prjName || '(이름 없음)'}{' '}
            <span className={ui.cellMono}>{project.prjCode}</span>
          </p>
          {project.prjPmName ? (
            <span className={ui.hint}>현재 PM: {project.prjPmName}</span>
          ) : (
            <span className={ui.hint}>현재 지정된 PM 이 없습니다.</span>
          )}
        </div>

        <div className={ui.fieldWide}>
          <StaffPicker
            attribute={PM_ATTRIBUTE}
            id="reassign-pm"
            label="새 PM"
            value={pm}
            onChange={setPm}
            required
            disabled={updateProject.isPending}
          />
        </div>
      </div>
    </Modal>
  )
}
