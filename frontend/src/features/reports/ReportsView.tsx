import { useMemo, useState, type FormEvent } from 'react'
import { useReportSummary, useWorkload } from '@/apis/queries/neotms.query'
import { codeOptions, REPORT_GROUPS } from '@/apis/neotms.codes'
import type { ReportGroupBy, ReportLine, ReportQuery } from '@/apis/neotms.types'
import { Amount } from '@/shared/ui/Amount'
import { ErrorNotice, InfoNotice, TableState } from '@/shared/ui/Feedback'
import { dateKstOffsetDays, formatDateTime, todayKst } from '@/shared/utils/format'
import { decimalCompare, decimalPercent, formatMoney, isDecimalString, isNegative } from '@/shared/utils/money'
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
 * 서버가 줄 목록을 자르면 **표와 그래프는 부분이고 합계는 전체다.** 합계를 별도의 무제한
 * 쿼리로 구하기 때문이다(NeotmsReportManager 의 runReport). 둘의 범위가 다르다는 사실을
 * 말하지 않으면, 줄들을 더해 보는 사람이 발견하는 것은 "리포트의 숫자가 안 맞는다" 이고 그
 * 순간 맞는 숫자까지 같이 버려진다. 그래서 경고를 표 위에 띄우고 합계 라벨에도 표시한다.
 *
 * 표시 개수를 사용자가 고르게 된 뒤로 이 상태는 예외가 아니라 **보통**이다 — 고객사가 30곳을
 * 넘는 기간이면 기본값으로 조회해도 잘린다.
 *
 * ## 비율은 계산하되, 0 으로 나누지는 않는다
 *
 * 매출이 0 인 기간(견적만 있는 달)이 실제로 있고, 그때 비율은 0으로 나누는 값이다. 0% 로
 * 적으면 거짓이고 '-' 로 적으면 계산 오류로 읽히므로, 그 경우에는 **막대를 그리지 않고** 왜
 * 못 그리는지 한 줄로 적는다. 비율 계산은 `decimalPercent` 가 BigInt 로 한다 — 이 화면에서
 * `Number()` 를 쓰는 곳은 한 군데도 없다(money.ts 맨 위 주석).
 *
 * ## 숫자 상자 대신 비중 막대
 *
 * 매출·원가·마진·행수를 큰 숫자 네 개로 세워 두면, 읽는 사람이 가장 먼저 알고 싶은 것(마진이
 * 수주액의 몇 %인가)을 머리로 나눗셈해서 구해야 한다. 그래서 상자 네 개를 치우고 **수익/원가
 * 비중 막대 한 개 + 총수주금액 한 줄**로 바꿨다. 정확한 세 금액은 표 바닥의 합계 줄에 그대로
 * 있으므로 잃는 정보는 없다.
 */

/** 기본 기간은 최근 30일. 월 단위가 아닌 이유는 이 화면이 월말 정산 전용이 아니기 때문이다. */
const DEFAULT_FROM = dateKstOffsetDays(-30)

/**
 * 막대 그래프에 세울 줄 수. 서버의 `REPORT_TOP_N_MAX` 가 30 이므로 그 위는 둘 수 없다.
 *
 * 기본값이 **상한인 30** 인 것이 중요하다. 10 으로 두면 화면을 처음 연 사람이 보는 그래프가
 * 이미 잘린 그래프이고, 잘렸다는 사실은 경고를 읽어야 알 수 있다 — 기본값이 데이터를 숨기는
 * 설정은 리포트에서 가장 하기 싫은 선택이다. 게다가 기본 기간이 30일이므로, '일자별' 로 보면
 * 30 이 곧 "기간 전체" 다. 사용자는 거기서 **좁혀 간다**.
 *
 * 자유 입력(`type="number"`)이 아니라 드롭다운인 이유는 서버가 1~30 만 받기 때문이다. 숫자를
 * 직접 치게 하면 50 을 넣고 '조회' 를 눌러 400 을 받는 길이 열리는데, 그 400 의 메시지는
 * 사용자가 고를 수 있었던 값이 무엇인지 말해 주지 못한다.
 */
const LINE_LIMITS = ['5', '10', '15', '20', '30'] as const

/**
 * 막대 그래프 한 줄에 필요한 값들. 전부 10진 문자열 또는 null 이다.
 *
 * `null` 은 "그릴 수 없다" 는 뜻이고 0 과 구분된다 — 0% 는 "마진이 정말 0" 이지만 null 은
 * "분모가 0이라 비율이 존재하지 않음" 이다. 둘을 같은 값으로 뭉개면 매출 0원인 줄이 '마진 0%'
 * 로 보이고, 그건 틀린 말이 아니라 **말이 안 되는 말**이다.
 */
interface ChartBar {
  line: ReportLine
  /** 가장 큰 줄 대비 이 줄의 매출 비중. 막대 전체 길이. */
  lengthPct: string | null
  /** 이 줄 안에서 수익이 차지하는 비중. 막대 왼쪽 조각의 길이. */
  marginPct: string | null
  /** 원가가 매출을 넘겼는지. 넘긴 줄은 쪼개지 않고 통째로 손실색이다. */
  loss: boolean
}

/**
 * `width` 에 넣을 퍼센트 문자열. 못 그리는 값(null)과 음수는 `0%` 로 눕힌다.
 *
 * **음수를 그대로 넘기면 안 된다.** `width: -5%` 는 CSS 가 선언째로 무시하므로, 막대는
 * `width: auto` 로 되돌아가 트랙을 꽉 채운다. 즉 매출이 음수인 줄(취소·환입된 건만 남은 고객사)이
 * **1위 줄과 똑같이 긴 막대**로 그려진다 — 잘못된 값이 가장 좋은 값으로 보이는, 막대 그래프에서
 * 할 수 있는 최악의 실패다. 0 으로 눕히면 "그릴 수 없었다" 가 그림으로도 그렇게 보인다.
 *
 * 100 을 넘는 값은 깎지 않는다. 그런 값이 들어오는 자리(원가 비중)에서는 호출자가 막대를
 * 쪼개는 대신 통째로 손실색으로 칠하므로 여기까지 오지 않는다.
 */
function barWidth(pct: string | null): string {
  if (pct === null || isNegative(pct)) return '0%'
  return `${pct}%`
}

export function ReportsView() {
  const [draft, setDraft] = useState({
    from: DEFAULT_FROM,
    to: todayKst(),
    groupBy: 'customer' as ReportGroupBy,
    limit: '30',
  })

  /** '조회' 를 눌러 확정된 조건. 이 값만 쿼리에 들어간다. */
  const [query, setQuery] = useState<ReportQuery | null>(null)

  const summaryQuery = useReportSummary(
    query ?? { from: draft.from, to: draft.to, groupBy: draft.groupBy, limit: draft.limit },
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
    setQuery({
      from: draft.from,
      to: draft.to,
      groupBy: draft.groupBy,
      limit: draft.limit,
    })
  }

  /** 조건을 고치면 이전 결과를 가리킨 상태를 버린다. 위 주석 참고. */
  const change = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => {
    setQuery(null)
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  const result = summaryQuery.data
  const groupLabel =
    REPORT_GROUPS.find((g) => g.value === (query?.groupBy ?? draft.groupBy))?.label ?? '집계'

  /*
   * 전체 비중: 수익과 원가가 각각 총수주금액의 몇 %인가.
   *
   * 원가 쪽 퍼센트도 따로 구한다. 막대의 **길이**는 한쪽만 알면 되지만(나머지는 flex 가 채운다),
   * 범례에 적는 **숫자**는 두 쪽 다 필요하다. 100 에서 빼서 구하지 않는 이유는 반올림이다 —
   * 수익이 59.995% 일 때 표시값은 60.00% 이고, 거기서 100 을 빼면 원가가 40.00% 로 적히는데
   * 실제 원가 비중은 40.005% → 40.01% 다. 각각 원값에서 구하면 둘 다 자기 숫자로 맞는다.
   */
  const totals = result?.totals
  const marginPct = decimalPercent(totals?.margin, totals?.revenue)
  const costPct = decimalPercent(totals?.cost, totals?.revenue)
  /*
   * 원가가 수주액을 넘긴 기간. 막대를 '수익 | 원가' 로 쪼개지 않고 통째로 손실색으로 칠한다.
   *
   * 쪼갤 수 없는 이유는 수익 비중이 **음수**이기 때문이다. `width: -25%` 는 CSS 가 무시하므로
   * 막대는 원가 100% 로 그려지고, 결과적으로 "원가가 수주액과 같다" 는 그림이 된다 — 가장
   * 심각한 상태가 정상 상태처럼 보이는, 이 화면이 절대 하면 안 되는 거짓말이다.
   */
  const totalLoss = isNegative(totals?.margin)

  /*
   * 막대 그래프의 각 줄. 길이의 기준은 **가장 큰 매출**이다.
   *
   * 총수주금액을 기준으로 삼지 않는 이유: 고객사가 서른 곳이면 1위도 전체의 10% 쯤이고, 모든
   * 막대가 트랙의 왼쪽 10분의 1 안에 몰려 서로 구분되지 않는다. 1위를 꽉 찬 막대로 두면 줄들
   * **사이의** 비교가 보이고, 전체 대비 비중은 바로 위 비중 막대와 표가 맡는다.
   */
  const bars = useMemo<ChartBar[]>(() => {
    const lines = result?.lines
    if (!lines || lines.length === 0) return []

    let max: string | null = null
    for (const line of lines) {
      // 파싱 안 되는 값은 기준에서 제외한다. 포함하면 그 쓰레기 값이 최대가 되어 **모든** 막대가
      // 0 에 가깝게 짧아지고, 그래프가 통째로 비어 보인다.
      if (!isDecimalString(line.revenue)) continue
      if (max === null || (decimalCompare(line.revenue, max) ?? 0) > 0) max = line.revenue
    }

    return lines.map((line) => ({
      line,
      lengthPct: decimalPercent(line.revenue, max),
      marginPct: decimalPercent(line.margin, line.revenue),
      loss: isNegative(line.margin),
    }))
  }, [result])

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

          {/*
           * 표시 개수. 서버의 `limit` 으로 그대로 간다.
           *
           * '일자별' 에서 이 값이 뜻하는 것은 **최근** N 일이고, 화면에는 그 N 일이 날짜순으로
           * 선다(NeotmsReport.dbops.ts 의 pickBy/displayBy 분리). 범위의 앞 N 일이 아니다 —
           * 3개월을 조회하고 10 을 고른 사람이 보고 싶은 것은 석 달 전의 열흘이 아니다.
           */}
          <div className={ui.filterField}>
            <label className={ui.label} htmlFor="rf-limit">
              표시 개수
            </label>
            <select
              id="rf-limit"
              className={ui.select}
              value={draft.limit}
              onChange={(e) => change('limit', e.target.value)}
            >
              {LINE_LIMITS.map((n) => (
                <option key={n} value={n}>
                  {n}개
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
              기간과 집계 기준을 고른 뒤 '조회' 를 누르세요.
            </p>
          ) : null}

          {/*
           * 잘림 경고의 방향을 틀리지 않는 것이 중요하다.
           *
           * 서버는 합계를 **표와 무관한 별도 쿼리**로 구한다(NeotmsReportManager 의 runReport
           * 주석: "three queries, deliberately"). 즉 잘린 것은 **줄 목록**이고 합계는 기간
           * 전체다. 그래서 "합계가 부분합이다" 라고 적으면 정확히 거꾸로 된 말이 되고, 읽는
           * 사람은 맞는 숫자를 틀린 숫자로 알고 버린다.
           *
           * 말해야 하는 사실은 하나다: **보이는 줄을 더해도 합계가 되지 않는다.** 그걸 미리
           * 말하지 않으면, 더해 보는 사람이 발견하는 것은 "리포트의 숫자가 안 맞는다" 다.
           */}
          {result?.truncated ? (
            <InfoNotice>
              줄이 {result.lines.length}개로 잘렸습니다. 아래 <strong>총수주금액과 표 바닥의 합계는
              기간 전체</strong> 금액이므로, 보이는 줄을 모두 더해도 합계와 같아지지 않습니다. 전체
              줄을 보려면 표시 개수를 늘리거나 기간을 좁혀 주세요.
            </InfoNotice>
          ) : null}

          {result ? (
            <>
              <div className={ui.shareWrap}>
                {marginPct === null ? (
                  /*
                   * 수주금액이 0원인 기간. 비중이 존재하지 않으므로 막대를 그리지 않는다.
                   *
                   * 0% 막대를 그리면 "수익이 0이고 원가가 전부" 라는 그림이 되는데, 원가도 0인
                   * 기간에서 그건 틀린 그림이다. 왜 못 그리는지 한 줄로 적는 편이 정확하다.
                   */
                  <p className={ui.hint}>
                    이 기간의 수주금액이 0원이어서 수익·원가 비중을 그릴 수 없습니다.
                  </p>
                ) : (
                  <>
                    <div className={ui.shareLegend}>
                      <span className={ui.shareItem}>
                        {/* 손실 기간에는 '수익' 점도 손실색이다 — 막대와 범례의 색이 달라지면
                            어느 쪽이 어느 조각인지 알 수 없다. */}
                        <span
                          className={`${ui.shareDot} ${totalLoss ? ui.shareDotLoss : ui.shareDotMargin}`}
                        />
                        수익
                        <span className={ui.sharePct}>{marginPct}%</span>
                      </span>
                      <span className={ui.shareItem}>
                        {/*
                         * 손실 기간에는 원가 쪽 점을 찍지 않는다.
                         *
                         * 그때 막대는 통째로 손실색이라 **원가색 조각이 아예 없다.** 범례는
                         * "이 색이 막대의 이 부분" 이라는 약속이므로, 막대에 없는 색을 범례에
                         * 두면 읽는 사람은 찾을 수 없는 조각을 찾는다. 숫자는 그대로 둔다 —
                         * 120% 라는 값이야말로 이 기간에 대해 가장 중요한 사실이다.
                         */}
                        {totalLoss ? null : <span className={`${ui.shareDot} ${ui.shareDotCost}`} />}
                        원가
                        <span className={ui.sharePct}>{costPct}%</span>
                      </span>
                    </div>

                    <div className={ui.shareBar}>
                      {totalLoss ? (
                        <div className={ui.shareSegLoss} />
                      ) : (
                        <>
                          {/* 왼쪽만 너비를 받는다. 오른쪽은 남는 자리를 채운다 — ui.module.css
                              의 `.shareSegCost` 주석(반올림으로 합이 100 을 벗어나는 문제). */}
                          <div className={ui.shareSegMargin} style={{ width: barWidth(marginPct) }} />
                          <div className={ui.shareSegCost} />
                        </>
                      )}
                    </div>
                  </>
                )}

                {/*
                 * 분모를 적는 줄. 위 막대의 두 퍼센트가 **무엇의** 몇 %인지를 여기서 못 읽으면
                 * 비중 막대는 비율만 있고 금액이 없는 그림이 된다.
                 *
                 * `<div>` 인 이유는 `.shareTotal` 이 flex 이고 margin 을 쓰지 않기 때문이다.
                 * `<p>` 로 두면 브라우저 기본 margin 1em 이 붙어 `.shareWrap` 의 gap 과 겹친다.
                 */}
                {/* '(일부)' 를 붙이지 않는다. 이 금액은 표시 개수와 무관한 기간 전체 합계다 —
                    바로 위 경고 주석 참고. */}
                <div className={ui.shareTotal}>
                  <span className={ui.statLabel}>총수주금액</span>
                  <span className={ui.shareTotalValue}>{formatMoney(result.totals.revenue)}</span>
                  <span className={ui.statLabel}>100%</span>
                </div>
              </div>

              {/*
               * 표시 줄 수는 `result.lines.length` 로 센다. `result.query.limit` 을 쓰지 않는
               * 이유는 서버가 그 값을 valibot 으로 **숫자**로 바꿔 되돌려 주는데 프런트 타입은
               * `string` 이기 때문이다 — 그 자리에 들어 있는 것은 타입이 말하는 것과 다르다.
               * 실제로 그려진 줄 수를 세면 그 불일치를 지나칠 수 있고, 표시 개수보다 줄이 적은
               * 경우(고객사가 7곳인데 30개 요청)에도 맞는 숫자가 나온다.
               */}
              <p className={ui.hint}>
                {result.query.from} ~ {result.query.to} · 전체 {result.totals.rows}개 행 집계 ·{' '}
                {result.lines.length}개 줄 표시 · 집계 시각 {formatDateTime(result.computedAt)}
              </p>
            </>
          ) : null}
        </div>

        {/*
         * 막대 그래프. 표와 **같은 데이터**를 같은 순서로 그린다.
         *
         * 표를 없애지 않고 위에 그래프를 얹는 이유는 두 가지가 서로 다른 질문에 답하기 때문이다.
         * 그래프는 "어디가 큰가" 에 눈으로 답하고, 표는 "정확히 얼마인가" 에 숫자로 답한다.
         * 그래프만 두면 금액을 베껴 쓸 수 없고(길이는 복사할 수 없다), 표만 두면 서른 줄 중에서
         * 1위를 찾는 일을 사람이 한다.
         *
         * `cardBody` 를 따로 쓴다 — 표는 `cardBodyFlush` 로 카드 끝까지 붙지만 그래프는 안쪽
         * 여백이 있어야 막대 끝이 카드 테두리에 닿지 않는다.
         */}
        {bars.length > 0 ? (
          <div className={ui.cardBody}>
            <div className={ui.chart}>
              {bars.map((bar) => (
                <div className={ui.chartRow} key={bar.line.key}>
                  {/* 표의 첫 칸과 같은 규칙으로 비운 라벨을 적는다 — 아래 `(미지정)` 주석. */}
                  <span className={ui.chartLabel} title={bar.line.label || '(미지정)'}>
                    {bar.line.label || '(미지정)'}
                  </span>
                  <div className={ui.chartTrack}>
                    {/*
                     * 막대 하나에 두 가지 길이가 들어 있다. 바깥 `.chartBar` 의 너비는 **1위
                     * 대비 이 줄의 매출**이고, 그 안을 수익/원가로 쪼갠 비율은 **이 줄 안에서의
                     * 마진율**이다. 그래서 짧지만 파란 부분이 긴 막대는 "작지만 남는 거래" 로,
                     * 길지만 거의 전부 회색인 막대는 "크지만 남지 않는 거래" 로 읽힌다 — 금액
                     * 하나만 긴 막대로 세우는 그래프는 이 구분을 못 보여 준다.
                     */}
                    <div className={ui.chartBar} style={{ width: barWidth(bar.lengthPct) }}>
                      {bar.loss ? (
                        <div className={ui.chartSegLoss} />
                      ) : (
                        <>
                          <div
                            className={ui.chartSegMargin}
                            style={{ width: barWidth(bar.marginPct) }}
                          />
                          <div className={ui.chartSegCost} />
                        </>
                      )}
                    </div>
                  </div>
                  <span className={ui.chartValue}>{formatMoney(bar.line.revenue)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

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
             * 위 비중 막대에는 총수주금액만 있고 원가·마진의 **금액**은 없다(거기 있는 것은
             * 비율이다). 세 금액을 정확한 숫자로 읽는 자리는 여기 한 곳이므로, 비중 막대로
             * 바꾸면서 이 줄이 없어서는 안 되는 줄이 되었다. `tfoot` 는 `.table tfoot td` 에서
             * 아래쪽에 고정되므로 표를 스크롤해도 같이 보인다.
             *
             * 라벨에 '(기간 전체)' 를 붙이는 이유는 이 숫자가 **위 줄들의 합이 아니기** 때문이다
             * — 서버가 합계를 별도 쿼리로 구한다(위 잘림 경고 주석). 잘렸을 때만 붙인다: 잘리지
             *   않았으면 둘이 실제로 같으므로 덧붙일 말이 없다.
             */}
            {result && result.lines.length > 0 ? (
              <tfoot>
                <tr>
                  <td>합계{result.truncated ? ' (기간 전체)' : ''}</td>
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
