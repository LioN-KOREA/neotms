import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import styles from './Modal.module.css'

interface ModalProps {
  title: string
  onClose: () => void
  children: ReactNode
  /** 오른쪽 아래. 보통 취소 + 저장. */
  footer?: ReactNode
  width?: number
  /**
   * 입력 중인 내용이 있는지. true 면 Escape·배경 클릭·× 가 한 번 묻는다.
   *
   * 관리 콘솔의 모달은 필드가 두세 개라 실수로 닫혀도 다시 입력하면 됐다. 여기는 작업 등록이
   * 20개 필드이고, 금액·환율·납기를 보고 옮겨 적은 뒤다 — 배경을 잘못 클릭해서 그게 사라지면
   * 사용자는 같은 일을 처음부터 다시 한다. 묻는 비용(확인 한 번)이 잃는 비용보다 훨씬 작다.
   */
  isDirty?: boolean
}

const DISCARD_MESSAGE = '입력한 내용이 저장되지 않습니다. 닫을까요?'

/**
 * 최소한의 다이얼로그.
 *
 * Escape 와 배경 클릭으로 닫히고, 열릴 때 포커스가 패널로 들어온다 — 그렇지 않으면 키보드
 * 사용자는 뒤에 있는 페이지에 그대로 남는다.
 */
export function Modal({ title, onClose, children, footer, width = 560, isDirty = false }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)

  /**
   * isDirty 를 ref 로도 들고 있어야 아래 이펙트가 매 타이핑마다 재실행되지 않는다.
   *
   * 대입을 렌더 중에 하지 않고 이펙트로 미루는 이유가 두 가지다. 렌더 중 ref 쓰기는 React
   * Compiler 가 이 컴포넌트의 메모이제이션을 **포기하는** 조건이고(빌드에 플러그인이 켜져
   * 있다), StrictMode 의 이중 렌더에서 의미가 모호해진다. 한 렌더 늦어도 괜찮다 — 사용자
   * 이벤트(Escape·클릭)가 도착하기 전에 React 가 이펙트를 먼저 비우기 때문에, 핸들러가
   * 읽는 시점에는 항상 최신 값이다.
   */
  const dirtyRef = useRef(isDirty)
  useEffect(() => {
    dirtyRef.current = isDirty
  }, [isDirty])

  const requestClose = useCallback(() => {
    if (dirtyRef.current && !window.confirm(DISCARD_MESSAGE)) return
    onClose()
  }, [onClose])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose()
    }
    document.addEventListener('keydown', onKeyDown)
    // 다이얼로그가 떠 있는 동안 뒤쪽 페이지가 스크롤되면 안 된다.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [requestClose])

  return (
    <div className={styles.backdrop} onMouseDown={requestClose}>
      <div
        ref={panelRef}
        className={styles.panel}
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        // 패널 안쪽 클릭이 배경의 닫기 핸들러까지 올라가지 않게 막는다.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button type="button" className={styles.close} onClick={requestClose} aria-label="닫기">
            ×
          </button>
        </header>
        <div className={styles.body}>{children}</div>
        {footer ? <footer className={styles.footer}>{footer}</footer> : null}
      </div>
    </div>
  )
}
