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
export const SERVICE_PRODUCT_NAME = 'neoTMS'
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
  /**
   * 대시보드(영업) — 영업담당자가 나인 프로젝트의 집계.
   *
   * 두 대시보드가 메뉴를 **하나씩** 갖는다. 하나로 묶으면 "자기 직책에 맞는 쪽만 보인다" 를
   * 표현할 수 없기 때문이다 — 묶인 권한을 주면 둘 다 보이고, 주지 않으면 정작 필요한 쪽도
   * 사라진다. 둘로 나누면 PM 에게는 PM 쪽만, 영업담당자에게는 영업 쪽만 주고, 시스템 담당자가
   * 둘 다 갖는다.
   *
   * 권한이 넓어진 것이 아니다. 두 화면의 모든 숫자는 내 프로젝트·작업·발주의 합이고, 프로젝트
   * 상세 화면이 이미 한 건씩 보여 주는 값이다. 메뉴를 나눈 것은 권한의 **의미**를 좁힌 것이고,
   * 볼 수 있는 것을 넓힌 것이 아니다.
   *
   * `sys_menu` 에 행이 없으면 탭이 없고 주소를 직접 열면 403 이며 그 사실이 어디에도 적히지
   * 않는다 — 그 행은 db/013_dashboard_menus.sql 이 넣는다.
   */
  DASHBOARD_SALES: 'DASHBOARD_SALES',
  /** 대시보드(PM) — PM 이 나인 프로젝트의 집계. 위 DASHBOARD_SALES 주석 참고. */
  DASHBOARD_PM: 'DASHBOARD_PM',
  /**
   * 결제 — PO 금액 승인과 정산, 그리고 번역가 인보이스.
   *
   * PO 를 **올리는** 권한(`PURCHASE_ORDER`)과 그 금액을 **승인하는** 권한을 나눈 것이다. 같은
   * 메뉴에 두면 PO 를 올릴 수 있는 사람이 자기 PO 를 스스로 승인할 수 있고, 그것은 승인
   * 절차가 아니라 형식일 뿐이다. 그래서 `purchase_order.po_approved` 는 이 메뉴를 통해서만
   * 바뀌며, 승인되지 않은 PO 는 출력도 발송도 되지 않는다.
   *
   * 다섯 가지 동작의 뜻: `read` 는 결제 화면과 출력용 PO 문서·인보이스, `update` 는 PO 승인과
   * 입금 기록, `create` 는 인보이스 발행, `delete` 는 인보이스 취소. PO 의 금액 자체를 고치는
   * 것은 여전히 `PURCHASE_ORDER` 쪽이다 — 승인할 수 있는 사람이 금액을 바꿀 수 있는 사람이
   * 되지는 않는다.
   *
   * **메뉴는 둘, 권한은 하나다.** 화면이 `/payment/purchase-orders` 와 `/payment/invoices` 로
   * 갈라져 있지만 둘 다 이 id 를 쓴다 — 나누는 것은 위 다섯 동작이 이미 하고 있다
   * (`shared/permissions.ts` 의 `payment` 그룹 주석).
   *
   * `sys_menu` 행이 없으면 DASHBOARD_SALES 와 같은 방식으로 조용히 사라진다 — 그 행은
   * db/015_payment.sql 이 넣는다.
   */
  PAYMENT: 'PAYMENT',
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
