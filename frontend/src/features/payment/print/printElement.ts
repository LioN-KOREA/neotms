/****************************************************
 * 화면에 그려진 서식 **하나만** 프린터로 보낸다.
 *
 * ## 레거시의 `window.print()` 를 그대로 쓸 수 없는 이유
 *
 * 레거시의 출력 버튼은 `window.print()` 한 줄이었고, 그게 맞았다 — 그 페이지는 발주서를 띄우려고
 * 따로 열린 **빈 창**이었으므로(`PDF_Po_KOR.asp`, 닫기 버튼이 `self.close()` 인 것이 증거다),
 * '현재 창' 과 '발주서' 가 같은 것이었다.
 *
 * 지금 이 서식은 앱 화면 위에 뜬 모달 안이다. 여기서 `window.print()` 를 부르면 프린터로 가는 것은
 * **앱 전체**다 — 왼쪽 레일, 상단바, 뒤쪽 발주 목록, 그리고 그 위에 반투명 배경이 깔린 모달. 종이가
 * 나오기 전까지는 아무 오류도 보이지 않는다.
 *
 * ## 그래서 iframe 이다 — `@media print` 가 아니라
 *
 * 흔한 대안은 전역 `@media print` 에 "서식만 남기고 다 숨긴다" 를 쓰는 것이다. 그 길을 가지 않은
 * 이유가 셋이다:
 *
 * 1. **숨길 목록을 유지해야 한다.** `body > *:not(...)` 류의 규칙은 앱의 DOM 모양에 기대고, 레이아웃을
 *    한 겹 감싸는 순간 조용히 틀린다 — 그리고 틀렸다는 것은 인쇄물에서만 보인다.
 * 2. **CSS 모듈의 클래스 이름은 해시된다.** 전역 규칙에서 서식을 가리키려면 해시되지 않는 표식
 *    (`data-` 속성 등)을 따로 심고 그 약속을 두 파일이 지켜야 한다.
 * 3. **조상의 스타일이 따라온다.** 모달은 `position: fixed` 에 `max-height` 와 `overflow: hidden` 이
 *    걸린 상자 안에 있다. 숨기기만 해서는 그 상자가 남아서 **첫 페이지에서 잘린다.**
 *
 * iframe 은 세 문제를 한꺼번에 없앤다. 새 문서에는 서식 하나만 들어가므로 숨길 것이 없고, 조상이
 * 없으므로 잘릴 것이 없다. 해시된 클래스 이름은 **그대로 복사되므로** 약속이 필요 없다 — 요소의
 * `outerHTML` 과 문서의 스타일시트를 같이 옮기면 양쪽의 해시가 저절로 맞는다.
 *
 * ## 배율은 브라우저에 맡긴다
 *
 * `.printWrap` 은 1000px 고정이고 A4 의 인쇄 가능 폭은 ~190mm(약 718px)다. 즉 내용이 종이보다 넓다.
 * 여기서 `zoom` 이나 `transform: scale()` 로 맞추지 않는다 — 브라우저는 종이보다 넓은 문서를 기본
 * 설정에서 **폭에 맞춰 줄여** 찍고(레거시도 같은 조건에서 그렇게 나왔다), 축소 배율은 인쇄 대화상자에서
 * 사용자가 조절할 수 있다. 반대로 `transform` 을 걸면 페이지 나눔 계산이 변환 전 좌표로 돌아가서
 * 페이지 경계가 글자 한가운데를 지나간다.
 *
 * 치수를 정확히 맞춰야 하는 쪽은 PDF 경로다(`exportPdf.ts`). 그쪽은 캔버스를 떠서 mm 로 환산하므로
 * 브라우저 설정과 무관하게 같은 파일이 나온다. 이 모듈은 "지금 당장 프린터로" 하는 보조 경로다.
 ****************************************************/

/**
 * `onafterprint` 가 오지 않을 때 iframe 을 치우는 시한. ms.
 *
 * Safari 는 `onafterprint` 를 쏘지 않고, 사용자가 인쇄 대화상자를 열어 둔 채 자리를 비울 수도 있다.
 * 짧게 잡으면 **대화상자가 떠 있는 동안 문서가 사라져서** 인쇄가 취소된다 — 그래서 넉넉히 둔다.
 * 치우지 못한 iframe 하나가 남는 것보다 인쇄가 취소되는 쪽이 나쁘다.
 */
const CLEANUP_FALLBACK_MS = 60_000

/** iframe 안쪽 문서의 뷰포트 폭. px. */
const FRAME_WIDTH_PX = 1200

/**
 * HTML 텍스트 자리에 넣을 값을 이스케이프한다.
 *
 * 아래에서 문서 제목에만 쓴다. 제목은 발주 코드와 번역가 이름으로 만들어지고, 번역가 이름은 사람이
 * 입력한 값이다 — `<` 하나가 섞이면 `<title>` 이 닫히지 않고 그 뒤 전체가 제목으로 먹힌다.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * `el` 만 담은 문서를 숨은 iframe 에 만들고 인쇄 대화상자를 띄운다.
 *
 * `title` 은 인쇄 대화상자와 (PDF 로 인쇄할 때) 기본 파일명에 쓰인다.
 */
export async function printElement(el: HTMLElement, title: string): Promise<void> {
  /*
   * 앱의 스타일시트를 통째로 옮긴다. 개발 모드에서는 Vite 가 `<style>` 로 주입하고 빌드본에서는
   * `<link rel="stylesheet">` 가 되므로 **둘 다** 거둔다 — 한쪽만 거두면 개발에서는 멀쩡하고
   * 배포에서만 서식이 무너진다(또는 그 반대).
   *
   * 필요한 것만 골라 넣지 않는 이유: 해시된 클래스 이름이 어느 파일에 들어 있는지는 번들러가
   * 정하고 빌드마다 달라질 수 있다. 전부 옮기면 그 질문을 할 필요가 없다.
   */
  const styles = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
    .map((node) => node.outerHTML)
    .join('\n')

  /*
   * `<base>` 를 명시한다. srcdoc 문서는 부모의 URL 을 상속하므로 없어도 대개 맞지만, 상대 경로로
   * 들어오는 것이 **로고 이미지와 스타일시트**다. 그 둘이 깨지면 로고 없는 발주서가 인쇄된다.
   */
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<base href="${escapeHtml(document.baseURI)}">
<title>${escapeHtml(title)}</title>
${styles}
<style>
  /*
   * 앱의 global.css 도 위에서 같이 들어왔다. 그 안의 body 배경(--nt-bg)은 업무 화면의 회색
   * 바탕이고, 서식 종이에는 있어서는 안 된다. 여백도 0 으로 되돌린다 — 종이 여백은 아래
   * 의 @page 가 정한다.
   *
   * 이 주석에 역따옴표를 쓰지 않는 것이 규칙이다. 여기는 템플릿 리터럴 **안**이므로 역따옴표
   * 하나가 문자열을 닫아 버리고, 그 뒤의 한국어 문장이 코드로 읽혀 파싱이 깨진다.
   */
  html, body { margin: 0; padding: 0; background: #fff; height: auto; }
  @page { size: A4 portrait; margin: 10mm; }
</style>
</head>
<body>${el.outerHTML}</body>
</html>`

  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.setAttribute('title', title)
  /*
   * 화면 밖에 둔다. `display: none` 이나 `visibility: hidden` 으로는 안 된다 — 그 iframe 안의
   * 문서는 레이아웃을 받지 못하고, 레이아웃이 없는 문서를 인쇄하면 백지가 나온다.
   *
   * 폭을 1200px 로 잡은 것은 1000px 짜리 서식이 뷰포트에 넘치지 않게 하기 위해서다. 넘치면
   * 인쇄 전 레이아웃 단계에서 가로 스크롤이 생기고, 일부 브라우저가 그 상태의 잘린 폭을 쓴다.
   */
  frame.style.cssText =
    `position:fixed;left:-20000px;top:0;width:${FRAME_WIDTH_PX}px;height:100%;border:0;`

  const loaded = new Promise<void>((resolve, reject) => {
    frame.onload = () => resolve()
    frame.onerror = () => reject(new Error('인쇄용 문서를 만들 수 없습니다.'))
  })

  frame.srcdoc = html
  document.body.appendChild(frame)
  await loaded

  const win = frame.contentWindow
  if (!win) {
    frame.remove()
    throw new Error('인쇄용 문서를 만들 수 없습니다.')
  }

  /*
   * 글꼴이 올라오기를 기다린다. 기다리지 않으면 대체 글꼴로 측정된 레이아웃이 인쇄될 수 있고,
   * 그러면 줄바꿈 위치가 화면과 달라진다 — 서식에서는 그것이 칸이 밀리는 것으로 보인다.
   * `document.fonts` 가 없는 브라우저에서는 그냥 넘어간다.
   */
  try {
    await win.document.fonts?.ready
  } catch {
    /* 글꼴 로딩 실패는 인쇄를 막을 이유가 아니다. 대체 글꼴로 찍힌다. */
  }

  /*
   * iframe 을 치우는 일은 **한 번만 의미가 있다.** 두 경로(인쇄 종료 이벤트, 시한) 중 먼저
   * 도착한 쪽이 치우고 나머지는 아무 일도 하지 않는다. `remove()` 를 두 번 불러도 탈은 없지만,
   * 타이머를 지우지 않으면 모달이 닫힌 뒤에도 1분간 살아 있다.
   */
  let timer = 0
  const cleanup = () => {
    if (timer) window.clearTimeout(timer)
    timer = 0
    frame.remove()
  }
  win.onafterprint = cleanup
  timer = window.setTimeout(cleanup, CLEANUP_FALLBACK_MS)

  win.focus()
  win.print()
}
