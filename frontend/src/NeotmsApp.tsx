import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { NavLink, Outlet, useLocation } from 'react-router'
import { useProfile } from '@/apis/queries/neotms.query'
import { useAuthContext } from '@/auth/AuthContextProvider'
import { rememberReturnPath } from '@/auth/return-path'
import { SERVICE_ORG_NAME, SERVICE_PRODUCT_NAME } from '@/shared/config'
import { readableNav } from '@/shared/permissions'
import {
  AccessDeniedView,
  AuthErrorView,
  BootstrapView,
  LoginView,
  NoMenusView,
} from '@/features/auth/AuthGate'
import { ErrorNotice } from '@/shared/ui/Feedback'
import ui from '@/shared/ui/ui.module.css'
import styles from './NeotmsApp.module.css'

/**
 * 콘솔 셸.
 *
 * 두 가지만 한다: 인증 상태에 따라 무엇을 그릴지 정하고, 로그인 이후에는 사이드바 + `<Outlet/>`
 * 을 그린다. 화면 전환은 React Router 가 한다.
 *
 * ## 라우터를 쓰는 이유 (관리 콘솔은 탭 상태였다)
 *
 * 관리 콘솔은 화면이 여섯 개이고 전부 목록이라 탭 상태로 충분했다. 여기는 다르다 — 프로젝트
 * 상세가 있고, 그 상세를 **메신저로 공유한다**. 레거시에서 담당자들이 화면 캡처를 주고받던
 * 이유가 그것이고(§분석), 주소가 화면을 가리키지 않는 앱에서는 그 습관을 고칠 수 없다.
 */

export default function NeotmsApp() {
  const { authState, login, logout, retryBootstrap } = useAuthContext()
  const queryClient = useQueryClient()
  const location = useLocation()

  const isAuthenticated = authState.status === 'authenticated'

  /*
   * 로그인 상태를 벗어나면 쿼리 캐시를 비운다.
   *
   * 로그아웃 화면에서도 비우지만(LogoutView 주석) 그 화면을 지나지 않는 경로가 있다 — 세션
   * 만료, 갱신 실패, 다른 탭에서의 로그아웃. 캐시 키에 사용자 구분이 없으므로, 비우지 않으면
   * 다음 로그인의 첫 렌더에 이전 사용자의 금액이 잠깐 보인다.
   */
  useEffect(() => {
    if (!isAuthenticated) queryClient.clear()
  }, [isAuthenticated, queryClient])

  /** 로그인하러 떠나기 전에 지금 보던 주소를 기억한다. 돌아올 곳은 `/` 가 아니다. */
  const startLogin = () => {
    rememberReturnPath(`${location.pathname}${location.search}`)
    login()
  }

  if (authState.status === 'bootstrapping') return <BootstrapView />
  if (authState.status === 'login_required') return <LoginView onLogin={startLogin} />
  if (authState.status === 'no_access') {
    return <AccessDeniedView email={authState.user?.email ?? null} onLogout={() => void logout()} />
  }
  if (authState.status === 'error') {
    return (
      <AuthErrorView
        message={authState.errorMessage}
        onRetry={retryBootstrap}
        onLogin={startLogin}
      />
    )
  }

  return <Shell onLogout={() => void logout()} />
}

/**
 * 로그인 이후의 셸.
 *
 * `useProfile` 은 로그인한 뒤에만 부를 수 있어서 별도 컴포넌트다(훅은 조건부로 부를 수 없다).
 */
function Shell({ onLogout }: { onLogout: () => void }) {
  const profileQuery = useProfile()
  const profile = profileQuery.data
  const nav = readableNav(profile)

  /*
   * 권한 정보가 오기 전에는 사이드바를 그리지 않는다.
   *
   * 빈 메뉴를 먼저 그리면 한 번의 왕복 동안 "메뉴가 없는 화면" 이 보였다가 채워진다. 그건
   * 바로 아래의 NoMenusView(권한이 정말 없는 상태)와 눈으로 구분되지 않는다.
   */
  if (profileQuery.isLoading) return <BootstrapView />

  if (profileQuery.error) {
    return (
      <div className={styles.main}>
        <ErrorNotice error={profileQuery.error} />
        <button type="button" className={ui.btn} onClick={() => void profileQuery.refetch()}>
          다시 시도
        </button>
      </div>
    )
  }

  if (nav.length === 0) return <NoMenusView onLogout={onLogout} />

  return (
    <div className={styles.shell}>
      <nav className={styles.sidebar}>
        <div className={styles.brand}>
          <span className={styles.brandOrg}>{SERVICE_ORG_NAME}</span>
          <span className={styles.brandProduct}>{SERVICE_PRODUCT_NAME}</span>
        </div>

        <ul className={styles.nav}>
          {nav.map((item) => (
            <li key={item.menuId}>
              {/* NavLink 가 활성 상태를 직접 계산한다 — 현재 경로를 따로 비교하면 상세
                  화면(/projects/123)에서 상위 메뉴의 강조가 꺼진다. */}
              <NavLink
                to={item.path}
                className={({ isActive }) =>
                  `${styles.navLink} ${isActive ? styles.navLinkActive : ''}`
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>

        {/*
         * 전체 행을 보지 못하는 계정에는 그 사실을 말해 준다.
         *
         * 화면이 행을 걸러내는 것이 아니다 — 서버가 애초에 담당분만 보낸다. 그래서 이 안내가
         * 없으면 담당자는 자기 화면의 합계를 회사 전체 합계로 읽는다. 보고서에서 가장 비싼
         * 착각이다.
         */}
        {profile && !profile.seesEveryRow ? (
          <p className={styles.scopeHint}>
            담당하는 건만 표시됩니다. 합계는 회사 전체 값이 아닙니다.
          </p>
        ) : null}

        <div className={styles.account}>
          <div className={styles.accountName}>{profile?.name || '—'}</div>
          {profile?.roleName ? <div className={styles.accountRole}>{profile.roleName}</div> : null}
          <div className={styles.accountEmail}>{profile?.email}</div>
          <button type="button" className={styles.logout} onClick={onLogout}>
            로그아웃
          </button>
        </div>
      </nav>

      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  )
}
