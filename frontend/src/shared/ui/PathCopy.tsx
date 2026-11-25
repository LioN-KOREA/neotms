/**
 * NAS 경로 + [복사] (팀장님 2026-11-25).
 *
 * 브라우저는 보안 때문에 \nas\... 같은 네트워크 경로를 눌러 열 수 없다. 그래서 경로를 복사해 두고
 * 탐색기 주소창에 붙여 넣게 한다.
 */
import ui from './ui.module.css'

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export function PathCopy(props: { path: string; onCopied?: () => void }) {
  return (
    <span className={ui.pathCopy}>
      <span className={ui.pathText} title={props.path}>
        {props.path}
      </span>
      <button
        type="button"
        className={`${ui.btn} ${ui.btnSm}`}
        title="경로 복사 — 탐색기 주소창에 붙여 넣으세요"
        onClick={() => {
          void copyText(props.path).then((ok) => {
            if (ok) props.onCopied?.()
          })
        }}
      >
        복사
      </button>
    </span>
  )
}
