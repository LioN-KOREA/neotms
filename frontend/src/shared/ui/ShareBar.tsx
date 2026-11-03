import { cssPercent, decimalCompare, decimalPercent, formatMoney, isNegative } from '@/shared/utils/money'
import ui from './ui.module.css'

/**
 * 수주금액을 수익과 원가로 쪼갠 가로 막대.
 *
 * 리포트(기간 전체)와 대시보드(내 프로젝트 전체)가 같이 쓴다. 두 화면이 각자 그리지 않는 이유는
 * 모양을 맞추기 위해서가 아니라 **아래의 손실 처리 때문**이다.
 *
 * ## 원가가 수주액을 넘긴 경우를 쪼개면 안 된다
 *
 * 그때 수익 비중은 음수이고 `width: -25%` 는 CSS 가 선언째로 무시한다. 그래서 그대로 쪼개려
 * 들면 왼쪽 조각이 `width: auto` 로 되돌아가거나 오른쪽이 트랙을 채워, 화면에는 "원가가
 * 수주액과 딱 같다" 는 그림이 나온다 — **가장 심각한 상태가 정상으로 보이는** 거짓말이고, 금액
 * 화면이 절대 하면 안 되는 종류다. 그 경우 막대를 쪼개지 않고 통째로 손실색으로 칠한다.
 *
 * 이 판단을 화면마다 다시 쓰면, 빠뜨린 쪽은 **오류 없이** 틀린 그림을 그린다. 그래서 두 화면이
 * 분모와 라벨만 넘기고 그림은 여기서 한 번만 그린다.
 *
 * ## 분모가 0 인 경우도 화면마다 다시 쓸 일이 아니다
 *
 * 수주금액이 0원이면 비중이라는 값 자체가 없다(`decimalPercent` 가 null 을 준다). 0% 막대를
 * 그리면 "수익이 0이고 원가가 전부" 라는 그림이 되는데, 원가도 0인 경우에 그건 틀린 그림이다.
 * 막대를 그리지 않고 왜 못 그리는지 한 줄로 적는다.
 */

/**
 * 퍼센트를 조각 **안**에 넣을 최소 비중.
 *
 * 8% 아래에서는 숫자가 조각보다 넓어져 잘린다. 좁은 화면에서도 8% 면 `100.00%` 를 뺀 거의
 * 모든 표기가 들어간다. 이 값 미만인 조각은 숫자를 조각 밖(옆 조각 위)으로 내보낸다 —
 * 지우지 않는다. 마진율 3% 인 경우야말로 이 숫자가 가장 중요하다.
 */
const PCT_INSIDE_MIN = '8'

/** 비중이 조각 안에 들어갈 만한지. `decimalCompare` 로만 판단한다 — 이 파일에 `Number` 는 없다. */
function fitsInside(pct: string | null): boolean {
  const cmp = decimalCompare(pct, PCT_INSIDE_MIN)
  return cmp !== null && cmp >= 0
}

interface ShareBarProps {
  /** 분모. 막대 전체가 이 금액이다. */
  total: string
  margin: string
  cost: string
  /**
   * 막대 위 가운데에 적을 분모의 이름.
   *
   * 쓰는 쪽이 적는다. 같은 '총 수주금액' 이 리포트에서는 **고른 기간의** 합계이고 대시보드에서는
   * **기간 제한 없는 전체**이므로, 라벨을 여기에 박아 두면 둘 중 한쪽이 거짓말을 하게 된다.
   */
  totalLabel: string
  /** 분모가 0 일 때 막대 대신 적을 한 줄. 이것도 화면마다 뜻이 다르다. */
  emptyHint: string
}

export function ShareBar({ total, margin, cost, totalLabel, emptyHint }: ShareBarProps) {
  /*
   * 원가 쪽 퍼센트도 따로 구한다. 막대의 **길이**는 한쪽만 알면 되지만(나머지는 flex 가 채운다),
   * 적어 넣는 **숫자**는 두 쪽 다 필요하다. 100 에서 빼서 구하지 않는 이유는 반올림이다 —
   * 수익이 59.995% 일 때 표시값은 60.00% 이고, 거기서 100 을 빼면 원가가 40.00% 로 적히는데
   * 실제 원가 비중은 40.005% → 40.01% 다. 각각 원값에서 구하면 둘 다 자기 숫자로 맞는다.
   */
  const marginPct = decimalPercent(margin, total)
  const costPct = decimalPercent(cost, total)
  const loss = isNegative(margin)

  /*
   * 퍼센트를 조각 안에 넣을지, 옆으로 내보낼지. CSS 로는 판단할 수 없다 — 조각의 실제 픽셀
   * 폭을 아는 것은 브라우저뿐이고, 글자가 넘치는지 물어볼 방법이 없다. 하지만 **비중은 이미
   * 알고 있으므로**, 자리가 모자랄 비중을 미리 가려내면 된다.
   */
  const marginInside = fitsInside(marginPct)
  const costInside = fitsInside(costPct)

  return (
    <div className={ui.shareWrap}>
      {/*
       * 분모를 막대 위 가운데에 적는다. 아래 두 퍼센트가 **무엇의** 몇 %인지를 여기서 못 읽으면
       * 비중 막대는 비율만 있고 금액이 없는 그림이 된다.
       *
       * `<div>` 인 이유는 `.shareTotal` 이 flex 이고 margin 을 쓰지 않기 때문이다. `<p>` 로
       * 두면 브라우저 기본 margin 1em 이 붙어 `.shareWrap` 의 gap 과 겹친다.
       */}
      <div className={ui.shareTotal}>
        <span className={ui.statLabel}>{totalLabel}</span>
        <span className={ui.shareTotalValue}>{formatMoney(total)}원</span>
      </div>

      {marginPct === null ? (
        <p className={ui.hint}>{emptyHint}</p>
      ) : (
        <>
          <div className={ui.shareBar}>
            {loss ? (
              /*
               * 조각이 하나뿐이라 대비로 읽히지 않으므로 숫자에 '원가' 를 붙인다. 120% 라는
               * 값이야말로 이 상태에 대해 가장 중요한 사실이다.
               */
              <div className={ui.shareSegLoss}>
                <span className={ui.sharePct}>원가 {costPct}%</span>
              </div>
            ) : (
              <>
                {/* 왼쪽만 너비를 받는다. 오른쪽은 남는 자리를 채운다 — ui.module.css 의
                    `.shareSegCost` 주석(반올림으로 합이 100 을 벗어나는 문제). */}
                <div className={ui.shareSegMargin} style={{ width: cssPercent(marginPct) }}>
                  <span className={`${ui.sharePct} ${marginInside ? '' : ui.sharePctOutRight}`}>
                    {marginPct}%
                  </span>
                </div>
                <div className={ui.shareSegCost}>
                  <span className={`${ui.sharePct} ${costInside ? '' : ui.sharePctOutLeft}`}>
                    {costPct}%
                  </span>
                </div>
              </>
            )}
          </div>

          {/*
           * 막대 아래 양 끝의 금액. 왼쪽이 수익, 오른쪽이 원가 — 막대 조각의 좌우와 같은
           * 순서이므로 어느 금액이 어느 조각의 것인지 읽을 필요가 없다.
           *
           * 손실일 때는 '수익' 쪽 글자색이 손실색이다. 막대가 통째로 빨간데 그 아래 금액만
           * 초록이면, 막대와 숫자가 서로 다른 말을 한다.
           *
           * 단위 '원' 을 붙인다. 위 총액에는 붙어 있는데 여기만 빠지면, 같은 화면에서 같은
           * 종류의 숫자가 두 가지 모습으로 적히는 셈이다 — 읽는 사람은 그 차이에 뜻이 있는지
           * 부터 의심하게 된다.
           */}
          <div className={ui.shareEnds}>
            <span className={`${ui.shareEnd} ${loss ? ui.shareEndLoss : ui.shareEndMargin}`}>
              수익 {formatMoney(margin)}원
            </span>
            <span className={`${ui.shareEnd} ${ui.shareEndCost}`}>원가 {formatMoney(cost)}원</span>
          </div>
        </>
      )}
    </div>
  )
}
