import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from 'react-router'
import { AuthContextProvider } from './auth/AuthContextProvider'
import { neotmsRouter } from './routes'
import { shouldRetry } from './shared/utils/errors'

/**
 * 쿼리 기본값.
 *
 * `retry` 가 숫자가 아니라 함수인 것이 관리 콘솔과 다른 점이다. 이 API 는 503 을 **정상적으로**
 * 돌려준다 — 다른 탭이 토큰을 갱신 중이거나, Aurora 가 0 ACU 에서 깨어나는 중이다. 그 두
 * 경우는 다시 물어보면 되고, 401·403·404 는 몇 번을 물어도 같은 답이 온다. 숫자로 두면 전자를
 * 포기하거나 후자를 세 번 반복하거나 둘 중 하나가 된다.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 창을 오갈 때마다 다시 읽지 않는다. 이 시스템의 비용은 사실상 호출 수다.
      refetchOnWindowFocus: false,
      retry: shouldRetry,
    },
  },
})

export default function AppRoot() {
  /*
   * 라우터가 AuthContextProvider **안쪽**이다.
   *
   * 반대로 두면 로그인 상태가 바뀔 때마다 Provider 가 다시 마운트되면서 메모리에 들고 있는
   * 액세스 토큰이 사라진다. 또 라우터 안의 어떤 화면에서든 `useAuthContext` 를 쓸 수 있어야
   * 하는데, 콜백 화면이 바로 그 화면이다.
   */
  return (
    <QueryClientProvider client={queryClient}>
      <AuthContextProvider>
        <RouterProvider router={neotmsRouter} />
      </AuthContextProvider>
    </QueryClientProvider>
  )
}
