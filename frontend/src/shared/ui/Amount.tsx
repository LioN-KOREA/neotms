import { formatMoney, formatMoneyWithCoin, isNegative } from '@/shared/utils/money'
import ui from './ui.module.css'

/**
 * 금액 한 칸.
 *
 * 세 가지를 동시에 지킨다:
 *
 *   1. **오른쪽 정렬 + 고정폭 숫자**(`ui.amount` 가 `tabular-nums` 를 켠다). 자릿수가 세로로
 *      맞지 않는 금액 열은 눈으로 비교할 수 없다.
 *   2. **역할별 색**. 매출과 원가가 같은 검정이면, 마진이 왜 그 값인지 보려면 매번 두 열을
 *      번갈아 읽어야 한다.
 *   3. **음수 강조**. 원가가 매출을 넘은 작업은 이 시스템이 알려 줄 수 있는 가장 중요한 사실
 *      이고, 그걸 사용자가 두 숫자를 머릿속에서 빼서 알아내게 해서는 안 된다.
 *
 * `kind` 를 받는 이유: 같은 숫자가 작업 화면에서는 매출이고 발주 화면에서는 원가다. 색은
 * 값이 아니라 **맥락**이 정한다.
 */
export function Amount({
  value,
  kind = 'plain',
  coinCode,
}: {
  value: string | null | undefined
  kind?: 'plain' | 'revenue' | 'cost' | 'margin'
  /** 주면 통화 코드를 함께 보여 준다. 원화 환산액에는 쓰지 않는다. */
  coinCode?: string | null
}) {
  const text = coinCode === undefined ? formatMoney(value) : formatMoneyWithCoin(value, coinCode)

  const tone =
    kind === 'revenue'
      ? ui.amountRevenue
      : kind === 'cost'
        ? ui.amountCost
        : // 마진은 양수일 때 색을 쓰지 않는다. 전부 색이면 강조가 사라진다 — 빨간 마진이
          // 눈에 띄는 것은 그 열의 나머지가 검정이기 때문이다.
          kind === 'margin' && isNegative(value)
          ? ui.amountNeg
          : ''

  return <span className={`${ui.amount} ${tone}`.trim()}>{text}</span>
}
