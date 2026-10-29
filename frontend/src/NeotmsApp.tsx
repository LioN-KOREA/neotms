import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, NavLink, Outlet, useLocation } from 'react-router'
import { useProfile } from '@/apis/queries/neotms.query'
import { useAuthContext } from '@/auth/AuthContextProvider'
import { rememberReturnPath } from '@/auth/return-path'
import { SERVICE_ORG_NAME, SERVICE_PRODUCT_NAME } from '@/shared/config'
import { activeNavItem, readableNav, readableNavGroups } from '@/shared/permissions'
import {
  AccessDeniedView,
  AuthErrorView,
  BootstrapView,
  LoginView,
  NoMenusView,
  PendingApprovalView,
} from '@/features/auth/AuthGate'
import { SignupView } from '@/features/auth/SignupView'
import { ErrorNotice } from '@/shared/ui/Feedback'
import { Icon } from '@/shared/ui/Icon'
import ui from '@/shared/ui/ui.module.css'
import styles from './NeotmsApp.module.css'

/**
 * 콘솔 셸.
 *
 * 두 가지만 한다: 인증 상태에 따라 무엇을 그릴지 정하고, 로그인 이후에는 좌측 두 단 +
 * `<Outlet/>` 을 그린다. 화면 전환은 React Router 가 한다.
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
  const location = useLocation()
  const profile = profileQuery.data
  const nav = readableNav(profile)
  const groups = readableNavGroups(profile)

  /*
   * 권한 정보가 오기 전에는 좌측을 그리지 않는다.
   *
   * 빈 메뉴를 먼저 그리면 한 번의 왕복 동안 "메뉴가 없는 화면" 이 보였다가 채워진다. 그건
   * 바로 아래의 NoMenusView(권한이 정말 없는 상태)와 눈으로 구분되지 않는다.
   */
  if (profileQuery.isLoading) return <BootstrapView />

  if (profileQuery.error) {
    /*
     * 셸 바깥의 오류 화면이라 `ui.page` 로만 감싼다.
     *
     * 여기서 셸 레이아웃(.shell/.rail/.nav)을 그리지 않는 것은 그릴 수가 없기 때문이다 —
     * 좌측 두 단의 내용이 전부 `profile` 에서 나오고, 그 `profile` 을 못 받은 상태가 바로
     * 이 분기다. 빈 레일과 빈 패널을 세워 두면 "메뉴가 사라졌다" 로 읽힌다.
     */
    return (
      <div className={ui.page}>
        <ErrorNotice error={profileQuery.error} />
        <button type="button" className={ui.btn} onClick={() => void profileQuery.refetch()}>
          다시 시도
        </button>
      </div>
    )
  }

  /*
   * 등록 상태가 셋이고, 그중 둘은 애플리케이션이 아니라 한 장짜리 화면이다.
   *
   * 순서가 중요하다. 이 분기가 아래 `nav.length === 0` **앞에** 있어야 한다 — 등록 전과 승인
   * 대기 상태에서는 `menus` 가 `[]` 이므로 `nav` 도 비어 있고, 순서를 바꾸면 아직 가입하지도
   * 않은 사람이 "사용할 수 있는 메뉴가 없습니다. 시스템 담당자에게 역할 권한 설정을 요청해
   * 주세요" 를 보게 된다. 그건 회원가입이라는 할 수 있는 일을 숨기고, 할 수 없는 일을 하라고
   * 안내하는 화면이다. 레거시가 이 상태에 403 하나만 돌려줘서 생긴 교착이 바로 그것이고,
   * `/api/v0/me` 를 `account` 티어로 옮긴 이유 전체가 여기 쓸 분기 하나를 얻기 위한 것이다.
   *
   * 비활성 계정은 여기 없다. 서버가 `/api/v0/me` 에 403 을 주므로 위의 `profileQuery.error`
   * 가 먼저 받고, 그 본문("관리자에게 문의하십시오")이 그대로 보인다.
   */
  if (profile?.registration === 'unregistered') {
    return <SignupView prefill={profile.prefill} onLogout={onLogout} />
  }
  if (profile?.registration === 'pending') {
    /*
     * 이름은 접수된 `staff` 행의 것(`profile.name`)을 먼저 쓰고 `prefill` 로 떨어진다. 둘이
     * 다를 수 있다 — 가입할 때 SSO 이름을 고쳐서 냈다면 접수된 쪽이 그 사람이 낸 이름이고,
     * 승인 전에 확인하고 싶은 것도 그쪽이다.
     */
    return (
      <PendingApprovalView
        name={profile.name ?? profile.prefill.name}
        email={profile.email ?? profile.prefill.email}
        onLogout={onLogout}
      />
    )
  }

  if (nav.length === 0) return <NoMenusView onLogout={onLogout} />

  /*
   * 지금 열려 있는 메뉴와 그것이 속한 묶음.
   *
   * 둘 다 **주소에서만** 계산한다. 레일에 "선택된 묶음" 상태를 따로 두지 않은 것은 그 상태가
   * 주소와 어긋날 수 있기 때문이다 — 뒤로 가기, 북마크, 상세 화면에서 온 링크. 어긋나면 레일은
   * '거래처' 를 켜 두고 본문은 프로젝트를 보여 주는, 고치기 어려운 종류의 버그가 된다.
   *
   * 주소가 어느 메뉴에도 닿지 않을 때(404, `/`)는 첫 묶음을 펼친다. `groups` 는 비어 있지
   * 않다 — 위의 `nav.length === 0` 이 그 경우를 이미 걸러냈고, 묶음은 메뉴가 하나라도 있을
   * 때만 만들어진다(`readableNavGroups`).
   */
  const current = activeNavItem(profile, location.pathname)
  const activeGroup = groups.find((g) => g.id === current?.group) ?? groups[0]!

  const name = profile?.name || '—'

  return (
    <div className={styles.shell}>
      {/*
       * 아이콘 레일.
       *
       * 레일 항목을 누르면 그 묶음의 **첫 메뉴로 이동한다**. 패널만 펼치고 본문은 그대로 두는
       * 방식도 있지만, 그러면 "레일에서 고른 묶음" 과 "주소가 가리키는 묶음" 이 달라지는 상태가
       * 생긴다. 한 번 누르면 바로 일할 수 있는 화면이 나오는 쪽이 클릭도 적다.
       */}
      <nav className={styles.rail} aria-label="메뉴 묶음">
        <Link to={activeGroup.items[0]!.path} className={styles.brandmark} aria-label="처음으로">
          TMS
        </Link>

        {groups.map((group) => (
          <Link
            key={group.id}
            to={group.items[0]!.path}
            className={`${styles.railItem} ${group.id === activeGroup.id ? styles.railItemActive : ''}`}
            aria-current={group.id === activeGroup.id ? 'true' : undefined}
          >
            <Icon name={group.icon} size={20} />
            {group.label}
          </Link>
        ))}

        <div className={styles.railMe}>
          {/* 아바타는 장식이라 `aria-hidden` 이다 — 바로 아래에 이름이 글자로 있다. */}
          <div className={styles.railAvatar} aria-hidden="true">
            {name.slice(0, 1)}
          </div>
          <span className={styles.railMeName} title={name}>
            {name}
          </span>
          <span className={styles.railMeRole} title={profile?.email ?? ''}>
            {profile?.roleName || profile?.mgrId || ''}
          </span>
        </div>
      </nav>

      {/* 2차 메뉴 패널 — 열려 있는 묶음의 메뉴만. */}
      <div className={styles.nav}>
        <div className={styles.navGroupLabel}>{activeGroup.label}</div>

        <ul className={styles.navList}>
          {activeGroup.items.map((item) => (
            <li key={item.menuId}>
              {/* NavLink 가 활성 상태를 직접 계산한다 — 현재 경로를 따로 비교하면 상세
                  화면(/projects/123)에서 상위 메뉴의 강조가 꺼진다. */}
              <NavLink
                to={item.path}
                className={({ isActive }) =>
                  `${styles.navLink} ${isActive ? styles.navLinkActive : ''}`
                }
              >
                <span className={styles.navLabel}>{item.label}</span>
                <span className={styles.navHint}>{item.hint}</span>
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
            <b>조회 범위</b>
            담당하는 건만 표시됩니다. 합계는 회사 전체 값이 아닙니다.
          </p>
        ) : null}
      </div>

      <div className={styles.mainCol}>
        <header className={styles.top}>
          <span className={styles.topBrand}>
            {SERVICE_PRODUCT_NAME}
            <em>{SERVICE_ORG_NAME}</em>
          </span>

          <div className={styles.topRight}>
            <span className={styles.topWho}>
              <b>{name}</b>
              {profile?.email ? ` · ${profile.email}` : ''}
            </span>
            {profile?.roleName ? <span className={styles.topPill}>{profile.roleName}</span> : null}
            <button type="button" className={styles.topBtn} onClick={onLogout}>
              <Icon name="logout" size={14} />
              로그아웃
            </button>
          </div>
        </header>

        {/*
         * 경로 표시줄이 화면 제목을 대신한다.
         *
         * 큰 제목을 없앤 자리다. 제목이 말해 주던 것("프로젝트")은 좌측 패널에서 이미 강조되어
         * 있으므로, 같은 말을 20px 로 한 번 더 적는 대신 32px 한 줄로 '묶음 › 메뉴' 를 적는다.
         * 본문은 그만큼 위로 올라오고, 표가 한 화면에 더 들어온다.
         *
         * `aria-label` 을 붙인 `nav` 인 것은 스크린 리더 때문이다 — 지금 위치를 읽어 주는
         * 영역이라는 사실이 글자만으로는 전달되지 않는다.
         */}
        <nav className={styles.crumb} aria-label="현재 위치">
          <span>{activeGroup.label}</span>
          {current ? (
            <>
              <span className={styles.crumbSep} aria-hidden="true">
                <Icon name="chevronRight" size={12} />
              </span>
              <span className={styles.crumbCurrent}>{current.label}</span>
            </>
          ) : null}
        </nav>

        <main className={styles.body}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
