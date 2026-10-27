import type { ReactNode } from 'react'
import { SERVICE_ORG_NAME, SERVICE_PRODUCT_NAME } from '@/shared/config'
import ui from '@/shared/ui/ui.module.css'
import styles from './AuthGate.module.css'

/**
 * 로그인 전·권한 없음·오류 화면이 공유하는 카드.
 *
 * 네 화면이 전부 "가운데 카드 하나 + 설명 한 문단 + 버튼 하나" 라서 레이아웃을 한 곳에 둔다.
 * 각 화면이 자기 마크업을 따로 들면, 그중 하나만 로고가 빠지거나 여백이 달라지는 식으로
 * 어긋나는데 — 사용자가 이 네 화면을 연달아 보는 경우(로그인 → 권한 없음)가 바로 그 차이가
 * 가장 잘 보이는 경로다.
 */
export function AuthGateCard({ children }: { children: ReactNode }) {
  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.brandOrg}>{SERVICE_ORG_NAME}</span>
          <span className={styles.brandText}>{SERVICE_PRODUCT_NAME}</span>
        </div>
        {children}
      </div>
    </div>
  )
}

/**
 * 부팅 중.
 *
 * 글자를 거의 넣지 않는다. 이 화면이 보이는 시간은 보통 refresh 한 번(수백 ms)이고, 그 사이에
 * 읽을 수 없는 문장을 띄우면 깜빡임만 늘어난다. 다만 Aurora 가 0 ACU 에서 깨어나는 첫 요청은
 * 몇 초가 걸릴 수 있어서(서버가 `Retry-After: 2` 를 준다) 완전히 비워 두지는 않는다.
 */
export function BootstrapView() {
  return (
    <AuthGateCard>
      <p className={styles.lead}>세션을 확인하는 중입니다…</p>
    </AuthGateCard>
  )
}

/**
 * 로그인 화면.
 *
 * 비밀번호 입력란이 없다. 이 시스템은 자체 로그인을 하지 않고 계정관리 시스템(LPX)으로
 * 보낸다 — 버튼을 누르면 페이지가 떠나고, 돌아올 때는 `/auth/callback` 이다.
 */
export function LoginView({ onLogin }: { onLogin: () => void }) {
  return (
    <AuthGateCard>
      <p className={styles.lead}>
        라이온코리아 통합 로그인으로 들어갑니다. 다른 사내 시스템에 이미 로그인해 두었다면
        비밀번호를 다시 묻지 않습니다.
      </p>
      <button
        type="button"
        className={`${ui.btn} ${ui.btnPrimary} ${styles.action}`}
        onClick={onLogin}
      >
        로그인
      </button>
    </AuthGateCard>
  )
}

/**
 * 로그인은 됐지만 이 시스템을 쓸 권한이 없을 때.
 *
 * **로그인 버튼을 두지 않는다.** 이 상태의 사용자는 SSO 세션이 살아 있어서, 로그인을 누르면
 * 비밀번호도 묻지 않고 즉시 이 화면으로 돌아온다 — 누를 수 있는 버튼이 있으면 사용자는 그걸
 * 반복하고, 시스템이 고장 난 것처럼 느낀다. 할 수 있는 일은 권한 요청과 로그아웃뿐이므로
 * 그 두 가지만 둔다.
 */
export function AccessDeniedView({
  email,
  onLogout,
}: {
  email: string | null
  onLogout: () => void
}) {
  return (
    <AuthGateCard>
      <div className={`${ui.alert} ${ui.alertInfo}`} role="alert">
        이 계정에는 TMS 접근 권한이 없습니다.
      </div>
      <p className={styles.lead}>
        로그인은 정상적으로 되었습니다. TMS 사용 권한은 계정관리 시스템에서 부여되므로, 시스템
        담당자에게 권한 부여를 요청해 주세요. 권한이 부여된 뒤에는 이 페이지를 새로고침하면
        들어갈 수 있습니다.
      </p>
      {email ? <p className={styles.meta}>로그인한 계정: {email}</p> : null}
      <div className={styles.altActions}>
        <button type="button" className={styles.linkButton} onClick={onLogout}>
          다른 계정으로 로그인
        </button>
      </div>
    </AuthGateCard>
  )
}

/**
 * 세션 확인이 오류로 끝났을 때.
 *
 * login_required 와 구분해서 보여 준다. 세션이 끝난 것이 아니라 **확인에 실패한** 것이므로,
 * 로그인을 다시 시작하게 하면 멀쩡한 세션을 버리고 왕복을 한 번 더 한다. 먼저 "다시 시도" 를
 * 권하고, 로그인은 보조 동작으로 둔다.
 */
export function AuthErrorView({
  message,
  onRetry,
  onLogin,
}: {
  message?: string
  onRetry: () => void
  onLogin: () => void
}) {
  return (
    <AuthGateCard>
      <div className={`${ui.alert} ${ui.alertError}`} role="alert">
        {message || '로그인 상태를 확인하지 못했습니다.'}
      </div>
      <p className={styles.lead}>
        네트워크 문제이거나 계정관리 시스템이 일시적으로 응답하지 않는 경우입니다. 잠시 후 다시
        시도해 주세요.
      </p>
      <button
        type="button"
        className={`${ui.btn} ${ui.btnPrimary} ${styles.action}`}
        onClick={onRetry}
      >
        다시 시도
      </button>
      <div className={styles.altActions}>
        <button type="button" className={styles.linkButton} onClick={onLogin}>
          로그인 화면으로
        </button>
      </div>
    </AuthGateCard>
  )
}

/**
 * 읽을 수 있는 메뉴가 하나도 없을 때.
 *
 * `canAccess` 는 true 인데 역할 권한 행렬이 비어 있는 상태다. 백엔드의 NeotmsMenus.ts 가
 * 적어 둔 대로 메뉴 ID 가 아직 레거시 SY_MENU 와 대조되지 않았고, 대조 전에는 권한 판정이
 * 전부 닫힌 쪽으로 실패한다 — 그게 올바른 방향이지만, 화면이 빈 사이드바가 되면 사용자는
 * 로그인이 깨진 것으로 본다. 무엇이 없는지 말해 주는 쪽이 낫다.
 */
export function NoMenusView({ onLogout }: { onLogout: () => void }) {
  return (
    <AuthGateCard>
      <div className={`${ui.alert} ${ui.alertError}`} role="alert">
        사용할 수 있는 메뉴가 없습니다.
      </div>
      <p className={styles.lead}>
        계정은 확인되었지만 이 계정의 역할에 조회 권한이 부여된 메뉴가 없습니다. 시스템 담당자에게
        역할 권한 설정을 요청해 주세요.
      </p>
      <div className={styles.altActions}>
        <button type="button" className={styles.linkButton} onClick={onLogout}>
          로그아웃
        </button>
      </div>
    </AuthGateCard>
  )
}
