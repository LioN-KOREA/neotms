import { useState } from 'react'
import { useSetProjectAcceptance } from '@/apis/queries/neotms.mutation'
/**
 * What this dialog needs about a project, and nothing more.
 *
 * Narrower than `ProjectRow` because it is opened from two places with two different row shapes -
 * the project detail screen, which has the whole row, and the dashboard'''s acceptance panel, which
 * has a deliberately small one. A `ProjectRow` prop would force the panel to carry thirty columns
 * it does not use, or to fabricate them.
 */
interface AnswerableProject {
  id: string
  prjCode: string
  prjName: string | null
  cusCodeName: string | null
}
import { ErrorNotice, InfoNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'

/**
 * The assigned PM answers for one project.
 *
 * ## The decision is fixed before the dialog opens
 *
 * `accepted` comes from WHICH BUTTON was pressed on the screen behind, and this dialog cannot
 * change it. Offering both answers here would mean one mis-click lands the wrong one - and neither
 * answer can be taken back from this screen afterwards, which is the whole reason there is a
 * confirmation step at all.
 *
 * ## Why there is a dialog rather than two buttons that just fire
 *
 * Because of what the two answers do to other people. An acceptance is a commitment to a deadline
 * somebody has already quoted to a customer; a rejection sends the project back with nobody on it,
 * and until a sales manager notices and reassigns it, nothing happens to it at all. Neither belongs
 * behind a single click next to an edit button.
 *
 * The note is the other reason. A rejection with no reason tells the sales manager only that the
 * work came back, and the next step is a telephone call - so the box is here, optional on both
 * answers and prompted harder on the one that needs it.
 */
interface Props {
  project: AnswerableProject
  /** true accepts, false rejects. Decided by the button that opened this. */
  accepted: boolean
  onClose: () => void
  onDone: (message: string) => void
}

export function ProjectAcceptanceModal({ project, accepted, onClose, onDone }: Props) {
  const answer = useSetProjectAcceptance()
  const [note, setNote] = useState('')

  const submit = async () => {
    if (answer.isPending) return
    await answer.mutateAsync({
      id: project.id,
      input: { accepted, note: note.trim() || null },
    })
    onDone(
      accepted
        ? `'${project.prjName || project.prjCode}' 프로젝트를 수락했습니다.`
        : `'${project.prjName || project.prjCode}' 프로젝트를 거절했습니다. 영업담당자가 다른 PM 을 배정할 수 있습니다.`,
    )
    onClose()
  }

  return (
    <Modal
      title={accepted ? '프로젝트 수락' : '프로젝트 거절'}
      onClose={onClose}
      isDirty={!answer.isPending && note.trim().length > 0}
      width={520}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose} disabled={answer.isPending}>
            취소
          </button>
          <button
            type="button"
            className={`${ui.btn} ${accepted ? ui.btnPrimary : ui.btnDanger}`}
            onClick={() => void submit()}
            disabled={answer.isPending}
          >
            {answer.isPending ? '처리 중…' : accepted ? '수락' : '거절'}
          </button>
        </>
      }
    >
      <ErrorNotice error={answer.error} />

      <InfoNotice>
        {accepted
          ? '수락하면 이 프로젝트의 담당 PM 으로 확정됩니다. 수락은 이 화면에서 되돌릴 수 없고, 맡을 수 없게 되면 영업담당자에게 PM 재배정을 요청해야 합니다.'
          : '거절하면 이 프로젝트는 담당자가 정해지지 않은 상태로 영업담당자에게 돌아갑니다. 거절도 되돌릴 수 없으며, 다시 맡으려면 PM 재배정을 받아야 합니다.'}
      </InfoNotice>

      <div className={ui.formGrid}>
        <div className={ui.fieldWide}>
          <span className={ui.label}>프로젝트</span>
          <p className={ui.detailValue}>
            {project.prjName || '(이름 없음)'} <span className={ui.cellMono}>{project.prjCode}</span>
          </p>
          {project.cusCodeName ? <span className={ui.hint}>{project.cusCodeName}</span> : null}
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="pa-note">
            {accepted ? '메모' : '거절 사유'}
          </label>
          <textarea
            id="pa-note"
            className={ui.input}
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            disabled={answer.isPending}
            autoFocus={!accepted}
          />
          <span className={ui.hint}>
            {accepted
              ? '비워 두셔도 됩니다. 적으시면 프로젝트 상세의 수락 이력에 함께 남습니다.'
              : '비워 두셔도 되지만, 적어 주시면 영업담당자가 다음 PM 을 정할 때 같은 이유로 다시 거절되는 일을 줄일 수 있습니다.'}
          </span>
        </div>
      </div>
    </Modal>
  )
}
