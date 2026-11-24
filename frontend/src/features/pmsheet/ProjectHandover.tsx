/**
 * 프로젝트 화면의 'JOB 인계' — 영업 담당이 작업을 골라 각 작업의 담당 PM 에게 넘긴다.
 *
 * 받는 사람은 작업마다 지정된 담당 PM 이다(작업에 PM 이 없으면 넘길 수 없다).
 * PM 은 "나의 업무 → 인계" 탭에서 받기/수정 요청/거부 중 하나를 고르고, 그 답이 알림으로 돌아온다.
 * 같은 작업을 다시 넘기면 지난 인계와 달라진 칸이 PM 쪽에서 노란색으로 보인다.
 */
import { useState } from 'react'
import { useCreateHandovers, useProjectHandovers, type PmHandover } from '@/apis/pmsheet.api'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'

import { isoToYmd } from './sheetModel'
const STATUS: Record<number, string> = { 0: '대기', 1: '인계 완료', 2: '수정 요청', [-1]: '거부' }
const STATUS_COLOR: Record<number, string> = { 0: '#8a94a3', 1: '#1e8e3e', 2: '#e37400', [-1]: '#d93025' }

export function JobHandoverButton(props: {
  jobs: { id: string; label: string }[]
  onDone: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className={`${ui.btn} ${ui.btnSm}`} onClick={() => setOpen(true)} title="고른 작업을 각 작업의 담당 PM 에게 인계합니다">
        JOB 인계
      </button>
      {open ? <HandoverModal jobs={props.jobs} onClose={() => setOpen(false)} onDone={(m) => { setOpen(false); props.onDone(m) }} /> : null}
    </>
  )
}

function HandoverModal(props: { jobs: { id: string; label: string }[]; onClose: () => void; onDone: (m: string) => void }) {
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const create = useCreateHandovers()
  const send = async () => {
    setError(null)
    try {
      const r = await create.mutateAsync({ jobIds: props.jobs.map((j) => j.id), message: message.trim() || null })
      const skipped = r.skipped.map((s) => `${props.jobs.find((j) => j.id === s.jobId)?.label ?? s.jobId}: ${s.reason}`)
      if (r.created === 0) setError(`인계하지 못했습니다. ${skipped.join(' / ')}`)
      else props.onDone(`작업 ${String(r.created)}건을 인계했습니다.${skipped.length ? ` (제외: ${skipped.join(' / ')})` : ''}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '인계하지 못했습니다.')
    }
  }
  return (
    <Modal
      title={`JOB 인계 — ${String(props.jobs.length)}건`}
      width={480}
      isDirty={message.trim().length > 0}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className={`${ui.btn} ${ui.btnGhost}`} onClick={props.onClose}>취소</button>
          <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} disabled={create.isPending} onClick={() => void send()}>인계 보내기</button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>각 작업의 <b>담당 PM</b> 에게 보냅니다. PM 이 '나의 업무 → 인계' 에서 받으면 그 PM 의 시트에 들어갑니다.</p>
      <ul style={{ maxHeight: 160, overflow: 'auto', margin: '0 0 8px', paddingLeft: 18 }}>
        {props.jobs.map((j) => <li key={j.id}>{j.label}</li>)}
      </ul>
      <label style={{ display: 'block', marginBottom: 4 }}>PM 에게 전할 말 (선택)</label>
      <textarea rows={4} maxLength={2000} style={{ width: '100%', font: 'inherit' }} value={message} onChange={(e) => setMessage(e.target.value)} />
      {error ? <p style={{ color: '#d93025' }}>{error}</p> : null}
    </Modal>
  )
}

/** 이 프로젝트의 작업별 마지막 인계 상태. */
export function ProjectHandoverStatus({ projectId, jobLabel }: { projectId: string; jobLabel: (jobId: string) => string }) {
  const q = useProjectHandovers(projectId)
  const latest = new Map<string, PmHandover>()
  for (const h of q.data ?? []) {
    const prev = latest.get(h.jobId)
    if (!prev || Number(h.id) > Number(prev.id)) latest.set(h.jobId, h)
  }
  if (latest.size === 0) return null
  return (
    <div className={ui.card}>
      <div className={ui.cardHeader}>
        <span>JOB 인계 현황</span>
      </div>
      <div className={`${ui.cardBodyFlush} ${ui.tableWrap}`}>
        <table className={ui.table}>
          <thead>
            <tr>
              <th>작업</th>
              <th>받는 PM</th>
              <th>상태</th>
              <th>보낸 날</th>
              <th>PM 답변</th>
            </tr>
          </thead>
          <tbody>
            {[...latest.values()].map((h) => (
              <tr key={h.id}>
                <td>{jobLabel(h.jobId)}</td>
                <td>{h.toName ?? ''}</td>
                <td><b style={{ color: STATUS_COLOR[h.status] }}>{STATUS[h.status] ?? h.status}</b></td>
                <td>{isoToYmd(h.createdAt)}</td>
                <td style={{ whiteSpace: 'normal' }}>{h.reply ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
