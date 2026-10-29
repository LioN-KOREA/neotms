/**
 * 콘솔 전역 설정.
 *
 * ## 여기에 API 주소도, client_id 도 없다
 *
 * 둘 다 빌드에 넣지 않는다. 콘솔과 API 는 같은 CloudFront 배포에서 나오고(기본 경로 → 콘솔,
 * `/api/*` → API) 그래서 모든 호출이 `/api/...` 라는 상대 경로다. client_id 는 서버가 OIDC
 * 흐름 전체를 들고 있으므로 브라우저가 알 필요가 없다 — 알 필요가 없는 값을 번들에 넣으면
 * 운영 도메인으로 옮길 때마다 프런트를 다시 빌드해야 하는 이유만 늘어난다.
 *
 * 로컬 개발에서는 vite.config.ts 의 프록시가 `/api` 를 배포된 주소로 넘긴다. 그래서 개발
 * 모드에서도 코드 경로는 운영과 완전히 같다.
 */

/** 화면에 노출되는 서비스 이름. 프로젝트 코드네임(NEOTMS)은 UI 에 쓰지 않는다. */
export const SERVICE_ORG_NAME = '라이온코리아'
export const SERVICE_PRODUCT_NAME = 'TMS 시스템'
export const SERVICE_FULL_NAME = `${SERVICE_ORG_NAME} ${SERVICE_PRODUCT_NAME}`

/**
 * 권한이 부여되는 메뉴 ID.
 *
 * 백엔드 lambdas/neotms/nodejs/neotms/NeotmsMenus.ts 의 `NeotmsMenu` 와 **같은 값이어야 한다.**
 * 어긋나면 그 메뉴는 사이드바에서 조용히 사라진다 — 서버는 아무 오류도 내지 않고, 사용자는
 * "권한을 줬는데 메뉴가 없다"고 말하게 된다.
 *
 * 백엔드 주석대로 이 값들은 아직 레거시 SY_MENU 와 대조되지 않았다. 대조 전에는 권한 판정이
 * 전부 닫힌 쪽으로 실패하므로, 사이드바가 비어 버릴 수 있다 — NeotmsApp 이 그 경우를 빈 화면이
 * 아니라 설명으로 처리한다.
 */
export const NeotmsMenuId = {
  CUSTOMER: 'CUSTOMER',
  PROJECT: 'PROJECT',
  JOB: 'JOB',
  PURCHASE_ORDER: 'PURCHASE_ORDER',
  TRANSLATOR: 'TRANSLATOR',
  REPORT: 'REPORT',
  /**
   * 유지보수 — 코드 테이블(`sys_code`) 관리.
   *
   * 드롭다운을 **읽는** 권한과 코드 목록을 **정하는** 권한을 나눈 것이다. 읽기는 모든 직원에게
   * 열려 있고(`GET /api/v0/codes`), 이 메뉴는 분야 분류 체계를 누가 결정하는지에 대한 것이다.
   */
  MAINTENANCE: 'MAINTENANCE',
  /**
   * 사용자 관리 — 직원 목록과 역할 배정.
   *
   * 이 메뉴의 쓰기만이 **다른 모든 메뉴의 권한을 바꾼다**(`staff.role_id`). 그래서 이것도 그냥
   * 하나의 메뉴다 — "슈퍼유저면 된다" 를 코드에 박아 두면 그 권한은 아무 표에도 나타나지 않고,
   * 회수할 방법도 감사할 방법도 없다.
   */
  STAFF: 'STAFF',
} as const

export type NeotmsMenuIdValue = (typeof NeotmsMenuId)[keyof typeof NeotmsMenuId]

/**
 * 목록 한 페이지의 기본 건수.
 *
 * 서버의 상한은 200 이다(`NEOTMS_PAGE_SIZE_MAX`). 상한까지 쓰지 않는 이유는 용량 고정인 소형
 * DB 인스턴스에서 한 번의 응답 시간이 길어지는 것보다 '더 보기' 를 한 번 더 누르는 것이 낫기
 * 때문이다 — 담당자는 보통 첫 화면에서 찾던 행을 찾는다.
 */
export const LIST_PAGE_SIZE = 50

/**
 * 상세 화면에서 자식 목록을 읽을 때의 건수.
 *
 * 프로젝트 상세는 소속 작업·발주의 **합계**를 보여 준다. 합계가 맞으려면 가능한 한 한 번에
 * 다 읽혀야 한다 — 페이지가 나뉘면 화면의 합계는 "읽어 온 만큼의 합" 이 되고, 그 사실을
 * 화면에 써 두더라도 사용자는 그 숫자를 전체 합계로 읽는다. 그래서 목록보다 크게 잡는다.
 */
export const DETAIL_PAGE_SIZE = 200
