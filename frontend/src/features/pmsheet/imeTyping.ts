/**
 * 칸에서 바로 한글 치기 (팀장님 2026-11-26).
 *
 * ReactGrid 는 칸을 고르면 포커스를 숨은 입력칸(`.rg-hidden-element`)에 두고, 한글 조합이 끝나야
 * (한 글자를 다 쳐야) 편집을 시작한다. 그래서 자음을 치는 동안 아무것도 안 보였다. 조합 중에 포커스를
 * 편집기로 옮기는 방법(첫 키에서 편집기 열기)은 실제 입력기에서 첫 자모를 잃었다 — 조합은 이미 숨은
 * 칸에서 시작됐기 때문이다.
 *
 * 그래서 포커스를 옮기지 않는다: 조합이 시작되면 그 숨은 칸을 고른 칸 위에 보이게 펼쳐서 거기서 그대로
 * 친다. Enter·Tab·↑↓·다른 곳 누르기로 확정, Esc 로 취소. 확정한 글자는 보통 칸 고치기와 같은 길로
 * 저장되어 실행취소도 같다.
 */
import { useEffect, useRef, type RefObject } from 'react'

export interface ImeTypingHandlers {
  /** 지금 고른 칸에 글을 칠 수 있는가 (고칠 수 없는 칸·목록 칸이면 false — 원래대로 둔다). */
  canStart: () => boolean
  /** 확정한 글자. */
  commit: (text: string) => void
}

export function useImeTyping(box: RefObject<HTMLDivElement | null>, handlers: ImeTypingHandlers) {
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })
  /** 조합 입력 중이면 true — 시트 단축키(Ctrl+Z·Delete 등)가 끼어들지 않게. */
  const active = useRef(false)

  useEffect(() => {
    const root = box.current
    if (!root) return
    let el: HTMLInputElement | null = null
    let savedStyle = ''

    const isHidden = (t: EventTarget | null): t is HTMLInputElement =>
      t instanceof HTMLInputElement && t.classList.contains('rg-hidden-element')

    const show = (input: HTMLInputElement): boolean => {
      const focus = root.querySelector('.rg-cell-focus')
      if (!focus) return false
      const r = focus.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return false
      savedStyle = input.getAttribute('style') ?? ''
      input.style.cssText = [
        savedStyle,
        'position:fixed',
        `left:${String(r.left)}px`,
        `top:${String(r.top)}px`,
        `width:${String(Math.max(r.width, 140))}px`,
        `height:${String(Math.max(r.height, 22))}px`,
        'opacity:1',
        'z-index:1000',
        'background:#fff',
        'color:#1f2328',
        'border:2px solid #1a73e8',
        'padding:0 4px',
        'margin:0',
        'font-size:13px',
        'box-sizing:border-box',
        'outline:none',
        'pointer-events:auto',
        'clip:auto',
        'clip-path:none',
      ].join(';')
      return true
    }

    const finish = (commit: boolean) => {
      if (!el) return
      const input = el
      const text = input.value
      el = null
      active.current = false
      input.setAttribute('style', savedStyle)
      input.value = ''
      if (commit && text.trim() !== '') latest.current.commit(text)
    }

    const onStart = (e: CompositionEvent) => {
      if (el || !isHidden(e.target)) return
      if (!latest.current.canStart()) return
      if (!show(e.target)) return
      el = e.target
      active.current = true
    }
    // 조합이 끝나도 ReactGrid 가 편집을 시작하지 않게 — 계속 이 칸에서 친다.
    const onEnd = (e: CompositionEvent) => {
      if (el && e.target === el) e.stopPropagation()
    }
    const onKey = (e: KeyboardEvent) => {
      if (!el || e.target !== el) return
      if (e.isComposing || e.keyCode === 229) {
        e.stopPropagation()
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        finish(true)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(false)
        return
      }
      if (e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // 확정하고 시트가 평소처럼 옆·아래 칸으로 옮기게 둔다.
        finish(true)
        return
      }
      // 그 밖의 키(글자·지우기·←→)는 이 입력칸의 것 — 시트로 보내지 않는다.
      e.stopPropagation()
    }
    const onBlur = (e: FocusEvent) => {
      if (el && e.target === el) finish(true)
    }
    const onDown = (e: PointerEvent) => {
      if (el && e.target !== el) finish(true)
    }

    root.addEventListener('compositionstart', onStart, true)
    root.addEventListener('compositionend', onEnd, true)
    root.addEventListener('keydown', onKey, true)
    root.addEventListener('focusout', onBlur, true)
    window.addEventListener('pointerdown', onDown, true)
    return () => {
      finish(false)
      root.removeEventListener('compositionstart', onStart, true)
      root.removeEventListener('compositionend', onEnd, true)
      root.removeEventListener('keydown', onKey, true)
      root.removeEventListener('focusout', onBlur, true)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [box])

  return active
}
