import { useState } from 'react'
import { useSendHandoverMail } from '@/apis/queries/neotms.mutation'
import { useHiworksCredential } from '@/apis/queries/neotms.query'
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
  /*
   * 기타요청. Deliberately NOT part of `complete` - the official form has this row whether or
   * not anything was asked for, and most handovers have nothing to add. Requiring it would
   * teach people to type a full stop to get past the button.
   */
  const [note, setNote] = useState('')
  const [hiworksId, setHiworksId] = useState('')
  const [hiworksPassword, setHiworksPassword] = useState('')

  /*
   * 저장된 하이웍스 계정이 있는지. 없으면(혹은 아직 읽는 중이면) 전처럼 두 칸을 묻는다 —
   * 기다리는 동안 칸을 감추면, 느린 연결에서 칸이 뒤늦게 나타난다.
   *
   * `manual` 은 "이번만 다른 계정으로" 다. 대화상자를 닫으면 사라지는 상태인 것이 맞다:
   * 한 번의 예외가 다음 발송까지 따라가면 그게 더 놀라운 동작이다.
   */
  const credential = useHiworksCredential()
  /*
   * `registered && vaultConfigured`, not `registered` alone.
   *
   * 비생산 배포들은 한 데이터베이스를 공유한다. 그래서 **내 배포가 열 수 없는 행**이 보일 수
   * 있다 — 다른 배포가 자기 키로 봉인한 행이다. 상태 조회는 KMS 를 전혀 쓰지 않는데(가린
   * 아이디만 읽는다) 그 장점이 여기서는 함정이 된다: `registered` 만 보고 칸을 감추면, 화면은
   * "저장된 계정으로 보냅니다" 라고 약속한 뒤 보내기가 400 으로 거절된다.
   *
   * 이 배포에 키가 없으면 칸을 보여 주는 쪽이 항상 맞다. 서버도 같은 사실을 알고 있고
   * (`vaultConfigured`), 그 값을 함께 보는 것이 약속을 지킬 수 있는지 미리 아는 방법이다.
   */
  const hasStoredCredential =
    (credential.data?.registered ?? false) && (credential.data?.vaultConfigured ?? false)
  const [manual, setManual] = useState(false)
  const useStored = hasStoredCredential && !manual

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
    // 저장된 계정으로 보낼 때는 두 칸이 비어 있는 것이 정상이다.
    (useStored || (hiworksId.trim().length > 0 && hiworksPassword.length > 0))

  const canSend = complete && !sendMail.isPending

  const onSubmit = async () => {
    if (!canSend) return
    const sent = await sendMail.mutateAsync({
      id: project.id,
      input: {
        formats,
        layouts,
        recipient: recipient.trim(),
        note: note.trim(),
        /*
         * 저장된 계정으로 보낼 때는 **보내지 않는다** — 빈 문자열이 아니라 아예 없는 필드다.
         * 서버의 규칙이 "입력한 값이 있으면 그것을 쓴다" 이므로 둘은 같은 뜻이지만, 쓰지 않는
         * 값을 요청 본문에 넣지 않는 쪽이 정직하고, 네트워크 로그에도 남지 않는다.
         */
        hiworksId: useStored ? undefined : hiworksId.trim(),
        hiworksPassword: useStored ? undefined : hiworksPassword,
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
      isDirty={hiworksPassword.length > 0 || note.trim().length > 0}
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
        <strong>{project.prjCode}</strong> {project.prjName || '(이름 없음)'} — 회사 인계 양식으로
        거래처·영업담당·PM·프로젝트코드·언어·납품요청일이 나가고, <strong>경로</strong> 칸에는
        프로젝트 <strong>비고</strong>가 들어갑니다. 거래처 담당자 칸은 비워 둔 채로 보냅니다.
      </p>

      <div className={ui.field}>
        <label className={`${ui.label} ${ui.required}`}>
          편집포맷
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
        <label className={`${ui.label} ${ui.required}`}>
          레이아웃
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
        <label className={`${ui.label} ${ui.required}`} htmlFor="hm-to">
          PM 이메일
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

      <div className={ui.field}>
        <label className={ui.label} htmlFor="hm-note">
          기타요청
        </label>
        {/*
         * No `ui.required`: the form's remarks row is rendered blank when nothing is typed. The
         * placeholder says so, because an empty box with no hint reads as a field somebody
         * forgot to fill in.
         */}
        <textarea
          id="hm-note"
          className={ui.textarea}
          rows={3}
          placeholder="PM에게 따로 전할 내용이 있으면 적어 주세요. 비워 두면 메일의 기타요청 칸이 빈 칸으로 나갑니다."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={sendMail.isPending}
        />
      </div>

      {/*
       * The Hiworks credentials. They are kept apart from the other fields and sit under their own
       * note on purpose: a field asking for a password needs the reason beside it, and without one
       * people read it as this system wanting to keep their Hiworks account.
       *
       * 저장된 계정이 있으면 두 칸을 **감춘다**. 감추는 것이 비워 두는 것보다 나은 이유는
       * "비어 있으면 저장된 계정으로 보낸다" 라는 규칙이 화면에 보이지 않기 때문이다 — 빈 칸
       * 두 개를 보면 사람은 채워야 한다고 읽는다.
       *
       * 그래도 '직접 입력' 을 남겨 둔다. 다른 계정으로 한 번 보내야 하는 일은 실제로 있고(팀
       * 공용 계정, 휴가 중인 동료 대행), 그걸 하려고 저장된 계정을 지웠다 다시 넣게 만들 수는
       * 없다. 서버도 같은 우선순위를 쓴다 — 입력한 값이 저장된 값을 이긴다.
       */}
      <InfoNotice>
        메일은 <strong>본인의 하이웍스 계정</strong>에서 발송되며, 보낸메일함에도 저장됩니다.
        {useStored
          ? ' 내 정보에 저장한 계정으로 보냅니다.'
          : ' 입력한 ID 와 비밀번호는 이 발송에 한 번만 쓰이고 저장되지 않습니다.'}
      </InfoNotice>

      {useStored ? (
        <div className={ui.filterNote}>
          저장된 계정: <strong>{credential.data?.hiworksIdHint ?? '-'}</strong>
          <button
            type="button"
            className={ui.btnLink}
            onClick={() => setManual(true)}
            disabled={sendMail.isPending}
          >
            직접 입력
          </button>
        </div>
      ) : (
        <>
          <div className={ui.datePair}>
            <div className={ui.field}>
              <label className={`${ui.label} ${ui.required}`} htmlFor="hm-id">
                하이웍스 ID
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
              <label className={`${ui.label} ${ui.required}`} htmlFor="hm-pw">
                하이웍스 비밀번호
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
          {hasStoredCredential ? (
            <div className={ui.filterNote}>
              <button
                type="button"
                className={ui.btnLink}
                onClick={() => {
                  setManual(false)
                  setHiworksId('')
                  setHiworksPassword('')
                }}
                disabled={sendMail.isPending}
              >
                저장된 계정 사용
              </button>
            </div>
          ) : null}
        </>
      )}
    </Modal>
  )
}
