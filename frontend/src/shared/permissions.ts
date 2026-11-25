import type { ProfileView } from '@/apis/neotms.types'
import {
  NEOTMS_PERMISSION_CUSTOMER_READ,
  NEOTMS_PERMISSION_DASHBOARD_PM_READ,
  NEOTMS_PERMISSION_WORKSPACE_READ,
  NEOTMS_PERMISSION_DASHBOARD_SALES_READ,
  NEOTMS_PERMISSION_INVOICE_READ,
  NEOTMS_PERMISSION_JOB_READ,
  NEOTMS_PERMISSION_MAINTENANCE_READ,
  NEOTMS_PERMISSION_PO_READ,
  NEOTMS_PERMISSION_PROJECT_READ,
  NEOTMS_PERMISSION_REPORT_READ,
  NEOTMS_PERMISSION_STAFF_READ,
  NEOTMS_USER_ATTRIBUTE_SUPERUSER,
  NEOTMS_PERMISSION_TRANSLATOR_READ,
} from '@/apis/neotms.authorities'
import { NeotmsMenuId, type NeotmsMenuIdValue } from '@/shared/config'
import type { IconName } from '@/shared/ui/Icon'

/**
 * 메뉴 권한을 읽는 곳.
 *
 * 셸(NeotmsApp)에 두지 않고 따로 뺀 이유는 의존 방향이다. 버튼을 가리는 화면이 일곱 개이므로,
 * 셸에 두면 모든 목록 화면이 셸 모듈을 import 하게 된다 — 지금은 순환이 아니지만, 셸이 나중에
 * 화면 하나를 직접 참조하는 순간(예: 공통 헤더에 알림 뱃지) 순환이 된다. 그때 생기는 오류는
 * `undefined is not a function` 이고, 원인을 찾는 데 한참 걸린다.
 */

/**
 * 메뉴가 속한 묶음.
 *
 * 설계안의 좌측은 두 단(아이콘 레일 + 2차 패널)이고, 레일 항목 하나가 이 묶음 하나다. 묶음을
 * 둔 이유는 모양을 맞추기 위해서가 아니라 메뉴 여덟 개가 **성격이 네 가지**이기 때문이다 —
 * 매일 여는 업무 화면, 거래처 정보, 가끔 보는 집계, 한 달에 한 번 쓰는 관리. 여덟 개를 한 줄로
 * 세우면 그 차이가 사라지고, 담당자는 매번 같은 목록을 처음부터 훑는다.
 */
export type NeotmsNavGroupId =
  | 'dashboard'
  | 'sheet'
  | 'work'
  | 'party'
  | 'insight'
  | 'admin'
  | 'trn'
  | 'payment'
  | 'me'

/**
 * 권한 이름 자리에 쓰는 표식 — "등록된 직원이면 누구나".
 *
 * 메뉴 하나가 이것을 쓴다(내 정보). 다른 메뉴는 모두 회사 데이터를 보여 주므로 "누가 볼 수
 * 있는가" 를 누군가 정해야 하지만, 자기 설정 화면에 권한을 걸면 뜻이 뒤집힌다 — 자기 비밀번호에
 * 접근할 권리를 빼앗는 장치가 되고, 새로 만든 역할은 그 화면에 들어갈 수 없는데 이유가 어디에도
 * 적히지 않는다. 서버도 같은 판단을 한다(`anyStaff` 라우트).
 *
 * **값이 비어 있지 않은 것이 중요하다.** `readPermission` 을 선택 항목으로 만들면 "게이트가
 * 아예 없는 항목" 을 표현할 수 있게 되고, 그건 실수로 만들어지는 쪽이다. 이 표식은 게이트가
 * 없다는 뜻이 아니라 **게이트가 등록 여부**라는 뜻이고, 그 차이가 `readableNav` 에 그대로
 * 적혀 있다.
 *
 * `'*'` 로 시작하므로 어떤 권한 이름과도 겹치지 않는다 — 실제 권한은 모두
 * `NEOTMS_PERMISSION_…` 이다.
 */
export const NEOTMS_NAV_ANY_STAFF = '*anyStaff' as const

/**
 * One sidebar entry. `readPermission` is what the server grants and what decides whether this
 * entry appears; `path` is the router's path. `menuId` is only the id the screen is known by --
 * see the field comments below, which is where the two used to be the same thing.
 */
export interface NeotmsNavItem {
  /**
   * Still here, and still the id the screen is known by - but it no longer decides anything.
   * Permissions are granted by name now, so visibility reads `readPermission` below.
   */
  menuId: NeotmsMenuIdValue
  /**
   * Holding this is what makes the entry appear. One permission, not a menu plus an action.
   *
   * Or `NEOTMS_NAV_ANY_STAFF`, for the one entry whose gate is "is registered staff" rather than a
   * grant - see that constant. It is a value in this field rather than a separate optional flag so
   * that every entry still has to say what its gate is.
   */
  readPermission: string | typeof NEOTMS_NAV_ANY_STAFF
  /**
   * Set when the entry is for superusers only, and no permission can stand in for it.
   *
   * One entry carries it: 역할 관리, which edits what a role permits. A permission-shaped gate
   * there would be editable through the screen it gates, so `readableNav` asks for the attribute
   * instead — and `readPermission` is still required on the type, so an entry cannot accidentally
   * have no gate at all.
   */
  superuserOnly?: true
  path: string
  label: string
  /** 2차 패널에서 메뉴 이름 아래에 한 줄로 붙는다. 비워 두지 않는다 — 아래 주석 참고. */
  hint: string
  group: NeotmsNavGroupId
}

/**
 * 레일에 서는 묶음. 순서가 곧 레일의 위아래 순서다.
 *
 * `icon` 은 `shared/ui/Icon.tsx` 의 이름이고 타입이 맞춰져 있으므로, 없는 아이콘을 적으면
 * 빈 자리가 아니라 **타입 오류**가 난다.
 */
export interface NeotmsNavGroup {
  id: NeotmsNavGroupId
  label: string
  icon: IconName
}

export const NEOTMS_NAV_GROUPS: readonly NeotmsNavGroup[] = [
  /*
   * 대시보드가 맨 앞이다. 두 가지 이유가 같은 방향을 가리킨다.
   *
   * **첫 화면이 된다.** `routes.tsx` 의 `HomeRedirect` 는 `readableNav(profile)[0]` 로 보낸다.
   * 그러므로 이 묶음이 맨 앞이면 로그인 직후 보이는 것이 자기 대시보드다 — 집계 화면은 들어와야
   * 보이는 순간부터 아무도 보지 않는다.
   *
   * 이 자리는 두 대시보드가 메뉴 권한을 **하나씩** 갖게 된 뒤에야 맞는 자리가 되었다. 둘 다
   * PROJECT 에 걸려 있던 동안에는 모든 계정의 첫 화면이 **대시보드(영업)** 가 되고, PM 만 하는
   * 담당자는 로그인할 때마다 0 이 네 칸 찍힌 화면을 먼저 봤다 — 그 0 은 사실이지만 고장으로
   * 읽힌다. 이제 그 담당자의 `readableNav[0]` 은 대시보드(PM) 이므로, 맨 앞이 각자에게 맞는
   * 화면을 뜻한다.
   */
  { id: 'dashboard', label: '대시보드', icon: 'grid' },
  /*
   * 업무 워크시트가 '업무' 와 따로 선 이유.
   *
   * 묶음은 모양이 아니라 **성격**으로 나눈다(이 배열 머리의 주석). 프로젝트·작업·PO 는 한 건을
   * 열어 고치는 화면이고, 워크시트는 **여러 건을 한 장에 펼쳐 놓고** 훑으며 고치는 화면이다 —
   * 쓰는 방식도, 한 번에 보는 양도, 여는 빈도도 다르다. 같은 묶음에 넣으면 목록 셋 뒤에 끼어
   * 네 번째 항목이 되고, 매일 여는 화면이 매일 세 번 지나쳐야 하는 자리에 놓인다.
   *
   * 묶음이 항목 하나로 시작하는 것은 일시적이다. 같은 틀(칸 꾸밈, 추가 열, 끌어 옮기는 열)을
   * 쓰는 다른 시트가 이 아래로 들어올 예정이고, 그때 이 자리가 그대로 늘어난다 — 나중에 묶음을
   * 만들면 그날 모든 사람의 레일에서 메뉴가 한 칸씩 움직인다.
   */
  { id: 'sheet', label: '업무 워크시트', icon: 'table' },
  { id: 'work', label: '업무', icon: 'folder' },
  { id: 'party', label: '고객', icon: 'users' },
  { id: 'trn', label: '번역가', icon: 'globe' },
  /*
   * 결제가 '업무' 와 따로 선 이유.
   *
   * 묶음은 모양이 아니라 **성격**으로 나눈다(이 배열 머리의 주석). 프로젝트·작업·PO는 담당자가
   * 하루에 여러 번 여는 업무 화면이고, 결제는 **다른 사람이** 다른 때에 여는 화면이다 — 금액을
   * 승인하고 입금을 확인하는 일이다. 같은 묶음에 넣으면 그 차이가 레일에서 사라지고, PO를
   * 올리는 담당자는 자기가 쓰지 않는 탭을 매일 지나치게 된다.
   *
   * 권한도 실제로 다르다. `PAYMENT` 는 `PURCHASE_ORDER` 와 별개의 메뉴이고, 두 권한을 같은
   * 사람에게 주지 않는 것이 승인 절차가 형식이 되지 않게 하는 장치다(shared/config.ts).
   */
  { id: 'payment', label: '결제', icon: 'cart' },
  { id: 'insight', label: '리포트', icon: 'chart' },
  { id: 'admin', label: '운영관리', icon: 'gear' },
  /*
   * 내 정보가 **맨 끝**인 이유는 자리가 아니라 첫 화면 때문이다.
   *
   * 이 묶음은 모든 계정에 보이는 유일한 묶음이다(`NEOTMS_NAV_ANY_STAFF`). `HomeRedirect` 는
   * `readableNav(profile)[0]` 로 보내므로, 이 항목이 배열 앞에 있으면 **모든 사람의 로그인 직후
   * 첫 화면이 자기 설정**이 된다 — 아무도 매일 열려고 하지 않는 화면이다. 그래서 `NEOTMS_NAV`
   * 에서도 맨 끝이고, 두 배열 모두에서 끝이어야 한다(레일 순서는 이 배열, 첫 화면은 그 배열).
   *
   * 역설적으로, 권한이 하나도 없는 계정에게는 이것이 첫 화면이 된다. 그 경우에는 그게 맞다 —
   * 대안은 빈 화면이다.
   */
  { id: 'me', label: '내 정보', icon: 'user' },
]

/*
 * `hint` 가 선택 항목이 아닌 이유.
 *
 * 2차 패널은 메뉴 이름만 적어도 동작한다. 그런데 이 시스템의 이름들은 서로 구분이 잘 되지
 * 않는다 — '프로젝트' 와 '작업' 과 'PO' 는 셋 다 "일" 이고, 어느 것이 고객에게서 받은
 * 일이고 어느 것이 번역가에게 내보내는 일인지는 이름만으로 알 수 없다. 레거시에서 신입
 * 담당자가 가장 많이 헤맨 지점이 정확히 여기다. 그래서 한 줄 설명을 필수 항목으로 두고,
 * 새 메뉴를 추가하는 사람이 "이건 무엇인가" 를 한 번은 적게 만든다.
 */
export const NEOTMS_NAV: readonly NeotmsNavItem[] = [
  /*
   * 대시보드 둘. 세 가지가 설명이 필요하다.
   *
   * **왜 메뉴가 둘인가.** 요구가 "각자 자기 직책에 맞는 쪽만 본다" 이고, 메뉴 하나로는 그 말을
   * 할 수 없다. `DASHBOARD` 하나로 묶으면 권한은 둘 다이거나 둘 다 아니거나이므로, PM 에게
   * 주면 영업 화면까지 열리고 주지 않으면 PM 화면도 사라진다. 메뉴를 둘로 두면 `sys_role_auth`
   * 가 화면별로 부여되고, 시스템 담당자는 둘 다 갖는다. 권한 배정 자체는 사용자 관리 화면에서
   * 하고 여기서는 아무것도 정하지 않는다.
   *
   * 이것은 권한이 넓어진 것이 아니다. 두 화면이 보여 주는 것은 전부 내 프로젝트와 그에 달린
   * 작업·PO의 합계이고, 프로젝트 상세 화면이 이미 한 건씩 같은 값을 적는다. REPORT 로 걸면
   * 오히려 넓어진다(REPORT 는 남의 실적까지 본다) — 내 숫자를 보는 것이 특권이 되어서는 안 된다.
   *
   * **왜 맨 앞인가.** `NEOTMS_NAV_GROUPS` 의 'dashboard' 주석에 있다. 요약하면 `HomeRedirect`
   * 가 `readableNav(profile)[0]` 로 보내므로, 이 순서가 곧 로그인 직후의 첫 화면이다. 묶음만
   * 앞으로 보내도 레일의 순서는 바뀌지만 **첫 화면은 바뀌지 않는다** — `readableNav` 는 묶음이
   * 아니라 이 배열의 순서를 따르기 때문이고, 그래서 두 항목이 여기서도 맨 앞에 있어야 한다.
   *
   * **왜 둘 다 보일 수 있는가.** `staff` 에는 '이 사람은 영업' 이라는 칼럼이 없다 — 영업이냐
   * PM 이냐는 **프로젝트마다** 정해진다(`prj_mgr_id` / `prj_pm_id`). 한 사람이 어떤 프로젝트에서는
   * 영업이고 다른 프로젝트에서는 PM 일 수 있고, 그런 사람에게는 두 메뉴를 다 주는 것이 맞다.
   * 그래서 두 `hint` 가 '내 것' 의 기준을 각각 명시한다 — 한 화면만 받은 사람은 그 기준을 볼
   * 기회가 한 번뿐이다.
   */
  {
    menuId: NeotmsMenuId.DASHBOARD_SALES,
    readPermission: NEOTMS_PERMISSION_DASHBOARD_SALES_READ,
    path: '/dashboard/sales',
    label: '대시보드(영업)',
    hint: '영업 담당자용 대시보드',
    group: 'dashboard',
  },
  {
    menuId: NeotmsMenuId.DASHBOARD_PM,
    readPermission: NEOTMS_PERMISSION_DASHBOARD_PM_READ,
    path: '/dashboard/pm',
    label: '대시보드(PM)',
    hint: 'PM용 대시보드',
    group: 'dashboard',
  },
  /*
   * 나의 업무 — 지금은 워크시트 묶음의 **유일한** 항목이고, 그래서 레일에서 이 항목을 누르면
   * 2차 패널에 하나만 선다. 그 모양이 어색해 보여도 묶음을 미리 만드는 쪽이 맞다: 나중에
   * 만들면 그날 모든 사람의 레일에서 메뉴가 한 칸씩 움직이고, 익숙해진 자리를 다시 익혀야 한다.
   *
   * 배열에서의 **자리는 그대로 둔다**(대시보드 바로 다음). `readableNav` 가 묶음이 아니라 이
   * 배열의 순서를 따르므로(`NEOTMS_NAV_GROUPS` 의 주석), 여기를 옮기면 워크시트 권한만 가진
   * 사람의 로그인 직후 첫 화면이 바뀐다 — 이번 변경은 레일의 자리에 대한 것이지 첫 화면에
   * 대한 것이 아니다.
   */
  {
    menuId: NeotmsMenuId.WORKSPACE,
    readPermission: NEOTMS_PERMISSION_WORKSPACE_READ,
    path: '/workspace',
    label: '나의 업무',
    hint: '내가 수락한 프로젝트의 PO를 한 장의 시트에서',
    group: 'sheet',
  },
  {
    menuId: NeotmsMenuId.PROJECT,
    readPermission: NEOTMS_PERMISSION_PROJECT_READ,
    path: '/projects',
    label: '프로젝트',
    hint: '번역·MICE 등 프로젝트 관리',
    group: 'work',
  },
  {
    menuId: NeotmsMenuId.JOB,
    readPermission: NEOTMS_PERMISSION_JOB_READ,
    path: '/jobs',
    label: '작업',
    hint: '프로젝트 작업(JOB)목록',
    group: 'work',
  },
  {
    menuId: NeotmsMenuId.PURCHASE_ORDER,
    readPermission: NEOTMS_PERMISSION_PO_READ,
    path: '/purchase-orders',
    label: 'PO',
    hint: 'PO목록 조회',
    group: 'work',
  },
  {
    menuId: NeotmsMenuId.CUSTOMER,
    readPermission: NEOTMS_PERMISSION_CUSTOMER_READ,
    path: '/customers',
    label: '고객사',
    hint: '고객사 목록 및 정보 조회',
    group: 'party',
  },
  {
    menuId: NeotmsMenuId.TRANSLATOR,
    readPermission: NEOTMS_PERMISSION_TRANSLATOR_READ,
    path: '/translators',
    label: '번역가',
    hint: '언어·분야·단가',
    group: 'trn',
  },
  /*
   * 결제. **메뉴 둘, 권한 하나.**
   *
   * 화면이 둘인 이유는 두 화면이 서로 다른 질문에 답하기 때문이다. PO 화면은 "이 기간에 마감되는
   * PO의 금액이 결재됐고 지급됐는가" 를 묻고, 인보이스 화면은 "이 번역가에게 보낸 청구서가
   * 입금됐는가" 를 묻는다. 한 화면의 두 탭으로 두면 두 질문의 **필터가 한 주소를 공유**하고,
   * 그래서 "인보이스 조건이 걸린 PO 화면" 이 링크로 공유될 수 있다. 메뉴를 둘로 나누면 주소
   * 하나가 화면 하나를 가리킨다.
   *
   * **그런데 `menuId` 는 하나다.** 이 두 줄은 같은 `PAYMENT` 권한을 공유한다 — `readableNav` 가
   * 항목별로 같은 메뉴를 보므로 둘은 **함께** 보이거나 함께 사라진다. 메뉴 아이디를 둘로 쪼개면
   * `sys_menu` 행을 하나 더 넣는 마이그레이션과 `sys_role_grant_all_menus` 재부여가 또 필요하고
   * (db/008·013·015 의 같은 경고), 얻는 것은 "승인은 되는데 인보이스는 안 되는" 역할인데 그
   * 구분은 이미 다섯 동작이 하고 있다 — `update` 가 PO 승인과 입금, `create` 가 인보이스 발행,
   * `delete` 가 인보이스 취소다(shared/config.ts 의 PAYMENT 항목).
   *
   * 다른 메뉴들처럼 이 줄만으로는 탭이 보이지 않는다. `sys_menu` 에 행이 있어야 `GET /api/v0/me`
   * 의 응답에 들어오고 그 행은 db/015_payment.sql 이 넣는다 — 적용하지 않으면 탭이 없고, 주소를
   * 직접 열면 403 이며, 어디에도 이유가 적히지 않는다.
   *
   * 경로가 `/payment/…` 로 한 겹 들어가 있는 것은 `activeNavItem` 때문이 아니라(그 함수는 긴
   * 경로를 먼저 보므로 어느 쪽이든 맞는다) 두 화면이 한 묶음이라는 사실을 주소가 말하게 하려는
   * 것이다. `/payment` 자체는 메뉴가 아니고 라우터에서 첫 화면으로 넘긴다(routes.tsx).
   */
  {
    menuId: NeotmsMenuId.PAYMENT,
    readPermission: NEOTMS_PERMISSION_INVOICE_READ,
    path: '/payment/purchase-orders',
    label: 'PO 승인·정산',
    hint: 'PO 금액 승인과 지급 기록',
    group: 'payment',
  },
  {
    menuId: NeotmsMenuId.PAYMENT,
    readPermission: NEOTMS_PERMISSION_INVOICE_READ,
    path: '/payment/invoices',
    label: '번역가 인보이스',
    hint: '인보이스 발행·입금 기록',
    group: 'payment',
  },
  {
    menuId: NeotmsMenuId.REPORT,
    readPermission: NEOTMS_PERMISSION_REPORT_READ,
    path: '/reports',
    label: '보고서',
    hint: '기간별 매출과 수익',
    group: 'insight',
  },
  /*
   * 관리 메뉴 둘은 맨 끝이다. 매일 쓰는 메뉴의 자리가 한 달에 한 번 쓰는 메뉴 때문에 밀리면
   * 안 되기 때문이고, db/008_admin.sql 의 `ord_no` 7·8 과도 같은 순서다.
   *
   * 이 두 줄만으로는 탭이 보이지 않는다. 메뉴는 `sys_menu` 행이 있어야 `GET /api/v0/me` 의
   * 응답에 들어오고, 그 행은 db/008_admin.sql 이 넣는다 — 적용하지 않으면 탭이 없고, 주소를
   * 직접 열면 403 이며, 어디에도 이유가 적히지 않는다.
   */
  {
    menuId: NeotmsMenuId.MAINTENANCE,
    readPermission: NEOTMS_PERMISSION_MAINTENANCE_READ,
    path: '/maintenance',
    label: '각종 코드 및 변수 관리',
    hint: '분야·언어 등',
    group: 'admin',
  },
  {
    menuId: NeotmsMenuId.STAFF,
    readPermission: NEOTMS_PERMISSION_STAFF_READ,
    path: '/staff',
    label: '사용자 관리',
    hint: '가입 승인·역할 배정',
    group: 'admin',
  },
  /*
   * 역할 관리. 사용자 관리와 **다른 메뉴**인 이유가 이 앱의 권한 설계 그 자체다.
   *
   * 사용자 관리는 "이 사람에게 어떤 역할을 줄까" 를 정하고, 이 화면은 "그 역할이 무엇을
   * 뜻하는지" 를 정한다. 영향 범위가 다르다 — 앞의 것은 한 사람을, 뒤의 것은 그 역할을 가진
   * 모든 사람을 한 번에 바꾼다. 한 화면에 두 탭으로 넣으면 그 차이가 사라지고, '역할 배정'
   * 권한만 가진 관리자에게 누르면 403 이 나는 탭이 보인다.
   *
   * **`menuId` 는 STAFF 를 재사용한다.** 새 `sys_menu` 행을 넣지 않는다 — 이 항목은 메뉴 권한이
   * 아니라 `superuserOnly` 로 걸러지므로 서버가 내려주는 메뉴 목록에 들어갈 이유가 없고, 행을
   * 하나 넣으면 마이그레이션과 재부여가 따라붙는다(db/003_access_control.sql 의 같은 경고).
   * `menuId` 는 이제 아무것도 결정하지 않는 식별자일 뿐이다 — `NeotmsNavItem` 의 주석 참고.
   *
   * `readPermission` 도 STAFF_READ 로 둔다. 타입이 요구하므로 비울 수 없고, 비워 둘 수 있게
   * 만들면 "게이트가 아예 없는 항목" 이 표현 가능해진다. 시스템관리자는 모든 권한 검사를
   * 통과하므로 이 값은 실질적으로 쓰이지 않지만, 둘 다 통과해야 보이게 두는 쪽이 안전하다.
   */
  {
    menuId: NeotmsMenuId.STAFF,
    readPermission: NEOTMS_PERMISSION_STAFF_READ,
    superuserOnly: true,
    path: '/roles',
    label: '역할 관리',
    hint: '역할별 권한 설정',
    group: 'admin',
  },
  /*
   * 내 정보 — **권한이 아니라 등록 여부로 보이는 유일한 항목**이다.
   *
   * 이유는 `NEOTMS_NAV_ANY_STAFF` 에 적어 두었다. 요약하면, 이 화면이 보여 주는 것은 회사
   * 데이터가 아니라 **보는 사람 자신의 설정**이고, 거기에 권한을 걸면 "자기 비밀번호에 접근할
   * 권리" 를 누군가 부여하는 모양이 된다.
   *
   * **배열의 맨 끝이어야 한다.** `readableNav` 는 묶음이 아니라 이 배열의 순서를 따르고,
   * `HomeRedirect` 는 그 첫 항목으로 보낸다. 모든 계정에 보이는 항목이므로 앞에 두면 모두의 첫
   * 화면이 자기 설정이 된다. 새 항목을 추가할 때 이 줄 **위에** 넣어야 하는 이유다.
   */
  {
    menuId: NeotmsMenuId.MY_INFO,
    readPermission: NEOTMS_NAV_ANY_STAFF,
    path: '/me',
    label: '내 정보',
    hint: 'Hiworks 계정 등 내 설정',
    group: 'me',
  },
]

/**
 * 이 메뉴에 대해 이 동작이 허용되는지.
 *
 * 메뉴가 응답에 아예 없을 때도 false 다. 서버의 `hasPermission` 과 같은 방향으로 실패해야
 * 한다 — 모르는 메뉴를 "허용" 으로 해석하면 화면은 버튼을 보여 주고 서버는 403 을 주므로,
 * 사용자는 저장이 안 되는 이유를 알 수 없다.
 *
 * 프로필이 아직 없을 때(`undefined`) 도 false 다. 그래서 목록 화면은 프로필을 기다리는 동안
 * 등록 버튼을 그리지 않는다 — 누를 수 없는 버튼을 먼저 보여 주는 것보다 낫다.
 */
export function may(profile: ProfileView | undefined, permission: string): boolean {
  return profile?.permissions.includes(permission) ?? false
}

/**
 * Whether this person holds an attribute - what they may be NAMED as.
 *
 * Separate from `may` because it answers a different question. Nothing here opens a screen;
 * `NEOTMS_USER_ATTRIBUTE_PM` is what lets somebody else put this person's name in a project's
 * 담당PM column.
 */
export function hasAttribute(
  profile: ProfileView | undefined,
  attribute: string,
): boolean {
  return profile?.attributes.includes(attribute) ?? false
}


/** 읽을 수 있는 메뉴만. 순서는 NEOTMS_NAV 가 정한다(서버의 `ordNo` 는 레거시 값이라 신뢰하지 않는다). */
export function readableNav(profile: ProfileView | undefined): readonly NeotmsNavItem[] {
  return NEOTMS_NAV.filter(
    (item) =>
      // 등록이 끝난 직원이면 누구나 보는 항목(내 정보 하나). `registration === 'active'` 로 보는
      // 이유는 가입 대기 중인 사람에게는 아직 저장할 staff 행이 없기 때문이다 — 서버의
      // `anyStaff` 도 같은 것을 본다.
      (item.readPermission === NEOTMS_NAV_ANY_STAFF
        ? profile?.registration === 'active'
        : may(profile, item.readPermission)) &&
      // `superuserOnly` 항목은 권한을 통과해도 속성이 없으면 보이지 않는다. 시스템관리자는
      // 모든 권한 검사를 통과하므로 실제로는 이 조건이 혼자 결정하지만, 두 조건을 모두 보게
      // 두면 `superuserOnly` 를 빼먹은 항목이 권한만으로 열리는 쪽으로 실수하게 된다.
      (!item.superuserOnly || hasAttribute(profile, NEOTMS_USER_ATTRIBUTE_SUPERUSER)),
  )
}

/** 레일에 그릴 묶음과 그 안의 메뉴. */
export interface ReadableNavGroup extends NeotmsNavGroup {
  items: readonly NeotmsNavItem[]
}

/**
 * 읽을 수 있는 메뉴를 묶음별로 모은다.
 *
 * **빈 묶음은 돌려주지 않는다.** 역할에 따라 한 묶음의 메뉴가 전부 막힐 수 있고(번역가 관리만
 * 하는 계정에게 '관리' 가 그렇다), 그때 레일에 눌러도 아무 데도 가지 않는 아이콘이 남으면
 * 그건 고장으로 읽힌다. 권한이 없다는 사실은 메뉴를 **없애서** 알리는 것이 이 앱의 기존
 * 방식이고(`readableNav`), 레일도 같아야 한다.
 */
export function readableNavGroups(profile: ProfileView | undefined): readonly ReadableNavGroup[] {
  const readable = readableNav(profile)
  return NEOTMS_NAV_GROUPS.map((group) => ({
    ...group,
    items: readable.filter((item) => item.group === group.id),
  })).filter((group) => group.items.length > 0)
}

/**
 * 지금 경로가 속한 메뉴.
 *
 * `startsWith` 로 찾는 이유는 상세 화면 때문이다 — `/projects/123` 은 그 자체로는 메뉴가
 * 아니지만 '프로젝트' 메뉴 안에 있고, 레일과 패널의 강조는 거기서도 켜져 있어야 한다.
 * 정확히 일치만 보면 상세로 들어가는 순간 좌측이 통째로 꺼져서, 담당자는 자기가 어디에
 * 있는지 알 수 없게 된다.
 *
 * 긴 경로를 먼저 보도록 정렬한 뒤 찾는다. 지금은 한 경로가 다른 경로의 접두사인 경우가
 * 없지만(`/projects` 와 `/purchase-orders` 는 겹치지 않는다), 나중에 `/jobs` 와 `/jobs-draft`
 * 같은 쌍이 생기면 짧은 쪽이 먼저 걸려서 엉뚱한 메뉴가 강조된다.
 */
export function activeNavItem(
  profile: ProfileView | undefined,
  pathname: string,
): NeotmsNavItem | undefined {
  return [...readableNav(profile)]
    .sort((a, b) => b.path.length - a.path.length)
    .find((item) => pathname === item.path || pathname.startsWith(`${item.path}/`))
}
