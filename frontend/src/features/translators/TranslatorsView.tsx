import { useMemo, useState, type FormEvent } from 'react'
import { useProfile, useTranslators } from '@/apis/queries/neotms.query'
import { useDeleteTranslator } from '@/apis/queries/neotms.mutation'
import { CODE_DOMAIN, codeOptions, COIN_CODES } from '@/apis/neotms.codes'
import type { TranslatorRow } from '@/apis/neotms.types'
import { LIST_PAGE_SIZE, NeotmsMenuId } from '@/shared/config'
import { useUrlFilters } from '@/shared/hooks/useUrlFilters'
import { mayDo } from '@/shared/permissions'
import { CodeSelect } from '@/shared/ui/CodeSelect'
import { ErrorNotice, LoadMore, SuccessNotice, TableState } from '@/shared/ui/Feedback'
import { Icon } from '@/shared/ui/Icon'
import { ActiveChip } from '@/shared/ui/StatusChip'
import ui from '@/shared/ui/ui.module.css'
import { TranslatorFormModal } from './TranslatorFormModal'

/**
 * 번역가 목록.
 *
 * ## 이 화면의 용도는 "검색" 이다
 *
 * 다른 목록은 "최근 것부터 훑어본다" 가 기본 동작이지만, 번역가 목록은 거의 항상 **배정할
 * 사람을 찾기 위해** 열린다 — 이 분야를 할 수 있고, 이 프로그램을 쓰고, 이 통화로 정산하는 사람.
 * 그래서 서버의 facet 필터(`field`·`upro`·`coin`·`workCon`)를 그대로 필터 바로 올린다. 이 네
 * 컬럼에는 복합 인덱스가 있다(db/003_indexes.sql 의 `ix_tran_facet`).
 *
 * 분야·사용 프로그램은 `sys_code` 코드값이고, 코드 목록 엔드포인트(`GET /api/v0/codes`)가
 * 생겼으므로 `CodeSelect` 드롭다운으로 고른다. 한때 이 주석은 '등급' 이라고 적고 "검색 조건이니
 * 틀린 값을 넣어도 결과가 비는 것뿐" 이라고 변명하고 있었는데, 둘 다 틀렸다. `upro` 는 등급이
 * 아니라 번역가가 쓰는 번역 프로그램이고, 조건이 틀렸을 때 비는 결과는 안전한 게 아니라 **가장
 * 위험한 실패**다 — 화면은 오류 없이 "0건" 을 보여 주고, 배정할 사람을 찾던 사람은 그런 번역가가
 * 없다고 결론 낸다.
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
      {/* 제목은 셸의 경로 표시줄이 들고 있다 — NeotmsApp.module.css 의 `.crumb` 주석. */}
      <div className={ui.pageBar}>
        <p className={ui.pageNote}>
          발주의 상대방입니다. 발주 <b>원가</b>는 여기 등록된 정산 통화와 지급 방법을 따릅니다.
        </p>
        {mayCreate ? (
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => setEditing(null)}
          >
            <Icon name="plus" size={13} />
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

          {/* 필터에서도 드롭다운이어야 한다. 서버는 이 값을 `=` 로 비교하므로 자유 입력은
              오타 하나에 조용히 0건을 돌려주고, 찾는 사람은 "그런 번역가가 없다" 고 결론 낸다.
              `silent` 는 필터 바가 가로 배치라서 경고 문구가 입력칸 옆으로 밀려 나기 때문이다 —
              코드가 비어 있다는 안내는 등록 화면(TranslatorFormModal)에서 받는다. */}
          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="tf-field">
              가능 분야
            </label>
            <CodeSelect
              id="tf-field"
              domain={CODE_DOMAIN.FIELD}
              value={draft.field}
              onChange={(v) => setDraft((p) => ({ ...p, field: v }))}
              placeholder="전체"
              silent
            />
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="tf-upro">
              사용 프로그램
            </label>
            <CodeSelect
              id="tf-upro"
              domain={CODE_DOMAIN.UPRO}
              value={draft.upro}
              onChange={(v) => setDraft((p) => ({ ...p, upro: v }))}
              placeholder="전체"
              silent
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
                <th>사용 프로그램 · 조건</th>
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
                    ? '조건에 맞는 번역가가 없습니다. 조건을 줄여서 다시 조회해 보십시오.'
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
