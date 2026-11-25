/**
 * 확인 창 — 브라우저 기본 confirm 대신 (팀장님 2026-11-25).
 * 아이콘 · 질문 · 설명 · [취소] [확인]. Enter 는 확인, Esc 는 취소(Modal 이 처리).
 */
import type { ReactNode } from 'react'
import { Modal } from './Modal'
import ui from './ui.module.css'

export function ConfirmDialog(props: {
  title: string
  message: ReactNode
  detail?: ReactNode
  confirmLabel?: string
  pending?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <Modal
      title={props.title}
      onClose={props.onCancel}
      width={420}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={props.onCancel} disabled={props.pending}>
            취소
          </button>
          <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={props.onConfirm} disabled={props.pending} autoFocus>
            {props.pending ? '처리 중…' : (props.confirmLabel ?? '확인')}
          </button>
        </>
      }
    >
      <div className={ui.confirmBody}>
        <span className={ui.confirmIcon} aria-hidden="true">?</span>
        <div>
          <p className={ui.confirmMsg}>{props.message}</p>
          {props.detail ? <div className={ui.confirmDetail}>{props.detail}</div> : null}
        </div>
      </div>
    </Modal>
  )
}
