import { useRef, useState } from 'react'
import { useSendPoRequestMail, useUploadAttachment } from '@/apis/queries/neotms.mutation'
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
 * 번역가에게 의뢰 메일을 보낸다.
 *
 * ## 본문은 서버가 만든다
 *
 * 화면이 모으는 것은 사람이 정해야 하는 것들뿐이다 — 문서 형태 두 줄, 요청사항, 받는 사람,
 * 첨부파일, 그리고 Hiworks 자격증명. 언어·분량·납품일정은 PO 에 이미 있으므로 서버가 꺼내
 * 채운다. 화면에서 다시 입력받으면 같은 사실이 두 곳에 있게 되고, 둘이 어긋났을 때 번역가에게
 * 가는 쪽은 사람이 급히 친 쪽이 된다.
 *
 * ## 첨부는 S3 로 바로 올라간다
 *
 * 파일을 고르면 그 순간 등록되고 업로드된다(`useUploadAttachment`). 메일을 보낼 때 서버로 가는
 * 것은 **토큰 목록**이고, 링크는 서버가 만든다. 화면은 S3 키도 URL 도 만지지 않는다.
 *
 * Hiworks 메일 API 에는 첨부 기능이 없어서 링크로 보낸다. 그 링크는 S3 가 아니라 이 시스템을
 * 가리키고, 번역가가 누르는 순간 짧은 수명의 presigned URL 로 바뀐다 — S3 서명은 21일을 살 수
 * 없기 때문이다(최대 7일이고, Lambda 자격증명으로 서명하면 몇 시간이다).
 *
 * ## 비밀번호는 상태에만 있다
 *
 * `localStorage` 에 쓰지 않고, 대화상자를 닫으면 사라지고, 성공 안내에도 넣지 않는다. 서버도
 * 같다 — 한 번 로그인하고 버린다. 자동완성은 일부러 막지 않는다: 비밀번호 관리자는 사용자의
 * 것이고, 막으면 사람들이 더 짧은 비밀번호를 쓰게 된다.
 */

interface Props {
  po: PurchaseOrderRow
  onClose: () => void
  onSent: (message: string) => void
}

/** 체크 하나를 뒤집는다. 요청 본문이 배열이라 배열로 들고 있는다. */
function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

/** 업로드가 끝난 파일. 화면이 들고 있는 것은 토큰과 이름뿐이다. */
interface Attached {
  token: string
  fileName: string
}

export function PoRequestMailModal({ po, onClose, onSent }: Props) {
  const upload = useUploadAttachment()
  const sendMail = useSendPoRequestMail()

  /*
   * 원본은 PDF 가 기본, 작업파일은 아무것도 선택하지 않는다.
   *
   * 인계메일 대화상자가 WORD 를 기본으로 두는 것과 같은 판단이다: 압도적으로 많은 쪽으로
   * 기울여 두되, 근거 없는 기본값은 두지 않는다. 작업파일이 없는 건이 흔하므로, 비워 두는 것이
   * 사실에 더 가깝다.
   */
  const [originalFormats, setOriginalFormats] = useState<PoOriginalFormat[]>(['PDF'])
  const [workspaceFormats, setWorkspaceFormats] = useState<PoWorkspaceFormat[]>([])
  const [note, setNote] = useState('')
  const [recipient, setRecipient] = useState(po.poTranEmail ?? '')
  const [attached, setAttached] = useState<Attached[]>([])
  const [hiworksId, setHiworksId] = useState('')
  const [hiworksPassword, setHiworksPassword] = useState('')
  const [uploadError, setUploadError] = useState<string | null>(null)

  /*
   * 진짜 파일 입력칸은 감춰 두고, 보이는 버튼이 이 칸을 대신 누른다.
   *
   * `<input type="file">` 은 브라우저가 그리는 모양을 거의 바꿀 수 없다 — 버튼이 칸 안에 들어
   * 있고, 글꼴도 색도 이 화면의 다른 버튼과 맞지 않는다. 그래서 칸은 감추고, 눈에 보이는 것은
   * 이 화면의 다른 확인 버튼과 같은 버튼으로 둔다.
   */
  const fileInput = useRef<HTMLInputElement>(null)

  const pending = sendMail.isPending || upload.isPending

  /*
   * 고른 파일을 한 줄로 요약한다.
   *
   * 전체 목록은 아래 뱃지가 보여 주고 거기서 하나씩 뺄 수 있으므로, 이 칸이 같은 목록을 다시
   * 적을 이유가 없다. 감춘 파일 입력칸이 보여 주던 것과 같은 수준 — 하나면 그 이름, 여럿이면
   * 첫 이름과 나머지 개수 — 만 둔다.
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
     * 한 번에 하나씩 올린다. 동시에 올리면 100MB 짜리 다섯 개가 같은 회선을 나눠 쓰면서 전부
     * 느려지고, 하나가 실패했을 때 어느 것이 실패했는지 화면이 말해 주기 어려워진다.
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
    hiworksId.trim().length > 0 &&
    hiworksPassword.length > 0

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
        hiworksId: hiworksId.trim(),
        hiworksPassword,
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
        언어·분량·납품일정은 이 PO 에 저장된 값으로 서버가 채웁니다. 메일은 아래에 입력하신
        Hiworks 계정에서 발송되며, 보낸편지함에도 저장됩니다.
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
               * `readonly` 이고 `disabled` 가 아니다. 비활성 입력칸은 탭 순서에서 빠지고 일부
               * 스크린리더가 읽지 않는데, 이 칸에 들어가는 것은 **보내려는 파일의 이름**이고
               * 보내기 직전에 확인해야 하는 값이다. 막아야 할 것은 타이핑뿐이다.
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
               * 파일 목록을 **먼저** 배열로 복사한다. `input.files` 는 살아 있는 목록이어서,
               * 아래에서 값을 비우는 순간 빈 목록이 된다.
               */
              const picked = Array.from(e.target.files ?? [])
              /*
               * 그리고 칸을 비운다. 비우지 않으면 같은 파일을 두 번 고를 수 없다 — 값이 바뀌지
               * 않으면 `change` 가 일어나지 않으므로, 하나 뺐다가 같은 파일을 다시 고르면
               * 아무 일도 생기지 않고 버튼이 고장난 것처럼 보인다.
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
      </div>
    </Modal>
  )
}
