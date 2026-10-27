import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { registerSessionBridge } from '@/apis/neotms.session-bridge'
import {
  endSession,
  refreshSession,
  startLogin,
  type NeotmsSessionUser,
  type NeotmsSessionView,
} from './auth.api'

/**
 * 콘솔의 인증 상태.
 *
 * 흐름 전체가 서버에 있으므로(auth.api.ts 주석 참고) 이 파일이 하는 일은 세 가지로 좁다:
 * 부팅할 때 세션이 있는지 확인하고, 액세스 토큰을 메모리에 들고 있고, 만료 전에 갱신한다.
 *
 * ## 토큰을 저장하지 않는다
 *
 * localStorage 도 sessionStorage 도 쓰지 않는다. 저장할 이유가 없다 — 새로고침하면
 * `POST /api/auth/refresh` 한 번으로 세션 쿠키에서 토큰을 다시 받아오고, 사용자는 아무것도
 * 하지 않는다. 저장하면 XSS 가 났을 때 훔칠 수 있는 창이 "탭이 살아 있는 동안"에서 "그 브라우저
 * 프로필이 유지되는 동안"으로 늘어난다. 얻는 것 없이 잃기만 한다.
 */

export type AuthStatus =
  /** 세션을 확인하는 중. 아직 아무것도 그리지 않는다. */
  | 'bootstrapping'
  /** 세션이 없다. 로그인 화면을 보여야 한다. */
  | 'login_required'
  /** 세션이 있고 토큰이 있다. */
  | 'authenticated'
  /**
   * 로그인은 됐지만 이 시스템을 쓸 권한이 없다.
   *
   * login_required 와 반드시 구분해야 한다. 이 상태에서 로그인 버튼을 보여 주면, 사용자는
   * 로그인 → 즉시 같은 화면으로 돌아오기를 반복한다(SSO 세션이 살아 있으므로 비밀번호도 묻지
   * 않는다). 할 수 있는 일은 담당자에게 권한을 요청하는 것뿐이고, 화면은 그렇게 말해야 한다.
   */
  | 'no_access'
  /** 서버에 닿지 못했거나 인증이 오류로 끝났다. 세션 유무를 알 수 없는 상태. */
  | 'error'

export interface AuthState {
  status: AuthStatus
  user: NeotmsSessionUser | null
  /** epoch ms. 만료 예약에만 쓴다. */
  expiresAt: number | null
  errorMessage?: string
}

interface AuthContextValue {
  authState: AuthState
  /** 계정 시스템으로 떠난다. 돌아오지 않는다. */
  login: () => void
  /** 세션을 끝내고 /logout 으로 떠난다. */
  logout: () => Promise<void>
  /** 콜백 화면이 코드 교환을 마치고 호출한다. */
  adoptSession: (session: NeotmsSessionView) => void
  /** 오류 상태에서 "다시 시도"를 눌렀을 때. */
  retryBootstrap: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

/** 만료 몇 ms 전에 갱신할지. 서버의 REFRESH_AHEAD_MS 와 같은 값이다. */
const REFRESH_AHEAD_MS = 60_000

/**
 * 503(다른 탭이 갱신 중)일 때 다시 시도하는 횟수와 간격.
 *
 * 서버가 `Retry-After: 1` 을 주는 상황은 1초 안에 끝나므로 세 번이면 넉넉하다. 더 끈질기게
 * 매달려도 얻을 게 없다: 세 번 다 실패했다면 리스를 잡은 탭이 죽었다는 뜻이고, 그때는 리스가
 * 만료되기를 기다리는 것보다 다음 호출이 자연스럽게 재시도하게 두는 편이 낫다.
 */
const BUSY_RETRIES = 3
const BUSY_WAIT_MS = 1000

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

/**
 * 부팅 시 세션 확인을 건너뛰어야 하는 경로.
 *
 *   - `/auth/callback` 은 **콜백 화면이** 코드를 세션으로 교환한다. 여기서 refresh 를 먼저
 *     부르면 아직 세션이 없으니 401 이 오고, 상태가 login_required 로 떨어진다. 그러면 코드
 *     교환이 성공하기도 전에 로그인 화면이 깜빡이고, 운이 나쁘면 사용자가 그 버튼을 눌러
 *     **아직 쓰지 않은 인가 코드를 버린다**.
 *   - `/auth/logout` 은 방금 로그아웃한 사람이 도착하는 곳이다. 401 → login_required 가 되면
 *     "로그아웃되었습니다" 대신 로그인 화면이 뜨는데, 공용 PC 에서는 그게 로그아웃이 안 된
 *     것과 구분되지 않는다.
 */
const SELF_DRIVEN_PATHS = new Set(['/auth/callback', '/auth/logout'])

export interface AuthContextProviderProps {
  children: ReactNode
}

export function AuthContextProvider({ children }: AuthContextProviderProps) {
  const selfDriven = SELF_DRIVEN_PATHS.has(window.location.pathname)

  const [authState, setAuthState] = useState<AuthState>({
    // 콜백·로그아웃 화면은 스스로 상태를 정하므로 확인을 기다리게 하지 않는다.
    status: 'bootstrapping',
    user: null,
    expiresAt: null,
  })

  /**
   * 액세스 토큰. state 가 아니라 ref 다.
   *
   * state 로 두면 갱신이 일어날 때마다 Provider 아래의 모든 화면이 다시 렌더링된다. 토큰은
   * 화면에 그려지는 값이 아니므로 그 렌더링은 전부 낭비이고, 목록 화면에서는 스크롤 위치가
   * 튀는 등 눈에 보이는 부작용까지 생긴다. 토큰을 **읽는** 곳은 api 레이어 하나뿐이고, 그쪽은
   * 호출 시점에 ref 를 들여다보면 된다.
   */
  const tokenRef = useRef<string | null>(null)

  /** StrictMode 는 개발 모드에서 이펙트를 두 번 실행한다. 부팅 확인은 한 번만 한다. */
  const bootstrapped = useRef(false)
  /** 진행 중인 갱신. 동시에 들어온 요청을 하나로 합친다(아래 `doRefresh` 주석). */
  const refreshInFlight = useRef<Promise<string | null> | null>(null)
  /** 부팅을 다시 시도하게 만드는 값. */
  const [bootAttempt, setBootAttempt] = useState(0)

  const adoptSession = useCallback((session: NeotmsSessionView) => {
    tokenRef.current = session.accessToken
    setAuthState({
      // 토큰은 받았지만 이 시스템을 열 권한이 없을 수 있다. 서버는 그 경우에도 세션을 만들어
      // 준다(권한 없음과 로그인 실패는 다른 문제이고, 사용자에게도 다르게 설명해야 한다).
      status: session.user.canAccess ? 'authenticated' : 'no_access',
      user: session.user,
      expiresAt: session.expiresAt,
    })
  }, [])

  const clearSession = useCallback((status: AuthStatus, errorMessage?: string) => {
    tokenRef.current = null
    setAuthState({ status, user: null, expiresAt: null, errorMessage })
  }, [])

  /**
   * 세션 쿠키로 토큰을 다시 받아온다.
   *
   * 동시 호출을 하나로 합친다. 합치지 않으면 한 화면이 목록·상세·요약을 병렬로 띄운 상태에서
   * 토큰이 만료될 때 세 개의 401 이 동시에 나고, 세 개의 갱신 요청이 서버로 간다. 서버는
   * DynamoDB 조건부 업데이트로 하나만 통과시키고 나머지에 503 을 주므로 **데이터는 안전하지만**,
   * 화면에는 이유 없는 503 두 개가 뜬다. 여기서 합치면 서버에 가는 요청이 애초에 하나다.
   */
  const doRefresh = useCallback(async (): Promise<string | null> => {
    if (refreshInFlight.current) return refreshInFlight.current

    const run = (async (): Promise<string | null> => {
      for (let attempt = 0; ; attempt++) {
        const res = await refreshSession()

        if (res.status === 200 && res.session) {
          adoptSession(res.session)
          return res.session.accessToken
        }
        if (res.status === 401) {
          // 세션이 끝났다. 서버가 쿠키도 지웠다.
          clearSession('login_required')
          return null
        }
        if (res.status === 503 && attempt < BUSY_RETRIES) {
          // 다른 탭이 갱신 중이다. 그 탭이 저장할 토큰을 잠시 뒤 읽는다.
          await sleep(BUSY_WAIT_MS)
          continue
        }
        // 0(네트워크), 502(계정 시스템 장애), 500(설정 미비) — 세션이 끝났는지는 알 수 없다.
        // login_required 로 떨어뜨리면 세션이 멀쩡한 사용자를 로그인 화면으로 내보내게 된다.
        return null
      }
    })()

    refreshInFlight.current = run
    try {
      return await run
    } finally {
      refreshInFlight.current = null
    }
  }, [adoptSession, clearSession])

  // ---- 부팅 ------------------------------------------------------------
  useEffect(() => {
    if (selfDriven) return
    if (bootstrapped.current && bootAttempt === 0) return
    bootstrapped.current = true

    let cancelled = false
    void (async () => {
      const res = await refreshSession()
      if (cancelled) return

      if (res.status === 200 && res.session) {
        adoptSession(res.session)
        return
      }
      if (res.status === 401) {
        clearSession('login_required')
        return
      }
      if (res.status === 503) {
        // 다른 탭이 갱신 중이거나 DB 가 깨어나는 중이다. 한 번 더.
        await sleep(BUSY_WAIT_MS)
        if (cancelled) return
        const again = await refreshSession()
        if (cancelled) return
        if (again.status === 200 && again.session) return adoptSession(again.session)
        if (again.status === 401) return clearSession('login_required')
        return clearSession('error', again.message)
      }
      clearSession('error', res.message)
    })()

    return () => {
      cancelled = true
    }
  }, [selfDriven, bootAttempt, adoptSession, clearSession])

  // ---- 갱신 예약 -------------------------------------------------------
  useEffect(() => {
    if (authState.status !== 'authenticated' || !authState.expiresAt) return
    let cancelled = false

    const left = authState.expiresAt - Date.now() - REFRESH_AHEAD_MS
    // 음수면 이미 만료가 가깝다 — 즉시. setTimeout 의 지연 상한(약 24.8일)을 넘기지 않도록
    // 자르는 것은 형식적이지만, 서버 시계가 크게 틀어진 토큰을 받았을 때 타이머가 즉시
    // 발화하는 쪽이 조용히 영원히 기다리는 쪽보다 낫다.
    const delayMs = Math.max(0, Math.min(left, 86_400_000))

    const timer = window.setTimeout(() => {
      void (async () => {
        if (cancelled) return
        const token = await doRefresh()
        if (cancelled || token) return
        /*
         * 갱신이 실패했는데 세션이 끝난 것은 아니다(끝났다면 doRefresh 가 이미
         * login_required 로 바꿨다). 네트워크 문제일 가능성이 높다.
         *
         * 여기서 로그아웃시키지 않는다. 사용자가 작성 중인 폼을 잃기 때문이다. 토큰이 실제로
         * 만료되면 다음 API 호출이 401 을 받고, api 레이어가 한 번 더 갱신을 시도한다 —
         * 그때까지 사무실 와이파이가 돌아올 시간이 있다.
         */
      })()
    }, delayMs)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [authState.status, authState.expiresAt, doRefresh])

  // ---- api 레이어와 연결 -----------------------------------------------
  //
  // 레이아웃 이펙트가 아니라 일반 이펙트로 충분하다: 첫 렌더에서는 status 가 bootstrapping
  // 이므로 어떤 화면도 아직 API 를 부르지 않는다.
  useEffect(() => {
    registerSessionBridge({
      getAccessToken: () => tokenRef.current,
      refresh: doRefresh,
      onSignedOut: () => clearSession('login_required'),
    })
  }, [doRefresh, clearSession])

  // ---- 동작 ------------------------------------------------------------
  const logout = useCallback(async () => {
    const logoutUrl = await endSession()
    tokenRef.current = null
    /*
     * 돌려받은 주소로 이동한다. 받지 못했더라도(계정 시스템의 discovery 가 실패하는 등) 최소한
     * 로그아웃 화면으로는 보낸다 — 우리 세션은 이미 지워졌으므로 "로그아웃됐다"는 설명이
     * 틀린 말은 아니고, 사용자를 작업하던 화면에 그대로 두는 것보다는 낫다.
     */
    window.location.assign(logoutUrl ?? '/auth/logout')
  }, [])

  const retryBootstrap = useCallback(() => {
    setAuthState({ status: 'bootstrapping', user: null, expiresAt: null })
    setBootAttempt((n) => n + 1)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ authState, login: startLogin, logout, adoptSession, retryBootstrap }),
    [authState, logout, adoptSession, retryBootstrap],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuthContext(): AuthContextValue {
  const v = useContext(AuthContext)
  if (!v) throw new Error('useAuthContext must be used inside AuthContextProvider')
  return v
}
