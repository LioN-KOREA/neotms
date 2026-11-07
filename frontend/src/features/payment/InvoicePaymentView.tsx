import { useMemo, useState, type FormEvent } from 'react'
import { useInvoices, useProfile } from '@/apis/queries/neotms.query'
import { useDeleteInvoice } from '@/apis/queries/neotms.mutation'
import { codeOptions, COIN_CODES, INVOICE_STATES, MONEY_STATES } from '@/apis/neotms.codes'
import type { InvoiceRow } from '@/apis/neotms.types'
import { LIST_PAGE_SIZE, NeotmsMenuId } from '@/shared/config'
import { useUrlFilters } from '@/shared/hooks/useUrlFilters'
import { mayDo } from '@/shared/permissions'
import { Amount } from '@/shared/ui/Amount'
import { ErrorNotice, LoadMore, SuccessNotice, TableState } from '@/shared/ui/Feedback'
import { Icon } from '@/shared/ui/Icon'
import { StatusChip } from '@/shared/ui/StatusChip'
import { dateKstOffsetDays, formatDate } from '@/shared/utils/format'
import { decimalSum } from '@/shared/utils/money'
import ui from '@/shared/ui/ui.module.css'
import { InvoiceFormModal } from './InvoiceFormModal'
import { InvoicePrintModal } from './print/InvoicePrintModal'

/**
 * 결제 — 번역가 인보이스. 청구서 한 장이 한 행이다.
 *
 * ## 두 금액이 나란히 서 있는 것이 이 표의 요점이다
 *
 * `invSum`(청구액)은 **번역가가 종이에 적어 보낸 숫자**이고, `poSum`(PO 합계)은 **우리 PO가
 * 말하는 금액**이다. 둘은 달라도 되고, 실제로 환율·원천징수·협의 때문에 다르다. 그래서 둘 중
 * 하나를 다른 쪽에서 계산해 내지 않고 양쪽을 다 적는다 — 한쪽만 보여 주면 그 차이는 아무 화면에도
 * 나타나지 않고, 차이를 발견하는 시점은 번역가가 "덜 받았다" 고 연락하는 때가 된다.
 *
 * `poCount` 를 같이 적는 이유도 같다. PO 네 건을 묶어 보낸 인보이스가 세 건만 연결된 채
 * 저장될 수는 없지만(서버가 전부 아니면 전무로 처리한다), 나중에 PO 하나를 떼어내는 수정은
 * 가능하다. 그때 "4건" 이 "3건" 으로 바뀌는 것이 이 열이 하는 유일한 일이고, 그게 필요한 일이다.
 *
 * ## 삭제는 취소(void)다
 *
 * 인보이스를 지우면 그 인보이스에 묶여 있던 PO들이 **다시 청구 가능한 상태로 돌아온다**(서버가
 * 같은 트랜잭션에서 떼어낸다). 잘못 발행한 인보이스를 고치는 정상적인 방법이 그것이다 — 번역가를
 * 바꾸는 수정을 허용하지 않는 것과 같은 판단이고, `InvoiceFormModal` 의 안내가 사용자를 여기로
 * 보낸다.
 *
 * ## 기본 조건: 발행일 오늘 ±30일, 나머지는 전체
 *
 * 발행 상태·지급·통화는 전부 '전체' 로 연다 — 인보이스는 PO보다 훨씬 적고(PO 여러 건이 한 장이
 * 된다), 이 화면에서 찾는 것은 보통 "이번 달에 발행한 것들" 이다. 기간만 잘라 두면 그 질문에
 * 바로 답하면서도 전 기간을 읽지 않는다.
 *
 * 기본값을 **화면 단위**로 적용하는 규칙과 '전체' 가 빈 문자열이 아닌 이유는 PO 화면과 같다 —
 * `PoPaymentView` 의 머리글에 한 번만 적어 두었다.
 */

const FILTER_KEYS = ['q', 'state', 'money', 'coin', 'basis', 'from', 'to'] as const

/** '전체' 를 나타내는 주소 값. `PoPaymentView` 의 `FILTER_ALL` 과 같은 이유로 빈 값이 아니다. */
const FILTER_ALL = 'all'

/**
 * 기간을 **어느 날짜에** 걸 것인가. 서버는 발행일 범위와 지급일 범위를 AND 로 묶으므로 한 쌍만
 * 보낸다 — `InvoiceListQuery` 와 `PoPaymentView` 의 `PERIOD_BASES` 주석이 근거다.
 */
const PERIOD_BASES = [
  { value: 'issued', label: '발행일' },
  { value: 'paid', label: '지급일' },
  { value: FILTER_ALL, label: '전체 기간' },
] as const

/** 모듈 상수여야 하는 이유는 `PoPaymentView` 의 같은 상수와 같다 — 캐시 키가 흔들리면 안 된다. */
const DEFAULT_FROM = dateKstOffsetDays(-30)
const DEFAULT_TO = dateKstOffsetDays(30)

/**
 * 발행일 기준인데도 **앞뒤 30일**인 것이 의도다. 발행일은 과거일 수밖에 없어 보이지만, 지급
 * 예정일에 맞춰 날짜를 적어 미리 등록해 둔 인보이스가 실제로 있다. 뒤쪽을 자르면 그 행들이
 * 화면에서 사라지고, 사라진 이유는 아무 데도 적혀 있지 않다.
 */
const DEFAULTS = {
  q: '',
  state: '',
  money: '',
  coin: '',
  basis: 'issued',
  from: DEFAULT_FROM,
  to: DEFAULT_TO,
}

export function InvoicePaymentView() {
  const { data: profile } = useProfile()
  const { filters, setFilters, resetFilters, activeCount } = useUrlFilters(FILTER_KEYS)

  /*
   * 이 화면이 보는 동작은 셋이다 — `create` 가 인보이스 발행, `update` 가 수정, `delete` 가 취소.
   * PO 화면과 같은 `PAYMENT` 메뉴를 쓰고, 다섯 동작이 두 화면의 권한을 가른다(permissions.ts).
   */
  const mayCreate = mayDo(profile, NeotmsMenuId.PAYMENT, 'create')
  const mayUpdate = mayDo(profile, NeotmsMenuId.PAYMENT, 'update')
  const mayDelete = mayDo(profile, NeotmsMenuId.PAYMENT, 'delete')

  /** 주소에 조건이 하나도 없을 때만 기본값 — `PoPaymentView` 의 '기본값' 절 참고. */
  const pristine = activeCount === 0
  const chosen = pristine
    ? DEFAULTS
    : {
        q: filters.q,
        state: filters.state,
        money: filters.money,
        coin: filters.coin,
        basis: filters.basis || DEFAULTS.basis,
        from: filters.from,
        to: filters.to,
      }

  const onIssued = chosen.basis === 'issued'
  const onPaid = chosen.basis === 'paid'

  const [draft, setDraft] = useState(chosen)
  const [editing, setEditing] = useState<InvoiceRow | null | undefined>(undefined)
  /** 명세를 인쇄 중인 인보이스. `editing` 과 달리 '신규' 가 없으므로 `null` 이 곧 닫힌 상태다. */
  const [printing, setPrinting] = useState<InvoiceRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /** 뒤집힌 기간은 막지 않고 알린다 — `PoPaymentView` 의 같은 경고와 같은 이유다. */
  const rangeReversed = !!draft.from && !!draft.to && draft.from > draft.to

  const invoicesQuery = useInvoices({
    limit: LIST_PAGE_SIZE,
    q: chosen.q || undefined,
    invState: chosen.state || undefined,
    moneyState: chosen.money || undefined,
    coinCode: chosen.coin || undefined,
    issuedFrom: onIssued ? chosen.from || undefined : undefined,
    issuedTo: onIssued ? chosen.to || undefined : undefined,
    paidFrom: onPaid ? chosen.from || undefined : undefined,
    paidTo: onPaid ? chosen.to || undefined : undefined,
  })
  const removeInvoice = useDeleteInvoice()

  const rows = useMemo(
    () => invoicesQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [invoicesQuery.data],
  )

  /**
   * 표시된 인보이스의 PO 원가 합계. **청구액이 아니라 PO 합계를 더한다** — 청구액은 통화가
   * 섞여 있을 수 있고(번역가마다 다르다), 서로 다른 통화의 숫자를 더한 값은 아무 뜻도 없다.
   * `poKsum` 은 서버가 원화로 환산해 둔 값이라 더할 수 있다.
   */
  const cost = useMemo(() => decimalSum(rows.map((r) => r.poKsum)), [rows])

  const onSearch = (e: FormEvent) => {
    e.preventDefault()
    setFilters(draft)
  }

  /** '기본 조건으로' — `PoPaymentView` 의 `onReset` 과 같은 뜻이다. */
  const onReset = () => {
    setDraft(DEFAULTS)
    resetFilters()
  }

  const onDelete = async (row: InvoiceRow) => {
    if (
      !window.confirm(
        `인보이스 ${row.invTranCode} 를 삭제할까요?\n\n` +
          `이 인보이스에 묶인 PO ${row.poCount}건은 다시 청구 가능한 상태로 돌아갑니다. ` +
          'PO 자체는 지워지지 않습니다.',
      )
    ) {
      return
    }
    await removeInvoice.mutateAsync(row.id)
    setNotice(
      `인보이스 ${row.invTranCode} 를 삭제했습니다. 묶여 있던 PO ${row.poCount}건을 다시 청구할 수 있습니다.`,
    )
  }

  return (
    <div className={ui.page}>
      {/* 제목은 셸의 경로 표시줄이 들고 있다 — NeotmsApp.module.css 의 `.crumb` 주석. */}
      <div className={ui.pageBar}>
        <p className={ui.pageNote}>
          번역가가 보낸 청구서 한 장이 한 행입니다. 한 장에 <b>여러 PO</b>를 묶을 수 있습니다.
          기본 조건은 <b>발행일 오늘 ±30일</b>입니다.
        </p>
        {mayCreate ? (
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => setEditing(null)}
          >
            <Icon name="plus" size={13} />
            인보이스 발행
          </button>
        ) : null}
      </div>

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}
      <ErrorNotice error={removeInvoice.error} />

      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <span>{rows.length}건 표시</span>
          <span className={ui.spacer} />
          <span className={ui.hint}>
            표시된 {cost.counted}건 PO 원가 합계 <Amount value={cost.total} kind="cost" />
          </span>
        </div>

        <form className={ui.filterBar} onSubmit={onSearch}>
          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="inv-q">
              검색어
            </label>
            <input
              id="inv-q"
              className={`${ui.input} ${ui.searchInput}`}
              type="search"
              placeholder="인보이스 코드 · 번역가"
              value={draft.q}
              onChange={(e) => setDraft((p) => ({ ...p, q: e.target.value }))}
            />
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="inv-f-state">
              발행 상태
            </label>
            <select
              id="inv-f-state"
              className={ui.select}
              value={draft.state}
              onChange={(e) => setDraft((p) => ({ ...p, state: e.target.value }))}
            >
              <option value="">전체</option>
              {codeOptions(INVOICE_STATES, draft.state).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="inv-f-money">
              지급
            </label>
            <select
              id="inv-f-money"
              className={ui.select}
              value={draft.money}
              onChange={(e) => setDraft((p) => ({ ...p, money: e.target.value }))}
            >
              <option value="">전체</option>
              {codeOptions(MONEY_STATES, draft.money).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="inv-f-coin">
              통화
            </label>
            <select
              id="inv-f-coin"
              className={ui.select}
              value={draft.coin}
              onChange={(e) => setDraft((p) => ({ ...p, coin: e.target.value }))}
            >
              <option value="">전체</option>
              {codeOptions(COIN_CODES, draft.coin).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="inv-f-basis">
              기간 기준
            </label>
            <select
              id="inv-f-basis"
              className={ui.select}
              value={draft.basis}
              onChange={(e) => setDraft((p) => ({ ...p, basis: e.target.value }))}
            >
              {PERIOD_BASES.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>

          {/* '전체 기간' 이면 날짜 칸을 그리지 않는다 — `PoPaymentView` 의 같은 자리 주석 참고. */}
          {draft.basis === FILTER_ALL ? null : (
            <div className={ui.filterField}>
              <label className={ui.label} htmlFor="inv-f-from">
                {draft.basis === 'paid' ? '지급일' : '발행일'} 범위
              </label>
              <div className={ui.inputRow}>
                <input
                  id="inv-f-from"
                  className={ui.input}
                  type="date"
                  value={draft.from}
                  onChange={(e) => setDraft((p) => ({ ...p, from: e.target.value }))}
                />
                <input
                  className={ui.input}
                  type="date"
                  aria-label={`${draft.basis === 'paid' ? '지급일' : '발행일'} 종료`}
                  value={draft.to}
                  onChange={(e) => setDraft((p) => ({ ...p, to: e.target.value }))}
                />
              </div>
            </div>
          )}

          <div className={ui.spacer} />

          <button type="submit" className={`${ui.btn} ${ui.btnPrimary}`}>
            조회
          </button>
          {activeCount > 0 ? (
            <button type="button" className={`${ui.btn} ${ui.btnGhost}`} onClick={onReset}>
              기본 조건으로 ({activeCount})
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
                <th>번역가</th>
                <th>발행일</th>
                <th>PO</th>
                <th>청구액</th>
                <th>PO 원가(원화)</th>
                <th>지급 예정</th>
                <th>발행</th>
                <th>지급</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <TableState
                isLoading={invoicesQuery.isLoading}
                error={invoicesQuery.error}
                isEmpty={rows.length === 0}
                emptyText={
                  pristine
                    ? '발행일이 오늘 ±30일인 인보이스가 없습니다. 납품된 PO를 묶어 발행할 수 있습니다.'
                    : '조건에 맞는 인보이스가 없습니다.'
                }
                colSpan={10}
              />
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className={ui.cellMono}>{row.invTranCode}</td>
                  <td>{row.tranName || '(번역가 미지정)'}</td>
                  <td className={ui.cellMuted}>{formatDate(row.invDay)}</td>
                  <td className={ui.cellMuted}>{row.poCount}건</td>
                  {/*
                   * 청구액은 **인보이스의 통화로** 적는다. 원화로 환산하지 않는 이유는 그 환산이
                   * 어느 시점의 환율인지 이 행이 말할 수 없기 때문이다 — 옆 열의 원가는 서버가
                   * PO별로 환산해 둔 값이라 그 질문에 답할 수 있다.
                   */}
                  <td>
                    <Amount value={row.invSum} coinCode={row.coinCode} kind="cost" />
                  </td>
                  <td>
                    <Amount value={row.poKsum} kind="cost" />
                  </td>
                  <td className={ui.cellMuted}>{formatDate(row.invMoPday)}</td>
                  <td>
                    <StatusChip value={row.invState} />
                  </td>
                  <td>
                    <StatusChip value={row.invMoState} />
                    {row.invMoDay ? (
                      <div className={ui.cellMuted}>{formatDate(row.invMoDay)}</div>
                    ) : null}
                  </td>
                  <td>
                    <div className={ui.rowActions}>
                      {/*
                       * PO 문서 쪽과 달리 **막는 조건이 없다.** 인보이스는 발행된 것이 곧
                       * 존재하는 것이고(발행 전 인보이스라는 행이 없다), 승인에 해당하는
                       * 관문은 이미 묶인 PO들이 통과했다 — 납품된 PO만 올라올 수 있다.
                       */}
                      <button
                        type="button"
                        className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
                        onClick={() => setPrinting(row)}
                      >
                        인보이스
                      </button>
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
                          disabled={removeInvoice.isPending}
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
          hasNextPage={!!invoicesQuery.hasNextPage}
          isFetchingNextPage={invoicesQuery.isFetchingNextPage}
          onClick={() => void invoicesQuery.fetchNextPage()}
        />
      </div>

      {editing !== undefined ? (
        <InvoiceFormModal
          invoice={editing}
          onClose={() => setEditing(undefined)}
          onSaved={setNotice}
        />
      ) : null}

      {printing ? (
        <InvoicePrintModal invoice={printing} onClose={() => setPrinting(null)} />
      ) : null}
    </div>
  )
}
