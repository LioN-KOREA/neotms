/**
 * 로그인 전에 보고 있던 화면을 기억한다.
 *
 * ## 왜 서버가 해 주지 않는가
 *
 * 로그인은 최상위 내비게이션이다 — 브라우저가 `/api/auth/login` → 계정 시스템 → `/auth/callback`
 * 으로 **페이지를 두 번 떠난다.** 그래서 React 의 state 도, 쿼리 캐시도, 메모리 변수도 전부
 * 사라진다. 서버의 로그인 엔드포인트에는 돌아갈 경로를 받는 파라미터가 없고(그 파라미터는
 * 오픈 리다이렉트의 입구가 되므로 없는 편이 안전하다), 그래서 "어디로 돌아갈지" 는 브라우저가
 * 스스로 들고 있어야 한다.
 *
 * ## sessionStorage 를 쓰는 이유
 *
 * 토큰은 저장하지 않지만(AuthContextProvider 주석) 이건 경로다. 유출되어도 잃을 것이 없고,
 * 탭 단위로 분리되며 탭을 닫으면 사라진다 — 공용 PC 에서 다음 사람이 이전 사용자의 마지막
 * 화면 주소를 보게 되는 일이 없다. localStorage 는 그 두 성질을 모두 잃는다.
 *
 * ## 경로만 허용한다
 *
 * 돌아갈 주소를 `//evil.example.com` 이나 `https://evil.example.com` 으로 만들 수 있으면,
 * 그건 우리 도메인을 경유하는 오픈 리다이렉트다. 저장할 때와 꺼낼 때 양쪽에서 검사한다 —
 * 저장만 검사하면 다른 코드가 직접 키를 써넣은 경우를 놓친다.
 */

const KEY = 'neotms.returnPath'

/** `/` 로 시작하고 `//`(프로토콜 상대 주소)가 아닌 것만 경로로 인정한다. */
function isSafePath(value: string | null | undefined): value is string {
  return !!value && value.startsWith('/') && !value.startsWith('//')
}

/** 로그인 시작 직전에 호출한다. 콜백·로그아웃 화면 자신은 기억하지 않는다. */
export function rememberReturnPath(path: string): void {
  if (!isSafePath(path)) return
  if (path.startsWith('/auth/')) return
  try {
    window.sessionStorage.setItem(KEY, path)
  } catch {
    // 프라이버시 모드 등으로 저장이 막혀 있으면 기본 화면으로 돌아간다. 로그인 자체는
    // 영향받지 않으므로 조용히 넘어가는 것이 맞다.
  }
}

/**
 * 기억해 둔 경로를 꺼내고 지운다. 없으면 null.
 *
 * 꺼낼 때 바로 지우는 것이 중요하다. 남겨 두면 다음 로그인 때도 같은 화면으로 튀고, 사용자는
 * 자기가 누른 적 없는 화면으로 끌려가는 이유를 알 수 없다.
 */
export function takeReturnPath(): string | null {
  let value: string | null = null
  try {
    value = window.sessionStorage.getItem(KEY)
    window.sessionStorage.removeItem(KEY)
  } catch {
    return null
  }
  return isSafePath(value) && !value.startsWith('/auth/') ? value : null
}
