import { neotmsAuthApi } from '@/apis/neotms.client'

/**
 * `/api/auth/*` 네 개의 엔드포인트.
 *
 * OIDC 흐름 전체가 서버에 있다. 이 파일에는 PKCE 도, state 검증도, 토큰 교환도 없다 — 그 코드는
 * Lambda 의 NeotmsSessionManager 에 있고, 브라우저가 하는 일은 세 가지뿐이다:
 *
 *   1. `/api/auth/login` 으로 **페이지를 이동**한다(fetch 가 아니다).
 *   2. 돌아온 주소의 쿼리 문자열을 `/api/auth/session` 에 그대로 전달한다.
 *   3. 받은 액세스 토큰을 메모리에 들고 있는다.
 *
 * 이 분담이 중요한 이유는 리프레시 토큰이다. 리프레시 토큰은 24시간 유효하고, 브라우저로
 * 내려오지 않는다. 내려왔다면 XSS 한 번에 하루치 세션이 넘어간다. 대신 브라우저는 HttpOnly
 * 세션 쿠키 + 최대 1시간짜리 액세스 토큰만 갖는다.
 */

export interface NeotmsSessionUser {
  sub: string
  email: string
  name: string
  /**
   * 이 계정이 NEOTMS 를 **열 수** 있는지. 거친 1단계 권한이다.
   *
   * 무엇을 할 수 있는지는 여기서 알 수 없다 — 그건 /api/v0/me 의 메뉴 권한 행렬이 정한다.
   * 이 값이 false 일 때 빈 화면 대신 "접근 권한이 없습니다"를 보여 주기 위해서만 쓴다.
   */
  canAccess: boolean
}

export interface NeotmsSessionView {
  accessToken: string
  /** epoch ms. */
  expiresAt: number
  user: NeotmsSessionUser
}

/**
 * 로그인을 시작한다. **돌아오지 않는다** — 페이지가 떠난다.
 *
 * fetch 가 아니라 `location.assign` 인 이유: 이 엔드포인트는 302 로 계정 시스템의 /authorize 로
 * 보낸다. fetch 로 부르면 브라우저가 리다이렉트를 따라가 버리고(그래서 사용자는 아무 데도 가지
 * 않고), 응답의 Set-Cookie 로 내려오는 PKCE 플로우 쿠키만 조용히 저장된 채 아무 일도 일어나지
 * 않는다. 최상위 내비게이션이어야 한다.
 */
export function startLogin(): void {
  window.location.assign('/api/auth/login')
}

/**
 * 계정 시스템이 되돌려보낸 쿼리 문자열을 세션으로 바꾼다.
 *
 * `search` 를 해석하지 않고 통째로 넘긴다. code 와 state 를 꺼내서 재조립하면 그 과정에서
 * 인코딩이 한 번 더 돌고, 서버는 그 문자열을 등록된 redirect_uri 뒤에 붙여 **서명 검증의
 * 입력으로** 쓰기 때문에 한 바이트만 달라져도 검증이 깨진다. 손대지 않는 것이 가장 안전하다.
 */
export async function completeLogin(
  search: string,
): Promise<{ status: number; session: NeotmsSessionView | null; message: string }> {
  const res = await neotmsAuthApi<NeotmsSessionView>('/api/auth/session', {
    method: 'POST',
    body: { callback: search },
  })
  return { status: res.status, session: res.body, message: res.message }
}

/**
 * 세션 쿠키로 액세스 토큰을 받아온다. 부팅할 때와 만료 직전에 쓴다.
 *
 * 새로고침이 로그인 화면으로 떨어지지 않는 이유가 이 호출이다. 액세스 토큰은 그 페이지의
 * 메모리에만 있었으니 새로고침과 함께 사라지지만, 세션 쿠키는 남아 있다.
 *
 * 503 은 실패가 아니다. 다른 탭이 갱신 리스를 잡고 있다는 뜻이고, 그 탭이 저장할 토큰을 잠시
 * 뒤 읽으면 된다. 재시도는 호출하는 쪽(AuthContextProvider)이 한다.
 */
export async function refreshSession(): Promise<{
  status: number
  session: NeotmsSessionView | null
  message: string
}> {
  const res = await neotmsAuthApi<NeotmsSessionView>('/api/auth/refresh', { method: 'POST' })
  return { status: res.status, session: res.body, message: res.message }
}

/**
 * 로그아웃. 반환된 주소로 **반드시 이동해야** 완결된다.
 *
 * 우리 쿠키를 지우는 것은 로그아웃이 아니다. 계정 시스템의 SSO 세션은 그대로 살아 있으므로
 * 다음 /authorize 가 아무것도 묻지 않고 바로 코드를 발급한다 — 사무실 공용 PC 에서는 그게
 * 바로 문제 그 자체다. 그래서 서버가 돌려주는 /logout 주소로 이동해 연동된 모든 앱의 세션을
 * 함께 끝낸다.
 */
export async function endSession(): Promise<string | null> {
  const res = await neotmsAuthApi<{ logoutUrl: string }>('/api/auth/logout', { method: 'POST' })
  return res.body?.logoutUrl ?? null
}
