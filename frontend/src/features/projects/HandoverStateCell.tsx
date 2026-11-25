/**
 * 작업 목록의 '인계 여부' 칸 (팀장님 2026-11-25).
 *
 * - 인계(받음): 초록 '인계' + 작은 회색 보낸 일시
 * - 인계 대기(보냈고 PM 이 아직): 주황 '인계 대기' + 보낸 일시
 * - 수정요청: 빨간 밑줄 '수정요청' — 누르면 작은 창에 PM 이 적은 내용 전문
 * - 거부(예전 건): 빨간 '거부'
 * - 미인계: 회색
 */
import { useState } from 'react'
import type { PmHandover } from '@/apis/pmsheet.api'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'
import { handoverStamp } from './handoverState'

export function HandoverStateCell({ handover, jobLabel }: { handover: PmHandover | undefined; jobLabel: string }) {
  const [open, setOpen] = useState(false)
  const stamp = handover ? <span className={ui.hoStamp}>{handoverStamp(handover.createdAt)}</span> : null
  let body
  if (!handover) body = <span className={ui.hoNone}>미인계</span>
  else if (handover.status === 1) body = <><span className={ui.hoDone}>인계</span>{stamp}</>
  else if (handover.status === 0) body = <><span className={ui.hoWait}>인계 대기</span>{stamp}</>
  else if (handover.status === 2)
    body = (
      <>
        <button type="button" className={ui.hoRevision} onClick={() => setOpen(true)} title="수정요청 내용 보기">
          수정요청
        </button>
        {stamp}
      </>
    )
  else body = <><span className={ui.hoReject} title={handover.reply ?? undefined}>거부</span>{stamp}</>
  return (
    <td className={ui.hoCell}>
      {body}
      {open && handover ? (
        <Modal title={`수정요청 — ${jobLabel}`} onClose={() => setOpen(false)} width={420}
          footer={<button type="button" className={ui.btn} onClick={() => setOpen(false)}>닫기</button>}
        >
          <p className={ui.hint} style={{ marginTop: 0 }}>
            {handover.toName ?? '담당PM'} · {handoverStamp(handover.answeredAt)}
          </p>
          <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{handover.reply || '(내용 없음)'}</div>
        </Modal>
      ) : null}
    </td>
  )
}
