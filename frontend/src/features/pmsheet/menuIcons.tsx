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

const tool = (children: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
)

/** 도구막대 단추 아이콘 (팀장님 2026-11-25 — 글자만 있던 메뉴를 아이콘 단추로). */
export const TOOL_ICONS = {
  /** 메모: 접힌 귀퉁이가 있는 쪽지 */
  note: tool(<><path d="M3 3h12v8l-4 4H3z" /><path d="M11 15v-4h4" /><path d="M6 7h6" /><path d="M6 10h3" /></>),
  /** 서식 지우기: 지우개 */
  clearFormat: tool(<><path d="M10.5 3.5 15 8l-6.5 6.5H5L2.5 12z" /><path d="M7 7l4.5 4.5" /><path d="M9 14.5h6.5" /></>),
  /** 조건부 서식: 칸 위의 붓 */
  cf: tool(<><rect x="2.5" y="2.5" width="8" height="8" rx="1" /><path d="M2.5 6.5h8" /><path d="M6.5 2.5v8" /><path d="M15.5 9.5 11 14" /><path d="M11 14l-1.5 2 2-.5" /></>),
  /** 열 관리: 세로 막대 셋 */
  columns: tool(<><rect x="2.5" y="3" width="13" height="12" rx="1" /><path d="M6.8 3v12" /><path d="M11.2 3v12" /></>),
  /** 단축키: 자판 */
  shortcuts: tool(<><rect x="1.5" y="4.5" width="15" height="9" rx="1.5" /><path d="M4.5 7.5h.01" /><path d="M7.5 7.5h.01" /><path d="M10.5 7.5h.01" /><path d="M13.5 7.5h.01" /><path d="M5.5 10.5h7" /></>),
  /** 행 통합: 두 줄이 하나로 */
  merge: tool(<><path d="M3 4h5l2 5h5" /><path d="M3 14h5l2-5" /><path d="M13 7l2 2-2 2" /></>),
  /** 통합 해제: 한 줄이 둘로 */
  unmerge: tool(<><path d="M3 9h5l2-5h5" /><path d="M8 9l2 5h5" /><path d="M13 2l2 2-2 2" /><path d="M13 12l2 2-2 2" /></>),
  /** 행 빼기: 줄에 빼기 */
  hide: tool(<><rect x="2.5" y="5.5" width="13" height="7" rx="1" /><path d="M6.5 9h5" /></>),
  /** 아카이빙: 보관 상자 (팀장님 2026-11-26) */
  archive: tool(<><rect x="2" y="3" width="14" height="4" rx="1" /><path d="M3.5 7v7.5h11V7" /><path d="M7 10h4" /></>),
  /** 필터 저장: 별 */
  favSave: tool(<path d="M9 2.5l1.9 4 4.3.5-3.2 3 .9 4.3L9 12.2l-3.9 2.1.9-4.3-3.2-3 4.3-.5z" />),
  /** 필터 해제: 깔때기에 × */
  filterClear: tool(<><path d="M2.5 3h11L9.5 8.5V14l-3 1.5v-7z" /><path d="M12.5 11.5l3 3" /><path d="M15.5 11.5l-3 3" /></>),
  /** 바뀐 칸 확인: 체크 */
  confirm: tool(<><path d="M3 9.5l3.5 3.5L15 4.5" /></>),
  /** 배율: 돋보기 */
  /** 고정: 압정 */
  freeze: tool(<><path d="M7 2.5h4" /><path d="M7.8 2.5v4.2L5 9.5h8l-2.8-2.8V2.5" /><path d="M9 9.5v6" /></>),
  zoom: tool(<><circle cx="7.5" cy="7.5" r="5" /><path d="M11.2 11.2 15.5 15.5" /></>),
}
