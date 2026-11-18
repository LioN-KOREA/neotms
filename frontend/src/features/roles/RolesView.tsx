import { useMemo, useState } from 'react'
import { useDeleteRole, useUpdateRole } from '@/apis/queries/neotms.mutation'
import { useRoleGrants } from '@/apis/queries/neotms.query'
import type { RoleAdminRow } from '@/apis/neotms.types'
import { LABELLED_PERMISSIONS, PERMISSION_GROUPS } from '@/shared/permissionLabels'
import { ErrorNotice, SuccessNotice, TableState } from '@/shared/ui/Feedback'
import { ActiveChip } from '@/shared/ui/StatusChip'
import ui from '@/shared/ui/ui.module.css'
import { RoleFormModal } from './RoleFormModal'
import { RolePermissionsModal } from './RolePermissionsModal'

/**
 * 역할 관리 — 역할과 그 역할이 가진 권한.
 *
 * ## 사용자 관리와 다른 화면인 이유
 *
 * 사용자 관리는 **이 사람에게 어떤 역할을 줄까** 를 정한다. 이 화면은 **그 역할이 무엇을 뜻하는지**
 * 를 정한다. 둘은 영향 범위가 다르다 — 앞의 것은 한 사람을, 뒤의 것은 그 역할을 가진 모든 사람을
 * 한 번에 바꾸고, 바뀐 사람들에게는 아무 알림도 가지 않는다.
 *
 * 그래서 서버도 두 화면을 다르게 막는다. 사용자 관리는 '역할 배정' 권한으로 열리고, 이 화면은
 * **시스템관리자 속성**이 있어야 열린다. 권한으로 막으면 그 권한을 가진 역할이 자기 자신에게
 * 나머지 권한을 전부 부여할 수 있고, 그러면 문을 지키는 자물쇠가 문 안쪽에 있는 셈이 된다.
 *
 * ## 권한이 하나도 없는 역할을 눈에 띄게 적는다
 *
 * 새 역할은 권한 0개로 만들어진다(서버가 그렇게 만든다 — 그럴듯한 기본값을 물려주면 아무도
 * 의도하지 않은 권한이 조용히 생긴다). 그 상태로 배정하면 받은 사람은 빈 사이드바를 보고
 * "로그인이 안 된다" 고 말한다. 목록에서 0개 역할에 경고를 붙이는 것이 그 전화를 막는 유일한
 * 장치다.
 */
export function RolesView() {
  const grantsQuery = useRoleGrants()
  const updateRole = useUpdateRole()
  const deleteRole = useDeleteRole()

  const [editing, setEditing] = useState<RoleAdminRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [permissionsFor, setPermissionsFor] = useState<RoleAdminRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const items = useMemo(() => grantsQuery.data?.items ?? [], [grantsQuery.data])
  const emptyRoles = useMemo(
    () => items.filter((role) => role.active && role.permissions.length === 0).length,
    [items],
  )

  /*
   * 라벨이 없는 권한 이름.
   *
   * 서버에 권한이 추가됐는데 이 화면의 설명 목록(`permissionLabels.ts`)에 안 들어온 경우다.
   * 테스트가 그 둘이 같은 집합인지 확인하지만, 배포 시점이 어긋날 수 있다 — 그때 체크박스가
   * 조용히 사라지면 그 권한은 이 화면에서 **끌 수도 켤 수도 없는 권한**이 된다. 그래서 숫자로
   * 적어 둔다.
   */
  const unlabelled = useMemo(() => {
    const known = new Set<string>(LABELLED_PERMISSIONS)
    const extra = new Set<string>()
    for (const role of items) for (const name of role.permissions) if (!known.has(name)) extra.add(name)
    return [...extra].sort()
  }, [items])

  const onToggleActive = async (role: RoleAdminRow) => {
    const label = role.roleName || role.roleCode
    await updateRole.mutateAsync({ id: role.id, input: { active: !role.active } })
    setNotice(
      role.active
        ? `'${label}' 을(를) 사용 중지했습니다. 역할 드롭다운에서 사라지지만, 이미 이 역할을 가진 사람은 그대로 가지고 있습니다.`
        : `'${label}' 을(를) 다시 사용합니다.`,
    )
  }

  const onDelete = async (role: RoleAdminRow) => {
    const label = role.roleName || role.roleCode
    /*
     * 확인 문구에 '사용 중지' 를 같이 적는다. 이 화면에 온 사람의 목적은 보통 "이 역할을 더 쓰지
     * 않겠다" 이고, 그 목적에 맞는 수단은 대개 삭제가 아니다. 보유자가 있으면 서버가 409 로
     * 막아 주지만, 그 전에 한 번 알려 주는 쪽이 낫다 — CodeFormModal 의 삭제와 같은 판단이다.
     */
    const confirmed = window.confirm(
      `'${label}' 역할을 삭제합니다.\n\n` +
        `이 역할에 부여된 권한 ${String(role.permissions.length)}개도 함께 사라집니다. ` +
        `되돌릴 수 없습니다.\n\n` +
        `더 쓰지 않을 역할이라면 삭제보다 '사용 중지' 가 맞습니다 — 드롭다운에서는 사라지고, ` +
        `이미 가진 사람은 그대로 유지됩니다.\n\n계속하시겠습니까?`,
    )
    if (!confirmed) return
    await deleteRole.mutateAsync(role.id)
    setNotice(`역할 '${label}' 을(를) 삭제했습니다.`)
  }

  return (
    <div className={ui.page}>
      {/* 제목은 셸의 경로 표시줄이 들고 있다 — NeotmsApp.module.css 의 `.crumb` 주석. */}
      <div className={ui.pageBar}>
        <p className={ui.pageNote}>
          <b>역할</b>이 무엇을 뜻하는지 정하는 화면입니다. 여기서 권한을 바꾸면 그 역할을 가진{' '}
          <b>모든 사람</b>에게 적용되고, 당사자에게 알림은 가지 않습니다. 특정한 한 사람의 역할을
          바꾸려면 <b>사용자 관리</b> 화면을 쓰십시오.
        </p>
        <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => setCreating(true)}>
          역할 등록
        </button>
      </div>

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}
      <ErrorNotice error={grantsQuery.error ?? updateRole.error ?? deleteRole.error} />

      {emptyRoles > 0 ? (
        <div className={`${ui.alert} ${ui.alertWarn}`} role="alert">
          권한이 하나도 없는 역할이 {emptyRoles}개 있습니다. 이 역할을 배정받은 사람은 로그인은
          되지만 사이드바가 비어 있고, 보통 "로그인이 안 된다" 고 말합니다. 아래에서 권한을
          선택해 주십시오.
        </div>
      ) : null}

      {unlabelled.length > 0 ? (
        <div className={`${ui.alert} ${ui.alertWarn}`} role="alert">
          이 화면이 설명을 갖고 있지 않은 권한이 {unlabelled.length}개 있습니다(
          <code>{unlabelled.join(', ')}</code>). 서버에는 있고 이 화면에는 없는 상태이므로, 아래
          권한 편집에서 켜거나 끌 수 없습니다 — 프론트엔드를 다시 배포해야 합니다.
        </div>
      ) : null}

      <div className={ui.card}>
        <div className={`${ui.cardBodyFlush} ${ui.tableWrap}`}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>역할</th>
                <th>코드</th>
                <th>권한</th>
                <th>보유자</th>
                <th>상태</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <TableState
                isLoading={grantsQuery.isLoading}
                error={grantsQuery.error}
                isEmpty={items.length === 0}
                emptyText="역할이 없습니다. 위의 '역할 등록' 으로 만들 수 있습니다."
                colSpan={6}
              />
              {items.map((role) => (
                <tr key={role.id}>
                  <td>
                    {role.roleName || <span className={ui.cellMuted}>(이름 없음)</span>}
                  </td>
                  <td className={ui.cellMono}>{role.roleCode}</td>
                  <td>
                    {role.permissions.length === 0 ? (
                      <span className={`${ui.badge} ${ui.badgeWarn}`}>없음</span>
                    ) : (
                      <>
                        {role.permissions.length}개
                        {/*
                         * 묶음 이름만 적는다. 36개 이름을 한 칸에 넣으면 표가 읽히지 않고,
                         * 어느 묶음에 권한이 있는지가 "이 역할이 무슨 일을 하는 역할인가" 에
                         * 대한 답으로는 충분하다. 정확한 내용은 권한 편집에서 본다.
                         */}
                        <div className={ui.cellMuted}>
                          {PERMISSION_GROUPS.filter((group) =>
                            group.permissions.some((permission) =>
                              role.permissions.includes(permission.name),
                            ),
                          )
                            .map((group) => group.label)
                            .join(' · ')}
                        </div>
                      </>
                    )}
                  </td>
                  <td>
                    {role.staffCount}명
                    {role.holders > role.staffCount ? (
                      <div className={ui.cellMuted}>
                        퇴사 {role.holders - role.staffCount}명
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <ActiveChip active={role.active} on="사용 중" off="사용 중지" />
                  </td>
                  <td>
                    <div className={ui.rowActions}>
                    <button
                      type="button"
                      className={ui.btnGhost}
                      onClick={() => setPermissionsFor(role)}
                    >
                      권한 편집
                    </button>
                    <button type="button" className={ui.btnGhost} onClick={() => setEditing(role)}>
                      수정
                    </button>
                    <button
                      type="button"
                      className={ui.btnGhost}
                      onClick={() => void onToggleActive(role)}
                      disabled={updateRole.isPending}
                    >
                      {role.active ? '사용 중지' : '다시 사용'}
                    </button>
                    <button
                      type="button"
                      className={`${ui.btnGhost} ${ui.btnDanger}`}
                      onClick={() => void onDelete(role)}
                      disabled={deleteRole.isPending || role.holders > 0}
                      title={
                        role.holders > 0
                          ? '이 역할을 가진 사람이 있어 삭제할 수 없습니다. 먼저 다른 역할로 옮기거나, 사용 중지로 내려 주십시오.'
                          : undefined
                      }
                    >
                        삭제
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {creating ? (
        <RoleFormModal
          role={null}
          onClose={() => setCreating(false)}
          onSaved={(message, created) => {
            setNotice(message)
            // 만든 직후 권한 편집을 바로 연다. 두 단계라는 사실을 숨기지 않으면서, 두 번째
            // 단계를 잊기 어렵게 만드는 방법이다.
            if (created) setPermissionsFor(created)
          }}
        />
      ) : null}

      {editing ? (
        <RoleFormModal
          role={editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => setNotice(message)}
        />
      ) : null}

      {permissionsFor ? (
        <RolePermissionsModal
          role={permissionsFor}
          onClose={() => setPermissionsFor(null)}
          onSaved={(message) => setNotice(message)}
        />
      ) : null}
    </div>
  )
}
