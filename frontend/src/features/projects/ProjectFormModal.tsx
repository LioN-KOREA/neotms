import { useState } from 'react'
import { useCreateProject, useUpdateProject } from '@/apis/queries/neotms.mutation'
import {
  CODE_DOMAIN,
  codeOptions,
  COIN_CODES,
  MONEY_STATE_UNPAID,
  MONEY_STATES,
  PROJECT_STATE_QUOTE,
  PROJECT_STATES,
  unsetPlaceholder,
} from '@/apis/neotms.codes'
import { ASSIGNABLE_ATTRIBUTES, type ProjectInput, type ProjectRow } from '@/apis/neotms.types'
import { useProfile } from '@/apis/queries/neotms.query'
import { CodeSelect } from '@/shared/ui/CodeSelect'
import { ErrorNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import type { PickerOption } from '@/shared/ui/RecordPicker'
import { alignPeriod, nowTimeKst, toDateInputValue, todayKst } from '@/shared/utils/format'
import { DateField } from '@/shared/ui/DateField'
import ui from '@/shared/ui/ui.module.css'
import { CustomerPicker } from '@/features/customers/CustomerPicker'
import { StaffPicker } from '@/features/staff/StaffPicker'

/** Index 0 is sales manager and 1 is PM - see `ASSIGNABLE_ATTRIBUTES`, which the server shares. */
const [SALES_MANAGER_ATTRIBUTE, PM_ATTRIBUTE] = ASSIGNABLE_ATTRIBUTES

interface Props {
  /** null 이면 신규. */
  project: ProjectRow | null
  onClose: () => void
  onSaved: (message: string) => void
}

/**
 * 프로젝트 등록·수정.
 *
 * ## 고객사가 필수다
 *
 * `ProjectInput.customerId` 는 선택값이 아니다. 매출은 작업(JOB)에 쌓이고 작업은 프로젝트에
 * 달리므로, 고객사가 비어 있는 프로젝트의 매출은 **어디에도 귀속되지 않는다** — 고객사별
 * 집계에서 조용히 빠지고, 합계가 맞지 않는 이유를 찾을 단서가 남지 않는다.
 *
 * 수정 화면에서는 이미 고른 고객사를 검색 없이 되살려야 한다. 서버가 목록에 조인해 주는
 * `cusCodeName` 이 그 역할을 한다 — 고객사를 한 건 더 조회하지 않아도 이름을 보여 줄 수 있다.
 *
 * ## The two assignees are pickers, and the server checks them
 *
 * `prjMgrId` (sales manager) and `prjPmId` (PM) are `staff` ids, and each picker lists only the people
 * carrying the matching attribute - `GET /api/v0/staff/assignable`. The server refuses an id that
 * does not carry it, so the picker is a convenience over the rule rather than the rule itself.
 *
 * The three parent fields sit on ONE ROW: a customer name, a PM's name and a sales manager's name are all
 * short, and the three together are "who this project belongs to". Before this they were a full-
 * width picker and two sentences of apology.
 *
 * ## The PM is who has to accept the project
 *
 * Naming a PM here puts the project in front of them: `acceptance_status` starts at 0 and the
 * project appears in that person's handover panel until they answer. CHANGING the PM on an
 * existing project resets the acceptance, because the previous PM's answer was theirs - so this
 * form is also how a rejected project is handed to somebody else.
 *
 * ## sales manager defaults to the person filling the form in
 *
 * If they hold the attribute. Whoever enters a project is almost always the salesperson who sold
 * it, and getting it wrong is cheap to fix here while leaving it blank is not: a project with no
 * sales manager has nobody who can ask its PM to look again after a rejection (that endpoint's authority
 * is `prj_mgr_id = <caller>`), so it quietly loses its only route out of that state.
 */
export function ProjectFormModal({ project, onClose, onSaved }: Props) {
  const isEdit = !!project
  const createProject = useCreateProject()
  const updateProject = useUpdateProject()
  const pending = createProject.isPending || updateProject.isPending

  /**
   * 고른 고객사. 수정 화면에서는 기존 값으로 시작한다.
   *
   * `cusCodeName` 은 서버가 `코드 이름` 형태로 합쳐 준 표시용 문자열이다. 그대로 제목에 넣고
   * 부제는 비운다 — 코드를 한 번 더 보여 줄 필요가 없다.
   */
  const [customer, setCustomer] = useState<PickerOption | null>(
    project?.customerId
      ? { id: project.customerId, title: project.cusCodeName ?? project.customerId }
      : null,
  )

  /*
   * The two assignees, as picker selections.
   *
   * On an edit they start from the ids already on the project, titled with the denormalised names
   * the server keeps for the list screen - so the dialog opens showing who is assigned without a
   * second read. On a NEW project the sales manager starts as the current user when they are eligible;
   * see the file header for why that default and not a blank.
   *
   * `profile.attributes` is the same list the server would check, so an ineligible user is not
   * offered themselves and then refused on save. A user whose profile has not loaded yet gets no
   * default, which is the honest answer at that moment rather than a guess that may need undoing.
   */
  const { data: profile } = useProfile()
  const [pm, setPm] = useState<PickerOption | null>(
    project?.prjPmId
      ? { id: project.prjPmId, title: project.prjPmName ?? project.prjPmId }
      : null,
  )
  const [salesManager, setSalesManager] = useState<PickerOption | null>(() => {
    if (project) {
      return project.prjMgrId
        ? { id: project.prjMgrId, title: project.prjMgrName ?? project.prjMgrId }
        : null
    }
    const mine = profile?.staffId
    const eligible = profile?.attributes.includes(SALES_MANAGER_ATTRIBUTE) ?? false
    return mine && eligible ? { id: mine, title: profile?.name ?? mine } : null
  })

  const [form, setForm] = useState({
    prjName: project?.prjName ?? '',
    coinCode: project?.coinCode ?? 'KRW',
    cusMgrName: project?.cusMgrName ?? '',
    prjField: project?.prjField ?? '',
    prjField2: project?.prjField2 ?? '',
    prjState: project?.prjState ?? PROJECT_STATE_QUOTE,
    prjMoneyState: project?.prjMoneyState ?? MONEY_STATE_UNPAID,
    /*
     * 신규는 시작일이 **지금**이다. 거의 모든 프로젝트가 등록하는 날 시작하므로, 비워 두고
     * 매번 고르게 하면 그 칸은 셋 중 하나가 된다 — 오늘로 채워지거나, 빈 채로 저장되거나,
     * 틀린 날짜로 저장된다.
     *
     * `??` 가 아니라 `project ? :` 로 갈라야 한다. `project?.prjSdayTime ?? nowTimeKst()` 는
     * **시작 시각이 비어 있는 기존 행을 수정할 때 현재 시각을 집어넣는다** — 폼을 열었다
     * 그대로 저장하면 없던 시각이 생긴다. 기본값은 신규에만 해당한다.
     */
    prjSday: project ? toDateInputValue(project.prjSday) : todayKst(),
    prjSdayTime: project ? (project.prjSdayTime ?? '') : nowTimeKst(),
    prjEday: toDateInputValue(project?.prjEday),
    prjEdayTime: project?.prjEdayTime ?? '',
    prjContent: project?.prjContent ?? '',
  })
  const [dirty, setDirty] = useState(false)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setDirty(true)
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  /**
   * 시작일·마감일을 **함께** 넣는다. 거꾸로 된 기간은 `alignPeriod` 가 맞춘다.
   *
   * 두 칸을 각각 `set` 으로 넣지 않는 이유는 `alignPeriod` 가 두 값을 보고 한 쌍을 돌려주기
   * 때문이다. 한 번에 넣어야 "시작일을 밀었더니 마감일이 따라온" 것이 한 번의 렌더로 보인다 —
   * 두 번 나누면 중간에 거꾸로 된 기간이 한 프레임 섞인다.
   */
  const setPeriod = (start: string, end: string, changed: 'start' | 'end') => {
    const next = alignPeriod(start, end, changed)
    setDirty(true)
    setForm((prev) => ({ ...prev, prjSday: next.start, prjEday: next.end }))
  }

  const name = form.prjName.trim()
  const canSave = name.length > 0 && !!customer && !pending

  /*
   * 다섯 칸('진행 상태'·'통화'·'입금'·'분야'·'세부 분야')은 '선택 없음' 을 제공하지 않는다. 비워 둘
   * 이유가 없는 칸이고, 그 항목이 첫 번째에 있으면 기본값이 빈 값이 된다 — 판단과 이유는 전부
   * `unsetPlaceholder` 주석에 있다. 이미 비어 있는 행을 수정할 때만 항목이 돌아온다.
   *
   * 통화의 '선택 없음' 은 조금 다른 이유로 없어진다. 비워 두어도 **고장나지는 않는다** — 서버는
   * `COALESCE(coin_code, 'KRW')` 로 읽고, 통화가 없는 금액은 이미 원화라고 결론 내린다
   * (NeotmsMoney.ts 가 그 선택을 명시해 두고 있다). 문제는 그 다음이다: 빈 값은 `KRW` 와 효과가
   * 완전히 같은데 화면에는 "통화 미지정" 으로 보인다. 같은 사실을 두 가지로 적는 선택지이고,
   * 둘이 다르다고 믿게 만드는 쪽이 비싸다. 기본값은 이미 `KRW` 였다.
   */
  const unsetState = unsetPlaceholder(isEdit, form.prjState)
  const unsetCoin = unsetPlaceholder(isEdit, form.coinCode)
  const unsetMoney = unsetPlaceholder(isEdit, form.prjMoneyState)

  const onSubmit = async () => {
    if (!customer || name.length === 0) return

    /*
     * 빈 문자열은 null 로 보낸다 — 고객사 폼과 같은 이유다(CustomerFormModal 주석).
     *
     * 납기 시각(`prjEdayTime`)만 따로 볼 필요가 있다: 날짜는 있는데 시각이 비어 있는 것이
     * 정상이다("그날 중"). 반대로 시각만 있고 날짜가 없으면 의미가 없지만, 그 조합을 막지는
     * 않는다 — 레거시 데이터에 실제로 있고, 저장을 막으면 그 행은 수정조차 못 하게 된다.
     */
    const input: ProjectInput = {
      prjName: name,
      customerId: customer.id,
      coinCode: form.coinCode.trim() || null,
      prjField: form.prjField.trim() || null,
      prjField2: form.prjField2.trim() || null,
      prjState: form.prjState.trim() || null,
      /*
       * `prjInvoiceState` 와 `invCode` 가 여기 없는 것은 **의도다.** 세금계산서와 세금계산서 번호
       * 두 칸을 화면에서 뺐고, 보내지 않으므로 수정 경로에서 기존 값이 지워지지 않는다 — 부분
       * 수정이고, 본문에 없는 필드는 서버가 건드리지 않는다. 컬럼(`project.prj_invoice_state`,
       * `project.inv_code`)과 쓰기 스키마, 타입은 그대로 남아 있으므로 되돌리는 것은 칸을 다시
       * 그리고 이 두 줄을 넣는 일이다.
       */
      prjMoneyState: form.prjMoneyState.trim() || null,
      prjSday: form.prjSday || null,
      prjSdayTime: form.prjSdayTime || null,
      prjEday: form.prjEday || null,
      prjEdayTime: form.prjEdayTime || null,
      prjContent: form.prjContent.trim() || null,
      cusMgrName: form.cusMgrName.trim() || null,
      /*
       * The two assignees, always sent - including as `null` when the box is empty.
       *
       * `null` is how a field is CLEARED, and clearing an assignee is a real edit: a project
       * between PMs has none. Omitting them instead would mean this form could never take an
       * assignee off a project, which is the state a rejected project has to be able to reach
       * before it is handed to somebody else.
       *
       * Sending the PM unchanged is harmless and is what makes the acceptance reset behave: the
       * server compares the id against the stored one and resets `acceptance_status` only when it
       * actually differs (see `ProjectUpdateOps`), so saving a typo fix does not re-ask the PM.
       */
      prjPmId: pm?.id ?? null,
      prjMgrId: salesManager?.id ?? null,
    }

    if (project) {
      await updateProject.mutateAsync({ id: project.id, input })
      onSaved(`${name} 프로젝트를 수정했습니다.`)
    } else {
      const created = await createProject.mutateAsync(input)
      onSaved(`${name} 프로젝트를 등록했습니다. (코드: ${created.prjCode})`)
    }
    onClose()
  }

  return (
    <Modal
      title={isEdit ? '프로젝트 수정' : '프로젝트 등록'}
      onClose={onClose}
      isDirty={dirty && !pending}
      width={720}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose} disabled={pending}>
            취소
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void onSubmit()}
            disabled={!canSave}
          >
            {pending ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      <ErrorNotice error={createProject.error ?? updateProject.error} />

      {isEdit ? (
        <p className={ui.hint}>
          프로젝트 코드 <strong>{project.prjCode}</strong> — 코드는 변경할 수 없습니다.
        </p>
      ) : null}

      <div className={ui.formGrid}>
        <div className={ui.fieldWide}>
          <label className={`${ui.label} ${ui.required}`} htmlFor="prj-name">
            프로젝트명
          </label>
          <input
            id="prj-name"
            className={ui.input}
            value={form.prjName}
            onChange={(e) => set('prjName', e.target.value)}
            required
          />
        </div>

        {/*
          고객사 · PM · 영업담당 한 줄. 세 칸 모두 `.field` 이므로 `.formGrid` 의 자동 열 수가
          모달 폭(720px)에서 셋을 한 줄에 놓는다. 좁은 화면에서는 둘 + 하나로 접히고, 그때도
          순서는 그대로다 — 고객사가 먼저인 것은 셋 중 유일한 필수 항목이기 때문이다.
        */}
        <div className={ui.field}>
          <CustomerPicker
            value={customer}
            onChange={(option) => {
              setDirty(true)
              setCustomer(option)
            }}
            required
            disabled={pending}
          />
        </div>

        {/* 업체 담당자 — 이름을 자유롭게 적는다 (팀장님 2026-11-25). 고객사 바로 옆: 같은 쪽 사람이다. */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="prj-cus-mgr">
            업체 담당자
          </label>
          <input
            id="prj-cus-mgr"
            className={ui.input}
            maxLength={100}
            value={form.cusMgrName}
            onChange={(e) => set('cusMgrName', e.target.value)}
            disabled={pending}
            placeholder="예: 홍길동 과장"
          />
        </div>

        <div className={ui.field}>
          <StaffPicker
            attribute={PM_ATTRIBUTE}
            id="prj-pm"
            label="PM"
            value={pm}
            onChange={(option) => {
              setDirty(true)
              setPm(option)
            }}
            disabled={pending}
          />
        </div>

        <div className={ui.field}>
          <StaffPicker
            attribute={SALES_MANAGER_ATTRIBUTE}
            id="prj-sales-manager"
            label="영업담당"
            value={salesManager}
            onChange={(option) => {
              setDirty(true)
              setSalesManager(option)
            }}
            disabled={pending}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="prj-state">
            진행 상태
          </label>
          <select
            id="prj-state"
            className={ui.select}
            value={form.prjState}
            onChange={(e) => set('prjState', e.target.value)}
          >
            {/*
             * '선택 없음' 이 없다. 상태 없는 프로젝트는 업무상 존재하지 않고, 그 항목이 첫
             * 번째에 있던 동안에는 기본값이 사실상 "상태 없음" 이었다 — 지금은 `견적` 이다.
             *
             * 이미 비어 있는 행을 수정할 때만 항목이 돌아온다(`unsetPlaceholder` 주석). 그
             * 라벨이 '지정 없음' 인 것도 그 함수가 정한다.
             */}
            {unsetState ? <option value="">{unsetState}</option> : null}
            {/* 목록에 없는 값이 저장되어 있어도 지워지지 않게 한다 — neotms.codes.ts */}
            {codeOptions(PROJECT_STATES, form.prjState).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="prj-coin">
            통화
          </label>
          <select
            id="prj-coin"
            className={ui.select}
            value={form.coinCode}
            onChange={(e) => set('coinCode', e.target.value)}
          >
            {/* '선택 없음' 이 없다 — 통화 없는 금액은 금액이 아니다. `unsetCoin` 주석 참고. */}
            {unsetCoin ? <option value="">{unsetCoin}</option> : null}
            {codeOptions(COIN_CODES, form.coinCode).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/*
         * '세금계산서' 가 있던 자리. 지금 쓰지 않으므로 뺐다 — 컬럼과 쓰기 스키마는 그대로이고,
         * 저장 본문에서 빠진 이유와 그 안전함은 위 `input` 주석에 적혀 있다.
         */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="prj-money-state">
            입금
          </label>
          <select
            id="prj-money-state"
            className={ui.select}
            value={form.prjMoneyState}
            onChange={(e) => set('prjMoneyState', e.target.value)}
          >
            {/* 진행 상태와 같은 이유로 '선택 없음' 이 없다. 기본값은 `미정산` 이다. */}
            {unsetMoney ? <option value="">{unsetMoney}</option> : null}
            {codeOptions(MONEY_STATES, form.prjMoneyState).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/*
         * 시작일·마감일을 날짜와 시각 두 칸으로 나눈 것은 컬럼이 그렇게 생겼기 때문이다
         * (`prj_sday` 는 date, `prj_sday_time` 은 별도 text). 하나의 datetime 입력으로 합치면
         * 시각이 비어 있는 기존 행에 00:00 이 들어가고, "그날 중" 이 "자정까지" 로 바뀐다.
         *
         * 둘을 `.datePair` 로 묶어 **한 줄을 통째로** 쓴다. 자동 열 수(`.formGrid`)에 맡기면
         * 열이 셋일 때 기간의 두 끝 사이에 '분야' 가 끼어들어, 한 쌍으로 읽혀야 할 것이 셋으로
         * 보이고 '분야' 는 제 짝인 '세부 분야' 와 떨어진다.
         */}
        <div className={ui.datePair}>
          <DateField
            id="prj-sday"
            label="시작일"
            value={form.prjSday}
            onChange={(v) => setPeriod(v, form.prjEday, 'start')}
            disabled={pending}
            time={{
              value: form.prjSdayTime,
              onChange: (v) => set('prjSdayTime', v),
              ariaLabel: '시작 시각',
            }}
          />

          <DateField
            id="prj-eday"
            label="마감일"
            value={form.prjEday}
            onChange={(v) => setPeriod(form.prjSday, v, 'end')}
            disabled={pending}
            time={{
              value: form.prjEdayTime,
              onChange: (v) => set('prjEdayTime', v),
              ariaLabel: '마감시각',
            }}
          >
            <span className={ui.hint}>시각을 비워 두면 '그날 중' 으로 봅니다.</span>
          </DateField>
        </div>

        {/*
         * 두 칸은 **서로 다른 목록**에서 고른다. 분야는 `PRJCAT`(큰 분류, 일곱 개), 세부 분야는
         * `FIELD`(세부, 열여덟 개)다.
         *
         * 전에는 둘 다 `FIELD` 였고, 그래서 세부 분야 칸은 첫 칸을 되풀이하거나 모순되게 만드는
         * 것 외에 할 수 있는 일이 없었다 — 그 사실을 칸 아래 힌트가 "같은 분야 목록에서
         * 고릅니다" 라고 적어 두고 있었다. 더 중요한 쪽은 리포트다: 분야별 집계가 `prj_field` 로
         * 묶이는데 거기 세부 값이 들어 있었으니 열여덟 갈래로 쪼개진 막대가 나왔고, 그건 "사업의
         * 어느 쪽이 버는가" 에 대한 답이 아니다. `PRJCAT` 도메인과 기존 값의 이전은
         * db/016_project_fields.sql 에 있다.
         *
         * 두 칸의 값이 서로 맞는지는 **아무도 검사하지 않는다.** '기술·공학 / 의학·제약' 같은
         * 조합이 저장될 수 있다는 뜻이다. 그 짝을 코드로 못박으려면 분류마다 어떤 세부 분야가
         * 속하는지의 표가 있어야 하는데, 그 표는 이 회사가 정할 일이고 유지보수 화면에서 목록을
         * 고치면 곧 어긋난다 — 016 헤더가 같은 판단을 적어 두고 있다.
         */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="prj-field">
            분야
          </label>
          <CodeSelect
            id="prj-field"
            domain={CODE_DOMAIN.PRJCAT}
            value={form.prjField}
            onChange={(v) => set('prjField', v)}
            placeholder={unsetPlaceholder(isEdit, form.prjField)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="prj-field2">
            세부 분야
          </label>
          <CodeSelect
            id="prj-field2"
            domain={CODE_DOMAIN.FIELD}
            value={form.prjField2}
            onChange={(v) => set('prjField2', v)}
            placeholder={unsetPlaceholder(isEdit, form.prjField2)}
          />
        </div>

        {/* '세금계산서 번호' 가 있던 자리 — 위 세금계산서 칸과 같은 이유로 뺐다. */}
        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="prj-content">
            내용
          </label>
          <textarea
            id="prj-content"
            className={ui.textarea}
            rows={3}
            value={form.prjContent}
            onChange={(e) => set('prjContent', e.target.value)}
          />
        </div>
      </div>

      <p className={ui.hint}>
        영업담당자와 PM 은 이 화면에서 지정하지 않습니다. 직원 목록 API 가 준비되면 추가됩니다 —
        기존에 지정된 담당자는 저장해도 바뀌지 않습니다.
      </p>
    </Modal>
  )
}
