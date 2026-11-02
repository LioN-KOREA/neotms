import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useProfile, useProjects } from '@/apis/queries/neotms.query'
import { useDeleteProject } from '@/apis/queries/neotms.mutation'
import {
  codeOptions,
  INVOICE_STATES,
  MONEY_STATES,
  PROJECT_STATES,
} from '@/apis/neotms.codes'
import type { ProjectRow } from '@/apis/neotms.types'
import { LIST_PAGE_SIZE, NeotmsMenuId } from '@/shared/config'
import { useUrlFilters } from '@/shared/hooks/useUrlFilters'
import { mayDo } from '@/shared/permissions'
import { ErrorNotice, LoadMore, SuccessNotice, TableState } from '@/shared/ui/Feedback'
import { Icon } from '@/shared/ui/Icon'
import { StatusChip } from '@/shared/ui/StatusChip'
import { formatDate, isOverdue } from '@/shared/utils/format'
import ui from '@/shared/ui/ui.module.css'
import { ProjectFormModal } from './ProjectFormModal'

/**
 * 프로젝트 목록.
 *
 * ## 세 가지 상태를 모두 세운다
 *
 * 진행 상태·세금계산서·입금은 서로 다른 축이고, 담당자가 실제로 찾는 것은 그 **조합**이다 —
 * "완료됐는데 계산서가 안 나간 프로젝트", "계산서는 나갔는데 입금이 안 된 프로젝트". 레거시에서
 * 이 조합을 찾는 방법은 목록을 눈으로 훑는 것뿐이었고, 그래서 입금 누락이 몇 달씩 남아 있었다.
 * 세 열을 모두 세우고 세 필터를 모두 주는 이유가 그것이다.
 *
 * ## 프로젝트명이 링크다
 *
 * 금액은 이 화면에 없다. 매출은 작업(JOB)에 쌓이므로 프로젝트의 합계는 소속 작업을 모아야 나오고,
 * 그건 상세 화면이 한다. 목록에서 합계를 보여 주려면 행마다 집계 쿼리가 필요하다 — 용량이
 * 고정된 소형 DB 인스턴스에서 50행짜리 목록에 50번의 집계를 붙일 수는 없다.
 *
 * ## 기간 검색은 '기준 + 범위' 다
 *
 * 프로젝트에는 날짜가 둘 있다(시작일 `prj_sday`, 납기일 `prj_eday`). "3월 프로젝트를 보여 달라"
 * 는 요청은 그래서 **두 가지 뜻**이고, 둘 다 실제로 쓰인다 — 영업담당자는 "3월에 **수주한**"
 * 건을 보고, PM 은 "3월에 **납품할**" 건을 본다. 그래서 날짜칸 둘 앞에 기준 드롭다운을 둔다.
 *
 * 날짜칸 **넷**(시작일 범위 + 납기일 범위)을 한 줄에 세우지 않는 이유는 둘이다. 하나는 자리다 —
 * 걸러내기 줄에 이미 검색어와 상태 셋이 있고, 거기에 날짜칸 넷을 더하면 줄이 두 줄로 접힌다.
 * 다른 하나는 그 조합이 거의 쓰이지 않는다는 것이다. 네 칸을 다 채우면 "3월에 시작해서 3월에
 * 끝나는" 이라는 뜻이 되는데, 그 질문을 하는 사람은 드물고 할 수 있는 길은 남아 있다(서버는
 * 두 범위를 독립으로 받는다 — `ProjectListQuery` 주석 참고). 드물게 쓰는 조합 때문에 늘 쓰는
 * 화면을 어지럽히지 않는다는 쪽을 골랐다.
 */

const FILTER_KEYS = ['q', 'state', 'invoiceState', 'moneyState', 'basis', 'from', 'to'] as const

/**
 * 기간 검색의 기준. 주소에 적히는 값이므로 **짧고 안 바뀌어야** 한다.
 *
 * `'start'` 가 기본값이고, 주소에 `basis` 가 없을 때도 그렇게 읽는다. 기본값을 납기일로 두지
 * 않은 이유는, 이 화면에서 납기일에는 이미 '지난 납기 붉게' 라는 별도 신호가 있어서 납기 중심의
 * 질문은 눈으로도 답이 나오는 반면, "이 기간에 시작한 일" 은 목록을 훑어서는 알 수 없기
 * 때문이다.
 */
const PERIOD_BASES = [
  { value: 'start', label: '시작일' },
  { value: 'due', label: '납기일' },
] as const

export function ProjectsView() {
  const { data: profile } = useProfile()
  const { filters, setFilters, resetFilters, activeCount } = useUrlFilters(FILTER_KEYS)

  /** 입력 중인 값. 주소로 옮기는 것은 '조회' 를 누를 때만 한다. */
  const [draft, setDraft] = useState({
    q: filters.q,
    state: filters.state,
    invoiceState: filters.invoiceState,
    moneyState: filters.moneyState,
    basis: filters.basis || 'start',
    from: filters.from,
    to: filters.to,
  })
  const [editing, setEditing] = useState<ProjectRow | null | undefined>(undefined)
  const [notice, setNotice] = useState<string | null>(null)

  /*
   * 주소의 기간을 서버 파라미터 한 쌍으로 옮긴다.
   *
   * 고른 기준의 한 쌍만 채우고 **나머지 한 쌍은 undefined 로 남긴다.** 둘 다 채우면 서버가 두
   * 범위를 AND 로 묶으므로(의도된 동작이다) "3월에 시작해서 3월에 끝나는" 으로 뜻이 바뀌고,
   * 사용자는 기준을 '시작일' 로 골랐는데 납기가 다음 달인 프로젝트가 사라진 이유를 알 수 없다.
   *
   * `|| undefined` 가 필요한 이유: 주소에서 읽은 값은 없을 때 빈 문자열이고, 빈 문자열을
   * 그대로 넘기면 쿼리 키가 `{ startFrom: '' }` 과 `{}` 로 갈라져 **같은 목록을 두 번 캐시**한다
   * (api 레이어가 빈 값을 URL 에서 떨어뜨리므로 서버로는 같은 요청이 간다).
   */
  const useDueBasis = filters.basis === 'due'
  const periodFrom = filters.from || undefined
  const periodTo = filters.to || undefined

  const projectsQuery = useProjects({
    limit: LIST_PAGE_SIZE,
    q: filters.q || undefined,
    state: filters.state || undefined,
    invoiceState: filters.invoiceState || undefined,
    moneyState: filters.moneyState || undefined,
    startFrom: useDueBasis ? undefined : periodFrom,
    startTo: useDueBasis ? undefined : periodTo,
    dueFrom: useDueBasis ? periodFrom : undefined,
    dueTo: useDueBasis ? periodTo : undefined,
  })
  const deleteProject = useDeleteProject()

  const rows = useMemo(
    () => projectsQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [projectsQuery.data],
  )

  const mayCreate = mayDo(profile, NeotmsMenuId.PROJECT, 'create')
  const mayUpdate = mayDo(profile, NeotmsMenuId.PROJECT, 'update')
  const mayDelete = mayDo(profile, NeotmsMenuId.PROJECT, 'delete')

  /*
   * 기간의 앞뒤가 뒤집혔는지. `YYYY-MM-DD` 는 사전순 비교가 곧 날짜순 비교다.
   *
   * 막지 않고 알려만 준다. 서버는 이 조건으로 **빈 목록**을 돌려주는데, 빈 목록은 "그 기간에
   * 프로젝트가 없다" 와 생김새가 똑같다 — 날짜를 거꾸로 넣은 사람은 조건이 틀렸다는 사실을
   * 알 길이 없고 "데이터가 없네" 로 결론을 낸다. 그 오해가 이 한 줄보다 비싸다.
   */
  const rangeReversed = !!draft.from && !!draft.to && draft.from > draft.to

  const onSearch = (e: FormEvent) => {
    e.preventDefault()
    /*
     * 기준은 **날짜가 하나라도 있을 때만** 주소에 적는다.
     *
     * 늘 적으면 `?basis=start` 가 조건이 하나도 없는 목록에도 남고, `activeCount` 가 그걸 세어
     * '조건 해제 (1)' 버튼이 항상 떠 있게 된다. 해제할 조건이 없는데 해제 버튼이 보이는 화면은
     * 사용자가 버튼을 눌러 보고 아무 일도 안 일어나는 것을 확인해야 하는 화면이다.
     */
    const hasPeriod = !!draft.from || !!draft.to
    setFilters({ ...draft, basis: hasPeriod ? draft.basis : '' })
  }

  const onReset = () => {
    setDraft({
      q: '',
      state: '',
      invoiceState: '',
      moneyState: '',
      // 기준은 비우지 않고 기본값으로 되돌린다 — 드롭다운에 빈 항목이 없으므로 빈 문자열을
      // 넣으면 `<select>` 의 value 가 어느 option 과도 안 맞아 브라우저가 첫 항목을 고른 척
      // 보여 준다. 즉 화면에는 '시작일' 이 적혀 있는데 상태는 '' 인, 눈과 코드가 어긋난 상태.
      basis: 'start',
      from: '',
      to: '',
    })
    resetFilters()
  }

  /*
   * 삭제는 소속 작업이 있으면 서버가 거절한다(FK).
   *
   * 그 409 를 미리 막으려 하지 않는다 — 막으려면 작업 수를 세야 하고, 그러면 목록마다 집계가
   * 붙는다. 대신 확인 문구에서 그 가능성을 미리 알려 준다. 실패하면 `ErrorNotice` 가 서버
   * 메시지를 번역해 보여 준다(shared/utils/errors.ts).
   */
  const onDelete = async (row: ProjectRow) => {
    const label = row.prjName || row.prjCode
    if (
      !window.confirm(
        `${label} 프로젝트를 삭제할까요?\n소속 작업이 있으면 삭제할 수 없습니다. 먼저 작업을 정리해 주세요.`,
      )
    ) {
      return
    }
    await deleteProject.mutateAsync(row.id)
    setNotice(`${label} 프로젝트를 삭제했습니다.`)
  }

  return (
    <div className={ui.page}>
      {/*
       * 제목이 없다. 경로 표시줄(셸)과 좌측 패널이 이미 '프로젝트' 라고 두 번 적고 있으므로,
       * 여기서는 그 메뉴 이름으로는 알 수 없는 것 — 이 화면의 한 건이 무엇인지 — 만 적는다.
       */}
      <div className={ui.pageBar}>
        <p className={ui.pageNote}>
          프로젝트를 조회, 등록 및 확인합니다.
        </p>
        {mayCreate ? (
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => setEditing(null)}
          >
            <Icon name="plus" size={13} />
            프로젝트 등록
          </button>
        ) : null}
      </div>

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}
      <ErrorNotice error={deleteProject.error} />

      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <span>{rows.length}건 표시</span>
        </div>

        <form className={ui.filterBar} onSubmit={onSearch}>
          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="pf-q">
              검색어
            </label>
            <input
              id="pf-q"
              className={`${ui.input} ${ui.searchInput}`}
              type="search"
              placeholder="프로젝트명 · 코드 · 고객사"
              value={draft.q}
              onChange={(e) => setDraft((p) => ({ ...p, q: e.target.value }))}
            />
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="pf-state">
              진행 상태
            </label>
            <select
              id="pf-state"
              className={ui.select}
              value={draft.state}
              onChange={(e) => setDraft((p) => ({ ...p, state: e.target.value }))}
            >
              <option value="">전체</option>
              {codeOptions(PROJECT_STATES, draft.state).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="pf-invoice">
              세금계산서
            </label>
            <select
              id="pf-invoice"
              className={ui.select}
              value={draft.invoiceState}
              onChange={(e) => setDraft((p) => ({ ...p, invoiceState: e.target.value }))}
            >
              <option value="">전체</option>
              {codeOptions(INVOICE_STATES, draft.invoiceState).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="pf-money">
              입금
            </label>
            <select
              id="pf-money"
              className={ui.select}
              value={draft.moneyState}
              onChange={(e) => setDraft((p) => ({ ...p, moneyState: e.target.value }))}
            >
              <option value="">전체</option>
              {codeOptions(MONEY_STATES, draft.moneyState).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {/*
            기간 검색: 기준 하나 + 날짜 둘.
            세 칸을 연달아 두는 이유는 이 셋이 **한 조건**이기 때문이다. 사이에 상태 드롭다운이
            끼면 '기준' 이 무엇의 기준인지 읽히지 않는다.
          */}
          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="pf-basis">
              기간 기준
            </label>
            <select
              id="pf-basis"
              className={ui.select}
              value={draft.basis}
              onChange={(e) => setDraft((p) => ({ ...p, basis: e.target.value }))}
            >
              {PERIOD_BASES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="pf-from">
              기간 시작
            </label>
            <input
              id="pf-from"
              className={ui.input}
              type="date"
              value={draft.from}
              onChange={(e) => setDraft((p) => ({ ...p, from: e.target.value }))}
            />
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="pf-to">
              기간 종료
            </label>
            <input
              id="pf-to"
              className={ui.input}
              type="date"
              value={draft.to}
              onChange={(e) => setDraft((p) => ({ ...p, to: e.target.value }))}
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

          {rangeReversed ? (
            <p className={`${ui.filterNote} ${ui.hintWarn}`}>
              기간 시작이 종료보다 뒤입니다. 이대로 조회하면 결과가 항상 비어 있습니다.
            </p>
          ) : null}
        </form>

        <div className={`${ui.cardBodyFlush} ${ui.tableWrap}`}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>코드</th>
                <th>프로젝트명</th>
                <th>고객사</th>
                <th>담당</th>
                <th>기간</th>
                <th>진행</th>
                <th>계산서</th>
                <th>입금</th>
                <th>수정</th>
              </tr>
            </thead>
            <tbody>
              <TableState
                isLoading={projectsQuery.isLoading}
                error={projectsQuery.error}
                isEmpty={rows.length === 0}
                emptyText={
                  activeCount > 0
                    ? '조건에 맞는 프로젝트가 없습니다.'
                    : '등록된 프로젝트가 없습니다. 먼저 고객사를 등록한 뒤 프로젝트를 만듭니다.'
                }
                colSpan={9}
              />
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className={ui.cellMono}>{row.prjCode}</td>
                  <td>
                    {/*
                     * 상세로 가는 링크. `<a href>` 가 아니라 `<Link>` 다 — href 를 쓰면 클릭마다
                     * 전체 문서가 다시 로드되고, 그때 프로필·목록 캐시가 전부 날아간 뒤 다시
                     * 읽힌다. 그 재조회는 람다 호출과 DB 쿼리를 그만큼 더 쓴다.
                     */}
                    <Link className={ui.btnLink} to={`/projects/${row.id}`}>
                      {row.prjName || '(이름 없음)'}
                    </Link>
                  </td>
                  <td>{row.cusCodeName || '-'}</td>
                  <td className={ui.cellMuted}>
                    {[row.prjMgrName, row.prjPmName].filter(Boolean).join(' / ') || '-'}
                  </td>
                  {/*
                   * 지난 납기를 붉게 표시한다. 완료·취소된 프로젝트는 제외한다 — 끝난 일의
                   * 납기가 지난 것은 당연한 사실이고, 그걸 빨갛게 칠하면 목록의 절반이 빨개져서
                   * 정말 늦은 건이 묻힌다.
                   */}
                  <td className={ui.cellMuted}>
                    <div>{formatDate(row.prjSday)} →</div>
                    <div
                      className={
                        isOverdue(row.prjEday) && row.prjState !== '완료' && row.prjState !== '취소'
                          ? ui.amountNeg
                          : undefined
                      }
                    >
                      {formatDate(row.prjEday)}
                      {row.prjEdayTime ? ` ${row.prjEdayTime}` : ''}
                    </div>
                  </td>
                  {/*
                   * 색은 StatusChip 의 표가 정한다.
                   *
                   * 여기서 삼항 연산자로 고르던 것을 옮긴 이유는, 같은 '정산완료' 가 이 화면과
                   * 발주 목록·프로젝트 상세에서 각각 따로 적혀 있었기 때문이다. 한 곳만 고치면
                   * 같은 값이 화면에 따라 다른 색으로 나오고, 담당자는 그걸 데이터의 차이로
                   * 읽는다.
                   */}
                  <td>
                    <StatusChip value={row.prjState} />
                  </td>
                  <td>
                    <StatusChip value={row.prjInvoiceState} />
                  </td>
                  <td>
                    <StatusChip value={row.prjMoneyState} />
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
                          disabled={deleteProject.isPending}
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
          hasNextPage={!!projectsQuery.hasNextPage}
          isFetchingNextPage={projectsQuery.isFetchingNextPage}
          onClick={() => void projectsQuery.fetchNextPage()}
        />
      </div>

      {editing !== undefined ? (
        <ProjectFormModal
          project={editing}
          onClose={() => setEditing(undefined)}
          onSaved={setNotice}
        />
      ) : null}
    </div>
  )
}
