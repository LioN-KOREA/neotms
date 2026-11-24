/**
 * 머리줄의 알림 종 — 인계·재인계(PM 에게), 인계 받음·수정 요청·거부(영업 담당에게).
 *
 * 1분마다 새 알림을 묻는다. 새로 온 알림이 있고 브라우저 알림을 허락했으면 바탕화면 알림도 띄운다
 * (기획서: 다른 창을 보고 있어도 인계가 온 것을 알 수 있게). 허락은 종을 처음 누를 때 묻는다 —
 * 브라우저는 사용자가 누른 순간에만 허락 창을 띄울 수 있다.
 */
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useNotices, useReadNotices, type PmNotice } from '@/apis/pmsheet.api'
import { Icon } from '@/shared/ui/Icon'

const KIND: Record<PmNotice['kind'], string> = {
  handover: '새 인계',
  rehandover: '다시 온 인계',
  accept: '인계 받음',
  revision: '수정 요청',
  reject: '인계 거부',
}

const SEEN_KEY = 'neotms.notice.lastSeen'

function readSeen(): number {
  try {
    return Number(window.localStorage.getItem(SEEN_KEY) ?? '0') || 0
  } catch {
    return 0
  }
}
function writeSeen(id: number) {
  try {
    window.localStorage.setItem(SEEN_KEY, String(id))
  } catch {
    /* 저장이 막힌 브라우저 — 알림이 한 번 더 뜰 뿐이다 */
  }
}

export function NoticeBell({ className }: { className?: string }) {
  const q = useNotices()
  const read = useReadNotices()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const items = q.data?.items ?? []
  const unread = q.data?.unread ?? 0

  /* 새 알림 → 바탕화면 알림. 처음 불러올 때 쌓여 있던 것은 띄우지 않는다(본 적 있는 최대 id 기준). */
  const data = q.data
  useEffect(() => {
    const items = data?.items ?? []
    if (items.length === 0) return
    const maxId = Math.max(...items.map((n) => Number(n.id)))
    const seen = readSeen()
    if (seen === 0) {
      writeSeen(maxId)
      return
    }
    if (maxId <= seen) return
    writeSeen(maxId)
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    for (const n of items.filter((x) => Number(x.id) > seen && !x.read).slice(0, 3)) {
      try {
        const note = new Notification(`NEOTMS · ${KIND[n.kind]}`, {
          body: [n.fromName, n.prjCode, n.jobName, n.message].filter(Boolean).join(' · '),
          tag: `neotms-notice-${n.id}`,
        })
        note.onclick = () => {
          window.focus()
          void navigate('/workspace')
        }
      } catch {
        /* 알림을 못 띄우는 환경 — 종 배지로 충분하다 */
      }
    }
  }, [data, navigate])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const toggle = () => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission()
    setOpen((o) => !o)
  }

  return (
    <div ref={box} style={{ position: 'relative' }}>
      <button type="button" className={className} onClick={toggle} title="알림" aria-label={`알림 ${String(unread)}건`}>
        <Icon name="bell" size={14} />
        {unread > 0 ? (
          <span style={{ background: '#d93025', color: '#fff', borderRadius: 9, padding: '0 5px', fontSize: 11, fontWeight: 700, marginLeft: 2 }}>
            {unread}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          style={{
            position: 'absolute', right: 0, top: '110%', width: 320, maxHeight: 420, overflow: 'auto', zIndex: 1000,
            background: 'var(--surface, #fff)', color: 'var(--text, #1f2328)', border: '1px solid #c6cbd2', borderRadius: 8,
            boxShadow: '0 6px 24px rgba(0,0,0,.18)', fontSize: 12.5,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', padding: '8px 10px', borderBottom: '1px solid #eceef1' }}>
            <b>알림</b>
            <span style={{ flex: 1 }} />
            {unread > 0 ? (
              <button type="button" style={{ border: 'none', background: 'none', color: '#1a73e8', cursor: 'pointer', font: 'inherit' }} onClick={() => read.mutate(null)}>
                모두 읽음
              </button>
            ) : null}
          </div>
          {items.length === 0 ? <p style={{ padding: 12, margin: 0, color: '#6b7280' }}>알림이 없습니다.</p> : null}
          {items.map((n) => (
            <button
              key={n.id}
              type="button"
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '8px 10px', border: 'none', borderTop: '1px solid #f3f4f6',
                background: n.read ? 'transparent' : '#f1f6fe', cursor: 'pointer', font: 'inherit', color: 'inherit',
              }}
              onClick={() => {
                if (!n.read) read.mutate([n.id])
                setOpen(false)
                void navigate('/workspace')
              }}
            >
              <div>
                <b style={{ color: n.kind === 'reject' ? '#d93025' : n.kind === 'revision' ? '#e37400' : '#1a73e8' }}>{KIND[n.kind]}</b>
                {' · '}
                {n.fromName ?? ''}
                <span style={{ float: 'right', color: '#9aa3ae' }}>{shortTime(n.createdAt)}</span>
              </div>
              <div style={{ color: '#374151' }}>{[n.prjCode, n.jobCode, n.jobName].filter(Boolean).join(' · ')}</div>
              {n.message ? <div style={{ color: '#6b7280', whiteSpace: 'pre-wrap' }}>{n.message}</div> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
