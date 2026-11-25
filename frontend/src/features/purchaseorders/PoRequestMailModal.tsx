import { useRef, useState } from 'react'
import { useSendPoRequestMail, useUploadAttachment } from '@/apis/queries/neotms.mutation'
import { useHiworksCredential } from '@/apis/queries/neotms.query'
import {
  PO_FORMAT_LABELS,
  PO_ORIGINAL_FORMATS,
  PO_WORKSPACE_FORMATS,
  type PoOriginalFormat,
  type PoWorkspaceFormat,
  type PurchaseOrderRow,
} from '@/apis/neotms.types'
import { ErrorNotice, InfoNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'

/**
 * Send a translator the mail that commissions their job.
 *
 * ## The server composes the body
 *
 * This screen collects only what a PERSON has to decide - the two document-format rows, the
 * request note, the recipient, the files, and the Hiworks credentials. Languages, volume and the
 * delivery schedule are already on the PO, so the server reads them from there. Asking for them
 * again would put one fact in two places, and the copy that reached the translator would be the one
 * somebody typed in a hurry.
 *
 * ## Attachments go straight to S3
 *
 * Picking a file registers and uploads it on the spot (`useUploadAttachment`). What goes to the
 * server when the mail is sent is a LIST OF TOKENS; the links are built there. This screen never
 * touches an S3 key or a URL.
 *
 * The Hiworks mail API has no attachment parameter, so files travel as links. A link points at this
 * system rather than at S3, and resolves to a short-lived presigned URL at the moment the
 * translator clicks it - because an S3 signature cannot live for 21 days (seven at most, and only
 * hours when it is signed with the function's own credentials).
 *
 * ## The password lives in state and nowhere else
 *
 * Never written to `localStorage`, gone when the dialog closes, and absent from the success notice.
 * The server does the same: it signs in once and discards it. Autocomplete is deliberately NOT
 * blocked - a password manager belongs to the user, and blocking it is how people end up choosing
 * shorter passwords.
 */

interface Props {
  po: PurchaseOrderRow
  onClose: () => void
  onSent: (message: string) => void
}

/** Flip one checkbox. Held as an array because the request body is one. */
function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

/** An uploaded file. All this screen holds is the token and the name. */
interface Attached {
  token: string
  fileName: string
}

export function PoRequestMailModal({ po, onClose, onSent }: Props) {
  const upload = useUploadAttachment()
  const sendMail = useSendPoRequestMail()

  /*
   * PDF is the default original; nothing is ticked for the workspace file.
   *
   * The same judgement the handover-mail dialog makes by defaulting to WORD: lean towards the
   * overwhelmingly common answer, but do not invent a default with nothing behind it. Jobs with no
   * workspace file are common, so leaving it empty is closer to the truth.
   */
  const [originalFormats, setOriginalFormats] = useState<PoOriginalFormat[]>(['PDF'])
  const [workspaceFormats, setWorkspaceFormats] = useState<PoWorkspaceFormat[]>([])
  const [note, setNote] = useState('')
  const [recipient, setRecipient] = useState(po.poTranEmail ?? '')
  const [attached, setAttached] = useState<Attached[]>([])
  const [hiworksId, setHiworksId] = useState('')
  const [hiworksPassword, setHiworksPassword] = useState('')

  /*
   * 저장된 하이웍스 계정이 있으면 두 칸을 감춘다 — 인계메일 대화상자와 같은 규칙이고, 같은
   * 이유다(HandoverMailModal 의 주석). 아직 읽는 중이면 전처럼 묻는다.
   */
  const credential = useHiworksCredential()
  /*
   * `registered && vaultConfigured`, not `registered` alone.
   *
   * 비생산 배포들이 한 데이터베이스를 공유하므로, 내 배포가 열 수 없는 행이 보일 수 있다 —
   * 자세한 이유는 HandoverMailModal 의 같은 자리에 적어 두었다. 요약하면, `registered` 만 보고
   * 칸을 감추면 지킬 수 없는 약속을 하게 된다.
   */
  const hasStoredCredential =
    (credential.data?.registered ?? false) && (credential.data?.vaultConfigured ?? false)
  const [manual, setManual] = useState(false)
  const useStored = hasStoredCredential && !manual
  const [uploadError, setUploadError] = useState<string | null>(null)

  /*
   * The real file input is hidden, and a visible button clicks it on the user's behalf.
   *
   * `<input type="file">` is drawn by the browser and barely styleable - its button sits INSIDE the
   * field, in a font and colour that match nothing else in this dialog. So the field is hidden and
   * the thing people see is an ordinary button, the same one as every other confirm action here.
   */
  const fileInput = useRef<HTMLInputElement>(null)

  const pending = sendMail.isPending || upload.isPending

  /*
   * The selection, summarised in one line.
   *
   * The badges below already list every file and let one be taken back out, so there is no reason
   * for this field to repeat the same list. It says what the hidden file input would have said -
   * one file's name, or the first name and how many others.
   */
  const pickedLabel =
    attached.length === 0
      ? ''
      : attached.length === 1
        ? attached[0].fileName
        : `${attached[0].fileName} 외 ${String(attached.length - 1)}건`

  const onPickFiles = async (files: File[]) => {
    if (files.length === 0) return
    setUploadError(null)
    /*
     * One at a time. Five 100MB files sharing one connection make all five slow, and when one of
     * them fails it becomes hard for the screen to say WHICH one.
     */
    for (const file of files) {
      try {
        const done = await upload.mutateAsync({
          input: {
            poId: po.id,
            fileName: file.name,
            contentType: file.type || 'application/octet-stream',
            sizeBytes: file.size,
          },
          file,
        })
        setAttached((prev) => [...prev, { token: done.token, fileName: done.fileName }])
      } catch (err) {
        setUploadError(
          err instanceof Error ? err.message : `${file.name} 을(를) 올리지 못했습니다.`,
        )
        break
      }
    }
  }

  const canSend =
    !pending &&
    originalFormats.length > 0 &&
    recipient.trim().length > 0 &&
    // 저장된 계정으로 보낼 때는 두 칸이 비어 있는 것이 정상이다.
    (useStored || (hiworksId.trim().length > 0 && hiworksPassword.length > 0))

  const onSubmit = async () => {
    if (!canSend) return
    const sent = await sendMail.mutateAsync({
      poId: po.id,
      input: {
        originalFormats,
        workspaceFormats,
        note: note.trim(),
        attachments: attached.map((a) => a.token),
        recipient: recipient.trim(),
        // 쓰지 않는 값은 본문에 넣지 않는다 — HandoverMailModal 의 같은 자리 참고.
        hiworksId: useStored ? undefined : hiworksId.trim(),
        hiworksPassword: useStored ? undefined : hiworksPassword,
      },
    })
    onSent(
      `${sent.recipient} 로 의뢰 메일을 보냈습니다. 제목: ${sent.subject}` +
        (sent.attachments > 0 ? ` (첨부 ${String(sent.attachments)}건)` : ''),
    )
    onClose()
  }

  return (
    <Modal
      title={`의뢰 메일 — ${po.poCode}`}
      onClose={onClose}
      isDirty={!pending && (attached.length > 0 || note.trim().length > 0)}
      width={620}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose} disabled={pending}>
            취소
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void onSubmit()}
            disabled={!canSend}
          >
            {sendMail.isPending ? '보내는 중…' : '보내기'}
          </button>
        </>
      }
    >
      <ErrorNotice error={sendMail.error} />
      {uploadError ? <ErrorNotice error={new Error(uploadError)} /> : null}

      <InfoNotice>
        언어·분량·납품일정은 이 PO 에 저장된 값으로 서버가 채웁니다. 메일은
        <strong>본인의 Hiworks 계정</strong>에서 발송되며, 보낸편지함에도 저장됩니다.
        {useStored ? ' 내 정보에 저장한 계정으로 보냅니다.' : ''}
      </InfoNotice>

      <div className={ui.formGrid}>
        <div className={ui.fieldWide}>
          <span className={`${ui.label} ${ui.required}`}>원본 문서 형태</span>
          <div className={ui.checkGrid}>
            {PO_ORIGINAL_FORMATS.map((format) => (
              <label className={ui.check} key={format}>
                <input
                  type="checkbox"
                  checked={originalFormats.includes(format)}
                  onChange={() => setOriginalFormats((prev) => toggle(prev, format))}
                  disabled={pending}
                />
                <span className={ui.checkText}>
                  <span className={ui.checkLabel}>{PO_FORMAT_LABELS[format] ?? format}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className={ui.fieldWide}>
          <span className={ui.label}>작업파일 형태</span>
          <div className={ui.checkGrid}>
            {PO_WORKSPACE_FORMATS.map((format) => (
              <label className={ui.check} key={format}>
                <input
                  type="checkbox"
                  checked={workspaceFormats.includes(format)}
                  onChange={() => setWorkspaceFormats((prev) => toggle(prev, format))}
                  disabled={pending}
                />
                <span className={ui.checkText}>
                  <span className={ui.checkLabel}>{PO_FORMAT_LABELS[format] ?? format}</span>
                </span>
              </label>
            ))}
          </div>
          <span className={ui.hint}>
            작업파일이 없는 건이면 비워 두십시오. 메일에는 '-' 로 나갑니다.
          </span>
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="po-mail-files">
            첨부파일
          </label>
          <div className={ui.inputRow}>
            <input
              id="po-mail-files"
              className={ui.input}
              value={pickedLabel}
              placeholder="선택된 파일 없음"
              /*
               * `readonly`, not `disabled`. A disabled input leaves the tab order and some screen
               * readers skip it entirely - and what this field holds is the NAME OF THE FILE about
               * to be mailed out, which is the thing to check before pressing send. Typing is the
               * only thing worth preventing.
               */
              readOnly
            />
            <button
              type="button"
              className={`${ui.btn} ${ui.btnPrimary}`}
              onClick={() => fileInput.current?.click()}
              disabled={pending}
            >
              파일 선택
            </button>
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              /*
               * Copy the list into an array FIRST. `input.files` is live, so it becomes empty the
               * moment the value is cleared below.
               */
              const picked = Array.from(e.target.files ?? [])
              /*
               * Then clear the field. Without this the same file cannot be picked twice: an
               * unchanged value raises no `change` event, so taking a file back out and choosing it
               * again does nothing at all and the button looks broken.
               */
              e.target.value = ''
              void onPickFiles(picked)
            }}
            disabled={pending}
          />
          <span className={ui.hint}>
            고르는 즉시 올라갑니다. 한 개당 100MB, 최대 10개까지. 메일에는 파일 이름이 적힌
            링크로 나가며, <b>링크는 21일간 유효합니다.</b>
          </span>
          {attached.length > 0 ? (
            <ul className={ui.badgeList}>
              {attached.map((file) => (
                <li key={file.token}>
                  <span className={ui.badge}>{file.fileName}</span>
                  <button
                    type="button"
                    className={ui.btnLink}
                    onClick={() =>
                      setAttached((prev) => prev.filter((f) => f.token !== file.token))
                    }
                    disabled={pending}
                  >
                    빼기
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {upload.isPending ? <span className={ui.hint}>올리는 중…</span> : null}
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="po-mail-note">
            요청사항
          </label>
          <textarea
            id="po-mail-note"
            className={ui.input}
            rows={4}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={pending}
          />
          <span className={ui.hint}>
            비워 두셔도 됩니다. 양식에 늘 들어가는 세 가지 요청(원본 참고, 태그 유지, 오탈자
            확인)은 서버가 항상 넣습니다.
          </span>
        </div>

        <div className={ui.fieldWide}>
          <label className={`${ui.label} ${ui.required}`} htmlFor="po-mail-to">
            받는 사람
          </label>
          <input
            id="po-mail-to"
            className={ui.input}
            type="email"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            disabled={pending}
          />
          <span className={ui.hint}>
            {po.poTranEmail
              ? '이 PO 의 번역가 주소입니다. 다른 주소로 보내려면 고쳐 주십시오.'
              : '이 PO 에는 번역가 주소가 없습니다. 보낼 주소를 입력해 주십시오.'}
          </span>
        </div>

        {useStored ? (
          <div className={ui.fieldWide}>
            <span className={ui.label}>보내는 계정</span>
            <div className={ui.filterNote}>
              저장된 계정: <strong>{credential.data?.hiworksIdHint ?? '-'}</strong>
              <button
                type="button"
                className={ui.btnLink}
                onClick={() => setManual(true)}
                disabled={pending}
              >
                직접 입력
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className={ui.field}>
              <label className={`${ui.label} ${ui.required}`} htmlFor="po-mail-id">
                하이웍스 ID
              </label>
              <input
                id="po-mail-id"
                className={ui.input}
                value={hiworksId}
                onChange={(e) => setHiworksId(e.target.value)}
                autoComplete="username"
                disabled={pending}
              />
            </div>

            <div className={ui.field}>
              <label className={`${ui.label} ${ui.required}`} htmlFor="po-mail-pw">
                하이웍스 비밀번호
              </label>
              <input
                id="po-mail-pw"
                className={ui.input}
                type="password"
                value={hiworksPassword}
                onChange={(e) => setHiworksPassword(e.target.value)}
                autoComplete="current-password"
                disabled={pending}
              />
            </div>

            {hasStoredCredential ? (
              <div className={ui.fieldWide}>
                <div className={ui.filterNote}>
                  <button
                    type="button"
                    className={ui.btnLink}
                    onClick={() => {
                      setManual(false)
                      setHiworksId('')
                      setHiworksPassword('')
                    }}
                    disabled={pending}
                  >
                    저장된 계정 사용
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  )
}
