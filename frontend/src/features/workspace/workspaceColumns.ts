import type { WorkspaceRow } from '@/apis/neotms.types'

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
