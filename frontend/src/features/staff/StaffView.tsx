import { useMemo, useState } from 'react'
import { useProfile, useStaff } from '@/apis/queries/neotms.query'
import type { StaffRow } from '@/apis/neotms.types'
import { NeotmsMenuId } from '@/shared/config'
import { mayDo } from '@/shared/permissions'
import { ErrorNotice, SuccessNotice, TableState } from '@/shared/ui/Feedback'
import { ActiveChip } from '@/shared/ui/StatusChip'
import ui from '@/shared/ui/ui.module.css'
import { StaffRoleModal } from './StaffRoleModal'

/**
 * 사용자 관리 — 직원 목록과 역할 배정.
 *
 * ## 이 화면의 첫 줄이 알림 역할을 한다
 *
 * 자가 가입한 사용자는 `role_id = NULL` 로 들어와서 승인 안내 화면을 보며 기다린다. 이 시스템에는
 * 메일을 보내는 경로가 없으므로 관리자에게 아무것도 알려 주지 않는다 — 새 동료와 무한정 대기
 * 사이에 놓인 유일한 장치는 **그 행이 이 목록의 첫 줄이라는 사실**이다. 그래서 정렬은 서버가
 * 하고(`role_id IS NULL` 이 먼저, NeotmsStaffAdmin.dbops.ts) 이 화면은 다시 정렬하지 않는다.
 * 대기 건수를 맨 위에 따로 적어 두는 것도 같은 이유다.
 *
 * ## 등록 버튼이 없다
 *
 * 관리자는 직원 행을 만들 수 없다. 쓸 수 있는 행이 되려면 `lpx_sub` 가 있어야 하는데, 관리자가
 * 그걸 발급할 방법이 없다 — 지어내면 쓸 수 없는 행이 되거나, 더 나쁘게는 나중에 같은 메일로
 * 로그인한 사람이 가져갈 수 있는 행이 된다. 행은 레거시 ETL 과 본인 가입으로만 생기고, 관리자의
 * 일은 **승인**(수정)이다.
 *
 * ## 삭제 버튼도 없다
 *
 * 이 사람의 `mgr_id` 가 과거의 모든 프로젝트·작업·발주의 `created_by` 에 남아 있다. 접근을
 * 끝내는 방법은 '사용 중지' 이고, 그건 권한 모달 안에 있다. 직원 행을 실제로 지우는 일은 SQL 로만
 * 되게 두었다 — "직원 삭제" 가 "역할 변경" 옆의 버튼이어서는 안 된다.
 */

/** 역할이 없는 행 = 가입 요청. 서버의 `whyUnusable` 이 "no role" 로 분류하는 상태다. */
const isPending = (row: StaffRow) => row.roleId === null

export function StaffView() {
  const { data: profile } = useProfile()
  const staffQuery = useStaff()
  const [editing, setEditing] = useState<StaffRow | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const mayUpdate = mayDo(profile, NeotmsMenuId.STAFF, 'update')

  const items = useMemo(() => staffQuery.data?.items ?? [], [staffQuery.data])
  const pendingCount = useMemo(() => items.filter(isPending).length, [items])

  return (
    <div className={ui.page}>
      {/* 제목은 셸의 경로 표시줄이 들고 있다 — NeotmsApp.module.css 의 `.crumb` 주석. */}
      <div className={ui.pageBar}>
        <p className={ui.pageNote}>
          <b>역할</b>이 메뉴별 조회·등록·수정·삭제 권한을 결정하고, <b>열람 범위</b>가 본인
          담당분만 볼지 회사 전체를 볼지를 결정합니다.
        </p>
      </div>

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}
      <ErrorNotice error={staffQuery.error} />

      {/*
       * 대기 건수를 숫자로 적는다. 표의 첫 줄에 이미 올라와 있지만, 표를 스크롤해서 보고 있던
       * 관리자에게는 보이지 않는다. 0건일 때는 이 안내를 그리지 않는다 — 늘 떠 있는 배너는
       * 읽히지 않고, 읽히지 않는 배너는 1건이 생겼을 때도 읽히지 않는다.
       */}
      {pendingCount > 0 ? (
        <div className={`${ui.alert} ${ui.alertWarn}`} role="alert">
          승인을 기다리는 가입 요청이 {pendingCount}건 있습니다. 아래 목록 맨 위에 있습니다 — 역할을
          배정해 주시면 그때부터 서비스를 쓸 수 있습니다. 요청한 분에게는 알림이 가지 않으므로,
          이 화면이 유일한 확인 경로입니다.
        </div>
      ) : null}

      <div className={ui.card}>
        <div className={`${ui.cardBodyFlush} ${ui.tableWrap}`}>
          <table className={ui.table}>
            <thead>
              <tr>
                <th>이름</th>
                <th>사번</th>
                <th>연락처</th>
                <th>역할</th>
                <th>열람 범위</th>
                <th>상태</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <TableState
                isLoading={staffQuery.isLoading}
                error={staffQuery.error}
                isEmpty={items.length === 0}
                emptyText="직원이 없습니다. db/006_bootstrap.sql 의 staff_bootstrap_superuser() 로 첫 관리자를 만들 수 있습니다."
                colSpan={7}
              />
              {items.map((row) => {
                const self = row.id === profile?.staffId
                return (
                  <tr key={row.id}>
                    <td>
                      {row.name || '(이름 없음)'}
                      {self ? <span className={ui.badge}>나</span> : null}
                      {row.position ? (
                        <div className={ui.cellMuted}>{row.position}</div>
                      ) : null}
                    </td>
                    <td className={ui.cellMono}>{row.mgrId}</td>
                    <td className={ui.cellMuted}>
                      {row.email || '-'}
                      {row.phone ? <div>{row.phone}</div> : null}
                      {/*
                       * LPX 신원이 안 붙은 행은 ETL 로 들어왔고 아직 아무도 그 계정으로 로그인한
                       * 적이 없다는 뜻이다. 그래서 역할은 있는데 연락처가 비어 있을 수 있고, 그게
                       * 오류가 아니라는 걸 적어 두지 않으면 "메일이 왜 비었지" 를 고치려 든다.
                       * `lpx_sub` 자체는 서버가 내려주지 않는다 — 남의 계정 식별 토큰이다.
                       */}
                      {!row.linked ? (
                        <div className={ui.cellMuted}>미연동(이전 시스템 자료)</div>
                      ) : null}
                    </td>
                    <td>
                      {isPending(row) ? (
                        <span className={`${ui.badge} ${ui.badgeWarn}`}>승인 대기</span>
                      ) : (
                        row.roleName || row.roleCode || '-'
                      )}
                    </td>
                    <td className={ui.cellMuted}>
                      {/*
                       * 'Y' 만 전체다. 서버의 `VIEW_SCOPE_ALL` 은 'Y'·'ALL'·'A' 를 전체로 보지만
                       * 이 화면이 쓰는 값은 'Y'/'N' 두 개뿐이고, 나머지 모든 값(NULL·빈 문자열
                       * 포함)은 본인 담당분만으로 **안전한 쪽으로** 해석된다.
                       */}
                      {row.viewScope === 'Y' ? '회사 전체' : '본인 담당분'}
                    </td>
                    {/*
                     * '사용 중지' 가 더 이상 빨강이 아니다.
                     *
                     * 이전에는 `badgeDanger` 였다. 중지는 관리자가 **의도해서** 만든 상태이고,
                     * 빨강은 "고쳐야 할 것" 을 뜻한다 — 퇴사자가 쌓인 목록이 전부 빨강이면 정작
                     * 봐야 하는 '승인 대기' 가 그 빨강 사이에 묻힌다. 이 화면에서 눈이 가야 하는
                     * 곳은 위의 경고 배너와 대기 행 하나다. (StatusChip.tsx 의 `ActiveChip` 주석)
                     */}
                    <td>
                      <ActiveChip active={row.active} on="사용 중" off="사용 중지" />
                    </td>
                    <td>
                      <div className={ui.rowActions}>
                        {mayUpdate ? (
                          <button
                            type="button"
                            className={`${ui.btn} ${
                              isPending(row) ? ui.btnPrimary : ui.btnGhost
                            } ${ui.btnSm}`}
                            onClick={() => setEditing(row)}
                          >
                            {/* 대기 중인 행에서는 '승인' 이라고 쓴다. 같은 모달이지만 관리자가
                                지금 하려는 일의 이름이 다르다. */}
                            {isPending(row) ? '승인' : '권한 변경'}
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
      </div>

      {editing ? (
        <StaffRoleModal
          staff={editing}
          isSelf={editing.id === profile?.staffId}
          onClose={() => setEditing(null)}
          onSaved={setNotice}
        />
      ) : null}
    </div>
  )
}
