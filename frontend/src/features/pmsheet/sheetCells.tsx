/**
 * PM 시트의 ReactGrid 칸 종류.
 *
 * `sheet` — 이 시트의 거의 모든 칸. 보이는 글자(`text`)와 고칠 때의 글자(`raw`)가 **다르다**:
 * 날짜는 `11/13(금)` 으로 보이지만 고칠 때는 `2026-11-13`, 수식은 결과가 보이지만 고칠 때는
 * `=[분량]*2`. 기본 text 칸은 이 둘을 구별하지 못해서, 수식 칸을 한 번 열었다 닫으면 수식이
 * 결과 값으로 덮어써진다. 그래서 칸 종류를 하나 만들었다.
 *
 * 복사는 `text`(보이는 글자)가 나간다 — 엑셀·구글 시트에 붙였을 때 보던 그대로가 들어가도록.
 * 붙여넣기는 `update` 로 들어와 `text` 에 새 글자가 담긴다; 그 글자를 해석하는 것은 시트의 몫이다.
 */
import type { CSSProperties } from 'react'
import {
  getCharFromKey,
  isAlphaNumericKey,
  isNavigationKey,
  keyCodes,
  type Cell,
  type CellTemplate,
  type Compatible,
  type Uncertain,
  type UncertainCompatible,
} from '@silevis/reactgrid'
import { FunnelIcon } from './menuIcons'
import { PersonEditor } from './PersonEditor'
import css from './PmSheet.module.css'

export interface SheetCell extends Cell {
  type: 'sheet'
  /** 보이는 글자 (복사되는 글자). */
  text: string
  /** 고칠 때 입력칸에 들어가는 글자. 없으면 `text`. */
  raw?: string
  /** 링크. `internal` 이면 앱 안 이동. */
  href?: string
  internal?: boolean
  onNavigate?: (href: string) => void
  /** 칸 메모 — 있으면 오른쪽 위에 빨간 삼각형. */
  note?: string
  tooltip?: string
  /** 고를 수 있는 값(드롭다운). `free` 면 목록 밖 글자도 적을 수 있다(콤보). */
  choices?: string[]
  free?: boolean
  /** 번역가 칸의 '변경' 단추. */
  onOpen?: () => void
  openLabel?: string
  /** 칸 안 글꼴·정렬 — ReactGrid 의 CellStyle 이 받지 않는 것들. */
  inner?: CSSProperties
  placeholder?: string
  /** 줄바꿈: 'wrap' 이면 여러 줄, 'clip' 이면 말줄임 없이 자름. 없으면 말줄임(…). */
  wrap?: 'wrap' | 'clip' | null
  /** 한 번 클릭으로 목록 열기(진행 상태). 칸의 화면 좌표를 넘긴다. */
  onQuickPick?: (x: number, y: number) => void
  /** 우클릭 메뉴 (이 열로 정렬 · 이 값으로 필터). */
  onMenu?: (x: number, y: number) => void
  /** 글자 앞의 작은 단추 (통합 행의 'M'). */
  badge?: { text: string; title: string; onClick?: () => void }
  /** 마우스를 올리면 보이는 ‹ › (납품일 하루씩). */
  step?: { onPrev: () => void; onNext: () => void; title: string }
  /** 고른 칸이면 ‹ › 를 늘 보인다 — 마우스를 옮기는 사이에 사라지지 않게 (팀장님 2026-11-26). */
  stepShown?: boolean
  /** 번역가·감수자 칸: 더블클릭하면 찾기 입력기 (팀장님 2026-11-26). */
  person?: { jobId: string | null; which: 'tr' | 'rv' }
  /** 입력기에서 목록으로 고른 번역가 id (고친 결과에 실려 시트로 간다). */
  pickedId?: string | null
}

/** 한 번 클릭 목록(onQuickPick)을 더블클릭과 가르는 타이머 — 더블클릭이면 목록 대신 직접 입력. */
let quickTimer = 0

let datalistSeq = 0

export class SheetCellTemplate implements CellTemplate<SheetCell> {
  getCompatibleCell(uncertain: Uncertain<SheetCell>): Compatible<SheetCell> {
    const text = typeof uncertain.text === 'string' ? uncertain.text : ''
    return { ...uncertain, type: 'sheet', text, value: Number.NaN } as Compatible<SheetCell>
  }

  update(cell: Compatible<SheetCell>, cellToMerge: UncertainCompatible<SheetCell>): Compatible<SheetCell> {
    // 붙여넣기·채우기 핸들: 들어온 글자를 그대로 새 '고칠 글자' 로.
    const text = typeof cellToMerge.text === 'string' ? cellToMerge.text : ''
    return this.getCompatibleCell({ ...cell, text, raw: text })
  }

  isFocusable = () => true

  handleKeyDown(
    cell: Compatible<SheetCell>,
    keyCode: number,
    ctrl: boolean,
    shift: boolean,
    alt: boolean,
    key?: string,
    capsLock?: boolean,
  ): { cell: Compatible<SheetCell>; enableEditMode: boolean } {
    if (cell.nonEditable) return { cell, enableEditMode: false }
    if (!ctrl && !alt && isAlphaNumericKey(keyCode) && !(shift && keyCode === keyCodes.SPACE) && !cell.choices) {
      // 글자를 치면 그 글자로 새로 쓰기 시작 — 엑셀과 같다.
      const char = getCharFromKey(key ?? '', shift, capsLock)
      return { cell: this.getCompatibleCell({ ...cell, text: char, raw: char }), enableEditMode: true }
    }
    if (keyCode === keyCodes.DELETE || keyCode === keyCodes.BACKSPACE) {
      return { cell: this.getCompatibleCell({ ...cell, text: '', raw: '' }), enableEditMode: false }
    }
    return { cell, enableEditMode: keyCode === keyCodes.POINTER || keyCode === keyCodes.ENTER || keyCode === keyCodes.F2 }
  }

  handleCompositionEnd(cell: Compatible<SheetCell>, eventData: string) {
    // 한글 입력(IME) — 조합이 끝난 글자로 편집을 시작한다.
    return { cell: this.getCompatibleCell({ ...cell, text: eventData, raw: eventData }), enableEditMode: !cell.nonEditable }
  }

  getClassName(cell: Compatible<SheetCell>): string {
    return `${css.sheetCell} ${cell.className ?? ''}`
  }

  render(
    cell: Compatible<SheetCell>,
    isInEditMode: boolean,
    onCellChanged: (cell: Compatible<SheetCell>, commit: boolean) => void,
  ) {
    if (!isInEditMode) {
      const body = cell.href ? (
        <a
          className={css.cellLink}
          href={cell.href}
          target={cell.internal ? undefined : '_blank'}
          rel={cell.internal ? undefined : 'noreferrer'}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            if (cell.internal && cell.onNavigate) {
              e.preventDefault()
              cell.onNavigate(cell.href!)
            }
          }}
        >
          {cell.text}
        </a>
      ) : (
        <span
          className={`${css.cellText} ${cell.badge ? css.cellTextFit : ''}`}
          style={
            cell.wrap === 'wrap'
              ? { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textOverflow: 'clip' }
              : cell.wrap === 'clip'
                ? { textOverflow: 'clip' }
                : undefined
          }
        >
          {cell.text || (cell.placeholder ? <i className={css.placeholder}>{cell.placeholder}</i> : '')}
        </span>
      )
      return (
        <div
          className={css.cellInner}
          style={cell.inner}
          title={cell.tooltip ?? cell.note}
          onContextMenu={
            cell.onMenu
              ? (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  cell.onMenu?.(e.clientX, e.clientY)
                }
              : undefined
          }
          onClick={
            cell.onQuickPick
              ? (e) => {
                  // 끌어서 범위를 고른 것이 아니라 한 칸을 누른 것일 때만 (click 은 같은 칸에서 떼야 생긴다).
                  // 두 번째 클릭(더블클릭)이면 목록을 열지 않는다 — 더블클릭은 직접 입력.
                  window.clearTimeout(quickTimer)
                  if (e.detail > 1) return
                  const r = e.currentTarget.getBoundingClientRect()
                  quickTimer = window.setTimeout(() => cell.onQuickPick?.(r.left, r.bottom), 230)
                }
              : undefined
          }
        >
          {cell.step ? (
            <button
              type="button"
              className={`${css.stepBtn} ${cell.stepShown ? css.stepOn : ''}`}
              title={`${cell.step.title} 하루 앞으로`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                cell.step?.onPrev()
              }}
            >
              ‹
            </button>
          ) : null}
          {body}
          {/* 통합 행의 M — 숫자 뒤에 (팀장님 2026-11-25). */}
          {cell.badge ? (
            <button
              type="button"
              className={css.badgeBtn}
              title={cell.badge.title}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                cell.badge?.onClick?.()
              }}
            >
              {cell.badge.text}
            </button>
          ) : null}
          {cell.step ? (
            <button
              type="button"
              className={`${css.stepBtn} ${css.stepNext} ${cell.stepShown ? css.stepOn : ''}`}
              title={`${cell.step.title} 하루 뒤로`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                cell.step?.onNext()
              }}
            >
              ›
            </button>
          ) : null}
          {cell.onOpen ? (
            <button
              type="button"
              className={css.pickBtn}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                cell.onOpen?.()
              }}
            >
              {cell.openLabel ?? '변경'}
            </button>
          ) : null}
          {cell.choices && !cell.nonEditable ? <span className={css.caret}>▾</span> : null}
          {cell.note ? <span className={css.noteMark} /> : null}
        </div>
      )
    }

    const initial = cell.raw ?? cell.text
    if (cell.person) {
      return (
        <PersonEditor
          initial={initial}
          jobId={cell.person.jobId}
          which={cell.person.which}
          onCommit={(name, id) => onCellChanged(this.getCompatibleCell({ ...cell, text: name, raw: name, pickedId: id }), true)}
          onCancel={() => onCellChanged(cell, false)}
        />
      )
    }
    if (cell.choices && !cell.free) {
      return (
        <select
          className={css.cellSelect}
          autoFocus
          defaultValue={initial}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (isNavigationKey(e.keyCode) || e.keyCode === keyCodes.ENTER) e.stopPropagation()
            if (e.keyCode === keyCodes.ESCAPE) onCellChanged(cell, false)
          }}
          onChange={(e) => onCellChanged(this.getCompatibleCell({ ...cell, text: e.target.value, raw: e.target.value }), true)}
          onBlur={() => onCellChanged(cell, false)}
        >
          <option value="">(없음)</option>
          {cell.choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      )
    }

    let escaped = false
    const listId = cell.choices ? `pmsheet-dl-${String(++datalistSeq)}` : undefined
    return (
      <>
        <input
          className={css.cellInput}
          ref={(input) => {
            if (input) {
              input.focus()
              input.setSelectionRange(input.value.length, input.value.length)
            }
          }}
          list={listId}
          defaultValue={initial}
          onChange={(e) => onCellChanged(this.getCompatibleCell({ ...cell, text: e.currentTarget.value, raw: e.currentTarget.value }), false)}
          onBlur={(e) =>
            onCellChanged(this.getCompatibleCell({ ...cell, text: e.currentTarget.value, raw: e.currentTarget.value }), !escaped)
          }
          onCopy={(e) => e.stopPropagation()}
          onCut={(e) => e.stopPropagation()}
          onPaste={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (isAlphaNumericKey(e.keyCode) || isNavigationKey(e.keyCode)) e.stopPropagation()
            if (e.keyCode === keyCodes.ESCAPE) escaped = true
          }}
        />
        {listId ? (
          <datalist id={listId}>
            {cell.choices!.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        ) : null}
      </>
    )
  }
}

/** 머리글 — 열 이름, 정렬 단추, 필터 단추. */
export interface SheetHeaderCell extends Cell {
  type: 'sheetHeader'
  text: string
  hint?: string
  direction?: 'asc' | 'desc' | null
  filtered?: boolean
  /** ⚙ 단추 (진행 상태 열). */
  onSettings?: () => void
  /** 정렬·필터 메뉴 (우클릭, 또는 걸려 있다는 표시를 눌렀을 때). */
  onMenu?: (x: number, y: number) => void
  inner?: CSSProperties
}

export class SheetHeaderTemplate implements CellTemplate<SheetHeaderCell> {
  getCompatibleCell(uncertain: Uncertain<SheetHeaderCell>): Compatible<SheetHeaderCell> {
    const text = typeof uncertain.text === 'string' ? uncertain.text : ''
    return { ...uncertain, type: 'sheetHeader', text, value: Number.NaN } as Compatible<SheetHeaderCell>
  }
  getClassName = () => 'rg-header-cell'
  isFocusable = () => false
  render(cell: Compatible<SheetHeaderCell>) {
    return (
      <div
        className={css.headerCell}
        style={cell.inner}
        title={cell.hint ? `${cell.hint}
(우클릭: 정렬·필터)` : '우클릭: 정렬·필터'}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          cell.onMenu?.(e.clientX, e.clientY)
        }}
      >
        <span className={css.headerText}>{cell.text}</span>
        {cell.onSettings ? (
          <button
            type="button"
            className={css.hdrBtn}
            title="진행 상태 설정 (목록·색·연동, 나만 적용)"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              cell.onSettings?.()
            }}
          >
            ⚙
          </button>
        ) : null}
        {/* 정렬·필터는 우클릭 메뉴로. 걸려 있을 때만 표시가 남고, 표시를 눌러도 같은 메뉴가 열린다. */}
        {cell.direction ? (
          <button
            type="button"
            className={`${css.hdrBtn} ${css.hdrOn}`}
            title={cell.direction === 'asc' ? '오름차순 정렬 중 — 눌러서 메뉴' : '내림차순 정렬 중 — 눌러서 메뉴'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              cell.onMenu?.(r.left, r.bottom)
            }}
          >
            {cell.direction === 'asc' ? '▲' : '▼'}
          </button>
        ) : null}
        {cell.filtered ? (
          <button
            type="button"
            className={`${css.hdrBtn} ${css.hdrOn}`}
            title="필터 걸림 — 눌러서 메뉴"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation()
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              cell.onMenu?.(r.left, r.bottom)
            }}
          >
            <FunnelIcon />
          </button>
        ) : null}
      </div>
    )
  }
}

