import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useProfile, useWorkspace } from '@/apis/queries/neotms.query'
import type { WorkspaceRow } from '@/apis/neotms.types'
import {
  NEOTMS_PERMISSION_JOB_UPDATE,
  NEOTMS_PERMISSION_PO_UPDATE,
} from '@/apis/neotms.authorities'
import { may } from '@/shared/permissions'
import { ErrorNotice, InfoNotice, LoadMore, SuccessNotice } from '@/shared/ui/Feedback'
import { Icon } from '@/shared/ui/Icon'
import ui from '@/shared/ui/ui.module.css'
import {
  TranslatorSwapModal,
  type SwappableTranslatorPo,
} from '@/features/purchaseorders/TranslatorSwapModal'
import { WorkspaceColumnsModal } from './WorkspaceColumnsModal'
import { WorkspaceGrid } from './WorkspaceGrid'

/** 정렬 선택지. 서버의 `WORKSPACE_SORTS` 와 같아야 한다 — 없는 키를 보내면 기본값으로 조용히 떨어진다. */
const SORTS = [
  { value: 'due', label: '납품일' },
  { value: 'code', label: 'PO코드' },
  { value: 'project', label: '프로젝트코드' },
  { value: 'created', label: '등록순' },
] as const

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
  const unplacedJobs = sheet.data?.pages[0]?.unplacedJobs ?? 0

  const mayEditJob = may(profile, NEOTMS_PERMISSION_JOB_UPDATE)
  const mayEditPo = may(profile, NEOTMS_PERMISSION_PO_UPDATE)

  return (
    <div className={ui.page}>
      <div className={ui.pageBar}>
        <p className={ui.pageNote}>
          내가 수락한 프로젝트의 PO 목록입니다. 칸을 두 번 누르면 바로 고쳐집니다.
        </p>
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
          <span className={ui.spacer} />
          <label className={ui.hint} htmlFor="ws-sort">
            정렬
          </label>
          <select
            id="ws-sort"
            className={ui.select}
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            {SORTS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnGhost} ${ui.btnSm}`}
            onClick={() => setDir(dir === 'asc' ? 'desc' : 'asc')}
          >
            {dir === 'asc' ? '오름차순' : '내림차순'}
          </button>
        </div>

        {/*
         * PO 가 없는 작업 건수. 위 머리말의 '보이지 않는 것을 말한다' 가 이것이다.
         *
         * 작업 목록으로 보내는 링크를 함께 둔다 — 건수만 적으면 "그래서 어느 작업인가" 에 답이
         * 없고, 그 답을 들고 있는 화면은 작업 목록이다.
         */}
        {unplacedJobs > 0 ? (
          <div className={ui.cardBody}>
            <InfoNotice>
              이 시트는 PO 한 건을 한 행으로 보여 줍니다. 수락한 프로젝트의 작업 중{' '}
              <strong>{unplacedJobs}건</strong>은 아직 PO 가 없어 여기 나오지 않습니다 —{' '}
              <Link className={ui.btnLink} to="/jobs">
                작업 목록
              </Link>
              에서 확인하세요.
            </InfoNotice>
          </div>
        ) : null}

        <div className={ui.cardBodyFlush}>
          {sheet.isLoading ? (
            <p className={ui.cardBody}>불러오는 중…</p>
          ) : rows.length === 0 ? (
            <p className={ui.cardBody}>
              수락한 프로젝트에 PO 가 없습니다. 프로젝트를 인계받아 수락하면 그 프로젝트의 PO 가
              여기 모입니다.
            </p>
          ) : (
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
            />
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
