import { useRef, useState, type ReactNode } from 'react'
import { ErrorNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'
import { savePdfFromElement } from './exportPdf'
import { printElement } from './printElement'
import styles from './PrintDocModal.module.css'

/**
 * 인쇄용 서식을 띄우는 모달. **발주서와 인보이스가 같은 껍데기를 쓴다.**
 *
 * ## 레거시의 `.btnArea` 를 그대로 가져왔다
 *
 * 아래 버튼 세 개(PDF저장 · 출력 · 닫기)는 네 템플릿이 모두 같은 자리에 같은 순서로 가지고 있던
 * 것이다. 순서까지 지키는 이유는 담당자들이 몇 년째 **왼쪽 버튼**을 눌러 PDF 를 받아 왔기 때문이고,
 * 그 근육 기억이 틀리게 되는 변경은 서식의 모양을 바꾸는 것과 같은 종류의 손실이다.
 *
 * 레거시의 닫기는 `self.close()` 였다 — 서식이 따로 열린 창이었으므로. 여기서는 모달을 닫는다.
 *
 * ## 한/영은 탭이 아니라 교체다
 *
 * 두 서식을 동시에 그려 두고 한쪽을 `display: none` 으로 숨기는 흔한 방법을 쓰지 않는다.
 * html2canvas 는 **계산된 스타일을 읽어** 그리므로, 숨은 쪽을 캡처하면 폭 0 짜리 백지가 나온다.
 * 즉 숨겨 두면 "화면에는 영문 서식이 보이는데 저장된 PDF 는 한글" 같은 일이 생기고, 더 나쁜
 * 경우는 백지가 저장된다. 그래서 `children` 이 **함수**다 — 지금 고른 언어의 서식 하나만 존재한다.
 *
 * ## 저장 중에는 버튼이 잠긴다
 *
 * 캔버스를 뜨는 데 1000px × 2배율이면 몇백 ms 가 걸린다. 그 사이에 다시 누르면 같은 작업이 두 번
 * 돌고, 두 번째 캔버스가 먼저 끝나면 파일이 두 개 내려온다. 사용자에게는 "한 번 눌렀는데 두 개가
 * 받아졌다" 로 보인다.
 */

/** 서식의 언어. `purchase_order.po_lang` 과 같은 두 값이다. */
export type PrintLang = 'KOR' | 'ENG'

export const PRINT_LANG_KOR: PrintLang = 'KOR'
export const PRINT_LANG_ENG: PrintLang = 'ENG'

/**
 * 서식 언어의 기본값을 고른다.
 *
 * 발주는 `po_lang` 에 적혀 있고, 그 값은 발주를 올릴 때 담당자가 고른 것이다 — 즉 "이 번역가에게는
 * 영문 서식으로 보낸다" 는 결정이 이미 내려져 있다. 여기서 한국어로 열어 버리면 그 결정을 매번
 * 다시 눌러야 한다.
 *
 * 적혀 있지 않거나 알 수 없는 값이면 한국어다. 사용자 대부분이 국내 담당자이고, 틀렸을 때 고치기
 * 쉬운 쪽이다.
 */
export function printLangOf(value: string | null | undefined): PrintLang {
  return value?.trim().toUpperCase() === PRINT_LANG_ENG ? PRINT_LANG_ENG : PRINT_LANG_KOR
}

interface PrintDocModalProps {
  /** 모달 머리글. 예: `발주서 SPO_071763`. */
  title: string
  /** 저장될 PDF 파일명. 확장자까지 포함한 완성된 이름이다 — `pdfFileName()` 으로 만든다. */
  fileName: string
  initialLang?: PrintLang
  onClose: () => void
  /** 고른 언어의 서식 하나. 위 주석 참고 — 두 개를 그려 두고 숨기면 안 된다. */
  children: (lang: PrintLang) => ReactNode
}

export function PrintDocModal({
  title,
  fileName,
  initialLang = PRINT_LANG_KOR,
  onClose,
  children,
}: PrintDocModalProps) {
  /**
   * 캡처 대상. 서식을 **딱 감싸는** 상자를 가리킨다(`styles.docFrame`).
   *
   * 한 겹 바깥의 스크롤 상자(`styles.viewport`)를 가리키면 **보이는 만큼만** 떠진다 — 스크롤된
   * 상자는 자기 폭·높이가 내용보다 작고, html2canvas 는 그 치수를 쓴다. 그래서 스크롤 안쪽,
   * 서식 바로 위에 둔다. `.docFrame` 이 `width: max-content` 여야 하는 이유도 같다(저쪽 주석).
   */
  const docRef = useRef<HTMLDivElement>(null)

  const [lang, setLang] = useState<PrintLang>(initialLang)
  const [busy, setBusy] = useState<'pdf' | 'print' | null>(null)
  const [error, setError] = useState<unknown>(null)

  const run = async (kind: 'pdf' | 'print') => {
    const el = docRef.current
    if (!el || busy) return
    setBusy(kind)
    setError(null)
    try {
      if (kind === 'pdf') await savePdfFromElement(el, fileName)
      else await printElement(el, title)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      /*
       * 1000px 서식 + 스크롤 상자 여백 + 모달 본문 여백. 이보다 좁게 잡으면 넓은 화면에서도
       * 가로 스크롤이 생기고, 넓게 잡아도 패널은 `width: 100%` 이므로 창보다 커지지 않는다.
       */
      width={1060}
      footer={
        <>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void run('pdf')}
            disabled={busy !== null}
          >
            {busy === 'pdf' ? 'PDF 만드는 중…' : 'PDF저장'}
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnGhost}`}
            onClick={() => void run('print')}
            disabled={busy !== null}
          >
            출력
          </button>
          <button type="button" className={`${ui.btn} ${ui.btnGhost}`} onClick={onClose}>
            닫기
          </button>
        </>
      }
    >
      <ErrorNotice error={error} />

      <div className={styles.docBar}>
        <label className={ui.label} htmlFor="print-lang">
          서식
        </label>
        <select
          id="print-lang"
          className={ui.select}
          value={lang}
          onChange={(e) => setLang(e.target.value === PRINT_LANG_ENG ? PRINT_LANG_ENG : PRINT_LANG_KOR)}
        >
          <option value={PRINT_LANG_KOR}>국문</option>
          <option value={PRINT_LANG_ENG}>영문</option>
        </select>
        <span className={ui.spacer} />
        <span className={styles.docNote}>
          PDF 는 A4 세로로 저장됩니다. 출력은 브라우저의 인쇄 대화상자를 엽니다.
        </span>
      </div>

      <div className={styles.viewport}>
        <div ref={docRef} className={styles.docFrame}>
          {children(lang)}
        </div>
      </div>
    </Modal>
  )
}
