/**
 * PO 의 'CAT 분량' 표 계산 (팀장님 2026-11-25). 화면(`CatTable.tsx`)과 시험이 같이 쓴다 —
 * 그래서 `@/` 별칭 없이 쓴다(루트 tsc 가 시험에서 읽을 때 별칭을 못 푼다).
 *
 * - 구간: 반복 / 100% / 95% / 85% / 75% / 50% / 일치없음
 * - 소계 = 단어 × 가중치(%) 를 소수 첫째 자리에서 반올림한 정수, 합계 = 소계의 합
 * - 가중치는 고칠 수 없다. 기본값 하나, 번역가 '[거래처] Taijia' 만 예외.
 */

export const CAT_BANDS = ['반복', '100%', '95%', '85%', '75%', '50%', '일치없음'] as const

export const DEFAULT_CAT_WEIGHTS: readonly number[] = [10, 0, 30, 30, 30, 30, 100]
/** 번역가 '[거래처] Taijia' 의 가중치. */
export const TAIJIA_CAT_WEIGHTS: readonly number[] = [10, 0, 30, 60, 60, 100, 100]

/** 번역가 이름에 맞는 가중치. 띄어쓰기·대소문자는 보지 않는다. */
export function catWeightsFor(translatorName: string | null | undefined): readonly number[] {
  const key = (translatorName ?? '').replace(/\s+/g, '').toLowerCase()
  return key === '[거래처]taijia' ? TAIJIA_CAT_WEIGHTS : DEFAULT_CAT_WEIGHTS
}

/** 칸의 글 → 단어 수. 빈 칸·숫자 아닌 글은 null. 쉼표(1,234)는 뺀다. */
export function readWords(text: string): number | null {
  const t = text.replace(/[,\s]/g, '')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function catSubtotal(words: number | null, weight: number): number {
  if (words === null) return 0
  // 부동소수 오차(예: 0.35 → 0.34999…) 때문에 반올림이 한 칸 내려가지 않게 아주 작은 값을 더한다.
  return Math.round((words * weight) / 100 + 1e-9)
}

export function catTotal(words: readonly (number | null)[], weights: readonly number[]): number {
  return words.reduce<number>((sum, w, i) => sum + catSubtotal(w, weights[i] ?? 0), 0)
}

/**
 * 스프레드시트에서 복사한 글 → 칸들. 한 줄을 가로로 복사했으면 탭으로, 한 열을 세로로 복사했으면
 * 줄로 나눈다. 여러 줄 × 여러 열이면 숫자가 가장 많은 줄을 쓴다(머리글 줄이 같이 와도 되게).
 */
export function parseCatPaste(text: string): string[] {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return []
  const rows = lines.map((l) => l.split('\t').map((c) => c.trim()))
  if (rows.every((r) => r.length === 1)) return rows.map((r) => r[0] ?? '')
  const numeric = (r: string[]) => r.filter((c) => readWords(c) !== null).length
  return rows.reduce((best, r) => (numeric(r) > numeric(best) ? r : best), rows[0] ?? [])
}

/** 저장할 값. 단어가 하나도 없으면 null (표를 쓰지 않은 것). */
export function catDetail(words: readonly string[], weights: readonly number[]) {
  const nums = CAT_BANDS.map((_, i) => readWords(words[i] ?? ''))
  if (nums.every((n) => n === null)) return null
  const total = catTotal(nums, weights)
  const mid = [2, 3, 4, 5].reduce((s, i) => s + (nums[i] ?? 0), 0)
  return {
    detail: { words: nums, weights: [...weights] },
    total,
    /** 기존 칸에도 채운다: 일치없음 단어 / 95~50% 단어 합 / 가중 합계. */
    newWords: nums[6] ?? 0,
    midWords: mid,
  }
}
