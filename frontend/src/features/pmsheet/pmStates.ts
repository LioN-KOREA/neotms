/**
 * 진행 상태 — 기본 목록·기본 색, 그리고 사람마다의 설정(⚙)을 합친 '내 목록'.
 *
 * 기본 색은 팀장님이 주신 구글 시트 캡처(2026-11-25)의 색이다. 그 시트의 상태 이름은 이 목록과
 * 조금 달라서(선작업↔선편집, 후작업↔후편집, 대기 중↔인계 수령·배포 대기, 캔슬↔홀딩/캔슬) 뜻이 같은
 * 것끼리 맞췄다. 별도 관리 두 상태는 묶음 테두리(#990000)가 따로 있어 색을 주지 않는다.
 *
 * 이 파일은 아무것도 화면에서 가져오지 않는다 — 서버 테스트가 그대로 불러 시험한다.
 */
import type { PmStateDef, PmStyle } from '../../apis/pmsheet.types'

/** 서버 `PM_STATES` 와 같은 순서. (테스트가 둘을 비교한다.) */
export const BUILTIN_STATES = [
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

const C = (bg: string, fg: string) => ({ bg, fg })

/** 캡처의 색 → 이 목록의 상태. */
const DEFAULT_COLORS: Record<string, { bg: string; fg: string }> = {
  '인계 수령': C('#FFCFC9', '#BB332F'), // 대기 중
  '배포 대기': C('#FFCFC9', '#BB332F'), // 대기 중
  '선편집 요청': C('#E6CFF2', '#795A97'), // 선작업 의뢰
  '선편집 중': C('#D089F5', '#744897'),
  '선편집 완': C('#A51BEC', '#6B2C96'),
  '번역 의뢰': C('#BFE1F6', '#3374B2'),
  '번역 중': C('#669DF0', '#172536'),
  '번역 완': C('#0049B6', '#000811'),
  '감수 의뢰': C('#FFE5A0', '#584E32'),
  '감수 중': C('#F3CA62', '#363016'),
  '감수 완': C('#B89A00', '#111100'),
  '후편집 요청': C('#D4EDBC', '#3C8C64'), // 후작업 의뢰
  '후편집 중': C('#57C084', '#C8E9B5'),
  '후편집 완': C('#11734B', '#C2E2AE'),
  '납품 대기': C('#3D3D3D', '#D5D5D5'),
  '납품 완료': C('#CCCCCC', '#626162'),
  '홀딩/캔슬': C('#3D3D3D', '#CAC8CA'), // 캔슬
}

/** 기본 상태의 프로젝트 연동 (서버 `PmProjectStateSyncOps` 와 같은 규칙). */
export function builtinProjectState(name: string): PmStateDef['prj'] {
  if (name === '납품 완료') return '완료'
  if (name === '홀딩/캔슬') return '보류'
  if (name.startsWith('별도 관리')) return null
  return '진행'
}

export const DEFAULT_STATES: PmStateDef[] = BUILTIN_STATES.map((name) => ({
  name,
  builtin: true,
  prj: builtinProjectState(name),
  bg: DEFAULT_COLORS[name]?.bg ?? null,
  fg: DEFAULT_COLORS[name]?.fg ?? null,
  span: 'cell',
}))

const isBuiltin = (name: string) => (BUILTIN_STATES as readonly string[]).includes(name)

/**
 * 내 목록. 저장된 설정이 없으면 기본 목록. 있으면 그 순서대로 — 다만 기본 상태가 빠져 있으면
 * (나중에 기본 상태가 늘어난 경우) 끝에 붙이고, 기본 상태의 이름·연동은 늘 기본값을 쓴다.
 */
export function effectiveStates(saved: PmStateDef[] | undefined | null): PmStateDef[] {
  if (!saved || saved.length === 0) return DEFAULT_STATES
  const out: PmStateDef[] = []
  const seen = new Set<string>()
  for (const def of saved) {
    if (!def?.name || seen.has(def.name)) continue
    seen.add(def.name)
    out.push(isBuiltin(def.name) ? { ...def, builtin: true, prj: builtinProjectState(def.name) } : { ...def, builtin: false })
  }
  for (const def of DEFAULT_STATES) if (!seen.has(def.name)) out.push(def)
  return out
}

/** 드롭다운에 보일 이름들. */
export const selectableStates = (defs: PmStateDef[]) => defs.filter((d) => !d.hidden).map((d) => d.name)

/** 끝난 상태(프로젝트 완료·보류로 가는 것) — '오늘 할 일' 과 기본 날짜 색에서 뺀다. */
export function isClosedState(name: string | null | undefined, defs: PmStateDef[]): boolean {
  if (!name) return false
  const def = defs.find((d) => d.name === name)
  const prj = def ? def.prj : isBuiltin(name) ? builtinProjectState(name) : null
  return prj === '완료' || prj === '보류'
}

/**
 * 이 행의 진행 상태 색이 `colKey` 칸에 걸리는지, 걸리면 그 꾸밈.
 * `order` 는 지금 보이는 열 순서 — 범위(어느 열부터 어느 열까지)는 보이는 순서로 판단한다.
 */
export function stateStyleFor(
  state: string | null | undefined,
  colKey: string,
  order: readonly string[],
  defs: PmStateDef[],
): PmStyle | null {
  if (!state) return null
  const def = defs.find((d) => d.name === state)
  if (!def || (!def.bg && !def.fg && !def.bold)) return null
  const span = def.span ?? 'cell'
  let hit = false
  if (span === 'row') hit = true
  else if (span === 'cell') hit = colKey === 'pmState'
  else {
    const a = order.indexOf(def.from ?? 'pmState')
    const b = order.indexOf(def.to ?? 'pmState')
    const i = order.indexOf(colKey)
    if (a >= 0 && b >= 0 && i >= 0) hit = i >= Math.min(a, b) && i <= Math.max(a, b)
  }
  if (!hit) return null
  const out: PmStyle = {}
  if (def.bg) out.bg = def.bg
  if (def.fg) out.fg = def.fg
  if (def.bold) out.bold = true
  return out
}
