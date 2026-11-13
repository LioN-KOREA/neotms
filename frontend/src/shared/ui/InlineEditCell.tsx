import {
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import type { CodeOption } from '@/apis/neotms.codes'
import { DateTextInput } from '@/shared/ui/DateField'
import { StatusChip } from '@/shared/ui/StatusChip'
import { formatDate, toDateInputValue } from '@/shared/utils/format'
import ui from '@/shared/ui/ui.module.css'

/**
 * 표 안에서 두 번 눌러 한 칸만 고치는 셀.
 *
 * ## 왜 수정 모달이 있는데도 이게 필요한가
 *
 * 수정 모달은 한 건의 **모든** 칸을 다룬다. 실제로 반복되는 일은 그게 아니다 — 작업 열 건의
 * 납기를 하루씩 미루거나, 끝난 작업 넷의 상태를 '완료' 로 바꾸는 일이다. 모달을 쓰면 건당
 * 열고·찾고·저장하고·닫기 네 번이고, 더 비싼 것은 열려 있는 모달이 금액 칸까지 들고 있다는
 * 점이다. 상태만 바꾸려고 열었다가 환산 금액을 건드려 저장하는 사고가 그 자리에서 난다.
 *
 * ## 본문에는 바뀐 필드 **하나만** 담는다
 *
 * 서버의 수정은 부분 수정이다 — 본문에 없는 필드는 건드리지 않는다. 그래서 `{ jobState }` 만
 * 보내는 것이 안전하고, 동시에 그것이 위 사고를 구조적으로 막는다. 보내지 않은 금액은 바뀔
 * 수가 없다.
 *
 * ## 값이 그대로면 아무것도 보내지 않는다
 *
 * 두 번 눌러 열고 그냥 다른 곳을 누르는 일은 자주 있다. 그때마다 저장이 돌면 `updatedAt` 과
 * `updatedBy` 가 바뀌어 **아무도 고치지 않은 수정 기록**이 쌓인다. 감사 기록은 그 순간부터
 * 질문에 답하지 못한다.
 *
 * ## 저장 중에는 편집을 막는다
 *
 * 저장이 끝나면 목록 질의가 무효화되고 다시 읽히는데, 그 사이에 같은 칸을 또 고치면 두 번째
 * 수정이 **되돌려진 값**을 바탕으로 만들어진다. 되돌아온 화면이 자기가 보낸 값과 다른 이유를
 * 설명할 방법이 없으므로, 왕복이 끝날 때까지 잠근다.
 */

/**
 * 편집 상태와 그 열기·닫기 규칙. 세 셀이 공유한다.
 *
 * `skip` 참조가 하는 일: 취소(Esc)와 커밋(blur)이 **같은 조작에서 연달아** 일어날 수 있다.
 * Esc 로 닫으면 포커스가 사라지면서 blur 가 따라오고, 드롭다운은 change 로 커밋한 직후 blur 가
 * 온다. 막지 않으면 Esc 가 저장이 되고, 드롭다운은 같은 값을 두 번 보낸다. 상태(`useState`)로
 * 두면 그 판단이 다음 렌더에나 보이므로 참조여야 한다.
 */
function useInlineEdit<T>(value: T, onCommit: (next: T) => void) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<T>(value)
  const skip = useRef(false)

  /*
   * 여는 순간 초안을 현재 값으로 채운다. `useEffect` 로 맞추지 않는 이유는, 효과는 렌더
   * **뒤에** 돌기 때문이다 — 한 번의 렌더 동안 이전에 열었던 칸의 초안이 입력란에 보이고,
   * 그 사이에 Enter 를 누를 수 있다.
   */
  const open = () => {
    setDraft(value)
    skip.current = false
    setEditing(true)
  }

  const commit = () => {
    setEditing(false)
    if (skip.current) return
    skip.current = true
    if (draft !== value) onCommit(draft)
  }

  const cancel = () => {
    skip.current = true
    setEditing(false)
  }

  return { editing, draft, setDraft, open, commit, cancel }
}

/**
 * 두 번 누르기는 키보드로 닿지 않는다. Enter·Space 로도 열 수 있게 해 둔다.
 *
 * 반환형을 적어 두는 이유는 `className` 을 읽는 호출자가 있기 때문이다 — 추론에 맡기면 비활성
 * 분기의 `{}` 와 유니온이 되어, 그 속성을 읽을 수 있는지가 TypeScript 의 유니온 축약 규칙에
 * 달리게 된다.
 */
function openProps(
  open: () => void,
  enabled: boolean,
  title = '두 번 눌러 수정',
): HTMLAttributes<HTMLTableCellElement> & { tabIndex?: number } {
  if (!enabled) return {}
  return {
    className: ui.cellEditable,
    tabIndex: 0,
    title,
    onDoubleClick: open,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      open()
    },
  }
}

interface Common {
  /** 권한이 없거나 저장 중이면 false. 그때는 평범한 칸으로 그려진다. */
  editable: boolean
}

/**
 * 한 칸의 속. **보여 주는 글자는 편집 중에도 흐름에 남는다.**
 *
 * 그것이 이 컴포넌트의 존재 이유다 — 두 번 눌러 고치기 시작하면 열 폭이 달라지던 문제를 고친다.
 * 표는 `table-layout: auto` 이므로 열 폭을 칸의 내용에서 계산하는데, 글자가 `<input>` 으로
 * 바뀌면 그 칸이 내놓는 폭이 입력란의 `size`(기본 20자)나 `<select>` 의 가장 긴 선택지에서
 * 오게 되어 열이 넓어지거나 좁아지고, 오른쪽의 모든 열이 함께 밀렸다.
 *
 * 그래서 글자를 지우지 않고 **안 보이게만** 하고(자리는 지킨다), 컨트롤은 절대 위치로 그 위에
 * 겹친다. 절대 위치 상자는 조상의 폭 계산에 기여하지 않으므로 열 폭은 두 상태에서 같다.
 * 자세한 사정은 `ui.module.css` 의 `.cellSwap` 주석에 있다.
 *
 * 편집 중이 아닐 때도 같은 상자를 쓴다. 한쪽 상태에만 감싸개가 있으면 그 자체가 두 상태의
 * 차이가 되므로, 고치려는 성질("두 상태에서 같다")을 눈으로 확인할 수 없게 된다.
 */
function CellSwap({
  editing,
  control,
  children,
}: {
  editing: boolean
  /** 편집 중에만 그려지는 컨트롤. 겹쳐 띄우므로 행 높이도 바꾸지 않는다. */
  control?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={ui.cellSwap}>
      <span className={editing ? ui.cellSwapText : undefined}>{children}</span>
      {editing ? <div className={ui.cellSwapEdit}>{control}</div> : null}
    </div>
  )
}

/** 이름 한 칸. 글자칸으로 열린다. */
export function InlineTextCell({
  value,
  onCommit,
  editable,
  emptyText = '(이름 없음)',
  ariaLabel,
}: Common & {
  value: string | null | undefined
  onCommit: (next: string) => void
  emptyText?: string
  ariaLabel: string
}) {
  const current = value ?? ''
  const { editing, draft, setDraft, open, commit, cancel } = useInlineEdit(current, (next) =>
    onCommit(next.trim()),
  )

  return (
    <td {...(editing ? {} : openProps(open, editable))}>
      <CellSwap
        editing={editing}
        control={
          <input
            className={ui.cellInput}
            aria-label={ariaLabel}
            /* 열자마자 포커스가 가야 한다. 안 가면 두 번 누른 뒤 한 번 더 눌러야 타이핑이 된다. */
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              else if (e.key === 'Escape') cancel()
            }}
          />
        }
      >
        {current || emptyText}
      </CellSwap>
    </td>
  )
}

/**
 * 날짜 한 칸. 글자칸으로 열린다 — `261111` 여섯 타면 된다.
 *
 * 들어오는 값은 서버의 날짜 문자열이고 보여 줄 때는 KST 로 포맷하지만, 나가는 값은 언제나
 * `YYYY-MM-DD` 다 — 서버의 `date` 컬럼이 받는 형태와 같다.
 *
 * ## 위 세 칸과 달리 `useInlineEdit` 을 쓰지 않는다
 *
 * 그 훅의 초안은 **글자가 곧 값**인 경우를 위한 것이다. 날짜는 그렇지 않다: 칸에 보이는
 * `2026-11-11(수)` 와 저장되는 `2026-11-11` 이 다르고, 사이에 해석이 끼어 있으며 그 해석은
 * 실패할 수 있다. 그 세 가지를 모두 `DateTextInput` 이 들고 있으므로(서식에서도 같은 규칙이어야
 * 하니까) 여기서 초안을 한 벌 더 들면 두 개의 진실이 생긴다.
 *
 * 그래서 남는 일은 **언제 닫는가** 하나뿐이다.
 *
 * ## 달력이 없는 것은 의도다
 *
 * 표의 칸 위에 뜨는 팝업은 `overflow: auto` 상자 안에서 잘린다 — `InlinePickerCell` 이 모달로
 * 여는 것과 같은 이유다. 달력이 필요하면 수정 모달을 열면 되고, 제자리 수정이 실제로 쓰이는
 * 경우(납기를 하루 미루기)는 어차피 타이핑이 더 빠르다.
 */
export function InlineDateCell({
  value,
  onCommit,
  editable,
  className,
  ariaLabel,
}: Common & {
  value: string | null | undefined
  onCommit: (next: string | null) => void
  /** 표시 상태의 색(연체면 빨강). 편집 중에는 쓰지 않는다. */
  className?: string
  ariaLabel: string
}) {
  const current = toDateInputValue(value)
  const [editing, setEditing] = useState(false)

  const props = editing ? {} : openProps(() => setEditing(true), editable)
  return (
    <td {...props} className={[className, props.className].filter(Boolean).join(' ')}>
      <CellSwap
        editing={editing}
        control={
          <DateTextInput
            className={ui.cellInput}
            value={current}
            /*
             * 값이 실제로 달라졌을 때만 불린다(`DateTextInput` 의 커밋 규칙) — 그래서 "그대로면
             * 아무것도 보내지 않는다" 는 이 파일 머리말의 약속이 여기서도 그대로 지켜진다.
             *
             * 빈 값은 null 로 보낸다. 납기를 지우는 것은 정상 조작이고, 빈 문자열은 `date` 컬럼이
             * 받지 않는다.
             */
            onChange={(next) => onCommit(next || null)}
            ariaLabel={ariaLabel}
            autoFocus
            /*
             * **해석에 성공했을 때만** 닫는다. 실패하면 칸은 열린 채로 오류를 달고 있는다 — 닫아
             * 버리면 잘못 적은 날짜가 옛 값으로 조용히 되돌아가고, 적은 사람은 저장된 줄 안다.
             */
            onBlur={(ok) => {
              if (ok) setEditing(false)
            }}
            onDone={(ok) => {
              if (ok) setEditing(false)
            }}
            onCancel={() => setEditing(false)}
          />
        }
      >
        {formatDate(value)}
      </CellSwap>
    </td>
  )
}

/**
 * 두 번 눌러 **대화상자**를 여는 칸. 칸 안에서 고칠 수 없는 값에 쓴다.
 *
 * ## 위 셋과 달리 편집 상태를 들고 있지 않다
 *
 * 글자·날짜·드롭다운은 칸 안에서 값을 고르고 그 자리에서 커밋한다. 번역가는 그럴 수 없다 —
 * 고르는 방법이 **검색**이기 때문이다(후보가 서버의 한 페이지 상한을 넘는다. `RecordPicker` 의
 * 머리말). 검색란과 결과 목록을 표의 한 칸에 집어넣으면 행 높이가 세 배가 되고, 표의 가로
 * 스크롤 상자 안에서 결과 목록이 잘린다.
 *
 * 그래서 이 셀은 **여는 일만** 한다. 초안도 `skip` 참조도 없다 — 저장할 값을 들고 있지 않으므로
 * Esc 와 blur 가 겹쳐 두 번 보내는 문제 자체가 생기지 않는다. 대화상자를 띄우고 저장하는 것은
 * 쓰는 화면의 몫이고, 그쪽은 이미 모달을 화면 밑단에 두는 모양을 하고 있다.
 *
 * 보여 줄 내용은 `children` 이다. 같은 칸이 비어 있을 때는 경고 배지(`미지정`)를, 채워져
 * 있을 때는 이름을 그리는 식으로 쓰는 쪽이 다르게 그릴 수 있어야 한다.
 */
export function InlinePickerCell({
  editable,
  onOpen,
  title,
  className,
  children,
}: Common & {
  onOpen: () => void
  /** 두 번 눌러 무엇이 열리는지. 기본 문구('두 번 눌러 수정')보다 구체적이어야 쓸모가 있다. */
  title?: string
  className?: string
  children: ReactNode
}) {
  const props = openProps(onOpen, editable, title)
  return (
    <td {...props} className={[className, props.className].filter(Boolean).join(' ')}>
      {children}
    </td>
  )
}

/**
 * 상태 한 칸. 드롭다운으로 열린다.
 *
 * `options` 는 **반드시 `codeOptions` 를 거친 것**이어야 한다. 그러지 않으면 목록에 없는
 * 현재 값(운영 데이터의 레거시 상태값)이 들어왔을 때 `<select>` 가 첫 항목을 선택된 것처럼
 * 그리고, 담당자가 아무것도 고르지 않고 닫아도 상태가 바뀐 것으로 보인다. 그 함정의 전모는
 * `codeOptions` 주석에 있다.
 */
export function InlineSelectCell({
  value,
  options,
  onCommit,
  editable,
  ariaLabel,
}: Common & {
  value: string | null | undefined
  options: readonly CodeOption[]
  onCommit: (next: string) => void
  ariaLabel: string
}) {
  const current = value ?? ''
  /*
   * 초안을 쓰지 않는다 — 드롭다운은 고르는 즉시 저장하므로 "아직 확정되지 않은 값" 이라는
   * 상태가 존재하지 않는다. `cancel` 만 받아 열고 닫는 데 쓴다.
   */
  const { editing, open, cancel } = useInlineEdit(current, onCommit)

  return (
    <td {...(editing ? {} : openProps(open, editable))}>
      <CellSwap
        editing={editing}
        control={
          <select
            className={ui.cellInput}
            aria-label={ariaLabel}
            autoFocus
            value={current}
            /*
             * 고르는 즉시 저장한다. 드롭다운에는 '확인' 이 없고, 고른 다음 다른 곳을 눌러야
             * 저장되는 방식이라면 아무도 저장된 줄 모른다.
             */
            onChange={(e) => {
              const next = e.target.value
              cancel()
              if (next !== current) onCommit(next)
            }}
            /* 고르지 않고 벗어나면 그냥 닫는다. 여기서 저장할 것은 없다. */
            onBlur={cancel}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel()
            }}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        }
      >
        <StatusChip value={value} />
      </CellSwap>
    </td>
  )
}
