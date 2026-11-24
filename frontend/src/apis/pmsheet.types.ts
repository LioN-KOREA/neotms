/**
 * PM 시트의 꾸밈·조건부 서식 타입. 아무것도 import 하지 않는다 — 서버 테스트(jest)가 화면 코드를
 * 끌어오지 않고 조건부 서식 로직을 시험할 수 있게.
 */
/** 칸·행·열의 꾸밈. 없는 속성은 '물려받음'. */
export interface PmStyle {
  bg?: string | null
  fg?: string | null
  size?: number | null
  bold?: boolean | null
  italic?: boolean | null
  underline?: boolean | null
  strike?: boolean | null
  align?: 'left' | 'center' | 'right' | null
  valign?: 'top' | 'middle' | 'bottom' | null
  border?: 'none' | 'thin' | 'thick' | null
  /** 테두리를 그릴 변: t·b·l·r 조합. */
  borderSides?: string | null
  borderColor?: string | null
  decimals?: number | null
}

/** 조건부 서식 규칙 하나. */
export type PmCondOp =
  | 'contains'
  | 'notContains'
  | 'empty'
  | 'notEmpty'
  | 'equals'
  | 'dateBefore'
  | 'dateOn'
  | 'dateAfter'

export interface PmCondClause {
  /** 조건을 볼 열. 비우면 서식을 칠할 그 칸 자신. */
  column?: string | null
  op: PmCondOp
  /** 글자 조건의 값, 또는 날짜 조건의 기준일(`today` 또는 `YYYY-MM-DD`). */
  value?: string
}

export interface PmCondRule {
  id: string
  name?: string
  /** 서식을 칠할 열들. */
  columns: string[]
  join: 'and' | 'or'
  clauses: PmCondClause[]
  style: PmStyle
  /** 행 전체를 칠할지. */
  wholeRow?: boolean
  enabled?: boolean
}
