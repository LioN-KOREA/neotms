import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import {
  useCodeNames,
  useJobs,
  useProfile,
  useProject,
  usePurchaseOrders,
} from '@/apis/queries/neotms.query'
import {
  useApprovePurchaseOrder,
  useCreateJob,
  useCreatePurchaseOrder,
  useDeleteJob,
  useDeletePurchaseOrder,
  useUpdateJob,
  useUpdatePurchaseOrder,
} from '@/apis/queries/neotms.mutation'
import { CODE_DOMAIN, codeOptions, JOB_STATES, PO_STATES } from '@/apis/neotms.codes'
import {
  PROJECT_ACCEPTANCE_ASSIGNED,
  type JobRow,
  type PurchaseOrderRow,
} from '@/apis/neotms.types'
import { DETAIL_PAGE_SIZE } from '@/shared/config'
import { useRowSelection } from '@/shared/hooks/useRowSelection'
import { may } from '@/shared/permissions'
import {
  NEOTMS_PERMISSION_JOB_CREATE,
  NEOTMS_PERMISSION_JOB_DELETE,
  NEOTMS_PERMISSION_JOB_READ,
  NEOTMS_PERMISSION_JOB_UPDATE,
  NEOTMS_PERMISSION_PO_APPROVE,
  NEOTMS_PERMISSION_PO_CREATE,
  NEOTMS_PERMISSION_PO_DELETE,
  NEOTMS_PERMISSION_PO_READ,
  NEOTMS_PERMISSION_PO_UPDATE,
  NEOTMS_PERMISSION_PROJECT_UPDATE,
} from '@/apis/neotms.authorities'
import { Amount } from '@/shared/ui/Amount'
import { ErrorNotice, InfoNotice, LoadMore, SuccessNotice, TableState } from '@/shared/ui/Feedback'
import { Icon } from '@/shared/ui/Icon'
import {
  InlineDateCell,
  InlinePickerCell,
  InlineSelectCell,
  InlineTextCell,
} from '@/shared/ui/InlineEditCell'
import type { PickerOption } from '@/shared/ui/RecordPicker'
import { AcceptanceChip, ApprovalChip, StatusChip } from '@/shared/ui/StatusChip'
import { describeBulk, runSequential } from '@/shared/utils/bulk'
import { formatDate, formatDateTime, isOverdue } from '@/shared/utils/format'
import { decimalPercent, decimalSubtract, decimalSum, krwToShow } from '@/shared/utils/money'
import ui from '@/shared/ui/ui.module.css'
import {
  ALL_ALREADY_APPROVED,
  approvalPrompt,
  unapprovedOf,
} from '@/features/payment/poBulkApprove'
import { duplicateJobInput } from '@/features/jobs/jobDuplicate'
import { JobFormModal } from '@/features/jobs/JobFormModal'
import { ProjectAcceptanceModal } from './ProjectAcceptanceModal'
import { JobTypeSwapModal, jobTypeSummary } from '@/features/jobs/JobTypeSwapModal'
import { PoDocButtons, type PoPrintRequest } from '@/features/payment/print/PoDocButtons'
import { PoPrintModal } from '@/features/payment/print/PoPrintModal'
import { duplicatePurchaseOrderInput } from '@/features/purchaseorders/poDuplicate'
import { PurchaseOrderFormModal } from '@/features/purchaseorders/PurchaseOrderFormModal'
import {
  mayChangeTranslator,
  translatorLockReason,
  TranslatorSwapModal,
} from '@/features/purchaseorders/TranslatorSwapModal'
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
 * 서버에 '프로젝트 마진' 엔드포인트가 없다. 매출은 작업에, 원가는 PO에 있으므로 두 목록을
 * 읽어 합산한다. 합산은 `BigInt` 10진 연산으로 한다 — `Number` 로 더하면 0.1+0.2 문제가 그대로
 * 금액에 남고, 그 1원은 정산할 때 발견된다.
 *
 * **합계는 읽어 온 행의 합이다.** 한 프로젝트의 작업이 200건을 넘으면 첫 페이지만으로는
 * 전체가 아니고, 그때 화면은 합계 옆에 그 사실을 명시한다. 금액이 틀린 화면은 금액이 없는
 * 화면보다 나쁘다.
 *
 * ## PO가 없는 작업을 드러낸다
 *
 * 원가가 비어 있는 작업은 마진이 100% 로 보인다. 그건 이 시스템이 만들어 내는 가장 비싼
 * 착각이므로, 작업 표에서 PO 건수를 함께 보여 주고 0건이면 표시를 남긴다.
 *
 * ## 두 표가 **편집 가능한 표**다
 *
 * 다른 목록 화면과 달리 여기서는 체크박스로 여러 건을 골라 한꺼번에 지우거나 복제할 수 있고,
 * 이름·납기·상태는 칸을 두 번 눌러 바로 고칠 수 있다. 이 화면만 그런 이유가 있다.
 *
 * 프로젝트 한 건의 작업들은 **서로 같은 종류의 일**이다. 같은 고객사, 같은 언어쌍, 비슷한 단가
 * 이고, 그래서 담당자가 하는 일도 묶음 단위다 — 작업 열 건을 만들고(복제), 납기를 하루씩
 * 미루고, 끝난 것들을 '완료' 로 바꾼다. 그 묶음을 모달로 처리하면 건당 네 번씩 클릭하게 되고,
 * 더 비싼 것은 열려 있는 모달이 **금액 칸까지 들고 있다**는 점이다: 상태만 바꾸려고 열었다가
 * 환산 금액을 건드려 저장하는 사고가 그 자리에서 난다. 제자리 수정은 바뀐 한 칸만 보낸다
 * (`InlineEditCell`).
 *
 * 반대로 작업 목록·발주 목록 화면은 여러 프로젝트가 섞여 있어 묶음 조작의 뜻이 약하고, 거기서
 * 서른 건을 한꺼번에 지우는 버튼은 안전장치가 아니라 사고 장치다. 그래서 **체크박스와 일괄
 * 조작은 이 화면에만** 있다.
 *
 * 제자리 수정은 그렇지 않다. 한 칸만 보내는 것은 어느 화면에서나 같은 이유로 안전하므로, 발주
 * 목록에도 번역가 칸 하나가 제자리 수정으로 열려 있다(그쪽 머리말 — 그 화면에서 왜 그 칸
 * **하나만** 인지가 적혀 있다). 두 성질을 한 문단에서 같이 정당화했던 것이 전에 이 자리에
 * 있었고, 그 논거는 묶음 조작에만 들어맞았다.
 */
export function ProjectDetailView() {
  const { id = '' } = useParams()
  const { data: profile } = useProfile()

  const projectQuery = useProject(id || null)
  const jobsQuery = useJobs({ limit: DETAIL_PAGE_SIZE, projectId: id }, !!id)
  const posQuery = usePurchaseOrders({ limit: DETAIL_PAGE_SIZE, projectId: id }, !!id)

  const deleteJob = useDeleteJob()
  const deletePo = useDeletePurchaseOrder()
  const approvePo = useApprovePurchaseOrder()
  const createJob = useCreateJob()
  const createPo = useCreatePurchaseOrder()
  const updateJob = useUpdateJob()
  const updatePo = useUpdatePurchaseOrder()

  /** 업무 분류 코드를 이름으로. 작업 표에서 쓴다 — 작업 목록 화면과 같은 처리다. */
  const categoryName = useCodeNames(CODE_DOMAIN.JOBCAT)
  /*
   * 분야 두 칸도 코드가 아니라 이름으로 읽는다. **도메인이 서로 다르다** — 분야(`prjField`)는
   * `PRJCAT`(큰 분류 일곱 개), 세부 분야(`prjField2`)는 `FIELD`(열여덟 개)에서 고른다. 한
   * 함수로 둘을 다 찾으면 상대 도메인의 코드가 이름을 못 찾고 코드로 떨어지므로, 고치기 전과
   * 똑같이 보이는 칸이 하나 남는다. 그 사정은 `NeotmsCodeDomain` 의 `PRJCAT` 주석에 있다.
   */
  const fieldName = useCodeNames(CODE_DOMAIN.PRJCAT)
  const subFieldName = useCodeNames(CODE_DOMAIN.FIELD)

  const [editingProject, setEditingProject] = useState(false)
  /*
   * Which answer the dialog is open for: true accepting, false rejecting, null closed.
   *
   * One state rather than two booleans, because the two are mutually exclusive by nature - nobody
   * is accepting and rejecting at once - and two flags would make that an invariant somebody has to
   * maintain instead of one the type states.
   */
  const [answering, setAnswering] = useState<boolean | null>(null)
  const [editingJob, setEditingJob] = useState<JobRow | null | undefined>(undefined)
  const [editingPo, setEditingPo] = useState<PurchaseOrderRow | null | undefined>(undefined)
  /** 'PO 추가' 를 누른 작업. PO는 작업에 달리므로 어느 작업인지가 먼저 정해져야 한다. */
  const [poForJob, setPoForJob] = useState<PickerOption | null>(null)
  /** 지금 뽑으려는 PO 문서와 그 서식. 모달은 화면 밑단에 하나만 둔다 — `PoDocButtons` 주석. */
  const [printing, setPrinting] = useState<PoPrintRequest | null>(null)
  /** 번역가를 바꾸려고 연 발주. 같은 이유로 행이 아니라 화면이 들고 있다. */
  const [swapping, setSwapping] = useState<PurchaseOrderRow | null>(null)
  /**
   * 업무 구분을 바꾸려고 연 작업. `editingJob`(서식)과 따로 두는 이유는 두 대화상자가 **다른
   * 것을 저장**하기 때문이다 — 서식은 작업의 모든 칸을, 이쪽은 구분과 그에 딸린 값만 보낸다.
   */
  const [swappingType, setSwappingType] = useState<JobRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /**
   * 일괄 작업 중 **첫 번째** 실패의 오류.
   *
   * 뮤테이션 훅의 `error` 를 그대로 쓸 수 없다. 순차로 열 건을 돌리면 마지막 건이 성공하는
   * 순간 훅의 `error` 가 지워지고(react-query 가 호출마다 상태를 덮는다), 중간에 실패한 세
   * 건의 이유가 화면에서 사라진다. 요약 문장은 "3건 실패" 라고 적혀 있는데 왜인지는 어디에도
   * 없는 상태가 된다.
   */
  const [bulkError, setBulkError] = useState<unknown>(null)

  const project = projectQuery.data
  const jobs = useMemo(() => jobsQuery.data?.pages.flatMap((p) => p.items) ?? [], [jobsQuery.data])
  const pos = useMemo(() => posQuery.data?.pages.flatMap((p) => p.items) ?? [], [posQuery.data])

  /*
   * 매출·원가·마진. 저장된 금액이 아니라 **지금 시점의 가치**를 더한다 — 이유는 `krwToShow` 에
   * 적혀 있고, 여기서는 하나 더 있다: 마진은 이 둘의 차이다. 한쪽만 현 시세로 계산하면 마진이
   * 어느 시점의 숫자도 아닌 값이 된다.
   */
  const revenue = useMemo(
    () => decimalSum(jobs.map((j) => krwToShow(j.jobPriceKrw, j.jobPriceKsum))),
    [jobs],
  )
  const cost = useMemo(
    () => decimalSum(pos.map((p) => krwToShow(p.poPriceKrw, p.poPriceKsum))),
    [pos],
  )
  const margin = useMemo(() => decimalSubtract(revenue.total, cost.total), [revenue, cost])

  /**
   * 수익률 = 수익 ÷ 매출. **매출이 0 이면 `null` 이고, 그 null 을 숫자로 바꾸지 않는다.**
   *
   * 전에는 이 줄이 없었고, 없는 이유를 "매출이 0 인 프로젝트(견적 단계)가 흔하고 그때 비율은
   * 0 으로 나누는 값이다" 라고 적어 두었다. 그 관찰은 지금도 맞지만 결론이 과했다 — 0 으로
   * 나누는 경우가 **있다**는 것이 비율 자체를 보여 주지 않을 이유는 아니다. 담당자가 수익
   * 금액만 보고 하는 일은 그 금액을 매출로 나누는 것이고, 그 나눗셈을 머릿속에서 하면 틀린다.
   *
   * 대신 못 세는 경우를 숫자로 둔갑시키지 않는다. `decimalPercent` 가 분모 0 에서 `null` 을
   * 돌려주므로(그쪽 주석), 그때 화면은 퍼센트 대신 **왜 못 세는지**를 적는다. 0% 로 적으면
   * 거짓이고, '-' 로 적으면 "계산이 안 되는 화면" 으로 읽힌다 — 셋 중 문장만이 사실이다.
   *
   * 원가가 매출을 넘긴 프로젝트에서는 음수다. 깎지 않는다. 그 음수가 이 화면이 알려 줄 수 있는
   * 가장 중요한 사실이고, 같은 판단이 `decimalPercent` 머리말에도 적혀 있다.
   */
  const marginRate = useMemo(() => decimalPercent(margin, revenue.total), [margin, revenue])

  /*
   * 두 표의 선택. 저장은 id 로 하고 **읽을 때 현재 행과 교집합**을 낸다 — 왜 그래야 하는지는
   * `useRowSelection` 에 적혀 있다. 요점은 이 화면에서 행이 실제로 사라진다는 것이다(일괄
   * 삭제가 지우고 '더 보기' 가 늘린다).
   */
  const jobSel = useRowSelection(jobs)
  const poSel = useRowSelection(pos)

  /** 작업별 PO 건수. 위 주석의 "PO 없는 작업" 을 세우기 위한 것이다. */
  const poCountByJob = useMemo(() => {
    const out = new Map<string, number>()
    for (const po of pos) out.set(po.jobId, (out.get(po.jobId) ?? 0) + 1)
    return out
  }, [pos])

  const mayUpdateProject = may(profile, NEOTMS_PERMISSION_PROJECT_UPDATE)
  /*
   * Is the person reading this the PM the project is assigned to?
   *
   * Compared on `staffId`, not on the name: two people can share a name, the names on `project` are
   * denormalised copies that can lag a rename, and `prjPmId` is the column the server's own test
   * uses. A name comparison would sooner or later offer somebody a button that answers 403, or hide
   * it from the one person it belongs to.
   */
  const isAssignedPm = !!project && !!profile?.staffId && project.prjPmId === profile.staffId
  const acceptance = project?.acceptance ?? []
  const mayReadJob = may(profile, NEOTMS_PERMISSION_JOB_READ)
  const mayCreateJob = may(profile, NEOTMS_PERMISSION_JOB_CREATE)
  const mayUpdateJob = may(profile, NEOTMS_PERMISSION_JOB_UPDATE)
  const mayDeleteJob = may(profile, NEOTMS_PERMISSION_JOB_DELETE)
  const mayReadPo = may(profile, NEOTMS_PERMISSION_PO_READ)
  const mayCreatePo = may(profile, NEOTMS_PERMISSION_PO_CREATE)
  const mayUpdatePo = may(profile, NEOTMS_PERMISSION_PO_UPDATE)
  const mayDeletePo = may(profile, NEOTMS_PERMISSION_PO_DELETE)
  /*
   * Approving a PO's amount is PAYMENT:update, not a purchase-order right - the same split the
   * route table makes and the same one the payment screen checks. Someone who may raise and edit
   * POs here is not thereby someone who may sign off what they cost; that is the whole point of
   * the approval gate, and it would be defeated by reading `mayUpdatePo` instead.
   */
  const mayApprovePo = may(profile, NEOTMS_PERMISSION_PO_APPROVE)

  /*
   * 삭제 두 개. 문구는 각 목록 화면의 것과 **같은 문장**이다(JobsView·PurchaseOrdersView) —
   * 같은 동작을 두 화면에서 다르게 설명하면 어느 쪽이 맞는지 담당자가 확인할 방법이 없다.
   *
   * 작업 삭제는 PO 가 달려 있으면 서버가 거절한다. 그 거절은 정상 동작이고, 본문이 이유를
   * 설명하므로 아래에서 `ErrorNotice` 로 그대로 내보낸다 — 여기서 뭉개면 담당자는 'PO 를 먼저
   * 지워야 한다' 는 사실을 알 길이 없고, 삭제가 그냥 안 되는 화면으로 읽는다.
   */
  const onDeleteJob = async (row: JobRow) => {
    const label = row.jobName || row.jobCode
    if (
      !window.confirm(
        `${label} 작업을 삭제할까요?\n이 작업의 매출이 집계에서 빠집니다. PO 가 달려 있으면 삭제할 수 없습니다.`,
      )
    ) {
      return
    }
    await deleteJob.mutateAsync(row.id)
    setNotice(`${label} 작업을 삭제했습니다.`)
  }

  const onDeletePo = async (row: PurchaseOrderRow) => {
    // PO명 은 화면에서 빠졌으므로 코드가 그 PO를 가리키는 유일한 이름이다.
    const label = row.poCode
    if (!window.confirm(`${label} PO를 삭제할까요?`)) return
    await deletePo.mutateAsync(row.id)
    setNotice(`PO [${label}]를 삭제했습니다.`)
  }

  /*
   * ── 일괄 작업 네 개 ────────────────────────────────────────────────────
   *
   * 공통 규칙 셋:
   *
   *   1. **순차로 돌고 부분 실패를 허용한다.** 근거는 `runSequential` 에 전부 있다 — 커넥션
   *      예산과 무효화 폭풍, 그리고 "PO 가 달린 작업은 지워지지 않는다" 가 정상 동작이라는 것.
   *   2. **끝나면 선택을 비운다.** 비우지 않으면 지워진 행의 id 가 남아 다음 조작이 없는 행을
   *      건드리려 든다. 복제 쪽도 비운다 — 복제가 끝난 뒤 남아 있는 선택은 "원본이 아직
   *      선택되어 있다" 는 뜻이고, 한 번 더 누르면 조용히 두 벌이 더 생긴다.
   *   3. **확인 문구가 결과를 말한다.** 건수만 묻지 않고 그 조작이 집계에 무엇을 하는지 적는다.
   *      복제는 특히 그렇다 — 매출과 원가가 그만큼 **늘어난다.**
   */

  const runBulk = async <T,>(
    rows: readonly T[],
    confirmText: string,
    verb: string,
    clear: () => void,
    run: (row: T) => Promise<unknown>,
  ) => {
    if (rows.length === 0) return
    if (!window.confirm(confirmText)) return
    setBulkError(null)
    const result = await runSequential(rows, run)
    setBulkError(result.firstError)
    setNotice(describeBulk(result, rows.length, verb))
    clear()
  }

  const onBulkDeleteJobs = () =>
    runBulk(
      jobSel.selected,
      `선택한 작업 ${jobSel.selected.length}건을 삭제할까요?\n이 작업들의 매출이 집계에서 빠집니다. PO 가 달려 있는 작업은 삭제되지 않고 남습니다.`,
      '삭제',
      jobSel.clear,
      (row) => deleteJob.mutateAsync(row.id),
    )

  const onBulkDeletePos = () =>
    runBulk(
      poSel.selected,
      `선택한 PO ${poSel.selected.length}건을 삭제할까요?\n이 PO들의 원가가 집계에서 빠지고, 그만큼 마진이 올라갑니다.`,
      '삭제',
      poSel.clear,
      (row) => deletePo.mutateAsync(row.id),
    )

  /*
   * 복제 두 개. 무엇을 베끼고 무엇을 되돌리는지는 `duplicateJobInput`·
   * `duplicatePurchaseOrderInput` 이 들고 있다 — 요약하면 일과 값은 베끼고, 그 일에 **일어난
   * 사건**(진행 상태, 세금계산서, 지급)은 베끼지 않는다.
   *
   * JOB·PO 코드는 보내지 않는다. 서버가 민든다. 그게 이 기능이 성립하는 이유다.
   */
  const onBulkCopyJobs = () =>
    runBulk(
      jobSel.selected,
      `선택한 작업 ${jobSel.selected.length}건을 복제할까요?\n새 JOB 코드로 같은 내용의 작업이 생기고, 이 프로젝트의 매출이 그만큼 늘어납니다. 진행 상태는 '대기' 로 시작합니다.`,
      '복제',
      jobSel.clear,
      (row) => createJob.mutateAsync(duplicateJobInput(row)),
    )

  /*
   * Bulk approval, through the same confirm-then-run helper as the other four. The one thing it
   * does first is narrow the selection: already-approved POs are dropped, so the count in the
   * prompt, the count run and the count reported are all the same number.
   *
   * The rule and the wording live in `poBulkApprove`, shared with the payment desk - the same act
   * on the same rows should not be described two different ways depending on which screen it was
   * started from.
   */
  const onBulkApprovePos = () => {
    const pending = unapprovedOf(poSel.selected)
    if (poSel.selected.length > 0 && pending.length === 0) {
      setNotice(ALL_ALREADY_APPROVED)
      return
    }
    return runBulk(
      pending,
      approvalPrompt(pending, poSel.selected.length),
      '승인',
      poSel.clear,
      (row) => approvePo.mutateAsync({ id: row.id, input: { approved: true } }),
    )
  }

  const onBulkCopyPos = () =>
    runBulk(
      poSel.selected,
      `선택한 PO ${poSel.selected.length}건을 복제할까요?\n새 PO 코드로 같은 내용의 PO가 생기고, 원가가 그만큼 늘어납니다. 승인·세금계산서·지급 기록은 복제되지 않습니다 — 새 PO는 미승인·미정산으로 시작합니다.`,
      '복제',
      poSel.clear,
      (row) => createPo.mutateAsync(duplicatePurchaseOrderInput(row)),
    )

  /*
   * 제자리 수정. 본문에 **바뀐 한 칸만** 담는다 — 서버의 수정은 부분 수정이고, 보내지 않은
   * 금액은 바뀔 수가 없다(`InlineEditCell` 머리말).
   */
  const patchJob = (row: JobRow, input: Parameters<typeof updateJob.mutateAsync>[0]['input']) =>
    void updateJob.mutateAsync({ id: row.id, input })

  const patchPo = (
    row: PurchaseOrderRow,
    input: Parameters<typeof updatePo.mutateAsync>[0]['input'],
  ) => void updatePo.mutateAsync({ id: row.id, input })

  /*
   * 저장이 도는 동안은 제자리 수정을 잠근다.
   *
   * 저장이 끝나면 목록 질의가 무효화되고 다시 읽히는데, 그 왕복 사이에 같은 칸을 또 고치면
   * 두 번째 수정이 **되돌려진 값**을 바탕으로 만들어진다. 되돌아온 화면이 자기가 보낸 값과
   * 다른 이유를 설명할 방법이 없다.
   */
  const jobBusy = deleteJob.isPending || createJob.isPending || updateJob.isPending
  const poBusy =
    deletePo.isPending || createPo.isPending || updatePo.isPending || approvePo.isPending

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
        {/*
         * 여기는 제목을 남긴다.
         *
         * 다른 화면의 제목을 없앤 근거는 "경로 표시줄이 이미 같은 말을 한다" 였다. 이 분기는
         * 그 경로 표시줄이 '업무 › 프로젝트' 라고 적고 있는데 화면에는 아무것도 없는 상태이고,
         * 사용자가 알아야 하는 것은 메뉴 이름이 아니라 **방금 누른 링크가 실패했다**는 사실이다.
         */}
        <h1 className={ui.pageTitle}>프로젝트를 불러올 수 없습니다</h1>
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
      {/*
       * 여기도 제목을 남긴다 — 목록 화면들과 달리.
       *
       * 목록에서 제목을 없앤 근거는 '프로젝트' 라는 **메뉴 이름**이 좌측 패널과 경로 표시줄에
       * 이미 두 번 적혀 있다는 것이었다. 이 화면의 제목은 메뉴 이름이 아니라 **이 한 건의
       * 이름**이고, 그건 셸의 어디에도 없다. 담당자들이 주소를 서로 보내는 화면이므로(파일 머리
       * 주석) 받은 사람이 가장 먼저 확인하는 것이 이 줄이다.
       *
       * 다만 크기는 15px 다(`.pageTitle`). 20px 짜리 큰 글자를 쓰지 않는 이유는 아래 표가
       * 12px 이고, 그 사이에 20px 이 끼면 한 화면 안에서 글자 크기가 세 단으로 뛰기 때문이다.
       */}
      <div className={ui.pageBar}>
        <div className={ui.recordHead}>
          <Link className={ui.btnLink} to="/projects">
            <Icon name="chevronLeft" size={11} />
            프로젝트 목록
          </Link>
          <h1 className={ui.pageTitle}>{project.prjName || '(이름 없음)'}</h1>
          <span className={ui.cellMono}>{project.prjCode}</span>
          {project.cusCodeName ? <span className={ui.hint}>{project.cusCodeName}</span> : null}
          {/* 상태 두 개를 제목 줄에 붙인다. 아래 '프로젝트 정보' 카드에도 같은 값이 있지만,
              이 화면에서 가장 먼저 묻는 질문이 "이거 지금 어디까지 왔나" 다.

              세금계산서 칩이 여기 있었다. 프로젝트 등록 폼에서 세금계산서와 세금계산서 번호 두
              칸을 뺐으므로 `prj_invoice_state` 를 쓰는 화면이 하나도 남지 않았고, 아무도 채울
              수 없는 값은 늘 같은 칩으로만 서 있게 된다. 컬럼과 타입은 그대로이므로 되돌리는
              것은 이 줄을 다시 넣는 일이다(`ProjectsView` 머리말 참고). */}
          <StatusChip value={project.prjState} />
          <StatusChip value={project.prjMoneyState} />
          <AcceptanceChip status={project.acceptanceStatus} />
        </div>
        <div className={ui.rowActions}>
          {/*
           * The PM's two buttons, and the condition is the whole access rule on this screen.
           *
           * Shown only to the person the project is ASSIGNED TO, and only while nobody has answered.
           * There is no permission involved - the server's test is `prj_pm_id = <caller>`, which no
           * permission can express - so the condition here has to be the same shape, or the screen
           * offers a button that answers 403.
           *
           * The sales manager sees the chip and no buttons, which is correct: they can see what the
           * PM said and, if it was no, reassign the project.
           */}
          {isAssignedPm && project.acceptanceStatus === PROJECT_ACCEPTANCE_ASSIGNED ? (
            <>
              <button
                type="button"
                className={`${ui.btn} ${ui.btnPrimary}`}
                onClick={() => setAnswering(true)}
              >
                수락
              </button>
              <button
                type="button"
                className={ui.btn}
                onClick={() => setAnswering(false)}
              >
                거절
              </button>
            </>
          ) : null}
          {mayUpdateProject ? (
            <button type="button" className={ui.btn} onClick={() => setEditingProject(true)}>
              <Icon name="pencil" size={13} />
              프로젝트 수정
            </button>
          ) : null}
        </div>
      </div>

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}

      {/*
       * The answers given on this project, and the reasons.
       *
       * Above the money, because on a rejected project this is the only thing on the screen that
       * says what has to happen next - and the figures below it are revenue nobody is working on.
       *
       * Rendered only when there is something to show. An unanswered project draws nothing here;
       * the chip in the title row already says so, and an empty card headed 'acceptance history' would read
       * as a feature that is broken rather than as a project nobody has answered for yet.
       */}
      {acceptance.length > 0 ? (
        <div className={ui.card}>
          <div className={ui.cardHeader}>
            <span>수락 이력</span>
          </div>
          <div className={ui.cardBody}>
            {acceptance.map((answer) => (
              <div key={answer.id} className={ui.detailItem}>
                <span className={ui.detailLabel}>
                  <AcceptanceChip status={answer.status} />
                </span>
                <span className={ui.detailValue}>
                  {answer.staffName || '(이름 없음)'}
                  <span className={ui.hint}> · {formatDateTime(answer.createdAt) || '-'}</span>
                  {/*
                   * The reason, on its own line. A rejection without one is normal - the box is
                   * optional - and saying so beats a blank space that reads as a loading state.
                   */}
                  <div className={answer.note ? undefined : ui.cellMuted}>
                    {answer.note || '남긴 메모가 없습니다.'}
                  </div>
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {/* 삭제 거절을 읽을 수 있는 자리. 두 표가 멀리 떨어져 있어 각 표 안에 두면 스크롤
          밖에서 사라지므로, 알림은 화면 머리에 모아 둔다. */}
      <ErrorNotice error={deleteJob.error} />
      <ErrorNotice error={deletePo.error} />
      {/* 복제와 제자리 수정의 거절. `bulkError` 가 따로 있는 이유는 그 상태의 주석에 있다. */}
      <ErrorNotice error={createJob.error} />
      <ErrorNotice error={createPo.error} />
      <ErrorNotice error={updateJob.error} />
      <ErrorNotice error={updatePo.error} />
      <ErrorNotice error={bulkError} />

      {/*
       * 매출·원가·수익 세 숫자. 수익률은 **네 번째 상자가 아니라 수익 상자의 둘째 줄**이다.
       *
       * 비율은 금액에 대한 설명이고, 설명은 설명하는 대상 옆에 있어야 한다. 넷으로 늘리면
       * `.statGrid` 의 `auto-fit` 이 한 줄에 네 상자를 밀어 넣어 좁은 화면에서 2+2 로 접히고,
       * 그때 수익률이 매출 아래에 서서 **매출의 비율처럼** 읽힌다.
       */}
      <div className={ui.statGrid}>
        <div className={ui.stat}>
          <span className={ui.statLabel}>매출 (작업 {revenue.counted}건)</span>
          <span className={ui.statValue}>
            <Amount value={revenue.total} kind="revenue" />
          </span>
        </div>
        <div className={ui.stat}>
          <span className={ui.statLabel}>원가 (PO {cost.counted}건)</span>
          <span className={ui.statValue}>
            <Amount value={cost.total} kind="cost" />
          </span>
        </div>
        <div className={ui.stat}>
          <span className={ui.statLabel}>수익 · 수익률</span>
          <span className={ui.statValue}>
            <Amount value={margin} kind="margin" />
          </span>
          {/*
           * 비율은 `.statValue` 가 아니라 `.hint` 다 — 19px 두 줄은 어느 쪽이 주된 숫자인지를
           * 모호하게 만들고, 이 화면의 주된 숫자는 금액이다.
           *
           * 세지 못한 이유를 문장으로 적는 분기는 `marginRate` 주석 참고.
           */}
          <span className={ui.hint}>
            {marginRate === null ? '매출이 0이라 수익률을 셀 수 없습니다.' : `${marginRate}%`}
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
          금액이 입력되지 않은 PO가 있습니다 — 작업 {revenue.skipped}건, PO {cost.skipped}건.
          위 합계에서 제외되었으므로 위에 표시되는 수익은 실제와 다를 수 있습니다.
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
            {/* 두 상태는 위 제목 줄에도 칩으로 서 있다. 여기 한 번 더 두는 이유는 이 격자가
                '이 프로젝트의 모든 필드' 를 훑는 자리이고, 그 목록에서 상태만 빠지면 "여기
                없다 = 값이 없다" 로 읽히기 때문이다.

                같은 이유로 세금계산서 칸은 **남겨 두지 않았다.** 등록 폼에 그 칸이 없어진 뒤로는
                여기 서 있는 값이 영원히 같은 값이고, '모든 필드' 격자에 바뀔 수 없는 칸이 끼면
                담당자는 어디서 고치는지를 찾게 된다. */}
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>진행 상태</span>
              <span className={ui.detailValue}>
                <StatusChip value={project.prjState} />
              </span>
            </div>
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>입금</span>
              <span className={ui.detailValue}>
                <StatusChip value={project.prjMoneyState} />
              </span>
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
              <span className={ui.detailLabel}>마감일</span>
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
              {/*
               * 저장된 것은 코드(`PRJ_FIELD1`)이고, 읽을 수 있는 것은 이름('번역')이다. 코드를
               * 그대로 찍으면 이 칸은 **서식에서 고른 것과 다른 글자**를 보여 준다 — 드롭다운에는
               * 이름이 떠 있었으므로, 담당자는 저장이 엉뚱하게 됐다고 읽는다.
               *
               * 이름이 없으면 코드로 떨어진다(`useCodeNames`). 은퇴한 코드가 `PRJ_FIELD1` 로
               * 읽히는 것은 사실의 보고이고, 빈 칸으로 읽히는 것은 거짓이다.
               */}
              <span className={ui.detailValue}>
                {[fieldName(project.prjField), subFieldName(project.prjField2)]
                  .filter(Boolean)
                  .join(' · ') || '-'}
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
          <span>작업 {jobs.length}건</span>
          {/*
           * 선택 건수를 적는다. 체크박스만 있으면 스크롤을 내린 상태에서 몇 건을 골랐는지 알
           * 수 없고, 일괄 삭제는 되돌릴 수 없는 조작이다. 이 숫자는 `useRowSelection` 이 현재
           * 행과 교집합을 낸 결과이므로 **화면에 보이는 체크 개수와 항상 같다.**
           */}
          {jobSel.selected.length > 0 ? (
            <span className={ui.badge}>{jobSel.selected.length}건 선택</span>
          ) : null}
          <span className={ui.spacer} />
          {/*
           * 일괄 버튼은 **고른 것이 있을 때만** 나온다. 늘 보이게 두고 비활성으로 두는 쪽은
           * 택하지 않았다 — 카드 머리글에 늘 떠 있는 '선택 삭제' 는 아무것도 고르지 않은
           * 상태에서 누르는 사람을 만들고, 그 클릭은 아무 일도 하지 않으므로 화면이 고장난
           * 것으로 읽힌다.
           */}
          {jobSel.selected.length > 0 && mayCreateJob ? (
            <button
              type="button"
              className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
              onClick={() => void onBulkCopyJobs()}
              disabled={jobBusy}
            >
              선택 복제
            </button>
          ) : null}
          {jobSel.selected.length > 0 && mayDeleteJob ? (
            <button
              type="button"
              className={`${ui.btn} ${ui.btnDanger} ${ui.btnSm}`}
              onClick={() => void onBulkDeleteJobs()}
              disabled={jobBusy}
            >
              선택 삭제
            </button>
          ) : null}
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
                    {/*
                     * 머리글 체크박스. **지금 화면의 행만** 켜고 끈다 — '더 보기' 로 아직
                     * 불러오지 않은 행까지 고를 수는 없고, 고른 척하면 일괄 삭제가 사용자가
                     * 본 적 없는 행을 지운다.
                     *
                     * `ref` 로 `indeterminate` 를 세운다. 이 속성은 HTML 속성이 아니라 DOM
                     * 프로퍼티라서 JSX 로 줄 수 없다. 일부만 골랐을 때 체크박스가 **꺼진**
                     * 모양이면 '전체 선택' 과 '전체 해제' 중 어느 쪽이 일어날지 알 수 없다.
                     */}
                    <th className={ui.cellCheck}>
                      <input
                        type="checkbox"
                        aria-label="작업 전체 선택"
                        checked={jobSel.allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = jobSel.someSelected
                        }}
                        onChange={jobSel.toggleAll}
                      />
                    </th>
                    <th>JOB코드</th>
                    <th>작업명</th>
                    {/* 작업 목록 화면과 같은 한 열이다 — JobsView 의 같은 열 주석 참고. */}
                    <th>언어 페어 · 업무 분류</th>
                    <th>물량 · 단가</th>
                    <th>매출(원화)</th>
                    <th>PO</th>
                    <th>마감일</th>
                    <th>상태</th>
                    {/* 머리글이 '수정' 이었다. 이 칸에 버튼이 셋(수정·PO 추가·삭제) 있으므로
                        그중 하나의 이름을 머리글로 쓰면 나머지 둘을 가린다 — PO 표와 같이 비운다. */}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <TableState
                    isLoading={jobsQuery.isLoading}
                    error={jobsQuery.error}
                    isEmpty={jobs.length === 0}
                    emptyText="이 프로젝트에는 작업이 없습니다. 작업을 추가하면 매출이 잡힙니다."
                    colSpan={10}
                  />
                  {jobs.map((job) => {
                    const poCount = poCountByJob.get(job.id) ?? 0
                    const on = jobSel.isSelected(job.id)
                    return (
                      <tr key={job.id} className={on ? ui.rowSelected : ''}>
                        <td className={ui.cellCheck}>
                          <input
                            type="checkbox"
                            aria-label={`${job.jobCode} 선택`}
                            checked={on}
                            onChange={() => jobSel.toggle(job.id)}
                          />
                        </td>
                        <td className={ui.cellMono}>{job.jobCode}</td>
                        {/*
                         * 두 번 눌러 고치는 칸 셋 중 첫째 — 작업명. 권한이 없으면 평범한
                         * 칸으로 그려진다(점선 밑줄도 없다): 고칠 수 없는 칸에 고칠 수 있다는
                         * 단서를 붙이면 두 번 눌러 보고 아무 일도 안 일어나는 것을 겪게 된다.
                         */}
                        <InlineTextCell
                          value={job.jobName}
                          editable={mayUpdateJob && !jobBusy}
                          ariaLabel={`${job.jobCode} 작업명`}
                          onCommit={(jobName) => patchJob(job, { jobName })}
                        />
                        {/*
                         * 두 번 눌러 업무 구분을 바꾼다. 작업 목록(`JobsView`)의 같은 칸과 **같은
                         * 함수로 그리고 같은 대화상자를 연다** — 두 화면이 각자 삼항 연산자를 들고
                         * 있었고, 그런 쌍은 한쪽만 고쳐지는 날이 온다.
                         *
                         * 저장은 대화상자가 자기 뮤테이션으로 한다. 그래서 `patchJob` 을 거치지
                         * 않고, `jobBusy` 도 보지 않는다 — 여는 일만 하는 칸이다.
                         */}
                        <InlinePickerCell
                          editable={mayUpdateJob && !jobBusy}
                          title="두 번 눌러 업무 구분 변경"
                          className={ui.cellMuted}
                          onOpen={() => setSwappingType(job)}
                        >
                          {jobTypeSummary(job, categoryName)}
                        </InlinePickerCell>
                        {/*
                         * 비언어 작업에서는 두 줄 모두 `-` 가 된다 — 의도한 모습이고, JobsView 의
                         * 같은 칸에 이유가 적혀 있다. 네 값 모두 언어 상세 테이블의 컬럼이므로
                         * (db/012_job_pricing.sql) 서버가 null 을 돌려준다.
                         */}
                        <td className={ui.cellMuted}>
                          <div>
                            {job.jobVolume ?? '-'} {job.unitCode ?? ''}
                          </div>
                          <div>
                            <Amount value={job.jobPrice} coinCode={job.coinCode} />
                          </div>
                        </td>
                        <td>
                          <Amount
                            value={krwToShow(job.jobPriceKrw, job.jobPriceKsum)}
                            kind="revenue"
                          />
                        </td>
                        <td>
                          {poCount > 0 ? (
                            <span className={ui.badge}>{poCount}건</span>
                          ) : (
                            // 원가가 없는 작업. 마진이 과대계상된 상태다 — 위 주석 참고.
                            <span className={`${ui.badge} ${ui.badgeWarn}`}>없음</span>
                          )}
                        </td>
                        <InlineDateCell
                          value={job.jobEday}
                          editable={mayUpdateJob && !jobBusy}
                          ariaLabel={`${job.jobCode} 마감일`}
                          className={
                            isOverdue(job.jobEday) &&
                            job.jobState !== '완료' &&
                            job.jobState !== '취소'
                              ? ui.amountNeg
                              : ui.cellMuted
                          }
                          onCommit={(jobEday) => patchJob(job, { jobEday })}
                        />
                        {/*
                         * 상태는 `codeOptions` 를 거친 목록으로 고친다. 그러지 않으면 운영
                         * 데이터의 레거시 상태값이 목록에 없을 때 `<select>` 가 첫 항목('대기')을
                         * 고른 것처럼 그리고, 아무것도 안 고르고 닫은 담당자의 '검수' 작업이
                         * 대기로 돌아간 것처럼 보인다.
                         */}
                        <InlineSelectCell
                          value={job.jobState}
                          options={codeOptions(JOB_STATES, job.jobState)}
                          editable={mayUpdateJob && !jobBusy}
                          ariaLabel={`${job.jobCode} 상태`}
                          onCommit={(jobState) => patchJob(job, { jobState })}
                        />
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
                                PO 추가
                              </button>
                            ) : null}
                            {mayDeleteJob ? (
                              <button
                                type="button"
                                className={`${ui.btn} ${ui.btnDanger} ${ui.btnSm}`}
                                onClick={() => void onDeleteJob(job)}
                                disabled={deleteJob.isPending}
                              >
                                삭제
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

      {/* ── PO ─────────────────────────────────────────────────────────── */}

      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <span>PO {pos.length}건</span>
          {poSel.selected.length > 0 ? (
            <span className={ui.badge}>{poSel.selected.length}건 선택</span>
          ) : null}
          <span className={ui.spacer} />
          {/*
           * 'PO 추가'. 전에는 이 자리에 버튼이 없었고, 그 이유는 "PO 는 작업에 달리므로 어느
           * 작업인지가 먼저 정해져야 한다" 였다 — 그래서 등록 입구가 위 작업 표의 행별
           * 'PO 추가' 하나뿐이었다.
           *
           * 그 전제는 맞지만 결론이 틀렸다. 작업이 먼저 정해져야 한다는 것은 **폼에 작업
           * 선택란이 필요하다**는 뜻이고, 그 선택란은 이미 있다(`JobPicker`). 입구를 막을
           * 이유가 아니다. 막아 둔 결과는 "이 프로젝트에 발주를 하나 더 넣자" 를 하려면 작업
           * 표까지 거슬러 올라가 **어느 작업이었는지 먼저 기억해 내야** 하는 것이었고, 작업이
           * 스무 건인 프로젝트에서 그건 기억이 아니라 추측이다.
           *
           * 행별 버튼은 그대로 남는다 — 작업을 보면서 그 작업의 발주를 넣는 것이 더 빠른 경우가
           * 실제로 많고, 그쪽은 작업이 **정해진 채로** 열린다(`fixedJob`).
           *
           * 여기서 여는 폼의 작업 검색은 **이 프로젝트로 한정**한다(`jobScopeProjectId`). 한정하지
           * 않으면 다른 프로젝트의 작업을 고를 수 있고, 그러면 이 프로젝트의 원가가 저쪽 매출에
           * 붙는다 — `JobPicker` 주석에 그 사고가 적혀 있다.
           */}
          {mayCreatePo ? (
            <button
              type="button"
              className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
              onClick={() => {
                setPoForJob(null)
                setEditingPo(null)
              }}
              disabled={poBusy}
            >
              <Icon name="plus" size={13} />
              PO 추가
            </button>
          ) : null}
          {poSel.selected.length > 0 && mayApprovePo ? (
            <button
              type="button"
              className={`${ui.btn} ${ui.btnPrimary} ${ui.btnSm}`}
              onClick={() => void onBulkApprovePos()}
              disabled={poBusy}
            >
              선택 승인
            </button>
          ) : null}
          {poSel.selected.length > 0 && mayCreatePo ? (
            <button
              type="button"
              className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
              onClick={() => void onBulkCopyPos()}
              disabled={poBusy}
            >
              선택 복제
            </button>
          ) : null}
          {poSel.selected.length > 0 && mayDeletePo ? (
            <button
              type="button"
              className={`${ui.btn} ${ui.btnDanger} ${ui.btnSm}`}
              onClick={() => void onBulkDeletePos()}
              disabled={poBusy}
            >
              선택 삭제
            </button>
          ) : null}
        </div>

        {!mayReadPo ? (
          <div className={ui.cardBody}>
            <p className={ui.hint}>PO 조회 권한이 없어 이 프로젝트의 원가를 볼 수 없습니다.</p>
          </div>
        ) : (
          <>
            <div className={`${ui.cardBodyFlush} ${ui.tableWrap}`}>
              <table className={ui.table}>
                <thead>
                  <tr>
                    {/* 작업 표의 머리글 체크박스와 같다 — 그쪽 주석 참고. */}
                    <th className={ui.cellCheck}>
                      <input
                        type="checkbox"
                        aria-label="PO 전체 선택"
                        checked={poSel.allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = poSel.someSelected
                        }}
                        onChange={poSel.toggleAll}
                      />
                    </th>
                    <th>PO코드</th>
                    <th>작업</th>
                    <th>번역가</th>
                    <th>원가(원화)</th>
                    <th>납기</th>
                    <th>진행</th>
                    {/*
                     * The approval column exists because the 선택 승인 button above it does. Bulk
                     * approving without it would be blind in both directions: no way to see which
                     * of the selected rows the action will actually change, and no way to see
                     * afterwards that it changed them. The payment screen shows the same chip.
                     */}
                    <th>승인</th>
                    <th>지급</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <TableState
                    isLoading={posQuery.isLoading}
                    error={posQuery.error}
                    isEmpty={pos.length === 0}
                    emptyText="이 프로젝트에는 PO가 없습니다. 원가가 0이므로, 수익과 매출은 동일합니다."
                    colSpan={10}
                  />
                  {pos.map((po) => {
                    const on = poSel.isSelected(po.id)
                    return (
                      <tr key={po.id} className={on ? ui.rowSelected : ''}>
                        <td className={ui.cellCheck}>
                          <input
                            type="checkbox"
                            aria-label={`${po.poCode} 선택`}
                            checked={on}
                            onChange={() => poSel.toggle(po.id)}
                          />
                        </td>
                        <td className={ui.cellMono}>{po.poCode}</td>
                        <td className={ui.cellMuted}>{po.jobName || po.jobCode || '-'}</td>
                        {/*
                         * 번역가는 칸 안에서 고를 수 없어 대화상자로 연다 — 고르는 방법이
                         * 검색이기 때문이다(`InlinePickerCell`). 승인·정산완료에서 막는 이유는
                         * `TranslatorSwapModal` 이 들고 있고, 이 칸과 그 대화상자가 같은 함수로
                         * 판단한다.
                         */}
                        <InlinePickerCell
                          editable={mayUpdatePo && !poBusy && mayChangeTranslator(po)}
                          title={translatorLockReason(po) ?? '두 번 눌러 번역가 변경'}
                          onOpen={() => setSwapping(po)}
                        >
                          {po.poTranName ? (
                            po.poTranName
                          ) : (
                            <span className={`${ui.badge} ${ui.badgeWarn}`}>미지정</span>
                          )}
                        </InlinePickerCell>
                        <td>
                          <Amount value={krwToShow(po.poPriceKrw, po.poPriceKsum)} kind="cost" />
                        </td>
                        <InlineDateCell
                          value={po.poEday}
                          editable={mayUpdatePo && !poBusy}
                          ariaLabel={`${po.poCode} 납기`}
                          className={
                            isOverdue(po.poEday) && po.poState !== '완료' && po.poState !== '취소'
                              ? ui.amountNeg
                              : ui.cellMuted
                          }
                          onCommit={(poEday) => patchPo(po, { poEday })}
                        />
                        {/* 색을 고르는 삼항 연산자 세 개가 여기 있었다. 같은 '정산완료' 가 이
                            화면과 PO 목록에서 다른 색으로 나오던 원인이다 — StatusChip.tsx 의
                            `TONES` 표가 그 판단을 들고 있다. */}
                        <InlineSelectCell
                          value={po.poState}
                          options={codeOptions(PO_STATES, po.poState)}
                          editable={mayUpdatePo && !poBusy}
                          ariaLabel={`${po.poCode} 진행 상태`}
                          onCommit={(poState) => patchPo(po, { poState })}
                        />
                        <td>
                          <ApprovalChip approved={po.poApproved} />
                          {/*
                           * Who approved it and when. Approval is the act of accepting
                           * responsibility for an amount, so the record of it belongs on screen -
                           * the same reasoning, and the same two lines, as the payment screen.
                           */}
                          {po.poApproved && po.poApprovedAt ? (
                            <div className={ui.cellMuted}>
                              {formatDateTime(po.poApprovedAt)}
                              {po.poApprovedBy ? ` · ${po.poApprovedBy}` : ''}
                            </div>
                          ) : null}
                        </td>
                        {/*
                         * 지급 상태는 **제자리 수정 대상이 아니다.** 셋 중 하나만 평범한 칸으로
                         * 남은 것이 의도다.
                         *
                         * `poMoneyState` 를 바꾸는 것은 "번역가에게 돈을 줬다" 고 적는 일이고, 그
                         * 기록에는 금액(`poMoneyPrice`)과 날짜(`poMoneyDay`)와 수단
                         * (`poMoneyGubun`)이 함께 있어야 뜻이 생긴다. 상태 한 칸만 '정산완료' 로
                         * 바꾸면 **얼마를 언제 줬는지가 비어 있는 정산완료**가 만들어지고, 그 행은
                         * 정산 대상 목록에서 사라지는데 지급 기록은 어디에도 없다. 그래서 지급은
                         * 결제 화면의 정산 모달만 쓴다 — 서버도 같은 판단이고, 그 네 칸을 묶어
                         * 받는 별도 엔드포인트(`PoSettlementInput`)를 두고 있다.
                         */}
                        <td>
                          <StatusChip value={po.poMoneyState} />
                        </td>
                        <td>
                          <div className={ui.rowActions}>
                            {/*
                             * 국 / 영 발주서. 미승인 PO 에서 비활성인 이유까지 전부
                             * `PoDocButtons` 에 있다 — 세 화면이 같은 컴포넌트를 쓴다.
                             */}
                            <PoDocButtons po={po} onPick={setPrinting} />
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
                            {mayDeletePo ? (
                              <button
                                type="button"
                                className={`${ui.btn} ${ui.btnDanger} ${ui.btnSm}`}
                                onClick={() => void onDeletePo(po)}
                                disabled={deletePo.isPending}
                              >
                                삭제
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

      {answering !== null ? (
        <ProjectAcceptanceModal
          project={project}
          accepted={answering}
          onClose={() => setAnswering(null)}
          onDone={setNotice}
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
          /*
           * 작업이 정해져 있지 않을 때(PO 카드의 'PO 추가')만 뜻이 있다. 수정이거나 `fixedJob`
           * 이 있으면 폼이 작업 선택란 대신 정해진 작업을 글로 보여 주므로 쓰이지 않는다.
           */
          jobScopeProjectId={id}
          onClose={() => {
            setEditingPo(undefined)
            setPoForJob(null)
          }}
          onSaved={setNotice}
        />
      ) : null}

      {printing ? (
        <PoPrintModal po={printing.po} lang={printing.lang} onClose={() => setPrinting(null)} />
      ) : null}

      {swapping ? (
        <TranslatorSwapModal
          purchaseOrder={swapping}
          onClose={() => setSwapping(null)}
          onSaved={setNotice}
        />
      ) : null}

      {swappingType ? (
        <JobTypeSwapModal
          job={swappingType}
          onClose={() => setSwappingType(null)}
          onSaved={setNotice}
        />
      ) : null}
    </div>
  )
}
