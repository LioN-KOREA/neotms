/**
 * 작업 그룹 (팀장님 2026-11-25, db/014) — 다음 코드 미리보기와 [작업 그룹] 단추.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { neotmsApi } from './neotms.client'

export const peekJobGroup = (projectId: string) =>
  neotmsApi<{ code: string }>(`/api/v0/projects/${encodeURIComponent(projectId)}/job-groups/next`)

export const applyJobGroup = (projectId: string, mode: 'merge' | 'new', jobIds: string[]) =>
  neotmsApi<{ code: string; jobIds: string[] }>(`/api/v0/projects/${encodeURIComponent(projectId)}/job-groups`, {
    method: 'POST',
    body: { mode, jobIds },
  })

/** 작업 등록 창의 '예정' 코드. 번호를 쓰지 않으니 실제 저장 때 다를 수 있다(누가 먼저 만들면). */
export function usePeekJobGroup(projectId: string | null) {
  return useQuery({
    queryKey: ['neotms', 'jobGroupPeek', projectId],
    queryFn: () => peekJobGroup(projectId!),
    enabled: !!projectId,
    staleTime: 0,
  })
}

export function useApplyJobGroup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, mode, jobIds }: { projectId: string; mode: 'merge' | 'new'; jobIds: string[] }) =>
      applyJobGroup(projectId, mode, jobIds),
    onSuccess: () => void qc.invalidateQueries(),
  })
}

export { groupNumber } from './jobGroupCode'
