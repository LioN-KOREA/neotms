import { useSetWorkspaceStyles } from '@/apis/queries/neotms.mutation'
import type { WorkspaceStyle } from '@/apis/neotms.types'
import ui from '@/shared/ui/ui.module.css'
import bar from './WorkspaceToolbar.module.css'
import type { WorkspaceSelection } from './WorkspaceGrid'

/**
 * 고를 수 있는 색.
 *
 * 자유로운 색상 선택기(`<input type="color">`)가 아니라 **정해진 묶음**이다. 시트의 목적은
 * 눈에 띄게 하는 것이고, 24비트 색을 전부 열어 두면 한 사람의 시트 안에서 비슷하지만 다른
 * 노랑이 다섯 가지가 되어 구분이라는 목적 자체가 사라진다. 여기 있는 것들은 서로 확실히 다르고,
 * 모두 검은 글씨가 읽히는 밝기다.
 */
const FILLS: { label: string; value: string | null }[] = [
  { label: '없음', value: null },
  { label: '노랑', value: '#FFF2CC' },
  { label: '초록', value: '#D9EAD3' },
  { label: '파랑', value: '#CFE2F3' },
  { label: '분홍', value: '#F4CCCC' },
  { label: '주황', value: '#FCE5CD' },
  { label: '회색', value: '#EFEFEF' },
]

/**
 * 글자색. 배경보다 적다 — 글자색은 보통 '빨강=늦음' 같은 한두 가지 약속으로만 쓰인다.
 */
const INKS: { label: string; value: string | null }[] = [
  { label: '기본', value: null },
  { label: '빨강', value: '#CC0000' },
  { label: '파랑', value: '#1155CC' },
  { label: '초록', value: '#38761D' },
  { label: '회색', value: '#777777' },
]

const SIZES = [10, 11, 12, 13, 14, 16]

interface Props {
  selection: WorkspaceSelection
  onDone: (message: string) => void
  onError: (message: string) => void
}

/**
 * 시트 위의 꾸밈 도구막대. **고른 범위에** 칠한다.
 *
 * ## 무엇을 고쳤는지 먼저 말한다
 *
 * 왼쪽에 "칸 12개" 처럼 적는다. 엑셀과 달리 이 시트의 선택은 열 전체일 수도 행 전체일 수도
 * 있고, 그 판단은 범위의 모양에서 **추측**된다(`WorkspaceGrid` 의 `onSelectionChanged`).
 * 추측이므로 사람에게 되돌려 보여 준다 — 틀렸다면 칠하기 전에 보인다.
 *
 * ## 누르면 바로 저장된다
 *
 * 미리보기도 '적용' 버튼도 없다. 한 번 더 누르면 바뀌고 '없음' 으로 되돌릴 수 있으므로, 중간
 * 단계를 두는 것이 단계를 늘리기만 한다. 실패하면 화면 위쪽에 오류가 뜨고 색은 돌아오지 않는다.
 */
export function WorkspaceToolbar({ selection, onDone, onError }: Props) {
  const setStyles = useSetWorkspaceStyles()

  const count =
    selection.cells.length + selection.columns.length + selection.rows.length
  const scope =
    selection.columns.length > 0
      ? `열 ${selection.columns.length}개`
      : selection.rows.length > 0
        ? `행 ${selection.rows.length}개`
        : selection.cells.length > 0
          ? `칸 ${selection.cells.length}개`
          : '선택 없음'

  const apply = async (style: Partial<WorkspaceStyle>, what: string) => {
    if (count === 0 || setStyles.isPending) return
    try {
      await setStyles.mutateAsync({
        style,
        cells: selection.cells,
        columns: selection.columns,
        rows: selection.rows,
      })
      onDone(`${scope}에 ${what}을(를) 적용했습니다.`)
    } catch (err) {
      onError(err instanceof Error ? err.message : '꾸밈을 저장하지 못했습니다.')
    }
  }

  const disabled = count === 0 || setStyles.isPending

  return (
    <div className={bar.bar}>
      <span className={`${ui.hint} ${bar.scope}`}>{scope}</span>

      <span className={ui.hint}>채우기</span>
      <div className={bar.swatches}>
        {FILLS.map((fill) => (
          <button
            key={fill.label}
            type="button"
            className={`${bar.swatch} ${fill.value ? '' : bar.none}`}
            style={fill.value ? { background: fill.value } : undefined}
            title={fill.label}
            aria-label={`채우기 ${fill.label}`}
            disabled={disabled}
            onClick={() => void apply({ bgColor: fill.value }, `채우기 ${fill.label}`)}
          />
        ))}
      </div>

      <span className={ui.hint}>글자색</span>
      <div className={bar.swatches}>
        {INKS.map((ink) => (
          <button
            key={ink.label}
            type="button"
            className={`${bar.swatch} ${ink.value ? '' : bar.none}`}
            style={ink.value ? { background: ink.value } : undefined}
            title={ink.label}
            aria-label={`글자색 ${ink.label}`}
            disabled={disabled}
            onClick={() => void apply({ textColor: ink.value }, `글자색 ${ink.label}`)}
          />
        ))}
      </div>

      {/*
       * 글자 모양 넷. **끄는 단추를 따로 두지 않는다** — 누를 때마다 켜고 끄는 것이 아니라
       * '켠다' 뿐이고, 되돌리는 것은 오른쪽의 '꾸밈 지우기' 다.
       *
       * 토글로 만들려면 고른 범위가 지금 어떤 상태인지 알아야 하는데, 범위에는 굵은 칸과 그렇지
       * 않은 칸이 섞여 있을 수 있다. 그 애매한 상태에서 토글은 절반을 끄고 절반을 켜는 단추가
       * 되고, 두 번 눌러도 처음으로 돌아오지 않는다. 켜기만 하는 단추는 그 함정이 없다.
       */}
      <div className={bar.marks}>
        <button
          type="button"
          className={`${ui.btn} ${ui.btnSm} ${bar.mark} ${bar.boldBtn}`}
          title="굵게"
          disabled={disabled}
          onClick={() => void apply({ bold: true }, '굵게')}
        >
          가
        </button>
        <button
          type="button"
          className={`${ui.btn} ${ui.btnSm} ${bar.mark} ${bar.italicBtn}`}
          title="기울임"
          disabled={disabled}
          onClick={() => void apply({ italic: true }, '기울임')}
        >
          가
        </button>
        <button
          type="button"
          className={`${ui.btn} ${ui.btnSm} ${bar.mark} ${bar.underlineBtn}`}
          title="밑줄"
          disabled={disabled}
          onClick={() => void apply({ underline: true }, '밑줄')}
        >
          가
        </button>
        <button
          type="button"
          className={`${ui.btn} ${ui.btnSm} ${bar.mark} ${bar.strikeBtn}`}
          title="취소선"
          disabled={disabled}
          onClick={() => void apply({ strike: true }, '취소선')}
        >
          가
        </button>
      </div>

      <span className={ui.hint}>정렬</span>
      <div className={bar.marks}>
        {(
          [
            { value: 'left', label: '왼쪽', glyph: '⯇' },
            { value: 'center', label: '가운데', glyph: '≡' },
            { value: 'right', label: '오른쪽', glyph: '⯈' },
          ] as const
        ).map((align) => (
          <button
            key={align.value}
            type="button"
            className={`${ui.btn} ${ui.btnSm} ${bar.mark}`}
            title={`${align.label} 정렬`}
            disabled={disabled}
            onClick={() => void apply({ textAlign: align.value }, `${align.label} 정렬`)}
          >
            {align.glyph}
          </button>
        ))}
      </div>

      <span className={ui.hint}>크기</span>
      <select
        className={`${ui.select} ${bar.size}`}
        disabled={disabled}
        value=""
        onChange={(e) => {
          const value = e.target.value
          void apply({ textSize: value ? Number(value) : null }, value ? `${value}px` : '기본 크기')
          e.target.value = ''
        }}
      >
        <option value="">크기…</option>
        {SIZES.map((size) => (
          <option key={size} value={size}>
            {size}px
          </option>
        ))}
        <option value="">기본</option>
      </select>

      <span className={ui.spacer} />

      {/*
       * 열을 옮기는 방법을 적어 둔다. ReactGrid 의 열 끌기는 **두 단계**다 — 머리글을 눌러
       * 고른 다음, 그 머리글을 다시 눌러 끈다. 바로 끌면 열이 옮겨지는 대신 여러 열이 선택된다.
       * 알아서 발견할 수 있는 동작이 아니고, 한 번 겪으면 "끌기가 안 된다" 로 기억된다.
       */}
      <span className={ui.hint}>열 머리글을 눌러 고른 뒤 끌면 순서가 바뀝니다</span>

      {/*
       * 꾸밈 지우기는 네 가지를 **모두 null 로** 보낸다. 하나씩 지우는 것과 다르다 — 서버는
       * 보내지 않은 속성을 그대로 두므로, 네 개를 다 보내는 것만이 "아무것도 없던 상태" 를
       * 뜻할 수 있다.
       */}
      <button
        type="button"
        className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
        disabled={disabled}
        onClick={() =>
          void apply(
            {
              bgColor: null,
              textColor: null,
              textSize: null,
              bold: null,
              italic: null,
              underline: null,
              strike: null,
              textAlign: null,
            },
            '꾸밈 지우기',
          )
        }
      >
        꾸밈 지우기
      </button>
    </div>
  )
}
