/**
 * PO 등록 창의 작업·번역가 칸 — 입력하며 찾고 Tab 으로 확정 (팀장님 2026-11-25).
 *
 * - 작업: 칸을 누르면 그 프로젝트의 작업이 바로 펼쳐진다(프로젝트를 모르면 입력한 글로 찾는다).
 *   후보마다 작업명 / 담당PM / 언어 페어 / 작업 종류. 내가 담당PM 인 작업이 맨 위.
 * - 번역가: 이름을 치면 번역가 목록에서 찾는다. 후보에는 이름 · 언어 · 이메일, 고르면 이름만.
 */
import { useEffect, useMemo, useState } from 'react'
import { useJobs, useProfile, useTranslators } from '@/apis/queries/neotms.query'
import type { JobRow, TranslatorRow } from '@/apis/neotms.types'
import type { PickerOption } from '@/shared/ui/RecordPicker'
import { SuggestPicker } from '@/shared/ui/SuggestPicker'

/** 치는 동안 매번 서버에 묻지 않게 — 잠깐 멈추면 그때 찾는다. */
function useSettled(value: string, ms = 250): string {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return settled
}

function jobPair(row: Pick<JobRow, 'jobSlang' | 'jobElang'>): string {
  return [row.jobSlang, row.jobElang].filter(Boolean).join(' → ')
}

export function PoJobPicker(props: {
  value: PickerOption | null
  onChange: (option: PickerOption | null, row: JobRow | null) => void
  projectId?: string | null
  disabled?: boolean
}) {
  const { data: profile } = useProfile()
  const me = profile?.staffId ?? null
  const [keyword, setKeyword] = useState('')
  const q = useSettled(keyword.trim())
  const scoped = !!props.projectId
  // 프로젝트 안이면 작업을 한꺼번에 읽어 두고 칸 안에서 좁힌다. 아니면 입력한 글로 서버에서 찾는다.
  const query = useJobs(
    scoped ? { limit: 100, projectId: props.projectId ?? undefined } : { limit: 30, q: q || undefined },
    scoped || q.length > 0,
  )
  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data])
  const options = useMemo(() => {
    const k = keyword.trim().toLowerCase()
    const hit = scoped && k
      ? rows.filter((r) =>
          [r.jobName, r.jobCode, r.jobPmName, r.jobSlang, r.jobElang, r.workCode].some((t) => (t ?? '').toLowerCase().includes(k)),
        )
      : rows
    const mine = hit.filter((r) => me && r.jobPmId === me)
    const sorted = [...mine, ...hit.filter((r) => !mine.includes(r))]
    return sorted.map((r) => ({
      id: r.id,
      title: r.jobName || r.jobCode,
      subtitle: [
        mine.includes(r) ? `★ ${r.jobPmName ?? ''}` : (r.jobPmName ?? '담당PM 없음'),
        jobPair(r) || '-',
        r.workCode ?? '-',
        scoped ? null : r.prjCode,
      ]
        .filter((x) => x !== null)
        .join(' / '),
    }))
  }, [rows, keyword, scoped, me])

  return (
    <SuggestPicker
      id="po-job"
      label="작업"
      required
      disabled={props.disabled}
      placeholder={scoped ? '작업명 · 담당PM · 언어로 찾기' : '작업명 · 코드 · 프로젝트로 찾기'}
      selected={props.value}
      onSelect={(o) => props.onChange(o ? { id: o.id, title: o.title } : null, o ? (rows.find((r) => r.id === o.id) ?? null) : null)}
      options={options}
      keyword={keyword}
      onKeywordChange={setKeyword}
      isLoading={query.isLoading && (scoped || q.length > 0)}
      emptyText={scoped || keyword.trim() ? '맞는 작업이 없습니다. PO 는 작업에 달립니다 — 작업을 먼저 등록해 주세요.' : '작업명을 입력하세요.'}
    />
  )
}

function translatorLangs(row: Pick<TranslatorRow, 'tranLangs'>): string {
  return (row.tranLangs ?? '')
    .split(',')
    .filter(Boolean)
    .map((p) => p.split('>').filter(Boolean).join('→'))
    .join(', ')
}

export function PoTranslatorPicker(props: {
  value: PickerOption | null
  onChange: (option: PickerOption | null) => void
  disabled?: boolean
}) {
  const [keyword, setKeyword] = useState('')
  const q = useSettled(keyword.trim())
  const query = useTranslators({ limit: 20, q: q || undefined }, q.length > 0)
  const options = useMemo(
    () =>
      (query.data?.pages.flatMap((p) => p.items) ?? []).map((r) => ({
        id: r.id,
        title: r.tranName || r.tranCode,
        subtitle: [translatorLangs(r) || '언어 미등록', r.tranEmail || '이메일 없음'].join(' · '),
      })),
    [query.data],
  )
  return (
    <SuggestPicker
      id="po-translator"
      label="번역가"
      disabled={props.disabled}
      placeholder="번역가명으로 찾기"
      selected={props.value}
      // 고르면 이름만 보인다 (팀장님 2026-11-25).
      onSelect={(o) => props.onChange(o ? { id: o.id, title: o.title } : null)}
      options={options}
      keyword={keyword}
      onKeywordChange={setKeyword}
      isLoading={query.isLoading && q.length > 0}
      emptyText={keyword.trim() ? '맞는 번역가가 없습니다. 번역가 화면에서 먼저 등록해 주세요.' : '번역가명을 입력하세요.'}
    />
  )
}
