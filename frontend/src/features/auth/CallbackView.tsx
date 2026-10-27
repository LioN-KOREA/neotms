import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useAuthContext } from '@/auth/AuthContextProvider'
import { completeLogin } from '@/auth/auth.api'
import { takeReturnPath } from '@/auth/return-path'
import ui from '@/shared/ui/ui.module.css'
import { AuthGateCard } from './AuthGate'
import styles from './AuthGate.module.css'

/**
 * `/auth/callback` — 계정 시스템이 되돌려보내는 곳.
 *
 * 이 화면이 하는 일은 하나다: 도착한 쿼리 문자열을 `POST /api/auth/session` 에 넘겨 세션으로
 * 바꾸고, 원래 보던 화면으로 보낸다.
 *
 * ## 교환은 정확히 한 번만 한다
 *
 * 인가 코드는 **일회용**이다. 두 번 보내면 두 번째는 `invalid_grant` 로 거절되고, 더 나쁜
 * 경우(엄격한 IdP)는 첫 번째로 발급된 토큰까지 함께 폐기한다. React 19 의 StrictMode 는
 * 개발 모드에서 이펙트를 두 번 실행하므로, ref 가드가 없으면 **개발 환경에서만 로그인이
 * 실패하는** 증상이 나온다. 운영에서 재현되지 않는 버그는 찾는 데 가장 오래 걸린다.
 *
 * ## 실패해도 코드가 URL 에 남아 있으면 안 된다
 *
 * 성공·실패와 무관하게 주소를 `replace` 로 바꾼다. 남겨 두면 사용자가 새로고침할 때 이미 쓴
 * 코드를 한 번 더 보내게 되고, 브라우저 히스토리와 (CloudFront 접근 로그에) 인가 코드가
 * 그대로 남는다.
 */
export function CallbackView() {
  const { search } = useLocation()
  const navigate = useNavigate()
  const { adoptSession, login } = useAuthContext()

  const exchanged = useRef(false)

  /**
   * 도착한 주소만 보고 알 수 있는 실패는 **첫 렌더에서** 정한다.
   *
   * 이펙트에서 `setFailure` 를 부르면 "완료하는 중입니다…" 를 한 프레임 보여 준 뒤 오류로
   * 바뀐다 — 이미 실패한 로그인에 대해 진행 중이라고 거짓말하는 셈이다. 지연 초기화로 옮기면
   * 그 렌더가 사라진다.
   *
   * 렌더마다 `search` 에서 다시 **파생**시키지는 않는다. 아래 이펙트가 주소에서 코드를 지우고
   * (`replace`) 나면 `search` 가 비어서, 파생값이라면 방금 띄운 오류 메시지가 사라진다.
   * 이것은 "그때 받은 것" 이므로 상태가 맞다.
   */
  const [failure, setFailure] = useState<string | null>(() => {
    const params = new URLSearchParams(search)

    /*
     * 계정 시스템이 오류를 돌려보낸 경우.
     *
     * 서버의 startLogin 은 discovery 가 실패하면 502 를 주는 대신 이 주소로 되돌려보낸다
     * (`?error=temporarily_unavailable`). 최상위 내비게이션 중에 502 를 내면 사용자가 빈
     * 오류 페이지에 갇히기 때문이다 — 그 판단의 나머지 절반이 여기다. 여기서 error 를 읽지
     * 않으면 그 사용자는 "로그인을 눌렀는데 아무 일도 일어나지 않는" 화면을 보게 된다.
     */
    const error = params.get('error')
    if (error) return describeOidcError(error, params.get('error_description'))

    // 코드도 오류도 없다 — 사용자가 이 주소를 직접 열었거나, 북마크했다.
    if (!params.get('code')) return '로그인 정보가 없습니다. 로그인을 다시 시작해 주세요.'

    return null
  })

  useEffect(() => {
    if (exchanged.current) return
    exchanged.current = true

    const params = new URLSearchParams(search)

    // 오류로 되돌아온 경우: 보여 줄 문장은 이미 정해졌고, 주소에서 흔적만 지운다.
    if (params.get('error')) {
      void navigate('/auth/callback', { replace: true })
      return
    }

    // 코드가 없으면 교환할 것도 없다. 이 주소는 그대로 둔다(지울 민감한 값이 없다).
    if (!params.get('code')) return

    void (async () => {
      // search 를 해석하지 않고 그대로 넘긴다 — 이유는 auth.api.ts 의 completeLogin 주석.
      const res = await completeLogin(search)

      if (res.status === 200 && res.session) {
        adoptSession(res.session)
        // 원래 보던 화면으로. 기억된 것이 없으면 기본 화면이다.
        void navigate(takeReturnPath() ?? '/', { replace: true })
        return
      }

      setFailure(res.message || '로그인을 완료하지 못했습니다.')
      // 실패해도 코드는 주소창에서 지운다.
      void navigate('/auth/callback', { replace: true })
    })()
  }, [search, adoptSession, navigate])

  if (!failure) {
    return (
      <AuthGateCard>
        <p className={styles.lead}>로그인을 완료하는 중입니다…</p>
      </AuthGateCard>
    )
  }

  return (
    <AuthGateCard>
      <div className={`${ui.alert} ${ui.alertError}`} role="alert">
        {failure}
      </div>
      <button
        type="button"
        className={`${ui.btn} ${ui.btnPrimary} ${styles.action}`}
        onClick={login}
      >
        로그인 다시 시도
      </button>
    </AuthGateCard>
  )
}

/**
 * OAuth 오류 코드를 사람이 읽을 문장으로.
 *
 * 코드를 그대로 보여 주면("access_denied") 사용자는 자기가 무엇을 해야 하는지 알 수 없다.
 * `error_description` 은 IdP 가 영어로 주므로 설명문의 주인공으로 쓰지 않고 뒤에 덧붙인다 —
 * 지워 버리면 담당자가 원인을 추적할 단서가 없어진다.
 */
function describeOidcError(code: string, description: string | null): string {
  const known: Record<string, string> = {
    access_denied: '로그인이 취소되었거나 접근이 거부되었습니다.',
    temporarily_unavailable:
      '계정관리 시스템에 일시적으로 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
    invalid_request: '로그인 요청이 올바르지 않습니다. 시스템 담당자에게 문의해 주세요.',
    unauthorized_client:
      '이 시스템이 계정관리 시스템에 등록되어 있지 않습니다. 시스템 담당자에게 문의해 주세요.',
    server_error: '계정관리 시스템에서 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
  }
  const text = known[code] ?? `로그인에 실패했습니다 (${code}).`
  return description ? `${text} (${description})` : text
}
