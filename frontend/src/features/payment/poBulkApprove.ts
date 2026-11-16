import type { PurchaseOrderRow } from '@/apis/neotms.types'
import { decimalSum, formatMoney, krwToShow } from '@/shared/utils/money'

/**
 * The rules for approving several purchase orders at once, in one place because two screens do it.
 *
 * The payment desk (`PoPaymentView`) approves from a filtered list of POs across every project; the
 * project screen (`ProjectDetailView`) approves the POs of the project being looked at. Same act,
 * same money, so the same wording and the same skip rule - and if these lived in both screens, one
 * of them would be corrected some day and the other would not.
 *
 * ## Already-approved rows are skipped, not re-sent
 *
 * `PATCH /purchase-orders/:id/approval` is idempotent, so re-approving an approved PO is harmless
 * on the server. It is not harmless here. A bulk run is sequential precisely because this system's
 * PostgreSQL connection budget is small (see `runSequential`), so sending requests that change
 * nothing spends the budget for nothing - and worse, the summary afterwards would report work that
 * did not happen: "30건을 승인했습니다" when 28 of them were already approved last week.
 *
 * So the caller approves `unapprovedOf(selection)`, and the prompt names both numbers when they
 * differ.
 *
 * ## The prompt states the money, not just the count
 *
 * Approving is the moment the amount on a PO becomes payable, and a count alone does not convey
 * that - "12건을 승인할까요?" could be twelve thousand won or twelve million. The total is the
 * figure the approver is actually signing off, so it goes in the question.
 *
 * Rows whose amount is missing are counted separately rather than treated as zero. A PO with no
 * amount is approvable (the payment screen explains why it does not block those), but it must not
 * silently shrink the total the approver is agreeing to.
 */

/** The selected rows that approval would actually change. */
export function unapprovedOf(rows: readonly PurchaseOrderRow[]): PurchaseOrderRow[] {
  return rows.filter((row) => !row.poApproved)
}

/**
 * The confirmation question for approving `rows`, which must already be the unapproved subset.
 *
 * `selectedCount` is the size of the whole selection, so the sentence can say how many were left
 * alone for being approved already.
 */
export function approvalPrompt(
  rows: readonly PurchaseOrderRow[],
  selectedCount: number,
): string {
  const { total, counted, skipped } = decimalSum(
    rows.map((row) => krwToShow(row.poPriceKrw, row.poPriceKsum)),
  )
  const alreadyDone = selectedCount - rows.length

  const lines = [
    `선택한 PO ${rows.length}건의 금액을 승인할까요?`,
    '',
    `원가 합계 ${formatMoney(total)}원 (${counted}건)` +
      (skipped > 0 ? ` · 금액 미입력 ${skipped}건 제외` : ''),
  ]
  if (alreadyDone > 0) {
    lines.push(`이미 승인된 ${alreadyDone}건은 그대로 둡니다.`)
  }
  lines.push('', '승인된 PO는 출력해 번역가에게 보낼 수 있고, 정산도 승인 뒤에만 가능합니다.')
  return lines.join('\n')
}

/** Shown instead of the prompt when every selected PO is already approved. */
export const ALL_ALREADY_APPROVED = '선택한 PO가 모두 이미 승인되어 있습니다.'
