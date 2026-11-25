/**
 * PM 업무 시트의 기본 열 — 기획서 예시 시트("TMS 운영 PM 업무시트")의 열 구성 그대로.
 *
 * 한 행 = 작업(JOB) 하나. 번역가와 감수자가 한 줄에 같이 있다: 번역 PO 는 작업의 첫 '감수가 아닌'
 * PO, 감수 PO 는 첫 '감수' PO 다(서버 `NeotmsPmSheet.dbops` 머리말).
 *
 * `source` 는 이 칸을 고치면 **무엇이 바뀌는지**:
 *   * `readonly` — 못 고친다. 프로젝트·고객 값과 코드값. 그건 프로젝트 화면의 일이다.
 *   * `job`      — 작업이 바뀐다 (PATCH /jobs/:id) — TMS 연동.
 *   * `tr`/`rv`  — 번역/감수 PO 가 바뀐다 (PATCH /purchase-orders/:id) — TMS 연동.
 *   * `row`      — 이 시트의 행 값 (진행 상태, 업무, 비고, 백업, 경로). 진행 상태는 프로젝트
 *                  진행상태를 함께 바꾼다(서버가 계산).
 *   * `custom`   — 사용자가 만든 가제 열.
 */
import type { PmColumnsPref, PmStyle } from '@/apis/pmsheet.api'
import { DEFAULT_COLUMN_STYLES } from './columnDefaults'

export type SheetKind = 'text' | 'date' | 'hour' | 'number' | 'dropdown' | 'combo' | 'picker' | 'link' | 'flag'
export type SheetSource = 'readonly' | 'job' | 'tr' | 'rv' | 'row' | 'custom'

export interface SheetColumnSpec {
  key: string
  label: string
  width: number
  kind: SheetKind
  source: SheetSource
  /** 날짜 칸과 짝인 시간 칸이 보는 날짜 열 (당시/과시 판정). */
  pairDate?: string
  /** 기본 조건부 서식(오늘·지난 날짜/시각)을 받는 칸. 기획서: 날짜·시간 '입력란'. */
  defaultCf?: 'date' | 'hour'
  hint?: string
}

export const TASK_OPTIONS = ['번역', '대조감수', '교정교열', 'LQA', 'LSO']

export const FIXED_COLUMNS: readonly SheetColumnSpec[] = [
  { key: 'rowNo', label: '행ID', width: 56, kind: 'text', source: 'readonly' },
  { key: 'handoverAt', label: '인계일', width: 96, kind: 'date', source: 'readonly', hint: '인계 받은 날 (인계 시트에서 "인계 받기"를 누른 날)' },
  { key: 'cusCodeName', label: '업체명', width: 140, kind: 'text', source: 'readonly' },
  { key: 'cusMgrName', label: '업체 담당', width: 96, kind: 'text', source: 'readonly' },
  { key: 'prjMgrName', label: '영업 담당', width: 84, kind: 'text', source: 'readonly' },
  { key: 'lang', label: '번역어', width: 130, kind: 'text', source: 'readonly', hint: '출발어→도착어 (작업 화면에서 바꿉니다)' },
  { key: 'task', label: '업무', width: 90, kind: 'combo', source: 'row', hint: '번역·대조감수·교정교열·LQA·LSO 또는 직접 입력' },
  { key: 'translator', label: '번역가', width: 116, kind: 'picker', source: 'tr' },
  { key: 'trVolume', label: '원본 분량', width: 88, kind: 'number', source: 'tr' },
  { key: 'trPo', label: 'PO', width: 52, kind: 'flag', source: 'readonly', hint: '번역 PO 발행 여부' },
  { key: 'trEday', label: '번역본 도착일', width: 104, kind: 'date', source: 'tr', defaultCf: 'date' },
  { key: 'trTime', label: '시간', width: 48, kind: 'hour', source: 'tr', pairDate: 'trEday', defaultCf: 'hour' },
  { key: 'reviewer', label: '감수자', width: 116, kind: 'picker', source: 'rv' },
  { key: 'rvVolume', label: '감수 분량', width: 88, kind: 'number', source: 'rv' },
  { key: 'rvPo', label: 'PO', width: 52, kind: 'flag', source: 'readonly', hint: '감수 PO 발행 여부' },
  { key: 'rvEday', label: '감수본 도착일', width: 104, kind: 'date', source: 'rv', defaultCf: 'date' },
  { key: 'rvTime', label: '시간', width: 48, kind: 'hour', source: 'rv', pairDate: 'rvEday', defaultCf: 'hour' },
  { key: 'jobEday', label: '납품일', width: 104, kind: 'date', source: 'job', defaultCf: 'date' },
  { key: 'jobTime', label: '시간', width: 48, kind: 'hour', source: 'job', pairDate: 'jobEday', defaultCf: 'hour' },
  { key: 'pmState', label: '진행 상태', width: 128, kind: 'dropdown', source: 'row' },
  { key: 'remark', label: '비고', width: 180, kind: 'text', source: 'row' },
  { key: 'backup', label: '백업', width: 84, kind: 'text', source: 'row' },
  { key: 'prjCode', label: 'PRCODE', width: 112, kind: 'link', source: 'readonly', hint: '누르면 프로젝트 화면이 열립니다' },
  { key: 'path', label: '경로', width: 180, kind: 'text', source: 'row' },
]

/** 행 값(`fields`)에 저장되는 기본 열. */
export const ROW_FIELD_KEYS = new Set(['task', 'remark', 'backup', 'path'])

export const CUSTOM_PREFIX = 'c:'
export const isCustomKey = (key: string) => key.startsWith(CUSTOM_PREFIX)

export interface SheetColumn {
  key: string
  label: string
  width: number
  spec: SheetColumnSpec
  style: PmStyle
}

export const CUSTOM_WIDTH = 140

/**
 * 코드의 기본 열 + 사용자 설정(순서·너비·열 꾸밈·가제 열·숨긴 열)을 합친다.
 * 설정에 없는 기본 열은 코드 순서대로 뒤에 붙는다 — 새 기본 열이 남의 시트 맨 앞에 끼어들지 않게.
 */
export function buildColumns(pref: PmColumnsPref | undefined): SheetColumn[] {
  const custom = (pref?.custom ?? []).map(
    (c): SheetColumnSpec => ({ key: `${CUSTOM_PREFIX}${c.id}`, label: c.label, width: CUSTOM_WIDTH, kind: 'text', source: 'custom' }),
  )
  const all = [...FIXED_COLUMNS, ...custom]
  const byKey = new Map(all.map((s) => [s.key, s]))
  const hidden = new Set(pref?.hidden ?? [])
  const order: string[] = []
  for (const key of pref?.order ?? []) if (byKey.has(key) && !order.includes(key)) order.push(key)
  for (const s of all) if (!order.includes(s.key)) order.push(s.key)
  return order
    .filter((key) => !hidden.has(key))
    .map((key) => {
      const spec = byKey.get(key)!
      return {
        key,
        label: spec.label,
        width: pref?.widths?.[key] ?? spec.width,
        spec,
        style: { ...(DEFAULT_COLUMN_STYLES[key] ?? {}), ...(pref?.styles?.[key] ?? {}) },
      }
    })
}

/** 칸 → 행 → 열 순서로 꾸밈을 합친다. 가장 좁은 것이 이긴다, 속성마다 따로. */
export function mergeStyle(...layers: (PmStyle | null | undefined)[]): PmStyle {
  const out: PmStyle = {}
  for (const layer of layers) {
    if (!layer) continue
    for (const [k, v] of Object.entries(layer) as [keyof PmStyle, unknown][]) {
      if (v !== null && v !== undefined && out[k] === undefined) (out as Record<string, unknown>)[k] = v
    }
  }
  return out
}
