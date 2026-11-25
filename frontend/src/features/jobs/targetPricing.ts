/**
 * 작업 등록의 '언어별 설정' 계산 (팀장님 2026-11-25, 참고: 세부작업 UI task_form.py).
 *
 *   액면 물량 = 물량 ÷ 기준 (소수 첫째 자리 반올림, 손으로 고칠 수 있음)
 *   합산      = 단가 방식: 액면 물량 × 단가 · 고정가격: 단가 칸의 금액 · 무료: 0
 *   총 합산   = Σ 합산 − 할인금액
 *
 * 저장하면 도착어마다 작업이 하나씩 생기고, 할인은 **언어별 합산 비율로** 나눠 넣는다
 * (원 단위 끝수는 첫 작업). 그래서 작업마다 `합계 = 합산 − 나눈 할인` 이고, 작업들의 합계를
 * 더하면 화면의 총 합산과 정확히 같다.
 *
 * 금액은 JS 숫자를 거치지 않는다 — 1/100 단위 BigInt 로 계산한다 (money.ts 와 같은 원칙).
 * 화면 코드(DOM)를 가져오지 않는다 — 서버 쪽 테스트가 그대로 시험한다.
 */

export type PriceMode = 'unit' | 'fixed' | 'free'

export const PRICE_MODES: readonly { value: PriceMode; label: string }[] = [
  { value: 'unit', label: '단가' },
  { value: 'fixed', label: '고정가격' },
  { value: 'free', label: '무료' },
]

/** 단위별 기준. 단어 → 250/200/1단어, 글자 → 800/700/600/400/1자, 그 밖은 1. */
export function basisOptions(unit: string): { value: string; label: string }[] {
  // '1' 은 단어당·글자당 단가 — 예전 작업이 모두 이 방식이다 (기준이 없던 때).
  if (unit.includes('단어')) return ['250', '200', '1'].map((v) => ({ value: v, label: `${v}단어` }))
  if (unit.includes('글자')) return ['800', '700', '600', '400', '1'].map((v) => ({ value: v, label: `${v}자` }))
  return [{ value: '1', label: '1' }]
}

/** 단위를 바꿨을 때 지금 기준이 맞지 않으면 그 단위의 첫 기준으로. */
export function fitBasis(unit: string, basis: string): string {
  const options = basisOptions(unit)
  return options.some((o) => o.value === basis) ? basis : options[0]!.value
}

/* ------------------------------------------------------------------ 10진 (1/100) */

/** '12,000.5' → 1200050n (1/100 단위). 숫자가 아니면 null, 비었으면 0. */
export function toCents(text: string | null | undefined): bigint | null {
  const t = (text ?? '').replace(/[,\s]/g, '')
  if (t === '') return 0n
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(t)
  if (!m || (m[2] === '' && (m[3] ?? '') === '')) return null
  const frac = (m[3] ?? '').padEnd(3, '0')
  let cents = BigInt(m[2] || '0') * 100n + BigInt(frac.slice(0, 2))
  if (Number(frac[2]) >= 5) cents += 1n // 셋째 자리 반올림
  return m[1] === '-' ? -cents : cents
}

/** 1/100 단위 → '1234.50'. */
export function centsText(cents: bigint): string {
  const neg = cents < 0n
  const abs = neg ? -cents : cents
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`
}

/** 양수 나눗셈의 반올림 (half up). */
const divRound = (a: bigint, b: bigint) => {
  const neg = a < 0n !== b < 0n
  const x = a < 0n ? -a : a
  const y = b < 0n ? -b : b
  const q = (x * 2n + y) / (2n * y)
  return neg ? -q : q
}

/** 액면 물량 = 물량 ÷ 기준, 소수 첫째 자리 반올림. '1234.5' 꼴, 계산할 수 없으면 null. */
export function faceVolume(raw: string, basis: string): string | null {
  const r = toCents(raw)
  const b = toCents(basis)
  if (r === null || b === null || b <= 0n) return null
  const tenths = divRound(r * 10n, b)
  const neg = tenths < 0n
  const abs = neg ? -tenths : tenths
  return `${neg ? '-' : ''}${abs / 10n}.${abs % 10n}`
}

/** 한 줄의 합산(1/100). 숫자가 틀리면 null. */
export function lineSubtotal(face: string, price: string, mode: PriceMode): bigint | null {
  if (mode === 'free') return 0n
  const p = toCents(price)
  if (p === null) return null
  if (mode === 'fixed') return p
  const f = toCents(face)
  if (f === null) return null
  return divRound(f * p, 100n)
}

/**
 * 전체(`total`)를 비율(`weights`)대로 나눈다. 끝수는 첫 칸에. 비율이 모두 0 이면 첫 칸에 전부.
 * 결과의 합은 언제나 `total` 과 같다.
 */
export function splitByWeight(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) return []
  const sum = weights.reduce((a, b) => a + b, 0n)
  if (sum === 0n) return weights.map((_, i) => (i === 0 ? total : 0n))
  const parts = weights.map((w) => (total * w) / sum)
  const rest = total - parts.reduce((a, b) => a + b, 0n)
  parts[0] = parts[0]! + rest
  return parts
}

export interface TargetLine {
  key: string
  lang: string
  pmId: string | null
  pmName: string | null
  rawVolume: string
  unit: string
  basis: string
  price: string
  mode: PriceMode
  /** 액면 물량 — `faceManual` 이 아니면 물량 ÷ 기준으로 따라간다. */
  face: string
  faceManual: boolean
}

/** 물량·기준이 바뀌었을 때 액면 물량을 다시 계산한다 (손으로 고친 줄은 그대로). */
export function refreshFace(line: TargetLine): TargetLine {
  if (line.faceManual) return line
  return { ...line, face: faceVolume(line.rawVolume, line.basis) ?? '' }
}

/** 저장할 작업들의 금액. `discount` 는 할인금액 전체, `total` 은 화면의 총 합산(환산되었으면 환산값). */
export function planJobs(
  lines: readonly TargetLine[],
  discount: string,
  total?: string | null,
): { subtotals: bigint[]; discounts: bigint[]; sums: bigint[] } | null {
  const subtotals = lines.map((l) => lineSubtotal(l.face, l.price, l.mode))
  if (subtotals.some((s) => s === null)) return null
  const subs = subtotals as bigint[]
  const dis = toCents(discount)
  if (dis === null) return null
  const discounts = splitByWeight(dis, subs)
  let sums = subs.map((s, i) => s - discounts[i]!)
  // 총 합산이 따로 정해졌으면(원화 환산 등) 그 금액을 같은 비율로 나눈다.
  const fixed = total === undefined || total === null ? null : toCents(total)
  const natural = sums.reduce((a, b) => a + b, 0n)
  if (fixed !== null && fixed !== natural) sums = splitByWeight(fixed, sums)
  return { subtotals: subs, discounts, sums }
}
