/**
 * 조건부 서식 — 사용자별 규칙 + 기본 규칙(날짜·시간 칸의 당일/과일, 당시/과시).
 *
 * 기획서:
 *   * 조건 모듈: 텍스트에 포함 / 포함되지 않음, 비어 있음 / 비어 있지 않음, 정확히 일치,
 *     기준일 이전 / 기준일 / 기준일 이후.
 *   * 여러 조건을 그리고(AND)/또는(OR) 로 묶는다 — 구글 시트는 맞춤 수식을 써야 하는 부분.
 *   * 규칙마다 적용할 열(범위)을 고른다.
 *   * 기본: 날짜 칸 당일 → #FF9900, 과일 → #3271EA (흰색 굵은 글씨). 시간 칸 당시/과시도 같다.
 *
 * 우선순위: 사용자 규칙(목록 위쪽이 먼저) > 기본 규칙 > 칸 꾸밈 > 행 꾸밈 > 열 꾸밈.
 * 구글 시트처럼 조건부 서식이 손으로 칠한 서식을 이긴다 — 조건이 풀리면 원래 서식이 돌아온다.
 */
import type { PmCondClause, PmCondRule, PmStyle } from '../../apis/pmsheet.types'
import { dayState, isYmd, todayYmd } from './sheetFormat'

export const TODAY_STYLE: PmStyle = { bg: '#FF9900', fg: '#FFFFFF', bold: true }
export const PAST_STYLE: PmStyle = { bg: '#3271EA', fg: '#FFFFFF', bold: true }

export const COND_OP_LABELS: Record<PmCondClause['op'], string> = {
  contains: '텍스트에 포함',
  notContains: '텍스트에 포함되지 않음',
  empty: '비어 있음',
  notEmpty: '비어 있지 않음',
  equals: '텍스트가 정확하게 일치함',
  dateBefore: '기준일 이전',
  dateOn: '기준일',
  dateAfter: '기준일 이후',
}

export const needsValue = (op: PmCondClause['op']) => op !== 'empty' && op !== 'notEmpty'
export const isDateOp = (op: PmCondClause['op']) => op === 'dateBefore' || op === 'dateOn' || op === 'dateAfter'

/** 기준일: `today` / `today+3` / `today-1` / `YYYY-MM-DD`. */
export function resolveDate(value: string | undefined, now: Date = new Date()): string | null {
  const v = (value ?? 'today').trim()
  const m = /^today\s*([+-]\s*\d+)?$/i.exec(v)
  if (m) {
    const shift = m[1] ? Number(m[1].replace(/\s/g, '')) : 0
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + shift)
    return todayYmd(d)
  }
  return isYmd(v) ? v : null
}

/**
 * 조건 하나. `raw` 는 저장된 값(날짜는 `YYYY-MM-DD`), `shown` 은 보이는 글자 —
 * 글자 조건은 보이는 글자로, 날짜 조건은 저장된 날짜로 본다.
 */
export function testClause(clause: PmCondClause, raw: string, shown: string, now: Date = new Date()): boolean {
  const text = shown.trim()
  const needle = (clause.value ?? '').trim()
  switch (clause.op) {
    case 'contains':
      return needle.length > 0 && text.toLowerCase().includes(needle.toLowerCase())
    case 'notContains':
      return needle.length === 0 || !text.toLowerCase().includes(needle.toLowerCase())
    case 'empty':
      return text.length === 0
    case 'notEmpty':
      return text.length > 0
    case 'equals':
      return text === needle
    case 'dateBefore':
    case 'dateOn':
    case 'dateAfter': {
      if (!isYmd(raw)) return false
      const base = resolveDate(clause.value, now)
      if (!base) return false
      return clause.op === 'dateBefore' ? raw < base : clause.op === 'dateOn' ? raw === base : raw > base
    }
    default:
      return false
  }
}

/** 칸 값을 읽는 함수: 열 키 → { raw, shown }. */
export type CellReader = (colKey: string) => { raw: string; shown: string }

export function testRule(rule: PmCondRule, selfKey: string, read: CellReader, now: Date = new Date()): boolean {
  if (rule.enabled === false || rule.clauses.length === 0) return false
  const results = rule.clauses.map((clause) => {
    const v = read(clause.column || selfKey)
    return testClause(clause, v.raw, v.shown, now)
  })
  return rule.join === 'or' ? results.some(Boolean) : results.every(Boolean)
}

/**
 * 한 칸에 걸리는 조건부 서식. 위의 규칙이 먼저 — 속성마다 처음 정해진 값이 이긴다.
 * `defaults` 가 false 면 기본 규칙(당일/과일)을 끈다.
 */
export function conditionalStyle(args: {
  rules: PmCondRule[]
  colKey: string
  read: CellReader
  defaultKind: 'date' | 'hour' | null
  defaultState: 'today' | 'past' | 'now' | null
  defaults: boolean
  now?: Date
}): PmStyle | null {
  const layers: PmStyle[] = []
  for (const rule of args.rules) {
    const applies = rule.wholeRow || rule.columns.includes(args.colKey)
    if (applies && testRule(rule, args.colKey, args.read, args.now)) layers.push(rule.style)
  }
  if (args.defaults && args.defaultKind && args.defaultState) {
    layers.push(args.defaultState === 'past' ? PAST_STYLE : TODAY_STYLE)
  }
  if (layers.length === 0) return null
  const out: PmStyle = {}
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (v !== null && v !== undefined && (out as Record<string, unknown>)[k] === undefined) {
        ;(out as Record<string, unknown>)[k] = v
      }
    }
  }
  return out
}

export { dayState }
