import { useMemo, useState } from 'react'
import { useProfile, useWorkspace } from '@/apis/queries/neotms.query'
import type { WorkspaceRow } from '@/apis/neotms.types'
import {
  NEOTMS_PERMISSION_JOB_UPDATE,
  NEOTMS_PERMISSION_PO_UPDATE,
} from '@/apis/neotms.authorities'
import { may } from '@/shared/permissions'
import { ErrorNotice, LoadMore, SuccessNotice } from '@/shared/ui/Feedback'
import { Icon } from '@/shared/ui/Icon'
import ui from '@/shared/ui/ui.module.css'
import {
  TranslatorSwapModal,
  type SwappableTranslatorPo,
} from '@/features/purchaseorders/TranslatorSwapModal'
import { WorkspaceColumnsModal } from './WorkspaceColumnsModal'
import { WorkspaceGrid, type WorkspaceSelection } from './WorkspaceGrid'
import { WorkspaceToolbar } from './WorkspaceToolbar'

/**
 * 정렬을 **열 머리글에서** 한다.
 *
 * 시트 위에 있던 드롭다운과 오름/내림 단추를 걷어냈다. 스프레드시트에서 정렬은 열에 속한
 * 동작이고, 머리글에 화살표 하나를 두면 '무엇으로 정렬 중인가' 와 '바꾸는 방법' 을 같은 자리가
 * 답한다 — 드롭다운은 그 둘을 표에서 떼어 놓고 자리만 넓게 차지했다.
 *
 * 정렬할 수 있는 열은 넷이다(`SORTABLE`). 서버가 실제 컬럼으로만 정렬할 수 있기 때문이고,
 * 그래서 '등록순' 은 화면에서 사라졌다 — 머리글이 없는 정렬이라 걸 자리가 없다. API 에는
 * 그대로 있으므로 필요해지면 열을 하나 더 열면 된다.
 */

/**
 * 나의 업무 — 내가 수락한 프로젝트의 PO 를 한 장의 시트로.
 *
 * ## 이 화면에는 걸러내기가 없다
 *
 * 다른 업무 화면은 모두 조건을 주소에 적는다. 여기는 적을 조건이 없다 — 보이는 것은 '내가 PM 이고
 * 내가 수락한 프로젝트의 PO' 뿐이고, 그건 고를 수 있는 조건이 아니라 이 화면의 정의다. 정렬만
 * 바뀌므로 주소에 담지 않는다(남에게 보내도 그 사람의 시트가 열린다).
 *
 * ## 보이지 않는 것을 말한다
 *
 * 행은 **PO 한 건**이다. 그래서 아직 PO 가 없는 작업은 이 시트에 없고, 그건 보통 번역가를 아직
 * 붙이지 않은 작업 — PM 이 가장 신경 써야 하는 쪽이다. 그 건수를 머리글에 적는다. 건수는 행의
 * 대체물이 아니지만, **빠져 있다는 사실이 보이는 것과 보이지 않는 것의 차이**는 크다.
 *
 * ## 고치는 권한은 열마다 다르다
 *
 * 시트를 여는 것은 `WORKSPACE:read` 하나지만, 칸을 고치는 것은 그 값의 권한이다 — 출발어·도착어는
 * `JOB:update`, 번역가·분량·납품일·진행상태는 `PO:update`. 권한이 없으면 그 칸은 읽기 전용으로
 * 그려진다(회색). 서버도 같은 판단을 하므로 화면이 막는 것은 **거절당할 요청을 보내지 않기
 * 위한 것**이고, 권한 자체는 서버가 정한다.
 */
export function WorkspaceView() {
  const { data: profile } = useProfile()
  const [sort, setSort] = useState<string>('due')
  const [dir, setDir] = useState<'asc' | 'desc'>('asc')
  const [notice, setNotice] = useState<string | null>(null)
  const [cellError, setCellError] = useState<string | null>(null)
  const [managing, setManaging] = useState(false)
  const [swapping, setSwapping] = useState<SwappableTranslatorPo | null>(null)
  /*
   * 지금 고른 범위. 시트가 알려 주고 도구막대가 읽는다.
   *
   * 화면이 들고 있는 이유는 **둘 다 필요하기 때문**이다 — 고르는 쪽은 시트이고 칠하는 쪽은
   * 도구막대이며, 둘은 형제다. 도구막대를 시트 안에 두었다면 상태를 올릴 필요가 없었겠지만,
   * 그러면 도구막대가 시트의 스크롤 상자 안에서 함께 흘러가 버린다.
   */
  const [selection, setSelection] = useState<WorkspaceSelection>({
    cells: [],
    columns: [],
    rows: [],
  })

  const sheet = useWorkspace(sort, dir)

  /*
   * 행 배열을 `useMemo` 로 고정한다. 시트가 렌더마다 새 배열을 받으면 방금 고친 값을 들고 있는
   * 쪽(`WorkspaceGrid` 의 `edits`)이 매번 "새 데이터가 왔다" 로 읽고 정리를 돌린다.
   */
  const rows = useMemo(
    () => sheet.data?.pages.flatMap((page) => page.items) ?? [],
    [sheet.data],
  )
  const columns = sheet.data?.pages[0]?.columns ?? []

  const mayEditJob = may(profile, NEOTMS_PERMISSION_JOB_UPDATE)
  const mayEditPo = may(profile, NEOTMS_PERMISSION_PO_UPDATE)

  return (
    <div className={ui.page}>
      <div className={ui.pageBar}>
        <button type="button" className={ui.btn} onClick={() => setManaging(true)}>
          <Icon name="plus" size={13} />
          열 관리
        </button>
      </div>

      {notice ? <SuccessNotice>{notice}</SuccessNotice> : null}
      {/* 칸 저장 실패. 되돌려진 칸이 어느 것인지는 시트가 서버 값으로 되돌려 보여 준다. */}
      {cellError ? <ErrorNotice error={new Error(cellError)} /> : null}
      <ErrorNotice error={sheet.error} />

      <div className={ui.card}>
        <div className={ui.cardHeader}>
          <span>{rows.length}건 표시</span>
        </div>
        <div className={ui.cardBodyFlush}>
          {sheet.isLoading ? (
            <p className={ui.cardBody}>불러오는 중…</p>
          ) : rows.length === 0 ? (
            <p className={ui.cardBody}>
              표시할 항목이 없습니다.
            </p>
          ) : (
            <>
              {/*
               * 도구막대는 시트 **바깥**에 있다. 시트는 자기 스크롤 상자를 가지고 있으므로,
               * 안에 두면 아래로 내려간 순간 색 단추가 화면에서 사라진다 — 칠하려면 매번 맨
               * 위로 올라와야 한다.
               */}
              <WorkspaceToolbar
                selection={selection}
                onDone={setNotice}
                onError={setCellError}
              />
              <WorkspaceGrid
                rows={rows}
                columns={columns}
                mayEditJob={mayEditJob}
                mayEditPo={mayEditPo}
                onChangeTranslator={(row: WorkspaceRow) =>
                  setSwapping({
                    id: row.poId,
                    poCode: row.poCode,
                    poTranName: row.poTranName,
                    translatorId: row.translatorId,
                    poCoinCode: row.poCoinCode,
                    poApproved: row.poApproved,
                    poMoneyState: row.poMoneyState,
                  })
                }
                onError={setCellError}
                sort={sort}
                dir={dir}
                /*
                 * 같은 열을 다시 누르면 방향이 뒤집히고, 다른 열을 누르면 그 열로 바꾸되
                 * **오름차순부터** 시작한다. 내림차순이 따라오면 날짜 열에서 가장 먼 미래가
                 * 먼저 나오는데, 이 시트를 여는 이유는 거의 언제나 그 반대다.
                 */
                onSort={(key) => {
                  if (key === sort) setDir(dir === 'asc' ? 'desc' : 'asc')
                  else {
                    setSort(key)
                    setDir('asc')
                  }
                }}
                onSelectionChange={setSelection}
              />
            </>
          )}
        </div>

        <LoadMore
          hasNextPage={!!sheet.hasNextPage}
          isFetchingNextPage={sheet.isFetchingNextPage}
          onClick={() => void sheet.fetchNextPage()}
        />
      </div>

      {managing ? (
        <WorkspaceColumnsModal
          columns={columns}
          onClose={() => setManaging(false)}
          onSaved={setNotice}
        />
      ) : null}

      {swapping ? (
        <TranslatorSwapModal
          purchaseOrder={swapping}
          onClose={() => setSwapping(null)}
          onSaved={setNotice}
        />
      ) : null}
    </div>
  )
}
