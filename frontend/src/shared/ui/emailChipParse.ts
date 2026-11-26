/** 메일 주소 칩 해석 — EmailChips 가 쓴다. 이름 <주소> / 주소. */
export type EmailChip = { name: string | null; email: string; valid: boolean; raw: string }

const EMAIL = /^[^@\s<>,;]+@[^@\s<>,;.]+(\.[^@\s<>,;.]+)+$/

/** 한 덩어리 글 → 칩 하나. */
export function parseEmailChip(raw: string): EmailChip | null {
  const text = raw.trim()
  if (!text) return null
  const angle = /^(.*?)<\s*([^<>]+?)\s*>\s*$/.exec(text)
  if (angle) {
    const name = angle[1]!.trim().replace(/^["']|["']$/g, '').trim()
    const email = angle[2]!.trim()
    return { name: name || null, email, valid: EMAIL.test(email), raw: text }
  }
  return { name: null, email: text, valid: EMAIL.test(text), raw: text }
}

/** 붙여 넣은 글 → 칩 여러 개. `<…>` 와 따옴표 안의 쉼표는 나누지 않는다. */
export function parseEmailList(text: string): EmailChip[] {
  const parts: string[] = []
  let cur = ''
  let depth = 0
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    if (ch === '<') depth++
    if (ch === '>') depth = Math.max(0, depth - 1)
    if (depth === 0 && !quoted && (ch === ',' || ch === ';' || ch === '\n')) {
      parts.push(cur)
      cur = ''
    } else cur += ch
  }
  parts.push(cur)
  return parts.map(parseEmailChip).filter((c): c is EmailChip => c !== null)
}


/**
 * 자주쓰는 참조 메일 단추의 기본 이름 (팀장님 2026-11-26): `이름 <주소>` 면 그 이름, 주소만이면 @ 앞 글자,
 * 여럿이면 첫 사람 뒤에 ' 외 n명'.
 */
export function ccFavName(chips: readonly Pick<EmailChip, 'name' | 'email'>[]): string {
  const first = chips[0]
  if (!first) return ''
  const head = first.name?.trim() || first.email.split('@')[0] || first.email
  return chips.length > 1 ? `${head} 외 ${String(chips.length - 1)}명` : head
}
