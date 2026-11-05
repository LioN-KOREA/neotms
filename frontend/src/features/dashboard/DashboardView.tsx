import { Link } from 'react-router'
import { PROJECT_STATE_ACTIVE } from '@/apis/neotms.codes'
import type { DashboardRole } from '@/apis/neotms.types'
import { useDashboard, useProfile, useProjects } from '@/apis/queries/neotms.query'
import { ErrorNotice, InfoNotice, TableState } from '@/shared/ui/Feedback'
import { ShareBar } from '@/shared/ui/ShareBar'
import { StatusChip } from '@/shared/ui/StatusChip'
import { formatDate, isOverdue } from '@/shared/utils/format'
import ui from '@/shared/ui/ui.module.css'

/**
 * 내 프로젝트 현황.
 *
 * ## 한 화면을 역할 둘이 쓴다
 *
 * '내 프로젝트' 의 정의가 역할마다 다르다 — 영업은 `prj_mgr_id`, PM 은 `prj_pm_id` 다. 그
 * **한 가지**만 다르고 타일 넷과 금액 셋은 완전히 같으므로, 화면을 둘로 복사하지 않고 `role`
 * 을 받는다. 복사했다면 둘 중 하나에만 반영되는 수정이 생기고, 그 어긋남은 "영업 대시보드와
 * PM 대시보드의 숫자가 다르다" 로 보인다 — 그건 **원래 달라야 하는 것**이라서 아무도 버그로
 * 의심하지 않는다.
 *
 * 역할은 서버에도 그대로 넘어가고(`?as=`), 캐시 키에도 들어간다. 그래서 탭을 옮길 때 옆 역할의
 * 숫자가 잠깐 그려지지 않는다.
 *
 * ## 타일 셋은 서로 겹친다 — 그 사실을 적는다
 *
 * 납기가 지난 진행 프로젝트는 진행이면서 동시에 지연이다. 셋은 같은 집합에 던지는 세 질문이고
 * 집합의 분할이 아니므로 **합이 전체와 같지 않다.** 적어 두지 않으면, 세 숫자를 더해 본 사람이
 * 발견하는 것은 "대시보드의 숫자가 안 맞는다" 이고 그 순간 맞는 숫자까지 같이 버려진다.
 *
 * ## 0 을 좋은 소식으로 읽게 두지 않는다
 *
 * `prj_state` 는 제약이 없는 자유 텍스트이고, 이 앱이 아는 다섯 값은 아직 **잠정**이다
 * (neotms.codes.ts / 서버의 NeotmsProjectStates.ts). 운영 데이터의 어휘가 다르면 타일은 오류
 * 없이 0 을 가리키는데, 0 을 가리키는 타일은 좋은 소식으로 읽힌다. 서버가 그래서 분류하지 못한
 * 건수를 같이 내려주고, 이 화면은 그 값이 0 보다 클 때 경고를 띄운다 — 그 한 줄이 '정말 없음'
 * 과 '못 세었음' 을 가른다.
 *
 * ## 금액은 기간 제한이 없다
 *
 * 리포트는 기간을 받아야만 집계하지만(가장 비싼 쿼리라서), 여기는 집합이 소유 조건으로 이미 한
 * 사람 몫으로 묶여 있어 전체를 집계해도 싸다. 그래서 라벨에 **'전체'** 를 박는다. 기간이 없는
 * 금액을 기간이 있는 금액처럼 적어 두면, 리포트의 이번 달 수치와 맞지 않는다는 문의가 된다.
 *
 * ## 목록은 대시보드 쿼리가 아니라 프로젝트 목록을 다시 쓴다
 *
 * 아래 '나의 진행중인 프로젝트' 표는 서버의 프로젝트 목록 엔드포인트를 `salesManagerId`
 * 또는 `pmId` + `state` 로 걸러 읽는다. 대시보드 응답에 행 목록을 끼워 넣지 않은 이유는, 그
 * 표에 필요한 열(고객사명·담당자명·상태칩)이 이미 `ProjectRow` 에 다 있고 그 조인을 서버에서
 * 한 번 더 쓰면 같은 SQL 이 두 벌이 되기 때문이다. 집계는 집계 엔드포인트가, 행은 목록
 * 엔드포인트가 한다.
 */

interface DashboardViewProps {
  role: DashboardRole
}

/** 화면 제목. 역할마다 '내 프로젝트' 의 뜻이 다르므로 제목이 그것을 밝혀야 한다. */
const ROLE_TITLE: Record<DashboardRole, string> = {
  sales: '대시보드(영업)',
  pm: '대시보드(PM)',
}

/** '내 것' 의 근거. 제목 아래 한 줄로 적는다 — 두 대시보드의 숫자가 다른 이유가 이것뿐이다. */
const ROLE_BASIS: Record<DashboardRole, string> = {
  sales: '내 프로젝트(영업 담당자용)',
  pm: '내 프로젝트(PM용)',
}

/**
 * 아래 표에 담을 줄 수. 목록 화면들의 `LIST_PAGE_SIZE`(50) 를 쓰지 않는다.
 *
 * 이 표는 **대시보드의 일부**이고 대시보드는 한 화면에 들어와야 한다. 50줄을 받으면 금액 막대가
 * 스크롤 두 번 아래로 밀려나는데, 그 막대는 사용자가 이 화면에 온 이유의 절반이다. 반대로 더
 * 줄이면(열 줄 이하) 진행 프로젝트가 스무 건인 사람에게는 표가 거의 쓸모가 없어진다.
 *
 * 이 숫자는 머리글에 그대로 적힌다. '더 보기' 가 없는 표에서 상한을 숨기면, 마지막 줄 다음이
 * **없는 것인지 잘린 것인지** 구별할 방법이 없다 — 그 구별이 안 되는 표는 "내 진행 프로젝트는
 * 이게 전부" 라는 틀린 결론을 만든다.
 */
const ACTIVE_ROWS = 20

export function DashboardView({ role }: DashboardViewProps) {
  const { data: profile } = useProfile()
  const summaryQuery = useDashboard(role)
  const summary = summaryQuery.data

  /*
   * 목록 쪽 필터. 역할에 따라 **다른 컬럼**으로 거른다 — 위 집계가 쓰는 것과 같은 정의여야
   * 한다. 한쪽만 고치면 타일의 '진행 3건' 아래에 5줄짜리 표가 붙는다.
   *
   * `staffId` 가 없는 계정(등록 대기)에서는 목록을 읽지 않는다. 빈 문자열을 보내면 서버는
   * 그것을 "필터 없음" 으로 읽고 **남의 프로젝트를 포함한** 목록을 돌려주므로, 조건을 끄는
   * 것이 아니라 조건을 뒤집는 셈이 된다(열람 범위가 '전부' 인 관리자에서 특히).
   */
  const staffId = profile?.staffId
  const ownerFilter = role === 'sales' ? { salesManagerId: staffId } : { pmId: staffId }
  /*
   * 정렬을 **명시한다.** 서버의 기본값은 `created` 내림차순(NeotmsProjectManager 의
   * `readListQuery(request, PROJECT_SORTS, "created")`)이므로, 보내지 않으면 최근에 만든 순으로
   * 스무 건이 잘린다 — 그러면 다음 주가 납기인 프로젝트가 표에서 빠지고, 작년에 등록한
   * 프로젝트가 남는다. 머리글에 '납기일 빠른 순' 이라고 적을 수 있는 근거가 이 두 줄이다.
   *
   * `due` 는 `p.prj_eday` 이고 nullable 이어서 서버가 nulls-last 로 정렬한다
   * (PROJECT_SORTS 의 주석). 납기 미정 프로젝트가 맨 위를 차지하지 않는다는 뜻이고, 이 표에서는
   * 그게 맞는 순서다.
   */
  const projectsQuery = useProjects(
    { ...ownerFilter, state: PROJECT_STATE_ACTIVE, limit: ACTIVE_ROWS, sort: 'due', dir: 'asc' },
    !!staffId,
  )
  const rows = projectsQuery.data?.pages.flatMap((p) => p.items) ?? []

  /** 건수 한 칸. 값이 아직 없으면 `…` 다 — 0 으로 두면 '없음' 이라는 **틀린 사실**이 된다. */
  const count = (value: number | undefined): string =>
    value === undefined ? '…' : `${value}건`

  return (
    <div className={ui.page}>
      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <span>{ROLE_TITLE[role]}</span>
          <span className={ui.hint}>{ROLE_BASIS[role]}</span>
        </div>

        <div className={ui.cardBody}>
          <ErrorNotice error={summaryQuery.error} />

          {/*
           * 분류하지 못한 상태값 경고. 타일 **위**에 둔다 — 아래에 두면 숫자를 먼저 읽고 믿은
           * 다음에 경고를 읽게 되고, 그때는 이미 늦다.
           */}
          {summary && summary.unrecognisedState > 0 ? (
            <InfoNotice>
              내 프로젝트 {summary.unrecognisedState}건의 진행 상태가 이 화면이 아는 값(견적 ·
              진행 · 완료 · 보류 · 취소)이 아닙니다. 아래 <strong>진행 · 보류 건수는 그만큼
              적게 세어졌습니다</strong> — 프로젝트의 진행 상태를 확인해 주세요.
            </InfoNotice>
          ) : null}

          <div className={ui.statGrid}>
            <div className={ui.stat}>
              <span className={ui.statLabel}>내 프로젝트 전체</span>
              <span className={ui.statValue}>{count(summary?.projects)}</span>
            </div>
            <div className={`${ui.stat} ${ui.statOk}`}>
              <span className={ui.statLabel}>진행중</span>
              <span className={ui.statValue}>{count(summary?.inProgress)}</span>
            </div>
            {/*
             * 지연 건수에만 글자색을 준다. 그리고 **0건일 때는 주지 않는다** — 0건을 주황으로
             * 적으면 아무 문제가 없는 상태가 경고로 읽히고, 그게 반복되면 색 자체가 무시된다.
             */}
            <div className={`${ui.stat} ${ui.statWarn}`}>
              <span className={ui.statLabel}>납기지연</span>
              <span
                className={`${ui.statValue} ${summary && summary.overdue > 0 ? ui.statValueWarn : ''}`}
              >
                {count(summary?.overdue)}
              </span>
            </div>
            <div className={`${ui.stat} ${ui.statInfo}`}>
              <span className={ui.statLabel}>보류</span>
              <span className={ui.statValue}>{count(summary?.onHold)}</span>
            </div>
          </div>
        </div>

        {/*
         * 금액. 라벨에 '전체' 가 들어가는 이유는 위 머리 주석에 있다 — 기간 제한이 없는 금액이다.
         *
         * 리포트와 **같은 막대, 같은 색**을 쓴다. 두 화면이 같은 종류의 숫자를 다른 그림으로
         * 보여 주면, 읽는 사람은 그 차이에 뜻이 있는지부터 의심한다.
         */}
        {summary ? (
          <div className={ui.cardBody}>
            <ShareBar
              total={summary.revenue}
              margin={summary.margin}
              cost={summary.cost}
              totalLabel="내 프로젝트 전체 수주금액"
              emptyHint="현재 프로젝트 매출이 없습니다."
            />
          </div>
        ) : null}
      </div>

      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <span>나의 진행중인 프로젝트</span>
          {/* 왜 상한을 머리글에 적는지는 ACTIVE_ROWS 의 주석에 있다. */}
          <span className={ui.hint}>{ACTIVE_ROWS}건 (마감일 순)</span>
        </div>

        <div className={`${ui.cardBodyFlush} ${ui.tableWrap}`}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>코드</th>
                <th>프로젝트명</th>
                <th>고객사</th>
                <th>기간</th>
                <th>진행</th>
              </tr>
            </thead>
            <tbody>
              <TableState
                isLoading={projectsQuery.isLoading}
                error={projectsQuery.error}
                isEmpty={rows.length === 0}
                emptyText={
                  staffId
                    ? '진행중인 프로젝트가 없습니다.'
                    : '계정이 아직 승인되지 않아 목록을 읽을 수 없습니다.'
                }
                colSpan={5}
              />
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className={ui.cellMono}>{row.prjCode}</td>
                  <td>
                    <Link className={ui.btnLink} to={`/projects/${row.id}`}>
                      {row.prjName || '(이름 없음)'}
                    </Link>
                  </td>
                  <td>{row.cusCodeName || '-'}</td>
                  {/*
                   * 지난 납기를 붉게. 이 표는 진행 프로젝트만 담으므로 완료·취소 예외가 필요
                   * 없고, 그래서 목록 화면들의 `state !== '완료' && state !== '취소'` 가 여기에는
                   * 없다 — 조건을 빼먹은 것이 아니라 들어올 수 없는 행이다.
                   */}
                  <td className={ui.cellMuted}>
                    <div>{formatDate(row.prjSday)} →</div>
                    <div className={isOverdue(row.prjEday) ? ui.amountNeg : undefined}>
                      {formatDate(row.prjEday)}
                      {row.prjEdayTime ? ` ${row.prjEdayTime}` : ''}
                    </div>
                  </td>
                  <td>
                    <StatusChip value={row.prjState} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/*
         * '더 보기' 를 두지 않는다. 이 표는 **대시보드의 일부**이고, 여기서 목록을 끝까지 넘기는
         * 사람은 프로젝트 목록 화면을 원하는 것이다. 그 화면에는 걸러내기와 정렬과 '더 보기' 가
         * 다 있으므로, 같은 기능을 반쪽으로 다시 만들지 않고 링크로 보낸다.
         */}
        <div className={ui.cardBody}>
          <Link className={ui.btnLink} to="/projects">
            프로젝트 목록에서 전체 보기 →
          </Link>
        </div>
      </div>
    </div>
  )
}
