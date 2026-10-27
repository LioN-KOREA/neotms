/**
 * 금액과 물량 표시.
 *
 * ## 숫자로 바꾸지 않는다
 *
 * 백엔드는 모든 금액·물량을 **10진 문자열**로 보낸다(`"1234567.89"`). 이 파일의 어떤 함수도
 * 그 값을 `Number` 로 바꿔 계산하지 않는다. 이유는 IEEE 754 다:
 *
 *   0.1 + 0.2 === 0.30000000000000004
 *
 * 매출·원가·마진은 돈이고, 돈의 합계가 1원 틀리면 정산이 안 맞는다. 레거시 LKTMS 가 정확했던
 * 이유도 SQL Server 의 decimal 로만 계산했기 때문이다. 집계는 PostgreSQL 의 `numeric` 이 하고,
 * 프론트엔드는 그 결과를 보여 준다.
 *
 * ## 다만 합계 입력은 프론트엔드가 계산해야 한다
 *
 * `job_price_sum`·`job_price_ksum` 은 **저장되는 입력값**이다(백엔드 JOB_FIELDS 를 보면 그대로
 * INSERT 된다). 서버가 `volume × price` 를 다시 계산해 주지 않는 것은 의도된 설계다 — 레거시
 * 데이터에는 손으로 조정한 합계가 들어 있고, 서버가 덮어쓰면 이미 발행된 세금계산서의 금액과
 * 달라진다.
 *
 * 그래서 등록 화면은 합계를 계산해야 한다. 그 계산은 `Number` 로 하지 않는다 — 아래
 * `decimal*` 함수들이 `BigInt` 로 정확히 계산한다. `Number` 는 표시용 자릿수 구분자를 넣을
 * 때만, 그리고 정수부에만 쓴다.
 */

/** 10진 문자열인지. 빈 값·null 은 아니다. */
export function isDecimalString(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false
  return /^-?\d+(?:\.\d+)?$/.test(value.trim())
}

/**
 * 부호를 본다. 문자열만 보고 판단한다 — 파싱하지 않는다.
 *
 * 마진이 음수인지 묻기 위해 존재한다. `Number(value) < 0` 으로도 되지만, 그렇게 쓰기 시작하면
 * 다음 사람이 `Number(a) + Number(b)` 를 쓴다. 이 파일에 Number 변환이 없는 것 자체가 규칙을
 * 지키게 만드는 장치다.
 */
export function isNegative(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false
  const t = value.trim()
  if (!t.startsWith('-')) return false
  // "-0" 과 "-0.00" 은 음수가 아니다.
  return /[1-9]/.test(t)
}

/**
 * 1000 단위 구분자를 넣는다. 소수부는 있으면 그대로 둔다.
 *
 * `Intl.NumberFormat` 에 넘기지 않는다 — 넘기려면 Number 로 바꿔야 하고, 15자리를 넘는 값에서
 * 정밀도가 사라진다. 환율 환산 전의 외화 누적액은 그 자리수에 닿을 수 있다. 정수부를 세 자리씩
 * 끊는 것은 정규식 한 줄이면 되고, 그 방식에는 상한이 없다.
 */
export function formatAmount(value: string | null | undefined): string {
  if (value === null || value === undefined) return '-'
  const t = value.trim()
  if (t.length === 0) return '-'
  if (!isDecimalString(t)) return t // 알 수 없는 형식이면 손대지 않고 그대로 보여 준다.

  const negative = t.startsWith('-')
  const unsigned = negative ? t.slice(1) : t
  const [intPart, fracPart] = unsigned.split('.')
  const grouped = (intPart ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const body = fracPart ? `${grouped}.${fracPart}` : grouped
  return negative ? `-${body}` : body
}

/**
 * 금액을 표시용으로 다듬는다. 소수부가 전부 0 이면 떼어 낸다.
 *
 * 원화 금액이 `numeric(18,2)` 에 들어 있으므로 서버는 `"1200000.00"` 을 준다. 목록에서 모든
 * 금액에 `.00` 이 붙어 있으면 유효숫자가 두 자리 늘어난 것처럼 보여 스캔이 느려진다. 실제로
 * 소수부가 있는 값(외화 단가 `0.085` 등)은 그대로 보여 준다.
 */
export function formatMoney(value: string | null | undefined): string {
  if (value === null || value === undefined) return '-'
  const t = value.trim()
  if (!isDecimalString(t)) return formatAmount(t)
  const trimmed = t.includes('.') ? t.replace(/\.?0+$/, '') : t
  return formatAmount(trimmed.length === 0 || trimmed === '-' ? '0' : trimmed)
}

/** 통화 코드와 함께. 코드가 없으면 금액만. */
export function formatMoneyWithCoin(
  value: string | null | undefined,
  coinCode: string | null | undefined,
): string {
  const amount = formatMoney(value)
  if (amount === '-') return '-'
  const coin = coinCode?.trim()
  return coin ? `${amount} ${coin}` : amount
}

/**
 * 폼 입력값을 서버에 보낼 10진 문자열로 다듬는다. 보낼 값이 없으면 null.
 *
 * 사용자는 `1,200,000` 이라고 치고 붙여넣기도 한다. 구분자만 떼고 **그대로** 보낸다 — 반올림도
 * 자릿수 맞추기도 하지 않는다. 자릿수는 컬럼 정의가 정하고, 맞지 않으면 서버의 valibot 스키마가
 * 거절한다. 여기서 미리 깎으면 사용자가 입력한 값과 저장된 값이 조용히 달라진다.
 */
export function toDecimalInput(raw: string): string | null {
  const cleaned = raw.replace(/,/g, '').trim()
  if (cleaned.length === 0) return null
  return cleaned
}

/* -------------------------------------------------------------------------- */
/* 정확한 10진 연산                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 10진 문자열을 "정수 × 10^-scale" 로 쪼갠다. 형식이 아니면 null.
 *
 * `BigInt` 를 쓰는 이유는 상한이 없기 때문이다. `numeric(18,2)` 금액에 `numeric(18,6)` 환율을
 * 곱하면 중간값이 24자리가 되고, 그건 `Number.MAX_SAFE_INTEGER`(약 9.0 × 10^15) 를 한참
 * 넘는다. 즉 환율 환산을 `Number` 로 하면 **정상적인 입력에서** 값이 틀린다 — 반올림 오차가
 * 아니라 자리수 손실이다.
 */
function parseDecimal(value: string | null | undefined): { units: bigint; scale: number } | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  if (!isDecimalString(t)) return null
  const negative = t.startsWith('-')
  const unsigned = negative ? t.slice(1) : t
  const [intPart, fracPart = ''] = unsigned.split('.')
  const digits = `${intPart}${fracPart}`
  const units = BigInt(digits) * (negative ? -1n : 1n)
  return { units, scale: fracPart.length }
}

/** 같은 scale 로 맞춘다. 올리는 쪽만 한다 — 내리면 자리를 버리게 되므로. */
function align(a: { units: bigint; scale: number }, b: { units: bigint; scale: number }) {
  const scale = Math.max(a.scale, b.scale)
  const lift = (x: { units: bigint; scale: number }) =>
    x.units * 10n ** BigInt(scale - x.scale)
  return { a: lift(a), b: lift(b), scale }
}

/**
 * scale 자리로 반올림한다. 0.5 는 **0 에서 먼 쪽으로**(half-up).
 *
 * PostgreSQL 의 `numeric` 반올림과 같은 방향이어야 한다. 은행가 반올림(half-even)을 쓰면
 * 화면에 표시한 합계와 저장된 합계가 끝자리에서 갈라지고, 그 1원을 찾는 데 하루가 간다.
 */
function toFixedString(units: bigint, scale: number, targetScale: number): string {
  let u = units
  if (scale > targetScale) {
    const divisor = 10n ** BigInt(scale - targetScale)
    const negative = u < 0n
    const abs = negative ? -u : u
    const q = abs / divisor
    const r = abs % divisor
    const rounded = r * 2n >= divisor ? q + 1n : q
    u = negative ? -rounded : rounded
  } else if (scale < targetScale) {
    u = u * 10n ** BigInt(targetScale - scale)
  }

  const negative = u < 0n
  const abs = (negative ? -u : u).toString().padStart(targetScale + 1, '0')
  const intPart = abs.slice(0, abs.length - targetScale) || '0'
  const fracPart = targetScale > 0 ? abs.slice(abs.length - targetScale) : ''
  const body = fracPart ? `${intPart}.${fracPart}` : intPart
  return negative && /[1-9]/.test(abs) ? `-${body}` : body
}

/** 금액 컬럼의 소수 자릿수. `numeric(18,2)` 다 — db/002_tables.sql. */
export const MONEY_SCALE = 2

/**
 * 곱셈. 어느 하나라도 10진 문자열이 아니면 null.
 *
 * null 을 돌려주는 것이 중요하다. 입력 중인 폼에서는 단가는 쳤고 물량은 아직 비어 있는 상태가
 * 정상이고, 그때 합계는 "0" 이 아니라 **아직 없는 값**이다. 0 을 보여 주면 사용자가 그 0 을
 * 그대로 저장한다.
 */
export function decimalMultiply(
  a: string | null | undefined,
  b: string | null | undefined,
  targetScale = MONEY_SCALE,
): string | null {
  const x = parseDecimal(a)
  const y = parseDecimal(b)
  if (!x || !y) return null
  return toFixedString(x.units * y.units, x.scale + y.scale, targetScale)
}

/** 뺄셈. 둘 중 하나가 비어 있으면 상대 값(또는 null)을 그대로 돌려준다. */
export function decimalSubtract(
  a: string | null | undefined,
  b: string | null | undefined,
  targetScale = MONEY_SCALE,
): string | null {
  const x = parseDecimal(a)
  const y = parseDecimal(b)
  if (!x) {
    if (!y) return null
    return toFixedString(-y.units, y.scale, targetScale)
  }
  if (!y) return toFixedString(x.units, x.scale, targetScale)
  const { a: lx, b: ly, scale } = align(x, y)
  return toFixedString(lx - ly, scale, targetScale)
}

/**
 * 합계. 10진 문자열이 아닌 항목은 **건너뛴다**.
 *
 * 건너뛰는 선택에는 대가가 있다 — 값이 비어 있는 행이 섞인 합계는 "그 행까지 포함한 합계" 가
 * 아니다. 그래서 이 함수를 쓰는 화면은 합계 옆에 집계된 건수를 함께 보여 준다(프로젝트 상세).
 * 그러지 않으면 발주 단가를 아직 안 넣은 작업 때문에 마진이 실제보다 좋아 보인다.
 */
export function decimalSum(
  values: readonly (string | null | undefined)[],
  targetScale = MONEY_SCALE,
): { total: string; counted: number; skipped: number } {
  let units = 0n
  let scale = 0
  let counted = 0
  let skipped = 0

  for (const value of values) {
    const parsed = parseDecimal(value)
    if (!parsed) {
      skipped += 1
      continue
    }
    counted += 1
    const lifted = align({ units, scale }, parsed)
    units = lifted.a + lifted.b
    scale = lifted.scale
  }

  return { total: toFixedString(units, scale, targetScale), counted, skipped }
}
