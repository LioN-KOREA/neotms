import { useState } from 'react'
import { useUpdateJob } from '@/apis/queries/neotms.mutation'
import { ASSIGNABLE_ATTRIBUTES, type JobRow } from '@/apis/neotms.types'
import { ErrorNotice, InfoNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import type { PickerOption } from '@/shared/ui/RecordPicker'
import ui from '@/shared/ui/ui.module.css'
import { StaffPicker } from '@/features/staff/StaffPicker'

/** Index 1 of the shared list is the PM attribute. See `ASSIGNABLE_ATTRIBUTES`. */
const PM_ATTRIBUTE = ASSIGNABLE_ATTRIBUTES[1]

/**
 * The 담당 PM cell of a job table.
 *
 * A component rather than a string-returning helper, because the three cases are drawn differently
 * and because TWO tables show this cell - 작업 목록 and 프로젝트 상세. A pair of ternaries living in
 * both views is what `jobTypeSummary` next door exists to prevent: such pairs get fixed on one side.
 *
 * The cases are three, not two. A job with no PM at all is a gap worth seeing - nothing is broken,
 * but nobody is answerable for the work, and for a colleague whose view is scoped that job is
 * reachable only through the project PM or 영업담당. A job that HAS a PM whose name is missing is a
 * different thing: a row loaded without one. Painting that as 미지정 would send somebody looking
 * for an assignment that has already been made.
 */
export function JobPmName({ job }: { job: Pick<JobRow, 'jobPmId' | 'jobPmName'> }) {
  if (job.jobPmName) return <>{job.jobPmName}</>
  if (job.jobPmId) return <span className={ui.hint}>(이름 없음)</span>
  return <span className={`${ui.badge} ${ui.badgeWarn}`}>미지정</span>
}

interface Props {
  job: JobRow
  onClose: () => void
  onSaved: (message: string) => void
}

/**
 * Hand one job to a different PM.
 *
 * ## Why not the edit form
 *
 * The same argument as `TranslatorSwapModal`. Reassigning work is a frequent single edit - somebody
 * is on leave, one project is split between two PMs, a job was created by whoever happened to be at
 * the keyboard - and `JobFormModal` opens more than twenty fields to do it, among them the exchange
 * rate and the two totals. Opening a money form to change a name is how money gets changed by
 * accident.
 *
 * What goes out is `{ jobPmId }` and nothing else. The server maintains `job_pm_name` itself, from
 * the id it was given rather than from the body (`JOB_DERIVED`), which is exactly why the name in
 * the list can be read as fact.
 *
 * ## Nothing has to be locked here, unlike the translator
 *
 * The translator of a PO is frozen once that PO is approved or paid, because an approval record and
 * a payment record are statements about one particular person. No such record hangs off the PM of a
 * job: it says who is answerable for the work right now, and the normal case is that it changes
 * while the work is in flight. So there is no state in which this dialog refuses.
 *
 * ## It does move the job out of somebody else's screens, and that is worth saying
 *
 * `job_pm_id` is one of the three row-level scope columns of a job, and one of the four of a PO. For
 * a colleague who does not see every row, reassignment therefore takes this job AND its POs off
 * their lists - including the lists of the person doing the reassigning, when they are handing over
 * their own job. That is what an assignment means, so it is not a reason to prevent it. It is a
 * reason not to let it be discovered afterwards.
 */
export function JobPmSwapModal({ job, onClose, onSaved }: Props) {
  const updateJob = useUpdateJob()
  const [picked, setPicked] = useState<PickerOption | null>(null)
  /** Whether 지정 해제 was pressed. Has to be distinct from `picked === null` - see `canSave`. */
  const [clearing, setClearing] = useState(false)

  const current = job.jobPmName || (job.jobPmId ? job.jobPmId : null)

  /*
   * Two ways to be saveable: somebody was PICKED and differs from the present PM, or 지정 해제 was
   * pressed. Kept apart because `null` cannot mean both "nothing chosen yet" and "clear it" - were
   * they one state, the save button would be live the moment the dialog opened, and that one click
   * would unassign a job nobody meant to touch.
   */
  const nextId = clearing ? null : (picked?.id ?? null)
  const changed = nextId !== (job.jobPmId ?? null)
  const canSave = (clearing || picked !== null) && changed && !updateJob.isPending

  const onSubmit = async () => {
    if (!canSave) return
    await updateJob.mutateAsync({ id: job.id, input: { jobPmId: nextId } })
    onSaved(
      nextId === null
        ? `작업 [${job.jobCode}] 의 담당 PM 지정을 해제했습니다.`
        : `작업 [${job.jobCode}] 의 담당 PM 을 ${picked?.title ?? ''} 님으로 바꿨습니다.`,
    )
    onClose()
  }

  return (
    <Modal
      title="담당 PM 변경"
      onClose={onClose}
      /* One question on a background click: the person was found by searching, which is costly to redo. */
      isDirty={canSave}
      width={520}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose} disabled={updateJob.isPending}>
            취소
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void onSubmit()}
            disabled={!canSave}
          >
            {updateJob.isPending ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      <ErrorNotice error={updateJob.error} />

      <p className={ui.hint}>
        작업 <strong>{job.jobCode}</strong> — 담당 PM 만 바뀝니다. 금액·물량·마감일·상태는 그대로
        입니다.
      </p>

      <div className={ui.field}>
        <span className={ui.label}>현재 담당 PM</span>
        <div className={ui.pickerSelected}>
          <span className={ui.pickerSelectedText}>
            <span className={ui.pickerItemTitle}>{current ?? '미지정'}</span>
            <span className={ui.pickerItemSub}>{job.jobName || job.jobCode}</span>
          </span>
          {/*
           * 지정 해제. A job with no PM is a real state - legacy rows have it, and a job between
           * two people has it for a day. With no way back, a job assigned to the wrong person
           * could only be corrected by assigning it to another wrong person.
           */}
          {job.jobPmId && !clearing ? (
            <button
              type="button"
              className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
              onClick={() => {
                setPicked(null)
                setClearing(true)
              }}
              disabled={updateJob.isPending}
            >
              지정 해제
            </button>
          ) : null}
        </div>
      </div>

      {clearing ? (
        <InfoNotice>
          담당 PM 지정을 <strong>해제</strong>합니다. 저장하면 이 작업을 맡은 PM 이 없어지고,
          프로젝트의 PM·영업담당만 이 작업을 볼 수 있게 됩니다.{' '}
          <button type="button" className={ui.btnLink} onClick={() => setClearing(false)}>
            되돌리기
          </button>
        </InfoNotice>
      ) : (
        <div className={ui.field}>
          <StaffPicker
            attribute={PM_ATTRIBUTE}
            id="job-pm-swap"
            label="새 담당 PM"
            value={picked}
            onChange={setPicked}
            disabled={updateJob.isPending}
          />
        </div>
      )}

      {/* The scope consequence, in the one place where it is about to happen. See the header. */}
      {picked ? (
        <InfoNotice>
          저장하면 이 작업과 딸린 PO 가 <strong>{picked.title}</strong> 님의 목록으로 옮겨갑니다.
          이전 담당 PM 은 프로젝트의 PM·영업담당이 아니라면 이 작업을 더는 볼 수 없습니다.
        </InfoNotice>
      ) : null}
    </Modal>
  )
}
