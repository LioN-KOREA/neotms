import { useState } from 'react'
import { useCreateRole, useUpdateRole } from '@/apis/queries/neotms.mutation'
import type { RoleAdminRow } from '@/apis/neotms.types'
import { ErrorNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'

interface Props {
  /** null 이면 신규. */
  role: RoleAdminRow | null
  onClose: () => void
  /** 새로 만든 역할을 넘겨 준다 — 호출하는 쪽이 이어서 권한 편집을 연다. */
  onSaved: (message: string, created: RoleAdminRow | null) => void
}

/** `NEOTMS_SYSADMIN` 처럼 대문자·숫자·밑줄, 첫 글자는 영문 대문자. 서버의 `RoleCodeSchema` 와 같다. */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]*$/u

/**
 * 역할 등록·수정.
 *
 * ## 역할 코드는 등록할 때만 입력받는다
 *
 * 수정 화면에서는 글자로만 보여 준다. 코드로 역할을 찾는 것들이 있기 때문이다 —
 * `staff_bootstrap_superuser()` 는 첫 관리자에게 줄 역할을 코드로 찾고, 초기 데이터 스크립트는
 * `ON CONFLICT (role_code)` 로 권한을 다시 부여하고, `sys_role_grant_all_permissions(text)` 는
 * 코드를 인수로 받는다. 이름을 바꾸면 그 전부가 없는 행을 찾게 되고, 최악의 경우 증상이 없다 —
 * 부트스트랩이 조용히 역할을 못 찾게 되고, 그걸 알게 되는 날은 그게 필요한 날이다.
 *
 * 사람들이 실제로 바꾸고 싶어 하는 것은 **표시 이름**이고, 그건 바꿀 수 있다.
 *
 * ## 새 역할은 권한이 하나도 없이 만들어진다
 *
 * 서버가 그렇게 만든다. 저장 직후 권한 편집 화면을 바로 열어 주는 것이 이 모달의 일이고, 그게
 * 두 단계라는 사실을 숨기지 않는 방법이다 — "만들었으니 됐다" 로 끝나면 아무 권한도 없는 역할이
 * 배정되고, 받은 사람은 빈 사이드바를 본다.
 */
export function RoleFormModal({ role, onClose, onSaved }: Props) {
  const isEdit = !!role
  const createRole = useCreateRole()
  const updateRole = useUpdateRole()
  const pending = createRole.isPending || updateRole.isPending

  const [form, setForm] = useState({
    roleCode: role?.roleCode ?? '',
    roleName: role?.roleName ?? '',
    active: role?.active ?? true,
  })
  const [dirty, setDirty] = useState(false)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setDirty(true)
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const trimmedCode = form.roleCode.trim().toUpperCase()
  const codeOk = CODE_SHAPE.test(trimmedCode)
  const canSave = isEdit ? true : codeOk

  const onSubmit = async () => {
    if (!canSave) return
    const label = form.roleName.trim() || trimmedCode

    if (role) {
      await updateRole.mutateAsync({
        id: role.id,
        input: { roleName: form.roleName.trim() || null, active: form.active },
      })
      onSaved(`역할 '${label}' 을(를) 수정했습니다.`, null)
    } else {
      const created = await createRole.mutateAsync({
        roleCode: trimmedCode,
        roleName: form.roleName.trim() || null,
        active: form.active,
      })
      onSaved(`역할 '${label}' 을(를) 만들었습니다. 이어서 권한을 선택해 주십시오.`, created)
    }
    onClose()
  }

  return (
    <Modal
      title={isEdit ? '역할 수정' : '역할 등록'}
      onClose={onClose}
      isDirty={dirty && !pending}
      width={560}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose} disabled={pending}>
            취소
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void onSubmit()}
            disabled={pending || !canSave}
          >
            {pending ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      <ErrorNotice error={createRole.error ?? updateRole.error} />

      <div className={ui.formGrid}>
        <div className={ui.fieldWide}>
          <label className={`${ui.label} ${isEdit ? '' : ui.required}`} htmlFor="role-code">
            역할 코드
          </label>
          {isEdit ? (
            <>
              {/* 입력란이 아니라 글자다. disabled 입력란으로 두면 "왜 안 되지" 를 먼저 겪고
                  설명은 그 다음에 읽힌다 — CodeFormModal 의 코드값과 같은 이유다. */}
              <p className={ui.inputMono}>{role.roleCode}</p>
              <span className={ui.hint}>
                역할 코드는 변경할 수 없습니다. 초기화 스크립트와 복구 함수가 이 값으로 역할을
                찾기 때문입니다. 표시 이름은 아래에서 바꿀 수 있습니다.
              </span>
            </>
          ) : (
            <>
              <input
                id="role-code"
                className={`${ui.input} ${ui.inputMono}`}
                value={form.roleCode}
                onChange={(e) => set('roleCode', e.target.value.toUpperCase())}
                placeholder="PROJECT_MANAGER"
                autoComplete="off"
              />
              <span className={ui.hint}>
                영문 대문자·숫자·밑줄만 사용합니다(예: <code>PROJECT_MANAGER</code>). 나중에 바꿀
                수 없으니 직책을 그대로 적어 주십시오.
              </span>
              {form.roleCode.trim().length > 0 && !codeOk ? (
                <span className={ui.hintWarn}>
                  영문 대문자로 시작하고, 대문자·숫자·밑줄만 쓸 수 있습니다.
                </span>
              ) : null}
            </>
          )}
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="role-name">
            표시 이름
          </label>
          <input
            id="role-name"
            className={ui.input}
            value={form.roleName}
            onChange={(e) => set('roleName', e.target.value)}
            placeholder="프로젝트 매니저"
          />
          <span className={ui.hint}>
            사용자 관리 화면의 역할 드롭다운에 이 이름이 나옵니다. 비워 두면 역할 코드가 그대로
            보입니다.
          </span>
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.check}>
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => set('active', e.target.checked)}
            />
            <span className={ui.checkText}>
              <span className={ui.checkLabel}>사용 중</span>
              <span className={ui.checkDesc}>
                해제하면 사용자 관리의 역할 드롭다운에서 사라집니다. <b>이미 이 역할을 가진 사람은
                그대로 가지고 있고, 권한도 그대로 작동합니다</b> — 더 쓰지 않을 역할은 삭제가
                아니라 이쪽이 맞습니다. 삭제는 아무도 들고 있지 않을 때만 됩니다.
              </span>
            </span>
          </label>
        </div>
      </div>
    </Modal>
  )
}
