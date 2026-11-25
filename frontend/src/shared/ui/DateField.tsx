import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  addDays,
  calendarMonth,
  formatDateField,
  parseDateField,
  shiftMonth,
  todayKst,
  WEEKDAY_HEADS,
} from '@/shared/utils/format'
import { TimeInput } from './TimeInput'
import ui from './ui.module.css'

/**
 * 날짜 한 칸 — 글자로 적고, 달력으로 고르고, 버튼으로 민다.
 *
 * ## `<input type="date">` 를 그만 쓴다
 *
 * 이 앱의 날짜는 전부 브라우저 기본 날짜 입력이었다. 그게 공짜로 주는 것(달력, 유효성 검사,
 * 로케일)은 분명했지만, 이 업무에서 대가가 더 컸다.
 *
 * **1. 글자로 적을 수 없다.** 기본 날짜 입력은 연·월·일 세 칸으로 쪼개져 있고 각 칸을 따로
 * 채워야 한다. 담당자가 납기를 적는 속도는 `261111` 여섯 타가 전부인데, 그 여섯 타가
 * `2`→`0`→`2`→`6`→(탭)→`1`→`1`→(탭)→`1`→`1` 이 된다. 하루에 수십 번이면 그 차이가 전부다.
 *
 * **2. 요일이 안 보인다.** 납기 대화는 "수요일까지" 로 이루어진다. `2026-11-11` 만 보고 그게
 * 수요일인지 아는 사람은 없고, 모르면 토요일을 납기로 잡는다. 기본 입력에는 요일을 넣을
 * 자리가 없다.
 *
 * **3. 표에서 복사한 날짜를 되돌려받지 못한다.** 표는 `2026. 10. 27.` 로 찍는데 기본 입력은
 * 그 글자를 받지 않는다. 붙여넣기가 통하지 않는 입력칸은 다시 타이핑을 부른다.
 *
 * ## 값은 `YYYY-MM-DD` 그대로다
 *
 * 바뀐 것은 **보여 주는 글자**뿐이다. `onChange` 로 나가는 값은 지금까지와 똑같은
 * `YYYY-MM-DD`(또는 지웠으면 빈 문자열)이므로, 이 컴포넌트를 끼워 넣는 일은 폼의 상태·저장
 * 본문·서버 어디에도 닿지 않는다. 해석과 표시 규칙은 `format.ts` 의 `parseDateField` /
 * `formatDateField` 에 있다.
 *
 * ## 잘못된 날짜는 **고쳐 주지 않는다**
 *
 * `2026-02-30` 을 2026-03-02 로 바꾸는 것이 가장 흔한 구현이고(날짜 생성자가 그렇게 동작한다)
 * 가장 나쁜 동작이다. 사용자가 적지 않은 날짜가 저장되고, 화면은 그걸 성공으로 보여 준다.
 * 여기서는 오류를 띄우고 **적은 글자를 그대로 둔다** — 고칠 사람이 무엇을 적었는지 봐야 하기
 * 때문이다. 그동안 `onChange` 는 부르지 않으므로 폼에는 이전 값이 남아 있다.
 */

/**
 * 적는 형태 안내. **화면에 상시로 그리지 않고 마우스를 올렸을 때만 뜬다**(`title`).
 *
 * 처음에는 명세대로 라벨 옆에 적었다. 그 자리는 비어 있으니 공짜처럼 보였지만 실제로는 둘 다
 * 틀어졌다:
 *
 * **1. 라벨 줄이 두 줄이 된다.** `시작일 yymmdd · yy-mm-dd · yyyy-mm-dd` 는 한 열 폭(약 240px)에
 * 들어가지 않는다. 접히면 그 칸만 라벨이 두 줄이 되고, 옆에 선 '납기' 는 한 줄이므로 **두 칸의
 * 입력란 높이가 어긋난다** — 기간의 두 끝이 계단처럼 보인다.
 *
 * **2. 형식 문자열이 값처럼 읽힌다.** `yyyy-mm-dd` 를 라벨 옆과 빈 칸 안(placeholder)에 **두 번**
 * 적어 두면, 그게 안내가 아니라 화면이 흘린 내부 문자열로 보인다. 실제로 그렇게 보고되었다.
 *
 * 그래서 placeholder 도 지웠다. 빈 날짜칸은 그냥 비어 있고, 규칙이 필요한 사람은 칸 위에 마우스를
 * 올리면 된다 — 이 안내는 한 번 배우면 끝인 것이지 매번 읽어야 하는 것이 아니다.
 */
export const DATE_INPUT_HINT = '이렇게 적어도 됩니다 — 261111 · 1111 · 26-11-11 · 26/11/11 · 11/11 · 2026-11-11'

interface TextProps {
  /** `YYYY-MM-DD` 또는 빈 문자열. */
  value: string
  /** 해석에 성공했을 때만, 값이 달라졌을 때만 부른다. */
  onChange: (next: string) => void
  disabled?: boolean
  id?: string
  ariaLabel?: string
  className?: string
  autoFocus?: boolean
  /**
   * 칸을 벗어났을 때. `ok` 는 **해석에 성공했는지**다 — 값이 바뀌었는지가 아니다.
   *
   * `InlineDateCell` 이 편집을 닫는 데 쓰고, 그래서 결과를 받아야 한다. `ok` 없이 무조건
   * 닫으면 `2026-02-30` 을 적고 다른 곳을 누른 사람은 **칸이 옛 날짜로 돌아간 것**만 본다 —
   * 오류 문구는 칸과 함께 사라지므로 무엇이 잘못됐는지 알 방법이 없고, 저장된 줄 알고 넘어간다.
   */
  onBlur?: (ok: boolean) => void
  /** Enter 로 확정했을 때. 같은 용도, 같은 `ok`. */
  onDone?: (ok: boolean) => void
  /**
   * Escape. 주면 **적은 글자를 버리고** 이 함수를 부른다.
   *
   * 주지 않으면 Escape 를 아예 건드리지 않는다 — 서식 안에서는 모달이 받아야 하기 때문이다.
   */
  onCancel?: () => void
}

/**
 * 날짜 **글자칸** 하나. 달력도 버튼도 없다.
 *
 * `DateField` 와 `InlineDateCell` 이 함께 쓴다. 표 안의 칸에는 달력 팝업을 띄울 수 없는데
 * (`overflow: auto` 상자 안에서 잘린다 — `InlinePickerCell` 주석의 같은 이유), 명세가 주는
 * 가치의 대부분인 **적는 규칙**은 거기서도 그대로 필요하다. 그래서 적는 부분만 떼어 둔다.
 */
export function DateTextInput({
  value,
  onChange,
  disabled = false,
  id,
  ariaLabel,
  className,
  autoFocus,
  onBlur,
  onDone,
  onCancel,
}: TextProps) {
  const [text, setText] = useState(() => formatDateField(value))
  const [error, setError] = useState<string | null>(null)

  /*
   * 바깥에서 값이 바뀌었을 때 글자를 다시 맞춘다 — 달력·today·+N 이 눌렸거나, 시작일/종료일
   * 맞춤이 이 칸을 끌어당겼을 때다.
   *
   * `useEffect` 를 쓰지 않는다. 효과는 렌더 **뒤에** 돌기 때문에 한 번의 렌더 동안 **옛 글자**가
   * 화면에 보이고, 그 사이에 Enter 가 눌리면 방금 고른 날짜가 아니라 옛 글자가 확정된다
   * (`useInlineEdit` 의 초안도 같은 이유로 효과를 쓰지 않는다).
   *
   * 렌더 중에 `setState` 를 부르는 이것은 리액트가 문서로 권하는 모양이다. 리액트는 이 렌더를
   * 버리고 **DOM 에 반영하기 전에** 다시 돌리므로 깜빡임도 중간 상태도 없다.
   */
  const [synced, setSynced] = useState(value)
  if (synced !== value) {
    setSynced(value)
    setText(formatDateField(value))
    setError(null)
  }

  /*
   * 포커스가 들어오면서 전체를 선택했는지. **클릭 한 번에 전체 선택**을 만드는 장치다.
   *
   * `onFocus` 에서 `select()` 만 하면 소용이 없다 — 클릭은 focus 다음에 mouseup 으로 캐럿을
   * 놓으면서 그 선택을 지운다. 그래서 포커스를 가져온 그 클릭의 mouseup 만 막는다. 이미
   * 포커스가 있는 칸에서의 클릭은 막지 않으므로, 한 번 더 누르면 평소처럼 캐럿이 선다 —
   * 글자 가운데를 고쳐야 하는 경우가 막히지 않는다.
   */
  const tookFocus = useRef(false)

  /*
   * Escape 로 버렸는지. 버린 직후의 blur 가 **확정으로 바뀌지 않게** 막는다.
   *
   * 포커스가 있는 입력란을 Escape 가 치우면 blur 가 따라오고, 그 blur 의 커밋이 방금 버린
   * 글자를 저장한다. `useInlineEdit` 의 `skip` 참조와 같은 함정이고, 같은 이유로 상태가 아니라
   * 참조다 — 상태로 두면 그 판단이 다음 렌더에나 보인다.
   */
  const cancelled = useRef(false)

  /** 해석에 성공했으면 true. 실패하면 오류를 띄우고 글자를 **그대로 둔다.** */
  const commit = () => {
    const parsed = parseDateField(text)
    if (!parsed.ok) {
      setError(parsed.reason)
      return false
    }
    setError(null)
    /*
     * 성공했으면 **언제나** 정규형으로 다시 쓴다. `onChange` 뒤의 되돌아오는 값에 맡길 수
     * 없다 — 적은 날짜가 지금 값과 같으면(`261111` 을 다시 적은 경우) `onChange` 가 아예
     * 불리지 않고, 그러면 `261111` 이 칸에 그대로 남는다.
     */
    setText(formatDateField(parsed.value))
    setSynced(parsed.value)
    if (parsed.value !== value) onChange(parsed.value)
    return true
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && onCancel) {
      cancelled.current = true
      // 적은 글자를 버리고 들어온 값으로 되돌린다. 다시 열었을 때 옛 오타가 남아 있지 않게.
      setText(formatDateField(value))
      setError(null)
      onCancel()
      return
    }
    if (e.key !== 'Enter') return
    /*
     * 서식 안의 Enter 는 기본이 **제출**이다. 막지 않으면 날짜를 확정하려는 Enter 가 모달을
     * 저장하고 닫는다 — `type="button"` 을 빠뜨린 버튼과 같은 함정이다.
     */
    e.preventDefault()
    onDone?.(commit())
  }

  return (
    <>
      <input
        id={id}
        className={className ?? `${ui.input} ${ui.dateText}`}
        aria-label={ariaLabel}
        aria-invalid={error ? true : undefined}
        autoFocus={autoFocus}
        disabled={disabled}
        value={text}
        /* 안내는 여기에만 — 상시로 그리지 않는 이유는 `DATE_INPUT_HINT` 주석에 있다. */
        title={DATE_INPUT_HINT}
        /* 브라우저 자동완성이 날짜칸에 주소나 이름을 채워 넣는 일을 막는다. */
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value)
          // 고치기 시작하면 경고를 내린다. 남겨 두면 이미 고친 글자 밑에 옛 오류가 붙어 있다.
          if (error) setError(null)
        }}
        onFocus={(e) => {
          tookFocus.current = true
          cancelled.current = false
          e.currentTarget.select()
        }}
        onMouseUp={(e) => {
          if (!tookFocus.current) return
          tookFocus.current = false
          e.preventDefault()
        }}
        onBlur={() => {
          tookFocus.current = false
          // Escape 로 버린 직후의 blur. 커밋도 통보도 하지 않는다 — 위 `cancelled` 주석.
          if (cancelled.current) return
          onBlur?.(commit())
        }}
        onKeyDown={onKeyDown}
      />
      {error ? (
        <span className={ui.hintWarn} role="alert">
          {error}
        </span>
      ) : null}
    </>
  )
}

/**
 * 달력 석 달 — 전달·이번달·다음달.
 *
 * ## 왜 석 달인가
 *
 * 납기는 이번 달 안에 있는 경우가 드물다. 한 달짜리 달력에서 다음 달 10일을 고르려면 '다음'
 * 을 누르고, 고르고, 그 날이 이번 달 말일로부터 며칠인지는 **머릿속에서** 세야 한다. 석 달을
 * 같이 보여 주면 그 계산이 눈으로 끝난다.
 *
 * ## 위치는 두 축 모두 재서 맞춘다
 *
 * 팝업은 제 날짜칸의 왼쪽 아래에 붙는다(`left: 0; top: calc(100% + 4px)`). 그 자리가 맞지 않는
 * 경우가 두 가지 있고, **둘 다 CSS 만으로는 고를 수 없다.**
 *
 * - **가로.** 기간의 오른쪽 칸에서 열면 그 지점이 이미 모달의 절반이므로 석 달이 오른쪽
 *   가장자리를 넘어간다. 왼쪽 칸에는 `left: 0` 이, 오른쪽 칸에는 `right: 0` 이 맞는데 어느
 *   쪽인지는 모달 폭과 열 수에 달려 있고 그 둘은 서식마다 다르다.
 * - **세로.** 서식 아래쪽 날짜칸에서 열면 달력이 본문 바닥 밑으로 내려간다. 그러면 담당자는
 *   달력을 보려고 서식을 스크롤해야 하고, 그게 보고된 증상이다. 들어갈 자리가 아래인지 위인지는
 *   **화면 높이**에 달려 있다 — `.body` 에 `max-height` 가 없어서, 노트북에서는 넘치고 큰
 *   모니터에서는 넘치지 않는 같은 서식이 된다.
 *
 * 그래서 띄운 뒤 한 번 재서 모자란 만큼만 민다. 세로는 순서가 있다: 아래에 들어가면 그대로,
 * 안 들어가고 **위에 들어가면 날짜칸 위로 뒤집고**, 둘 다 안 되면 자르는 상자의 위쪽에 붙인
 * 뒤 팝업 안에서 스크롤하게 둔다(`maxHeight`). 마지막 경우는 좁은 화면에서 석 달이 접혀
 * 세로로 길어졌을 때뿐이다.
 *
 * `useLayoutEffect` 다. `useEffect` 는 **그려진 뒤에** 돌므로 달력이 한 프레임 동안 잘린 자리에
 * 보였다가 옮겨 간다 — 깜빡임이고, 그 한 프레임 안에 누른 클릭은 엉뚱한 날에 떨어진다.
 *
 * ## Escape 가 모달을 닫지 않는다
 *
 * `Modal` 은 Escape 를 `document` 에서 **버블 단계로** 듣는다. 그래서 여기서
 * `stopPropagation()` 을 부르면 그 핸들러까지 가지 않는다 — 달력만 닫히고 서식은 열려 있다.
 * 막지 않으면 달력을 닫으려는 Escape 가 스무 칸을 채운 모달을 날린다.
 *
 * (이것은 `Modal` 의 구현에 기댄 것이다. 그쪽이 캡처 단계로 옮기면 여기가 조용히 깨진다 —
 * 그래서 이 문단이 있다.)
 */
function CalendarPopup({
  value,
  onPick,
  onClose,
  anchor,
}: {
  value: string
  onPick: (next: string) => void
  onClose: () => void
  /** 달력 아이콘. 가운데 달이 이 아이콘 바로 위나 아래에 오게 띄운다 (팀장님 2026-11-25). */
  anchor: React.RefObject<HTMLElement | null>
}) {
  const today = todayKst()
  // 가운데 달은 들어 있는 날짜의 달. 비어 있으면 이번 달이다.
  const base = (value || today).slice(0, 7)
  const [center, setCenter] = useState({
    year: Number(base.slice(0, 4)),
    month: Number(base.slice(5, 7)),
  })

  const move = (offset: number) => setCenter((c) => shiftMonth(c.year, c.month, offset))

  /*
   * 가장자리를 넘어간 만큼만 되민다. 아무것도 모자라지 않으면 `null` 로 남겨 `style` 자체를
   * 붙이지 않는다 — 굳이 `transform` 을 걸어 두면 그 상자가 새 기준점이 되어(고정 위치
   * 자손의 containing block) 다음 사람이 디버깅할 거리가 늘어난다.
   *
   * 한 번만 잰다(`[]`). 달 이동은 크기를 바꾸지 않으므로(언제나 석 달) 다시 잴 일이 없고,
   * 팝업은 열 때마다 새로 마운트된다.
   */
  const popRef = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState<{ left: number; top: number; maxHeight?: number } | null>(null)

  /*
   * 자리 잡기 (팀장님 2026-11-25): 가운데 달(석 달 중 둘째)의 한가운데가 **아이콘과 일직선**이
   * 되게 좌우를 맞추고, 아이콘 아래에 공간이 있으면 아래, 없으면 위에 띄운다. 마우스를 조금만
   * 움직여 날짜를 누를 수 있게 하려는 것이다.
   *
   * `position: fixed` — 모달 본문의 스크롤 상자(overflow)에 잘리지 않는다.
   */
  useLayoutEffect(() => {
    const pop = popRef.current
    const icon = anchor.current
    if (!pop || !icon) return
    const a = icon.getBoundingClientRect()
    const box = pop.getBoundingClientRect()
    const mid = pop.querySelector<HTMLElement>('[data-mid-month]')
    const margin = 8
    const gap = 4
    const midCenter = mid ? mid.getBoundingClientRect().left - box.left + mid.offsetWidth / 2 : box.width / 2
    let left = a.left + a.width / 2 - midCenter
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - box.width))
    const room = window.innerHeight - margin * 2
    const maxHeight = box.height > room ? room : undefined
    const height = maxHeight ?? box.height
    let top = a.bottom + gap
    if (top + height > window.innerHeight - margin) {
      const above = a.top - gap - height
      top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - height)
    }
    setFit({ left, top, maxHeight })
  }, [anchor])

  // 바깥을 누르면 닫는다 (아이콘은 제외 — 아이콘은 스스로 여닫는다).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [anchor, onClose])

  return (
    <div
      ref={popRef}
      className={ui.calendarPop}
      style={{
        position: 'fixed',
        left: fit?.left ?? -9999,
        top: fit?.top ?? -9999,
        maxHeight: fit?.maxHeight,
        visibility: fit ? undefined : 'hidden',
      }}
      onMouseDown={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation()
        onClose()
      }}
    >
      <div className={ui.calendarBar}>
        <button
          type="button"
          className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
          onClick={() => move(-1)}
        >
          ‹ 이전
        </button>
        <button
          type="button"
          className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
          onClick={() => {
            const [y, m] = today.split('-')
            setCenter({ year: Number(y), month: Number(m) })
          }}
        >
          이번달
        </button>
        <button
          type="button"
          className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
          onClick={() => move(1)}
        >
          다음 ›
        </button>
        <span className={ui.spacer} />
        <button
          type="button"
          className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
          onClick={() => onPick(today)}
        >
          오늘 선택
        </button>
      </div>

      <div className={ui.calendarMonths}>
        {[-1, 0, 1].map((offset) => {
          const at = shiftMonth(center.year, center.month, offset)
          const month = calendarMonth(at.year, at.month)
          return (
            <div key={`${at.year}-${at.month}`} data-mid-month={offset === 0 ? '' : undefined}>
              <div className={ui.calendarTitle}>{month.title}</div>
              <div className={ui.calendarGrid}>
                {WEEKDAY_HEADS.map((head) => (
                  <div key={head} className={ui.calendarHead}>
                    {head}
                  </div>
                ))}
                {month.weeks.flat().map((day, index) => {
                  if (!day) {
                    // 그 달에 없는 칸. `key` 에 자리 번호를 쓰는 이유는 날짜가 없기 때문이다.
                    return <div key={`b${index}`} className={ui.calendarBlank} />
                  }
                  /* 자리 번호 7로 나눈 나머지가 요일이다 — 격자가 월요일에서 시작하므로 5=토, 6=일. */
                  const weekday = index % 7
                  const tone =
                    weekday === 5 ? ui.calendarSat : weekday === 6 ? ui.calendarSun : ''
                  const mark =
                    day === value ? ui.calendarSel : day === today ? ui.calendarToday : ''
                  return (
                    <button
                      key={day}
                      type="button"
                      className={`${ui.calendarDay} ${tone} ${mark}`}
                      aria-label={day}
                      aria-current={day === today ? 'date' : undefined}
                      onClick={() => onPick(day)}
                    >
                      {Number(day.slice(8))}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface Props {
  /** `YYYY-MM-DD` 또는 빈 문자열. */
  value: string
  onChange: (next: string) => void
  id: string
  label: string
  disabled?: boolean
  /** 입력칸 아래 한 줄. 서식마다 다른 업무 설명("시각을 비워 두면 '그날 중'")이 온다. */
  children?: React.ReactNode
  /** 시각 칸. 주면 날짜 줄 오른쪽에 붙는다 — 아래 주석 참고. */
  time?: {
    value: string
    onChange: (next: string) => void
    ariaLabel: string
  }
}

/**
 * 명세가 못 박은 차례 — `날짜 입력칸 → 달력 → today → +1 → +3 → +7`.
 *
 * 글자만 `today` 에서 `오늘` 로 바꿨다. 견본이 영어인 것에 뜻이 있어 보이지 않고, 한글 버튼
 * 다섯 개 사이에 영어 하나가 섞이면 그 하나가 다른 기능처럼 읽힌다 — 달력 안의 `오늘 선택` 과
 * 같은 일을 하는 버튼이므로 같은 말로 적는다.
 */
const DAY_STEPS = [1, 3, 7] as const

/**
 * 라벨 · 날짜칸 · 달력 · today · +1 · +3 · +7, 그리고 있으면 시각.
 *
 * ## `+N` 은 **그 칸에 적힌 날짜**에 더한다
 *
 * 이것이 `DeadlineQuickPick` 과 반대인 지점이고, 바꾼 것이 맞다. 전에는 `+3` 이 "오늘부터
 * 3일 뒤" 로 고정이었고 그 근거는 멱등성이었다 — 두 번 눌러도 같은 값이니 잘못 눌러도
 * 되돌리기 쉽다는 것.
 *
 * 그 근거는 **버튼을 하나만 놓고 보았을 때만** 성립한다. 실제 조작은 "달력에서 시작일을 고르고,
 * 거기서 일주일" 이다. 오늘 기준이면 그 일을 할 수 없다 — 시작일이 다음 달이어도 `+7` 은
 * 이번 주를 가리키므로, 담당자는 버튼을 포기하고 달력을 다시 연다. 즉 멱등한 버튼은 안전한
 * 대신 **쓸 일이 없었다.**
 *
 * 되돌리기는 `today` 와 달력이 맡는다. 그리고 누적이 필요한 이유는 따로 있다: `+3` 과 `+7` 을
 * 함께 눌러 +10 을 만드는 것이 명세가 의도한 사용법이고, 오늘 기준에서는 그게 그냥 +7 이다.
 *
 * ## 시각은 날짜와 **다른 칸**이다
 *
 * 스키마가 날짜(`date`)와 시각(`text`)을 따로 둔다. 시각 없는 납기는 "그날 중" 이라는 뜻이고,
 * 날짜를 바꿀 때 시각이 따라 움직이면 안 된다 — 명세도 "날짜를 바꿔도 시간은 유지한다" 고
 * 적는다. 둘이 별개의 상태이므로 그 요구는 저절로 지켜지고, 여기서 하는 일은 **섞지 않는 것**
 * 뿐이다.
 *
 * ## (2026-11-25 바뀜) 시각은 이제 `TimeInput` — 24시간 글자칸에 ‹ › 한 시간 단추. 분은 그대로 지킨다.
 *
 * 아래는 그 전, `<input type="time">` 을 썼던 이유다 (분을 지켜야 한다는 점은 지금도 같다).
 *
 * 견본이 시 단위 드롭다운인 것은 tkinter 에 시각 입력이 없어서다. 그걸 그대로 옮기면 **분이
 * 사라진다** — `prj_sday_time` 에는 이미 분이 들어 있고(새 항목의 기본값이 `nowTimeKst()` 다),
 * 드롭다운으로 바꾸는 순간 `14:30` 짜리 기존 값이 열기만 해도 `14:00` 이 된다. 브라우저 시각
 * 입력은 명세가 요구한 00~23 을 이미 주면서 분을 지키므로, 명세의 **뜻**에는 이쪽이 맞다.
 *
 * 더한 것은 `12시`·`18시` 두 버튼이다. 그 둘이 명세가 실제로 노린 것 — 가장 흔한 두 시각을
 * 한 번에 — 이고, 그건 입력 방식과 무관하게 붙일 수 있다.
 *
 * ## 줄은 **세 줄로 못 박는다**
 *
 * 글자칸 / 달력·today·+N / 시각. 전에는 열 개 남짓한 컨트롤을 한 줄에 늘어놓고 `flex-wrap` 에
 * 맡겼는데, 그러면 어디서 접힐지를 **들어 있는 글자**가 정한다. 시각이 채워진 '시작일' 과 비어
 * 있는 '납기' 는 글자 폭이 다르므로 다른 자리에서 접히고, 나란히 선 두 칸의 버튼이 서로 다른
 * 높이에 선다. 넘치지도 겹치지도 않아 오류로는 안 보이고 그냥 어수선해 보인다 — 줄을 마크업이
 * 정하면 두 칸은 모달 폭과 상관없이 같은 모양이 된다.
 */
export function DateField({ value, onChange, id, label, disabled = false, children, time }: Props) {
  const [open, setOpen] = useState(false)
  const iconRef = useRef<HTMLButtonElement>(null)

  /* 날짜가 비어 있을 때 `+N` 의 기준. 빈 칸에서 `+3` 은 "오늘부터 3일" 이 유일하게 말이 된다. */
  const step = (days: number) => onChange(addDays(value || todayKst(), days))

  const small = `${ui.btn} ${ui.btnGhost} ${ui.btnSm}`

  return (
    <div className={ui.field}>
      <label className={ui.label} htmlFor={id}>
        {label}
      </label>

      {/*
       * 배치 (팀장님 2026-11-25): 위 줄에 [날짜] [시간], 아래 줄에 각 칸의 단추.
       *   [  날짜  ] [ 시간 ]
       *   오늘 +1 +3 +7   12시 18시
       */}
      <div className={`${ui.dateGrid} ${time ? ui.dateGridTime : ''}`}>
        {/* 달력은 칸 오른쪽 안의 아이콘으로 연다 (팀장님 2026-11-25 — 따로 있던 '달력' 단추 대신). */}
        <div className={ui.dateInputWrap}>
          <DateTextInput id={id} value={value} onChange={onChange} disabled={disabled} />
          <button
            ref={iconRef}
            type="button"
            className={ui.dateIcon}
            disabled={disabled}
            aria-expanded={open}
            aria-label={`${label} 달력`}
            title="달력"
            onClick={() => setOpen((v) => !v)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="1.5" y="3" width="13" height="11.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <path d="M1.5 6.5h13M5 1.5v3M11 1.5v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <path d="M4.5 9h2M9.5 9h2M4.5 11.8h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {time ? (
          <div className={ui.dateTimeCell}>
            <TimeInput value={time.value} onChange={time.onChange} ariaLabel={time.ariaLabel} disabled={disabled} />
          </div>
        ) : null}

        <div className={ui.dateBtns}>
          <button type="button" className={small} disabled={disabled} onClick={() => onChange(todayKst())}>
            오늘
          </button>
          {/* `type="button"`. 빠지면 제출이 되어 `+1` 을 누르는 순간 모달이 저장되고 닫힌다. */}
          {DAY_STEPS.map((days) => (
            <button key={days} type="button" className={small} disabled={disabled} onClick={() => step(days)}>
              +{days}
            </button>
          ))}
        </div>

        {time ? (
          <div className={`${ui.dateBtns} ${ui.dateTimeBtns}`}>
            <button type="button" className={small} disabled={disabled} onClick={() => time.onChange('12:00')}>
              12시
            </button>
            <button type="button" className={small} disabled={disabled} onClick={() => time.onChange('18:00')}>
              18시
            </button>
          </div>
        ) : null}

        {open && !disabled ? (
          <CalendarPopup
            anchor={iconRef}
            value={value}
            onPick={(next) => {
              onChange(next)
              /* 고르면 닫는다. 달력을 띄워 둔 채로 할 일이 더 없다. */
              setOpen(false)
            }}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </div>

      {children}
    </div>
  )
}
