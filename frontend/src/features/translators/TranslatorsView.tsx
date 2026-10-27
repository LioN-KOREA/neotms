import { useMemo, useState, type FormEvent } from 'react'
import { useProfile, useTranslators } from '@/apis/queries/neotms.query'
import { useDeleteTranslator } from '@/apis/queries/neotms.mutation'
import { codeOptions, COIN_CODES } from '@/apis/neotms.codes'
import type { TranslatorRow } from '@/apis/neotms.types'
import { LIST_PAGE_SIZE, NeotmsMenuId } from '@/shared/config'
import { useUrlFilters } from '@/shared/hooks/useUrlFilters'
import { mayDo } from '@/shared/permissions'
import { ErrorNotice, LoadMore, SuccessNotice, TableState } from '@/shared/ui/Feedback'
import ui from '@/shared/ui/ui.module.css'
import { TranslatorFormModal } from './TranslatorFormModal'

/**
 * 번역가 목록.
 *
 * ## 이 화면의 용도는 "검색" 이다
 *
 * 다른 목록은 "최근 것부터 훑어본다" 가 기본 동작이지만, 번역가 목록은 거의 항상 **배정할
 * 사람을 찾기 위해** 열린다 — 이 분야를 할 수 있고, 이 등급이고, 이 통화로 정산하는 사람.
 * 그래서 서버의 facet 필터(`field`·`upro`·`coin`·`workCon`)를 그대로 필터 바로 올린다. 이 네
 * 컬럼에는 복합 인덱스가 있다(db/003_indexes.sql 의 `ix_tran_facet`).
 *
 * 분야·등급은 `sys_code` 코드값이고 코드 목록 엔드포인트가 아직 없으므로 자유 입력이다. 검색
 * 조건이므로 틀린 값을 넣어도 결과가 비는 것뿐이고, 저장과 달리 위험하지 않다.
 */

const FILTER_KEYS = ['q', 'field', 'upro', 'coin'] as const

export function TranslatorsView() {
  const { data: profile } = useProfile()
  const { filters, setFilters, resetFilters, activeCount } = useUrlFilters(FILTER_KEYS)

  /** 입력 중인 값. 주소로 옮기는 것은 '조회' 를 누를 때만 한다. */
  const [draft, setDraft] = useState({
    q: filters.q,
    field: filters.field,
    upro: filters.upro,
    coin: filters.coin,
  })
  const [editing, setEditing] = useState<TranslatorRow | null | undefined>(undefined)
  const [notice, setNotice] = useState<string | null>(null)

  const translatorsQuery = useTranslators({
    limit: LIST_PAGE_SIZE,
    q: filters.q || undefined,
    field: filters.field || undefined,
    upro: filters.upro || undefined,
    coin: filters.coin || undefined,
  })
  const deleteTranslator = useDeleteTranslator()

  const rows = useMemo(
    () => translatorsQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [translatorsQuery.data],
  )

  const mayCreate = mayDo(profile, NeotmsMenuId.TRANSLATOR, 'create')
  const mayUpdate = mayDo(profile, NeotmsMenuId.TRANSLATOR, 'update')
  const mayDelete = mayDo(profile, NeotmsMenuId.TRANSLATOR, 'delete')

  const onSearch = (e: FormEvent) => {
    e.preventDefault()
    setFilters(draft)
  }

  const onReset = () => {
    setDraft({ q: '', field: '', upro: '', coin: '' })
    resetFilters()
  }

  const onDelete = async (row: TranslatorRow) => {
    const label = row.tranName || row.tranCode
    if (!window.confirm(`${label} 번역가를 삭제할까요?\n이 화면에서는 되돌릴 수 없습니다.`)) return
    await deleteTranslator.mutateAsync(row.id)
    setNotice(`${label} 번역가를 삭제했습니다.`)
  }

  return (
    <div className={ui.page}>
      <div className={ui.pageHead}>
        <div>
          <h1 className={ui.pageTitle}>번역가</h1>
          <p className={ui.pageHint}>
            발주의 상대방입니다. 발주 원가는 여기 등록된 정산 통화와 지급 방법을 따릅니다.
          </p>
        </div>
        {mayCreate ? (
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => setEditing(null)}
          >
            번역가 등록
          </button>
        ) : null}
      </div>

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}
      <ErrorNotice error={deleteTranslator.error} />

      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <span>{rows.length}건 표시</span>
        </div>

        {/* 필터 바는 카드 안에 둔다 — `.filterBar` 의 아래쪽 경계선이 표의 머리와 이어지도록
            만든 스타일이고, 카드 밖에 두면 떠 있는 회색 띠가 된다. */}
        <form className={ui.filterBar} onSubmit={onSearch}>
          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="tf-q">
              검색어
            </label>
            <input
              id="tf-q"
              className={`${ui.input} ${ui.searchInput}`}
              type="search"
              placeholder="이름 · 이메일 · 다른 표기"
              value={draft.q}
              onChange={(e) => setDraft((p) => ({ ...p, q: e.target.value }))}
            />
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="tf-field">
              가능 분야
            </label>
            <input
              id="tf-field"
              className={ui.input}
              value={draft.field}
              onChange={(e) => setDraft((p) => ({ ...p, field: e.target.value }))}
            />
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="tf-upro">
              등급
            </label>
            <input
              id="tf-upro"
              className={ui.input}
              value={draft.upro}
              onChange={(e) => setDraft((p) => ({ ...p, upro: e.target.value }))}
            />
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="tf-coin">
              정산 통화
            </label>
            <select
              id="tf-coin"
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
                <th>번역가명</th>
                <th>연락처</th>
                <th>등급 · 조건</th>
                <th>가능 분야</th>
                <th>불가 분야</th>
                <th>정산</th>
                <th>상태</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <TableState
                isLoading={translatorsQuery.isLoading}
                error={translatorsQuery.error}
                isEmpty={rows.length === 0}
                emptyText={
                  activeCount > 0
                    ? '조건에 맞는 번역가가 없습니다. 분야·등급은 등록된 코드값과 정확히 같아야 합니다.'
                    : '등록된 번역가가 없습니다.'
                }
                colSpan={9}
              />
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className={ui.cellMono}>{row.tranCode}</td>
                  <td>
                    <div>{row.tranName || '-'}</div>
                    {/* 다른 표기를 같이 보여 준다 — 중복 등록을 알아채는 유일한 단서다. */}
                    {row.tranDup ? <div className={ui.cellMuted}>{row.tranDup}</div> : null}
                  </td>
                  <td className={ui.cellMuted}>
                    {row.tranEmail ? <div>{row.tranEmail}</div> : null}
                    {row.tranPhone ? <div>{row.tranPhone}</div> : null}
                    {!row.tranEmail && !row.tranPhone ? '-' : null}
                  </td>
                  <td className={ui.cellMuted}>
                    {[row.tranUpro, row.tranWorkCon].filter(Boolean).join(' · ') || '-'}
                  </td>
                  <td className={ui.cellClamp}>{row.tranField || '-'}</td>
                  {/*
                   * 불가 분야를 목록에 세운다.
                   *
                   * 모달을 열어야 보이면 아무도 열지 않고, 맡기면 안 되는 분야의 일이 배정된다.
                   * 등록해 둔 정보가 배정 순간에 보이지 않으면 등록할 이유도 없다.
                   */}
                  <td className={ui.cellClamp}>
                    {row.tranUnfield ? (
                      <span className={`${ui.badge} ${ui.badgeWarn}`}>{row.tranUnfield}</span>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className={ui.cellMuted}>
                    {[row.tranCoin, row.tranGive].filter(Boolean).join(' · ') || '-'}
                    {row.tranCatUse ? (
                      <div>
                        <span className={ui.badge}>CAT</span>
                      </div>
                    ) : null}
                  </td>
                  <td>
                    {row.active ? (
                      <span className={`${ui.badge} ${ui.badgeSuccess}`}>거래 중</span>
                    ) : (
                      <span className={ui.badge}>거래 종료</span>
                    )}
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
                          disabled={deleteTranslator.isPending}
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
          hasNextPage={!!translatorsQuery.hasNextPage}
          isFetchingNextPage={translatorsQuery.isFetchingNextPage}
          onClick={() => void translatorsQuery.fetchNextPage()}
        />
      </div>

      {editing !== undefined ? (
        <TranslatorFormModal
          translator={editing}
          onClose={() => setEditing(undefined)}
          onSaved={setNotice}
        />
      ) : null}
    </div>
  )
}
