import { useState } from 'react'
import { useUpdateStaff } from '@/apis/queries/neotms.mutation'
import { useRoles } from '@/apis/queries/neotms.query'
import type { StaffRow, StaffUpdateInput } from '@/apis/neotms.types'
import { ErrorNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'

interface Props {
  staff: StaffRow
  /** 호출자가 자기 자신을 열었는지. 서버도 막지만, 눌러 보기 전에 알려 주는 쪽이 낫다. */
  isSelf: boolean
  onClose: () => void
  onSaved: (message: string) => void
}

/**
 * 역할 배정.
 *
 * ## 이 모달이 바꾸는 값이 앱의 모든 권한이다
 *
 * `role_id` 는 `sys_role_auth` 를 거쳐 메뉴 x 동작 행렬이 되고, `view_scope` 는 목록 쿼리의
 * WHERE 절이 된다. 이 두 칸 말고는 아무것도 쓰지 않는다 — 이름·메일·전화는 본인이 자기 프로필에서
 * 관리하고, 역할을 배정하는 관리자가 남의 전화번호를 고칠 이유가 없다.
 *
 * ## '역할 없음' 을 고를 수 있게 둔다
 *
 * 비워 두는 것이 가입 요청 상태이고(자가 가입은 `role_id = NULL` 로 시작한다), 계정을 삭제하지
 * 않고 권한만 회수하는 수단이기도 하다 — 그 사람은 계속 로그인되지만 아무것도 할 수 없다.
 * 퇴사자에게는 보통 '사용 중지' 가 맞고, 권한을 다시 검토하는 동안 잠시 멈추는 것이라면 이쪽이
 * 맞다.
 *
 * ## 열람 범위를 라디오로 둔 이유
 *
 * 체크박스 하나로 두면 "전체 열람" 이 꺼진 상태가 두 가지로 읽힌다 — 내 담당분만 보도록 정한
 * 것인지, 아직 정하지 않은 것인지. `view_scope` 는 'Y' 가 아닌 모든 값(NULL·빈 문자열 포함)을
 * 내 담당분만으로 해석하므로(서버의 `VIEW_SCOPE_ALL`), ETL 로 들어온 행은 실제로 "정해지지
 * 않은" 상태로 존재한다. 두 선택지를 나란히 보여 주면 저장하는 순간 둘 중 하나로 확정된다.
 */
export function StaffRoleModal({ staff, isSelf, onClose, onSaved }: Props) {
  const rolesQuery = useRoles()
  const updateStaff = useUpdateStaff()
  const pending = updateStaff.isPending

  const [roleId, setRoleId] = useState<string>(staff.roleId ?? '')
  const [scopeAll, setScopeAll] = useState<boolean>(staff.viewScope === 'Y')
  const [active, setActive] = useState<boolean>(staff.active)
  const [dirty, setDirty] = useState(false)

  const roles = rolesQuery.data?.items ?? []
  const label = staff.name?.trim() || staff.mgrId

  /*
   * 바뀐 칸만 보낸다.
   *
   * 서버 스키마가 `v.partial` 이라 생략된 키는 "건드리지 않음" 이고, 명시적 `null` 은 "회수" 다.
   * 세 칸을 늘 전부 보내면 두 관리자가 같은 사람을 동시에 열었을 때 나중에 저장한 쪽이 앞사람의
   * 변경을 자기 화면의 옛 값으로 덮어쓴다 — 역할만 바꾸려던 사람이 열람 범위까지 되돌리는 식이다.
   */
  const onSubmit = async () => {
    const input: StaffUpdateInput = {}
    const nextRoleId = roleId === '' ? null : roleId
    if (nextRoleId !== staff.roleId) input.roleId = nextRoleId
    const nextScope = scopeAll ? 'Y' : 'N'
    if (nextScope !== staff.viewScope) input.viewScope = nextScope
    if (active !== staff.active) input.active = active

    if (Object.keys(input).length === 0) {
      onClose()
      return
    }

    await updateStaff.mutateAsync({ id: staff.id, input })

    const roleLabel =
      nextRoleId === null
        ? '역할 없음'
        : roles.find((r) => r.id === nextRoleId)?.roleName ?? '변경된 역할'
    onSaved(`${label} 님의 권한을 저장했습니다. (${roleLabel})`)
    onClose()
  }

  return (
    <Modal
      title={`${label} 님의 권한`}
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
            disabled={pending}
          >
            {pending ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      {/* 서버의 409(자기 역할 회수·자기 비활성화)와 23503(없는 역할)이 그대로 보여야 한다. */}
      <ErrorNotice error={updateStaff.error} />

      {isSelf ? (
        <div className={`${ui.alert} ${ui.alertWarn}`} role="alert">
          본인 계정입니다. 자신의 역할을 '역할 없음' 으로 바꾸거나 자신을 사용 중지할 수는
          없습니다 — 그렇게 하면 되돌릴 화면에 스스로 접근할 수 없게 되기 때문입니다. 필요하다면
          다른 관리자에게 요청해 주십시오.
        </div>
      ) : null}

      {staff.roleId === null ? (
        <div className={`${ui.alert} ${ui.alertInfo}`} role="alert">
          아직 역할이 배정되지 않은 가입 요청입니다. 이 분은 지금 로그인은 되지만 어떤 메뉴도 쓸
          수 없고, 승인을 기다리는 안내 화면을 보고 있습니다.
        </div>
      ) : null}

      <div className={ui.formGrid}>
        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="staff-role">
            역할
          </label>
          <select
            id="staff-role"
            className={ui.select}
            value={roleId}
            onChange={(e) => {
              setDirty(true)
              setRoleId(e.target.value)
            }}
            disabled={rolesQuery.isLoading}
          >
            <option value="">(역할 없음 — 로그인만 되고 아무것도 할 수 없습니다)</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.roleName ? `${role.roleName} (${role.roleCode})` : role.roleCode}
              </option>
            ))}
            {/*
             * 지금 역할이 목록에 없을 때를 위한 항목. 역할이 '사용 중지' 되면 배정 목록에서는
             * 빠지지만 이미 그 역할을 가진 사람은 계속 갖고 있다. 이 항목이 없으면 `<select>` 가
             * 첫 option('역할 없음')을 선택된 것처럼 보여 주고, 열람 범위만 고치려고 열었다가
             * 저장하는 순간 그 사람의 역할이 조용히 사라진다.
             */}
            {staff.roleId && !roles.some((r) => r.id === staff.roleId) ? (
              <option value={staff.roleId}>
                {staff.roleName || staff.roleCode || '현재 역할'} (사용 중지된 역할)
              </option>
            ) : null}
          </select>
          <span className={ui.hint}>
            역할이 메뉴별로 조회·등록·수정·삭제·내보내기 권한을 결정합니다. 역할 자체의 권한
            구성은 이 화면에서 바꿀 수 없습니다.
          </span>
        </div>

        <div className={ui.fieldWide}>
          <span className={ui.label}>열람 범위</span>
          <label className={ui.check}>
            <input
              type="radio"
              name="staff-scope"
              checked={!scopeAll}
              onChange={() => {
                setDirty(true)
                setScopeAll(false)
              }}
            />
            <span className={ui.checkText}>
              <span className={ui.checkLabel}>본인 담당분만</span>
              <span className={ui.checkDesc}>
                자신이 담당자로 지정된 프로젝트·작업·발주만 보입니다. 목록과 보고서의 숫자도 그
                범위로 계산됩니다.
              </span>
            </span>
          </label>
          <label className={ui.check}>
            <input
              type="radio"
              name="staff-scope"
              checked={scopeAll}
              onChange={() => {
                setDirty(true)
                setScopeAll(true)
              }}
            />
            <span className={ui.checkText}>
              <span className={ui.checkLabel}>회사 전체</span>
              <span className={ui.checkDesc}>
                담당자와 무관하게 모든 행이 보입니다. 매출·원가가 그대로 드러나므로 관리자와
                경영진에게만 주십시오.
              </span>
            </span>
          </label>
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.check}>
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => {
                setDirty(true)
                setActive(e.target.checked)
              }}
              disabled={isSelf}
            />
            <span className={ui.checkText}>
              <span className={ui.checkLabel}>사용 중</span>
              <span className={ui.checkDesc}>
                해제하면 이 분은 로그인할 수 없습니다. 퇴사자를 처리하는 올바른 방법입니다 —
                계정을 지우지 않으므로 이 분이 만든 프로젝트·작업·발주의 담당자 기록이 그대로
                남습니다.
              </span>
            </span>
          </label>
        </div>
      </div>
    </Modal>
  )
}
