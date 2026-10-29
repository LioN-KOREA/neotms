import { NeotmsApiException } from '@/apis/neotms.exception'

/**
 * 쿼리·뮤테이션이 던진 것을 사람이 읽고 행동할 수 있는 문장으로 바꾼다.
 *
 * 상태 코드마다 사용자가 해야 할 일이 다르고, 그 차이를 말해 주지 않으면 전부 "오류가
 * 발생했습니다"가 된다. 그 화면을 받은 사람이 할 수 있는 일은 담당자에게 전화하는 것뿐이고,
 * 담당자도 로그를 보기 전까지는 모른다.
 */
export function describeError(error: unknown): string {
  if (error instanceof NeotmsApiException) {
    switch (error.status) {
      case 401:
        return '세션이 만료되었습니다. 다시 로그인해 주세요.'
      case 403:
        // 두 가지 경우가 모두 403 이다: 메뉴 권한이 없거나, 볼 수 없는 범위의 행을 건드렸거나.
        // 사용자 입장에서 할 일은 같다 — 권한을 요청하는 것이다.
        return '이 작업을 수행할 권한이 없습니다. 권한이 필요하면 관리자에게 요청해 주세요.'
      case 404:
        return '대상을 찾을 수 없습니다. 다른 사용자가 이미 삭제했을 수 있습니다.'
      case 409:
        /*
         * 409 는 두 가지다 — 중복 키(SQLSTATE 23505)와 참조 무효(23503). 사용자가 할 일이
         * 정반대이므로 구분해야 한다: 앞쪽은 값을 바꿔야 하고, 뒤쪽은 참조 대상을 먼저
         * 등록해야 한다. 서버는 둘 다 409 로 주고 메시지로만 구분한다(PostgresUtils).
         *
         * 이 경로를 가장 많이 타던 것은 분야·언어 같은 코드 입력란이었다. 그 컬럼들은 `sys_code`
         * 를 참조하는 FK 인데 화면이 자유 입력으로 받고 있었고, 그래서 오타 하나가 저장 실패가
         * 되었다. 지금은 모두 `CodeSelect` 드롭다운이므로 이 메시지를 보는 경우는 드물다 —
         * 남겨 두는 이유는 (a) 다른 사람이 코드를 삭제한 직후, (b) ETL 로 들어온 행을 열어서
         * 수정할 때 '등록되지 않은 값' 을 그대로 다시 저장하는 경우가 남아 있기 때문이다.
         */
        if (/referenced record/i.test(error.message)) {
          return '참조하는 값이 등록되어 있지 않습니다. 코드는 유지보수 화면에 등록된 값만 저장할 수 있습니다.'
        }
        return '이미 사용 중인 값입니다. 코드나 이름을 확인해 주세요.'
      case 422:
      case 400:
        // 서버의 valibot 스키마가 거절한 경우다. 어떤 필드가 왜 틀렸는지는 서버 메시지에 있다.
        return error.message
      case 502:
        return '외부 시스템(계정 시스템 또는 메일 발송)에 문제가 있습니다. 잠시 후 다시 시도해 주세요.'
      case 503:
        // api 레이어가 이미 두 번 재시도한 뒤다. 여기까지 왔다면 깨어나는 데 평소보다 오래
        // 걸리고 있다는 뜻이므로, 장애가 아니라 대기라고 말해 준다.
        return '데이터베이스가 절전 상태에서 깨어나는 중입니다. 잠시 후 다시 시도해 주세요.'
      case 504:
        return '처리 시간이 초과되었습니다. 기간이나 조건을 좁혀서 다시 시도해 주세요.'
      case 0:
        return '서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.'
      default:
        return error.message
    }
  }
  if (error instanceof Error) return error.message
  return '알 수 없는 오류가 발생했습니다.'
}

/**
 * 재시도해도 결과가 같은 실패인가. react-query 의 `retry` 에 쓴다.
 *
 * 4xx 를 재시도하면 같은 답을 세 번 받으면서 사용자를 세 배 오래 기다리게 한다. 503 과 502,
 * 그리고 네트워크 실패만 다시 시도할 가치가 있다.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false
  if (error instanceof NeotmsApiException) return error.isTransient
  // 알 수 없는 오류는 한 번만 더.
  return failureCount < 1
}
