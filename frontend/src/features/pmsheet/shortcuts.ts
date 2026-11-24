/**
 * PM 시트 단축키 — 기본값 + 사용자 지정(prefs.shortcuts.map, 동작 → 조합).
 *
 * 복사·붙여넣기·잘라내기(Ctrl+C/V/X)와 방향키·Enter 는 ReactGrid 가 처리하므로 여기서 바꾸지 않는다.
 */
export const ACTIONS: { id: string; label: string; fallback: string }[] = [
  { id: 'undo', label: '실행취소', fallback: 'Ctrl+Z' },
  { id: 'redo', label: '재실행', fallback: 'Ctrl+Y' },
  { id: 'bold', label: '굵게', fallback: 'Ctrl+B' },
  { id: 'italic', label: '기울임', fallback: 'Ctrl+I' },
  { id: 'underline', label: '밑줄', fallback: 'Ctrl+U' },
  { id: 'strike', label: '취소선', fallback: 'Alt+Shift+5' },
  { id: 'note', label: '메모 달기', fallback: 'Shift+F2' },
  { id: 'today', label: '오늘 날짜(시간 칸은 지금 시각) 넣기', fallback: 'Ctrl+;' },
  { id: 'clearFilters', label: '필터 모두 해제', fallback: 'Ctrl+Shift+L' },
  { id: 'alignLeft', label: '왼쪽 정렬', fallback: 'Ctrl+Shift+J' },
  { id: 'alignCenter', label: '가운데 정렬', fallback: 'Ctrl+Shift+E' },
  { id: 'alignRight', label: '오른쪽 정렬', fallback: 'Ctrl+Shift+R' },
  { id: 'clearFormat', label: '서식 지우기', fallback: 'Ctrl+\\' },
  { id: 'todayBar', label: '오늘 할 일 펼치기/접기', fallback: 'Alt+T' },
]

export const DEFAULT_SHORTCUTS: Record<string, string> = Object.fromEntries(ACTIONS.map((a) => [a.id, a.fallback]))

export function effectiveShortcuts(custom: Record<string, string> | undefined): Record<string, string> {
  return { ...DEFAULT_SHORTCUTS, ...(custom ?? {}) }
}

const KEY_NAMES: Record<string, string> = { ' ': 'Space', Escape: 'Esc' }

/** 키 이벤트 → 'Ctrl+Shift+B' 같은 조합. 수정키만 눌렸으면 null. */
export function comboOf(e: KeyboardEvent): string | null {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return null
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  // Shift 와 숫자를 같이 누르면 e.key 가 '%' 처럼 바뀐다 — 자판 위치(code)로 읽는다.
  let key = e.key
  if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (e.code === 'Semicolon') key = ';'
  else if (e.code === 'Backslash') key = '\\'
  key = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  if (parts.length === 0 && !/^F\d+$/.test(key)) return null
  parts.push(key)
  return parts.join('+')
}
