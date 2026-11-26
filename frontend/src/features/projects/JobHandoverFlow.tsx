/**
 * 프로젝트의 '인계' (팀장님 2026-11-25) — 두 창.
 *
 * 1. 작업 선택 — 선택 / 작업명 / 작업종류 / 언어(출발어 → 도착어) / 담당PM / 납기.
 *    여기서 고친 값은 [확인] 을 누를 때 실제 작업에 저장된다. [취소] 는 아무것도 바꾸지 않는다.
 *    고른 작업 중 담당PM 이 빈 것이 있으면 넘어가지 않는다.
 * 2. 인계정보 입력 — 편집포맷·레이아웃(고르거나 직접 입력), 기타요청, 참조 메일, 하이웍스 로그인.
 *    [인계] 는 각 작업의 담당PM 에게 인계만, [인계·발송] 은 PM 마다 인계 메일까지 보낸다.
 *    받는 PM 이 인계를 받으면 그 내용이 PM 의 '나의 업무' 비고 칸에 들어간다(서버 handoverRemark).
 *
 * 프로젝트 화면에서 작업을 골라 둔 채 누르면 바로 2 로 간다 — 담당PM 이 빈 작업이 있으면 1 부터.
 */
import { useMemo, useState } from 'react'
import { CODE_DOMAIN, isLinguistic } from '@/apis/neotms.codes'
import type { JobRow, JobUpdate } from '@/apis/neotms.types'
import { HANDOVER_FORMATS, HANDOVER_LAYOUTS } from '@/apis/neotms.types'
import { previewJobHandover, useSendJobHandover, type JobHandoverInput } from '@/apis/pmsheet.api'
import { useUpdateJob } from '@/apis/queries/neotms.mutation'
import { useCodeNames, useHiworksCredential, useJobs, useProfile } from '@/apis/queries/neotms.query'
import { groupNumber } from '@/apis/jobGroup.api'
import { DETAIL_PAGE_SIZE } from '@/shared/config'
import { CodeSelect } from '@/shared/ui/CodeSelect'
import { LangCombo } from '@/shared/ui/LangCombo'
import { EmailChips, type EmailChip } from '@/shared/ui/EmailChips'
import { parseEmailChip } from '@/shared/ui/emailChipParse'
import { ErrorNotice, InfoNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'
import { toDateInputValue } from '@/shared/utils/format'
import { PmPickCell } from '@/features/jobs/TargetLanguages'
import { DateTextInput } from '@/shared/ui/DateField'

type Draft = {
  jobName: string
  /** 작업 종류 (번역·감수·편집·DTP…) — 업무 구분이 아니다 (팀장님 2026-11-25). */
  workCode: string
  jobSlang: string
  jobElang: string
  pmId: string | null
  pmName: string | null
  jobEday: string
  jobEdayTime: string
}

const draftOf = (job: JobRow): Draft => ({
  jobName: job.jobName ?? '',
  workCode: job.workCode ?? '',
  jobSlang: job.jobSlang ?? '',
  jobElang: job.jobElang ?? '',
  pmId: job.jobPmId ?? null,
  pmName: job.jobPmName ?? null,
  jobEday: toDateInputValue(job.jobEday),
  jobEdayTime: (job.jobEdayTime ?? '').slice(0, 5),
})

/** 원래 값과 달라진 칸만 — 저장할 것. */
function changesOf(job: JobRow, d: Draft): Partial<JobUpdate> | null {
  const o = draftOf(job)
  const out: Partial<JobUpdate> = {}
  if (d.jobName !== o.jobName && d.jobName.trim()) out.jobName = d.jobName.trim()
  if (d.workCode !== o.workCode) out.workCode = d.workCode || null
  if (d.jobSlang !== o.jobSlang) out.jobSlang = d.jobSlang || null
  if (d.jobElang !== o.jobElang) out.jobElang = d.jobElang || null
  if (d.pmId !== o.pmId) out.jobPmId = d.pmId
  if (d.jobEday !== o.jobEday) out.jobEday = d.jobEday || null
  if (d.jobEdayTime !== o.jobEdayTime) out.jobEdayTime = d.jobEdayTime || null
  return Object.keys(out).length > 0 ? out : null
}

const DEFAULT_CC = 'work <work1@lion-korea.com>'

export function JobHandoverFlow(props: {
  projectId: string
  /** 창 머리에 보일 프로젝트 — 코드와 이름. */
  projectLabel: string
  /** 프로젝트 NAS 경로 — 인계정보 '경로' 칸의 기본값 (팀장님 2026-11-25). */
  projectPath?: string
  /** 프로젝트 화면에서 골라 둔 작업. 있으면 바로 인계정보 입력으로 (담당PM 이 다 있을 때). */
  preselected?: string[]
  onClose: () => void
  onDone: (message: string) => void
}) {
  const jobsQuery = useJobs({ limit: DETAIL_PAGE_SIZE, projectId: props.projectId }, true)
  const jobs = useMemo(() => jobsQuery.data?.pages.flatMap((p) => p.items) ?? [], [jobsQuery.data])
  const loaded = !jobsQuery.isLoading && !!jobsQuery.data
  const pre = props.preselected ?? []

  const [edits, setEdits] = useState<Record<string, Draft>>({})
  const [checked, setChecked] = useState<Set<string>>(() => new Set(pre))
  const [step, setStep] = useState<'pick' | 'info' | null>(pre.length > 0 ? null : 'pick')

  const draft = (job: JobRow) => edits[job.id] ?? draftOf(job)
  const picked = jobs.filter((j) => checked.has(j.id))
  const preAllPm = pre.length > 0 && jobs.filter((j) => pre.includes(j.id)).every((j) => !!j.jobPmId)
  const shown = step ?? (loaded ? (preAllPm ? 'info' : 'pick') : null)

  if (shown === null) {
    return (
      <Modal title="인계" onClose={props.onClose} width={420}>
        <p className={ui.hint}>작업을 불러오는 중…</p>
      </Modal>
    )
  }
  if (shown === 'pick') {
    return (
      <PickJobs
        {...props}
        jobs={jobs}
        loading={jobsQuery.isLoading}
        error={jobsQuery.error}
        draft={draft}
        setDraft={(id, d) => setEdits((prev) => ({ ...prev, [id]: d }))}
        checked={checked}
        setChecked={setChecked}
        pmNotice={step === null && pre.length > 0}
        onConfirmed={() => setStep('info')}
      />
    )
  }
  return (
    <HandoverInfo
      {...props}
      jobs={picked.map((j) => ({ id: j.id, label: `${j.jobCode} ${draft(j).jobName}`.trim(), pmName: draft(j).pmName ?? '' }))}
      onBack={() => setStep('pick')}
    />
  )
}

/* -------------------------------------------------------------------------- */
/* 1. 작업 선택                                                                */
/* -------------------------------------------------------------------------- */

function PickJobs(props: {
  projectLabel: string
  jobs: JobRow[]
  loading: boolean
  error: unknown
  draft: (job: JobRow) => Draft
  setDraft: (id: string, d: Draft) => void
  checked: Set<string>
  setChecked: (next: Set<string>) => void
  pmNotice: boolean
  onClose: () => void
  onConfirmed: () => void
}) {
  const { jobs, draft, setDraft, checked, setChecked } = props
  const updateJob = useUpdateJob()
  const [problem, setProblem] = useState<string | null>(null)
  const [missing, setMissing] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)

  const dirty = jobs.some((j) => changesOf(j, draft(j)) !== null)
  const allOn = jobs.length > 0 && jobs.every((j) => checked.has(j.id))

  const [view, setView] = useState<'jobs' | 'groups'>('jobs')
  const toggle = (id: string) => {
    const next = new Set(checked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setChecked(next)
  }

  const confirm = async () => {
    setProblem(null)
    const picked = jobs.filter((j) => checked.has(j.id))
    if (picked.length === 0) return setProblem('인계할 작업을 하나 이상 골라 주세요.')
    const noPm = picked.filter((j) => !draft(j).pmId)
    if (noPm.length > 0) {
      setMissing(new Set(noPm.map((j) => j.id)))
      return setProblem(`담당PM 이 비어 있는 작업이 있습니다 — ${noPm.map((j) => draft(j).jobName || j.jobCode).join(', ')}. 담당PM 을 고른 뒤 확인을 눌러 주세요.`)
    }
    setMissing(new Set())
    setSaving(true)
    try {
      for (const job of jobs) {
        const input = changesOf(job, draft(job))
        if (input) await updateJob.mutateAsync({ id: job.id, input })
      }
      props.onConfirmed()
    } catch (err) {
      setProblem(`작업을 저장하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`인계 — 작업 선택 · ${props.projectLabel}`}
      onClose={props.onClose}
      width={1040}
      isDirty={dirty}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={props.onClose} disabled={saving}>
            취소
          </button>
          <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => void confirm()} disabled={saving || props.loading}>
            {saving ? '저장하는 중…' : '확인'}
          </button>
        </>
      }
    >
      <ErrorNotice error={props.error} />
      {props.pmNotice ? <InfoNotice>골라 둔 작업 중 담당PM 이 비어 있는 것이 있어 작업 선택 창을 열었습니다.</InfoNotice> : null}
      {/* 작업 목록 | 그룹 목록 (팀장님 2026-11-25). 그룹 목록은 보기만 한다 — 고르는 것은 작업 목록에서. */}
      <div className={ui.hoTabs} role="tablist">
        {(
          [
            ['jobs', '작업 목록'],
            ['groups', '그룹 목록'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={view === id} className={`${ui.hoTab} ${view === id ? ui.hoTabOn : ''}`} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
      </div>
      {view === 'groups' ? <GroupList jobs={jobs} /> : null}
      <p className={ui.hint} style={{ marginTop: 0, display: view === 'jobs' ? undefined : 'none' }}>
        인계할 작업을 고르세요. 이 창에서 고친 값은 <strong>확인</strong>을 누를 때 작업에 저장됩니다.
      </p>
      <div className={ui.tableWrap} style={view === 'jobs' ? undefined : { display: 'none' }}>
        <table className={ui.hoTable}>
          <thead>
            <tr>
              <th style={{ width: 34 }}>
                <input
                  type="checkbox"
                  aria-label="작업 전체 선택"
                  checked={allOn}
                  onChange={() => setChecked(allOn ? new Set() : new Set(jobs.map((j) => j.id)))}
                />
              </th>
              <th>작업명</th>
              <th style={{ width: 120 }}>작업종류</th>
              <th style={{ width: 260 }}>언어 (출발어 → 도착어)</th>
              <th style={{ width: 150 }}>담당PM</th>
              <th style={{ width: 210 }}>납기</th>
            </tr>
          </thead>
          <tbody>
            {props.loading ? (
              <tr>
                <td colSpan={6} className={ui.hint}>불러오는 중…</td>
              </tr>
            ) : jobs.length === 0 ? (
              <tr>
                <td colSpan={6} className={ui.hint}>이 프로젝트에는 작업이 없습니다.</td>
              </tr>
            ) : (
              jobs.map((job) => {
                const d = draft(job)
                const set = (patch: Partial<Draft>) => setDraft(job.id, { ...d, ...patch })
                const on = checked.has(job.id)
                return (
                  <tr key={job.id} className={on ? '' : ui.hoOff}>
                    <td>
                      <input type="checkbox" aria-label={`${job.jobCode} 선택`} checked={on} onChange={() => toggle(job.id)} />
                    </td>
                    <td>
                      <input className={ui.input} aria-label={`${job.jobCode} 작업명`} value={d.jobName} disabled={saving} onChange={(e) => set({ jobName: e.target.value })} />
                      <div className={ui.hint} style={{ marginTop: 2 }}>{job.jobCode}</div>
                    </td>
                    <td>
                      <CodeSelect ariaLabel={`${job.jobCode} 작업종류`} domain={CODE_DOMAIN.WORK} value={d.workCode} onChange={(v) => set({ workCode: v })} placeholder="-" disabled={saving} silent />
                    </td>
                    <td>
                      {isLinguistic(job.jobType) ? (
                        <div className={ui.hoLang}>
                          <LangCombo ariaLabel={`${job.jobCode} 출발어`} value={d.jobSlang} onChange={(v) => set({ jobSlang: v })} placeholder="-" disabled={saving} />
                          <span>→</span>
                          <LangCombo ariaLabel={`${job.jobCode} 도착어`} value={d.jobElang} onChange={(v) => set({ jobElang: v })} placeholder="-" disabled={saving} />
                        </div>
                      ) : (
                        <span className={ui.hint}>-</span>
                      )}
                    </td>
                    <td className={missing.has(job.id) ? ui.hoMissing : undefined}>
                      <PmPickCell
                        ariaLabel={`${job.jobCode} 담당PM`}
                        pmId={d.pmId}
                        pmName={d.pmName}
                        disabled={saving}
                        onChange={(pmId, pmName) => set({ pmId, pmName })}
                      />
                    </td>
                    <td>
                      <div className={ui.hoDue}>
                        <DateTextInput ariaLabel={`${job.jobCode} 납기`} value={d.jobEday} disabled={saving} onChange={(v) => set({ jobEday: v })} />
                        <input className={ui.input} type="time" aria-label={`${job.jobCode} 납기 시각`} style={{ width: 92 }} value={d.jobEdayTime} disabled={saving} onChange={(e) => set({ jobEdayTime: e.target.value })} />
                      </div>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      {problem ? <p className={`${ui.hint} ${ui.hintWarn}`}>{problem}</p> : null}
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */
/* 2. 인계정보 입력                                                             */
/* -------------------------------------------------------------------------- */

function toggle<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

function HandoverInfo(props: {
  projectId: string
  projectLabel: string
  projectPath?: string
  jobs: { id: string; label: string; pmName: string }[]
  onClose: () => void
  onBack: () => void
  onDone: (message: string) => void
}) {
  const send = useSendJobHandover()
  const { data: profile } = useProfile()
  const [formats, setFormats] = useState<string[]>(['WORD'])
  const [formatText, setFormatText] = useState('')
  const [layouts, setLayouts] = useState<string[]>([])
  const [layoutText, setLayoutText] = useState('')
  const [note, setNote] = useState('')
  // 경로 — 기본은 프로젝트 경로. 여기서 고쳐도 프로젝트 경로는 그대로 (이 인계의 메일·시트에만).
  const [path, setPath] = useState(props.projectPath ?? '')
  const [preview, setPreview] = useState<{ subject: string; html: string; recipients: string[] } | null>(null)
  const [previewError, setPreviewError] = useState<unknown>(null)
  const [previewing, setPreviewing] = useState(false)
  const [cc, setCc] = useState<EmailChip[]>(() => [parseEmailChip(DEFAULT_CC)!])
  const [hiworksId, setHiworksId] = useState<string | null>(null)
  const [hiworksPassword, setHiworksPassword] = useState('')
  const id = hiworksId ?? profile?.mgrId ?? ''
  /*
   * 내 정보에 저장한 하이웍스 계정 (팀장님 2026-11-26). 있으면 두 칸을 감추고 그 계정으로 보낸다.
   * '직접 입력' 은 이번만 다른 계정으로 — 예전 인계메일 창(진우님)과 같은 규칙.
   */
  const credential = useHiworksCredential()
  const hasStored = (credential.data?.registered ?? false) && (credential.data?.vaultConfigured ?? false)
  const [manual, setManual] = useState(false)
  const useStored = hasStored && !manual

  const pms = [...new Set(props.jobs.map((j) => j.pmName).filter(Boolean))]
  const choicesOk = (formats.length > 0 || formatText.trim().length > 0) && (layouts.length > 0 || layoutText.trim().length > 0)
  const ccBad = cc.some((c) => !c.valid)
  const canHandover = choicesOk && !send.isPending
  const canSend = canHandover && !ccBad && (useStored || (id.trim().length > 0 && hiworksPassword.length > 0))

  const inputOf = (withMail: boolean): JobHandoverInput => ({
    jobIds: props.jobs.map((j) => j.id),
    formats,
    formatText: formatText.trim(),
    layouts,
    layoutText: layoutText.trim(),
    note: note.trim(),
    path: path.trim(),
    cc: withMail ? cc.map((c) => c.email) : [],
    send: withMail,
    // 저장된 계정으로 보낼 때는 ID·비밀번호를 아예 보내지 않는다 — 서버가 저장된 계정을 쓴다.
    ...(withMail && !useStored ? { hiworksId: id.trim(), hiworksPassword } : {}),
  })

  /** [미리보기] — 보낼 메일을 서버가 그대로 만들어 준다. 저장·발송은 하지 않는다. */
  const openPreview = async () => {
    setPreviewing(true)
    setPreviewError(null)
    try {
      setPreview(await previewJobHandover(props.projectId, inputOf(false)))
    } catch (e) {
      setPreviewError(e)
    } finally {
      setPreviewing(false)
    }
  }

  const submit = async (withMail: boolean) => {
    if (withMail ? !canSend : !canHandover) return
    const r = await send.mutateAsync({ projectId: props.projectId, input: inputOf(withMail) })
    const label = (jobId: string) => props.jobs.find((j) => j.id === jobId)?.label ?? jobId
    const parts = [`작업 ${String(r.created)}건을 인계했습니다.`]
    if (r.skipped.length > 0) parts.push(`제외: ${r.skipped.map((s) => `${label(s.jobId)} (${s.reason})`).join(' / ')}`)
    const ok = r.mails.filter((m) => m.sent)
    const failed = r.mails.filter((m) => !m.sent)
    if (ok.length > 0) parts.push(`인계 메일 ${String(ok.length)}통 발송: ${ok.map((m) => `${m.pmName} (${m.recipient})`).join(', ')}`)
    if (failed.length > 0) parts.push(`메일 발송 실패: ${failed.map((m) => `${m.pmName} — ${m.error ?? ''}`).join(' / ')}`)
    props.onDone(parts.join(' · '))
    props.onClose()
  }

  const busy = send.isPending
  return (
    <Modal
      title="인계정보 입력"
      onClose={props.onClose}
      isDirty={hiworksPassword.length > 0 || note.trim().length > 0}
      width={600}
      footer={
        <>
          <button type="button" className={`${ui.btn} ${ui.btnGhost}`} onClick={props.onBack} disabled={busy} style={{ marginRight: 'auto' }}>
            ‹ 작업 선택
          </button>
          <button type="button" className={ui.btn} onClick={() => void openPreview()} disabled={busy || previewing} title="보낼 인계 메일을 미리 봅니다 (보내지 않음)">
            {previewing ? '불러오는 중…' : '미리보기'}
          </button>
          <button type="button" className={ui.btn} onClick={props.onClose} disabled={busy}>
            취소
          </button>
          <button type="button" className={ui.btn} onClick={() => void submit(false)} disabled={!canHandover} title="각 작업의 담당PM 에게 인계합니다 (메일은 보내지 않음)">
            {busy ? '처리 중…' : '인계'}
          </button>
          <button type="button" className={`${ui.btn} ${ui.btnPrimary}`} onClick={() => void submit(true)} disabled={!canSend} title="인계하고, 모든 담당PM 에게 인계 메일 한 통을 보냅니다">
            {busy ? '처리 중…' : '인계·발송'}
          </button>
        </>
      }
    >
      <ErrorNotice error={send.error ?? previewError} />
      <p className={ui.hint} style={{ marginTop: 0 }}>
        <strong>{props.projectLabel}</strong> — 작업 {props.jobs.length}건을 담당PM{pms.length > 0 ? ` (${pms.join(', ')})` : ''} 에게 인계합니다.
        PM 이 받으면 아래 내용이 그 PM 의 나의 업무 <strong>비고</strong> 칸에 들어갑니다.
      </p>

      <div className={ui.field}>
        <label className={`${ui.label} ${ui.required}`}>편집포맷</label>
        <div className={ui.checkGrid}>
          {HANDOVER_FORMATS.map((option) => (
            <label key={option} className={ui.check}>
              <input type="checkbox" checked={formats.includes(option)} onChange={() => setFormats((p) => toggle(p, option))} disabled={busy} />
              <span className={ui.checkText}>
                <span className={ui.checkLabel}>{option}</span>
              </span>
            </label>
          ))}
        </div>
        <input className={`${ui.input} ${ui.hoCustom}`} placeholder="직접 입력" aria-label="편집포맷 직접 입력" value={formatText} maxLength={200} onChange={(e) => setFormatText(e.target.value)} disabled={busy} />
      </div>

      <div className={ui.field}>
        <label className={`${ui.label} ${ui.required}`}>레이아웃</label>
        <div className={ui.checkGrid}>
          {HANDOVER_LAYOUTS.map((option) => (
            <label key={option} className={ui.check}>
              <input type="checkbox" checked={layouts.includes(option)} onChange={() => setLayouts((p) => toggle(p, option))} disabled={busy} />
              <span className={ui.checkText}>
                <span className={ui.checkLabel}>{option}</span>
              </span>
            </label>
          ))}
        </div>
        <input className={`${ui.input} ${ui.hoCustom}`} placeholder="직접 입력" aria-label="레이아웃 직접 입력" value={layoutText} maxLength={200} onChange={(e) => setLayoutText(e.target.value)} disabled={busy} />
      </div>

      <div className={ui.field}>
        <label className={ui.label} htmlFor="ho-path">경로</label>
        <input
          id="ho-path"
          className={ui.input}
          maxLength={1000}
          placeholder="NAS 경로 — 프로젝트에 경로가 있으면 미리 들어갑니다"
          value={path}
          // 누르면 전체 선택 — 바로 덮어써 넣을 수 있게 (팀장님 2026-11-25).
          onFocus={(e) => e.currentTarget.select()}
          onMouseUp={(e) => e.preventDefault()}
          onChange={(e) => setPath(e.target.value)}
          disabled={busy}
        />
        <p className={ui.hint}>인계 메일의 경로 칸과, PM 이 받으면 나의 업무 시트 <strong>경로</strong> 칸에 들어갑니다. 여기서 고쳐도 프로젝트 경로는 바뀌지 않습니다.</p>
      </div>

      <div className={ui.field}>
        <label className={ui.label} htmlFor="ho-note">기타요청</label>
        <textarea
          id="ho-note"
          className={ui.textarea}
          rows={4}
          maxLength={2000}
          placeholder="분량·업무지침·납품처 등 담당PM 전달 사항을 입력해주세요."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={busy}
        />
      </div>

      <div className={ui.field}>
        <label className={ui.label} htmlFor="ho-cc">메일 참조</label>
        <EmailChips id="ho-cc" value={cc} onChange={setCc} disabled={busy} placeholder="이름 <주소> 또는 주소 — 쉼표·Enter 로 구분" />
        {ccBad ? <p className={`${ui.hint} ${ui.hintWarn}`}>메일 주소가 아닌 항목(빨간색)이 있습니다. 고치거나 지워 주세요.</p> : null}
        <p className={ui.hint}>받는 사람은 고른 작업의 담당PM 이메일로 정해집니다. PM 이 여럿이어도 메일은 한 통이고, 모든 PM 이 함께 받습니다.</p>
      </div>

      <InfoNotice>
        <strong>인계·발송</strong> 때만 쓰입니다. 메일은 <strong>본인의 하이웍스 계정</strong>에서 발송되며, 보낸메일함에도 저장됩니다.
        {useStored ? ' 내 정보에 저장한 계정으로 보냅니다.' : ' 입력한 ID 와 비밀번호는 발송에 한 번 쓰이고 저장되지 않습니다.'}
      </InfoNotice>
      {useStored ? (
        <div className={ui.filterNote}>
          저장된 계정: <strong>{credential.data?.hiworksIdHint ?? '-'}</strong>
          <button type="button" className={ui.btnLink} onClick={() => setManual(true)} disabled={busy}>
            직접 입력
          </button>
        </div>
      ) : (
        <div className={ui.datePair}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="ho-id">하이웍스 ID</label>
          <input id="ho-id" className={ui.input} autoComplete="username" value={id} onChange={(e) => setHiworksId(e.target.value)} disabled={busy} />
        </div>
        <div className={ui.field}>
          <label className={ui.label} htmlFor="ho-pw">하이웍스 비밀번호</label>
          <input id="ho-pw" className={ui.input} type="password" autoComplete="current-password" value={hiworksPassword} onChange={(e) => setHiworksPassword(e.target.value)} disabled={busy} />
        </div>
      </div>
      )}
      {preview ? (
        <Modal title="인계 메일 미리보기" width={560} onClose={() => setPreview(null)} footer={<button type="button" className={ui.btn} onClick={() => setPreview(null)}>닫기</button>}>
          <div className={ui.mailHead}>
            <div><span>받는 사람</span>{preview.recipients.join(', ') || '-'}</div>
            <div><span>참조</span>{cc.map((c) => c.email).join(', ') || '-'}</div>
            <div><span>제목</span><strong>{preview.subject}</strong></div>
          </div>
          {/* 보낼 메일 본문 그대로 — 스크립트가 돌지 않는 틀 안에서 보인다. */}
          <iframe title="인계 메일 본문" className={ui.mailFrame} sandbox="" srcDoc={preview.html} />
        </Modal>
      ) : null}
    </Modal>
  )
}

/* -------------------------------------------------------------------------- */
/* 그룹 목록 — 보기만 (팀장님 2026-11-25)                                       */
/* -------------------------------------------------------------------------- */

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x && x.trim() !== ''))]

function GroupList(props: { jobs: readonly JobRow[] }) {
  const workName = useCodeNames(CODE_DOMAIN.WORK)
  const groups = new Map<string, JobRow[]>()
  for (const j of props.jobs) {
    const key = j.jobGroup ?? '-'
    groups.set(key, [...(groups.get(key) ?? []), j])
  }
  const keys = [...groups.keys()].sort((a, b) => groupNumber(a) - groupNumber(b))
  return (
    <div className={ui.tableWrap}>
      <table className={ui.hoTable}>
        <thead>
          <tr>
            <th style={{ width: 90 }}>JOB 그룹</th>
            <th>작업명</th>
            <th style={{ width: 140 }}>작업종류</th>
            <th style={{ width: 240 }}>언어</th>
            <th style={{ width: 150 }}>담당PM</th>
            <th style={{ width: 150 }}>납기</th>
          </tr>
        </thead>
        <tbody>
          {keys.length === 0 ? (
            <tr>
              <td colSpan={6} className={ui.hint}>이 프로젝트에는 작업이 없습니다.</td>
            </tr>
          ) : (
            keys.map((key) => {
              const list = groups.get(key) ?? []
              const src = uniq(list.map((j) => j.jobSlang))
              const tgt = uniq(list.map((j) => j.jobElang))
              const due = list
                .map((j) => (j.jobEday ? `${toDateInputValue(j.jobEday)} ${(j.jobEdayTime ?? '').slice(0, 5)}`.trim() : ''))
                .filter(Boolean)
                .sort()
                .pop()
              return (
                <tr key={key}>
                  <td className={ui.cellMono}>{key}</td>
                  <td>
                    {list[0]?.jobName ?? list[0]?.jobCode ?? '-'}
                    {list.length > 1 ? <span className={ui.hint}> 외 {list.length - 1}건</span> : null}
                  </td>
                  <td>{uniq(list.map((j) => workName(j.workCode))).join(', ') || '-'}</td>
                  <td>{src.length || tgt.length ? `${src.join(', ') || '-'} → ${tgt.join(', ') || '-'}` : '-'}</td>
                  <td>{uniq(list.map((j) => j.jobPmName)).join(', ') || '-'}</td>
                  <td>{due ?? '-'}</td>
                </tr>
              )
            })
          )}
        </tbody>
      </table>
    </div>
  )
}
