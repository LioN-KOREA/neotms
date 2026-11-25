/** 도구막대 아이콘 (구글 시트 모양): 가로 정렬 / 세로 정렬 / 텍스트 줄바꿈. */
import type { ReactNode } from 'react'

const svg = (children: ReactNode) => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    {children}
  </svg>
)

export const ALIGN_ICONS = {
  left: svg(<><path d="M3 4h12" /><path d="M3 8h8" /><path d="M3 12h12" /><path d="M3 16h8" /></>),
  center: svg(<><path d="M3 4h12" /><path d="M5 8h8" /><path d="M3 12h12" /><path d="M5 16h8" /></>),
  right: svg(<><path d="M3 4h12" /><path d="M7 8h8" /><path d="M3 12h12" /><path d="M7 16h8" /></>),
}
export const VALIGN_ICONS = {
  top: svg(<><path d="M3 3h12" /><path d="M9 15V6" /><path d="M6 9l3-3 3 3" /></>),
  middle: svg(<><path d="M3 9h12" /><path d="M9 2v4" /><path d="M7 4.5 9 6.5l2-2" /><path d="M9 16v-4" /><path d="M7 13.5 9 11.5l2 2" /></>),
  bottom: svg(<><path d="M3 15h12" /><path d="M9 3v9" /><path d="M6 9l3 3 3-3" /></>),
}
export const WRAP_ICONS = {
  overflow: svg(<><path d="M3 3v12" /><path d="M6 9h9" /><path d="M12 6l3 3-3 3" /></>),
  wrap: svg(<><path d="M3 3v12" /><path d="M15 3v12" /><path d="M6 6h4.5a2.5 2.5 0 0 1 0 5H7" /><path d="M8.5 9.5 7 11l1.5 1.5" /></>),
  clip: svg(<><path d="M3 3v12" /><path d="M12 3v12" /><path d="M5.5 9h5" /></>),
}


export function FunnelIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M1 1.5h10L7.2 6.2V10L4.8 11V6.2z" fill="currentColor" />
    </svg>
  )
}
