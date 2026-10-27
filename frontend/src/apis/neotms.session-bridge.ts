/**
 * api 레이어와 인증 컨텍스트 사이의 연결 고리.
 *
 * ## 왜 토큰을 인자로 넘기지 않는가
 *
 * 계정관리 콘솔은 훅에서 토큰을 읽어 api 함수의 인자로 넘긴다. 여기서는 그렇게 하지 않는데,
 * 이 시스템에는 그 방식이 깨지는 지점이 있다 — **액세스 토큰이 1시간마다 바뀐다.**
 *
 * 토큰을 인자로 넘기면 그 값은 훅이 렌더링된 시점에 클로저에 갇힌다. useInfiniteQuery 의
 * fetchNextPage 나 리트라이는 그 클로저를 나중에 실행하므로, 갱신이 한 번 일어난 뒤의 호출은
 * **이미 폐기된 토큰**을 보낸다. 증상은 "목록 첫 페이지는 되는데 더 보기만 401" 같은 형태이고,
 * 토큰을 인자로 받는 코드만 보고는 원인을 찾을 수 없다.
 *
 * 그래서 api 레이어는 호출 **시점에** 현재 토큰을 물어본다. 모듈 전역을 쓰는 것은 일반적으로
 * 피해야 하지만, 여기서는 "브라우저 탭 하나에 세션은 하나"라는 사실과 정확히 일치하는 범위다.
 *
 * ## 왜 갱신도 여기 있는가
 *
 * 401 을 받은 api 함수가 직접 갱신하고 재시도해야 한다. 각 화면이 401 을 받아 처리하게 하면
 * 여섯 개 화면에 같은 코드가 여섯 번 생기고, 그중 하나를 고치지 않으면 그 화면만 가끔
 * 로그아웃된다. 갱신은 한 곳에서만 일어나야 한다.
 */

export interface NeotmsSessionBridge {
  /** 지금 유효한 액세스 토큰. 세션이 없으면 null. */
  getAccessToken: () => string | null
  /**
   * 세션 쿠키로 토큰을 다시 받아온다. 성공하면 새 토큰, 실패하면 null.
   *
   * 동시 호출은 인증 컨텍스트 쪽에서 하나로 합친다(아래 `refreshSession` 주석 참고). 여기서
   * 여러 번 불러도 백엔드로 가는 요청은 한 번이다.
   */
  refresh: () => Promise<string | null>
  /** 갱신까지 실패했다 — 세션이 끝났다고 앱 전체에 알린다. */
  onSignedOut: () => void
}

let bridge: NeotmsSessionBridge | null = null

/** AuthContextProvider 가 마운트될 때 한 번 등록한다. */
export function registerSessionBridge(next: NeotmsSessionBridge): void {
  bridge = next
}

export function currentAccessToken(): string | null {
  return bridge?.getAccessToken() ?? null
}

export async function refreshAccessToken(): Promise<string | null> {
  if (!bridge) return null
  return bridge.refresh()
}

export function notifySignedOut(): void {
  bridge?.onSignedOut()
}
