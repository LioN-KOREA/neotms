/**
 * '완료 업무' 시트 (팀장님 2026-11-26, db/016) — 내 업무에서 [아카이빙] 으로 보낸 납품 완료 행의 보관함.
 *
 * 열 구성은 내 업무와 같다(추가한 열·순서·폭·숨김 포함). 행은 인계일 순이고, 'yyyy년 mm월' 라벨 줄
 * (지난해는 그 위에 상·하반기 줄)로 묶여 [+]/[−] 로 접고 편다. 지금은 읽기만 한다 — 추가 기획 예정.
 */
import { useState, type CSSProperties } from 'react'
import { usePmArchive, usePmSheet, type PmArchiveRow, type PmStyle } from '@/apis/pmsheet.api'
import { ErrorNotice } from '@/shared/ui/Feedback'
import { archiveLines, defaultCollapsed, visibleLines } from './archiveModel'
import { buildColumns, mergeStyle } from './sheetColumns'
import css from './PmSheet.module.css'

const STORE = 'neotms.pmArchive.collapsed'
const MONTH_COLOR = '#FF6D01'
const HALF_COLOR = '#5F6368'

function readStored(): string[] | null {
  try {
    const raw = window.localStorage.getItem(STORE)
    const v: unknown = raw ? JSON.parse(raw) : null
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null
  } catch {
    return null
  }
}

function cellCss(style: PmStyle): CSSProperties {
  const out: CSSProperties = {}
  if (style.bg) out.background = style.bg
  if (style.fg) out.color = style.fg
  if (style.bold) out.fontWeight = 700
  if (style.italic) out.fontStyle = 'italic'
  const deco = [style.underline ? 'underline' : '', style.strike ? 'line-through' : ''].filter(Boolean).join(' ')
  if (deco) out.textDecoration = deco
  if (style.align) out.textAlign = style.align
  return out
}

export function ArchiveSheet(props: { staffId: string | null }) {
  const sheet = usePmSheet(props.staffId)
  // 올해 — 반기 줄이 생기는 기준. 화면을 여는 동안 바뀌지 않는다.
  const [thisYear] = useState(() => new Date().getFullYear())
  const archive = usePmArchive(props.staffId)
  const [collapsed, setCollapsed] = useState<Set<string> | null>(() => {
    const stored = readStored()
    return stored ? new Set(stored) : null
  })

  if (archive.isLoading || sheet.isLoading) return <p style={{ padding: 16 }}>완료 업무를 불러오는 중…</p>
  if (archive.error) return <ErrorNotice error={archive.error} />

  const columns = buildColumns(sheet.data?.prefs.columns)
  const rows: PmArchiveRow[] = archive.data ?? []
  const lines = archiveLines(rows, thisYear)
  const shut = collapsed ?? defaultCollapsed(lines)
  const shown = visibleLines(lines, shut)
  const save = (next: Set<string>) => {
    setCollapsed(next)
    try {
      window.localStorage.setItem(STORE, JSON.stringify([...next]))
    } catch {
      /* 저장이 막힌 브라우저 — 이번 화면에서만 기억한다. */
    }
  }
  const toggle = (id: string) => {
    const next = new Set(shut)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    save(next)
  }
  const groupIds = lines.filter((l) => l.kind !== 'row').map((l) => l.id)
  const firstWidth = Math.max(columns[0]?.width ?? 56, 56)

  return (
    <div className={css.archivePane}>
      <div className={css.archiveBar}>
        <b>완료 업무</b>
        <span className={css.small}>
          {rows.length}행 · 인계일 순 · 읽기 전용 (내 업무의 [아카이빙] 으로 보낸 납품 완료 행)
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
          <button type="button" className={css.tool} onClick={() => save(new Set())}>
            모두 펼치기
          </button>
          <button type="button" className={css.tool} onClick={() => save(new Set(groupIds))}>
            모두 접기
          </button>
        </span>
      </div>
      {rows.length === 0 ? (
        <p className={css.small} style={{ padding: 16 }}>
          아직 완료 업무가 없습니다. 내 업무에서 진행 상태를 &apos;납품 완료&apos; 로 바꾼 뒤 도구모음의 [아카이빙] 을 누르세요.
        </p>
      ) : (
        <div className={css.archiveScroll}>
          <table className={css.archiveTable}>
            <colgroup>
              {columns.map((c, i) => (
                <col key={c.key} style={{ width: i === 0 ? firstWidth : c.width }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c.key} title={c.spec.hint}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((line) => {
                if (line.kind !== 'row') {
                  const open = !shut.has(line.id)
                  const isHalf = line.kind === 'half'
                  return (
                    <tr key={line.id} className={css.archiveLabel}>
                      <td colSpan={columns.length} style={{ background: isHalf ? HALF_COLOR : MONTH_COLOR }}>
                        <button
                          type="button"
                          className={css.archiveToggle}
                          style={{ marginLeft: line.depth === 1 ? 18 : 0 }}
                          title={open ? '접기' : '펼치기'}
                          onClick={() => toggle(line.id)}
                        >
                          {open ? '−' : '+'}
                        </button>
                        <span>{line.label}</span>
                        <span className={css.archiveCount}>{line.count}건</span>
                      </td>
                    </tr>
                  )
                }
                const { row } = line
                return (
                  <tr key={line.id}>
                    {columns.map((c) => {
                      const cell = row.cells[c.key]
                      const style = mergeStyle(cell?.s, row.rowStyle, c.style)
                      const text = c.key === 'rowNo' ? String(line.no) : (cell?.t ?? '')
                      return (
                        <td
                          key={c.key}
                          style={{ ...cellCss(style), ...(c.key === 'rowNo' ? { textAlign: 'center' } : {}) }}
                          title={text.length > 12 ? text : undefined}
                        >
                          {text}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
