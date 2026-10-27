import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import {
  useJobs,
  useProfile,
  useProject,
  usePurchaseOrders,
} from '@/apis/queries/neotms.query'
import type { JobRow, PurchaseOrderRow } from '@/apis/neotms.types'
import { DETAIL_PAGE_SIZE, NeotmsMenuId } from '@/shared/config'
import { mayDo } from '@/shared/permissions'
import { Amount } from '@/shared/ui/Amount'
import { ErrorNotice, InfoNotice, LoadMore, SuccessNotice, TableState } from '@/shared/ui/Feedback'
import type { PickerOption } from '@/shared/ui/RecordPicker'
import { formatDate, formatDateTime, isOverdue } from '@/shared/utils/format'
import { decimalSubtract, decimalSum } from '@/shared/utils/money'
import ui from '@/shared/ui/ui.module.css'
import { JobFormModal } from '@/features/jobs/JobFormModal'
import { PurchaseOrderFormModal } from '@/features/purchaseorders/PurchaseOrderFormModal'
import { ProjectFormModal } from './ProjectFormModal'

/**
 * 프로젝트 한 건.
 *
 * ## 이 화면이 라우터를 쓰는 이유다
 *
 * 담당자들은 "이 프로젝트 좀 봐 달라" 를 주소로 전달한다. 레거시에서는 그걸 화면 캡처로
 * 주고받았다 — 캡처에는 금액이 찍혀 있지만 그 금액이 지금도 그 값인지 알 수 없다.
 *
 * ## 마진을 여기서 계산한다
 *
 * 서버에 '프로젝트 마진' 엔드포인트가 없다. 매출은 작업에, 원가는 발주에 있으므로 두 목록을
 * 읽어 합산한다. 합산은 `BigInt` 10진 연산으로 한다 — `Number` 로 더하면 0.1+0.2 문제가 그대로
 * 금액에 남고, 그 1원은 정산할 때 발견된다.
 *
 * **합계는 읽어 온 행의 합이다.** 한 프로젝트의 작업이 200건을 넘으면 첫 페이지만으로는
 * 전체가 아니고, 그때 화면은 합계 옆에 그 사실을 명시한다. 금액이 틀린 화면은 금액이 없는
 * 화면보다 나쁘다.
 *
 * ## 발주가 없는 작업을 드러낸다
 *
 * 원가가 비어 있는 작업은 마진이 100% 로 보인다. 그건 이 시스템이 만들어 내는 가장 비싼
 * 착각이므로, 작업 표에서 발주 건수를 함께 보여 주고 0건이면 표시를 남긴다.
 */
export function ProjectDetailView() {
  const { id = '' } = useParams()
  const { data: profile } = useProfile()

  const projectQuery = useProject(id || null)
  const jobsQuery = useJobs({ limit: DETAIL_PAGE_SIZE, projectId: id }, !!id)
  const posQuery = usePurchaseOrders({ limit: DETAIL_PAGE_SIZE, projectId: id }, !!id)

  const [editingProject, setEditingProject] = useState(false)
  const [editingJob, setEditingJob] = useState<JobRow | null | undefined>(undefined)
  const [editingPo, setEditingPo] = useState<PurchaseOrderRow | null | undefined>(undefined)
  /** '발주 추가' 를 누른 작업. 발주는 작업에 달리므로 어느 작업인지가 먼저 정해져야 한다. */
  const [poForJob, setPoForJob] = useState<PickerOption | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const project = projectQuery.data
  const jobs = useMemo(() => jobsQuery.data?.pages.flatMap((p) => p.items) ?? [], [jobsQuery.data])
  const pos = useMemo(() => posQuery.data?.pages.flatMap((p) => p.items) ?? [], [posQuery.data])

  const revenue = useMemo(() => decimalSum(jobs.map((j) => j.jobPriceKsum)), [jobs])
  const cost = useMemo(() => decimalSum(pos.map((p) => p.poPriceKsum)), [pos])
  const margin = useMemo(() => decimalSubtract(revenue.total, cost.total), [revenue, cost])

  /** 작업별 발주 건수. 위 주석의 "발주 없는 작업" 을 세우기 위한 것이다. */
  const poCountByJob = useMemo(() => {
    const out = new Map<string, number>()
    for (const po of pos) out.set(po.jobId, (out.get(po.jobId) ?? 0) + 1)
    return out
  }, [pos])

  const mayUpdateProject = mayDo(profile, NeotmsMenuId.PROJECT, 'update')
  const mayReadJob = mayDo(profile, NeotmsMenuId.JOB, 'read')
  const mayCreateJob = mayDo(profile, NeotmsMenuId.JOB, 'create')
  const mayUpdateJob = mayDo(profile, NeotmsMenuId.JOB, 'update')
  const mayReadPo = mayDo(profile, NeotmsMenuId.PURCHASE_ORDER, 'read')
  const mayCreatePo = mayDo(profile, NeotmsMenuId.PURCHASE_ORDER, 'create')
  const mayUpdatePo = mayDo(profile, NeotmsMenuId.PURCHASE_ORDER, 'update')

  /** 이 프로젝트를 `JobFormModal` 에 넘길 형태로. 작업 등록 시 프로젝트는 고정이다. */
  const projectOption: PickerOption | null = project
    ? {
        id: project.id,
        title: project.prjName || project.prjCode,
        subtitle: [project.prjCode, project.cusCodeName].filter(Boolean).join(' · '),
      }
    : null

  if (projectQuery.isLoading) {
    return (
      <div className={ui.page}>
        <p className={ui.placeholder}>불러오는 중…</p>
      </div>
    )
  }

  if (projectQuery.error || !project) {
    return (
      <div className={ui.page}>
        <div className={ui.pageHead}>
          <h1 className={ui.pageTitle}>프로젝트를 불러올 수 없습니다</h1>
        </div>
        <ErrorNotice error={projectQuery.error} />
        <p className={ui.pageHint}>
          <Link className={ui.btnLink} to="/projects">
            프로젝트 목록으로 돌아가기
          </Link>
        </p>
      </div>
    )
  }

  const overdue =
    isOverdue(project.prjEday) && project.prjState !== '완료' && project.prjState !== '취소'

  return (
    <div className={ui.page}>
      <div className={ui.pageHead}>
        <div>
          <p className={ui.pageHint}>
            <Link className={ui.btnLink} to="/projects">
              ← 프로젝트 목록
            </Link>
          </p>
          <h1 className={ui.pageTitle}>{project.prjName || '(이름 없음)'}</h1>
          <p className={ui.pageHint}>
            <span className={ui.cellMono}>{project.prjCode}</span>
            {project.cusCodeName ? ` · ${project.cusCodeName}` : ''}
          </p>
        </div>
        {mayUpdateProject ? (
          <button type="button" className={ui.btn} onClick={() => setEditingProject(true)}>
            프로젝트 수정
          </button>
        ) : null}
      </div>

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}

      {/*
       * 매출·원가·마진 세 숫자.
       *
       * 마진율은 보여 주지 않는다. 매출이 0 인 프로젝트(견적 단계)가 흔하고, 그때 비율은
       * 0으로 나누는 값이다 — '-' 로 두면 "계산이 안 된다" 로 읽히고, 0% 로 두면 거짓이다.
       */}
      <div className={ui.statGrid}>
        <div className={ui.stat}>
          <span className={ui.statLabel}>매출 (작업 {revenue.counted}건)</span>
          <span className={ui.statValue}>
            <Amount value={revenue.total} kind="revenue" />
          </span>
        </div>
        <div className={ui.stat}>
          <span className={ui.statLabel}>원가 (발주 {cost.counted}건)</span>
          <span className={ui.statValue}>
            <Amount value={cost.total} kind="cost" />
          </span>
        </div>
        <div className={ui.stat}>
          <span className={ui.statLabel}>마진</span>
          <span className={ui.statValue}>
            <Amount value={margin} kind="margin" />
          </span>
        </div>
      </div>

      {/*
       * 합계가 전체가 아닐 수 있는 두 가지 경우를 각각 말한다.
       *
       * 하나는 금액이 비어 있는 행(`skipped`), 다른 하나는 아직 안 읽은 페이지(`hasNextPage`).
       * 둘 다 합계를 실제보다 작게 만들고, 마진은 그 반대 방향으로 틀린다.
       */}
      {revenue.skipped > 0 || cost.skipped > 0 ? (
        <InfoNotice>
          금액이 입력되지 않은 행이 있습니다 — 작업 {revenue.skipped}건, 발주 {cost.skipped}건.
          위 합계에서 제외되었으므로 마진은 실제와 다릅니다.
        </InfoNotice>
      ) : null}

      {jobsQuery.hasNextPage || posQuery.hasNextPage ? (
        <InfoNotice>
          이 프로젝트의 하위 건수가 한 페이지를 넘습니다. 아래 '더 보기' 를 눌러 전부 불러온 뒤의
          합계가 전체 합계입니다.
        </InfoNotice>
      ) : null}

      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <span>프로젝트 정보</span>
        </div>
        <div className={ui.cardBody}>
          <div className={ui.detailGrid}>
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>진행 상태</span>
              <span className={ui.detailValue}>{project.prjState || '-'}</span>
            </div>
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>세금계산서</span>
              <span className={ui.detailValue}>
                {project.prjInvoiceState || '-'}
                {project.invCode ? ` (${project.invCode})` : ''}
              </span>
            </div>
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>입금</span>
              <span className={ui.detailValue}>{project.prjMoneyState || '-'}</span>
            </div>
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>통화</span>
              <span className={ui.detailValue}>{project.coinCode || '-'}</span>
            </div>
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>시작일</span>
              <span className={ui.detailValue}>
                {formatDate(project.prjSday)}
                {project.prjSdayTime ? ` ${project.prjSdayTime}` : ''}
              </span>
            </div>
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>납기</span>
              <span className={`${ui.detailValue} ${overdue ? ui.amountNeg : ''}`.trim()}>
                {formatDate(project.prjEday)}
                {project.prjEdayTime ? ` ${project.prjEdayTime}` : ''}
                {overdue ? ' (지남)' : ''}
              </span>
            </div>
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>영업담당 / PM</span>
              <span className={ui.detailValue}>
                {[project.prjMgrName, project.prjPmName].filter(Boolean).join(' / ') || '-'}
              </span>
            </div>
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>고객사 담당자</span>
              <span className={ui.detailValue}>{project.cusMgrName || '-'}</span>
            </div>
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>분야</span>
              <span className={ui.detailValue}>
                {[project.prjField, project.prjField2].filter(Boolean).join(' · ') || '-'}
              </span>
            </div>
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>최종 수정</span>
              <span className={ui.detailValue}>{formatDateTime(project.updatedAt)}</span>
            </div>
          </div>

          {project.prjContent ? (
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>내용</span>
              <span className={ui.detailValue}>{project.prjContent}</span>
            </div>
          ) : null}
        </div>
      </div>

      {/* ── 작업 ─────────────────────────────────────────────────────────── */}

      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <span>작업 {jobs.length}건 — 매출</span>
          <span className={ui.spacer} />
          {mayCreateJob ? (
            <button
              type="button"
              className={`${ui.btn} ${ui.btnSm}`}
              onClick={() => setEditingJob(null)}
            >
              작업 추가
            </button>
          ) : null}
        </div>

        {!mayReadJob ? (
          <div className={ui.cardBody}>
            <p className={ui.hint}>작업 조회 권한이 없어 이 프로젝트의 매출을 볼 수 없습니다.</p>
          </div>
        ) : (
          <>
            <div className={`${ui.cardBodyFlush} ${ui.tableWrap}`}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>코드</th>
                    <th>작업명</th>
                    <th>언어쌍</th>
                    <th>물량 · 단가</th>
                    <th>매출(원화)</th>
                    <th>발주</th>
                    <th>납기</th>
                    <th>상태</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <TableState
                    isLoading={jobsQuery.isLoading}
                    error={jobsQuery.error}
                    isEmpty={jobs.length === 0}
                    emptyText="이 프로젝트에는 작업이 없습니다. 작업을 추가하면 매출이 잡힙니다."
                    colSpan={9}
                  />
                  {jobs.map((job) => {
                    const poCount = poCountByJob.get(job.id) ?? 0
                    return (
                      <tr key={job.id}>
                        <td className={ui.cellMono}>{job.jobCode}</td>
                        <td>{job.jobName || '(이름 없음)'}</td>
                        <td className={ui.cellMuted}>
                          {[job.jobSlang, job.jobElang].filter(Boolean).join(' → ') || '-'}
                        </td>
                        <td className={ui.cellMuted}>
                          <div>
                            {job.jobVolume ?? '-'} {job.unitCode ?? ''}
                          </div>
                          <div>
                            <Amount value={job.jobPrice} coinCode={job.coinCode} />
                          </div>
                        </td>
                        <td>
                          <Amount value={job.jobPriceKsum} kind="revenue" />
                        </td>
                        <td>
                          {poCount > 0 ? (
                            <span className={ui.badge}>{poCount}건</span>
                          ) : (
                            // 원가가 없는 작업. 마진이 과대계상된 상태다 — 위 주석 참고.
                            <span className={`${ui.badge} ${ui.badgeWarn}`}>없음</span>
                          )}
                        </td>
                        <td
                          className={
                            isOverdue(job.jobEday) &&
                            job.jobState !== '완료' &&
                            job.jobState !== '취소'
                              ? ui.amountNeg
                              : ui.cellMuted
                          }
                        >
                          {formatDate(job.jobEday)}
                        </td>
                        <td>
                          <span
                            className={`${ui.badge} ${job.jobState === '진행' ? ui.badgePrimary : ''}`}
                          >
                            {job.jobState || '-'}
                          </span>
                        </td>
                        <td>
                          <div className={ui.rowActions}>
                            {mayUpdateJob ? (
                              <button
                                type="button"
                                className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
                                onClick={() => setEditingJob(job)}
                              >
                                수정
                              </button>
                            ) : null}
                            {mayCreatePo ? (
                              <button
                                type="button"
                                className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
                                onClick={() => {
                                  setPoForJob({
                                    id: job.id,
                                    title: job.jobName || job.jobCode,
                                    subtitle: job.jobCode,
                                  })
                                  setEditingPo(null)
                                }}
                              >
                                발주 추가
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <LoadMore
              hasNextPage={!!jobsQuery.hasNextPage}
              isFetchingNextPage={jobsQuery.isFetchingNextPage}
              onClick={() => void jobsQuery.fetchNextPage()}
            />
          </>
        )}
      </div>

      {/* ── 발주 ─────────────────────────────────────────────────────────── */}

      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <span>발주 {pos.length}건 — 원가</span>
        </div>

        {!mayReadPo ? (
          <div className={ui.cardBody}>
            <p className={ui.hint}>발주 조회 권한이 없어 이 프로젝트의 원가를 볼 수 없습니다.</p>
          </div>
        ) : (
          <>
            <div className={`${ui.cardBodyFlush} ${ui.tableWrap}`}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    <th>코드</th>
                    <th>발주명</th>
                    <th>작업</th>
                    <th>번역가</th>
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
                    isEmpty={pos.length === 0}
                    emptyText="이 프로젝트에는 발주가 없습니다. 원가가 비어 있으므로 위 마진은 매출과 같습니다."
                    colSpan={9}
                  />
                  {pos.map((po) => (
                    <tr key={po.id}>
                      <td className={ui.cellMono}>{po.poCode}</td>
                      <td>{po.poName || '(이름 없음)'}</td>
                      <td className={ui.cellMuted}>{po.jobName || po.jobCode || '-'}</td>
                      <td>
                        {po.poTranName ? (
                          po.poTranName
                        ) : (
                          <span className={`${ui.badge} ${ui.badgeWarn}`}>미지정</span>
                        )}
                      </td>
                      <td>
                        <Amount value={po.poPriceKsum} kind="cost" />
                      </td>
                      <td
                        className={
                          isOverdue(po.poEday) && po.poState !== '완료' && po.poState !== '취소'
                            ? ui.amountNeg
                            : ui.cellMuted
                        }
                      >
                        {formatDate(po.poEday)}
                      </td>
                      <td>
                        <span
                          className={`${ui.badge} ${po.poState === '진행' ? ui.badgePrimary : ''}`}
                        >
                          {po.poState || '-'}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`${ui.badge} ${
                            po.poMoneyState === '정산완료'
                              ? ui.badgeSuccess
                              : po.poMoneyState === '미정산'
                                ? ui.badgeWarn
                                : ''
                          }`}
                        >
                          {po.poMoneyState || '-'}
                        </span>
                      </td>
                      <td>
                        <div className={ui.rowActions}>
                          {mayUpdatePo ? (
                            <button
                              type="button"
                              className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
                              onClick={() => {
                                setPoForJob(null)
                                setEditingPo(po)
                              }}
                            >
                              수정
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
          </>
        )}
      </div>

      {editingProject ? (
        <ProjectFormModal
          project={project}
          onClose={() => setEditingProject(false)}
          onSaved={setNotice}
        />
      ) : null}

      {editingJob !== undefined ? (
        <JobFormModal
          job={editingJob}
          fixedProject={projectOption}
          onClose={() => setEditingJob(undefined)}
          onSaved={setNotice}
        />
      ) : null}

      {editingPo !== undefined ? (
        <PurchaseOrderFormModal
          purchaseOrder={editingPo}
          fixedJob={poForJob}
          onClose={() => {
            setEditingPo(undefined)
            setPoForJob(null)
          }}
          onSaved={setNotice}
        />
      ) : null}
    </div>
  )
}
