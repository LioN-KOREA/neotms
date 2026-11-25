import { useState } from 'react'
import { useHiworksCredential, useProfile } from '@/apis/queries/neotms.query'
import {
  useForgetHiworksCredential,
  useSaveHiworksCredential,
} from '@/apis/queries/neotms.mutation'
import { ErrorNotice, InfoNotice, SuccessNotice } from '@/shared/ui/Feedback'
import { formatDateTime } from '@/shared/utils/format'
import ui from '@/shared/ui/ui.module.css'

/**
 * 내 정보 — 보는 사람 자신의 설정. 지금은 항목이 하나다(Hiworks 계정).
 *
 * ## 이 메뉴만 권한이 없다
 *
 * 다른 모든 메뉴는 회사 데이터를 보여 주므로 "누가 볼 수 있는가" 를 누군가 정해야 한다. 이
 * 화면은 **보는 사람 자신의 설정**을 보여 주므로 권한을 걸면 뜻이 뒤집힌다 — 자기 비밀번호에
 * 접근할 권리를 부여하는 모양이 되고, 새로 만든 역할은 이 화면에 들어갈 수 없는데 그 이유가
 * 어디에도 적히지 않는다. 그래서 레일의 항목은 `NEOTMS_NAV_ANY_STAFF` 로 걸려 있고, 서버의
 * 라우트는 `anyStaff` 다.
 *
 * ## Hiworks 계정을 저장하는 것이 왜 선택인가
 *
 * 저장하지 않으면 전처럼 메일을 보낼 때마다 아이디와 비밀번호를 묻는다. 그 동작이 사라진 것이
 * 아니라 **그대로 남아 있고**, 저장은 그 위에 얹은 편의다. 자기 비밀번호를 회사 시스템에 맡기지
 * 않겠다는 선택은 충분히 합당하므로, 아무것도 하지 않아도 모든 기능이 그대로 동작한다.
 *
 * ## 전체 아이디를 보여 주지 않는 이유
 *
 * 저장된 값은 아이디와 비밀번호 **둘 다** 암호화되어 있다. 전체 아이디를 보여 주려면 이 화면을
 * 열 때마다 복호화해야 하고, 그러면 설정 화면을 여는 것만으로 KMS 호출과 CloudTrail 기록이
 * 생긴다 — 어느 계정인지 알아보는 데는 가린 형태로 충분하다. 서버가 저장할 때 만들어 둔
 * `hiworksIdHint` 를 그대로 보여 준다.
 *
 * ## 비밀번호는 이 컴포넌트의 상태에만 있다
 *
 * `localStorage` 도, `sessionStorage` 도 쓰지 않는다. 저장 요청이 끝나면 입력칸을 비우고, 쿼리
 * 캐시에 남는 것은 가린 아이디와 날짜뿐이다(`HiworksCredentialView`).
 */
export function MyInfoView() {
  const { data: profile } = useProfile()
  const credential = useHiworksCredential()
  const save = useSaveHiworksCredential()
  const forget = useForgetHiworksCredential()

  const [hiworksId, setHiworksId] = useState('')
  const [hiworksPassword, setHiworksPassword] = useState('')
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const view = credential.data
  const registered = view?.registered ?? false
  const vaultConfigured = view?.vaultConfigured ?? false
  /* 저장된 계정이 없으면 폼이 처음부터 열려 있다 — 닫을 것이 없기 때문이다. */
  const formOpen = editing || (!registered && vaultConfigured)

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setNotice(null)
    save.mutate(
      { hiworksId, hiworksPassword },
      {
        onSuccess: () => {
          /*
           * 성공한 **뒤에** 비운다. 먼저 비우면 저장이 실패했을 때 사용자가 방금 입력한 것을
           * 다시 타이핑해야 하고, 틀린 비밀번호를 거절하는 것이 이 엔드포인트의 정상 동작이다.
           */
          setHiworksId('')
          setHiworksPassword('')
          setEditing(false)
          setNotice('Hiworks 계정을 저장했습니다. 이제 메일을 보낼 때 입력하지 않아도 됩니다.')
        },
      },
    )
  }

  const remove = () => {
    setNotice(null)
    forget.mutate(undefined, {
      onSuccess: () => {
        setEditing(false)
        setNotice('저장된 Hiworks 계정을 지웠습니다. 메일을 보낼 때 다시 입력하시면 됩니다.')
      },
    })
  }

  return (
    <div className={ui.page}>
      <div className={ui.pageBar}>
        <h1 className={ui.pageTitle}>내 정보</h1>
      </div>

      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <strong>{profile?.name ?? '-'}</strong>
          <span className={ui.spacer} />
          <span className={ui.hint}>
            {profile?.roleName ?? '역할 미지정'}
            {profile?.mgrId ? ` · ${profile.mgrId}` : ''}
          </span>
        </div>
        <div className={ui.cardBody}>
          <div className={ui.detailGrid}>
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>이름</span>
              <span className={ui.detailValue}>{profile?.name ?? '-'}</span>
            </div>
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>이메일</span>
              <span className={ui.detailValue}>{profile?.email ?? '-'}</span>
            </div>
            <div className={ui.detailItem}>
              <span className={ui.detailLabel}>역할</span>
              <span className={ui.detailValue}>{profile?.roleName ?? '-'}</span>
            </div>
          </div>
        </div>
      </div>

      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <strong>Hiworks 계정</strong>
        </div>
        <div className={ui.cardBody}>
          <p className={ui.hint}>
            인계메일과 PO 발주 요청은 <b>본인의 Hiworks 계정</b>으로 나갑니다. 계정을 저장해 두면
            메일을 보낼 때마다 입력하지 않아도 됩니다. 저장은 선택이며, 저장하지 않아도 보낼 때
            직접 입력해서 그대로 사용할 수 있습니다.
          </p>

          {credential.isError ? <ErrorNotice error={credential.error} /> : null}
          {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}

          {credential.isLoading ? <p className={ui.placeholder}>불러오는 중…</p> : null}

          {view && !vaultConfigured ? (
            <InfoNotice>
              이 시스템에는 계정 저장 기능이 설정되어 있지 않습니다. 메일을 보낼 때 아이디와
              비밀번호를 직접 입력해 주세요.
            </InfoNotice>
          ) : null}

          {view && vaultConfigured && registered ? (
            <>
              <div className={ui.detailGrid}>
                <div className={ui.detailItem}>
                  <span className={ui.detailLabel}>저장된 계정</span>
                  <span className={ui.detailValue}>{view.hiworksIdHint ?? '-'}</span>
                </div>
                <div className={ui.detailItem}>
                  <span className={ui.detailLabel}>마지막 변경</span>
                  <span className={ui.detailValue}>
                    {view.updatedAt ? formatDateTime(view.updatedAt) : '-'}
                  </span>
                </div>
              </div>
              <p className={ui.hint}>
                아이디는 일부만 보여 드립니다. 저장된 값은 암호화되어 있어 화면에서 다시 확인할 수
                없고, 바꾸려면 새로 입력해야 합니다.
              </p>
              {!formOpen ? (
                <div className={ui.formActions}>
                  <button
                    type="button"
                    className={`${ui.btn} ${ui.btnPrimary}`}
                    onClick={() => setEditing(true)}
                  >
                    계정 변경
                  </button>
                  <button
                    type="button"
                    className={`${ui.btn} ${ui.btnDanger}`}
                    onClick={remove}
                    disabled={forget.isPending}
                  >
                    {forget.isPending ? '지우는 중…' : '저장된 계정 지우기'}
                  </button>
                </div>
              ) : null}
              <ErrorNotice error={forget.error} />
            </>
          ) : null}

          {formOpen ? (
            <form onSubmit={submit}>
              <div className={ui.formGrid}>
                <label className={ui.field}>
                  <span className={ui.label}>Hiworks 아이디</span>
                  <input
                    className={ui.input}
                    type="text"
                    value={hiworksId}
                    onChange={(e) => setHiworksId(e.target.value)}
                    autoComplete="off"
                    required
                  />
                </label>
                <label className={ui.field}>
                  <span className={ui.label}>Hiworks 비밀번호</span>
                  <input
                    className={ui.input}
                    type="password"
                    value={hiworksPassword}
                    onChange={(e) => setHiworksPassword(e.target.value)}
                    /*
                     * 브라우저 비밀번호 관리자가 이 칸을 자기 저장소에 넣으려 하지 않게 한다.
                     * 여기서 하는 일이 이미 "비밀번호를 맡아 두는 것" 이므로, 같은 값을 두
                     * 군데에 더 두는 것은 사용자가 요청한 적 없는 일이다.
                     */
                    autoComplete="new-password"
                    required
                  />
                </label>
              </div>
              <p className={ui.hint}>
                저장하기 전에 Hiworks 로그인을 한 번 확인합니다. 비밀번호가 맞지 않으면 저장되지
                않으므로, 잘못된 계정이 저장된 채 남는 일은 없습니다.
              </p>
              <ErrorNotice error={save.error} />
              <div className={ui.formActions}>
                <button
                  type="submit"
                  className={`${ui.btn} ${ui.btnPrimary}`}
                  disabled={save.isPending || hiworksId.trim() === '' || hiworksPassword === ''}
                >
                  {save.isPending ? '확인하는 중…' : '저장'}
                </button>
                {registered ? (
                  <button
                    type="button"
                    className={`${ui.btn} ${ui.btnGhost}`}
                    onClick={() => {
                      setEditing(false)
                      setHiworksId('')
                      setHiworksPassword('')
                    }}
                    disabled={save.isPending}
                  >
                    취소
                  </button>
                ) : null}
              </div>
            </form>
          ) : null}
        </div>
      </div>
    </div>
  )
}
