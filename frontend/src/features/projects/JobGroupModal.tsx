/**
 * 작업 그룹 조정 창 (팀장님 2026-11-25).
 *
 * 프로젝트의 작업이 그룹 순으로 나온다. 하나 또는 여러 개를 골라 [확인] 을 누르면 고른 작업들이 새 그룹
 * 코드 하나를 받는다 — 창은 그대로라 계속 조정할 수 있다. [확인·창닫기] 는 같은 일을 하고 닫는다.
 */
import { useMemo, useState } from 'react'
import type { JobRow } from '@/apis/neotms.types'
import { groupNumber, useApplyJobGroup } from '@/apis/jobGroup.api'
import { useCodeNames } from '@/apis/queries/neotms.query'
import { CODE_DOMAIN } from '@/apis/neotms.codes'
import { ErrorNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'

export function JobGroupModal(props: {
  projectId: string
  jobs: readonly JobRow[]
  onClose: () => void
  onNotice: (message: string) => void
}) {
  const apply = useApplyJobGroup()
  const workName = useCodeNames(CODE_DOMAIN.WORK)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [last, setLast] = useState<string | null>(null)
  const rows = useMemo(
    () => [...props.jobs].sort((a, b) => groupNumber(a.jobGroup) - groupNumber(b.jobGroup) || Number(a.id) - Number(b.id)),
    [props.jobs],
  )
  const toggle = (id: string) =>
    setPicked((old) => {
      const next = new Set(old)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const run = async (close: boolean) => {
    if (picked.size === 0) return
    const ids = [...picked]
    const res = await apply.mutateAsync({ projectId: props.projectId, mode: 'new', jobIds: ids })
    const message = `작업 ${ids.length}건에 새 작업 그룹 ${res.code} 을(를) 배정했습니다.`
    props.onNotice(message)
    setPicked(new Set())
    setLast(message)
    if (close) props.onClose()
  }

  return (
    <Modal
      title="작업 그룹 조정"
      onClose={props.onClose}
      width={860}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={props.onClose} disabled={apply.isPending}>
            취소
          </button>
          <button type="button" className={ui.btn} onClick={() => void run(true)} disabled={picked.size === 0 || apply.isPending}>
            확인·창닫기
          </button>
          <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => void run(false)} disabled={picked.size === 0 || apply.isPending}>
            {apply.isPending ? '배정 중…' : '확인'}
          </button>
        </>
      }
    >
      <ErrorNotice error={apply.error} />
      <p className={ui.hint}>
        새 그룹으로 묶을 작업을 고르고 [확인] 을 누르세요. 고른 작업들은 새 작업 그룹 코드 하나를 받습니다. 창이 닫히지 않으니 계속 조정할 수 있습니다.
        {last ? <strong style={{ color: '#b06a00', marginLeft: 6 }}>{last}</strong> : null}
      </p>
      <div className={ui.tableWrap} style={{ maxHeight: 460, overflow: 'auto' }}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th className={ui.cellCheck} />
              <th>JOB 그룹</th>
              <th>JOB코드</th>
              <th>작업명</th>
              <th>작업 종류</th>
              <th>언어</th>
              <th>담당PM</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((j) => (
              <tr key={j.id} className={picked.has(j.id) ? ui.rowSelected : ''} onClick={() => toggle(j.id)} style={{ cursor: 'pointer' }}>
                <td className={ui.cellCheck}>
                  <input type="checkbox" aria-label={`${j.jobCode} 선택`} checked={picked.has(j.id)} onChange={() => toggle(j.id)} onClick={(e) => e.stopPropagation()} />
                </td>
                <td className={ui.cellMono}>{j.jobGroup ?? '-'}</td>
                <td className={ui.cellMono}>{j.jobCode}</td>
                <td>{j.jobName ?? '-'}</td>
                <td>{workName(j.workCode) || '-'}</td>
                <td>{[j.jobSlang, j.jobElang].filter(Boolean).join(' → ') || '-'}</td>
                <td>{j.jobPmName ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
