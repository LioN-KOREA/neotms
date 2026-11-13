import { useRef, type KeyboardEvent } from 'react'
import { describeError } from '@/shared/utils/errors'
import ui from './ui.module.css'

/**
 * 번호로 고를 수 있는 결과의 개수.
 *
 * 9 다. 두 자리를 받지 않는 이유는 **첫 자리를 누른 순간 다른 행이 선택된다**는 것이다 — 12번을
 * 고르려고 `1` 을 누르면 1번이 선택되어 창이 닫히고, 그 뒤의 `2` 는 다른 입력란에 들어간다.
 * 그걸 피하려면 두 번째 키를 기다리는 타이머가 필요하고, 그러면 1번을 고르는 사람이 매번 그
 * 타이머만큼 기다리게 된다.
 *
 * 10번째 이후는 방향키로 간다. 검색 결과가 20건까지 오지만(각 Picker 의 `PICK_LIMIT`), 20건이
 * 나오는 검색어는 번호를 세기에도 이미 너무 길다 — 그때 필요한 것은 단축키가 아니라 더 좁은
 * 검색어다.
 */
const NUMBERED = 9

/** 고른 결과 한 줄. `subtitle` 은 동명이인·동명 회사를 구분하는 보조 정보다. */
export interface PickerOption {
  id: string
  title: string
  subtitle?: string | null
}

interface Props {
  /** `<label htmlFor>` 와 입력란을 잇는다. 화면 안에서 유일해야 한다. */
  id: string
  label: string
  required?: boolean
  /** 이미 고른 값. null 이면 검색란을 보여 준다. */
  selected: PickerOption | null
  /** 검색 결과. `selected` 가 있으면 그리지 않는다. */
  options: readonly PickerOption[]
  isLoading: boolean
  error: unknown
  /** 검색 입력란의 값. 상위가 들고 있어야 쿼리 실행 시점을 통제할 수 있다. */
  keyword: string
  onKeywordChange: (value: string) => void
  /** '검색' 또는 Enter. 이때만 쿼리가 나간다. */
  onSearch: () => void
  onSelect: (option: PickerOption | null) => void
  placeholder?: string
  hint?: string
  disabled?: boolean
}

/**
 * 부모 레코드를 고르는 칸. 프로젝트의 고객사, 발주의 작업.
 *
 * ## `<select>` 가 아닌 이유
 *
 * 서버의 한 페이지 상한이 200행이다(NEOTMS_PAGE_SIZE_MAX). 고객사는 그보다 많고, 작업은 훨씬
 * 많다. 드롭다운으로 만들면 목록에 **없는 고객사가 생기고**, 사용자는 그 고객사가 등록되지
 * 않았다고 결론 내린 뒤 같은 고객사를 한 번 더 등록한다. 레거시의 중복 고객사 행들이 그렇게
 * 생겼다.
 *
 * 그래서 검색해서 고른다. 검색은 서버가 PGroonga 색인으로 하므로 전체에서 찾고, 결과는 짧게 보여
 * 준다 — 긴 목록을 스크롤하는 것은 고르는 동작이 아니라 훑는 동작이다.
 *
 * ## 고른 뒤에는 검색란이 사라진다
 *
 * 고른 값과 검색란이 같이 보이면 "지금 무엇이 선택되어 있는가" 가 모호해진다. 바꾸려면 '변경'
 * 을 눌러 선택을 비우고 다시 검색한다 — 한 번에 하나의 상태만 보이게 하는 것이 목적이다.
 *
 * ## 키보드로만 고를 수 있다
 *
 * 이 칸은 발주 등록에서 두 번 나온다(작업, 번역가). 담당자가 하는 일은 이름을 타이핑하고
 * 결과에서 하나를 고르는 것인데, 전에는 마지막 한 걸음만 마우스였다 — 타이핑하던 손이 매번
 * 마우스로 갔다가 돌아온다. 그래서 세 가지를 붙였다.
 *
 * - **아래 방향키**가 검색란에서 결과 목록으로 들어간다. 위아래로 옮기고 Enter 로 고른다
 *   (결과가 이미 `<button>` 이므로 Enter 는 브라우저가 처리한다).
 * - **첫 줄에서 위 방향키**는 검색란으로 돌아온다. 검색어를 고치려는 동작이다.
 * - 목록 안에서 **1~9** 가 그 번호의 결과를 바로 고른다. 번호는 화면에 적혀 있다.
 *
 * ## 번호는 검색란에서 동작하지 않는다 — 그게 요점이다
 *
 * 검색이 끝나 결과가 떠 있는 상태에서 검색란에 `2` 를 치면 그것은 **검색어의 일부**다. 번역가
 * 코드(`TRN_000123`)와 작업 코드(`JOB_071763`)가 숫자이므로 흔한 입력이다. 그 자리에서 번호를
 * 단축키로 가로채면 코드로 검색할 수가 없게 되고, 더 나쁘게는 코드를 치던 사람이 **엉뚱한
 * 레코드를 고른 채 저장**한다 — PO 를 다른 작업에 붙이는 사고가 그 한 번의 키 입력으로 난다.
 *
 * 그래서 축을 나눈다: 검색란에서는 글자를, 목록에서는 번호를 받는다. 들어가는 비용은 방향키
 * 한 번이고, 그 한 번이 "지금 내가 어디에 있는가" 를 모호하지 않게 만든다.
 *
 * 검색 직후 첫 줄로 **자동으로** 옮기지도 않는다. 사람 이름은 한 번에 맞는 경우가 드물어
 * (동명이인·성만 입력) 검색어를 고치는 일이 흔하고, 그때 포커스가 목록에 가 있으면 타이핑이
 * 어디에도 들어가지 않는다.
 *
 * Escape 는 쓰지 않는다. 이 칸은 모달 안에 들어가고 `Modal` 이 `document` 에서 Escape 를 듣고
 * 있으므로(그쪽 주석), 여기서 Escape 를 '목록 빠져나가기' 로 쓰면 **등록 폼 전체가 닫힌다.**
 */
export function RecordPicker({
  id,
  label,
  required = false,
  selected,
  options,
  isLoading,
  error,
  keyword,
  onKeywordChange,
  onSearch,
  onSelect,
  placeholder,
  hint,
  disabled = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)

  /**
   * 결과 버튼들을 DOM 순서로. **그 순서가 화면에 적힌 번호의 순서다.**
   *
   * `options` 를 세어 인덱스를 따로 들고 있지 않다. 포커스가 실제로 어느 줄에 있는지는 DOM 이
   * 알고 있고, 별도의 '활성 인덱스' 상태를 두면 그 둘이 어긋날 수 있다 — 마우스로 세 번째
   * 줄을 가리킨 뒤 방향키를 누르면 두 번째로 가는(상태는 첫 줄이라고 믿고 있는) 종류의 어긋남
   * 이고, 사용자가 보는 것은 "방향키가 위로 뛰는" 화면이다.
   */
  const resultButtons = () =>
    Array.from(resultsRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])

  /** 범위를 넘으면 **끝에서 멈춘다.** 순환시키지 않는 이유는 아래 `onResultsKeyDown` 참고. */
  const focusResult = (index: number) => {
    const buttons = resultButtons()
    if (buttons.length === 0) return
    buttons[Math.min(Math.max(index, 0), buttons.length - 1)]?.focus()
  }

  /*
   * Enter 를 폼 제출이 아니라 검색으로 쓴다.
   *
   * 이 컴포넌트는 등록 폼 안에 들어가므로, Enter 가 그대로 올라가면 검색 대신 **저장**이
   * 실행된다. 고객사를 고르려고 Enter 를 눌렀는데 프로젝트가 저장되는 동작이다.
   */
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onSearch()
      return
    }
    /*
     * 아래 방향키로 결과 목록에 들어간다. `preventDefault` 가 필요하다 — 막지 않으면 포커스를
     * 옮기면서 **페이지도 한 줄 스크롤되고**, 모달 안에서는 그 스크롤이 서식 전체를 움직인다.
     */
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      focusResult(0)
    }
  }

  /**
   * 결과 목록의 키 입력. 목록 상자에 한 번만 달고 **버블링으로 받는다** — 버튼 20개에 같은
   * 핸들러를 20개 붙일 이유가 없고, `e.target` 이 곧 지금 포커스된 버튼이다.
   *
   * `document.activeElement` 를 읽지 않는 것도 그래서다. 이벤트가 알려 주는 값이 더 정확하다.
   */
  const onResultsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return

    /* 1~9. 범위를 벗어난 번호는 **아무 일도 하지 않는다** — 결과가 세 건일 때 `7` 을 누르면
     * 마지막 건이 선택되는 쪽이 더 나쁘다. 누른 번호와 다른 것이 선택되는 동작이므로. */
    if (e.key >= '1' && e.key <= String(NUMBERED)) {
      const option = options[Number(e.key) - 1]
      if (!option) return
      e.preventDefault()
      onSelect(option)
      return
    }

    const buttons = resultButtons()
    const at = buttons.indexOf(e.target as HTMLButtonElement)
    if (at < 0) return

    if (e.key === 'ArrowDown') {
      /*
       * 마지막 줄에서 멈춘다. 첫 줄로 돌려보내지 않는다 — 20건 목록에서 아래를 누르다가 갑자기
       * 1번으로 돌아가면 지금 몇 번째에 있는지를 처음부터 다시 세어야 하고, 이 목록에는 '몇
       * 번째' 를 알려 주는 표시가 9번까지만 있다.
       */
      e.preventDefault()
      focusResult(at + 1)
      return
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault()
      // 첫 줄에서 위를 누르면 검색란으로 돌아간다. 검색어를 고치려는 동작이다.
      if (at === 0) inputRef.current?.focus()
      else focusResult(at - 1)
    }
  }

  if (selected) {
    return (
      <div className={ui.field}>
        <span className={`${ui.label} ${required ? ui.required : ''}`}>{label}</span>
        <div className={ui.pickerSelected}>
          <span className={ui.pickerSelectedText}>
            <span className={ui.pickerItemTitle}>{selected.title}</span>
            {selected.subtitle ? (
              <span className={ui.pickerItemSub}>{selected.subtitle}</span>
            ) : null}
          </span>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
            onClick={() => onSelect(null)}
            disabled={disabled}
          >
            변경
          </button>
        </div>
        {hint ? <span className={ui.hint}>{hint}</span> : null}
      </div>
    )
  }

  return (
    <div className={ui.field}>
      <label className={`${ui.label} ${required ? ui.required : ''}`} htmlFor={id}>
        {label}
      </label>
      <div className={ui.toolbar}>
        <input
          ref={inputRef}
          id={id}
          className={ui.input}
          type="search"
          value={keyword}
          placeholder={placeholder}
          onChange={(e) => onKeywordChange(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
        />
        <button
          type="button"
          className={ui.btn}
          onClick={onSearch}
          disabled={disabled || keyword.trim().length === 0}
        >
          검색
        </button>
      </div>

      {error ? <span className={ui.hint}>{describeError(error)}</span> : null}
      {isLoading ? <span className={ui.hint}>찾는 중…</span> : null}

      {!isLoading && options.length > 0 ? (
        <>
          <div ref={resultsRef} className={ui.pickerResults} onKeyDown={onResultsKeyDown}>
            {options.map((o, index) => (
              <button
                key={o.id}
                type="button"
                className={ui.pickerItem}
                onClick={() => onSelect(o)}
                disabled={disabled}
              >
                {/*
                 * 번호는 9번까지만 적는다. 그 이상에는 누를 수 있는 키가 없으므로
                 * (`NUMBERED`), 적어 두면 눌러 보고 아무 일도 안 일어나는 것을 겪게 된다.
                 *
                 * 빈 칸을 남기지도 않는다 — 10번째 이후 줄의 제목이 왼쪽으로 당겨져 서면
                 * "번호가 있는 줄" 과 "없는 줄" 이 한눈에 갈린다.
                 */}
                {index < NUMBERED ? (
                  <span className={ui.pickerItemKey} aria-hidden="true">
                    {index + 1}
                  </span>
                ) : null}
                <span className={ui.pickerItemText}>
                  <span className={ui.pickerItemTitle}>{o.title}</span>
                  {o.subtitle ? <span className={ui.pickerItemSub}>{o.subtitle}</span> : null}
                </span>
              </button>
            ))}
          </div>
          {/*
           * 단축키 안내. 번호만 적혀 있으면 그것이 **누를 수 있는 키**라는 것을 알 수 없고,
           * 목록 번호(1. 2. 3.)로 읽힌다.
           */}
          <span className={ui.hint}>
            ↓ 로 목록에 들어가 ↑↓ 로 옮기고, 번호(1~{NUMBERED}) 로 바로 고를 수 있습니다.
          </span>
        </>
      ) : null}

      {hint ? <span className={ui.hint}>{hint}</span> : null}
    </div>
  )
}
