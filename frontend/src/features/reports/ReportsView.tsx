import { useState, type FormEvent } from 'react'
import { useReportSummary, useWorkload } from '@/apis/queries/neotms.query'
import { codeOptions, REPORT_GROUPS } from '@/apis/neotms.codes'
import type { ReportGroupBy, ReportQuery } from '@/apis/neotms.types'
import { Amount } from '@/shared/ui/Amount'
import { ErrorNotice, InfoNotice, TableState } from '@/shared/ui/Feedback'
import { dateKstOffsetDays, formatDateTime, todayKst } from '@/shared/utils/format'
import ui from '@/shared/ui/ui.module.css'

/**
 * 집계 리포트.
 *
 * ## 화면을 열었다고 조회하지 않는다
 *
 * 이 시스템에서 가장 비싼 쿼리다. 기본 기간으로 자동 조회하면, 사용자가 원하는 기간을 고르는
 * 동안 쓸 일 없는 집계가 이미 한 번 돌아간다. DB 는 용량이 고정된 소형 인스턴스이고 부하에
 * 따라 늘어나지 않으므로, 그 한 번은 같은 순간 목록을 보는 다른 사람의 응답 시간으로 간다.
 * 그래서 `enabled` 를 '조회' 버튼이 통제한다.
 *
 * 기간을 바꾸면 조회 상태가 풀린다. 그러지 않으면 화면에는 새 기간이, 표에는 옛 기간의 숫자가
 * 남는다 — 금액이 틀린 리포트는 없는 리포트보다 나쁘다.
 *
 * ## `truncated` 를 무시하지 않는다
 *
 * 서버가 결과를 자르면 합계는 **전체 합계가 아니다.** 그 경우 숫자를 그대로 보여 주면서
 * "전체가 아님" 을 말하지 않는 것이 이 화면이 할 수 있는 최악의 일이므로, 경고를 표 위에
 * 띄우고 합계 라벨에도 표시한다.
 *
 * ## 마진율을 계산하지 않는다
 *
 * 매출이 0 인 기간(견적만 있는 달)이 실제로 있고, 그때 비율은 0으로 나누는 값이다. 0% 로
 * 적으면 거짓이고, '-' 로 적으면 계산 오류로 읽힌다. 세 금액을 나란히 두는 것으로 충분하다.
 */

/** 기본 기간은 최근 30일. 월 단위가 아닌 이유는 이 화면이 월말 정산 전용이 아니기 때문이다. */
const DEFAULT_FROM = dateKstOffsetDays(-30)

export function ReportsView() {
  const [draft, setDraft] = useState({
    from: DEFAULT_FROM,
    to: todayKst(),
    groupBy: 'customer' as ReportGroupBy,
  })

  /** '조회' 를 눌러 확정된 조건. 이 값만 쿼리에 들어간다. */
  const [query, setQuery] = useState<ReportQuery | null>(null)

  const summaryQuery = useReportSummary(
    query ?? { from: draft.from, to: draft.to, groupBy: draft.groupBy },
    !!query,
  )

  /**
   * 마감 임박 현황은 자동으로 읽는다.
   *
   * 집계와 달리 이쪽은 건수 세 개를 세는 가벼운 쿼리이고, 이 화면을 여는 사람이 가장 먼저
   * 보고 싶어 하는 값이다. 두 쿼리의 비용 차이가 '조회' 버튼의 유무를 정한다.
   */
  const workloadQuery = useWorkload()

  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    if (!draft.from || !draft.to) return
    setQuery({ from: draft.from, to: draft.to, groupBy: draft.groupBy })
  }

  /** 조건을 고치면 이전 결과를 가리킨 상태를 버린다. 위 주석 참고. */
  const change = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => {
    setQuery(null)
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const result = summaryQuery.data
  const groupLabel =
    REPORT_GROUPS.find((g) => g.value === (query?.groupBy ?? draft.groupBy))?.label ?? '집계'

  return (
    <div className={ui.page}>
      {/*
       * 제목은 셸의 경로 표시줄이 들고 있다 — NeotmsApp.module.css 의 `.crumb` 주석.
       *
       * 이 화면에는 오른쪽에 둘 버튼이 없다(조회는 아래 필터 바에 있다). 그래도 `.pageBar` 를
       * 쓰는 이유는 여덟 화면의 첫 줄 높이가 같아야 메뉴를 옮겨 다닐 때 본문이 위아래로 흔들리지
       * 않기 때문이다 — `.pageBar` 의 `min-height` 가 그 일을 한다.
       */}
      <div className={ui.pageBar}>
        <p className={ui.pageNote}>
          <b>매출</b>은 작업의 원화 환산 합계, <b>원가</b>는 발주의 원화 환산 합계입니다. 마진은 그
          차액입니다.
        </p>
      </div>

      {/* 마감 임박. 집계와 달리 자동으로 읽는다 — 위 주석 참고. */}
      <div className={ui.statGrid}>
        <div className={ui.stat}>
          <span className={ui.statLabel}>7일 내 납기 작업</span>
          <span className={ui.statValue}>
            {workloadQuery.data ? `${workloadQuery.data.jobsDue}건` : '…'}
          </span>
        </div>
        <div className={ui.stat}>
          <span className={ui.statLabel}>7일 내 납기 발주</span>
          <span className={ui.statValue}>
            {workloadQuery.data ? `${workloadQuery.data.posDue}건` : '…'}
          </span>
        </div>
        <div className={ui.stat}>
          {/*
           * 발주가 없는 작업 = 원가가 아직 없는 작업.
           *
           * 그 작업의 마진은 매출과 같게 나오므로, 이 숫자가 클 때 모든 집계의 마진이 실제보다
           * 좋아 보인다. 리포트 화면에서 이 사실을 먼저 보여 주는 이유다.
           */}
          <span className={ui.statLabel}>발주 없는 작업</span>
          <span className={ui.statValue}>
            {workloadQuery.data ? `${workloadQuery.data.jobsWithoutPo}건` : '…'}
          </span>
        </div>
      </div>
      <ErrorNotice error={workloadQuery.error} />

      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <span>{groupLabel} 집계</span>
        </div>

        <form className={ui.filterBar} onSubmit={onSubmit}>
          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="rf-from">
              시작일
            </label>
            <input
              id="rf-from"
              className={ui.input}
              type="date"
              value={draft.from}
              max={draft.to || undefined}
              onChange={(e) => change('from', e.target.value)}
              required
            />
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="rf-to">
              종료일
            </label>
            <input
              id="rf-to"
              className={ui.input}
              type="date"
              value={draft.to}
              min={draft.from || undefined}
              onChange={(e) => change('to', e.target.value)}
              required
            />
          </div>

          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="rf-group">
              집계 기준
            </label>
            <select
              id="rf-group"
              className={ui.select}
              value={draft.groupBy}
              onChange={(e) => change('groupBy', e.target.value as ReportGroupBy)}
            >
              {/* 서버의 picklist 와 값이 정확히 같아야 한다 — neotms.codes.ts */}
              {codeOptions(REPORT_GROUPS, draft.groupBy).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className={ui.spacer} />

          <button
            type="submit"
            className={`${ui.btn} ${ui.btnPrimary}`}
            disabled={summaryQuery.isFetching || !draft.from || !draft.to}
          >
            {summaryQuery.isFetching ? '집계 중…' : '조회'}
          </button>
        </form>

        <div className={ui.cardBody}>
          <ErrorNotice error={summaryQuery.error} />

          {!query ? (
            <p className={ui.hint}>
              기간과 집계 기준을 고른 뒤 '조회' 를 누르세요. 이 집계는 이 시스템에서 가장 무거운
              쿼리이므로 자동으로 실행하지 않습니다.
            </p>
          ) : null}

          {result?.truncated ? (
            <InfoNotice>
              결과가 잘렸습니다. <strong>아래 합계는 전체 합계가 아닙니다.</strong> 기간을 좁혀서
              다시 조회해 주세요.
            </InfoNotice>
          ) : null}

          {result ? (
            <>
              <div className={ui.statGrid}>
                <div className={ui.stat}>
                  <span className={ui.statLabel}>
                    매출{result.truncated ? ' (일부)' : ''}
                  </span>
                  <span className={ui.statValue}>
                    <Amount value={result.totals.revenue} kind="revenue" />
                  </span>
                </div>
                <div className={ui.stat}>
                  <span className={ui.statLabel}>원가{result.truncated ? ' (일부)' : ''}</span>
                  <span className={ui.statValue}>
                    <Amount value={result.totals.cost} kind="cost" />
                  </span>
                </div>
                <div className={ui.stat}>
                  <span className={ui.statLabel}>마진{result.truncated ? ' (일부)' : ''}</span>
                  <span className={ui.statValue}>
                    <Amount value={result.totals.margin} kind="margin" />
                  </span>
                </div>
                <div className={ui.stat}>
                  <span className={ui.statLabel}>집계 행 수</span>
                  <span className={ui.statValue}>{result.totals.rows}</span>
                </div>
              </div>
              <p className={ui.hint}>
                {result.query.from} ~ {result.query.to} · 집계 시각{' '}
                {formatDateTime(result.computedAt)}
              </p>
            </>
          ) : null}
        </div>

        <div className={`${ui.cardBodyFlush} ${ui.tableWrap}`}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>{groupLabel.replace(/별$/, '')}</th>
                <th>매출</th>
                <th>원가</th>
                <th>마진</th>
              </tr>
            </thead>
            <tbody>
              <TableState
                isLoading={summaryQuery.isFetching}
                error={summaryQuery.error}
                isEmpty={!result || result.lines.length === 0}
                emptyText={
                  query
                    ? '이 기간에 집계할 매출·원가가 없습니다.'
                    : '조회 조건을 선택한 뒤 조회해 주세요.'
                }
                colSpan={4}
              />
              {result?.lines.map((line) => (
                <tr key={line.key}>
                  {/* 라벨이 비어 있는 행은 "미지정" 이다 — 고객사나 PM 이 비어 있는 건들이 묶인다. */}
                  <td>{line.label || '(미지정)'}</td>
                  <td>
                    <Amount value={line.revenue} kind="revenue" />
                  </td>
                  <td>
                    <Amount value={line.cost} kind="cost" />
                  </td>
                  <td>
                    <Amount value={line.margin} kind="margin" />
                  </td>
                </tr>
              ))}
            </tbody>
            {/*
             * 합계를 표 바닥에 한 번 더 적는다.
             *
             * 위의 `.statGrid` 에도 같은 세 숫자가 있지만, 그쪽은 표를 스크롤하면 화면에서
             * 사라진다. 집계 기준이 '고객사별' 이면 행이 수백 개이고, 그 상태에서 한 행의
             * 마진을 보는 사람이 "이게 전체의 몇 분의 일인가" 를 알려면 위로 되돌아가야 한다.
             * `tfoot` 는 `.table tfoot td` 에서 아래쪽에 고정되므로 늘 같이 보인다.
             *
             * 잘린 결과일 때 합계 칸에 '(일부)' 를 붙이는 이유는 위쪽 경고를 지나친 사람이
             * 바로 이 숫자를 전체 합계로 베껴 쓰기 때문이다.
             */}
            {result && result.lines.length > 0 ? (
              <tfoot>
                <tr>
                  <td>합계{result.truncated ? ' (일부)' : ''}</td>
                  <td>
                    <Amount value={result.totals.revenue} kind="revenue" />
                  </td>
                  <td>
                    <Amount value={result.totals.cost} kind="cost" />
                  </td>
                  <td>
                    <Amount value={result.totals.margin} kind="margin" />
                  </td>
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      </div>

      <p className={ui.pageHint}>
        엑셀 내려받기는 아직 없습니다. 서버에 XLSX 생성 엔드포인트를 추가한 뒤 이 화면에 붙입니다 —
        브라우저에서 만들면 잘린 결과(`truncated`)가 그대로 파일이 되어, 전체인 줄 알고 쓰이게
        됩니다.
      </p>
    </div>
  )
}
