import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useCodeNames, useJobs, useProfile } from '@/apis/queries/neotms.query'
import { useDeleteJob } from '@/apis/queries/neotms.mutation'
import { CODE_DOMAIN, codeOptions, isLinguistic, JOB_STATES } from '@/apis/neotms.codes'
import type { JobRow } from '@/apis/neotms.types'
import { LIST_PAGE_SIZE, NeotmsMenuId } from '@/shared/config'
import { useUrlFilters } from '@/shared/hooks/useUrlFilters'
import { mayDo } from '@/shared/permissions'
import { Amount } from '@/shared/ui/Amount'
import { CodeSelect } from '@/shared/ui/CodeSelect'
import { ErrorNotice, LoadMore, SuccessNotice, TableState } from '@/shared/ui/Feedback'
import { Icon } from '@/shared/ui/Icon'
import { KindTag, StatusChip } from '@/shared/ui/StatusChip'
import { formatDate, isOverdue } from '@/shared/utils/format'
import { decimalSum, krwToShow } from '@/shared/utils/money'
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

/*
 * 걸러낼 수 있는 조건들. URL 에 그대로 실린다(`useUrlFilters`).
 *
 * `jobType` 이 들어오면서 나머지 중 셋의 쓰임이 갈렸다 — 언어 작업에는 출발어·도착어, 비언어 작업에는
 * 업무 분류다. 셋을 다 남겨 두는 이유는 URL 이다: MICE 로 좁혀 둔 화면의 주소를 그대로 복사해 둔
 * 사람이 있을 수 있고, 조건 하나가 목록에서 빠지면 그 주소는 조용히 다른 결과를 돌려준다.
 */
const FILTER_KEYS = ['q', 'state', 'workCode', 'jobType', 'jobCategory', 'slang', 'elang'] as const

export function JobsView() {
  const { data: profile } = useProfile()
  const { filters, setFilters, resetFilters, activeCount } = useUrlFilters(FILTER_KEYS)

  const [draft, setDraft] = useState({
    q: filters.q,
    state: filters.state,
    workCode: filters.workCode,
    jobType: filters.jobType,
    jobCategory: filters.jobCategory,
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
    jobType: filters.jobType || undefined,
    jobCategory: filters.jobCategory || undefined,
    slang: filters.slang || undefined,
    elang: filters.elang || undefined,
  })
  const deleteJob = useDeleteJob()

  /** 업무 분류 코드를 이름으로. 표의 한 칸에서 쓰므로 행마다 부르지 않고 여기서 한 번 받는다. */
  const categoryName = useCodeNames(CODE_DOMAIN.JOBCAT)

  /**
   * 걸러내기 칸이 언어쌍을 물을지 업무 분류를 물을지.
   *
   * 폼과 달리 **'전체' 일 때는 둘 다 보여 준다.** 폼에서는 작업 하나의 업무 구분이 이미 정해져
   * 있으므로 쓰지 않는 칸을 숨기는 것이 맞지만, 여기서 구분을 고르지 않은 상태는 "모든 작업" 이고
   * 그 목록에는 두 종류가 섞여 있다 — 그때 업무 분류 칸을 숨기면 '행사운영' 으로 한 번에 좁힐 수
   * 없게 된다.
   */
  const typeFilter = draft.jobType.trim()
  const showLangFilters = typeFilter === '' || isLinguistic(typeFilter)
  const showCategoryFilter = typeFilter === '' || !isLinguistic(typeFilter)

  const rows = useMemo(() => jobsQuery.data?.pages.flatMap((p) => p.items) ?? [], [jobsQuery.data])

  /**
   * 화면에 올라온 행들의 원화 환산 매출 합계. 위 주석 참고.
   *
   * 저장된 금액(`jobPriceKsum`)이 아니라 **지금 시점의 가치**(`jobPriceKrw`)를 더한다 — 아래
   * 금액 칸과 같은 값이어야 하고, 그 이유는 `krwToShow` 에 적혀 있다. 둘을 섞으면 칸의 합과
   * 바닥의 합계가 다르다.
   */
  const revenue = useMemo(
    () => decimalSum(rows.map((r) => krwToShow(r.jobPriceKrw, r.jobPriceKsum))),
    [rows],
  )

  const mayCreate = mayDo(profile, NeotmsMenuId.JOB, 'create')
  const mayUpdate = mayDo(profile, NeotmsMenuId.JOB, 'update')
  const mayDelete = mayDo(profile, NeotmsMenuId.JOB, 'delete')

  const onSearch = (e: FormEvent) => {
    e.preventDefault()
    setFilters(draft)
  }

  const onReset = () => {
    setDraft({
      q: '',
      state: '',
      workCode: '',
      jobType: '',
      jobCategory: '',
      slang: '',
      elang: '',
    })
    resetFilters()
  }

  /**
   * 업무 구분을 바꾸면 쓰지 않게 된 조건을 **같이 비운다.**
   *
   * 비우지 않으면 숨겨진 조건이 계속 걸린다. MICE 를 고른 뒤 조회를 누르면 보이지 않는 출발어까지
   * 함께 나가고, 서버는 두 조건을 교집합으로 받으므로 결과가 0건이 된다 — 화면에는 "조건에 맞는
   * 작업이 없습니다" 만 남고, 걸려 있는 조건은 어디에도 보이지 않는다.
   */
  const onTypeChange = (value: string) => {
    setDraft((p) => {
      const next = { ...p, jobType: value }
      // '전체' 는 아무것도 비우지 않는다 — 두 칸이 모두 다시 보이므로 걸린 조건이 숨지 않는다.
      if (value.trim() === '') return next
      if (isLinguistic(value)) next.jobCategory = ''
      else {
        next.slang = ''
        next.elang = ''
      }
      return next
    })
  }

  const onDelete = async (row: JobRow) => {
    const label = row.jobName || row.jobCode
    if (
      !window.confirm(
        `${label} 작업을 삭제할까요?\n이 작업의 매출이 집계에서 빠집니다. PO 가 달려 있으면 삭제할 수 없습니다.`,
      )
    ) {
      return
    }
    await deleteJob.mutateAsync(row.id)
    setNotice(`${label} 작업을 삭제했습니다.`)
  }

  return (
    <div className={ui.page}>
      {/* 제목은 셸의 경로 표시줄이 들고 있다 — NeotmsApp.module.css 의 `.crumb` 주석. */}
      <div className={ui.pageBar}>
        <p className={ui.pageNote}>
          프로젝트에 속한 작업(JOB)들의 목록입니다.
        </p>
        {mayCreate ? (
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => setEditing(null)}
          >
            <Icon name="plus" size={13} />
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
            총 {revenue.counted}건 매출 합계{' '}
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
            {/*
             * 필터의 '전체' 는 빈 문자열이다. 등록 폼의 '선택 없음' 과 같은 값이지만 뜻이
             * 다르다 — 폼에서는 "값 없음으로 저장", 여기서는 "이 조건으로 좁히지 않음".
             */}
            <CodeSelect
              id="jf-work"
              domain={CODE_DOMAIN.WORK}
              value={draft.workCode}
              onChange={(v) => setDraft((p) => ({ ...p, workCode: v }))}
              placeholder="전체"
              silent
            />
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="jf-type">
              업무 구분
            </label>
            {/*
             * 이 화면에서 MICE·IMC 작업을 **찾을 수 있게 하는 칸이다.**
             *
             * 전에는 비언어 작업이 언어를 비워 둔 번역 작업으로 들어갔으니, 그걸 골라낼 조건이
             * 아예 없었다 — 언어가 빈 작업을 찾는 조건도 없고, 있었다 해도 그 결과에는 언어를
             * 적지 않은 번역 작업이 함께 걸렸다.
             */}
            <CodeSelect
              id="jf-type"
              domain={CODE_DOMAIN.JOBTYPE}
              value={draft.jobType}
              onChange={onTypeChange}
              placeholder="전체"
              silent
            />
          </div>

          {showCategoryFilter ? (
            <div className={ui.filterField}>
              <label className={ui.label} htmlFor="jf-category">
                업무 분류
              </label>
              <CodeSelect
                id="jf-category"
                domain={CODE_DOMAIN.JOBCAT}
                value={draft.jobCategory}
                onChange={(v) => setDraft((p) => ({ ...p, jobCategory: v }))}
                placeholder="전체"
                silent
              />
            </div>
          ) : null}

          {showLangFilters ? (
            <>
              <div className={ui.filterField}>
                <label className={ui.label} htmlFor="jf-slang">
                  출발어
                </label>
                {/*
                 * 자유 입력이었다. 필터에서 자유 입력은 저장을 깨뜨리지는 않지만 조용히 **0건**을
                 * 돌려준다 — '영어' 로 저장된 작업을 'English' 로 찾으면 결과가 없고, 화면은
                 * "검색한 작업이 없습니다" 라고만 말한다. 찾는 사람은 작업이 없다고 결론 낸다.
                 */}
                <CodeSelect
                  id="jf-slang"
                  domain={CODE_DOMAIN.LANG}
                  value={draft.slang}
                  onChange={(v) => setDraft((p) => ({ ...p, slang: v }))}
                  placeholder="전체"
                  silent
                />
              </div>

              <div className={ui.filterField}>
                <label className={ui.label} htmlFor="jf-elang">
                  도착어
                </label>
                <CodeSelect
                  id="jf-elang"
                  domain={CODE_DOMAIN.LANG}
                  value={draft.elang}
                  onChange={(v) => setDraft((p) => ({ ...p, elang: v }))}
                  placeholder="전체"
                  silent
                />
              </div>
            </>
          ) : null}

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
                {/*
                 * 작업 종류 열.
                 *
                 * 걸러내기에는 있었는데 표에는 없던 값이다. 그 조합은 쓸 수 없다 — '감수' 로
                 * 걸러낸 목록과 '번역' 으로 걸러낸 목록이 화면에서 똑같이 생겼으므로, 담당자는
                 * 자기가 무엇을 보고 있는지 걸러내기 칸을 다시 봐야 확인할 수 있었다.
                 */}
                <th>종류</th>
                {/*
                 * 한 열이 업무 구분에 따라 언어쌍 또는 업무 분류를 보여 준다.
                 *
                 * 열을 둘로 나누지 않는 이유: 어느 행이든 둘 중 하나만 값이 있으므로, 나누면
                 * 목록 전체에 반드시 빈 열이 하나 생긴다. 표가 넓어지는 대가로 얻는 것이 없다.
                 */}
                <th>언어 페어 · 업무 분류</th>
                <th>물량 · 단가</th>
                <th>매출(원화)</th>
                <th>마감일</th>
                <th>상태</th>
                <th>수정</th>
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
                colSpan={10}
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
                  <td>
                    <KindTag value={row.workCode} />
                  </td>
                  {/*
                   * 비언어 작업에는 업무 구분까지 같이 적는다. 업무 분류만으로는 MICE 의 '행사운영'
                   * 인지 IMC 의 '행사운영' 인지 알 수 없고, 그 둘은 다른 사업이다.
                   */}
                  <td className={ui.cellMuted}>
                    {isLinguistic(row.jobType)
                      ? [row.jobSlang, row.jobElang].filter(Boolean).join(' → ') || '-'
                      : [row.jobType, categoryName(row.jobCategory)].filter(Boolean).join(' · ') ||
                        '-'}
                  </td>
                  {/*
                   * 물량/단가. **비언어 작업에서는 두 줄이 모두 `-` 가 되고, 그게 의도한
                   * 모습이다.** 분기가 없는 것은 빠뜨린 것이 아니다 — 네 값 모두
                   * `job_detail_linguistic` 의 컬럼이므로(db/012_job_pricing.sql) MICE·IMC 작업은
                   * 언어 상세 행 자체가 없고, 서버가 null 을 돌려주므로 아래 두 폴백이 그대로
                   * 답이 된다.
                   *
                   * 비언어 작업의 업무량을 무엇으로 셀지는 아직 정해지지 않았다. 정해지면 그때
                   * 이 칸에 분기가 생긴다. 그 전까지 `-` 는 "이 작업은 단위로 팔지 않는다" 라는
                   * 정확한 진술이다.
                   */}
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
                    <Amount value={krwToShow(row.jobPriceKrw, row.jobPriceKsum)} kind="revenue" />
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
                    <StatusChip value={row.jobState} />
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
