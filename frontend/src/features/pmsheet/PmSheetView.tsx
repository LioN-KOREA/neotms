/**
 * 나의 업무 (개편) — 작업(JOB) 1개 = 1행인 PM 업무 시트.
 *
 * 탭:
 *   * 내 업무  — 내가 인계 받은 작업들의 시트.
 *   * 인계     — 영업 담당이 나에게 넘긴, 아직 받지 않은 작업. 배지 = 건수.
 *   * 타PM 업무 — 다른 PM 의 시트를 열어 보고 고칠 수 있다(휴가·대리 처리). 고친 값은 그 PM 의 시트에 저장된다.
 *   * PO 시트(이전) — 개편 전의 PO 단위 시트. 비교·이행 기간 동안 남겨 둔다.
 */
import { useState } from 'react'
import { usePendingHandovers, usePmSheet, usePmStaff } from '@/apis/pmsheet.api'
import { ErrorNotice, SuccessNotice } from '@/shared/ui/Feedback'
import ui from '@/shared/ui/ui.module.css'
import { WorkspaceView } from '@/features/workspace/WorkspaceView'
import { HandoverSheet } from './HandoverSheet'
import { PmSheet } from './PmSheet'
import css from './PmSheet.module.css'

type Tab = 'mine' | 'handover' | 'others' | 'legacy'

export function PmSheetView() {
  const [tab, setTab] = useState<Tab>('mine')
  const [other, setOther] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = usePendingHandovers(null)
  const pendingCount = pending.data?.length ?? 0

  const show = (m: string) => {
    setError(null)
    setNotice(m)
    window.setTimeout(() => setNotice((n) => (n === m ? null : n)), 5000)
  }
  const fail = (m: string) => {
    setNotice(null)
    setError(m)
  }

  return (
    <div className={ui.page}>
      <div className={ui.pageBar}>
        <h1 style={{ margin: 0, fontSize: 20 }}>나의 업무</h1>
      </div>

      <div className={css.tabs} role="tablist">
        {(
          [
            ['mine', '내 업무'],
            ['handover', '인계'],
            ['others', '타PM 업무'],
            ['legacy', 'PO 시트(이전)'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={`${css.tab} ${tab === id ? css.tabOn : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
            {id === 'handover' && pendingCount > 0 ? <span className={css.badge}>{pendingCount}</span> : null}
          </button>
        ))}
      </div>

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}
      {error ? (
        <div onClick={() => setError(null)} title="눌러서 닫기" style={{ cursor: 'pointer' }}>
          <ErrorNotice error={new Error(error)} />
        </div>
      ) : null}

      {tab === 'mine' ? <SheetPane staffId={null} onNotice={show} onError={fail} /> : null}
      {tab === 'handover' ? (
        <div className={ui.card}>
          <HandoverSheet staffId={null} onNotice={show} onError={fail} />
        </div>
      ) : null}
      {tab === 'others' ? (
        <OthersPane selected={other} onSelect={setOther} onNotice={show} onError={fail} />
      ) : null}
      {tab === 'legacy' ? <WorkspaceView /> : null}
    </div>
  )
}

function SheetPane(props: { staffId: string | null; onNotice: (m: string) => void; onError: (m: string) => void }) {
  const q = usePmSheet(props.staffId)
  if (q.isLoading) return <p style={{ padding: 16 }}>시트를 불러오는 중…</p>
  if (q.error || !q.data) return <ErrorNotice error={q.error ?? new Error('시트를 불러오지 못했습니다.')} />
  return (
    <div className={ui.card}>
      <PmSheet
        key={props.staffId ?? 'me'}
        sheet={q.data}
        ownerId={props.staffId ?? undefined}
        onNotice={props.onNotice}
        onError={props.onError}
      />
    </div>
  )
}

function OthersPane(props: {
  selected: string | null
  onSelect: (id: string | null) => void
  onNotice: (m: string) => void
  onError: (m: string) => void
}) {
  const staff = usePmStaff()
  const me = usePmSheet(null)
  const myId = me.data?.staff.id
  const list = (staff.data ?? []).filter((s) => s.id !== myId)
  const chosen = list.find((s) => s.id === props.selected) ?? null
  return (
    <>
      <div className={css.staffBar}>
        {staff.isLoading ? <span className={css.small}>직원 목록을 불러오는 중…</span> : null}
        {list.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`${css.staffBtn} ${chosen?.id === s.id ? css.staffBtnOn : ''}`}
            onClick={() => props.onSelect(chosen?.id === s.id ? null : s.id)}
          >
            {s.name} <span className={css.small} style={chosen?.id === s.id ? { color: '#fff' } : undefined}>({s.rows})</span>
          </button>
        ))}
        {!staff.isLoading && list.length === 0 ? <span className={css.small}>다른 PM 이 없습니다.</span> : null}
      </div>
      {chosen ? (
        <>
          <div className={css.otherBanner}>
            <b>{chosen.name}</b> 님의 시트를 보고 있습니다. 여기서 고친 값·서식은 {chosen.name} 님의 시트에 저장됩니다.
          </div>
          <SheetPane staffId={chosen.id} onNotice={props.onNotice} onError={props.onError} />
        </>
      ) : (
        <p className={css.small}>위에서 PM 을 고르면 그 사람의 시트가 열립니다.</p>
      )}
    </>
  )
}
