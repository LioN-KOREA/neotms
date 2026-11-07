import type { InvoiceRow, PurchaseOrderRow } from '@/apis/neotms.types'
import { formatDate } from '@/shared/utils/format'
import { decimalPercent, decimalSum, formatMoney, formatMoneyWithCoin } from '@/shared/utils/money'
import { PRINT_LANG_ENG, type PrintLang } from './PrintDocModal'
import doc from './printDoc.module.css'
import logo from './print_logo.png'

/**
 * 인쇄용 번역가 인보이스 명세(LIST OF INVOICE). **국문·영문 두 서식이 이 한 컴포넌트다.**
 *
 * `PoPrintDoc` 과 같은 구조이고 같은 이유다 — 루트의 `INVOICE_TEMPLATE_KOR` 과
 * `INVOICE_TEMPLATE_ENG` 는 **강조색 · 라벨 넷 · 첫 열 폭** 만 다르다.
 *
 * ## 이 문서가 PO 문서와 다른 점: 여러 PO 가 한 장에 들어간다
 *
 * 인보이스 하나가 PO 여러 건을 묶는다. 그래서 이 서식에는 PO 문서에 없는 명세 표가 있고, 합계가
 * 그 표에서 나온다. PO 목록은 `pos` 로 **받는다** — 여기서 조회하지 않는다. 서식 컴포넌트가
 * 데이터를 가져오면 PDF 저장 중에 조회가 끝나서 캡처 도중에 표가 바뀔 수 있고, 그러면 화면과
 * 파일이 다르다.
 *
 * ## 명세 표는 10행으로 채운다
 *
 * 레거시가 PO 한 건에 빈 행 아홉 개를 붙여 **항상 10행**을 찍었다. 그게 의도인 이유: 이 종이는
 * 번역가가 보관하고 정산 근거로 쓰는 문서이고, 행 수가 들쭉날쭉하면 "아래가 잘린 것인지" 를
 * 눈으로 판단할 수 없다. 빈 행이 깔려 있으면 명세가 거기서 끝났다는 것이 한눈에 보인다.
 *
 * PO 가 10건을 넘으면 늘어난다 — 레거시는 한 페이지를 전제했지만 묶음 수에 상한이 없고,
 * 잘라서 보여 주는 것은 정산 근거 문서에서 할 수 있는 가장 나쁜 일이다. PDF 쪽이 페이지를
 * 자동으로 넘긴다(`exportPdf.ts`).
 *
 * ## Tax 비율은 계산해서 적는다
 *
 * 레거시 서식에는 `Tax(3.3%)` 가 **글자로** 박혀 있었다. 인보이스에는 세율 컬럼이 없고 세액
 * (`invTax`)만 있으므로, 박아 둔 3.3% 는 실제 원천징수와 다를 수 있다 — 다르면 번역가가 받은
 * 종이의 산수가 맞지 않게 된다. 그래서 세액 ÷ 소계로 비율을 **역산해서** 적고, 역산이 안 되면
 * (소계가 0이거나 세액이 비었으면) 괄호 없이 `Tax` 만 적는다. 서식의 모양은 지키면서 숫자는
 * 사실이 되는 쪽이다.
 */

const text = (value: string | null | undefined): string => value?.trim() || ''

/** 레거시가 늘 찍던 명세 행 수. 위 주석 참고. */
const MIN_LINES = 10

interface InvoicePrintDocProps {
  invoice: InvoiceRow
  /** 이 인보이스에 묶인 PO. `invoiceTranslatorId` 로 조회한 결과를 그대로 넘긴다. */
  pos: readonly PurchaseOrderRow[]
  lang: PrintLang
}

export function InvoicePrintDoc({ invoice, pos, lang }: InvoicePrintDocProps) {
  const eng = lang === PRINT_LANG_ENG

  const accentText = eng ? doc.txtCyan : doc.txtOragne
  /** 명세 표의 머리글 색. `printDoc.module.css` 의 `table.oragne thead th` / `table.cyan …`. */
  const listAccent = eng ? doc.cyan : doc.oragne

  /**
   * 소계 — **명세 표의 합**이다. `invSum`(총액)에서 거꾸로 만들지 않는다.
   *
   * 거꾸로 만들면(`invSum + invTax`) 표의 숫자들을 더한 값과 다를 수 있고, 그 차이가 바로 이
   * 문서를 받은 번역가가 전화하는 이유가 된다. 표에 적힌 것을 더한 값이 소계여야 표가 근거가 된다.
   *
   * `poPriceSum` 은 PO 의 **PO 통화 금액**이다. 한 인보이스의 PO 들은 같은 번역가의 것이므로
   * 통화가 섞이는 일이 사실상 없지만, 섞이면 이 합은 뜻이 없어진다 — 그 경우를 아래에서 경고로
   * 드러낸다. 조용히 더해 버리는 것이 유일하게 해서는 안 되는 처리다.
   */
  const subTotal = decimalSum(pos.map((p) => p.poPriceSum))

  /** PO 통화가 두 가지 이상 섞였나. 위 주석 참고. */
  const mixedCoins =
    new Set(pos.map((p) => p.poCoinCode?.trim()).filter((c): c is string => !!c)).size > 1

  /** 역산한 세율. 못 구하면 null 이고 그때는 괄호를 적지 않는다. */
  const taxPercent = decimalPercent(invoice.invTax, subTotal.total)

  /** 10행을 채우기 위한 빈 행 수. PO 가 10건을 넘으면 0 이다. */
  const padding = Math.max(0, MIN_LINES - pos.length)

  return (
    <div className={doc.printWrap}>
      <div className={doc.pageHead}>
        <img src={logo} alt="LioNKOREA" />
        {/*
          * PO 문서의 제목에는 `txtSize20` 이 붙어 있는데 여기는 없다. 레거시 그대로다 — 인보이스
          * 쪽 제목이 한 단계 작다. 통일하고 싶어지는 자리이지만, 그러면 두 서식이 나란히 놓였을 때
          * 지금과 다른 모양이 된다.
          */}
        <strong>LIST OF INVOICE</strong>
        <strong className={`${doc.txtSize20} ${accentText}`}>{invoice.invTranCode}</strong>
      </div>

      <table className={doc.estimate}>
        <colgroup>
          {/* 첫 열 폭이 두 서식의 유일한 치수 차이다. 국문 라벨이 더 길다. */}
          <col style={{ width: eng ? 150 : 180 }} />
          <col />
          <col style={{ width: 150 }} />
        </colgroup>
        <tbody>
          <tr>
            <th>{eng ? 'DATE OF ISSUE : ' : '인보이스 발행일 : '}</th>
            <td>{formatDate(invoice.invDay)}</td>
            {/*
              * 오른쪽의 큰 숫자가 **청구 총액**이다. 통화 코드를 반드시 붙인다 — 번역가가 이
              * 종이에서 가장 먼저 보는 숫자이고, PO 문서 TOTAL 과 같은 이유로 단위가 없으면 안 된다.
              */}
            <td>
              <strong className={`${doc.ta_right} ${doc.txtSize15} ${accentText}`}>
                {formatMoneyWithCoin(invoice.invSum, invoice.coinCode)}
              </strong>
            </td>
          </tr>
        </tbody>
      </table>

      {/*
        * 레거시에서 이 표는 `class="companyInfo"` 였고, **그 클래스에는 규칙이 없었다** — 일반
        * `.printWrap table` 과 th/td 규칙만 받는다(`printDoc.module.css` 의 같은 자리 주석).
        *
        * 그래서 여기에는 `className` 을 적지 않는다. CSS 모듈에서 정의되지 않은 클래스를 꺼내면
        * 그 값이 `undefined` 가 되고, 그것은 **오타와 똑같은 모양**이다 — 클래스 이름 감사
        * (컴포넌트가 꺼내는 이름 전부를 CSS 의 선택자와 맞춰 보는 점검)에서 영원히 걸리면서,
        * 정작 진짜 오타를 찾을 때 신호가 아니라 잡음이 된다. 그려지는 모양은 어느 쪽이든 같다:
        * 레거시에도 적용되는 규칙이 없었으므로.
        */}
      <table>
        <colgroup>
          <col style={{ width: 150 }} />
          <col />
        </colgroup>
        <tbody>
          <tr>
            <th>TRANSLATOR</th>
            <td>{text(invoice.tranName)}</td>
          </tr>
          <tr>
            <th>PAYMENT DATE</th>
            {/*
              * 지급 **예정일**(`invMoPday`)이다. 실제 지급일(`invMoDay`)이 아니다 — 이 종이는
              * 지급 전에 번역가에게 가므로, 실제 지급일은 아직 없다. 둘을 바꿔 적으면 지급이
              * 끝난 뒤에만 값이 보이는 칸이 된다.
              */}
            <td>{formatDate(invoice.invMoPday)}</td>
          </tr>
          <tr>
            <th>E-mail</th>
            <td>{text(invoice.tranEmail)}</td>
          </tr>
        </tbody>
      </table>

      <table className={`${doc.estimateList} ${listAccent}`}>
        <colgroup>
          <col style={{ width: '5%' }} />
          <col />
          <col />
          <col />
          <col />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th />
            <th>{eng ? 'PRJ CODE' : '프로젝트 코드'}</th>
            <th>{eng ? 'PO CODE' : 'PO코드'}</th>
            <th>{eng ? 'PRJ NAME' : '프로젝트 명'}</th>
            <th>VOLUME</th>
            <th>RATE</th>
            <th>SUB TOTAL</th>
          </tr>
        </thead>
        <tbody>
          {pos.map((po, i) => (
            <tr key={po.id}>
              <td>{i + 1}</td>
              <td className={doc.ta_left}>{text(po.prjCode)}</td>
              <td>{po.poCode}</td>
              <td>{text(po.prjName)}</td>
              <td className={doc.ta_right}>{formatMoney(po.poVolume)}</td>
              <td className={doc.ta_right}>{formatMoney(po.poPrice)}</td>
              <td className={doc.ta_right}>
                {formatMoneyWithCoin(po.poPriceSum, po.poCoinCode)}
              </td>
            </tr>
          ))}
          {/*
            * 빈 행. `key` 가 인덱스인 것이 여기서는 맞다 — 내용이 없고 순서만 있는 행이므로
            * 재사용해도 잘못 섞일 내용이 없다.
            */}
          {Array.from({ length: padding }, (_, i) => (
            <tr key={`pad-${i}`}>
              <td />
              <td className={doc.ta_left} />
              <td />
              <td />
              <td className={doc.ta_right} />
              <td className={doc.ta_right} />
              <td className={doc.ta_right} />
            </tr>
          ))}
        </tbody>
      </table>

      <table className={doc.estimateSum}>
        <colgroup>
          <col style={{ width: '60%' }} />
          <col style={{ width: '40%' }} />
        </colgroup>
        <tbody>
          <tr>
            <th>Sub Total</th>
            <td>{formatMoney(subTotal.total)}</td>
          </tr>
          <tr>
            <th>Tax{taxPercent ? `(${formatMoney(taxPercent)}%)` : ''}</th>
            <td>{formatMoney(invoice.invTax)}</td>
          </tr>
          <tr>
            <th className={doc.bordertop}>Total</th>
            <td className={doc.bordertop}>{formatMoney(invoice.invSum)}</td>
          </tr>
        </tbody>
      </table>

      {/*
        * 통화가 섞인 묶음의 경고. 서식에 없던 줄이고, **없어야 정상인 줄**이다.
        *
        * 그래도 넣는 이유: 섞인 경우 위의 Sub Total 은 서로 다른 통화의 숫자를 더한 값이라 아무
        * 뜻이 없다. 그런 종이가 조용히 번역가에게 가는 것보다, 담당자가 저장 전에 보고 인보이스를
        * 쪼개는 쪽이 낫다. 정상 묶음에서는 이 줄이 그려지지 않으므로 서식의 모양은 그대로다.
        */}
      {mixedCoins ? (
        <div className={`${doc.h5Section} ${doc.txtred}`}>
          이 인보이스에 통화가 다른 PO 가 섞여 있습니다. 위의 Sub Total 은 서로 다른 통화를 더한
          값이므로 그대로 보내지 마십시오.
        </div>
      ) : null}

      <div className={doc.ta_right}>
        <strong className={doc.txtOragne}>LioNKOREA</strong>
        <br />
        {text(invoice.pmName)}
        <br />
        {text(invoice.pmPhone)}
        <br />
        {text(invoice.pmEmail)}
      </div>
    </div>
  )
}
