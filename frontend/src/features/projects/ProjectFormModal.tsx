import { useState } from 'react'
import { useCreateProject, useUpdateProject } from '@/apis/queries/neotms.mutation'
import {
  codeOptions,
  COIN_CODES,
  INVOICE_STATES,
  MONEY_STATES,
  PROJECT_STATES,
} from '@/apis/neotms.codes'
import type { ProjectInput, ProjectRow } from '@/apis/neotms.types'
import { ErrorNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import type { PickerOption } from '@/shared/ui/RecordPicker'
import { toDateInputValue } from '@/shared/utils/format'
import ui from '@/shared/ui/ui.module.css'
import { CustomerPicker } from '@/features/customers/CustomerPicker'

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
 * ## 담당자(영업·PM)는 입력란이 없다
 *
 * `prjMgrId`·`prjPmId` 는 `staff` 를 참조하는 UUID 이고, 직원 목록 엔드포인트가 아직 없다.
 * UUID 를 손으로 치게 만드는 입력란은 틀린 값을 받는 장치일 뿐이므로 MVP 에서는 빼 두고,
 * 수정 시 기존 값이 지워지지 않도록 **아예 전송하지 않는다**(아래 `input` 구성 참고).
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

  const [form, setForm] = useState({
    prjName: project?.prjName ?? '',
    coinCode: project?.coinCode ?? 'KRW',
    prjField: project?.prjField ?? '',
    prjField2: project?.prjField2 ?? '',
    prjState: project?.prjState ?? '진행',
    prjInvoiceState: project?.prjInvoiceState ?? '미발행',
    prjMoneyState: project?.prjMoneyState ?? '미정산',
    prjSday: toDateInputValue(project?.prjSday),
    prjSdayTime: project?.prjSdayTime ?? '',
    prjEday: toDateInputValue(project?.prjEday),
    prjEdayTime: project?.prjEdayTime ?? '',
    invCode: project?.invCode ?? '',
    prjContent: project?.prjContent ?? '',
  })
  const [dirty, setDirty] = useState(false)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setDirty(true)
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const name = form.prjName.trim()
  const canSave = name.length > 0 && !!customer && !pending

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
      prjInvoiceState: form.prjInvoiceState.trim() || null,
      prjMoneyState: form.prjMoneyState.trim() || null,
      prjSday: form.prjSday || null,
      prjSdayTime: form.prjSdayTime || null,
      prjEday: form.prjEday || null,
      prjEdayTime: form.prjEdayTime || null,
      invCode: form.invCode.trim() || null,
      prjContent: form.prjContent.trim() || null,
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
          <label className={ui.label} htmlFor="prj-name">
            프로젝트명 <span className={ui.required}>*</span>
          </label>
          <input
            id="prj-name"
            className={ui.input}
            value={form.prjName}
            onChange={(e) => set('prjName', e.target.value)}
            required
          />
        </div>

        <div className={ui.fieldWide}>
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
            <option value="">선택 없음</option>
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
            <option value="">선택 없음</option>
            {codeOptions(COIN_CODES, form.coinCode).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="prj-invoice-state">
            세금계산서
          </label>
          <select
            id="prj-invoice-state"
            className={ui.select}
            value={form.prjInvoiceState}
            onChange={(e) => set('prjInvoiceState', e.target.value)}
          >
            <option value="">선택 없음</option>
            {codeOptions(INVOICE_STATES, form.prjInvoiceState).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

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
            <option value="">선택 없음</option>
            {codeOptions(MONEY_STATES, form.prjMoneyState).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/*
         * 시작일·납기를 날짜와 시각 두 칸으로 나눈 것은 컬럼이 그렇게 생겼기 때문이다
         * (`prj_sday` 는 date, `prj_sday_time` 은 별도 text). 하나의 datetime 입력으로 합치면
         * 시각이 비어 있는 기존 행에 00:00 이 들어가고, "그날 중" 이 "자정까지" 로 바뀐다.
         */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="prj-sday">
            시작일
          </label>
          <div className={ui.inputRow}>
            <input
              id="prj-sday"
              className={ui.input}
              type="date"
              value={form.prjSday}
              onChange={(e) => set('prjSday', e.target.value)}
            />
            <input
              className={ui.input}
              type="time"
              aria-label="시작 시각"
              value={form.prjSdayTime}
              onChange={(e) => set('prjSdayTime', e.target.value)}
            />
          </div>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="prj-eday">
            납기
          </label>
          <div className={ui.inputRow}>
            <input
              id="prj-eday"
              className={ui.input}
              type="date"
              value={form.prjEday}
              onChange={(e) => set('prjEday', e.target.value)}
            />
            <input
              className={ui.input}
              type="time"
              aria-label="납기 시각"
              value={form.prjEdayTime}
              onChange={(e) => set('prjEdayTime', e.target.value)}
            />
          </div>
          <span className={ui.hint}>시각을 비워 두면 '그날 중' 으로 봅니다.</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="prj-field">
            분야
          </label>
          <input
            id="prj-field"
            className={ui.input}
            value={form.prjField}
            onChange={(e) => set('prjField', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="prj-field2">
            세부 분야
          </label>
          <input
            id="prj-field2"
            className={ui.input}
            value={form.prjField2}
            onChange={(e) => set('prjField2', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="prj-inv-code">
            세금계산서 번호
          </label>
          <input
            id="prj-inv-code"
            className={`${ui.input} ${ui.inputMono}`}
            value={form.invCode}
            onChange={(e) => set('invCode', e.target.value)}
          />
        </div>

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
