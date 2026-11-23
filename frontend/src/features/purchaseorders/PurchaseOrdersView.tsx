import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useProfile, usePurchaseOrders } from '@/apis/queries/neotms.query'
import { useDeletePurchaseOrder } from '@/apis/queries/neotms.mutation'
import { codeOptions, INVOICE_STATES, MONEY_STATES, PO_STATES } from '@/apis/neotms.codes'
import type { PurchaseOrderRow } from '@/apis/neotms.types'
import { LIST_PAGE_SIZE } from '@/shared/config'
import { useUrlFilters } from '@/shared/hooks/useUrlFilters'
import { may } from '@/shared/permissions'
import {
  NEOTMS_PERMISSION_PO_CREATE,
  NEOTMS_PERMISSION_PO_DELETE,
  NEOTMS_PERMISSION_PO_EMAIL,
  NEOTMS_PERMISSION_PO_UPDATE,
} from '@/apis/neotms.authorities'
import { Amount } from '@/shared/ui/Amount'
import { ErrorNotice, LoadMore, SuccessNotice, TableState } from '@/shared/ui/Feedback'
import { Icon } from '@/shared/ui/Icon'
import { StatusChip } from '@/shared/ui/StatusChip'
import { formatDate, isOverdue } from '@/shared/utils/format'
import { decimalSum, krwToShow } from '@/shared/utils/money'
import { InlinePickerCell } from '@/shared/ui/InlineEditCell'
import { useRecentSearch } from '@/shared/hooks/useRecentSearch'
import { PoRequestMailModal } from './PoRequestMailModal'
import { RecentSearchHints } from '@/shared/ui/RecentSearchHints'
import ui from '@/shared/ui/ui.module.css'
import { PoDocButtons, type PoPrintRequest } from '@/features/payment/print/PoDocButtons'
import { PoPrintModal } from '@/features/payment/print/PoPrintModal'
import { PurchaseOrderFormModal } from './PurchaseOrderFormModal'
import {
  mayChangeTranslator,
  translatorLockReason,
  TranslatorSwapModal,
} from './TranslatorSwapModal'

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
 *
 * ## 번역가 칸만 제자리에서 고친다
 *
 * 이 화면에서 두 번 눌러 고칠 수 있는 칸은 **번역가 하나**다. 그 칸이 선택된 이유는 위 문단과
 * 같다 — 미지정 발주를 찾아 주는 화면에서 그걸 고치려면 수정 모달을 열어야 한다는 것은, 찾는
 * 일과 고치는 일을 다른 화면에 둔다는 뜻이다. 그 모달에는 환산 금액과 환율이 함께 열린다.
 *
 * 나머지 칸(납기·진행)이 프로젝트 상세에서는 제자리 수정이 되고 여기서는 아닌 것은
 * 의도다. 저쪽은 **한 프로젝트의 발주 열몇 건**을 훑으며 손보는 화면이고, 여기는 **전체 발주를
 * 조건으로 걸러 보는** 화면이다. 거른 결과를 고치면 그 행이 조건에서 빠져 눈앞에서 사라지므로
 * (진행을 '완료' 로 바꾸면 진행=진행중 필터에서 빠진다), 여기서의 제자리 수정은 "방금 무엇을
 * 고쳤는지" 를 화면에서 지운다. 번역가는 필터 대상이 아니므로 그 문제가 없다.
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
  /** 지금 뽑으려는 PO 문서와 그 서식. 모달은 화면 밑단에 하나만 둔다 — `PoDocButtons` 주석. */
  const [printing, setPrinting] = useState<PoPrintRequest | null>(null)
  /** 번역가를 바꾸려고 연 발주. `printing` 과 같은 이유로 행이 아니라 화면이 들고 있다. */
  const [swapping, setSwapping] = useState<PurchaseOrderRow | null>(null)

  const posQuery = usePurchaseOrders({
    limit: LIST_PAGE_SIZE,
    q: filters.q || undefined,
    state: filters.state || undefined,
    invoiceState: filters.invoiceState || undefined,
    moneyState: filters.moneyState || undefined,
  })
  const deletePo = useDeletePurchaseOrder()

  const rows = useMemo(() => posQuery.data?.pages.flatMap((p) => p.items) ?? [], [posQuery.data])

  /**
   * 화면에 올라온 행들의 원화 환산 원가 합계. 전체 합계가 아니라는 사실을 라벨에 쓴다.
   *
   * 저장된 금액이 아니라 **지금 시점의 가치**를 더한다 — 이유는 `krwToShow` 에 적혀 있다.
   */
  const cost = useMemo(
    () => decimalSum(rows.map((r) => krwToShow(r.poPriceKrw, r.poPriceKsum))),
    [rows],
  )

  const mayCreate = may(profile, NEOTMS_PERMISSION_PO_CREATE)
  const mayUpdate = may(profile, NEOTMS_PERMISSION_PO_UPDATE)
  const mayDelete = may(profile, NEOTMS_PERMISSION_PO_DELETE)

  // 이 화면의 최근 검색어. scope 는 이 화면의 라우트 경로다.
  const recent = useRecentSearch('purchase-orders')
  const [mailing, setMailing] = useState<PurchaseOrderRow | null>(null)
  /*
   * 의뢰 메일을 보낼 수 있는가. 수정 권한과 별개다 — 발주서를 고치는 일과 회사 밖으로 파일을
   * 내보내는 일은 다른 결정이고, 그래서 `NEOTMS_PERMISSION_PO_EMAIL` 이 따로 있다. 이 권한은
   * 기능이 없던 동안 아무에게도 부여되지 않았으므로, 처음 쓰려면 역할 관리에서 켜야 한다.
   */
  const mayMail = may(profile, NEOTMS_PERMISSION_PO_EMAIL)

  const onSearch = (e: FormEvent) => {
    e.preventDefault()
    // 제출이 곧 '이 말로 검색하겠다' 다. 입력 중에 기록하면 한 단어의 접두사들이
    // 다섯 칸을 모두 차지한다 — useRecentSearch 의 주석 참고.
    recent.record(draft.q)
    setFilters(draft)
  }

  const onReset = () => {
    setDraft({ q: '', state: '', invoiceState: '', moneyState: '' })
    resetFilters()
  }

  const onDelete = async (row: PurchaseOrderRow) => {
    // PO명 은 화면에서 빠졌으므로 코드가 그 PO를 가리키는 유일한 이름이다.
    const label = row.poCode
    if (
      !window.confirm(
        `${label} PO를 삭제할까요?`,
      )
    ) {
      return
    }
    await deletePo.mutateAsync(row.id)
    setNotice(`PO [${label}]를 삭제했습니다.`)
  }

  return (
    <div className={ui.page}>
      {/* 제목은 셸의 경로 표시줄이 들고 있다 — NeotmsApp.module.css 의 `.crumb` 주석. */}
      <div className={ui.pageBar}>
        <p className={ui.pageNote}>
          작업을 번역가에게 맡긴 건입니다. 원화 환산 합계가 이 시스템의 <b>원가</b>입니다.
        </p>
        {mayCreate ? (
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => setEditing(null)}
          >
            <Icon name="plus" size={13} />
            PO 등록
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
              placeholder="코드 · 작업 · 번역가"
              value={draft.q}
              onChange={(e) => setDraft((p) => ({ ...p, q: e.target.value }))}
              list="of-q-recent"
              autoComplete="off"
            />
            <RecentSearchHints id="of-q-recent" recent={recent} />
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
                <th>작업 · 프로젝트</th>
                <th>번역가</th>
                <th>물량 · 단가</th>
                <th>원가(원화)</th>
                <th>마감일</th>
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
                    ? '조건에 맞는 PO가 없습니다.'
                    : '등록된 PO가 없습니다.'
                }
                colSpan={9}
              />
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className={ui.cellMono}>{row.poCode}</td>
                  <td className={ui.cellMuted}>
                    <div>{row.jobName || row.jobCode || '-'}</div>
                    <div>
                      <Link className={ui.btnLink} to={`/projects/${row.projectId}`}>
                        {row.prjName || row.prjCode || '프로젝트'}
                      </Link>
                    </div>
                  </td>
                  {/*
                   * 두 번 눌러 번역가를 바꾼다. 비활성 조건과 그 이유는 `TranslatorSwapModal` 이
                   * 들고 있다 — 이 칸과 대화상자가 **같은 함수**로 판단해야 "눌리는데 저장이
                   * 안 된다" 가 생기지 않는다.
                   */}
                  <InlinePickerCell
                    editable={mayUpdate && !deletePo.isPending && mayChangeTranslator(row)}
                    title={translatorLockReason(row) ?? '두 번 눌러 번역가 변경'}
                    onOpen={() => setSwapping(row)}
                  >
                    {row.poTranName ? (
                      row.poTranName
                    ) : (
                      // 지급 대상이 없는 발주. 위 주석 참고.
                      <span className={`${ui.badge} ${ui.badgeWarn}`}>미지정</span>
                    )}
                  </InlinePickerCell>
                  {/*
                   * 물량/단가. **비언어 발주에서는 두 줄 모두 `-` 다.** 분기를 쓰지 않은 것이
                   * 아니라, 분기가 필요 없다 — 네 값 모두 `po_detail_linguistic` 의 컬럼이므로
                   * (db/012_job_pricing.sql) MICE·IMC 발주에는 그 행이 없고 서버가 null 을
                   * 돌려준다. 그 발주의 금액은 다음 열(원가)에 있다.
                   */}
                  <td className={ui.cellMuted}>
                    <div>
                      {row.poVolume ?? '-'} {row.poUnitCode ?? ''}
                    </div>
                    <div>
                      <Amount value={row.poPrice} coinCode={row.poCoinCode} />
                    </div>
                  </td>
                  <td>
                    <Amount value={krwToShow(row.poPriceKrw, row.poPriceKsum)} kind="cost" />
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
                    <StatusChip value={row.poState} />
                  </td>
                  <td>
                    <StatusChip value={row.poMoneyState} />
                    {row.poMoneyDay ? (
                      <div className={ui.cellMuted}>{formatDate(row.poMoneyDay)}</div>
                    ) : null}
                  </td>
                  <td>
                    <div className={ui.rowActions}>
                      {/*
                       * 국 / 영 두 버튼. 레거시 PO 목록의 두 링크를 되돌린 것이고, 미승인
                       * PO 에서 비활성인 이유까지 전부 `PoDocButtons` 에 적혀 있다.
                       */}
                      <PoDocButtons po={row} onPick={setPrinting} />
                      {mayMail ? (
                        <button
                          type="button"
                          className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
                          onClick={() => setMailing(row)}
                          /*
                           * 미승인 PO 에서는 누를 수 없다. 출력 버튼과 같은 규칙이고
                           * (`PoDocButtons`), 이유도 같다 — 승인이 금액을 확정하는 행위이고,
                           * 이 메일은 그 금액의 일을 시작하라고 번역가에게 알리는 것이다.
                           */
                          disabled={!row.poApproved}
                          title={
                            row.poApproved
                              ? '번역가에게 의뢰 메일을 보냅니다.'
                              : '승인된 PO 만 의뢰 메일을 보낼 수 있습니다.'
                          }
                        >
                          의뢰메일
                        </button>
                      ) : null}
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

      {mailing ? (
        <PoRequestMailModal
          po={mailing}
          onClose={() => setMailing(null)}
          onSent={setNotice}
        />
      ) : null}

      {printing ? (
        <PoPrintModal
          po={printing.po}
          lang={printing.lang}
          onClose={() => setPrinting(null)}
        />
      ) : null}

      {swapping ? (
        <TranslatorSwapModal
          purchaseOrder={swapping}
          onClose={() => setSwapping(null)}
          onSaved={setNotice}
        />
      ) : null}
    </div>
  )
}
