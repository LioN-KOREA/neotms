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
 * Hands one project over to its operating PM by mail.
 *
 * The form is page 3 of the handover spec, and THE SERVER COMPOSES THE BODY
 * (NeotmsHandoverMail.ts). What this dialog collects is only the five things a person has to
 * decide: editing format, layout, the recipient address, and the Hiworks id and password.
 *
 * ## Why the body is not composed here
 *
 * The rules for folding the language pairs and the deadlines are long (four or more targets become
 * one word, differing deadlines split by language, differing halves add a bracket per line). A
 * second copy on the screen would eventually drift from the first. The more practical reason is
 * the ingredients: a `ProjectRow` on the list screen carries no jobs, so composing here would mean
 * fetching the job list all over again.
 *
 * ## There is no preview before sending
 *
 * The original requirement was "copy to the clipboard", which naturally included a look at the text
 * after pasting it. Sending directly removes that step. Rather than build a preview, two things
 * stand in for it: the subject comes BACK from the server and goes into the success notice, and
 * the send is saved to the sender's Hiworks sent-items folder (`is_save: true`). The place to check
 * does not disappear - it moves to after the send.
 *
 * ## The password lives only in state
 *
 * Never written to `localStorage`, gone when the dialog closes, and absent from the success notice.
 * The server does the same - one sign-in, then discarded (see the header of
 * NeotmsHandoverManager). Autocomplete is deliberately left on: the browser's password manager
 * belongs to the user, and blocking it is how people end up choosing shorter passwords.
 */

interface Props {
  project: ProjectRow
  onClose: () => void
  onSent: (message: string) => void
}

/** Toggles one checked option. Arrays, because the request body is arrays. */
function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

export function HandoverMailModal({ project, onClose, onSent }: Props) {
  const sendMail = useSendHandoverMail()

  /*
   * WORD is pre-selected; no layout is.
   *
   * The asymmetry is deliberate. The overwhelming majority go out as WORD, so that default leans
   * the way the truth usually lies. There is no such evidence for any one of the three layouts, and
   * a default with nothing behind it is one nobody corrects - it goes out as it stands and the
   * receiving PM reads it as an agreement.
   */
  const [formats, setFormats] = useState<HandoverFormat[]>(['WORD'])
  const [layouts, setLayouts] = useState<HandoverLayout[]>([])
  const [recipient, setRecipient] = useState('')
  const [hiworksId, setHiworksId] = useState('')
  const [hiworksPassword, setHiworksPassword] = useState('')

  /*
   * The address is checked for shape only. Whether it exists is a question only a mail server can
   * answer, and if it is wrong the bounce goes back to the sender. The server schema takes the same
   * view.
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
       * Ask once before discarding a typed password. Options that are merely selected do not ask -
       * putting a confirm dialog in front of something that costs two clicks to redo is how people
       * learn to dismiss confirm dialogs without reading them.
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
        {/* Multiple choice - the document's "click to toggle colour, several allowed". Only the
            chosen ones are coloured in the mail. */}
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
       * The Hiworks credentials. They are kept apart from the other fields and sit under their own
       * note on purpose: a field asking for a password needs the reason beside it, and without one
       * people read it as this system wanting to keep their Hiworks account.
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
