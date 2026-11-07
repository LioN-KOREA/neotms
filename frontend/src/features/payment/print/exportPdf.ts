import { jsPDF } from 'jspdf'
import html2canvas from 'html2canvas-pro'

/****************************************************
 * 화면에 그려진 서식을 A4 PDF 로 저장한다.
 *
 * ## 왜 캔버스를 거치나 — 글자를 글자로 넣지 않는 이유
 *
 * jsPDF 로 텍스트를 직접 그리면 글자가 글자로 들어가서 PDF 안에서 검색·복사가 된다. 그런데 그
 * 길로 가면 **서식을 두 번 만들어야 한다** — 한 번은 HTML 로(화면용), 한 번은 좌표로(PDF용).
 * 그리고 이 문서는 회사가 합의한 서식이므로, 둘이 어긋나는 순간 "화면에서는 맞는데 PDF 에서는
 * 칸이 밀린 발주서" 가 번역가에게 간다. 어긋났다는 사실을 알려 줄 것은 아무것도 없다.
 *
 * 그래서 레거시와 같은 선택을 유지한다: 화면에 그린 그대로를 캔버스로 떠서 이미지로 넣는다.
 * 서식은 한 벌이고, 화면에서 맞으면 PDF 에서도 맞는다.
 *
 * ## 레거시에서 바뀐 네 가지
 *
 * 레거시는 jsPDF 1.2.4 와 html2canvas 0.4.1(2013년)이었다. 지금은 jsPDF 4.x 와
 * html2canvas-pro 2.x 이고, 그 사이에 바뀐 것들:
 *
 * 1. **`onrendered` 콜백이 없어졌다.** 0.4.x 의 `onrendered` 옵션은 1.x 에서 제거되었고 지금은
 *    Promise 를 돌려준다. 콜백을 그대로 두면 **아무 일도 일어나지 않는다** — 캔버스는 만들어지고
 *    버려지며, 오류도 나지 않는다.
 *
 * 2. **`allowTaint: true` 를 버렸다.** 레거시가 켜 두었던 값이고, 켜면 CORS 로 못 읽는 이미지도
 *    캔버스에 그린다 — 대신 그 캔버스는 '오염' 되어 `toDataURL()` 이 `SecurityError` 를 던진다.
 *    즉 저장 단계에서 깨진다. 로고는 번들에 포함된 동일 출처 파일이므로 `useCORS` 만으로 충분하고,
 *    오염될 일 자체가 없다.
 *
 * 3. **페이지를 잘라서 넣는다.** 레거시는 전체 높이의 이미지 **한 장**을 페이지마다 음수 offset 으로
 *    다시 올렸다(`position = heightLeft - imgHeight`). 결과는 맞지만 같은 이미지가 N번 들어가서
 *    파일이 N배가 되고, PDF 뷰어는 페이지마다 전체 이미지를 디코딩한다. 여기서는 캔버스를 페이지
 *    높이만큼 잘라 각 페이지에 자기 몫만 넣는다.
 *
 * 4. **`scale: 2`.** 레거시는 기본값 1 이어서 1000px 짜리 서식이 210mm 에 들어가 ~120dpi 로
 *    나왔다 — 인쇄하면 글자 테두리가 눈에 보인다. 2 로 올리면 ~240dpi 다.
 *    `devicePixelRatio` 를 읽지 않는 이유는 `.printWrap` 의 폭을 1000px 로 고정한 이유와 같다:
 *    **같은 발주서가 노트북과 모니터에서 다른 파일로 나오면 안 된다.**
 ****************************************************/

/** A4 세로. mm. */
const A4_WIDTH_MM = 210
const A4_HEIGHT_MM = 297

/**
 * 캔버스 배율. 위 주석 4번 참고. 고정값인 것이 요점이다.
 *
 * 3 으로 올리지 않는 이유: 1000 × 2 = 2000px 폭의 PNG 는 2.5MB 쯤이고 메일에 붙는다. 3 이면
 * 5MB 를 넘고, 2 와 3 의 차이는 인쇄물에서 보이지 않는다.
 */
const CANVAS_SCALE = 2

/**
 * 마지막 조각이 이보다 얇으면 페이지를 더 만들지 않는다. mm.
 *
 * 없으면 서식 높이가 페이지 경계에 1px 걸칠 때마다 **거의 백지인 페이지**가 한 장 붙는다. 반올림
 * 오차 한 픽셀 때문에 두 장짜리 발주서가 세 장으로 인쇄되는 셈이고, 받는 쪽에서는 서식이 잘렸다고
 * 읽을 수도 있다.
 *
 * 레거시의 같은 자리 값은 20mm 였다(`while (heightLeft >= 20)`). 20mm 는 **본문 네 줄**이고,
 * 하필 서명란이 거기 걸리면 PM 연락처가 조용히 사라진다. 2mm 는 어떤 글자도 들어갈 수 없는
 * 두께다 — 빈 페이지만 거르고 내용은 거르지 않는 선.
 */
const MIN_TAIL_MM = 2

/**
 * 파일명에 쓸 수 없는 글자. 윈도우 기준이 가장 좁으므로 그것을 따른다.
 *
 * **하이픈과 공백은 이 목록에 없다.** 하이픈은 번역가 이름에 흔히 들어가고(레거시 파일명이
 * `SPO_071763_라이온-이정민.pdf` 이다), 공백은 아래에서 밑줄로 바꾼다 — 여기서 같이 지워
 * 버리면 그 치환은 영원히 아무 일도 하지 않는다.
 *
 * 뒤쪽 범위는 **제어문자**다(U+0000–U+001F). 사람이 입력한 이름 칸에 줄바꿈이나 탭이 섞여 들어올
 * 수 있고, 그런 글자가 든 파일명은 OS 에 따라 저장이 실패하거나 이름이 잘린 채 저장된다.
 *
 * 그래서 `no-control-regex` 를 끈다 — 이 경고는 "실수로 제어문자를 매칭했다" 를 잡는 것이고,
 * 여기서는 제어문자를 걸러 내는 것이 정규식의 목적 자체다.
 */
// oxlint-disable-next-line no-control-regex
const UNSAFE_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g

/**
 * 파일명을 안전하게 다듬는다.
 *
 * 레거시의 파일명은 `SPO_071763_라이온-이정민.pdf` 처럼 **발주 코드 + 번역가 이름**이었고, 그
 * 규칙을 유지한다 — 번역가가 받은 파일을 그대로 보관하므로 이름이 바뀌면 그쪽의 정리 방식이 깨진다.
 *
 * 이름 쪽이 사람이 입력한 값이라 다듬어야 한다. 실제로 `(편집) 김진우` 처럼 괄호가 들어간
 * 번역가명이 있고, 더 중요한 것은 `/` 다 — 한 글자만 섞여도 브라우저가 저장을 거부하거나 경로로
 * 해석한다. 공백은 밑줄로 바꾼다(레거시가 그랬다).
 */
export function pdfFileName(...parts: readonly (string | null | undefined)[]): string {
  const cleaned = parts
    .map((p) => (p ?? '').replace(UNSAFE_FILENAME, '').trim().replace(/\s+/g, '_'))
    .filter((p) => p.length > 0)
  return `${cleaned.length > 0 ? cleaned.join('_') : 'document'}.pdf`
}

/**
 * `el` 을 A4 PDF 로 떠서 내려받는다.
 *
 * 호출 쪽은 **`el` 이 화면에 붙어 있고 보이는 상태**임을 보장해야 한다. html2canvas 는 계산된
 * 스타일을 읽어 그리므로, `display: none` 인 요소는 폭 0 으로 잡혀 백지 한 장이 나온다 — 그래서
 * `PrintDocModal` 은 탭처럼 숨기지 않고 **서식을 교체**한다.
 */
export async function savePdfFromElement(el: HTMLElement, fileName: string): Promise<void> {
  const canvas = await html2canvas(el, {
    scale: CANVAS_SCALE,
    /*
     * 흰 배경을 **명시한다.** 기본값은 투명이고, 투명한 PNG 를 PDF 에 넣으면 뷰어에 따라 검게
     * 깔린다 — 글자색이 #555 이므로 그 순간 문서가 읽을 수 없게 된다. `.printWrap` 에도 같은
     * 이유로 `background: #fff` 가 있고, 여기는 캔버스 바깥 여백까지 덮는 쪽이다.
     */
    backgroundColor: '#ffffff',
    useCORS: true,
  })

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  /*
   * 캔버스 픽셀 ↔ mm 환산율. 캔버스의 **가로**를 A4 가로에 맞춘 것이므로 세로도 같은 비율이다.
   * `CANVAS_SCALE` 이 여기 다시 나오지 않는 이유가 그것이다 — 배율을 바꾸면 캔버스가 커지고
   * 환산율이 같이 커져서, 결과 PDF 의 치수는 그대로이고 해상도만 올라간다.
   */
  const pxPerMm = canvas.width / A4_WIDTH_MM
  const pageHeightPx = Math.floor(A4_HEIGHT_MM * pxPerMm)
  const minTailPx = MIN_TAIL_MM * pxPerMm

  /* 한 페이지에 들어가는 서식이 대부분이다. 그 경우 아래 루프는 한 바퀴만 돈다. */
  for (let top = 0, page = 0; top < canvas.height; page += 1) {
    const sliceHeight = Math.min(pageHeightPx, canvas.height - top)
    if (page > 0 && sliceHeight < minTailPx) break

    const slice = document.createElement('canvas')
    slice.width = canvas.width
    slice.height = sliceHeight

    const ctx = slice.getContext('2d')
    if (!ctx) throw new Error('PDF 를 만들 수 없습니다. 브라우저가 캔버스를 지원하지 않습니다.')

    /*
     * 조각마다 흰색을 먼저 깔아야 한다. 새 캔버스는 투명이고, 마지막 페이지는 보통 페이지 높이보다
     * 짧으므로 `addImage` 가 그 짧은 높이만큼만 그린다 — 깔지 않으면 그 페이지의 내용 영역이
     * 투명 PNG 가 되어 위와 같은 문제가 난다.
     */
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, slice.width, slice.height)
    ctx.drawImage(canvas, 0, top, canvas.width, sliceHeight, 0, 0, canvas.width, sliceHeight)

    if (page > 0) pdf.addPage()
    pdf.addImage(
      slice.toDataURL('image/png'),
      'PNG',
      0,
      0,
      A4_WIDTH_MM,
      sliceHeight / pxPerMm,
    )

    top += sliceHeight
  }

  pdf.save(fileName)
}
