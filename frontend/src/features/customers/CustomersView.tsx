import { useMemo, useState, type FormEvent } from 'react'
import { useCustomers, useProfile } from '@/apis/queries/neotms.query'
import { useDeleteCustomer } from '@/apis/queries/neotms.mutation'
import type { CustomerRow } from '@/apis/neotms.types'
import { LIST_PAGE_SIZE, NeotmsMenuId } from '@/shared/config'
import { mayDo } from '@/shared/permissions'
import { useUrlFilters } from '@/shared/hooks/useUrlFilters'
import { Amount } from '@/shared/ui/Amount'
import { ErrorNotice, LoadMore, SuccessNotice, TableState } from '@/shared/ui/Feedback'
import { Icon } from '@/shared/ui/Icon'
import { ActiveChip } from '@/shared/ui/StatusChip'
import ui from '@/shared/ui/ui.module.css'
import { CustomerFormModal } from './CustomerFormModal'

/**
 * 고객사 목록.
 *
 * ## 검색은 서버가 한다
 *
 * 관리 콘솔의 계정 목록은 이미 받아 온 페이지 안에서 걸렀다. 거기는 계정이 수십 개였다. 고객사는
 * 수천 건이고 한 페이지가 50건이므로, 화면에서 거르면 "검색 결과가 없습니다 — 더 보기를 눌러
 * 보세요" 라는 말을 사용자에게 60번 하게 된다. 서버에 `q` 를 보내면 PGroonga 색인이
 * 전체에서 찾는다(두 글자 한글도 걸린다).
 *
 * ## 검색어는 주소에 있다
 *
 * `useUrlFilters` 가 `?q=` 로 들고 있으므로 새로고침·뒤로 가기·링크 공유가 모두 맞는다.
 * 입력 중인 글자는 별도의 로컬 상태이고, **Enter(또는 조회)에서만** 주소로 옮긴다 — 한 글자마다
 * 주소를 고치면 그만큼 쿼리가 나가고, 이 시스템의 비용은 사실상 그 호출 수다.
 */

/** 모듈 상수여야 한다 — 렌더마다 새 배열이면 `useUrlFilters` 의 메모가 매번 깨진다. */
const FILTER_KEYS = ['q'] as const

export function CustomersView() {
  const { data: profile } = useProfile()
  const { filters, setFilters } = useUrlFilters(FILTER_KEYS)

  const [keyword, setKeyword] = useState(filters.q)
  const [editing, setEditing] = useState<CustomerRow | null | undefined>(undefined)
  const [notice, setNotice] = useState<string | null>(null)

  const customersQuery = useCustomers({ limit: LIST_PAGE_SIZE, q: filters.q || undefined })
  const deleteCustomer = useDeleteCustomer()

  const rows = useMemo(
    () => customersQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [customersQuery.data],
  )

  const mayCreate = mayDo(profile, NeotmsMenuId.CUSTOMER, 'create')
  const mayUpdate = mayDo(profile, NeotmsMenuId.CUSTOMER, 'update')
  const mayDelete = mayDo(profile, NeotmsMenuId.CUSTOMER, 'delete')

  const onSearch = (e: FormEvent) => {
    e.preventDefault()
    setFilters({ q: keyword })
  }

  const onDelete = async (row: CustomerRow) => {
    const label = row.cusName || row.cusCode
    /*
     * 삭제는 되돌릴 수 없는 것처럼 묻는다 — 실제로는 서버가 `deleted` 플래그만 세우지만
     * (neotms.api.ts 주석), 화면에 복구 수단이 없으므로 사용자 입장에서는 영구 삭제다.
     * "복구할 수 있습니다" 라고 쓰면 가볍게 누르고, 복구를 요청할 곳이 없다.
     */
    if (!window.confirm(`${label} 고객사를 삭제할까요?\n이 화면에서는 되돌릴 수 없습니다.`)) return
    await deleteCustomer.mutateAsync(row.id)
    setNotice(`${label} 고객사를 삭제했습니다.`)
  }

  return (
    <div className={ui.page}>
      {/* 제목은 셸의 경로 표시줄이 들고 있다 — NeotmsApp.module.css 의 `.crumb` 주석. */}
      <div className={ui.pageBar}>
        <p className={ui.pageNote}>
          프로젝트의 매출이 귀속되는 단위입니다. 기본 통화와 기본 단가는 작업 등록 때{' '}
          <b>초기값</b>으로 쓰입니다.
        </p>
        {mayCreate ? (
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => setEditing(null)}
          >
            <Icon name="plus" size={13} />
            고객사 등록
          </button>
        ) : null}
      </div>

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}
      <ErrorNotice error={deleteCustomer.error} />

      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <span>
            {rows.length}건 표시
            {/* 전체 건수는 서버가 주지 않는다. "표시" 라고 쓰는 이유다 — "건" 만 쓰면
                사용자는 그 숫자를 전체 고객사 수로 읽는다. */}
          </span>
          <form className={ui.toolbar} onSubmit={onSearch}>
            <input
              className={`${ui.input} ${ui.searchInput}`}
              type="search"
              placeholder="고객사명 · 이메일 · 분야"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            <button type="submit" className={ui.btn}>
              조회
            </button>
            {filters.q ? (
              <button
                type="button"
                className={`${ui.btn} ${ui.btnGhost}`}
                onClick={() => {
                  setKeyword('')
                  setFilters({ q: '' })
                }}
              >
                검색 해제
              </button>
            ) : null}
          </form>
        </div>

        <div className={`${ui.cardBodyFlush} ${ui.tableWrap}`}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>코드</th>
                <th>고객사명</th>
                <th>연락처</th>
                <th>국가 · 통화</th>
                {/* 사용 프로그램(cusUpro) 열은 없앴다. 등록 화면에서 묻지 않는 값이므로
                    ETL 로 적재된 고객사만 값이 있고, 직접 등록한 고객사는 모두 '-' 가 된다 —
                    그런 열은 읽는 사람에게 "비어 있다"가 아니라 "고장났다"로 보인다. */}
                <th>최소 수주</th>
                <th>분야</th>
                <th>상태</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <TableState
                isLoading={customersQuery.isLoading}
                error={customersQuery.error}
                isEmpty={rows.length === 0}
                emptyText={
                  filters.q
                    ? `'${filters.q}' 로 찾은 고객사가 없습니다.`
                    : '등록된 고객사가 없습니다.'
                }
                colSpan={8}
              />
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className={ui.cellMono}>{row.cusCode}</td>
                  <td>{row.cusName || '-'}</td>
                  <td className={ui.cellMuted}>
                    {row.cusEmail ? <div>{row.cusEmail}</div> : null}
                    {row.cusPhone ? <div>{row.cusPhone}</div> : null}
                    {!row.cusEmail && !row.cusPhone ? '-' : null}
                  </td>
                  <td className={ui.cellMuted}>
                    {[row.cusNation, row.cusCoin].filter(Boolean).join(' · ') || '-'}
                  </td>
                  {/* 최소 수주 금액에는 통화를 붙인다. 같은 열에 USD 와 KRW 가 섞인다. */}
                  <td>
                    <Amount value={row.cusMincost} coinCode={row.cusCoin} />
                  </td>
                  <td className={ui.cellClamp}>{row.cusField || '-'}</td>
                  <td>
                    <ActiveChip active={row.active} on="거래 중" off="거래 종료" />
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
                          disabled={deleteCustomer.isPending}
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
          hasNextPage={!!customersQuery.hasNextPage}
          isFetchingNextPage={customersQuery.isFetchingNextPage}
          onClick={() => void customersQuery.fetchNextPage()}
        />
      </div>

      {/*
       * `editing` 의 세 상태를 구분한다: `undefined` 는 닫힘, `null` 은 신규, 값이 있으면 수정.
       * null 하나로 닫힘과 신규를 겸하게 만들면 신규 등록 모달을 열 수 없다.
       */}
      {editing !== undefined ? (
        <CustomerFormModal
          customer={editing}
          onClose={() => setEditing(undefined)}
          onSaved={setNotice}
        />
      ) : null}
    </div>
  )
}
