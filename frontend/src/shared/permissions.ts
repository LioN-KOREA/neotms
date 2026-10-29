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
export type NeotmsNavGroupId = 'work' | 'party' | 'insight' | 'admin'

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
  { id: 'work', label: '업무', icon: 'folder' },
  { id: 'party', label: '거래처', icon: 'users' },
  { id: 'insight', label: '집계', icon: 'chart' },
  { id: 'admin', label: '관리', icon: 'gear' },
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
  {
    menuId: NeotmsMenuId.PROJECT,
    path: '/projects',
    label: '프로젝트',
    hint: '고객사에서 받은 일',
    group: 'work',
  },
  {
    menuId: NeotmsMenuId.JOB,
    path: '/jobs',
    label: '작업',
    hint: '매출이 쌓이는 단위',
    group: 'work',
  },
  {
    menuId: NeotmsMenuId.PURCHASE_ORDER,
    path: '/purchase-orders',
    label: '발주',
    hint: '번역가에게 내보낸 일',
    group: 'work',
  },
  {
    menuId: NeotmsMenuId.CUSTOMER,
    path: '/customers',
    label: '고객사',
    hint: '거래처와 단가',
    group: 'party',
  },
  {
    menuId: NeotmsMenuId.TRANSLATOR,
    path: '/translators',
    label: '번역가',
    hint: '언어·분야·단가',
    group: 'party',
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
    label: '유지보수',
    hint: '분야·언어 등 코드',
    group: 'admin',
  },
  {
    menuId: NeotmsMenuId.STAFF,
    path: '/staff',
    label: '사용자 관리',
    hint: '가입 승인과 역할',
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
