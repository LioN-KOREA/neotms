import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useProfile, usePurchaseOrders } from '@/apis/queries/neotms.query'
import { useApprovePurchaseOrder } from '@/apis/queries/neotms.mutation'
import { codeOptions, MONEY_STATES, PO_STATES } from '@/apis/neotms.codes'
import type { PurchaseOrderRow } from '@/apis/neotms.types'
import { LIST_PAGE_SIZE, NeotmsMenuId } from '@/shared/config'
import { useUrlFilters } from '@/shared/hooks/useUrlFilters'
import { mayDo } from '@/shared/permissions'
import { Amount } from '@/shared/ui/Amount'
import { ErrorNotice, LoadMore, SuccessNotice, TableState } from '@/shared/ui/Feedback'
import { ApprovalChip, StatusChip } from '@/shared/ui/StatusChip'
import { dateKstOffsetDays, formatDate, formatDateTime } from '@/shared/utils/format'
import { decimalSum, krwToShow } from '@/shared/utils/money'
import ui from '@/shared/ui/ui.module.css'
import { PoPrintModal } from './print/PoPrintModal'
import { SettlementModal } from './SettlementModal'

/**
 * 결제 — PO 승인·정산. **승인된 PO가, 마감일 오늘 ±30일로, 조회된 채 열린다.**
 *
 * ## 기본 조건이 이 화면의 주장이다
 *
 * 다른 목록 화면은 "전체" 로 열리고 빈 표로 기다린다. 여기는 그러면 안 된다. 이 화면이 답하는
 * 질문은 "PO가 어떻게 돼 가나" 가 아니라 **"결재가 끝난 PO 가운데 지금 돈이 나갈 것이 무엇인가"**
 * 이고, 그 질문에는 두 조건이 이미 들어 있다 — 금액이 승인됐을 것, 그리고 마감이 지금 즈음일 것.
 *
 * 날짜 조건이 기본값에 **반드시** 있어야 하는 이유는 성능이다. PO는 이 시스템에서 가장 빨리
 * 쌓이는 행이고(작업 하나에 여러 건), 기간을 자르지 않은 PO 목록은 전 기간을 읽는다. 다른
 * 목록처럼 "일단 다 읽고 사용자가 좁힌다" 를 하면 첫 화면이 가장 느린 화면이 된다.
 *
 * 승인 여부의 기본값이 **승인됨**인 것은 이 화면이 결제 담당자의 책상이라는 뜻이다. 승인
 * **대기** 목록도 한 번의 선택으로 나오고, 승인을 되돌리는 일도 같은 화면에서 한다.
 *
 * ## 기본값은 "주소에 조건이 하나도 없을 때" 만 적용된다
 *
 * `useUrlFilters` 는 빈 값의 키를 주소에서 **지운다.** 그래서 기본값을 키 단위로 ("키가 없으면
 * 기본값") 읽으면, 전 기간을 보려고 날짜를 비우고 조회하는 순간 키가 사라져 기본값이 되살아난다 —
 * 화면이 방금 받은 명령을 무시하는 종류의 버그다.
 *
 * 그래서 규칙은 **화면 단위**다: 주소에 이 화면의 조건이 하나도 없으면(`activeCount === 0`)
 * 기본값으로 조회하고, 하나라도 있으면 주소를 **글자 그대로** 읽는다. 그 결과 '조건 해제' 와
 * "메뉴를 눌러 들어온 상태" 가 같은 뜻이 되고, 링크로 공유된 주소는 거기 적힌 조건대로만
 * 동작한다.
 *
 * 남은 구멍은 하나뿐이다 — '전체' 를 뜻하는 선택이 주소에서 빈 값이면 "아직 아무것도 고르지
 * 않았다" 와 같은 모습이 된다. 그래서 그 값들은 빈 문자열이 아니다(`FILTER_ALL`).
 *
 * ## 승인은 한 번 누르면 끝난다 — 확인 창이 붙는 쪽은 해제다
 *
 * 승인은 되돌릴 수 있고(`approved: false`), 멱등이다. 그러므로 확인 창은 마찰일 뿐이다. 반대로
 * 해제는 이미 번역가에게 발송된 PO 문서를 무효로 만드는 일일 수 있어서 한 번 묻는다.
 *
 * ## 정산 버튼은 승인된 PO에만 열린다
 *
 * 서버가 거절하기 때문이 아니라 순서 때문이다 — `SettlementModal` 의 같은 자리 주석 참고.
 */

const FILTER_KEYS = ['q', 'approved', 'state', 'money', 'basis', 'from', 'to'] as const

/**
 * '전체' 를 나타내는 주소 값. **빈 문자열이 아니다** — 머리글의 '기본값' 절 참고.
 *
 * 서버로 보내지 않는 값이므로 `'all'` 이 PO 상태나 지급 상태의 코드와 부딪힐 일은 없다.
 */
const FILTER_ALL = 'all'

/**
 * 날짜 범위를 **어느 날짜에** 걸 것인가.
 *
 * 서버는 마감일 범위와 지급일 범위를 **AND** 로 묶는다(`PurchaseOrderListQuery` 의 주석). 네 칸을
 * 다 채우면 "마감이 이 안이고 **그리고** 지급도 이 안인" 이라는 다른 질문이 되고, 그 질문을 하려고
 * 네 칸을 채운 사람은 없다. 그래서 `ProjectsView` 와 같은 모양으로 기준을 **하나만** 고르게 하고,
 * 고른 쪽 한 쌍만 보낸다.
 *
 * '전체 기간' 이 세 번째 선택지인 이유는 기본 기간을 **끄는** 수단이 필요하기 때문이다. 날짜 칸을
 * 비우는 것으로는 끌 수 없다 — 비우면 주소에서 키가 사라지고, 다른 조건도 없으면 기본값이
 * 돌아온다. 기준을 '전체 기간' 으로 고르면 그 선택이 주소에 글자로 남는다.
 */
const PERIOD_BASES = [
  { value: 'due', label: '마감일' },
  { value: 'paid', label: '지급일' },
  { value: FILTER_ALL, label: '전체 기간' },
] as const

/**
 * 기본 기간은 **모듈 상수**다. 렌더마다 계산하면 `usePurchaseOrders` 의 캐시 키가 매번 달라져서
 * 조회가 멈추지 않는다 — `ReportsView` 의 `DEFAULT_FROM` 과 같은 이유다.
 *
 * 앞뒤로 30일인 것은 이 범위가 **마감일**에 걸리기 때문이다. 리포트의 기본 기간은 지난 30일이지만
 * (이미 일어난 일을 센다), 지급해야 할 PO는 절반이 아직 마감 전이다. 뒤쪽 30일이 없으면 다음 주에
 * 나갈 돈이 화면에 없다.
 */
const DEFAULT_FROM = dateKstOffsetDays(-30)
const DEFAULT_TO = dateKstOffsetDays(30)

/** 메뉴를 눌러 들어왔을 때의 조건. 머리글의 '기본 조건' 절이 근거다. */
const DEFAULTS = {
  q: '',
  approved: 'true',
  state: '',
  money: '',
  basis: 'due',
  from: DEFAULT_FROM,
  to: DEFAULT_TO,
}

export function PoPaymentView() {
  const { data: profile } = useProfile()
  const { filters, setFilters, resetFilters, activeCount } = useUrlFilters(FILTER_KEYS)

  /*
   * 권한은 화면마다 한 번 읽는다. 결제의 두 화면은 같은 `PAYMENT` 메뉴를 쓰고(permissions.ts),
   * `RequireMenu` 가 이미 `read` 를 지켰으므로 여기 온 사람은 최소한 조회 권한이 있다. 이 화면이
   * 보는 동작은 `update` 하나다 — PO 승인과 입금 기록이 그것이다.
   */
  const mayWrite = mayDo(profile, NeotmsMenuId.PAYMENT, 'update')

  /**
   * 주소에 조건이 하나도 없으면 기본값으로 조회한다 — 머리글의 '기본값' 절 참고. 하나라도 있으면
   * 주소가 전부다: 비어 있는 칸은 "거르지 않는다" 라는 **사용자의 선택**이다.
   */
  const pristine = activeCount === 0
  const chosen = pristine
    ? DEFAULTS
    : {
        q: filters.q,
        /*
         * 승인 키가 없는데 다른 조건은 있는 주소(손으로 만든 링크)는 '전체' 로 읽는다. 서버의
         * 계약과 같은 방향이다 — 값이 없으면 거르지 않는다.
         */
        approved: filters.approved || FILTER_ALL,
        state: filters.state,
        money: filters.money,
        basis: filters.basis || DEFAULTS.basis,
        from: filters.from,
        to: filters.to,
      }

  /** 서버로 보내는 승인 여부. '전체' 는 **보내지 않는 것으로** 표현된다. */
  const approved = chosen.approved === FILTER_ALL ? undefined : chosen.approved
  /** 고른 기준 한 쌍만 보낸다 — 위 `PERIOD_BASES` 주석이 근거다. */
  const onDue = chosen.basis === 'due'
  const onPaid = chosen.basis === 'paid'

  const [draft, setDraft] = useState(chosen)
  const [settling, setSettling] = useState<PurchaseOrderRow | null>(null)
  /** PO 문서를 출력 중인 PO. 위 주석 참고 — 승인된 PO만 여기 들어온다. */
  const [printing, setPrinting] = useState<PurchaseOrderRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  /**
   * 뒤집힌 기간은 **막지 않고 알린다.** 서버는 `from > to` 를 빈 목록으로 돌려주고, 빈 목록은
   * "여기엔 아무것도 없다" 와 똑같이 보인다 — `ProjectsView` 의 같은 경고와 같은 이유다.
   */
  const rangeReversed = !!draft.from && !!draft.to && draft.from > draft.to

  const posQuery = usePurchaseOrders({
    limit: LIST_PAGE_SIZE,
    q: chosen.q || undefined,
    approved,
    state: chosen.state || undefined,
    moneyState: chosen.money || undefined,
    dueFrom: onDue ? chosen.from || undefined : undefined,
    dueTo: onDue ? chosen.to || undefined : undefined,
    paidFrom: onPaid ? chosen.from || undefined : undefined,
    paidTo: onPaid ? chosen.to || undefined : undefined,
  })
  const approve = useApprovePurchaseOrder()

  const rows = useMemo(() => posQuery.data?.pages.flatMap((p) => p.items) ?? [], [posQuery.data])

  /** 화면에 올라온 PO의 원가 합계. 승인 대기만 걸러 보면 "지금 결재를 기다리는 돈" 이 된다. */
  const cost = useMemo(
    () => decimalSum(rows.map((r) => krwToShow(r.poPriceKrw, r.poPriceKsum))),
    [rows],
  )

  const onSearch = (e: FormEvent) => {
    e.preventDefault()
    setFilters(draft)
  }

  /**
   * '조건 해제' 는 **기본 조건으로 되돌린다** — 빈 조건으로 가지 않는다. 주소의 키를 전부 지우면
   * 그것이 곧 "메뉴를 눌러 들어온 상태" 이고(`pristine`), 그 상태의 뜻은 이 화면에서 기본값이다.
   * 그래서 `draft` 도 같은 값으로 맞춰 둬야 한다 — 그러지 않으면 조회 결과는 기본 조건인데 필터
   * 칸은 비어 있는, 둘이 다른 말을 하는 화면이 된다.
   */
  const onReset = () => {
    setDraft(DEFAULTS)
    resetFilters()
  }

  const onApprove = async (row: PurchaseOrderRow, next: boolean) => {
    const label = row.poName || row.poCode
    if (
      !next &&
      !window.confirm(
        `${label} PO의 승인을 해제할까요?\n\n` +
          '이미 번역가에게 발송된 PO 문서라면, 해제한 사실을 따로 알려야 합니다. ' +
          '해제된 PO는 출력도 정산도 할 수 없습니다.',
      )
    ) {
      return
    }
    await approve.mutateAsync({ id: row.id, input: { approved: next } })
    setNotice(
      next
        ? `${label} PO의 금액을 승인했습니다. 이제 PO 문서를 출력해 번역가에게 보낼 수 있습니다.`
        : `${label} PO의 승인을 해제했습니다.`,
    )
  }

  return (
    <div className={ui.page}>
      {/* 제목은 셸의 경로 표시줄이 들고 있다 — NeotmsApp.module.css 의 `.crumb` 주석. */}
      <div className={ui.pageBar}>
        <p className={ui.pageNote}>
          PO 금액을 <b>승인</b>하고 지급을 기록합니다. 승인되지 않은 PO는 출력도 발송도 되지
          않습니다. 기본 조건은 <b>승인됨 · 마감일 오늘 ±30일</b>입니다.
        </p>
      </div>

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}
      <ErrorNotice error={approve.error} />

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
            <label className={ui.label} htmlFor="pay-q">
              검색어
            </label>
            <input
              id="pay-q"
              className={`${ui.input} ${ui.searchInput}`}
              type="search"
              placeholder="PO명 · 코드 · 작업 · 번역가"
              value={draft.q}
              onChange={(e) => setDraft((p) => ({ ...p, q: e.target.value }))}
            />
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="pay-approved">
              승인 여부
            </label>
            <select
              id="pay-approved"
              className={ui.select}
              value={draft.approved}
              onChange={(e) => setDraft((p) => ({ ...p, approved: e.target.value }))}
            >
              {/*
               * 값이 `'false'`·`'true'` 문자열인 것이 의도다 — `PurchaseOrderListQuery.approved`
               * 의 주석 참고. 서버는 `=== "true"` 로만 참으로 읽고, 빈 값은 "거르지 않는다" 다.
               */}
              <option value={FILTER_ALL}>전체</option>
              <option value="false">승인 대기</option>
              <option value="true">승인됨</option>
            </select>
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="pay-state">
              진행 상태
            </label>
            <select
              id="pay-state"
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
            <label className={ui.label} htmlFor="pay-money">
              지급
            </label>
            <select
              id="pay-money"
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
            <label className={ui.label} htmlFor="pay-basis">
              기간 기준
            </label>
            <select
              id="pay-basis"
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

          {/*
           * 기준이 '전체 기간' 이면 날짜 칸을 **그리지 않는다.** 비활성으로 남겨 두면 값은 보이는데
           * 조회에는 쓰이지 않는 칸이 되고, 그 칸을 고치는 사람은 아무 일도 일어나지 않는 이유를
           * 알 수 없다.
           */}
          {draft.basis === FILTER_ALL ? null : (
            <div className={ui.filterField}>
              <label className={ui.label} htmlFor="pay-from">
                {draft.basis === 'paid' ? '지급일' : '마감일'} 범위
              </label>
              <div className={ui.inputRow}>
                <input
                  id="pay-from"
                  className={ui.input}
                  type="date"
                  value={draft.from}
                  onChange={(e) => setDraft((p) => ({ ...p, from: e.target.value }))}
                />
                <input
                  className={ui.input}
                  type="date"
                  aria-label={`${draft.basis === 'paid' ? '지급일' : '마감일'} 종료`}
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
                <th>PO명 · 작업</th>
                <th>번역가</th>
                <th>원가(원화)</th>
                <th>마감일</th>
                <th>진행</th>
                <th>승인</th>
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
                  /*
                   * 기본 조건으로 비어 있는 것과 사용자가 좁혀서 비어 있는 것은 **다른 소식**이다.
                   * 전자는 "지금 지급할 것이 없다" 는 정상 상태이고, 후자는 조건을 넓히면 뭔가
                   * 나올 수 있다는 뜻이다. 날짜가 기본으로 걸려 있는 화면이라 더 그렇다 — 그냥
                   * "없습니다" 만 적으면 ±30일 밖에 있는 PO가 없는 것처럼 읽힌다.
                   */
                  pristine
                    ? '마감일이 오늘 ±30일인 승인된 PO가 없습니다. 기간이나 승인 여부를 바꿔 보세요.'
                    : '조건에 맞는 PO가 없습니다.'
                }
                colSpan={9}
              />
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className={ui.cellMono}>{row.poCode}</td>
                  <td>
                    <div>{row.poName || '(이름 없음)'}</div>
                    <div className={ui.cellMuted}>
                      {row.jobName || row.jobCode || '-'}
                      {' · '}
                      <Link className={ui.btnLink} to={`/projects/${row.projectId}`}>
                        {row.prjName || row.prjCode || '프로젝트'}
                      </Link>
                    </div>
                  </td>
                  <td>
                    {row.poTranName ? (
                      row.poTranName
                    ) : (
                      /*
                       * 번역가 없는 PO. PO 목록에서는 "지급 대상이 없다" 는 경고였고,
                       * 여기서는 그보다 강하다 — 승인은 **누구에게 얼마를 주기로 한다** 는
                       * 결정이므로, 받는 사람이 비어 있으면 승인할 대상 자체가 불완전하다.
                       * 그래도 막지는 않는다: 금액은 정해졌고 사람만 나중에 정하는 순서가 실제로
                       * 있고, 막으면 그 PO는 영원히 이 목록에 남는다.
                       */
                      <span className={`${ui.badge} ${ui.badgeWarn}`}>미지정</span>
                    )}
                  </td>
                  <td>
                    <Amount value={krwToShow(row.poPriceKrw, row.poPriceKsum)} kind="cost" />
                  </td>
                  <td className={ui.cellMuted}>{formatDate(row.poEday)}</td>
                  <td>
                    <StatusChip value={row.poState} />
                  </td>
                  <td>
                    <ApprovalChip approved={row.poApproved} />
                    {/* 누가 언제 승인했는지. 승인은 책임을 지는 행위이므로 기록이 보여야 한다. */}
                    {row.poApproved && row.poApprovedAt ? (
                      <div className={ui.cellMuted}>
                        {formatDateTime(row.poApprovedAt)}
                        {row.poApprovedBy ? ` · ${row.poApprovedBy}` : ''}
                      </div>
                    ) : null}
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
                       * PO 문서 출력은 **쓰기 권한과 무관하다.** 종이를 뽑는 것은 아무것도
                       * 바꾸지 않고, 이 화면을 열 수 있는 사람은 이미 금액을 보고 있다.
                       * 승인 여부로만 막는다 — 이 화면의 머리글 주석과 승인 해제 경고문이
                       * 약속한 그대로다.
                       */}
                      <button
                        type="button"
                        className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
                        onClick={() => setPrinting(row)}
                        disabled={!row.poApproved}
                        title={
                          row.poApproved
                            ? undefined
                            : '승인되지 않은 PO는 출력할 수 없습니다.'
                        }
                      >
                        PO문서
                      </button>
                      {mayWrite ? (
                        <>
                          <button
                            type="button"
                            className={`${ui.btn} ${ui.btnSm} ${
                              row.poApproved ? ui.btnGhost : ui.btnPrimary
                            }`}
                            onClick={() => void onApprove(row, !row.poApproved)}
                            disabled={approve.isPending}
                          >
                            {row.poApproved ? '승인 해제' : '승인'}
                          </button>
                          <button
                            type="button"
                            className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
                            onClick={() => setSettling(row)}
                            disabled={!row.poApproved}
                            title={
                              row.poApproved
                                ? undefined
                                : '승인되지 않은 PO는 정산할 수 없습니다.'
                            }
                          >
                            정산
                          </button>
                        </>
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

      {settling ? (
        <SettlementModal
          purchaseOrder={settling}
          onClose={() => setSettling(null)}
          onSaved={setNotice}
        />
      ) : null}

      {printing ? (
        <PoPrintModal po={printing} onClose={() => setPrinting(null)} />
      ) : null}
    </div>
  )
}
