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
  /** 글자가 넘칠 때: 넘치기(기본) / 자동 줄바꿈 / 자르기. */
  wrap?: 'overflow' | 'wrap' | 'clip' | null
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

/**
 * 진행 상태 하나 (개인 설정 — `prefs.columns.states`, 다른 사람에게는 보이지 않는다).
 *
 * 기본 상태는 이름을 바꿀 수 없고 프로젝트 연동도 정해져 있다(서버가 이름으로 판단).
 * 사용자가 추가한 상태는 `prj` 로 프로젝트 진행상태를 고른다 — null 이면 연동하지 않는다.
 */
export interface PmStateDef {
  name: string
  builtin?: boolean
  /** 목록에서 뺀 기본 상태 (지운 것과 같지만 '기본값' 으로 되살릴 수 있게 남긴다). */
  hidden?: boolean
  prj?: '진행' | '완료' | '보류' | null
  bg?: string | null
  fg?: string | null
  bold?: boolean | null
  /** 칠할 곳: 그 칸만 / 행 전체 / 열 범위. */
  span?: 'cell' | 'row' | 'range'
  from?: string | null
  to?: string | null
}
