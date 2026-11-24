/**
 * 인계 시트 — 영업 담당이 넘긴 작업(JOB)을 받거나(인계 받기), 고쳐 달라고 하거나(수정 요청), 거부한다.
 *
 * 다시 넘어온 인계(수정 요청 뒤 재인계)는 지난 인계와 달라진 칸이 노란색으로 보인다.
 * 수정 요청·거부는 이유를 적어야 하고, 그 글은 영업 담당에게 알림으로 간다.
 */
import { useState } from 'react'
import { useAnswerHandover, usePendingHandovers, type PmHandover, type PmSheetRow } from '@/apis/pmsheet.api'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'
import { formatHour, formatSheetDate } from './sheetFormat'
import css from './PmSheet.module.css'

type Pending = PmHandover & { row: PmSheetRow }

const COLS: { key: string; label: string; get: (s: Record<string, unknown>) => string }[] = [
  { key: 'cusCodeName', label: '업체명', get: (s) => str(s.cusCodeName) },
  { key: 'cusMgrName', label: '업체 담당', get: (s) => str(s.cusMgrName) },
  { key: 'prjMgrName', label: '영업 담당', get: (s) => str(s.prjMgrName) },
  { key: 'prjCode', label: 'PRCODE', get: (s) => str(s.prjCode) },
  { key: 'prjName', label: '프로젝트명', get: (s) => str(s.prjName) },
  { key: 'jobName', label: '작업명', get: (s) => str(s.jobName) },
  { key: 'workCode', label: '업무', get: (s) => str(s.workCode) },
  { key: 'lang', label: '번역어', get: (s) => str(s.lang) },
  { key: 'jobVolume', label: '분량', get: (s) => str(s.jobVolume) },
  { key: 'jobEday', label: '납품일', get: (s) => formatSheetDate(str(s.jobEday)) },
  { key: 'jobEdayTime', label: '시간', get: (s) => formatHour(str(s.jobEdayTime)) },
  { key: 'jobMemo', label: '작업 메모', get: (s) => str(s.jobMemo) },
]

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}

export function HandoverSheet(props: { staffId: string | null; onNotice: (m: string) => void; onError: (m: string) => void }) {
  const q = usePendingHandovers(props.staffId)
  const answer = useAnswerHandover()
  const [replying, setReplying] = useState<{ item: Pending; action: 'revision' | 'reject' } | null>(null)
  const items = q.data ?? []

  const accept = async (item: Pending) => {
    try {
      await answer.mutateAsync({ id: item.id, action: 'accept', reply: null })
      props.onNotice(`${item.row.jobCode} 인계를 받았습니다. "내 업무" 시트에 들어갔습니다.`)
    } catch (err) {
      props.onError(err instanceof Error ? err.message : '처리하지 못했습니다.')
    }
  }

  if (q.isLoading) return <p style={{ padding: 16 }}>불러오는 중…</p>
  if (q.error) return <p style={{ padding: 16, color: '#d93025' }}>인계 목록을 불러오지 못했습니다.</p>
  if (items.length === 0) return <p style={{ padding: 16 }}>받을 인계가 없습니다.</p>

  return (
    <div className={css.hoWrap}>
      <table className={css.hoTable}>
        <thead>
          <tr>
            <th>처리</th>
            <th>인계일</th>
            <th>보낸 사람</th>
            {COLS.map((c) => <th key={c.key}>{c.label}</th>)}
            <th>인계 메시지</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const changed = new Set(item.changedKeys)
            return (
              <tr key={item.id}>
                <td>
                  <div className={css.hoActions}>
                    <button type="button" className={`${ui.btn} ${ui.btnPrimary} ${ui.btnSm}`} disabled={answer.isPending} onClick={() => void accept(item)}>인계 받기</button>
                    <button type="button" className={`${ui.btn} ${ui.btnSm}`} disabled={answer.isPending} onClick={() => setReplying({ item, action: 'revision' })}>수정 요청</button>
                    <button type="button" className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`} disabled={answer.isPending} onClick={() => setReplying({ item, action: 'reject' })}>거부</button>
                  </div>
                </td>
                <td>{formatSheetDate(item.createdAt.slice(0, 10))}{changed.size > 0 ? <span className={`${css.badge} ${css.badgeMuted}`} title="수정 요청 뒤 다시 넘어온 인계">재인계</span> : null}</td>
                <td>{item.fromName ?? ''}</td>
                {COLS.map((c) => (
                  <td key={c.key} className={changed.has(c.key) ? css.hoChanged : undefined} title={changed.has(c.key) ? '지난 인계에서 바뀐 칸' : undefined}>
                    {c.get(item.snapshot)}
                  </td>
                ))}
                <td className={css.hoMsg}>{item.message ?? ''}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {replying ? (
        <ReplyModal
          item={replying.item}
          action={replying.action}
          busy={answer.isPending}
          onClose={() => setReplying(null)}
          onSend={async (reply) => {
            try {
              await answer.mutateAsync({ id: replying.item.id, action: replying.action, reply })
              props.onNotice(`${replying.item.fromName ?? '영업 담당'} 님께 ${replying.action === 'revision' ? '수정 요청' : '거부'}을 보냈습니다.`)
              setReplying(null)
            } catch (err) {
              props.onError(err instanceof Error ? err.message : '보내지 못했습니다.')
            }
          }}
        />
      ) : null}
    </div>
  )
}

function ReplyModal(props: {
  item: Pending
  action: 'revision' | 'reject'
  busy: boolean
  onClose: () => void
  onSend: (reply: string) => Promise<void>
}) {
  const [text, setText] = useState('')
  const verb = props.action === 'revision' ? '수정 요청' : '거부'
  return (
    <Modal
      title={`${verb} — ${props.item.row.jobCode}`}
      width={480}
      isDirty={text.trim().length > 0}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className={`${ui.btn} ${ui.btnGhost}`} onClick={props.onClose}>취소</button>
          <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} disabled={props.busy || text.trim().length === 0} onClick={() => void props.onSend(text.trim())}>보내기</button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>
        받는 사람: <b>{props.item.fromName ?? '(영업 담당 없음)'}</b>
      </p>
      <p className={css.small}>
        {props.action === 'revision'
          ? '무엇을 고쳐서 다시 넘겨 달라는지 적어 주세요. 다시 넘어오면 바뀐 칸이 노란색으로 보입니다.'
          : '거부하는 이유를 적어 주세요.'}
      </p>
      <textarea autoFocus rows={5} maxLength={2000} style={{ width: '100%', font: 'inherit' }} value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  )
}
