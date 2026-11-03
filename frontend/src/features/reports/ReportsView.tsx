import { useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import { useReportSummary, useWorkload } from '@/apis/queries/neotms.query'
import { codeOptions, REPORT_GROUPS } from '@/apis/neotms.codes'
import type { ReportGroupBy, ReportQuery } from '@/apis/neotms.types'
import { Amount } from '@/shared/ui/Amount'
import { ErrorNotice, InfoNotice, TableState } from '@/shared/ui/Feedback'
import { dateKstOffsetDays, formatDateTime, todayKst } from '@/shared/utils/format'
import { decimalPercent, formatMoney, isNegative } from '@/shared/utils/money'
import { atLeast, barHeight, buildScale } from './reportScale'
import ui from '@/shared/ui/ui.module.css'

/**
 * 집계 리포트.
 *
 * ## 숫자는 조회를 누른 그 순간의 숫자다
 *
 * 서버가 `job`·`purchase_order` 를 요청마다 직접 집계한다. 밤에 한 번 돌려 둔 집계표를 읽는
 * 구조였던 적이 있었는데, 그러면 오늘 납품한 건이 리포트에 없다 — 지금 쓰는 TMS 는 당일 작업을
 * 보여 주므로, 그 구조로 넘어가는 것은 최적화가 아니라 **기능 후퇴**였다. 자세한 사정은
 * db/004_rollup.sql 과 NeotmsReport.dbops.ts 의 머리 주석에 있다.
 *
 * 그래서 이 화면에는 "언제 기준 데이터인가" 라는 질문이 없다. 아래 `조회 시각` 은 데이터의
 * 기준일이 아니라 **이 숫자를 뽑은 시각**이고, 두 번 조회하면 두 값이 달라질 수 있다 — 그
 * 사이에 누군가 작업을 등록했다면 그게 맞는 동작이다.
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
 *
 * ## 그래프가 먼저, 비중 막대가 그다음
 *
 * 둘은 같은 숫자를 다르게 자른 그림이고, **범위가 다르다**. 그래프는 줄 하나하나(고객사별)이고
 * 비중 막대는 기간 전체의 합계다. 합계를 위에 두면 읽는 순서가 '전체 → 부분' 이 되는데, 이
 * 화면을 여는 사람의 질문은 거의 항상 "어디가 컸나" 이지 "전부 얼마인가" 가 아니다. 그래서
 * 그래프를 먼저 세우고, 그 아래에서 "그래서 다 합치면 이만큼이고 그중 수익이 이만큼" 으로
 * 닫는다.
 *
 * 두 그림이 **같은 네 색**을 쓰는 것이 이 배치의 전제다(ui.module.css 의 색 주석). 위에서
 * 초록이던 수익이 아래에서 남색이면, 읽는 사람은 두 그림이 서로 다른 것을 잰다고 생각한다.
 *
 * ## 한 줄에 막대 세 개
 *
 * 가로 막대 하나를 수익/원가로 쪼개 그리던 때가 있었는데, 그 그림에는 **크기가 없었다** —
 * 매출 1억에 수익 10%인 고객사와 매출 100만에 수익 10%인 고객사가 같은 모양이고 길이만
 * 달랐다. 지금은 매출·원가·수익을 나란히 세운다. 회색 원가 막대가 매출 막대에 거의 닿은
 * 줄이 "크지만 남지 않는 거래" 이고, 그건 쪼갠 막대 하나로는 볼 수 없던 사실이다.
 *
 * 세로축 눈금 금액은 데이터에 없는 값이다(5,000,000원이라는 줄은 어느 고객사의 매출도 아니다).
 * 그 둥근 수를 만들어 내는 계산이 reportScale.ts 에 있고, 거기서도 `Number` 를 쓰지 않는다.
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
 * 그래프의 세 계열. **막대와 범례가 이 목록 하나를 같이 읽는다.**
 *
 * 둘을 따로 적어 두면 색이 거짓말을 할 수 있다 — 막대의 순서나 색을 고치고 범례를 안 고치면
 * 아무 오류 없이 "원가가 제일 큰 고객사" 가 "매출이 제일 큰 고객사" 로 읽힌다. 그래프에서
 * 범례가 틀리는 것은 숫자가 틀리는 것과 같다.
 *
 * 순서가 매출 → 원가 → 수익인 것은 표의 열 순서와 같기 때문이다. 그래프에서 두 번째 막대를
 * 보고 표로 눈을 옮기면 두 번째 열이 그 숫자다.
 */
const SERIES = [
  { key: 'revenue', label: '매출', tone: ui.chartColRevenue },
  { key: 'cost', label: '원가', tone: ui.chartColCost },
  { key: 'margin', label: '수익', tone: ui.chartColMargin },
] as const

/**
 * 비중 막대에서 퍼센트를 조각 **안**에 넣을 최소 비중.
 *
 * 8% 아래에서는 숫자가 조각보다 넓어져 잘린다. 좁은 화면에서도 8% 면 `100.00%` 를 뺀 거의
 * 모든 표기가 들어간다. 이 값 미만인 조각은 숫자를 조각 밖(옆 조각 위)으로 내보낸다 —
 * 지우지 않는다. 마진율 3% 인 기간이야말로 이 숫자가 가장 중요한 기간이다.
 */
const PCT_INSIDE_MIN = '8'

/**
 * `width`·`height` 에 넣을 퍼센트 문자열. 못 그리는 값(null)과 음수는 `0%` 로 눕힌다.
 *
 * **음수를 그대로 넘기면 안 된다.** `width: -5%` 는 CSS 가 선언째로 무시하므로, 비중 막대의
 * 왼쪽 조각은 `width: auto` 로 되돌아가 트랙을 꽉 채운다. 즉 가장 나쁜 값이 가장 좋은 값으로
 * 그려진다 — 막대 그래프에서 할 수 있는 최악의 실패다. 0 으로 눕히면 "그릴 수 없었다" 가
 * 그림으로도 그렇게 보인다.
 *
 * 세로 막대의 높이도 같은 함수를 쓴다. 그쪽에서 음수는 **아래로 자라는 막대**이고, 부호는
 * 높이가 아니라 0 선의 어느 쪽에 붙이느냐로 표현한다(reportScale.ts 의 `barHeight`).
 */
function barSize(pct: string | null): string {
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
   * 퍼센트를 조각 안에 넣을지, 옆으로 내보낼지. CSS 로는 판단할 수 없다 — 조각의 실제 픽셀
   * 폭을 아는 것은 브라우저뿐이고, 글자가 넘치는지 물어볼 방법이 없다. 하지만 **비중은 이미
   * 알고 있으므로**, 자리가 모자랄 비중을 미리 가려내면 된다.
   */
  const marginInside = atLeast(marginPct, PCT_INSIDE_MIN)
  const costInside = atLeast(costPct, PCT_INSIDE_MIN)

  /*
   * 세로 막대 그래프.
   *
   * 축은 **세 계열 전부**를 보고 만든다. 매출만 보고 상한을 잡으면 안 되는 이유는 원가가
   * 매출을 넘긴 줄 때문이다 — 그 줄의 회색 막대가 축 위로 삐져나가 잘리면, 이 그래프가
   * 알려 줄 수 있는 가장 중요한 사실이 바로 그 잘린 부분에 들어 있다.
   *
   * `buildScale` 이 null 이면 그릴 것이 없다(전부 0원이거나 금액이 아예 없다). 그때 축을
   * 억지로 만들면 상한이 10원인 그래프에 0원짜리 막대가 깔리고, 그 그림은 "데이터가 없다" 가
   * 아니라 "전부 0원이다" 로 읽힌다.
   */
  const chart = useMemo(() => {
    const lines = result?.lines
    if (!lines || lines.length === 0) return null

    const scale = buildScale(lines.flatMap((line) => [line.revenue, line.cost, line.margin]))
    if (!scale) return null

    const columns = lines.map((line) => ({
      line,
      bars: SERIES.map((series) => {
        const value = line[series.key]
        return {
          series,
          value,
          height: barHeight(value, scale),
          /** 0 선 아래로 자라는 막대. 수익이 음수인 줄뿐이다. */
          down: isNegative(value),
        }
      }),
    }))

    /*
     * 손실 막대가 하나라도 있을 때만 범례에 '손실' 을 더한다.
     *
     * 항상 띄워 두면 빨간 막대가 없는 날에도 찾게 되고, 빼 두면 빨간 막대가 나온 날에 그 색이
     * 무슨 뜻인지 화면 어디에도 없다. 범례는 **지금 화면에 있는 색**을 설명하는 것이다.
     */
    return { scale, columns, anyLoss: lines.some((line) => isNegative(line.margin)) }
  }, [result])

  return (
    <div className={ui.page}>

      {/* 마감 임박. 집계와 달리 자동으로 읽는다 — 위 주석 참고. */}
      <div className={ui.statGrid}>
        <div className={ui.stat}>
          <span className={ui.statLabel}>7일 내 마감되는 작업</span>
          <span className={ui.statValue}>
            {workloadQuery.data ? `${workloadQuery.data.jobsDue}건` : '…'}
          </span>
        </div>
        <div className={ui.stat}>
          <span className={ui.statLabel}>7일 내 마감되는 PO</span>
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
          <span className={ui.statLabel}>PO 없는 작업</span>
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
           * 주석: "Two queries, deliberately"). 즉 잘린 것은 **줄 목록**이고 합계는 기간
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

          {/*
           * 결과가 0줄일 때 **왜** 0줄인지 말한다. 표 안의 한 줄짜리 '없습니다' 는 이 질문에
           * 답하지 못한다.
           *
           * 이 화면에서 실제로 제일 먼저 겪은 문제가 이것이었다 — 10/01~11/01 로 잡아 둔
           * 프로젝트가 정산까지 끝났는데 리포트가 계속 비어 있었다. 리포트의 기준 날짜는
           * 프로젝트 기간이 아니라 **작업의 납품일(job_eday)** 이어서, 작업에 납품일이 비어
           * 있으면 어떤 기간으로 조회해도 그 작업은 어디에도 나오지 않는다. 날짜가 없는 건은
           * 속할 기간이 없기 때문이다.
           *
           * 비어 있는 리포트는 "이번 분기는 조용했다" 로 읽힌다. 그게 사실일 때도 있지만
           * 데이터가 잘못 들어가 있을 때도 똑같이 그렇게 읽히고, 그 둘을 화면이 구분해 주지
           * 않으면 사람은 틀린 쪽을 믿는다. 그래서 세 가지 원인을 전부 적는다 — 셋 다 화면
           * 어디에도 단서가 없는 것들이다(권한 범위는 특히 그렇다: 남의 일감은 애초에 보이지
           * 않으므로 "없다" 와 구분되지 않는다).
           */}
          {result && result.lines.length === 0 ? (
            <InfoNotice>
              이 기간에 집계할 건이 없습니다. 데이터가 있는데도 비어 있다면 다음을 확인해 주세요 —
              리포트의 기준 날짜는 프로젝트 기간이 아니라 <strong>작업의 납품일</strong>입니다.
              납품일이 비어 있는 작업은 어떤 기간으로 조회해도 나오지 않습니다. 또한 삭제된
              프로젝트의 작업은 제외되며, 전체 열람 권한이 없으면 <strong>본인이 담당한 작업·프로젝트</strong>만
              집계됩니다.
            </InfoNotice>
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
        {chart ? (
          <div className={ui.cardBody}>
            <figure className={ui.chart}>
              {/*
               * `<figure>` + `<figcaption>` 이다. 제목이 그래프에 **묶여** 있어야, 화면을
               * 읽어 주는 도구가 "그림 하나와 그 설명" 으로 전달한다. `<div>` 두 개면 제목은
               * 그래프와 무관한 앞 문단이 된다.
               */}
              <figcaption className={ui.chartTitle}>{groupLabel} 매출</figcaption>

              <div className={ui.chartMain}>
                <span className={ui.chartYTitle}>금액</span>

                {/*
                 * 눈금 금액. 스크롤 칸 **밖**에 있으므로 가로로 밀어도 축이 따라가지 않는다 —
                 * 눈금이 같이 밀려 나가면 오른쪽 끝 막대의 높이를 읽을 기준이 사라진다.
                 */}
                <div className={ui.chartTicks}>
                  {chart.scale.ticks.map((tick) => (
                    <span
                      className={ui.chartTickLabel}
                      key={tick.value}
                      style={{ bottom: `${tick.pos}%` }}
                    >
                      {formatMoney(tick.value)}원
                    </span>
                  ))}
                </div>

                <div className={ui.chartScroll}>
                  {/*
                   * 묶음 수를 CSS 에 넘긴다. 폭 계산(`--chart-slot × --chart-cols`)은 CSS 가
                   * 하고, 거기에 `min-width: 100%` 가 걸려 있다 — 묶음이 적으면 늘어나 카드를
                   * 채우고, 많으면 넘쳐서 스크롤된다. 한 묶음의 최소 폭(58px)을 JS 가 알 필요가
                   * 없으므로, 그 숫자는 CSS 한 곳에만 있다.
                   *
                   * 타입 단언이 필요한 이유는 `CSSProperties` 에 사용자 정의 속성이 없기
                   * 때문이다. React 는 `--` 로 시작하는 키를 그대로 인라인 스타일에 넣는다.
                   */}
                  <div
                    className={ui.chartCanvas}
                    style={{ '--chart-cols': chart.columns.length } as CSSProperties}
                  >
                    <div className={ui.chartArea}>
                      {chart.scale.ticks.map((tick) => (
                        <div
                          key={tick.value}
                          className={`${ui.chartRule} ${tick.value === '0' ? ui.chartRuleZero : ''}`}
                          style={{ bottom: `${tick.pos}%` }}
                        />
                      ))}

                      <div className={ui.chartCols}>
                        {chart.columns.map((column) => (
                          <div className={ui.chartGroup} key={column.line.key}>
                            {column.bars.map((bar) => (
                              <div className={ui.chartSlot} key={bar.series.key}>
                                {/*
                                 * 0 선에 붙여 자란다. 양수는 0 선에서 **위로**(`bottom`),
                                 * 음수는 0 선에서 **아래로**(`top`). 음수 막대는 계열색이
                                 * 아니라 손실색이다 — 수익 계열의 초록 막대가 0 선 아래에
                                 * 있으면 "좋은 값" 과 "나쁜 값" 이 같은 색이 된다.
                                 *
                                 * `title` 로 정확한 금액을 띄운다. 막대가 가늘어 눈으로는
                                 * 어느 줄인지 알기 어려운 상태가 실제로 생기고(30개 조회),
                                 * 그때 표까지 내려가지 않고 확인할 길이 필요하다.
                                 */}
                                <div
                                  className={`${ui.chartCol} ${
                                    bar.down
                                      ? `${ui.chartColDown} ${ui.chartColLoss}`
                                      : bar.series.tone
                                  }`}
                                  style={
                                    bar.down
                                      ? {
                                          top: `calc(100% - ${chart.scale.zero}%)`,
                                          height: barSize(bar.height),
                                        }
                                      : {
                                          bottom: `${chart.scale.zero}%`,
                                          height: barSize(bar.height),
                                        }
                                  }
                                  title={`${column.line.label || '(미지정)'} · ${bar.series.label} ${formatMoney(bar.value)}`}
                                />
                              </div>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* 가로축 라벨. 스크롤 칸 **안**에 있어야 막대와 같이 밀린다. */}
                    <div className={ui.chartXLabels}>
                      {chart.columns.map((column) => (
                        <span
                          className={ui.chartXLabel}
                          key={column.line.key}
                          title={column.line.label || '(미지정)'}
                        >
                          {/* 표의 첫 칸과 같은 규칙으로 비운 라벨을 적는다 — 아래 `(미지정)` 주석. */}
                          {column.line.label || '(미지정)'}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className={ui.chartLegend}>
                {SERIES.map((series) => (
                  <span className={ui.chartLegendItem} key={series.key}>
                    <span className={`${ui.chartSwatch} ${series.tone}`} />
                    {series.label}
                  </span>
                ))}
                {chart.anyLoss ? (
                  <span className={ui.chartLegendItem}>
                    <span className={`${ui.chartSwatch} ${ui.chartColLoss}`} />
                    손실 (원가 &gt; 매출)
                  </span>
                ) : null}
              </div>
            </figure>
          </div>
        ) : null}

        {/*
         * 기간 전체의 수익/원가 비중. 그래프 **아래**에 둔다 — 줄별 그림을 다 본 뒤에 합계로
         * 닫는 순서다(맨 위 주석).
         */}
        {result ? (
          <div className={ui.cardBody}>
            <div className={ui.shareWrap}>
              {/*
               * 분모를 막대 위 가운데에 적는다. 아래 두 퍼센트가 **무엇의** 몇 %인지를 여기서
               * 못 읽으면 비중 막대는 비율만 있고 금액이 없는 그림이 된다.
               *
               * `<div>` 인 이유는 `.shareTotal` 이 flex 이고 margin 을 쓰지 않기 때문이다.
               * `<p>` 로 두면 브라우저 기본 margin 1em 이 붙어 `.shareWrap` 의 gap 과 겹친다.
               *
               * '(일부)' 를 붙이지 않는다. 이 금액은 표시 개수와 무관한 기간 전체 합계다 —
               * 위 잘림 경고 주석 참고.
               */}
              <div className={ui.shareTotal}>
                <span className={ui.statLabel}>총 수주금액</span>
                <span className={ui.shareTotalValue}>{formatMoney(result.totals.revenue)}원</span>
              </div>

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
                  <div className={ui.shareBar}>
                    {totalLoss ? (
                      /*
                       * 원가가 수주액을 넘긴 기간. 쪼갤 수 없다 — 수익 비중이 음수이고
                       * `width: -25%` 는 CSS 가 무시하므로, 쪼개려 들면 "원가가 수주액과 딱
                       * 같다" 는 그림이 나온다. 가장 심각한 상태가 정상으로 보이는, 이 화면이
                       * 절대 하면 안 되는 거짓말이다.
                       *
                       * 조각이 하나뿐이라 대비로 읽히지 않으므로 숫자에 '원가' 를 붙인다.
                       * 120% 라는 값이야말로 이 기간에 대해 가장 중요한 사실이다.
                       */
                      <div className={ui.shareSegLoss}>
                        <span className={ui.sharePct}>원가 {costPct}%</span>
                      </div>
                    ) : (
                      <>
                        {/* 왼쪽만 너비를 받는다. 오른쪽은 남는 자리를 채운다 — ui.module.css
                            의 `.shareSegCost` 주석(반올림으로 합이 100 을 벗어나는 문제). */}
                        <div className={ui.shareSegMargin} style={{ width: barSize(marginPct) }}>
                          <span
                            className={`${ui.sharePct} ${marginInside ? '' : ui.sharePctOutRight}`}
                          >
                            {marginPct}%
                          </span>
                        </div>
                        <div className={ui.shareSegCost}>
                          <span className={`${ui.sharePct} ${costInside ? '' : ui.sharePctOutLeft}`}>
                            {costPct}%
                          </span>
                        </div>
                      </>
                    )}
                  </div>

                  {/*
                   * 막대 아래 양 끝의 금액. 왼쪽이 수익, 오른쪽이 원가 — 막대 조각의 좌우와
                   * 같은 순서이므로 어느 금액이 어느 조각의 것인지 읽을 필요가 없다.
                   *
                   * 손실 기간에는 '수익' 쪽 글자색이 손실색이다. 막대가 통째로 빨간데 그 아래
                   * 금액만 초록이면, 막대와 숫자가 서로 다른 말을 한다.
                   *
                   * 단위 '원' 을 붙인다. 위 총액과 세로축 눈금에는 붙어 있는데 여기만 빠지면,
                   * 같은 화면에서 같은 종류의 숫자가 두 가지 모습으로 적히는 셈이다 — 읽는
                   * 사람은 그 차이에 뜻이 있는지부터 의심하게 된다.
                   */}
                  <div className={ui.shareEnds}>
                    <span
                      className={`${ui.shareEnd} ${totalLoss ? ui.shareEndLoss : ui.shareEndMargin}`}
                    >
                      수익 {formatMoney(result.totals.margin)}원
                    </span>
                    <span className={`${ui.shareEnd} ${ui.shareEndCost}`}>
                      원가 {formatMoney(result.totals.cost)}원
                    </span>
                  </div>
                </>
              )}
            </div>

            {/*
             * 표시 줄 수는 `result.lines.length` 로 센다. `result.query.limit` 을 쓰지 않는
             * 이유는 서버가 그 값을 valibot 으로 **숫자**로 바꿔 되돌려 주는데 프런트 타입은
             * `string` 이기 때문이다 — 그 자리에 들어 있는 것은 타입이 말하는 것과 다르다.
             * 실제로 그려진 줄 수를 세면 그 불일치를 지나칠 수 있고, 표시 개수보다 줄이 적은
             * 경우(고객사가 7곳인데 30개 요청)에도 맞는 숫자가 나온다.
             */}
            {/*
             * `조회 시각` 이고 '집계 시각' 이 아니다.
             *
             * 리포트 화면의 이런 시각 표시는 보통 "데이터가 어디까지 반영됐는가" 를 뜻하고,
             * 야간 집계 구조에서는 실제로 그 뜻이었다. 지금은 요청마다 원본을 집계하므로
             * 반영 시점이라는 개념이 없다 — 저 시각은 이 숫자를 뽑은 시각이다. 같은 라벨에
             * 다른 뜻을 담아 두면, 오후 3시로 적힌 시각을 보고 "오후 3시까지의 매출" 이라고
             * 읽는 사람이 생긴다.
             */}
            <p className={ui.hint}>
              {result.query.from} ~ {result.query.to} · 전체 {result.totals.rows}개 행 집계 ·{' '}
              {result.lines.length}개 줄 표시 · 조회 시각 {formatDateTime(result.computedAt)}
            </p>
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
                  // 이유는 표 위의 안내가 말한다(위 주석). 여기는 표의 빈 칸을 메우는 한 줄이다.
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
