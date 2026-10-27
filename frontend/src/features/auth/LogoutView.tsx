import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuthContext } from '@/auth/AuthContextProvider'
import ui from '@/shared/ui/ui.module.css'
import { AuthGateCard } from './AuthGate'
import styles from './AuthGate.module.css'

/**
 * `/auth/logout` — 로그아웃이 끝난 사람이 도착하는 곳.
 *
 * 계정 시스템의 `/logout` 이 연동된 모든 앱의 세션을 끝낸 뒤 여기로 되돌려보낸다. 그러니 이
 * 화면은 "끝났다" 고 말하는 것 외에 할 일이 없다 — 세션 확인도 하지 않는다(그래서
 * AuthContextProvider 의 SELF_DRIVEN_PATHS 에 들어 있다).
 *
 * ## 캐시를 여기서 비운다
 *
 * 쿼리 캐시 키에는 사용자 구분이 없다. 비우지 않으면 같은 탭에서 다음 사람이 로그인했을 때,
 * 첫 렌더에 **이전 사용자의** 고객사 목록과 금액이 잠깐 보인다. 공용 PC 에서는 그 한 번의
 * 깜빡임이 그대로 정보 유출이다.
 *
 * 로그아웃 동작(`logout()`)에서 비우지 않고 이 화면에서 비우는 이유는, 세션이 만료되거나
 * 갱신이 실패해서 로그아웃 **되는** 경로도 있기 때문이다. 다만 그 경로는 이 화면을 지나지
 * 않으므로 셸에서도 한 번 더 비운다(NeotmsApp 주석).
 */
export function LogoutView() {
  const queryClient = useQueryClient()
  const { login } = useAuthContext()

  useEffect(() => {
    queryClient.clear()
  }, [queryClient])

  return (
    <AuthGateCard>
      <div className={`${ui.alert} ${ui.alertSuccess}`} role="status">
        로그아웃되었습니다.
      </div>
      <p className={styles.lead}>
        연결된 사내 시스템의 로그인도 함께 해제되었습니다. 공용 PC 라면 브라우저 창을 닫아
        주세요.
      </p>
      <button
        type="button"
        className={`${ui.btn} ${ui.btnPrimary} ${styles.action}`}
        onClick={login}
      >
        다시 로그인
      </button>
    </AuthGateCard>
  )
}
