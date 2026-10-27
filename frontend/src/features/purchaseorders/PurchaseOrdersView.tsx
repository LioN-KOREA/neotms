import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useProfile, usePurchaseOrders } from '@/apis/queries/neotms.query'
import { useDeletePurchaseOrder } from '@/apis/queries/neotms.mutation'
import { codeOptions, INVOICE_STATES, MONEY_STATES, PO_STATES } from '@/apis/neotms.codes'
import type { PurchaseOrderRow } from '@/apis/neotms.types'
import { LIST_PAGE_SIZE, NeotmsMenuId } from '@/shared/config'
import { useUrlFilters } from '@/shared/hooks/useUrlFilters'
import { mayDo } from '@/shared/permissions'
import { Amount } from '@/shared/ui/Amount'
import { ErrorNotice, LoadMore, SuccessNotice, TableState } from '@/shared/ui/Feedback'
import { formatDate, isOverdue } from '@/shared/utils/format'
import { decimalSum } from '@/shared/utils/money'
import ui from '@/shared/ui/ui.module.css'
import { PurchaseOrderFormModal } from './PurchaseOrderFormModal'

/**
 * 발주 목록. **이 화면의 금액이 원가다.**
 *
 * ## 지급 상태가 이 화면의 존재 이유다
 *
 * 번역가는 외부 거래처이고, 지급이 늦으면 다음 일을 받아 주지 않는다. 레거시에서 지급 누락을
 * 찾는 방법은 엑셀로 내려서 필터를 거는 것이었다 — 그래서 지급 상태·지급일 열을 세우고,
 * 미정산을 경고색으로 칠한다.
 *
 * ## 번역가가 비어 있는 발주를 드러낸다
 *
 * 번역가 없이 발주를 만들 수 있다(단가 협의 중인 상태). 그 상태로 잊히면 원가는 잡혀 있는데
 * 지급 대상이 없는 행이 남으므로, 목록에서 바로 보이게 한다.
 */

const FILTER_KEYS = ['q', 'state', 'invoiceState', 'moneyState'] as const

export function PurchaseOrdersView() {
  const { data: profile } = useProfile()
  const { filters, setFilters, resetFilters, activeCount } = useUrlFilters(FILTER_KEYS)

  const [draft, setDraft] = useState({
    q: filters.q,
    state: filters.state,
    invoiceState: filters.invoiceState,
    moneyState: filters.moneyState,
  })
  const [editing, setEditing] = useState<PurchaseOrderRow | null | undefined>(undefined)
  const [notice, setNotice] = useState<string | null>(null)

  const posQuery = usePurchaseOrders({
    limit: LIST_PAGE_SIZE,
    q: filters.q || undefined,
    state: filters.state || undefined,
    invoiceState: filters.invoiceState || undefined,
    moneyState: filters.moneyState || undefined,
  })
  const deletePo = useDeletePurchaseOrder()

  const rows = useMemo(() => posQuery.data?.pages.flatMap((p) => p.items) ?? [], [posQuery.data])

  /** 화면에 올라온 행들의 원화 환산 원가 합계. 전체 합계가 아니라는 사실을 라벨에 쓴다. */
  const cost = useMemo(() => decimalSum(rows.map((r) => r.poPriceKsum)), [rows])

  const mayCreate = mayDo(profile, NeotmsMenuId.PURCHASE_ORDER, 'create')
  const mayUpdate = mayDo(profile, NeotmsMenuId.PURCHASE_ORDER, 'update')
  const mayDelete = mayDo(profile, NeotmsMenuId.PURCHASE_ORDER, 'delete')

  const onSearch = (e: FormEvent) => {
    e.preventDefault()
    setFilters(draft)
  }

  const onReset = () => {
    setDraft({ q: '', state: '', invoiceState: '', moneyState: '' })
    resetFilters()
  }

  const onDelete = async (row: PurchaseOrderRow) => {
    const label = row.poName || row.poCode
    if (
      !window.confirm(
        `${label} 발주를 삭제할까요?\n이 발주의 원가가 집계에서 빠지고, 해당 작업의 마진이 올라갑니다.`,
      )
    ) {
      return
    }
    await deletePo.mutateAsync(row.id)
    setNotice(`${label} 발주를 삭제했습니다.`)
  }

  return (
    <div className={ui.page}>
      <div className={ui.pageHead}>
        <div>
          <h1 className={ui.pageTitle}>발주</h1>
          <p className={ui.pageHint}>
            작업을 번역가에게 맡긴 건입니다. 원화 환산 합계가 이 시스템의 원가입니다.
          </p>
        </div>
        {mayCreate ? (
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => setEditing(null)}
          >
            발주 등록
          </button>
        ) : null}
      </div>

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}
      <ErrorNotice error={deletePo.error} />

      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <span>{rows.length}건 표시</span>
          <span className={ui.spacer} />
          <span className={ui.hint}>
            표시된 {cost.counted}건 원가 합계 <Amount value={cost.total} kind="cost" />
            {cost.skipped > 0 ? ` · 금액 미입력 ${cost.skipped}건 제외` : ''}
          </span>
        </div>

        <form className={ui.filterBar} onSubmit={onSearch}>
          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="of-q">
              검색어
            </label>
            <input
              id="of-q"
              className={`${ui.input} ${ui.searchInput}`}
              type="search"
              placeholder="발주명 · 코드 · 작업 · 번역가"
              value={draft.q}
              onChange={(e) => setDraft((p) => ({ ...p, q: e.target.value }))}
            />
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="of-state">
              진행 상태
            </label>
            <select
              id="of-state"
              className={ui.select}
              value={draft.state}
              onChange={(e) => setDraft((p) => ({ ...p, state: e.target.value }))}
            >
              <option value="">전체</option>
              {codeOptions(PO_STATES, draft.state).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="of-invoice">
              계산서
            </label>
            <select
              id="of-invoice"
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
            <label className={ui.label} htmlFor="of-money">
              지급
            </label>
            <select
              id="of-money"
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
                <th>발주명</th>
                <th>작업 · 프로젝트</th>
                <th>번역가</th>
                <th>물량 · 단가</th>
                <th>원가(원화)</th>
                <th>납기</th>
                <th>진행</th>
                <th>지급</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <TableState
                isLoading={posQuery.isLoading}
                error={posQuery.error}
                isEmpty={rows.length === 0}
                emptyText={
                  activeCount > 0
                    ? '조건에 맞는 발주가 없습니다.'
                    : '등록된 발주가 없습니다. 발주는 작업에 달립니다 — 작업을 먼저 등록합니다.'
                }
                colSpan={10}
              />
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className={ui.cellMono}>{row.poCode}</td>
                  <td>{row.poName || '(이름 없음)'}</td>
                  <td className={ui.cellMuted}>
                    <div>{row.jobName || row.jobCode || '-'}</div>
                    <div>
                      <Link className={ui.btnLink} to={`/projects/${row.projectId}`}>
                        {row.prjName || row.prjCode || '프로젝트'}
                      </Link>
                    </div>
                  </td>
                  <td>
                    {row.poTranName ? (
                      row.poTranName
                    ) : (
                      // 지급 대상이 없는 발주. 위 주석 참고.
                      <span className={`${ui.badge} ${ui.badgeWarn}`}>미지정</span>
                    )}
                  </td>
                  <td className={ui.cellMuted}>
                    <div>
                      {row.poVolume ?? '-'} {row.poUnitCode ?? ''}
                    </div>
                    <div>
                      <Amount value={row.poPrice} coinCode={row.poCoinCode} />
                    </div>
                  </td>
                  <td>
                    <Amount value={row.poPriceKsum} kind="cost" />
                  </td>
                  <td
                    className={
                      isOverdue(row.poEday) && row.poState !== '완료' && row.poState !== '취소'
                        ? ui.amountNeg
                        : ui.cellMuted
                    }
                  >
                    {formatDate(row.poEday)}
                    {row.poEdayTime ? <div>{row.poEdayTime}</div> : null}
                  </td>
                  <td>
                    <span className={`${ui.badge} ${row.poState === '진행' ? ui.badgePrimary : ''}`}>
                      {row.poState || '-'}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`${ui.badge} ${
                        row.poMoneyState === '정산완료'
                          ? ui.badgeSuccess
                          : row.poMoneyState === '미정산'
                            ? ui.badgeWarn
                            : ''
                      }`}
                    >
                      {row.poMoneyState || '-'}
                    </span>
                    {row.poMoneyDay ? (
                      <div className={ui.cellMuted}>{formatDate(row.poMoneyDay)}</div>
                    ) : null}
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
                          disabled={deletePo.isPending}
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
          hasNextPage={!!posQuery.hasNextPage}
          isFetchingNextPage={posQuery.isFetchingNextPage}
          onClick={() => void posQuery.fetchNextPage()}
        />
      </div>

      {editing !== undefined ? (
        <PurchaseOrderFormModal
          purchaseOrder={editing}
          onClose={() => setEditing(undefined)}
          onSaved={setNotice}
        />
      ) : null}
    </div>
  )
}
