import type { MenuAction, ProfileView } from '@/apis/neotms.types'
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
export type NeotmsNavGroupId = 'dashboard' | 'work' | 'party' | 'insight' | 'admin' | 'trn'

/** 사이드바 메뉴. `menuId` 는 서버가 권한을 부여하는 단위이고, `path` 는 라우터의 경로다. */
export interface NeotmsNavItem {
  menuId: NeotmsMenuIdValue
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
  { id: 'work', label: '업무', icon: 'folder' },
  { id: 'party', label: '고객', icon: 'users' },
  { id: 'trn', label: '번역가', icon: 'globe' },
//  { id: 'payment', label: '결제', icon: 'cart' },
  { id: 'insight', label: '리포트', icon: 'chart' },
  { id: 'admin', label: '운영관리', icon: 'gear' },
]

/*
 * `hint` 가 선택 항목이 아닌 이유.
 *
 * 2차 패널은 메뉴 이름만 적어도 동작한다. 그런데 이 시스템의 이름들은 서로 구분이 잘 되지
 * 않는다 — '프로젝트' 와 '작업' 과 '발주' 는 셋 다 "일" 이고, 어느 것이 고객에게서 받은
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
   * 작업·발주의 합계이고, 프로젝트 상세 화면이 이미 한 건씩 같은 값을 적는다. REPORT 로 걸면
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
    path: '/dashboard/sales',
    label: '대시보드(영업)',
    hint: '영업담당자가 나인 프로젝트 현황',
    group: 'dashboard',
  },
  {
    menuId: NeotmsMenuId.DASHBOARD_PM,
    path: '/dashboard/pm',
    label: '대시보드(PM)',
    hint: 'PM 이 나인 프로젝트 현황',
    group: 'dashboard',
  },
  {
    menuId: NeotmsMenuId.PROJECT,
    path: '/projects',
    label: '프로젝트',
    hint: '번역·MICE 등 프로젝트 관리',
    group: 'work',
  },
  {
    menuId: NeotmsMenuId.JOB,
    path: '/jobs',
    label: '작업',
    hint: '프로젝트 작업(JOB)목록',
    group: 'work',
  },
  {
    menuId: NeotmsMenuId.PURCHASE_ORDER,
    path: '/purchase-orders',
    label: 'PO',
    hint: 'PO목록 조회',
    group: 'work',
  },
  {
    menuId: NeotmsMenuId.CUSTOMER,
    path: '/customers',
    label: '고객사',
    hint: '고객사 목록 및 정보 조회',
    group: 'party',
  },
  {
    menuId: NeotmsMenuId.TRANSLATOR,
    path: '/translators',
    label: '번역가',
    hint: '언어·분야·단가',
    group: 'trn',
  },
  {
    menuId: NeotmsMenuId.REPORT,
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
    path: '/maintenance',
    label: '각종 코드 및 변수 관리',
    hint: '분야·언어 등',
    group: 'admin',
  },
  {
    menuId: NeotmsMenuId.STAFF,
    path: '/staff',
    label: '사용자 관리',
    hint: '가입 승인·권한 관리',
    group: 'admin',
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
export function mayDo(
  profile: ProfileView | undefined,
  menuId: NeotmsMenuIdValue,
  action: MenuAction,
): boolean {
  return profile?.menus.find((m) => m.menuId === menuId)?.may[action] ?? false
}

/** 읽을 수 있는 메뉴만. 순서는 NEOTMS_NAV 가 정한다(서버의 `ordNo` 는 레거시 값이라 신뢰하지 않는다). */
export function readableNav(profile: ProfileView | undefined): readonly NeotmsNavItem[] {
  return NEOTMS_NAV.filter((item) => mayDo(profile, item.menuId, 'read'))
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
