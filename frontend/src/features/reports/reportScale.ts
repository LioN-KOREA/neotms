import { decimalPercent, isDecimalString } from '@/shared/utils/money'

/**
 * 세로 막대 그래프의 **세로축**을 만든다.
 *
 * ## 왜 따로 있나
 *
 * 가로 막대 하나만 그릴 때는 축이 필요 없었다. 막대 길이가 '1위 대비 몇 %' 이고, 그 비율은
 * `decimalPercent` 한 번이면 끝난다. 세로 막대 그래프는 다르다 — **눈금선이 있고, 눈금에
 * 금액이 적힌다.** 그 금액은 데이터에 없는 값이다(5,000,000원이라는 줄은 어느 고객사의
 * 매출도 아니다). 데이터의 최댓값에서 "사람이 읽을 수 있는 둥근 수" 를 만들어 내는 계산이
 * 필요하고, 그게 이 파일이다.
 *
 * ## 축 상한을 최댓값에 맞추지 않는 이유
 *
 * 최댓값이 4,938,120원일 때 축 상한을 그 값으로 두면 눈금이 0 / 987,624 / 1,975,248 … 로
 * 적힌다. 읽는 사람은 눈금을 읽는 것이 아니라 **눈금을 기준으로 막대를 읽으므로**, 눈금이
 * 둥글지 않으면 그래프는 "대충 200만쯤" 이라는 답을 주지 못하고 매번 숫자를 세게 만든다.
 * 그래서 1·2·2.5·5·10 × 10^n 중에서 간격을 고르고, 상한은 그 간격의 배수로 올린다 — 위
 * 예에서는 간격 1,000,000 / 상한 5,000,000 이 된다.
 *
 * ## 여기서도 `Number` 를 쓰지 않는다
 *
 * money.ts 맨 위의 규칙이 여기까지 온다. 금액은 10진 문자열이고 자릿수에 상한이 없다 —
 * 외화 누적액은 `Number.MAX_SAFE_INTEGER` 를 넘길 수 있다. 눈금 계산은 전부 `BigInt` 로
 * 하고, 밖으로 내보내는 값(눈금 금액, 위치 %)도 10진 문자열이다. 위치 문자열은 그대로
 * `bottom: 37.42%` 에 들어가므로 변환할 일이 애초에 없다.
 *
 * 다만 **자릿수 세기**(`toString().length`)에만 숫자를 쓴다. 그건 금액이 아니라 10의 거듭제곱을
 * 고르기 위한 자릿수이고, `BigInt` 의 십진 표기 길이는 정확하다.
 */

/**
 * 눈금 간격의 후보. 10 으로 시작하는 이유는 `base` 를 한 자리 낮춰 잡기 때문이다 — 25 를
 * 정수로 쓰려면 2.5 × 10^n 이 아니라 25 × 10^(n-1) 이어야 하고, 그래야 전 구간을 `BigInt`
 * 로만 계산할 수 있다.
 *
 * 2.5 를 넣어 두는 것이 중요하다. 없으면 간격이 2 에서 5 로 건너뛰고, 최댓값이 상한의 절반을
 * 겨우 넘는 구간(예: 1,100만)에서 축이 2,500만까지 올라가 막대가 전부 아래쪽 절반에 눕는다.
 */
const NICE_STEPS = [10n, 20n, 25n, 50n, 100n] as const

/** 눈금선 개수의 기준. 0 선을 빼고 위아래로 이만큼씩 선다 — 다섯이면 빽빽하지도 성기지도 않다. */
const INTERVALS = 5n

/** 축 한 칸. */
export interface AxisTick {
  /** 눈금에 적을 금액. 둥근 정수의 10진 문자열이다. */
  value: string
  /** 플롯 바닥에서의 위치. `bottom: ${pos}%` 로 그대로 들어간다. */
  pos: string
}

export interface ChartScale {
  /** 아래에서 위로. 0 선도 이 안에 들어 있다. */
  ticks: AxisTick[]
  /** 0 선의 위치. 막대가 **여기서** 자란다. 음수가 없으면 "0.00". */
  zero: string
  /** 축 상한 − 하한. 막대 높이의 분모다. 항상 양수. */
  range: string
}

/**
 * 10진 문자열을 **0 에서 먼 쪽으로 올린** 정수로 바꾼다. 형식이 아니면 null.
 *
 * 내림이 아니라 올림인 이유는 쓰이는 자리가 축의 한계값이기 때문이다. 4,938,120.4 를 내려
 * 4,938,120 으로 잡아도 상한은 어차피 둥근 수로 다시 올라가므로 대개 차이가 없지만, 값이
 * 정확히 간격의 배수 + 0.4 인 경우에 상한이 한 칸 모자라 **막대가 축 위로 삐져나간다.**
 * 음수도 같은 이유로 -1.5 → -2 다.
 */
function ceilUnits(value: string | null | undefined): bigint | null {
  if (typeof value !== 'string' || !isDecimalString(value)) return null
  const t = value.trim()
  const negative = t.startsWith('-')
  const unsigned = negative ? t.slice(1) : t
  const [intPart = '0', fracPart = ''] = unsigned.split('.')
  let units = BigInt(intPart)
  if (/[1-9]/.test(fracPart)) units += 1n
  return negative ? -units : units
}

/**
 * `span` 을 `INTERVALS` 칸 안에 담을 수 있는 가장 작은 둥근 간격.
 *
 * `base` 를 자릿수 − 2 로 잡으면 `rough / base` 가 10~99 사이에 떨어지고, 후보 다섯 개가 그
 * 구간을 덮는다. 자릿수가 1~2 면 `base` 는 1 이 되어 최소 간격이 10 이 된다 — 원 단위 리포트
 * 에서 그보다 촘촘한 축은 의미가 없다.
 */
function niceStep(span: bigint): bigint {
  if (span <= 0n) return 1n
  const rough = (span + INTERVALS - 1n) / INTERVALS // 올림 나눗셈
  const base = 10n ** BigInt(Math.max(0, rough.toString().length - 2))
  for (const multiple of NICE_STEPS) {
    const step = multiple * base
    if (step >= rough) return step
  }
  // 후보의 마지막(100 × base)은 정의상 rough 보다 크다. 도달하지 않지만, 반환값이 없는 길을
  // 남겨 두면 다음 사람이 후보 목록을 고칠 때 조용히 undefined 가 나간다.
  return 100n * base
}

/** 10진 문자열의 절댓값. 부호만 떼므로 파싱이 필요 없다. */
export function decimalAbs(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || !isDecimalString(value)) return null
  const t = value.trim()
  return t.startsWith('-') ? t.slice(1) : t
}

/**
 * 그래프에 설 값 전부를 받아 축을 만든다. 그릴 것이 없으면 null.
 *
 * null 을 돌려주는 경우는 **모든 값이 0 이거나 금액이 하나도 없는 경우**다. 그때 축을 억지로
 * 만들면 상한이 10원인 그래프가 그려지고, 0원짜리 막대 서른 개가 바닥에 깔린 그림은 "데이터가
 * 없다" 가 아니라 "전부 0원이다" 로 읽힌다 — 둘은 다른 사실이다. 화면이 구분해서 말해야 한다.
 *
 * 음수를 따로 다루는 이유: 마진은 음수가 될 수 있다(원가가 매출을 넘긴 고객사). 0 선을 바닥에
 * 고정해 두면 그 막대는 그릴 자리가 없어 사라지고, **가장 나쁜 줄이 그래프에서 제일 멀쩡해
 * 보인다.** 그래서 음수가 하나라도 있으면 0 선을 위로 띄우고 아래쪽에도 눈금을 세운다.
 */
export function buildScale(values: readonly (string | null | undefined)[]): ChartScale | null {
  let posMax = 0n
  let negMax = 0n // 절댓값으로 담는다. 부호 비교를 두 군데서 하지 않기 위해.

  for (const value of values) {
    const units = ceilUnits(value)
    if (units === null) continue
    if (units > posMax) posMax = units
    if (-units > negMax) negMax = -units
  }

  if (posMax === 0n && negMax === 0n) return null

  /*
   * 간격은 **위아래를 합친 폭**에서 구한다. 위쪽만 보고 정하면, 아래로 길게 내려가는 손실
   * 막대가 있을 때 눈금이 열 칸 넘게 생겨 축이 자(ruler)처럼 된다. 음수가 없으면 negMax 가
   * 0 이므로 이 식은 "최댓값 ÷ 5 를 둥글린 값" 과 정확히 같아진다 — 흔한 경우가 가장 단순한
   * 식으로 떨어진다.
   */
  const step = niceStep(posMax + negMax)
  const up = posMax === 0n ? 0n : (posMax + step - 1n) / step
  const down = negMax === 0n ? 0n : (negMax + step - 1n) / step

  const top = step * up
  const bottom = -step * down
  const range = top - bottom // posMax 와 negMax 가 동시에 0 인 경우는 위에서 걸렀으므로 > 0

  const rangeText = range.toString()
  const ticks: AxisTick[] = []
  for (let i = -down; i <= up; i += 1n) {
    const value = step * i
    ticks.push({
      value: value.toString(),
      pos: decimalPercent((value - bottom).toString(), rangeText) ?? '0',
    })
  }

  return {
    ticks,
    zero: decimalPercent((-bottom).toString(), rangeText) ?? '0',
    range: rangeText,
  }
}

/**
 * 한 막대의 높이. 축 폭 대비 값의 크기를 퍼센트 문자열로 돌려준다.
 *
 * 음수는 절댓값으로 잰다. 높이에 부호가 들어갈 자리는 없고 — `height: -12%` 는 CSS 가 선언째로
 * 무시한다 — 아래로 자란다는 사실은 호출자가 0 선 **아래쪽**에 붙여서 표현한다.
 */
export function barHeight(value: string | null | undefined, scale: ChartScale): string | null {
  const abs = decimalAbs(value)
  if (abs === null) return null
  return decimalPercent(abs, scale.range)
}
