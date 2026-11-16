import { useState } from 'react'
import { useSendHandoverMail } from '@/apis/queries/neotms.mutation'
import {
  HANDOVER_FORMATS,
  HANDOVER_LAYOUTS,
  type HandoverFormat,
  type HandoverLayout,
  type ProjectRow,
} from '@/apis/neotms.types'
import { ErrorNotice, InfoNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'

/**
 * 인계메일 발송 — 프로젝트 하나를 운영 PM 에게 메일로 넘긴다.
 *
 * 양식은 인계 기능_261111.docx 3쪽이고, 메일의 **본문은 서버가 짠다**(NeotmsHandoverMail.ts).
 * 이 대화상자가 받는 것은 그 양식에서 사람이 골라야 하는 다섯 가지뿐이다 — 편집포맷, 레이아웃,
 * 받는 주소, 하이웍스 ID·비밀번호.
 *
 * ## 본문을 화면에서 짜지 않는 이유
 *
 * 언어쌍과 납기를 접는 규칙이 꽤 길다(도착어 4개 이상이면 '다국어', 언어별 납기가 다르면 줄
 * 나누기, 오전/오후가 다르면 줄마다 괄호). 그걸 화면에도 한 벌 두면 **두 벌이 생기고**, 두 벌은
 * 언젠가 갈라진다. 더 실질적인 이유는 재료다 — 목록 화면의 `ProjectRow` 에는 작업이 없으므로,
 * 여기서 짜려면 작업 목록을 한 번 더 읽어야 한다.
 *
 * ## 보내기 전에 본문을 보여 주지 않는다
 *
 * 원래 요구사항은 "클립보드에 복사" 였고, 거기서는 붙여넣은 뒤 눈으로 확인하는 단계가 자연히
 * 있었다. 직접 발송으로 바꾸면 그 단계가 사라진다. 미리보기를 붙이는 대신 두 가지로 대신했다:
 * 보낸 뒤 **제목을 그대로 돌려받아** 알림에 적고, 발송은 하이웍스의 보낸메일함에 저장된다
 * (`is_save: true`). 즉 확인할 곳이 없어지는 것이 아니라, 확인 시점이 발송 뒤로 옮겨간다.
 *
 * ## 비밀번호는 상태에만 있다
 *
 * `localStorage` 에 넣지 않고, 서식을 닫으면 사라지며, 성공 알림에도 적지 않는다. 서버도 같다 —
 * 로그인에 한 번 쓰고 버린다(NeotmsHandoverManager 머리말). 자동완성을 끄지는 않았다: 브라우저의
 * 비밀번호 관리자는 사용자 자신의 것이고, 그걸 막으면 사람들이 더 짧은 비밀번호를 쓴다.
 */

interface Props {
  project: ProjectRow
  onClose: () => void
  onSent: (message: string) => void
}

/** 체크된 항목을 토글한다. 배열을 쓰는 이유는 서버 본문이 배열이기 때문이다. */
function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

export function HandoverMailModal({ project, onClose, onSent }: Props) {
  const sendMail = useSendHandoverMail()

  /*
   * 편집포맷은 WORD 하나를 미리 골라 둔다. 레이아웃은 비워 둔다.
   *
   * 둘을 다르게 둔 것은 의도다. 압도적 다수가 WORD 로 나가므로 그 기본값은 "맞는 쪽으로 기운"
   * 기본값이지만, 레이아웃 셋은 어느 하나가 더 흔하다고 말할 근거가 없다 — 근거 없는 기본값은
   * 아무도 안 고치고 그대로 나가서, 받는 PM 이 "보기좋게로 합의된 것" 으로 읽는다.
   */
  const [formats, setFormats] = useState<HandoverFormat[]>(['WORD'])
  const [layouts, setLayouts] = useState<HandoverLayout[]>([])
  const [recipient, setRecipient] = useState('')
  const [hiworksId, setHiworksId] = useState('')
  const [hiworksPassword, setHiworksPassword] = useState('')

  /*
   * 주소는 모양만 본다. 실제로 존재하는 주소인지는 메일 서버만 알고, 틀렸으면 반송 메일이
   * 보낸 사람에게 돌아간다 — 서버 스키마도 같은 판단이다.
   */
  const recipientLooksWrong = recipient.trim().length > 0 && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(recipient.trim())

  const complete =
    formats.length > 0 &&
    layouts.length > 0 &&
    recipient.trim().length > 0 &&
    !recipientLooksWrong &&
    hiworksId.trim().length > 0 &&
    hiworksPassword.length > 0

  const canSend = complete && !sendMail.isPending

  const onSubmit = async () => {
    if (!canSend) return
    const sent = await sendMail.mutateAsync({
      id: project.id,
      input: {
        formats,
        layouts,
        recipient: recipient.trim(),
        hiworksId: hiworksId.trim(),
        hiworksPassword,
      },
    })
    onSent(`${sent.recipient} 로 인계메일을 보냈습니다 — 제목 "${sent.subject}"`)
    onClose()
  }

  return (
    <Modal
      title="인계메일 발송"
      onClose={onClose}
      /*
       * 비밀번호가 들어 있으면 실수로 닫히지 않게 한 번 묻는다. 고를 것만 골라 둔 상태는 묻지
       * 않는다 — 다시 두 번 누르면 되는 것에 확인 대화상자를 띄우면 사람들은 그 확인을 읽지 않고
       * 누르는 습관을 들인다.
       */
      isDirty={hiworksPassword.length > 0}
      width={560}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose} disabled={sendMail.isPending}>
            취소
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void onSubmit()}
            disabled={!canSend}
          >
            {sendMail.isPending ? '보내는 중…' : '발송'}
          </button>
        </>
      }
    >
      <ErrorNotice error={sendMail.error} />

      <p className={ui.hint}>
        <strong>{project.prjCode}</strong> {project.prjName || '(이름 없음)'} — 거래처·담당영업·
        담당PM·언어·납품요청일과 프로젝트 <strong>내용</strong>이 기타요청 칸에 담겨 나갑니다.
        거래처 담당자와 경로 칸은 비워 둔 채로 보냅니다.
      </p>

      <div className={ui.field}>
        <label className={ui.label}>
          편집포맷 <span className={ui.required}>*</span>
        </label>
        {/* 다수 선택이다 — 문서의 "클릭으로 색/색없음 토글(다수 가능)". 고른 것만 메일에서 칠해진다. */}
        <div className={ui.checkGrid}>
          {HANDOVER_FORMATS.map((option) => (
            <label key={option} className={ui.check}>
              <input
                type="checkbox"
                checked={formats.includes(option)}
                onChange={() => setFormats((prev) => toggle(prev, option))}
                disabled={sendMail.isPending}
              />
              <span className={ui.checkText}>
                <span className={ui.checkLabel}>{option}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className={ui.field}>
        <label className={ui.label}>
          레이아웃 <span className={ui.required}>*</span>
        </label>
        <div className={ui.checkGrid}>
          {HANDOVER_LAYOUTS.map((option) => (
            <label key={option} className={ui.check}>
              <input
                type="checkbox"
                checked={layouts.includes(option)}
                onChange={() => setLayouts((prev) => toggle(prev, option))}
                disabled={sendMail.isPending}
              />
              <span className={ui.checkText}>
                <span className={ui.checkLabel}>{option}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className={ui.field}>
        <label className={ui.label} htmlFor="hm-to">
          PM 이메일 <span className={ui.required}>*</span>
        </label>
        <input
          id="hm-to"
          className={ui.input}
          type="email"
          placeholder="pm@lionkorea.com"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          disabled={sendMail.isPending}
        />
        {recipientLooksWrong ? (
          <p className={`${ui.hint} ${ui.hintWarn}`}>이메일 주소 모양이 아닙니다.</p>
        ) : null}
      </div>

      {/*
       * 하이웍스 자격증명. 두 칸을 다른 칸들과 한 묶음으로 두지 않고 안내문과 함께 아래로 내렸다 —
       * 비밀번호를 묻는 칸은 "왜 묻는지" 가 바로 옆에 있어야 하고, 그 설명이 없으면 사용자는
       * 이 시스템이 하이웍스 계정을 보관하려 한다고 읽는다.
       */}
      <InfoNotice>
        메일은 <strong>본인의 하이웍스 계정</strong>에서 발송되며, 보낸메일함에도 저장됩니다.
        입력한 ID 와 비밀번호는 발송에 한 번 쓰이고 저장되지 않습니다.
      </InfoNotice>

      <div className={ui.datePair}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="hm-id">
            하이웍스 ID <span className={ui.required}>*</span>
          </label>
          <input
            id="hm-id"
            className={ui.input}
            autoComplete="username"
            value={hiworksId}
            onChange={(e) => setHiworksId(e.target.value)}
            disabled={sendMail.isPending}
          />
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="hm-pw">
            하이웍스 비밀번호 <span className={ui.required}>*</span>
          </label>
          <input
            id="hm-pw"
            className={ui.input}
            type="password"
            autoComplete="current-password"
            value={hiworksPassword}
            onChange={(e) => setHiworksPassword(e.target.value)}
            disabled={sendMail.isPending}
          />
        </div>
      </div>
    </Modal>
  )
}
