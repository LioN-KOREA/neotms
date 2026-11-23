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

/**
 * Create or edit a role.
 *
 * ## It does not ask for a role code
 *
 * It used to: a box for something like `PROJECT_MANAGER`, filled in at create time. Two reasons it
 * is gone, and both of them happened:
 *
 *   * `role_code` is a SURROGATE key. Nothing reads meaning out of it, so the box asked somebody
 *     who had no reason to know the rules (upper case, digits, underscores) to follow them. A
 *     Korean label is refused, which reads as the form being broken rather than as a rule.
 *   * Whatever was typed is PERMANENT. There is no path in this system that renames a code.
 *
 * The server mints it now (`newRoleCode()` - `ROLE_` plus a UUID). The edit screen shows that value
 * as text, because things resolve a role BY it: the two bootstrap functions look up the role to
 * give an administrator, the seed re-asserts grants `ON CONFLICT (role_code)`, and
 * `sys_role_grant_all_permissions(text)` takes one as its argument. Change it and all of them look
 * for a row that no longer answers - and in the worst case there is no symptom at all, until the
 * day somebody needs the way back in.
 *
 * ## Which is why the name is required
 *
 * The name is now the only thing that tells two roles apart on screen. Leave it blank and the
 * assignment dropdown offers `ROLE_9F3C...`, which nobody can choose between.
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
    roleName: role?.roleName ?? '',
    active: role?.active ?? true,
  })
  const [dirty, setDirty] = useState(false)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setDirty(true)
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  // The same condition as the server's `v.minLength(1)`. The name is the only way to tell roles
  // apart now, so it cannot be blank.
  const trimmedName = form.roleName.trim()
  const canSave = trimmedName.length > 0

  const onSubmit = async () => {
    if (!canSave) return
    const label = trimmedName

    if (role) {
      await updateRole.mutateAsync({
        id: role.id,
        input: { roleName: trimmedName, active: form.active },
      })
      onSaved(`역할 '${label}' 을(를) 수정했습니다.`, null)
    } else {
      const created = await createRole.mutateAsync({
        roleName: trimmedName,
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
          <label className={`${ui.label} ${ui.required}`} htmlFor="role-name">
            역할 이름
          </label>
          <input
            id="role-name"
            className={ui.input}
            value={form.roleName}
            onChange={(e) => set('roleName', e.target.value)}
            placeholder="프로젝트 매니저"
            maxLength={100}
            autoFocus
          />
          <span className={ui.hint}>
            사용자 관리 화면의 역할 드롭다운에 이 이름이 나옵니다. 나중에 바꿀 수 있습니다.
          </span>
        </div>

        {isEdit ? (
          <div className={ui.fieldWide}>
            <span className={ui.label}>내부 식별자</span>
            {/* Text, not a disabled input. A disabled input makes somebody try it first and
                read the explanation second - the same reasoning as the code value in
                CodeFormModal. */}
            <p className={ui.inputMono}>{role.roleCode}</p>
            <span className={ui.hint}>
              서버가 만든 값이고 바꿀 수 없습니다. 초기화 스크립트와 복구 함수가 이 값으로 역할을
              찾기 때문입니다. 문의할 때만 쓰는 값이니 외우실 필요는 없습니다.
            </span>
          </div>
        ) : null}

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
