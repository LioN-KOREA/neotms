import type { ReactNode } from 'react'
import { createBrowserRouter, Navigate, useLocation } from 'react-router'
import { useProfile } from '@/apis/queries/neotms.query'
import NeotmsApp from '@/NeotmsApp'
import { NeotmsMenuId, type NeotmsMenuIdValue } from '@/shared/config'
import { mayDo, readableNav } from '@/shared/permissions'
import { CallbackView } from '@/features/auth/CallbackView'
import { LogoutView } from '@/features/auth/LogoutView'
import { CustomersView } from '@/features/customers/CustomersView'
import { JobsView } from '@/features/jobs/JobsView'
import { MaintenanceView } from '@/features/maintenance/MaintenanceView'
import { ProjectDetailView } from '@/features/projects/ProjectDetailView'
import { ProjectsView } from '@/features/projects/ProjectsView'
import { PurchaseOrdersView } from '@/features/purchaseorders/PurchaseOrdersView'
import { ReportsView } from '@/features/reports/ReportsView'
import { StaffView } from '@/features/staff/StaffView'
import { TranslatorsView } from '@/features/translators/TranslatorsView'
import ui from '@/shared/ui/ui.module.css'

/**
 * 경로 표.
 *
 * ## 라이브러리로 쓴다, 프레임워크로 쓰지 않는다
 *
 * `createBrowserRouter` + `RouterProvider` 만 쓰고 loader·action·framework 모드는 쓰지 않는다.
 * 데이터는 전부 TanStack Query 가 가져오고, 그쪽이 캐시·무효화·재시도를 들고 있다. 라우터
 * loader 를 같이 쓰면 같은 데이터에 **두 개의 캐시**가 생기고, 그러면 저장 후 무효화가 한쪽만
 * 갱신한다 — 목록은 새 값, 상세는 옛 값이 되는 종류의 버그다.
 *
 * 또 프레임워크 모드는 SSR 을 전제로 한다. 이 앱은 S3 에 올라가는 정적 파일이고, 서버는
 * Lambda 하나뿐이며 그게 비용 구조의 핵심이다.
 *
 * ## 모든 화면이 셸 아래에 있다
 *
 * `/auth/callback` 과 `/auth/logout` 만 셸 밖이다. 두 화면은 로그인되지 않은 상태로 열리는
 * 것이 정상이므로 인증 게이트 아래에 두면 안 된다 — 게이트가 로그인 화면을 먼저 그리면,
 * 콜백 화면은 인가 코드를 쓰지 못하고 사용자는 로그인 버튼을 다시 누른다.
 */

/**
 * 메뉴 권한이 없는 경로를 직접 열었을 때.
 *
 * 사이드바에 없는 메뉴의 주소를 북마크나 메신저 링크로 열 수 있다. 서버는 403 을 주므로
 * 데이터가 새지는 않지만, 그 403 은 화면에서 "불러오지 못했습니다" 로 보인다 — 권한 문제라고
 * 말해 주는 쪽이 문의 한 건을 줄인다.
 *
 * **이건 보안 장치가 아니다.** 모든 API 가 서버에서 같은 권한을 다시 확인한다.
 */
function RequireMenu({ menuId, children }: { menuId: NeotmsMenuIdValue; children: ReactNode }) {
  const { data: profile, isLoading } = useProfile()

  // 셸이 이미 프로필을 기다렸으므로 여기서 로딩이 걸리는 일은 드물다. 다만 캐시가 비워진
  // 직후(로그아웃 → 재로그인)에는 가능하므로, 그 순간에 "권한 없음" 을 띄우지는 않는다.
  if (isLoading) return null

  if (!mayDo(profile, menuId, 'read')) {
    return (
      <div className={ui.page}>
        {/*
         * 목록 화면들과 달리 여기는 제목을 남긴다.
         *
         * 제목을 없앤 근거는 "경로 표시줄이 같은 말을 한다" 였다. 이 화면에서 경로 표시줄은
         * 사용자가 열려고 한 메뉴 이름을 적고 있고, 정작 알려야 하는 것 — **그 메뉴를 열
         * 권한이 없다** — 은 셸의 어디에도 없다. (ui.module.css 의 `.pageTitle` 주석)
         */}
        <h1 className={ui.pageTitle}>접근 권한이 없습니다</h1>
        <div className={`${ui.alert} ${ui.alertInfo}`} role="alert">
          이 메뉴에 대한 조회 권한이 없습니다. 필요하다면 시스템 담당자에게 요청해 주세요.
        </div>
      </div>
    )
  }

  return <>{children}</>
}

/**
 * `/` 를 실제로 쓸 수 있는 첫 화면으로 보낸다.
 *
 * 고정된 기본 화면을 두지 않는다. '프로젝트' 를 기본으로 박으면 프로젝트 권한이 없는
 * 계정(예: 번역가 관리만 하는 담당자)은 로그인할 때마다 권한 없음 화면을 먼저 본다.
 */
function HomeRedirect() {
  const { data: profile, isLoading } = useProfile()
  if (isLoading) return null
  const first = readableNav(profile)[0]
  // 읽을 수 있는 메뉴가 없으면 셸이 이미 NoMenusView 를 그리므로 여기까지 오지 않는다.
  return <Navigate to={first?.path ?? '/projects'} replace />
}

/** 없는 주소. */
function NotFoundView() {
  const { pathname } = useLocation()
  return (
    <div className={ui.page}>
      {/* 위 403 과 같은 이유로 제목을 남긴다 — 이 주소에는 메뉴가 없으므로 경로 표시줄도
          아무것도 말하지 못한다. */}
      <h1 className={ui.pageTitle}>페이지를 찾을 수 없습니다</h1>
      <p className={ui.pageHint}>
        <code>{pathname}</code> 에 해당하는 화면이 없습니다. 왼쪽 메뉴에서 선택해 주세요.
      </p>
    </div>
  )
}

export const neotmsRouter = createBrowserRouter([
  // 인증 게이트 밖. 위 주석 참고.
  { path: '/auth/callback', element: <CallbackView /> },
  { path: '/auth/logout', element: <LogoutView /> },

  {
    path: '/',
    element: <NeotmsApp />,
    children: [
      { index: true, element: <HomeRedirect /> },
      {
        path: 'projects',
        element: (
          <RequireMenu menuId={NeotmsMenuId.PROJECT}>
            <ProjectsView />
          </RequireMenu>
        ),
      },
      {
        /*
         * 프로젝트 상세. 이 경로가 라우터를 쓰는 이유 그 자체다 — 담당자들은 "이 프로젝트
         * 좀 봐 달라" 를 주소로 전달한다.
         */
        path: 'projects/:id',
        element: (
          <RequireMenu menuId={NeotmsMenuId.PROJECT}>
            <ProjectDetailView />
          </RequireMenu>
        ),
      },
      {
        path: 'jobs',
        element: (
          <RequireMenu menuId={NeotmsMenuId.JOB}>
            <JobsView />
          </RequireMenu>
        ),
      },
      {
        path: 'purchase-orders',
        element: (
          <RequireMenu menuId={NeotmsMenuId.PURCHASE_ORDER}>
            <PurchaseOrdersView />
          </RequireMenu>
        ),
      },
      {
        path: 'customers',
        element: (
          <RequireMenu menuId={NeotmsMenuId.CUSTOMER}>
            <CustomersView />
          </RequireMenu>
        ),
      },
      {
        path: 'translators',
        element: (
          <RequireMenu menuId={NeotmsMenuId.TRANSLATOR}>
            <TranslatorsView />
          </RequireMenu>
        ),
      },
      {
        path: 'reports',
        element: (
          <RequireMenu menuId={NeotmsMenuId.REPORT}>
            <ReportsView />
          </RequireMenu>
        ),
      },
      {
        /*
         * 유지보수. `RequireMenu` 가 막는 것은 안내 문구일 뿐이고(이 파일 위쪽 주석), 실제
         * 차단은 서버의 라우트 표가 한다 — `/api/v0/admin/codes` 네 개가 MAINTENANCE 메뉴에
         * 걸려 있다. 드롭다운을 읽는 `GET /api/v0/codes` 는 거기 없다: 모든 직원이 읽는다.
         */
        path: 'maintenance',
        element: (
          <RequireMenu menuId={NeotmsMenuId.MAINTENANCE}>
            <MaintenanceView />
          </RequireMenu>
        ),
      },
      {
        /*
         * 사용자 관리. 이 화면의 쓰기만이 **다른 모든 메뉴의 권한을 바꾼다** —
         * `PATCH /api/v0/admin/staff/:id` 가 `staff.role_id` 를 쓰고, 앱의 모든 권한이 그
         * 컬럼에서 나온다. 그래서 서버 라우트 표에서 세 엔드포인트가 모두 STAFF 메뉴에 걸려
         * 있고, 등록(POST)과 삭제(DELETE)는 아예 존재하지 않는다.
         */
        path: 'staff',
        element: (
          <RequireMenu menuId={NeotmsMenuId.STAFF}>
            <StaffView />
          </RequireMenu>
        ),
      },
      { path: '*', element: <NotFoundView /> },
    ],
  },
])
