import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useJobs, useProfile } from '@/apis/queries/neotms.query'
import { useDeleteJob } from '@/apis/queries/neotms.mutation'
import { codeOptions, JOB_STATES, WORK_CODES } from '@/apis/neotms.codes'
import type { JobRow } from '@/apis/neotms.types'
import { LIST_PAGE_SIZE, NeotmsMenuId } from '@/shared/config'
import { useUrlFilters } from '@/shared/hooks/useUrlFilters'
import { mayDo } from '@/shared/permissions'
import { Amount } from '@/shared/ui/Amount'
import { ErrorNotice, LoadMore, SuccessNotice, TableState } from '@/shared/ui/Feedback'
import { formatDate, isOverdue } from '@/shared/utils/format'
import { decimalSum } from '@/shared/utils/money'
import ui from '@/shared/ui/ui.module.css'
import { JobFormModal } from './JobFormModal'

/**
 * 작업 목록. **이 화면의 금액이 매출이다.**
 *
 * ## 표시된 건의 합계를 머리에 둔다
 *
 * 전체 합계는 리포트가 준다. 여기 띄우는 것은 **지금 화면에 올라온 행들의 합**이고, 그래서
 * 라벨에 건수를 함께 쓴다("37건 합계"). 그 건수가 없으면 사용자는 이 숫자를 조건에 맞는 전체
 * 합계로 읽는다 — '더 보기' 를 누르지 않은 상태에서는 전체가 아니다.
 *
 * 금액이 비어 있는 행은 합계에서 빠지고(`decimalSum` 의 `skipped`), 빠진 건수도 같이 보여 준다.
 * 단가를 아직 입력하지 않은 작업이 섞여 있으면 합계는 실제보다 작고, 그 사실을 모르면 "매출이
 * 왜 이것밖에 안 되지" 로 끝난다.
 *
 * ## 납기 지난 행을 표시한다
 *
 * 이 목록이 열리는 가장 흔한 이유가 "뭐가 늦었나" 다. 완료·취소된 작업은 제외한다 — 끝난 일의
 * 납기가 지난 것은 당연하고, 그걸 칠하면 목록 절반이 붉어져서 정말 늦은 건이 묻힌다.
 */

const FILTER_KEYS = ['q', 'state', 'workCode', 'slang', 'elang'] as const

export function JobsView() {
  const { data: profile } = useProfile()
  const { filters, setFilters, resetFilters, activeCount } = useUrlFilters(FILTER_KEYS)

  const [draft, setDraft] = useState({
    q: filters.q,
    state: filters.state,
    workCode: filters.workCode,
    slang: filters.slang,
    elang: filters.elang,
  })
  const [editing, setEditing] = useState<JobRow | null | undefined>(undefined)
  const [notice, setNotice] = useState<string | null>(null)

  const jobsQuery = useJobs({
    limit: LIST_PAGE_SIZE,
    q: filters.q || undefined,
    state: filters.state || undefined,
    workCode: filters.workCode || undefined,
    slang: filters.slang || undefined,
    elang: filters.elang || undefined,
  })
  const deleteJob = useDeleteJob()

  const rows = useMemo(() => jobsQuery.data?.pages.flatMap((p) => p.items) ?? [], [jobsQuery.data])

  /** 화면에 올라온 행들의 원화 환산 매출 합계. 위 주석 참고. */
  const revenue = useMemo(() => decimalSum(rows.map((r) => r.jobPriceKsum)), [rows])

  const mayCreate = mayDo(profile, NeotmsMenuId.JOB, 'create')
  const mayUpdate = mayDo(profile, NeotmsMenuId.JOB, 'update')
  const mayDelete = mayDo(profile, NeotmsMenuId.JOB, 'delete')

  const onSearch = (e: FormEvent) => {
    e.preventDefault()
    setFilters(draft)
  }

  const onReset = () => {
    setDraft({ q: '', state: '', workCode: '', slang: '', elang: '' })
    resetFilters()
  }

  const onDelete = async (row: JobRow) => {
    const label = row.jobName || row.jobCode
    if (
      !window.confirm(
        `${label} 작업을 삭제할까요?\n이 작업의 매출이 집계에서 빠집니다. 발주가 달려 있으면 삭제할 수 없습니다.`,
      )
    ) {
      return
    }
    await deleteJob.mutateAsync(row.id)
    setNotice(`${label} 작업을 삭제했습니다.`)
  }

  return (
    <div className={ui.page}>
      <div className={ui.pageHead}>
        <div>
          <h1 className={ui.pageTitle}>작업</h1>
          <p className={ui.pageHint}>
            프로젝트를 쪼갠 실제 일감입니다. 원화 환산 합계가 이 시스템의 매출입니다.
          </p>
        </div>
        {mayCreate ? (
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => setEditing(null)}
          >
            작업 등록
          </button>
        ) : null}
      </div>

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}
      <ErrorNotice error={deleteJob.error} />

      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <span>{rows.length}건 표시</span>
          <span className={ui.spacer} />
          <span className={ui.hint}>
            표시된 {revenue.counted}건 매출 합계{' '}
            <Amount value={revenue.total} kind="revenue" />
            {revenue.skipped > 0 ? ` · 금액 미입력 ${revenue.skipped}건 제외` : ''}
          </span>
        </div>

        <form className={ui.filterBar} onSubmit={onSearch}>
          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="jf-q">
              검색어
            </label>
            <input
              id="jf-q"
              className={`${ui.input} ${ui.searchInput}`}
              type="search"
              placeholder="작업명 · 코드 · 프로젝트"
              value={draft.q}
              onChange={(e) => setDraft((p) => ({ ...p, q: e.target.value }))}
            />
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="jf-state">
              진행 상태
            </label>
            <select
              id="jf-state"
              className={ui.select}
              value={draft.state}
              onChange={(e) => setDraft((p) => ({ ...p, state: e.target.value }))}
            >
              <option value="">전체</option>
              {codeOptions(JOB_STATES, draft.state).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="jf-work">
              작업 종류
            </label>
            <select
              id="jf-work"
              className={ui.select}
              value={draft.workCode}
              onChange={(e) => setDraft((p) => ({ ...p, workCode: e.target.value }))}
            >
              <option value="">전체</option>
              {codeOptions(WORK_CODES, draft.workCode).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="jf-slang">
              출발어
            </label>
            <input
              id="jf-slang"
              className={ui.input}
              value={draft.slang}
              onChange={(e) => setDraft((p) => ({ ...p, slang: e.target.value }))}
            />
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="jf-elang">
              도착어
            </label>
            <input
              id="jf-elang"
              className={ui.input}
              value={draft.elang}
              onChange={(e) => setDraft((p) => ({ ...p, elang: e.target.value }))}
            />
          </div>

          <div className={ui.spacer} />

          <button type="submit" className={`${ui.btn} ${ui.btnPrimary}`}>
            조회
          </button>
          {activeCount > 0 ? (
            <button type="button" className={`${ui.btn} ${ui.btnGhost}`} onClick={onReset}>
              조건 해제 ({activeCount})
            </button>
          ) : null}
        </form>

        <div className={`${ui.cardBodyFlush} ${ui.tableWrap}`}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>코드</th>
                <th>작업명</th>
                <th>프로젝트 · 고객사</th>
                <th>언어쌍</th>
                <th>물량 · 단가</th>
                <th>매출(원화)</th>
                <th>납기</th>
                <th>상태</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <TableState
                isLoading={jobsQuery.isLoading}
                error={jobsQuery.error}
                isEmpty={rows.length === 0}
                emptyText={
                  activeCount > 0
                    ? '조건에 맞는 작업이 없습니다.'
                    : '등록된 작업이 없습니다. 프로젝트를 먼저 만든 뒤 작업을 추가합니다.'
                }
                colSpan={9}
              />
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className={ui.cellMono}>{row.jobCode}</td>
                  <td>{row.jobName || '(이름 없음)'}</td>
                  <td className={ui.cellMuted}>
                    <div>
                      <Link className={ui.btnLink} to={`/projects/${row.projectId}`}>
                        {row.prjName || row.prjCode || '프로젝트'}
                      </Link>
                    </div>
                    {row.cusCodeName ? <div>{row.cusCodeName}</div> : null}
                  </td>
                  <td className={ui.cellMuted}>
                    {[row.jobSlang, row.jobElang].filter(Boolean).join(' → ') || '-'}
                  </td>
                  <td className={ui.cellMuted}>
                    <div>
                      {row.jobVolume ?? '-'} {row.unitCode ?? ''}
                    </div>
                    {/*
                     * 단가에는 통화를 붙인다. 원화 환산 매출(다음 열)에는 붙이지 않는다 —
                     * 환산액은 언제나 원화이고, 두 열에 모두 코드가 있으면 어느 쪽이 외화인지
                     * 구분이 사라진다.
                     */}
                    <div>
                      <Amount value={row.jobPrice} coinCode={row.coinCode} />
                    </div>
                  </td>
                  <td>
                    <Amount value={row.jobPriceKsum} kind="revenue" />
                  </td>
                  <td
                    className={
                      isOverdue(row.jobEday) && row.jobState !== '완료' && row.jobState !== '취소'
                        ? ui.amountNeg
                        : ui.cellMuted
                    }
                  >
                    {formatDate(row.jobEday)}
                    {row.jobEdayTime ? <div>{row.jobEdayTime}</div> : null}
                  </td>
                  <td>
                    <span
                      className={`${ui.badge} ${row.jobState === '진행' ? ui.badgePrimary : ''}`}
                    >
                      {row.jobState || '-'}
                    </span>
                  </td>
                  <td>
                    <div className={ui.rowActions}>
                      {mayUpdate ? (
                        <button
                          type="button"
                          className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
                          onClick={() => setEditing(row)}
                        >
                          수정
                        </button>
                      ) : null}
                      {mayDelete ? (
                        <button
                          type="button"
                          className={`${ui.btn} ${ui.btnDanger} ${ui.btnSm}`}
                          onClick={() => void onDelete(row)}
                          disabled={deleteJob.isPending}
                        >
                          삭제
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <LoadMore
          hasNextPage={!!jobsQuery.hasNextPage}
          isFetchingNextPage={jobsQuery.isFetchingNextPage}
          onClick={() => void jobsQuery.fetchNextPage()}
        />
      </div>

      {editing !== undefined ? (
        <JobFormModal job={editing} onClose={() => setEditing(undefined)} onSaved={setNotice} />
      ) : null}
    </div>
  )
}
