import { useMemo, useState } from 'react'
import { useSetRolePermissions } from '@/apis/queries/neotms.mutation'
import type { RoleAdminRow } from '@/apis/neotms.types'
import { NEOTMS_PERMISSION_STAFF_UPDATE } from '@/apis/neotms.authorities'
import { PERMISSION_GROUPS } from '@/shared/permissionLabels'
import { ErrorNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'

interface Props {
  role: RoleAdminRow
  onClose: () => void
  onSaved: (message: string) => void
}

/**
 * 역할의 권한 편집.
 *
 * ## 저장은 체크된 것 **전체**를 보낸다
 *
 * 추가·삭제 목록이 아니라 "저장 후의 상태" 다. 차이 계산을 클라이언트가 하면, 두 관리자가 두
 * 탭에서 같은 역할을 고쳤을 때 결과가 둘 중 하나가 아니라 **둘의 합집합**이 된다 — 둘 다 자기가
 * 의도한 대로 저장됐다고 믿고, 실제로는 아무도 의도하지 않은 조합이 남는다.
 *
 * ## 몇 명이 영향을 받는지 먼저 적는다
 *
 * 이 화면의 저장 한 번이 그 역할을 가진 **모든 사람**의 권한을 바꾸고, 그들에게는 아무 알림도
 * 가지 않는다. 한 사람의 역할을 바꾸는 사용자 관리 화면과 다른 점이 그것이고, 그래서 보유자
 * 수를 제목 옆이 아니라 본문 맨 위에 적는다.
 *
 * ## 전체 선택 버튼을 묶음별로만 둔다
 *
 * '전부 선택' 을 하나 두면 한 번 눌러 36개가 켜지고, 그게 이 화면에서 가장 하기 쉬운 일이 된다 —
 * 역할을 나누는 화면에서 가장 하기 쉬운 일이 "모든 권한 주기" 여서는 안 된다. 묶음별 선택은
 * "프로젝트는 다 되게" 처럼 실제로 사람이 하는 말과 모양이 같다.
 */
export function RolePermissionsModal({ role, onClose, onSaved }: Props) {
  const setPermissions = useSetRolePermissions()
  const pending = setPermissions.isPending

  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(role.permissions))
  const [dirty, setDirty] = useState(false)

  const toggle = (name: string) => {
    setDirty(true)
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const setGroup = (names: readonly string[], on: boolean) => {
    setDirty(true)
    setPicked((prev) => {
      const next = new Set(prev)
      for (const name of names) {
        if (on) next.add(name)
        else next.delete(name)
      }
      return next
    })
  }

  const label = role.roleName || role.roleCode

  /*
   * 서버가 거절할 저장을 미리 알려 준다.
   *
   * 마지막 `STAFF_UPDATE` 를 거두면 아무도 사용자 관리 화면에 들어갈 수 없게 되고, 그 저장을
   * 되돌릴 화면이 바로 그 화면이다. 서버가 409 로 거절하므로 사고는 일어나지 않지만, 저장을
   * 누른 뒤에 읽는 설명보다 누르기 전에 보이는 경고가 낫다 — 여기서는 "이 역할이 그 권한을
   * 가지고 있었는데 지금 체크가 풀렸다" 까지만 알 수 있고, 다른 역할이 그 권한을 갖고 있는지는
   * 서버만 안다. 그래서 문구가 단정하지 않고 '확인한다' 로 적혀 있다.
   */
  const removingStaffUpdate =
    role.permissions.includes(NEOTMS_PERMISSION_STAFF_UPDATE) &&
    !picked.has(NEOTMS_PERMISSION_STAFF_UPDATE)

  const changed = useMemo(() => {
    const before = new Set(role.permissions)
    if (before.size !== picked.size) return true
    for (const name of picked) if (!before.has(name)) return true
    return false
  }, [picked, role.permissions])

  const onSubmit = async () => {
    await setPermissions.mutateAsync({
      id: role.id,
      // 정렬해서 보낸다. 서버는 순서를 보지 않지만, 요청 본문이 로그에 남을 때 같은 집합이
      // 항상 같은 모양이면 두 요청을 눈으로 비교할 수 있다.
      input: { permissions: [...picked].sort() },
    })
    onSaved(`'${label}' 역할의 권한을 저장했습니다. 보유자 ${String(role.staffCount)}명에게 적용됩니다.`)
    onClose()
  }

  return (
    <Modal
      title={`권한 편집 — ${label}`}
      onClose={onClose}
      isDirty={dirty && !pending}
      width={760}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose} disabled={pending}>
            취소
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void onSubmit()}
            disabled={pending || !changed}
          >
            {pending ? '저장 중…' : `저장 (${String(picked.size)}개)`}
          </button>
        </>
      }
    >
      <ErrorNotice error={setPermissions.error} />

      <div className={`${ui.alert} ${ui.alertInfo}`}>
        이 역할을 가진 <b>{role.staffCount}명</b>의 권한이 저장과 동시에 바뀝니다. 당사자에게
        알림은 가지 않습니다. 각자의 화면에 반영되기까지는 최대 1분 정도 걸립니다.
        {role.holders > role.staffCount ? (
          <>
            {' '}
            (퇴사 처리된 {role.holders - role.staffCount}명도 이 역할을 들고 있습니다.)
          </>
        ) : null}
      </div>

      {removingStaffUpdate ? (
        <div className={`${ui.alert} ${ui.alertWarn}`} role="alert">
          <b>사용자 관리 &gt; 역할 배정</b> 권한을 거두고 있습니다. 이 권한을 가진 사람이 아무도
          남지 않으면 누구도 역할을 배정할 수 없게 되고, 그것을 되돌릴 화면이 바로 그 화면입니다.
          다른 역할이나 시스템관리자 속성으로 그 경로가 남아 있는지 서버가 확인하고, 남아 있지
          않으면 저장을 거절합니다.
        </div>
      ) : null}

      {PERMISSION_GROUPS.map((group) => {
        const names = group.permissions.map((permission) => permission.name)
        const on = names.filter((name) => picked.has(name)).length
        return (
          <div className={ui.card} key={group.id}>
            <div className={ui.cardHeader}>
              <div>
                <b>{group.label}</b>{' '}
                <small>
                  {on}/{names.length}
                </small>
                <div className={ui.cellMuted}>{group.hint}</div>
              </div>
              <div>
                <button
                  type="button"
                  className={ui.btnGhost}
                  onClick={() => setGroup(names, true)}
                  disabled={pending || on === names.length}
                >
                  이 묶음 전체
                </button>
                <button
                  type="button"
                  className={ui.btnGhost}
                  onClick={() => setGroup(names, false)}
                  disabled={pending || on === 0}
                >
                  해제
                </button>
              </div>
            </div>
            <div className={ui.cardBody}>
              <div className={ui.checkGrid}>
                {group.permissions.map((permission) => (
                  <label className={ui.check} key={permission.name}>
                    <input
                      type="checkbox"
                      checked={picked.has(permission.name)}
                      onChange={() => toggle(permission.name)}
                      disabled={pending}
                    />
                    <span className={ui.checkText}>
                      <span className={ui.checkLabel}>
                        {permission.label}
                        {permission.sensitive ? (
                          <span className={`${ui.badge} ${ui.badgeWarn}`}>주의</span>
                        ) : null}
                      </span>
                      <span className={ui.checkDesc}>{permission.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )
      })}
    </Modal>
  )
}
