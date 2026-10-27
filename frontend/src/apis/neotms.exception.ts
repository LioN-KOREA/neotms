/**
 * API 호출이 실패했을 때 쿼리·뮤테이션이 던지는 예외.
 *
 * 메시지만 있는 Error 로는 화면이 401(세션 만료)과 403(권한 없음)을 구분할 수 없다. 둘은
 * 사용자가 해야 할 일이 완전히 다르다 — 전자는 다시 로그인, 후자는 담당자에게 권한 요청이다.
 * 그래서 상태 코드를 그대로 들고 다닌다.
 *
 * `retryAfterSec` 은 503 에만 있다. 백엔드가 503 을 쓰는 경우는 두 가지뿐이고 둘 다 "잠깐
 * 기다리면 된다"는 뜻이다:
 *
 *   - 다른 탭이 토큰 갱신 리스를 잡고 있다(Retry-After: 1).
 *   - Aurora 클러스터가 절전에서 깨어나는 중이다(Retry-After: 2). 업무시간 외에는 ACU 바닥이
 *     0 이므로 아침 첫 요청이나 야간 접속에서 정상적으로 발생한다. 오류로 취급하면 안 된다.
 */
export class NeotmsApiException extends Error {
  readonly status: number
  readonly retryAfterSec: number | null

  constructor(status: number, message: string, retryAfterSec: number | null = null) {
    super(message)
    this.name = 'NeotmsApiException'
    this.status = status
    this.retryAfterSec = retryAfterSec
  }

  /** 기다렸다 다시 보내면 성공할 수 있는 실패인가. */
  get isTransient(): boolean {
    return this.status === 503 || this.status === 502 || this.status === 0
  }
}
