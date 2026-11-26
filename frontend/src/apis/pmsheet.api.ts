/**
 * PM 업무 시트(나의 업무 v2) API — 서버 `pmsheet/` 모듈과 짝.
 *
 * 쿼리 키는 `['workspace', 'pm', …]` 아래에 둔다. 작업·PO 수정 훅(`useUpdateJob`,
 * `useUpdatePurchaseOrder`)이 성공하면 `['workspace']` 를 무효화하므로, 시트에서 연동 칸을 고치면
 * 이 시트도 저절로 새 값을 받는다.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { neotmsApi } from './neotms.client'
import type { PmCondRule, PmFreeRow, PmStateDef, PmStyle } from './pmsheet.types'

export type { PmCondClause, PmCondOp, PmCondRule, PmFreeRow, PmStateDef, PmStyle } from './pmsheet.types'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */


export interface PmPoBrief {
  poId: string
  poCode: string
  translatorId: string | null
  tranName: string | null
  volume: string | null
  eday: string | null
  edayTime: string | null
  approved: boolean
  moneyState: string | null
  coinCode: string | null
  state: string | null
}

export interface PmSheetRow {
  jobId: string
  jobCode: string
  jobName: string | null
  workCode: string | null
  jobType: string | null
  slang: string | null
  elang: string | null
  jobVolume: string | null
  jobEday: string | null
  jobEdayTime: string | null
  jobState: string | null
  projectId: string
  prjCode: string
  prjName: string | null
  prjState: string | null
  customerId: string | null
  cusCodeName: string | null
  cusMgrName: string | null
  prjMgrName: string | null
  handoverAt: string | null
  tr: PmPoBrief | null
  rv: PmPoBrief | null
  pmState: string | null
  fields: Record<string, string>
  rowStyle: PmStyle
  ordNo: number | null
  groupMonthly: boolean
  mergedInto: string | null
  /** 시트 주인이 마지막으로 확인한 뒤 다른 사람이 바꾼 연동 칸 (db/012). */
  changedKeys: string[]
  /** 이 작업의 기다리는 재인계 (있으면). */
  rehandoverId: string | null
}

export interface PmSheetCell {
  jobId: string
  colKey: string
  value: string | null
  style: PmStyle
  note: string | null
}

/** 사용자 열(가제 열). */
export interface PmCustomColumn {
  id: string
  label: string
}

/** `prefs.columns` — 열 순서·너비·열 꾸밈·추가 열. */
export interface PmColumnsPref {
  order?: string[]
  widths?: Record<string, number>
  styles?: Record<string, PmStyle>
  custom?: PmCustomColumn[]
  hidden?: string[]
  /** 진행 상태 목록·색·연동 (개인 설정). 없으면 기본 목록. */
  states?: PmStateDef[]
}

export interface PmFilterFavorite {
  id: string
  label: string
  filters: Record<string, string[]>
}

export interface PmViewPref {
  freezeCols?: number
  freezeRows?: number
  /** 글을 적은 빈 줄들. */
  freeRows?: PmFreeRow[]
  /** 시트 배율 (%) — 100 기준, 5 단위 (시트 주인 기준). */
  zoom?: number
  /** 작업 등록 창의 언어 즐겨찾기 (나만 적용). */
  langFav?: LangFav
}

/**
 * 작업 등록 창의 나만의 설정 (2026-11-25).
 *   langs — ☆ 한 언어 (목록 맨 위)
 *   src / tgt — 출발어 · 도착어 바로가기 단추 (`label` 은 우클릭으로 바꾼 이름)
 *   pmPresets — 담당PM 한 글자 빠른 단추 (예: '윤' = 김재윤)
 *   pairs — 예전(언어쌍 단추) 값. 더는 쓰지 않는다.
 */
export interface LangFav {
  langs?: string[]
  src?: { code: string; label?: string | null }[]
  tgt?: { code: string; label?: string | null }[]
  pmPresets?: { label: string; staffId: string; name: string }[]
  pairs?: { s: string; e: string; label?: string | null }[]
  /** 언어·PM 템플릿 (팀장님 2026-11-26) — 출발어 + 도착어별 담당PM 을 한 번에. 나만 보는 개인 설정. */
  templates?: LangTemplate[]
}

export interface LangTemplate {
  id: string
  /** 우클릭으로 바꾼 이름. 없으면 `auto`. */
  label?: string | null
  /** 저장할 때 만든 이름 — `고객사명·언어명` (도착어 둘 이상이면 `고객사명·23L`). */
  auto: string
  src: string
  targets: { lang: string; pmId: string | null; pmName: string | null }[]
}

export interface PmPrefs {
  columns?: PmColumnsPref
  cf?: { rules?: PmCondRule[]; defaults?: boolean }
  filters?: { favorites?: PmFilterFavorite[] }
  shortcuts?: { map?: Record<string, string> }
  view?: PmViewPref
}

export interface PmSheetView {
  staff: { id: string; name: string }
  mine: boolean
  rows: PmSheetRow[]
  cells: PmSheetCell[]
  prefs: PmPrefs
  pendingHandovers: number
}

export interface PmHandover {
  id: string
  jobId: string
  status: number
  message: string | null
  reply: string | null
  snapshot: Record<string, unknown>
  changedKeys: string[]
  fromStaffId: string | null
  fromName: string | null
  toStaffId: string
  toName: string | null
  createdAt: string
  answeredAt: string | null
  /** 이미 받는 사람 시트에 있는 작업을 다시 넘긴 인계 — 확인·수정 요청만 (db/012). */
  rehandover: boolean
}

export interface PmNotice {
  id: string
  kind: 'handover' | 'rehandover' | 'revision' | 'reject' | 'accept'
  jobId: string | null
  handoverId: string | null
  message: string | null
  fromName: string | null
  createdAt: string
  read: boolean
  jobCode: string | null
  jobName: string | null
  prjCode: string | null
}

export interface PmStaff {
  id: string
  name: string
  rows: number
}

export interface PmTranslatorSuggestion {
  translatorId: string
  name: string
  lastHandoverAt: string | null
  prjCode: string | null
  times: number
}

/** PM 진행 상태(기획서). 서버 `PM_STATES` 와 같은 목록·순서. */
export const PM_STATES = [
  '인계 수령',
  '배포 대기',
  '선편집 요청',
  '선편집 중',
  '선편집 완',
  '번역 의뢰',
  '번역 중',
  '번역 완',
  '감수 의뢰',
  '감수 중',
  '감수 완',
  '후편집 요청',
  '후편집 중',
  '후편집 완',
  '납품 대기',
  '납품 완료',
  '홀딩/캔슬',
  '별도 관리 프로젝트(시작)',
  '별도 관리 프로젝트(종료)',
] as const

export const GROUP_START = '별도 관리 프로젝트(시작)'
export const GROUP_END = '별도 관리 프로젝트(종료)'

/* -------------------------------------------------------------------------- */
/* Fetchers                                                                   */
/* -------------------------------------------------------------------------- */

const qs = (staffId?: string | null) => (staffId ? `?staffId=${encodeURIComponent(staffId)}` : '')

export const fetchPmSheet = (staffId: string | null, signal?: AbortSignal) =>
  neotmsApi<PmSheetView>(`/api/v0/pm-sheet${qs(staffId)}`, { signal })

export const fetchPmStaff = (signal?: AbortSignal) => neotmsApi<PmStaff[]>('/api/v0/pm-sheet/staff', { signal })

export const fetchPendingHandovers = (staffId: string | null, signal?: AbortSignal) =>
  neotmsApi<(PmHandover & { row: PmSheetRow })[]>(`/api/v0/pm-sheet/handovers${qs(staffId)}`, { signal })

export const fetchNotices = (signal?: AbortSignal) =>
  neotmsApi<{ items: PmNotice[]; unread: number; pendingHandovers: number }>('/api/v0/me/notices', { signal })

export const fetchProjectHandovers = (projectId: string, signal?: AbortSignal) =>
  neotmsApi<PmHandover[]>(`/api/v0/projects/${encodeURIComponent(projectId)}/job-handovers`, { signal })

export const fetchTranslatorSuggestions = (jobId: string, signal?: AbortSignal) =>
  neotmsApi<PmTranslatorSuggestion[]>(
    `/api/v0/pm-sheet/translator-suggestions?jobId=${encodeURIComponent(jobId)}`,
    { signal },
  )

export type PmRowPatch = {
  staffId?: string
  jobId: string
  pmState?: string | null
  fields?: Record<string, string>
  rowStyle?: PmStyle
  ordNo?: number | null
  groupMonthly?: boolean
  mergedInto?: string | null
  hidden?: boolean
}

export type PmCellWrite = {
  jobId: string
  colKey: string
  value?: string | null
  style?: PmStyle
  note?: string | null
}

export const patchPmRow = (input: PmRowPatch) =>
  neotmsApi<{ saved: boolean; prjState: string | null }>('/api/v0/pm-sheet/rows', { method: 'PUT', body: input })

export const writePmCells = (staffId: string | undefined, items: PmCellWrite[]) =>
  neotmsApi<{ saved: number }>('/api/v0/pm-sheet/cells', { method: 'PUT', body: { staffId, items } })

export const orderPmRows = (staffId: string | undefined, items: { jobId: string; ordNo: number }[]) =>
  neotmsApi<{ saved: number }>('/api/v0/pm-sheet/rows/order', { method: 'PUT', body: { staffId, items } })

/** 바뀐 칸 확인 — `keys` 가 없으면 그 행의 모든 칸. 남은 칸이 없으면 기다리는 재인계도 확인된다. */
export const confirmPmSeen = (staffId: string | undefined, jobIds: string[], keys?: string[]) =>
  neotmsApi<{ confirmed: number; rehandoversConfirmed: number }>('/api/v0/pm-sheet/seen', { method: 'POST', body: { staffId, jobIds, keys } })

export const writePmPref = (staffId: string | undefined, kind: keyof PmPrefs, data: unknown) =>
  neotmsApi<{ saved: boolean }>(`/api/v0/pm-sheet/prefs/${kind}`, { method: 'PUT', body: { staffId, data } })

export const createHandovers = (jobIds: string[], message: string | null) =>
  neotmsApi<{ created: number; skipped: { jobId: string; reason: string }[] }>('/api/v0/pm-sheet/handovers', {
    method: 'POST',
    body: { jobIds, message },
  })

/** 프로젝트의 '인계' — 고른 작업을 담당PM 에게, `send` 면 PM 마다 인계 메일까지 (팀장님 2026-11-25). */
export type JobHandoverInput = {
  jobIds: string[]
  formats: string[]
  formatText: string
  layouts: string[]
  layoutText: string
  note: string
  /** 경로 — 기본은 프로젝트 경로. 이 인계에만 쓴다. */
  path: string
  cc: string[]
  send: boolean
  hiworksId?: string
  hiworksPassword?: string
}
export type JobHandoverResult = {
  created: number
  skipped: { jobId: string; reason: string }[]
  mails: { pmName: string; recipient: string; subject: string; sent: boolean; error?: string }[]
}
export const sendJobHandover = (projectId: string, input: JobHandoverInput) =>
  neotmsApi<JobHandoverResult>(`/api/v0/projects/${encodeURIComponent(projectId)}/handover`, { method: 'POST', body: input })

/** 인계 메일 미리보기 — 저장·발송 없음 (팀장님 2026-11-25). */
export const previewJobHandover = (projectId: string, input: JobHandoverInput) =>
  neotmsApi<{ subject: string; html: string; recipients: string[] }>(
    `/api/v0/projects/${encodeURIComponent(projectId)}/handover/preview`,
    { method: 'POST', body: input },
  )

export const answerHandover = (id: string, action: 'accept' | 'revision' | 'reject', reply: string | null) =>
  neotmsApi<{ status: number }>(`/api/v0/pm-sheet/handovers/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    body: { action, reply },
  })

export const readNotices = (ids: string[] | null) =>
  neotmsApi<{ read: number }>('/api/v0/me/notices/read', { method: 'POST', body: { ids } })

/* -------------------------------------------------------------------------- */
/* Hooks                                                                      */
/* -------------------------------------------------------------------------- */

export const pmKeys = {
  all: ['workspace', 'pm'] as const,
  sheet: (staffId: string | null) => ['workspace', 'pm', 'sheet', staffId ?? 'me'] as const,
  staff: ['workspace', 'pm', 'staff'] as const,
  handovers: (staffId: string | null) => ['workspace', 'pm', 'handovers', staffId ?? 'me'] as const,
  notices: ['workspace', 'pm', 'notices'] as const,
  project: (id: string) => ['workspace', 'pm', 'project', id] as const,
  suggestions: (jobId: string) => ['workspace', 'pm', 'suggest', jobId] as const,
}

/** 내 개인 설정 문서들 (시트 없이). 시트 밖 화면(작업 등록의 언어 즐겨찾기)이 쓴다. */
export const fetchMyPmPrefs = (signal?: AbortSignal) => neotmsApi<PmPrefs>('/api/v0/pm-sheet/prefs', { signal })

const myPrefsKey = ['workspace', 'pm', 'myprefs'] as const

export function useMyPmPrefs() {
  return useQuery({ queryKey: myPrefsKey, queryFn: ({ signal }) => fetchMyPmPrefs(signal), staleTime: 60_000, retry: false })
}

/**
 * 언어 즐겨찾기 저장. `view` 문서를 통째로 쓰므로, 쓰기 직전에 최신 문서를 다시 읽어 다른 값
 * (시트의 틀 고정·빈 줄)을 지우지 않는다.
 */
export function useSaveLangFav() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (langFav: LangFav) => {
      const fresh = await fetchMyPmPrefs()
      await writePmPref(undefined, 'view', { ...(fresh.view ?? {}), langFav })
    },
    onMutate: (langFav) => {
      qc.setQueryData<PmPrefs>(myPrefsKey, (old) => ({ ...(old ?? {}), view: { ...(old?.view ?? {}), langFav } }))
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: pmKeys.all }),
  })
}

export function usePmSheet(staffId: string | null) {
  return useQuery({
    queryKey: pmKeys.sheet(staffId),
    queryFn: ({ signal }) => fetchPmSheet(staffId, signal),
    staleTime: 15_000,
    // 다른 사람이 프로젝트·작업 창에서 바꾼 값이 보이도록 2분마다 다시 읽는다 (팀장님 2026-11-25).
    refetchInterval: 120_000,
  })
}

export function usePmStaff(enabled = true) {
  return useQuery({ queryKey: pmKeys.staff, queryFn: ({ signal }) => fetchPmStaff(signal), enabled })
}

export function usePendingHandovers(staffId: string | null) {
  return useQuery({
    queryKey: pmKeys.handovers(staffId),
    queryFn: ({ signal }) => fetchPendingHandovers(staffId, signal),
    refetchInterval: 60_000,
  })
}

/** 알림. 1분마다 다시 묻는다 — 브라우저 알림과 배지가 이것을 본다. */
export function useNotices(enabled = true) {
  return useQuery({
    queryKey: pmKeys.notices,
    queryFn: ({ signal }) => fetchNotices(signal),
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
    enabled,
  })
}

export function useProjectHandovers(projectId: string) {
  return useQuery({
    queryKey: pmKeys.project(projectId),
    queryFn: ({ signal }) => fetchProjectHandovers(projectId, signal),
  })
}

export function useTranslatorSuggestions(jobId: string | null) {
  return useQuery({
    queryKey: pmKeys.suggestions(jobId ?? ''),
    queryFn: ({ signal }) => fetchTranslatorSuggestions(jobId ?? '', signal),
    enabled: !!jobId,
    staleTime: 60_000,
  })
}

export function useCreateHandovers() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ jobIds, message }: { jobIds: string[]; message: string | null }) =>
      createHandovers(jobIds, message),
    onSuccess: () => void qc.invalidateQueries({ queryKey: pmKeys.all }),
  })
}

export function useSendJobHandover() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ projectId, input }: { projectId: string; input: JobHandoverInput }) => sendJobHandover(projectId, input),
    // 인계는 작업 상태(대기→진행)와 인계 여부도 바꾼다 — 작업 목록까지 모두 새로.
    onSuccess: () => void qc.invalidateQueries(),
  })
}

export function useAnswerHandover() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action, reply }: { id: string; action: 'accept' | 'revision' | 'reject'; reply: string | null }) =>
      answerHandover(id, action, reply),
    onSuccess: () => void qc.invalidateQueries({ queryKey: pmKeys.all }),
  })
}

export function useReadNotices() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[] | null) => readNotices(ids),
    onSuccess: () => void qc.invalidateQueries({ queryKey: pmKeys.notices }),
  })
}
