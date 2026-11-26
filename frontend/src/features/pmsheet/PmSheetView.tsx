/**
 * 나의 업무 (개편) — 작업(JOB) 1개 = 1행인 PM 업무 시트.
 *
 * 탭:
 *   * 내 업무  — 내가 인계 받은 작업들의 시트.
 *   * 인계     — 영업 담당이 나에게 넘긴, 아직 받지 않은 작업. 배지 = 건수.
 *   * 완료 업무 — 내 업무에서 [아카이빙] 으로 보낸 납품 완료 행 (팀장님 2026-11-26, 읽기 전용).
 *   * 타PM 업무 — 다른 PM 의 시트를 열어 보고 고칠 수 있다(휴가·대리 처리). 고친 값은 그 PM 의 시트에 저장된다.
 *
 * 'PO 시트(이전)' 탭은 없앴다. PO 한 건이 한 행이던 개편 전 시트이고, 이 시트가 그 일을
 * 대신한다 — 비교할 것이 없어진 뒤로는 같은 일을 하는 화면이 둘 있다는 사실만 남았다.
 */
import { useState, type ReactNode } from 'react'
import { usePendingHandovers, usePmSheet, usePmStaff } from '@/apis/pmsheet.api'
import { ErrorNotice, SuccessNotice } from '@/shared/ui/Feedback'
import { ArchiveSheet } from './ArchiveSheet'
import { HandoverSheet } from './HandoverSheet'
import { PmSheet } from './PmSheet'
import css from './PmSheet.module.css'

type Tab = 'mine' | 'handover' | 'archive' | 'others'

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

  const tabs = (
    <div className={css.bottomTabs} role="tablist">
      {(
        [
          ['mine', '내 업무'],
          ['handover', '인계'],
          ['archive', '완료 업무'],
          ['others', '타PM 업무'],
        ] as [Tab, string][]
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          className={`${css.bottomTab} ${tab === id ? css.bottomTabOn : ''}`}
          onClick={() => setTab(id)}
        >
          {label}
          {id === 'handover' && pendingCount > 0 ? <span className={css.badge}>{pendingCount}</span> : null}
        </button>
      ))}
    </div>
  )

  /*
   * 화면을 꽉 채운다 (팀장님 2026-11-25): 제목·경로 줄 없이 머리줄 바로 밑부터 시트, 탭은 구글 시트처럼
   * 맨 아래. 알림은 시트를 밀어내지 않게 위에 떠 있다가 사라진다.
   */
  return (
    <div className={css.fullPage}>
      {notice || error ? (
        <div className={css.toastBox}>
          {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}
          {error ? (
            <div onClick={() => setError(null)} title="눌러서 닫기" style={{ cursor: 'pointer' }}>
              <ErrorNotice error={new Error(error)} />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={css.fullBody}>
        {tab === 'mine' ? <SheetPane staffId={null} onNotice={show} onError={fail} /> : null}
        {tab === 'handover' ? (
          <div className={css.handoverPane}>
            <HandoverSheet staffId={null} onNotice={show} onError={fail} />
          </div>
        ) : null}
        {tab === 'archive' ? <ArchiveSheet staffId={null} /> : null}
        {tab === 'others' ? <OthersPane selected={other} onSelect={setOther} onNotice={show} onError={fail} /> : null}
      </div>

      {tabs}
    </div>
  )
}

/** 아래 탭 줄 높이 + 1 — 시트가 그 위에서 끝나게. */
const TAB_BAR_GAP = 35

function SheetPane(props: {
  staffId: string | null
  onNotice: (m: string) => void
  onError: (m: string) => void
  toolbarStart?: ReactNode
}) {
  const q = usePmSheet(props.staffId)
  if (q.isLoading) return <p style={{ padding: 16 }}>시트를 불러오는 중…</p>
  if (q.error || !q.data) return <ErrorNotice error={q.error ?? new Error('시트를 불러오지 못했습니다.')} />
  return (
    <div className={css.sheetFrame}>
      <PmSheet
        key={props.staffId ?? 'me'}
        sheet={q.data}
        ownerId={props.staffId ?? undefined}
        onNotice={props.onNotice}
        onError={props.onError}
        toolbarStart={props.toolbarStart}
        bottomGap={TAB_BAR_GAP}
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
  if (!chosen) {
    return (
      <div className={css.othersPick}>
        <p className={css.small}>PM 을 고르면 그 사람의 시트가 열립니다. 여기서 고친 값·서식은 그 PM 의 시트에 저장됩니다.</p>
        <div className={css.staffBar}>
          {staff.isLoading ? <span className={css.small}>직원 목록을 불러오는 중…</span> : null}
          {list.map((s) => (
            <button key={s.id} type="button" className={css.staffBtn} onClick={() => props.onSelect(s.id)}>
              {s.name} <span className={css.small}>({s.rows})</span>
            </button>
          ))}
          {!staff.isLoading && list.length === 0 ? <span className={css.small}>다른 PM 이 없습니다.</span> : null}
        </div>
      </div>
    )
  }
  // PM 고르기는 도구막대 맨 왼쪽에 — 줄을 하나 아낀다 (팀장님 2026-11-25).
  const picker = (
    <select
      className={css.pmPick}
      value={chosen.id}
      title={`${chosen.name} 님의 시트 — 여기서 고친 값·서식은 ${chosen.name} 님의 시트에 저장됩니다.`}
      onChange={(e) => props.onSelect(e.target.value || null)}
    >
      <option value="">PM 고르기…</option>
      {list.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name} 님의 시트 ({s.rows})
        </option>
      ))}
    </select>
  )
  return <SheetPane staffId={chosen.id} onNotice={props.onNotice} onError={props.onError} toolbarStart={picker} />
}
