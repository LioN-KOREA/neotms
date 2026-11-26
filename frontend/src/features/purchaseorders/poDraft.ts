/**
 * '나의 업무' 시트의 [발행] · [보기] · [변경] 이 프로젝트 화면의 PO 창으로 넘기는 값 (팀장님 2026-11-26).
 *
 * 시트는 `navigate('/projects/:id', { state: { poAction } })` 로 넘어가고, 프로젝트 상세가 이 값을 읽어
 * PO 등록(new) 또는 수정(edit) 창을 연다. 미리 채운 값은 담당자가 고칠 수 있다.
 */
export interface PoDraft {
  /** 번역가 id — 목록에서 골랐을 때만. */
  translatorId?: string | null
  /** 번역가 이름 — id 가 없으면 이 이름으로 찾아 하나만 맞으면 고른다. */
  translatorName?: string | null
  poWorkCode?: string | null
  poType?: string | null
  poSlang?: string | null
  poElang?: string | null
  poVolume?: string | null
  poEday?: string | null
  poEdayTime?: string | null
}

export type PoAction =
  | { mode: 'new'; jobId: string; jobTitle: string; draft: PoDraft }
  | { mode: 'edit'; poId: string; draft?: PoDraft }

export const isPoAction = (value: unknown): value is PoAction => {
  if (!value || typeof value !== 'object') return false
  const v = value as { mode?: unknown }
  return v.mode === 'new' || v.mode === 'edit'
}
