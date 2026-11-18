import { useMemo, useState } from 'react'
import { useSetStaffAttributes } from '@/apis/queries/neotms.mutation'
import type { StaffRow } from '@/apis/neotms.types'
import { NEOTMS_USER_ATTRIBUTE_SUPERUSER } from '@/apis/neotms.authorities'
import { ATTRIBUTE_LABELS } from '@/shared/permissionLabels'
import { ErrorNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'

interface Props {
  staff: StaffRow
  /** 자기 자신을 편집하는 중인지. 서버도 막지만, 체크박스를 먼저 막는다. */
  isSelf: boolean
  onClose: () => void
  onSaved: (message: string) => void
}

/**
 * 사용자 속성 — 이 사람이 **무엇으로 지명될 수 있는지**.
 *
 * ## 역할과 다른 질문이다
 *
 * 역할은 "무엇을 할 수 있는가" 이고, 속성은 "무엇으로 불릴 수 있는가" 다. 담당PM 속성은 그 사람이
 * 아무 화면도 더 열지 못하게 한다 — 대신 **다른 사람이** 프로젝트의 담당PM 칸에 그 사람 이름을
 * 넣을 수 있게 한다. 그래서 PM 역할을 가졌지만 담당PM 속성이 없는 사람이 있을 수 있고, 그건
 * 설정 오류가 아니라 "PM 업무는 하지만 프로젝트 담당자로 기록되지는 않는 사람" 이다.
 *
 * 모달이 역할 배정과 따로인 이유도 그것이다. 두 쓰기는 서버에서 **다른 권한**으로 막혀 있다 —
 * 역할 배정은 '역할 배정' 권한, 속성은 시스템관리자 속성이다. 한 모달에 넣으면 역할만 바꿀 수
 * 있는 관리자에게 403 이 날 체크박스가 보인다.
 *
 * ## 자기 자신의 시스템관리자 속성은 뗄 수 없다
 *
 * 서버가 409 로 거절하고, 여기서는 체크박스를 아예 잠근다. 역할 설정이 잘못됐을 때도 작동하는
 * 우회로가 그 속성이므로, 그걸 스스로 내려놓는 것은 이 화면이 되돌려 줄 수 없는 유일한 변경이다.
 * 물러나는 방법은 다른 시스템관리자가 떼 주는 것이다.
 */
export function StaffAttributesModal({ staff, isSelf, onClose, onSaved }: Props) {
  const setAttributes = useSetStaffAttributes()
  const pending = setAttributes.isPending

  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(staff.attributes))
  const [dirty, setDirty] = useState(false)

  const held = useMemo(() => new Set(staff.attributes), [staff.attributes])

  const toggle = (name: string) => {
    setDirty(true)
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const changed = useMemo(() => {
    if (held.size !== picked.size) return true
    for (const name of picked) if (!held.has(name)) return true
    return false
  }, [held, picked])

  const label = staff.name || staff.mgrId

  const onSubmit = async () => {
    await setAttributes.mutateAsync({ id: staff.id, input: { attributes: [...picked].sort() } })
    onSaved(`'${label}' 님의 사용자 속성을 저장했습니다.`)
    onClose()
  }

  return (
    <Modal
      title={`사용자 속성 — ${label}`}
      onClose={onClose}
      isDirty={dirty && !pending}
      width={600}
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
            {pending ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      <ErrorNotice error={setAttributes.error} />

      <div className={`${ui.alert} ${ui.alertInfo}`}>
        속성은 <b>무엇을 할 수 있는지</b>가 아니라 <b>무엇으로 지명될 수 있는지</b>를 정합니다.
        화면이 더 열리지는 않습니다 — 그건 <b>역할</b>이 정하고, 역할은 '권한 변경' 에서 바꿉니다.
      </div>

      <div className={ui.checkGrid}>
        {ATTRIBUTE_LABELS.map((attribute) => {
          const isSuperuser = attribute.name === NEOTMS_USER_ATTRIBUTE_SUPERUSER
          // 자기 자신에게서 시스템관리자를 떼는 것만 잠근다. 켜는 것은 막지 않는다 — 이미
          // 가지고 있지 않다면 이 화면에 들어올 수 없었으므로, 실제로는 일어나지 않는 경우다.
          const locked = isSelf && isSuperuser && held.has(attribute.name)
          return (
            <label className={ui.check} key={attribute.name}>
              <input
                type="checkbox"
                checked={picked.has(attribute.name)}
                onChange={() => toggle(attribute.name)}
                disabled={pending || locked}
              />
              <span className={ui.checkText}>
                <span className={ui.checkLabel}>
                  {attribute.label}
                  {attribute.sensitive ? (
                    <span className={`${ui.badge} ${ui.badgeWarn}`}>주의</span>
                  ) : null}
                </span>
                <span className={ui.checkDesc}>
                  {attribute.hint}
                  {locked ? (
                    <>
                      {' '}
                      <b>
                        자기 자신의 시스템관리자 속성은 뗄 수 없습니다. 다른 시스템관리자에게
                        요청해 주십시오.
                      </b>
                    </>
                  ) : null}
                </span>
              </span>
            </label>
          )
        })}
      </div>
    </Modal>
  )
}
