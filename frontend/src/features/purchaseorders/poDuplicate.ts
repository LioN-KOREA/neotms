import { MONEY_STATE_UNPAID, PO_STATE_UNAPPROVED } from '@/apis/neotms.codes'
import type { PurchaseOrderInput, PurchaseOrderRow } from '@/apis/neotms.types'

/**
 * 발주 한 건을 복제할 때 보낼 등록 본문.
 *
 * ## 규칙은 작업 복제와 같다 — 일과 값은 베끼고, 일어난 사건은 베끼지 않는다
 *
 * 발주 쪽은 그 '사건' 이 훨씬 많고, 전부 **돈에 관한 것**이다. 그래서 작업 복제보다 되돌릴 칸이
 * 많다. 셋으로 나뉜다:
 *
 * **1. 세금계산서 사실** — `poInvoiceState`, `invCode`, `invDt`.
 *   이 셋은 "이 발주가 어느 인보이스에 실려 청구되었는가" 를 말한다. 베끼면 새 발주가 **자기가
 *   실려 있지도 않은 인보이스의 번호를 들고** 태어난다. 그 번호로 인보이스를 뽑으면 금액이 두
 *   배로 나오고, 어느 쪽이 가짜인지는 인보이스에 적혀 있지 않다.
 *
 * **2. 지급 사실** — `poMoneyState`, `poMoneyDay`, `poMoneyPrice`, `poMoneyGubun`.
 *   원본이 '정산완료' 라면 베낀 발주도 정산완료로 태어난다. 즉 **아직 한 푼도 주지 않은 번역가
 *   에게 줄 돈이 미정산 목록에서 사라진다.** 조용히 사라지는 쪽이라 아무도 신고하지 않는다.
 *
 * **3. 진행 상태** — `poState`, `poStateDt`. 작업 복제와 같은 이유다.
 *
 * ## 네 칸은 타입이 막아 준다
 *
 * `poApproved`·`poApprovedAt`·`poApprovedBy`·`invoiceTranslatorId` 는 `PurchaseOrderInput` 에
 * 애초에 없다. 승인은 결제 권한의 별도 엔드포인트만 쓰고(`PoApprovalInput`), 인보이스 귀속은
 * 인보이스 발행·취소만 쓴다. 즉 복제가 승인된 발주를 만들어 낼 방법이 **없다** — 여기서 조심해서
 * 그런 것이 아니라 입력 타입이 그렇게 생겨서 그렇다. 둘 중에서는 후자가 지켜진다.
 *
 * ## 그대로 가는 것들
 *
 * 번역가(`translatorId`)는 베낀다. 같은 사람에게 같은 종류의 일을 또 맡기는 것이 복제를 쓰는
 * 가장 흔한 이유다. CAT 분석 네 칸(`poCat*`)과 세금 세 칸(`poTax*`)도 그 일의 값이므로 그대로
 * 간다 — `poCat*` 은 이름이 비슷하지만 업무 분류(`poCategory`)와 아무 관계가 없는, CAT 툴
 * 분석 수치다.
 *
 * `poLang`(인쇄용 발주서의 한/영 서식)도 그대로다. 같은 번역가에게 보내는 문서의 언어가 바뀔
 * 이유가 없다.
 */
export function duplicatePurchaseOrderInput(row: PurchaseOrderRow): PurchaseOrderInput {
  return {
    jobId: row.jobId,
    // 이름은 서버에서 필수다. 작업 복제와 같은 처리다.
    poName: row.poName || row.poCode,
    poWorkCode: row.poWorkCode,
    poCatUse: row.poCatUse,
    poCatWord: row.poCatWord,
    poCatMid: row.poCatMid,
    poCatStotal: row.poCatStotal,
    poPmId: row.poPmId,
    translatorId: row.translatorId,
    poType: row.poType,
    poSlang: row.poSlang,
    poElang: row.poElang,
    poCategory: row.poCategory,
    poVolume: row.poVolume,
    poUnitCode: row.poUnitCode,
    poPriceSel: row.poPriceSel,
    poPrice: row.poPrice,
    poCoinCode: row.poCoinCode,
    /* 정산 플래그. 베끼는 이유는 `duplicateJobInput` 의 `coinRate` 주석과 같다. */
    poCoinRate: row.poCoinRate,
    poPriceSum: row.poPriceSum,
    poPriceKsum: row.poPriceKsum,
    poTax: row.poTax,
    poTaxPrice: row.poTaxPrice,
    poTaxSum: row.poTaxSum,
    poSday: row.poSday,
    poSdayTime: row.poSdayTime,
    poEday: row.poEday,
    poEdayTime: row.poEdayTime,
    poLang: row.poLang,
    poContent: row.poContent,

    /*
     * 여기서부터가 되돌리는 칸들. 위 세 묶음이다.
     *
     * `null` 로 **명시해서** 보낸다. 생략해도 서버가 비워 두기는 하지만, 생략은 "깜빡했다" 와
     * 구별되지 않는다 — 이 파일을 다음에 읽는 사람이 알아야 하는 것은 그 칸이 빠졌다는 사실이
     * 아니라 **일부러 비웠다**는 사실이다.
     */
    poState: PO_STATE_UNAPPROVED,
    poStateDt: null,
    poInvoiceState: null,
    poMoneyState: MONEY_STATE_UNPAID,
    poMoneyDay: null,
    poMoneyPrice: null,
    poMoneyGubun: null,
    invCode: null,
    invDt: null,
  }
}
