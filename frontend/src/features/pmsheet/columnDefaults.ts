import type { PmStyle } from '../../apis/pmsheet.types'

/**
 * 모든 사용자의 기본 열 꾸밈 (팀장님 2026-11-25) — 행ID·인계일·업무·PO·도착일·시간·납품일·진행 상태·
 * PRCODE 는 가운데, 비고는 자동 줄바꿈. 사용자가 그 열을 직접 꾸미면 그 값이 이긴다(속성마다).
 * '서식 지우기' 를 하면 이 기본값으로 돌아간다.
 */
export const DEFAULT_COLUMN_STYLES: Record<string, PmStyle> = Object.fromEntries([
  ...['rowNo', 'handoverAt', 'task', 'trPo', 'trEday', 'trTime', 'rvPo', 'rvEday', 'rvTime', 'jobEday', 'jobTime', 'pmState', 'prjCode'].map(
    (k) => [k, { align: 'center' } as PmStyle],
  ),
  ['remark', { wrap: 'wrap' } as PmStyle],
])
