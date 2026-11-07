import type { PurchaseOrderRow } from '@/apis/neotms.types'
import { isLinguistic } from '@/apis/neotms.codes'
import { formatDate } from '@/shared/utils/format'
import { formatMoney, formatMoneyWithCoin } from '@/shared/utils/money'
import { PRINT_LANG_ENG, type PrintLang } from './PrintDocModal'
import doc from './printDoc.module.css'
import logo from './print_logo.png'

/**
 * 인쇄용 발주서(PURCHASE ORDER). **국문·영문 두 서식이 이 한 컴포넌트다.**
 *
 * ## 네 템플릿이 두 컴포넌트인 이유
 *
 * 프로젝트 루트의 `PO_TEMPLATE/PO_FORM.html` 과 `PO_TEMPLATE_ENG/PO_TEMPLATE_ENG.html` 을 나란히
 * 놓고 비교하면, 다른 것은 **강조색 · 라벨 몇 개 · REMARKS 문구** 뿐이다. 표의 구조, 열 폭, 행 순서,
 * 서명란 위치가 모두 같다. 그래서 두 파일로 베껴 두지 않았다 — 베껴 두면 "국문에만 생긴 수정" 이
 * 반드시 나오고, 그 차이는 둘을 나란히 열어 보기 전까지 보이지 않는다.
 *
 * ## 강조색은 언어가 고른다
 *
 * 국문은 주황(`txtOragne` · `bgOragne` · PAYMENT 머리글은 `bgYellow`), 영문은 청록(`txtCyan` ·
 * `bgCyan`)이다. 레거시가 그렇게 해 두었고, 색이 서식의 신분증처럼 쓰이고 있다 — 담당자는 종이를
 * 보고 "주황이니까 국문 발주서" 로 읽는다. `txtOragne` 의 철자가 틀린 것(Orange 가 아니다)도
 * 레거시 그대로다. 고치면 `printDoc.module.css` 와 어긋난다.
 *
 * 한 가지 예외: 서명란의 `LioNKOREA` 는 **두 서식 모두 주황**이다. 영문 템플릿에서도 그 한 줄만
 * `txtOragne` 이고, 회사 이름의 색이므로 서식 강조색과 별개로 읽힌다.
 *
 * ## 템플릿과 일부러 다르게 한 세 군데
 *
 * 1. **E-mail 행을 영문 서식에도 넣었다.** 국문 템플릿에는 있고 영문 템플릿에는 없다. 영문
 *    템플릿이 실제 데이터가 박힌 **옛 저장본**이고 국문 쪽만 `{placeholder}` 로 갱신된 것이
 *    원인으로 보인다 — 해외 번역가에게 보내는 발주서에서 이메일 행을 뺄 이유를 찾을 수 없다.
 *    (`poTranEmail` 컬럼을 추가한 이유가 이 행이다.)
 * 2. **`PM 요청사항` 머리글은 영문 서식에서도 한국어다.** 이건 템플릿 그대로다. 번역해 넣고 싶은
 *    충동이 들지만, 서식 문구를 바꾸는 것은 회사가 합의한 양식을 바꾸는 일이므로 여기서 할 일이
 *    아니다. 바꿀 거라면 업무 쪽에서 정하고 이 줄을 같이 고치면 된다.
 * 3. **두 서식에 같은 최소 높이를 준다.** 국문 템플릿만 `min-height` 를 인라인으로 달고 있다
 *    (요청사항 100px, REMARKS 150px). 영문 쪽에 없으면 요청사항이 비었을 때 한 줄짜리 띠가 되어
 *    같은 문서가 언어에 따라 다른 모양이 된다.
 *
 * ## LANGUAGE 칸은 비언어 발주에서 업무 분류가 된다
 *
 * MICE·IMC 발주에는 언어쌍이 없다. 그 칸에 `? > ?` 를 찍는 것은 데이터가 빠졌다는 뜻이 되어버리고,
 * 그건 발주서에 적을 말이 아니다 — 업무 구분을 도입한 이유가 정확히 그 혼동이었다(`poType` 주석).
 * 그래서 비언어 발주는 라벨과 값을 같이 바꾼다. 작업 목록·프로젝트 상세가 이미 같은 분기를 한다.
 */

/** 값이 없는 칸. 레거시가 빈 칸으로 두었으므로 `-` 같은 표식을 넣지 않는다. */
const EMPTY = ''

const text = (value: string | null | undefined): string => value?.trim() || EMPTY

/** 레거시 템플릿의 인라인 `min-height`. 위 주석 3번 참고. */
const MIN_H_REQUEST = { minHeight: 100 }
const MIN_H_REMARKS = { minHeight: 150 }

interface PoPrintDocProps {
  po: PurchaseOrderRow
  lang: PrintLang
}

export function PoPrintDoc({ po, lang }: PoPrintDocProps) {
  const eng = lang === PRINT_LANG_ENG

  /* 강조색 세 자리. 위 주석 참고. */
  const accentText = eng ? doc.txtCyan : doc.txtOragne
  const accentBg = eng ? doc.bgCyan : doc.bgOragne
  const paymentHead = eng ? `${doc.bgCyan} ${doc.txtWhite}` : doc.bgYellow

  /*
   * 언어쌍인지 업무 분류인지. `isLinguistic` 을 쓰는 이유는 그 함수가 "모르는 구분은 비언어로
   * 본다" 는 판정 방향을 가지고 있기 때문이다 — 유지보수에서 네 번째 업무 구분이 추가되어도
   * 이 발주서는 `? > ?` 대신 업무 분류를 찍는다. 같은 분기를 직접 쓰면 그 보장이 사라진다.
   */
  const linguistic = isLinguistic(po.poType)

  return (
    <div className={doc.printWrap}>
      <div className={doc.pageHead}>
        <img src={logo} alt="LioNKOREA" />
        <strong className={doc.txtSize20}>PURCHASE ORDER</strong>
        <strong className={`${doc.txtSize20} ${accentText}`}>{po.poCode}</strong>
      </div>

      <table className={doc.estimate}>
        <colgroup>
          <col style={{ width: '18%' }} />
          <col />
          <col style={{ width: '18%' }} />
          <col />
          <col />
        </colgroup>
        <tbody>
          <tr>
            <th className={doc.borderbottom}>TRANSLATOR</th>
            <td className={doc.borderbottom}>{text(po.poTranName)}</td>
            <th className={doc.borderbottom}>
              {linguistic ? 'LANGUAGE' : eng ? 'CATEGORY' : '업무 분류'}
            </th>
            <td className={doc.borderbottom}>
              {linguistic
                ? `${text(po.poSlang)} > ${text(po.poElang)}`
                : text(po.poCategory)}
            </td>
            <td className={doc.borderbottom}>{text(po.prjCode)}</td>
          </tr>
          <tr>
            <th className={doc.borderbottom}>E-mail</th>
            <td className={doc.borderbottom} colSpan={4}>
              {text(po.poTranEmail)}
            </td>
          </tr>
          <tr>
            <th>{eng ? 'DATE OF ISSUE' : '의뢰일'}</th>
            {/*
              * `(GMT+9)` 는 레거시 그대로 고정 문자열이다. 서버가 날짜를 KST 로 내려 주므로
              * 사실에 맞고, 해외 번역가가 마감 시각을 자기 시간대로 환산할 수 있는 유일한 근거다.
              */}
            <td>
              {formatDate(po.poSday)}
              <br />
              (GMT+9)
            </td>
            <th>{eng ? 'DEADLINE' : '마감일'}</th>
            <td>
              <strong className={`${doc.txtSize15} ${accentText}`}>{formatDate(po.poEday)}</strong>
            </td>
            <td className={`${accentBg} ${doc.txtSize15} ${doc.txtWhite}`}>
              {text(po.poEdayTime)}
            </td>
          </tr>
        </tbody>
      </table>

      <br />

      <h5 className={doc.bgGray}>PM 요청사항</h5>
      {/*
        * 요청사항이 비면 `N/A` 다 — 레거시가 그렇게 찍었다. 빈 칸으로 두는 것과 다르다: 빈 칸은
        * "적는 것을 잊었다" 로 읽히고, N/A 는 "요청사항 없음" 으로 읽힌다. 번역가가 PM 에게
        * 되묻는 횟수가 그 차이에서 나온다.
        */}
      <div className={doc.h5Section} style={MIN_H_REQUEST}>
        {text(po.poContent) || 'N/A'}
      </div>

      <h5 className={doc.bgGray}>REMARKS</h5>
      <div className={doc.h5Section} style={MIN_H_REMARKS}>
        {eng ? <RemarksEng /> : <RemarksKor />}
      </div>

      <h5 className={paymentHead}>PAYMENT</h5>
      <table className={doc.basic}>
        <colgroup>
          <col />
          <col />
          <col />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr>
            {/*
              * 첫 열의 머리글은 **단위 코드 그 자체**다(`{unit}`). 영문 템플릿에 `WORD` 가 박혀
              * 있는 것은 그 샘플의 단위가 WORD 였기 때문이고, 글자·페이지·시간 단위 발주도 있다.
              */}
            <th className={doc.ta_right}>{text(po.poUnitCode) || 'VOLUME'}</th>
            <th className={doc.ta_right}>RATE</th>
            <th className={doc.ta_right}>SUB TOTAL</th>
            <th className={doc.ta_right}>TAX{po.poTax ? `(${formatMoney(po.poTax)}%)` : ''}</th>
            <th className={doc.ta_right}>TOTAL</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className={doc.ta_right}>{formatMoney(po.poVolume)}</td>
            <td className={doc.ta_right}>{formatMoney(po.poPrice)}</td>
            <td className={doc.ta_right}>{formatMoney(po.poPriceSum)}</td>
            <td className={doc.ta_right}>{formatMoney(po.poTaxPrice)}</td>
            {/*
              * TOTAL 에만 통화 코드를 붙인다.
              *
              * 이 숫자가 번역가가 실제로 받는 금액이고, 발주는 외화로도 나간다. `6,412` 가 원인지
              * 달러인지 적혀 있지 않은 발주서는 이 문서가 낼 수 있는 가장 비싼 오류다 — 나머지
              * 칸(물량·단가·소계)은 같은 통화임이 문맥으로 분명하므로 레거시처럼 숫자만 적는다.
              */}
            <td className={doc.ta_right}>{formatMoneyWithCoin(po.poTaxSum, po.poCoinCode)}</td>
          </tr>
        </tbody>
      </table>

      <div className={doc.ta_right}>
        <strong className={doc.txtOragne}>LioNKOREA</strong>
        <br />
        {text(po.poPmName)}
        <br />
        {text(po.poPmPhone)}
        <br />
        {text(po.poPmEmail)}
      </div>
    </div>
  )
}

/**
 * 국문 REMARKS. **문구를 다듬지 않는다.**
 *
 * 네 항목은 기밀유지 의무와 파일 회신 규칙을 담고 있고, 번역가가 몇 년째 같은 문장을 받아 왔다.
 * 레거시의 줄바꿈 위치(`<br>` 와 `&nbsp;` 들여쓰기)까지 옮긴 이유는 3번 항목의 `'_성명'` 처럼
 * 따옴표 안의 예시가 줄 끝에 걸리면 읽기가 나빠지기 때문이다.
 */
function RemarksKor() {
  return (
    <>
      1. 본 프로젝트와 관련하여 문의사항이나 문제가 있는 경우 담당 PM에게 연락해 주십시오.
      <br />
      2. 본 프로젝트에는 고객사와 기밀정보가 포함되어 있습니다. 본 프로젝트를 통하여 알게 된 모든
      정보를
      <br />
      {/*
        * 아래 두 줄 앞의 `{'…'}` 안에 들어 있는 것은 **줄바꿈 없는 공백(U+00A0)** 이다. 소스에서는
        * 보통 공백과 구별되지 않으니 주의 — 보통 공백으로 바꾸면 HTML 이 연속 공백을 한 칸으로
        * 줄여서 들여쓰기가 사라지고, 2번 항목의 둘째·셋째 줄이 번호 자리까지 올라붙는다. 레거시가
        * 같은 자리에 `&nbsp;` 를 쓴 이유가 그것이다.
        */}
      {'  '}당사 이외의 제3자에게 발설하는 행위는 기밀유지계약 준수 의무조항에 저촉되므로
      세심한 주의를 부탁
      <br />
      {'   '}드립니다.
      <br />
      3. 번역이 완료된 파일의 파일명은 바꾸지 마시고, 파일명 끝에 '_성명'을 붙여서 회신해 주시기
      바랍니다.
      <br />
      4. 해당 프로젝트의 스케줄을 확인하여 마감일과 시간을 반드시 지켜주세요.
    </>
  )
}

/** 영문 REMARKS. 국문과 같은 네 항목이고, 레거시 영문 템플릿의 문장 그대로다. */
function RemarksEng() {
  return (
    <>
      1. If you have any questions about the project, contact the project manager (PM) directly.
      <br />
      2. This project contains confidential information. Sharing or disclosing any information
      obtained through this project to any third-party constitutes a breach of confidentiality.
      <br />
      3. When submitting deliverables, include your name at the end of the original file name,
      separated by an underscore (e.g., "project.docx" → "project_name.docx").
      <br />
      4. Make sure to check the project schedule and adhere to the deadline (i.e., date and time).
    </>
  )
}
