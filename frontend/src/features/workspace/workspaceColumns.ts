import type {
  WorkspaceColumnDef,
  WorkspaceRow,
  WorkspaceStyle,
} from '@/apis/neotms.types'

/**
 * 나의 업무 의 기본 열. **열 수와 순서가 요구사항이고, 지울 수 없다.**
 *
 * 한 배열에 모아 둔 이유는 이 목록이 세 곳에서 같은 순서로 쓰이기 때문이다 — 머리글, 칸을 만드는
 * 곳, 그리고 열 폭. 세 군데에 따로 적으면 열 하나를 끼워 넣을 때 하나를 빠뜨리고, 그 증상은
 * **값이 한 칸씩 밀려 보이는 것**이다. 오류가 아니라 거짓이므로 아무도 신고하지 않는다.
 *
 * `source` 는 이 칸을 고치면 **무엇이 바뀌는지**다. 편집 가능 여부와 어느 엔드포인트로 나가는지가
 * 모두 여기서 나온다.
 *
 *   * `'readonly'` — 고칠 수 없다. 코드값(프로젝트·JOB·PO 코드)과 **프로젝트 단위 값**이 여기
 *     속한다. 프로젝트 값을 시트에서 고치면 그 프로젝트의 모든 행이 함께 바뀌고, 고객사는
 *     그보다 심하다 — 이미 집계된 매출이 다른 고객사로 옮겨간다. 그 편집은 프로젝트 화면의
 *     일이다.
 *   * `'job'` — 작업이 바뀐다(`PATCH /api/v0/jobs/{id}`). 한 작업에 PO 가 둘이면 두 행이 같이
 *     바뀌는데, 그게 맞다 — 출발어는 작업의 성질이고 PO 마다 다를 수 있는 값이 아니다.
 *   * `'po'` — 이 행의 PO 가 바뀐다(`PATCH /api/v0/purchase-orders/{id}`). 행과 일대일이다.
 *
 * 세 번째 열의 `kind` 는 ReactGrid 의 칸 종류다. `'picker'` 는 이 앱이 더한 종류이고 번역가 한
 * 칸에만 쓴다(`WorkspaceGrid`).
 */
export type WorkspaceColumnSource = 'readonly' | 'job' | 'po'

export interface DefaultColumnSpec {
  key: string
  label: string
  width: number
  source: WorkspaceColumnSource
  kind: 'text' | 'number' | 'date' | 'dropdown' | 'picker'
}

export const DEFAULT_COLUMNS: readonly DefaultColumnSpec[] = [
  /*
   * 인계일. 읽기 전용인 것이 설계다.
   *
   * 이 날짜는 컬럼이 아니라 **사건의 기록**이다 — 이 PM 이 프로젝트를 수락한 시각이고
   * (`project_acceptance`), 고친다는 것은 그 기록을 다시 쓴다는 뜻이다. 인계일을 옮겨야 하는
   * 상황은 실은 프로젝트를 다시 인계하는 상황이고, 그 길은 프로젝트 화면에 있다.
   */
  { key: 'handoverAt', label: '인계일', width: 104, source: 'readonly', kind: 'date' },
  { key: 'prjCode', label: '프로젝트코드', width: 128, source: 'readonly', kind: 'text' },
  { key: 'jobCode', label: 'JOB코드', width: 120, source: 'readonly', kind: 'text' },
  { key: 'poCode', label: 'PO코드', width: 120, source: 'readonly', kind: 'text' },
  { key: 'cusCodeName', label: '고객사', width: 150, source: 'readonly', kind: 'text' },
  { key: 'cusMgrName', label: '고객사담당자', width: 110, source: 'readonly', kind: 'text' },
  { key: 'prjMgrName', label: '영업담당', width: 96, source: 'readonly', kind: 'text' },
  { key: 'prjField', label: '프로젝트종류', width: 120, source: 'readonly', kind: 'text' },
  /*
   * 출발어·도착어. 작업이 바뀐다 — 요구사항의 표현 그대로다.
   *
   * PO 에도 자기 언어쌍이 있다(`po_detail_linguistic`). 그쪽은 일부러 작업과 독립이고(MICE
   * 행사에 통역 PO 가 달릴 수 있다) 이 시트는 그 값을 보여 주지 않는다. 한 칸이 두 테이블 중
   * 어느 쪽을 고치는지 화면에서 알 수 없게 되는 쪽이 더 나쁘다.
   */
  { key: 'jobSlang', label: '출발어', width: 104, source: 'job', kind: 'dropdown' },
  { key: 'jobElang', label: '도착어', width: 104, source: 'job', kind: 'dropdown' },
  /*
   * 번역가. 칸 안에서 고르지 않고 대화상자를 연다.
   *
   * 번역가는 **검색해서** 고른다 — 후보가 서버의 한 페이지 상한을 넘으므로, 드롭다운에 담으면
   * 목록이 조용히 잘린다. 잘린 드롭다운은 "그 번역가가 없다" 로 읽히고, 쓰는 사람은 없는 사람을
   * 새로 등록한다. 그래서 이 칸은 PO 화면과 **같은 대화상자**를 연다(`TranslatorSwapModal`) —
   * 승인·정산 잠금까지 그쪽 규칙을 그대로 따른다.
   */
  { key: 'translator', label: '번역가', width: 140, source: 'po', kind: 'picker' },
  { key: 'poVolume', label: '분량', width: 96, source: 'po', kind: 'number' },
  { key: 'poEday', label: '납품일', width: 110, source: 'po', kind: 'date' },
  { key: 'poState', label: '진행상태', width: 104, source: 'po', kind: 'dropdown' },
]

/** 추가 열의 ReactGrid `columnId`. 기본 열의 키와 섞이지 않게 접두사를 붙인다. */
export const CUSTOM_PREFIX = 'custom:'

export const customColumnId = (id: string) => `${CUSTOM_PREFIX}${id}`

/** `columnId` 가 추가 열이면 그 열 id, 아니면 null. */
export const customColumnKey = (columnId: string): string | null =>
  columnId.startsWith(CUSTOM_PREFIX) ? columnId.slice(CUSTOM_PREFIX.length) : null

/**
 * 기본 열 한 칸의 **읽는** 값. 고치는 쪽은 `WorkspaceGrid` 가 들고 있다.
 *
 * `codeName` 을 받는 이유는 코드 칸(프로젝트종류)이 코드값이 아니라 이름으로 읽혀야 하기
 * 때문이다. 이름이 없으면 코드로 떨어진다 — `useCodeNames` 와 같은 규칙이고, 빈 칸보다 낫다.
 */
export function defaultCellText(
  row: WorkspaceRow,
  key: string,
  codeName: (code: string | null | undefined) => string,
): string {
  switch (key) {
    case 'handoverAt':
      // 날짜만. 수락 시각의 분·초는 이 화면에서 쓸 데가 없고, 열 폭만 먹는다.
      return row.handoverAt ? row.handoverAt.slice(0, 10) : ''
    case 'prjCode':
      return row.prjCode
    case 'jobCode':
      return row.jobCode
    case 'poCode':
      return row.poCode
    case 'cusCodeName':
      return row.cusCodeName ?? ''
    case 'cusMgrName':
      return row.cusMgrName ?? ''
    case 'prjMgrName':
      return row.prjMgrName ?? ''
    case 'prjField':
      return codeName(row.prjField)
    case 'jobSlang':
      return row.jobSlang ?? ''
    case 'jobElang':
      return row.jobElang ?? ''
    case 'translator':
      return row.poTranName ?? ''
    case 'poVolume':
      return row.poVolume ?? ''
    case 'poEday':
      return row.poEday ?? ''
    case 'poState':
      return row.poState ?? ''
    default:
      return ''
  }
}

/* -------------------------------------------------------------------------- */
/* 코드가 가진 열 + 서버가 가진 설정                                            */
/* -------------------------------------------------------------------------- */

/** 시트가 실제로 그리는 열 하나. 기본 열과 추가 열을 **같은 모양**으로 만든 것이다. */
export interface SheetColumn {
  /** ReactGrid 의 `columnId`. 기본 열은 키, 추가 열은 `custom:<id>`. */
  columnId: string
  /** 기본 열이면 그 키, 추가 열이면 null. 꾸밈을 보낼 때 이 둘 중 하나를 쓴다. */
  key: string | null
  /** 추가 열이면 그 id, 기본 열이면 null. 배치를 보낼 때 쓴다. */
  customId: string | null
  /**
   * 서버의 열 행 id — **있을 때만.**
   *
   * 칸 꾸밈 맵의 키가 이 값이다. 기본 열은 사람이 한 번 손대야 행이 생기므로, 손댄 적 없는
   * 기본 열에서는 null 이고 그 열에는 칸 꾸밈도 있을 수 없다(가리킬 행이 없으니 저장될 수도
   * 없었다). 그래서 null 은 "꾸밈 없음" 과 같은 뜻이 된다.
   */
  styleId: string | null
  label: string
  width: number
  style: WorkspaceStyle
  /** 기본 열의 명세. 추가 열에는 없다 — 그래서 이 값이 "이 열은 무엇을 고치는가" 를 답한다. */
  spec: DefaultColumnSpec | null
}

const BLANK_STYLE: WorkspaceStyle = {
  bgColor: null,
  textColor: null,
  textSize: null,
  bold: null,
  italic: null,
  underline: null,
  strike: null,
  textAlign: null,
}

/** 추가 열의 기본 너비. 기본 열은 각자 `DEFAULT_COLUMNS` 의 값을 쓴다. */
export const CUSTOM_COLUMN_WIDTH = 150

/**
 * 서버가 보낸 설정을 코드가 가진 열 목록에 **겹친다.**
 *
 * ## 서버의 행은 '열' 이 아니라 '설정' 이다
 *
 * 기본 열 14개는 코드에 있고, 서버에는 그중 **사람이 손댄 것만** 행으로 있다. 납품일을 한 번도
 * 끌거나 칠하지 않았다면 그 행은 없고, 없다는 것이 곧 "코드가 정한 위치와 너비, 꾸밈 없음" 이라는
 * 완전한 답이다. 그래서 이 함수는 서버 목록을 그리는 것이 아니라 **코드 목록에 겹친다.**
 *
 * 이름도 코드 쪽이 이긴다. 기본 열의 이름은 UI 의 말이고 번역의 대상이므로, 서버에 복사해 두면
 * 화면에서 '납품일' 을 '납기' 로 고친 날 기존 사용자만 옛 단어를 보게 된다.
 *
 * ## 순서
 *
 * `ordNo` 가 있는 열이 먼저, 그 숫자대로. 없는 열은 그 뒤에 **코드가 적은 순서대로** 붙는다.
 * 한 번이라도 끌어 놓은 사람은 모든 열에 번호가 있으므로(배치는 전체를 보낸다) 섞인 상태는
 * 드물지만, 앞으로 15번째 기본 열이 생기면 기존 사용자에게는 번호가 없는 열이 하나 생긴다 —
 * 그때 그 열은 맨 뒤에 나타난다. 맨 앞이 아니라 맨 뒤인 것이 중요하다: 새 열이 남의 시트
 * 맨 왼쪽에 끼어드는 것보다 낫다.
 */
export function mergeColumns(stored: readonly WorkspaceColumnDef[]): SheetColumn[] {
  const byKey = new Map<string, WorkspaceColumnDef>()
  const custom: WorkspaceColumnDef[] = []
  for (const row of stored) {
    if (row.key) byKey.set(row.key, row)
    else custom.push(row)
  }

  const merged: { column: SheetColumn; sort: number }[] = []

  DEFAULT_COLUMNS.forEach((spec, index) => {
    const row = byKey.get(spec.key)
    merged.push({
      column: {
        columnId: spec.key,
        key: spec.key,
        customId: null,
        styleId: row?.id ?? null,
        label: spec.label,
        width: row?.width ?? spec.width,
        style: row?.style ?? BLANK_STYLE,
        spec,
      },
      sort: row?.ordNo ?? 1000 + index,
    })
  })

  custom.forEach((row, index) => {
    merged.push({
      column: {
        columnId: customColumnId(row.id),
        key: null,
        customId: row.id,
        styleId: row.id,
        // 추가 열에 이름이 없을 수는 없다(서버의 CHECK). 그래도 빈 머리글보다는 낫게 떨어뜨린다.
        label: row.label ?? '(이름 없음)',
        width: row.width ?? CUSTOM_COLUMN_WIDTH,
        style: row.style,
        spec: null,
      },
      sort: row.ordNo ?? 2000 + index,
    })
  })

  merged.sort((a, b) => a.sort - b.sort)
  return merged.map((entry) => entry.column)
}

/** 서버 목록에서 **사람이 만든** 열만. 열 관리 화면이 쓰는 목록이다. */
export const customColumnsOf = (stored: readonly WorkspaceColumnDef[]): WorkspaceColumnDef[] =>
  stored.filter((row) => row.key === null)

/**
 * 칸 하나에 실제로 적용되는 꾸밈. **칸 → 행 → 열** 순서로 합친다.
 *
 * 가장 좁은 것이 이긴다. 칸과 행은 **이 일**에 대한 표시이고(이 PO 가 급하다, 이 값이 확인
 * 안 됐다), 열은 시트의 생김새에 대한 것이기 때문이다. 각 속성을 따로 합치므로, 노란 행에 굵게만
 * 지정한 열이 겹치면 노란 바탕에 굵은 글씨가 된다 — 한쪽이 다른 쪽을 통째로 덮지 않는다.
 */
export function resolveStyle(
  cell: WorkspaceStyle | undefined,
  row: WorkspaceStyle | null,
  column: WorkspaceStyle,
): WorkspaceStyle {
  const pick = <K extends keyof WorkspaceStyle>(key: K): WorkspaceStyle[K] =>
    cell?.[key] ?? row?.[key] ?? column[key]
  return {
    bgColor: pick('bgColor'),
    textColor: pick('textColor'),
    textSize: pick('textSize'),
    bold: pick('bold'),
    italic: pick('italic'),
    underline: pick('underline'),
    strike: pick('strike'),
    textAlign: pick('textAlign'),
  }
}
