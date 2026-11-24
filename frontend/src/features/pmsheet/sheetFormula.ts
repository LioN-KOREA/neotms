/**
 * 시트 수식 — 추가 열(가제 열) 칸에 `=` 로 시작하는 글자를 적으면 계산해서 보인다.
 *
 * 기획서 요구: 기본 계산(더하기, 빼기, 곱하기, 나누기, SUM), IF.
 *
 * ## 칸을 가리키는 방법: `[열 이름]`
 *
 * 엑셀의 `A1` 주소를 쓰지 않는다. 이 시트는 열을 끌어 옮기고 행을 정렬·필터하므로, 위치로
 * 가리키는 주소는 옮기는 순간 다른 칸을 가리키게 된다. 대신 **같은 행의 열 이름**으로 가리킨다:
 *
 *     =[원본 분량] * 0.9
 *     =SUM([번역 분량], [감수 분량])
 *     =IF([진행 상태] = "납품 완료", "끝", "진행 중")
 *
 * 지원: 숫자, "글자", + - * / ^, & (글자 잇기), = <> < > <= >=, 괄호,
 *       SUM, AVERAGE, MIN, MAX, ROUND, IF, AND, OR, NOT, LEN, TODAY.
 * 계산할 수 없으면 `#오류` 를 보이고, 마우스를 올리면 이유를 보인다.
 */

import { asNumber, todayYmd } from './sheetFormat'

export type FormulaValue = number | string | boolean

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; v: string }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }

class FormulaError extends Error {}

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (/\s/.test(c)) {
      i += 1
      continue
    }
    if (/[0-9.]/.test(c)) {
      let j = i
      while (j < src.length && /[0-9.,]/.test(src[j]!)) j += 1
      const n = Number(src.slice(i, j).replace(/,/g, ''))
      if (!Number.isFinite(n)) throw new FormulaError(`숫자를 읽을 수 없습니다: ${src.slice(i, j)}`)
      out.push({ t: 'num', v: n })
      i = j
      continue
    }
    if (c === '"') {
      const j = src.indexOf('"', i + 1)
      if (j < 0) throw new FormulaError('따옴표가 닫히지 않았습니다.')
      out.push({ t: 'str', v: src.slice(i + 1, j) })
      i = j + 1
      continue
    }
    if (c === '[') {
      const j = src.indexOf(']', i + 1)
      if (j < 0) throw new FormulaError('[열 이름] 의 ] 가 없습니다.')
      out.push({ t: 'ref', v: src.slice(i + 1, j).trim() })
      i = j + 1
      continue
    }
    const two = src.slice(i, i + 2)
    if (two === '<=' || two === '>=' || two === '<>') {
      out.push({ t: 'op', v: two })
      i += 2
      continue
    }
    if ('+-*/^&=<>(),'.includes(c)) {
      out.push({ t: 'op', v: c })
      i += 1
      continue
    }
    if (/[A-Za-z가-힣_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9가-힣_]/.test(src[j]!)) j += 1
      out.push({ t: 'id', v: src.slice(i, j).toUpperCase() })
      i = j
      continue
    }
    throw new FormulaError(`알 수 없는 글자: ${c}`)
  }
  return out
}

const toNum = (v: FormulaValue): number => {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v.trim() === '') return 0
  const n = asNumber(v)
  if (n === null) throw new FormulaError(`'${v}' 는 숫자가 아닙니다.`)
  return n
}
const toStr = (v: FormulaValue): string => (typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v))
const toBool = (v: FormulaValue): boolean => (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : v.length > 0)

/** 비교: 둘 다 숫자로 읽히면 숫자로, 아니면 글자로. */
function compare(a: FormulaValue, b: FormulaValue): number {
  const na = typeof a === 'number' ? a : asNumber(toStr(a))
  const nb = typeof b === 'number' ? b : asNumber(toStr(b))
  if (na !== null && nb !== null) return na - nb
  return toStr(a).localeCompare(toStr(b))
}

/** 재귀 하강 파서. 우선순위: 비교 < & < 더하기·빼기 < 곱하기·나누기 < ^ < 단항. */
class Parser {
  private i = 0
  private readonly tokens: Token[]
  private readonly ref: (name: string) => FormulaValue
  constructor(tokens: Token[], ref: (name: string) => FormulaValue) {
    this.tokens = tokens
    this.ref = ref
  }

  private peek(): Token | undefined {
    return this.tokens[this.i]
  }
  private isOp(v: string): boolean {
    const tk = this.peek()
    return !!tk && tk.t === 'op' && tk.v === v
  }
  private expect(v: string) {
    if (!this.isOp(v)) throw new FormulaError(`'${v}' 가 필요합니다.`)
    this.i += 1
  }

  parse(): FormulaValue {
    const v = this.comparison()
    if (this.i < this.tokens.length) throw new FormulaError('수식 끝에 남은 글자가 있습니다.')
    return v
  }

  private comparison(): FormulaValue {
    let left = this.concat()
    for (;;) {
      const tk = this.peek()
      if (!tk || tk.t !== 'op' || !['=', '<>', '<', '>', '<=', '>='].includes(tk.v)) return left
      this.i += 1
      const right = this.concat()
      const c = compare(left, right)
      left =
        tk.v === '=' ? c === 0 : tk.v === '<>' ? c !== 0 : tk.v === '<' ? c < 0 : tk.v === '>' ? c > 0 : tk.v === '<=' ? c <= 0 : c >= 0
    }
  }
  private concat(): FormulaValue {
    let left = this.additive()
    while (this.isOp('&')) {
      this.i += 1
      left = toStr(left) + toStr(this.additive())
    }
    return left
  }
  private additive(): FormulaValue {
    let left = this.term()
    for (;;) {
      if (this.isOp('+')) {
        this.i += 1
        left = toNum(left) + toNum(this.term())
      } else if (this.isOp('-')) {
        this.i += 1
        left = toNum(left) - toNum(this.term())
      } else return left
    }
  }
  private term(): FormulaValue {
    let left = this.power()
    for (;;) {
      if (this.isOp('*')) {
        this.i += 1
        left = toNum(left) * toNum(this.power())
      } else if (this.isOp('/')) {
        this.i += 1
        const d = toNum(this.power())
        if (d === 0) throw new FormulaError('0 으로 나눌 수 없습니다.')
        left = toNum(left) / d
      } else return left
    }
  }
  private power(): FormulaValue {
    const base = this.unary()
    if (this.isOp('^')) {
      this.i += 1
      return toNum(base) ** toNum(this.power())
    }
    return base
  }
  private unary(): FormulaValue {
    if (this.isOp('-')) {
      this.i += 1
      return -toNum(this.unary())
    }
    if (this.isOp('+')) {
      this.i += 1
      return toNum(this.unary())
    }
    return this.primary()
  }
  private args(): FormulaValue[][] {
    // 각 인자를 값 하나로 — SUM(1,2,[a]) 처럼.
    this.expect('(')
    const list: FormulaValue[][] = []
    if (this.isOp(')')) {
      this.i += 1
      return list
    }
    for (;;) {
      list.push([this.comparison()])
      if (this.isOp(',')) {
        this.i += 1
        continue
      }
      this.expect(')')
      return list
    }
  }
  private primary(): FormulaValue {
    const tk = this.peek()
    if (!tk) throw new FormulaError('수식이 끝났습니다.')
    if (tk.t === 'num' || tk.t === 'str') {
      this.i += 1
      return tk.v
    }
    if (tk.t === 'ref') {
      this.i += 1
      return this.ref(tk.v)
    }
    if (tk.t === 'op' && tk.v === '(') {
      this.i += 1
      const v = this.comparison()
      this.expect(')')
      return v
    }
    if (tk.t === 'id') {
      this.i += 1
      if (tk.v === 'TRUE') return true
      if (tk.v === 'FALSE') return false
      const flat = () => this.args().flat()
      switch (tk.v) {
        case 'SUM':
          return flat().reduce<number>((s, v) => s + toNum(v), 0)
        case 'AVERAGE': {
          const xs = flat().map(toNum)
          if (xs.length === 0) throw new FormulaError('AVERAGE 에 값이 없습니다.')
          return xs.reduce((s, v) => s + v, 0) / xs.length
        }
        case 'MIN':
          return Math.min(...flat().map(toNum))
        case 'MAX':
          return Math.max(...flat().map(toNum))
        case 'ROUND': {
          const [x, d] = flat()
          const p = 10 ** toNum(d ?? 0)
          return Math.round(toNum(x ?? 0) * p) / p
        }
        case 'IF': {
          const [c, a, b] = flat()
          if (c === undefined) throw new FormulaError('IF(조건, 참일 때, 거짓일 때)')
          return toBool(c) ? (a ?? '') : (b ?? '')
        }
        case 'AND':
          return flat().every(toBool)
        case 'OR':
          return flat().some(toBool)
        case 'NOT':
          return !toBool(flat()[0] ?? false)
        case 'LEN':
          return toStr(flat()[0] ?? '').length
        case 'TODAY':
          this.args()
          return todayYmd()
        default:
          throw new FormulaError(`모르는 함수: ${tk.v}`)
      }
    }
    throw new FormulaError(`여기에 '${tk.v}' 가 올 수 없습니다.`)
  }
}

export const isFormula = (text: string | null | undefined): text is string =>
  !!text && text.trim().startsWith('=') && text.trim().length > 1

/**
 * 수식을 계산한다. `ref` 는 같은 행의 `[열 이름]` 값을 돌려준다(없는 열이면 throw).
 * 결과 `{ ok: false }` 의 `reason` 은 칸의 툴팁으로 보인다.
 */
export function evaluateFormula(
  text: string,
  ref: (name: string) => FormulaValue,
): { ok: true; value: FormulaValue } | { ok: false; reason: string } {
  try {
    const tokens = tokenize(text.trim().slice(1))
    const value = new Parser(tokens, (name) => {
      try {
        return ref(name)
      } catch (err) {
        throw new FormulaError(err instanceof Error ? err.message : `열 [${name}] 이 없습니다.`)
      }
    }).parse()
    if (typeof value === 'number' && !Number.isFinite(value)) return { ok: false, reason: '계산 결과가 숫자가 아닙니다.' }
    return { ok: true, value }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : '수식을 계산할 수 없습니다.' }
  }
}
