import type { ReactNode } from 'react'
import { describeError } from '@/shared/utils/errors'
import ui from './ui.module.css'

export function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <div className={`${ui.alert} ${ui.alertError}`} role="alert">
      {describeError(error)}
    </div>
  )
}

export function SuccessNotice({ children }: { children: ReactNode }) {
  if (!children) return null
  return (
    <div className={`${ui.alert} ${ui.alertSuccess}`} role="status">
      {children}
    </div>
  )
}

export function InfoNotice({ children }: { children: ReactNode }) {
  if (!children) return null
  return (
    <div className={`${ui.alert} ${ui.alertInfo}`} role="note">
      {children}
    </div>
  )
}

interface TableStateProps {
  isLoading: boolean
  error: unknown
  isEmpty: boolean
  emptyText: string
  colSpan: number
}

/**
 * 표 본문의 "내용이 아닌 세 상태". 모든 목록이 같은 모양으로 그린다.
 *
 * 보여 줄 내용이 있으면 null 을 돌려주므로, 호출하는 쪽은 조건 없이 `<tbody>` 맨 위에 그대로
 * 둘 수 있다.
 */
export function TableState({ isLoading, error, isEmpty, emptyText, colSpan }: TableStateProps) {
  if (!isLoading && !error && !isEmpty) return null
  return (
    <tr>
      <td colSpan={colSpan} className={ui.placeholder}>
        {isLoading ? '불러오는 중…' : error ? describeError(error) : emptyText}
      </td>
    </tr>
  )
}

interface LoadMoreProps {
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onClick: () => void
}

/**
 * '더 보기'.
 *
 * 페이지 번호가 없는 것은 UI 취향이 아니다 — 서버가 전체 건수를 주지 않기 때문이고, 주지 않는
 * 이유는 `COUNT(*)` 가 목록 쿼리보다 비싸기 때문이다(neotms.types.ts 의 `ListPage` 주석).
 *
 * 마지막 페이지에서는 버튼 대신 "마지막" 을 글자로 남긴다. 버튼이 그냥 사라지면 사용자는
 * 목록이 끝난 것인지 버튼을 못 찾은 것인지 알 수 없다.
 */
export function LoadMore({ hasNextPage, isFetchingNextPage, onClick }: LoadMoreProps) {
  return (
    <div className={ui.loadMore}>
      {hasNextPage ? (
        <button type="button" className={ui.btn} onClick={onClick} disabled={isFetchingNextPage}>
          {isFetchingNextPage ? '불러오는 중…' : '더 보기'}
        </button>
      ) : (
        <span className={ui.hint}>마지막 페이지입니다.</span>
      )}
    </div>
  )
}
