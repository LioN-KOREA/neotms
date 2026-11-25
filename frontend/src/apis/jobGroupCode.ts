/** 작업 그룹 코드 'J6012' → 6012 (정렬용). 모양이 틀리면 맨 뒤. 화면과 시험이 같이 쓴다. */
export function groupNumber(code: string | null | undefined): number {
  const m = /^[A-Z](\d+)$/.exec(code ?? '')
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}
