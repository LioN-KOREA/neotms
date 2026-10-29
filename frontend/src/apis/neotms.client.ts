import { NeotmsApiException } from './neotms.exception'
import { currentAccessToken, notifySignedOut, refreshAccessToken } from './neotms.session-bridge'

/**
 * NEOTMS API 를 호출하는 단 하나의 입구.
 *
 * ## 주소는 항상 상대 경로다
 *
 * 베이스 URL 상수가 없다. 콘솔과 API 는 같은 CloudFront 배포에서 나오므로(기본 경로 → 콘솔,
 * /api/* → Lambda) 같은 오리진이고, 로컬 개발에서는 vite 프록시가 그 역할을 대신한다
 * (vite.config.ts 참고).
 *
 * 선택이 아니라 제약이다. 세션 쿠키가 `SameSite=Lax` 이므로 다른 오리진에서 보낸
 * `POST /api/auth/refresh` 에는 쿠키가 붙지 않는다. 빌드 시점 설정이 없다는 것은 덤이 아니라
 * 핵심이다 — 노트북에서 만든 빌드가 엉뚱한 백엔드를 가리킬 방법이 아예 없다.
 *
 * ## 두 가지 자격증명이 서로 다른 경로에 붙는다
 *
 *   - `/api/auth/*` → **세션 쿠키**. HttpOnly 이므로 JS 가 읽지도 쓰지도 못하고, 브라우저가
 *     알아서 붙인다. Path 가 `/api/auth` 로 좁혀져 있어서 아래 /api/v0 호출에는 붙지 않는다.
 *   - `/api/v0/*` → **Bearer 액세스 토큰**. 메모리에만 있다.
 *
 * 이게 리프레시 토큰이 브라우저에 오지 않는 구조의 전부다. 쿠키는 세션 식별자일 뿐이고, 실제
 * 리프레시 토큰은 DynamoDB 안에서 Lambda 만 본다. XSS 가 났을 때 훔칠 수 있는 최대치가
 * "최대 1시간 남은 액세스 토큰"이 된다.
 *
 * ## 응답은 전부 JSON 이다 — 오류 본문까지
 *
 * 백엔드의 `responseDataToApiGatewayResult` 가 본문을 무조건 `JSON.stringify` 한다. 따라서
 * 오류 응답의 본문은 평문이 아니라 **JSON 문자열**이다. `"Not signed in"` 이 따옴표까지 포함해
 * 내려온다. 그냥 `await res.text()` 로 읽어 화면에 뿌리면 따옴표가 보인다.
 */

/** 503 이 왔을 때 최대 몇 번 더 시도할지. */
const TRANSIENT_RETRIES = 2

export interface NeotmsRequestInit {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** 쿼리 문자열. undefined · null 값은 빠진다. */
  query?: Record<string, string | number | boolean | null | undefined>
  /** JSON 으로 보낼 본문. */
  body?: unknown
  signal?: AbortSignal
}

function buildUrl(path: string, query?: NeotmsRequestInit['query']): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    // 빈 문자열도 뺀다. 필터 select 의 "전체" 선택지가 '' 이고, `state=` 를 보내면 백엔드가
    // 빈 상태값으로 필터링해 아무 행도 돌려주지 않는다.
    if (value === null || value === undefined || value === '') continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

/**
 * 본문을 읽는다. 성공이든 실패든 JSON 으로 파싱해 보고, 실패하면 평문으로 취급한다.
 *
 * 평문 경로가 필요한 이유: Lambda 가 아니라 **CloudFront 나 API Gateway** 가 답한 경우가 있다.
 * 504(통합 타임아웃)와 403(엣지에서 막힌 요청)은 HTML 이나 비정형 본문으로 온다.
 */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text.length === 0) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** 오류 본문에서 사람이 읽을 메시지를 뽑는다. */
function messageFrom(body: unknown, status: number): string {
  if (typeof body === 'string' && body.trim().length > 0) return body
  if (body && typeof body === 'object') {
    const maybe = (body as Record<string, unknown>).message
    if (typeof maybe === 'string' && maybe.trim().length > 0) return maybe
  }
  return `요청이 실패했습니다 (HTTP ${status}).`
}

function retryAfterOf(res: Response): number | null {
  const raw = res.headers.get('Retry-After')
  if (!raw) return null
  const sec = Number.parseInt(raw, 10)
  return Number.isFinite(sec) && sec >= 0 ? sec : null
}

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

/**
 * 인증이 필요한 API 호출. 401 이면 한 번 갱신하고 재시도한다.
 *
 * 재시도는 **정확히 한 번**이다. 갱신해서 받은 토큰으로 또 401 이 나면 그것은 만료 문제가
 * 아니라 권한 문제(또는 계정이 비활성화된 것)이므로, 더 시도해도 같은 답이 온다. 무한 갱신
 * 루프는 사용자 입장에서 "화면이 멈췄다"로 보이고 서버 입장에서는 요청 폭주로 보인다.
 */
export async function neotmsApi<T>(path: string, init: NeotmsRequestInit = {}): Promise<T> {
  let token = currentAccessToken()
  if (!token) {
    // 아직 세션이 없다. 쿼리의 `enabled` 가 보통 막아 주지만, 뮤테이션은 사용자가 버튼을 누른
    // 순간 실행되므로 여기서도 막아야 한다.
    const refreshed = await refreshAccessToken()
    if (!refreshed) {
      notifySignedOut()
      throw new NeotmsApiException(401, '세션이 만료되었습니다. 다시 로그인해 주세요.')
    }
    token = refreshed
  }

  let res = await send(path, init, token)

  if (res.status === 401) {
    const refreshed = await refreshAccessToken()
    if (!refreshed) {
      notifySignedOut()
      throw new NeotmsApiException(401, '세션이 만료되었습니다. 다시 로그인해 주세요.')
    }
    res = await send(path, init, refreshed)
    if (res.status === 401) {
      // 새 토큰으로도 401 — 만료가 아니라 자격 문제다.
      notifySignedOut()
      throw new NeotmsApiException(401, '이 계정으로는 접근할 수 없습니다.')
    }
  }

  return finish<T>(res)
}

async function send(path: string, init: NeotmsRequestInit, token: string): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'

  /*
   * 503 은 기다렸다 다시 보낸다.
   *
   * 서버가 503 + `Retry-After` 를 주는 경우는 "지금은 안 되지만 곧 된다"는 뜻이고 장애가
   * 아니다. 다른 탭이 토큰 갱신 리스를 잡고 있거나, DB 커넥션 풀(Supavisor)이 일시적으로
   * 연결을 거절한 경우다 — 후자는 동시 접속이 몰리거나 비밀번호를 교체한 직후에 생긴다.
   * 사용자에게 "오류가 발생했습니다"를 보여 주고 직접 새로고침하게 만들 이유가 없다.
   */
  let attempt = 0
  for (;;) {
    const res = await fetch(buildUrl(path, init.query), {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // 쿠키를 붙인다. 상대 경로라 어차피 same-origin 이지만, 명시해 두면 누군가 절대 주소로
      // 바꿨을 때 쿠키가 조용히 사라지는 대신 CORS 오류로 드러난다.
      credentials: 'same-origin',
      signal: init.signal,
    })

    if (res.status !== 503 || attempt >= TRANSIENT_RETRIES) return res
    const waitSec = retryAfterOf(res) ?? 2
    await sleep(Math.min(waitSec, 5) * 1000)
    attempt++
  }
}

async function finish<T>(res: Response): Promise<T> {
  const body = await readBody(res)
  if (!res.ok) {
    throw new NeotmsApiException(res.status, messageFrom(body, res.status), retryAfterOf(res))
  }
  return body as T
}

/**
 * 인증 없이 호출하는 `/api/auth/*`.
 *
 * Authorization 헤더를 붙이지 않는다 — 아직 토큰이 없을 때 쓰는 경로이고, 자격증명은 브라우저가
 * 붙이는 세션 쿠키다. 401 재시도 로직도 없다: 여기서의 401 은 "세션이 없다"는 **정답**이지
 * 고쳐야 할 오류가 아니다.
 */
export async function neotmsAuthApi<T>(
  path: string,
  init: NeotmsRequestInit = {},
): Promise<{ status: number; body: T | null; message: string }> {
  let res: Response
  try {
    res = await fetch(buildUrl(path, init.query), {
      method: init.method ?? 'GET',
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'same-origin',
      signal: init.signal,
    })
  } catch (err) {
    // 네트워크 자체가 실패했다. 호출하는 쪽이 세션 만료와 구분할 수 있어야 하므로 던지지 않고
    // 0 을 돌려준다 — 0 을 받은 부팅 코드는 로그인 화면이 아니라 "다시 시도" 를 보여 준다.
    console.error(`인증 API 호출이 실패했습니다 (${path}) : ${String(err)}`)
    return { status: 0, body: null, message: '서버에 연결할 수 없습니다.' }
  }

  const body = await readBody(res)
  return {
    status: res.status,
    body: res.ok ? (body as T) : null,
    message: res.ok ? '' : messageFrom(body, res.status),
  }
}
