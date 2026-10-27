import type { MenuAction, ProfileView } from '@/apis/neotms.types'
import { NeotmsMenuId, type NeotmsMenuIdValue } from '@/shared/config'

/**
 * 메뉴 권한을 읽는 곳.
 *
 * 셸(NeotmsApp)에 두지 않고 따로 뺀 이유는 의존 방향이다. 버튼을 가리는 화면이 일곱 개이므로,
 * 셸에 두면 모든 목록 화면이 셸 모듈을 import 하게 된다 — 지금은 순환이 아니지만, 셸이 나중에
 * 화면 하나를 직접 참조하는 순간(예: 공통 헤더에 알림 뱃지) 순환이 된다. 그때 생기는 오류는
 * `undefined is not a function` 이고, 원인을 찾는 데 한참 걸린다.
 */

/** 사이드바 메뉴. `menuId` 는 서버가 권한을 부여하는 단위이고, `path` 는 라우터의 경로다. */
export interface NeotmsNavItem {
  menuId: NeotmsMenuIdValue
  path: string
  label: string
}

export const NEOTMS_NAV: readonly NeotmsNavItem[] = [
  { menuId: NeotmsMenuId.PROJECT, path: '/projects', label: '프로젝트' },
  { menuId: NeotmsMenuId.JOB, path: '/jobs', label: '작업' },
  { menuId: NeotmsMenuId.PURCHASE_ORDER, path: '/purchase-orders', label: '발주' },
  { menuId: NeotmsMenuId.CUSTOMER, path: '/customers', label: '고객사' },
  { menuId: NeotmsMenuId.TRANSLATOR, path: '/translators', label: '번역가' },
  { menuId: NeotmsMenuId.REPORT, path: '/reports', label: '보고서' },
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
