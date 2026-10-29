import { useState } from 'react'
import { useCreateCode, useUpdateCode } from '@/apis/queries/neotms.mutation'
import type { CodeInput, CodeRow, CodeUpdateInput } from '@/apis/neotms.types'
import { ErrorNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import ui from '@/shared/ui/ui.module.css'

interface Props {
  /** null 이면 신규. */
  code: CodeRow | null
  /** 신규일 때 상위 도메인의 초기값. 지금 보고 있는 탭이 들어온다. */
  defaultParent?: string | null
  /** 상위로 고를 수 있는 도메인 행들(`codeParent` 가 null 인 행). */
  domains: readonly CodeRow[]
  onClose: () => void
  onSaved: (message: string) => void
}

/**
 * 코드 등록·수정.
 *
 * ## `code` 는 등록할 때만 입력받는다
 *
 * 수정 화면에서는 글자로만 보여 준다. 22개 컬럼이 `sys_code (code)` 를 참조하고 있어서, 값이
 * 참조되고 있으면 UPDATE 자체가 거절되고(참조 제약의 기본은 NO ACTION) 아직 아무도 참조하지
 * 않는 코드라면 **성공해 버린다** — 그러면 같은 개념이 두 가지 표기로 갈라진 채 둘 다 살아 있게
 * 된다. 코드를 잘못 만들었을 때의 해결은 그 코드를 '사용 중지' 로 내리고 올바른 코드를 새로
 * 만드는 것이다.
 *
 * ## 코드값은 전체 테이블에서 유일하다 — 도메인별이 아니다
 *
 * 외래키가 참조하려면 유일 제약이 있어야 하고, 그게 `(code_parent, code)` 라면 참조하는 22개
 * 테이블에 `code_parent` 를 다 복제해야 한다. 그래서 '기타' 는 이 DB 에 딱 하나만 존재할 수
 * 있다(작업 종류가 쓰고 있고, 다른 도메인은 '일반·기타', '기타 언어', '기타 프로그램' 처럼
 * 수식해서 쓴다). 서버가 23505 를 그 문장으로 번역해 주므로 여기서 미리 막지는 않는다.
 */
export function CodeFormModal({ code, defaultParent, domains, onClose, onSaved }: Props) {
  const isEdit = !!code
  const createCode = useCreateCode()
  const updateCode = useUpdateCode()
  const pending = createCode.isPending || updateCode.isPending

  const [form, setForm] = useState({
    code: code?.code ?? '',
    codeName: code?.codeName ?? '',
    codeEngName: code?.codeEngName ?? '',
    codeParent: code?.codeParent ?? defaultParent ?? '',
    // 숫자지만 문자열로 들고 있는다. number 로 두면 입력란을 비우는 순간 0 이 되고, 0 과
    // "순서 없음" 은 다른 뜻이다(`ord_no` 는 nullable 이고 NULL 은 목록 맨 끝으로 간다).
    ordNo: code?.ordNo === null || code?.ordNo === undefined ? '' : String(code.ordNo),
    active: code?.active ?? true,
  })
  const [dirty, setDirty] = useState(false)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setDirty(true)
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  /** 빈 문자열은 null, 숫자가 아니면 null. 서버의 `OrdNoSchema` 가 정수만 받는다. */
  const toOrdNo = (raw: string): number | null => {
    const trimmed = raw.trim()
    if (trimmed.length === 0) return null
    const parsed = Number(trimmed)
    return Number.isInteger(parsed) ? parsed : null
  }

  const trimmedCode = form.code.trim()
  const canSave = isEdit ? true : trimmedCode.length > 0

  const onSubmit = async () => {
    if (!canSave) return

    const shared: CodeUpdateInput = {
      codeName: form.codeName.trim() || null,
      codeEngName: form.codeEngName.trim() || null,
      // 비워 두면 이 행 자체가 도메인이 된다. 아래 입력란의 설명 문구가 그 뜻을 적어 둔다.
      codeParent: form.codeParent.trim() || null,
      ordNo: toOrdNo(form.ordNo),
      active: form.active,
    }

    const label = form.codeName.trim() || trimmedCode

    if (code) {
      await updateCode.mutateAsync({ id: code.id, input: shared })
      onSaved(`코드 '${label}' 을(를) 수정했습니다.`)
    } else {
      const input: CodeInput = { code: trimmedCode, ...shared }
      await createCode.mutateAsync(input)
      onSaved(`코드 '${label}' 을(를) 등록했습니다.`)
    }
    onClose()
  }

  return (
    <Modal
      title={isEdit ? '코드 수정' : '코드 등록'}
      onClose={onClose}
      isDirty={dirty && !pending}
      width={560}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose} disabled={pending}>
            취소
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void onSubmit()}
            disabled={pending || !canSave}
          >
            {pending ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      <ErrorNotice error={createCode.error ?? updateCode.error} />

      <div className={ui.formGrid}>
        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="code-code">
            코드값 {isEdit ? null : <span className={ui.required}>*</span>}
          </label>
          {isEdit ? (
            <>
              {/* 입력란이 아니라 글자다. disabled 된 입력란으로 두면 "왜 안 되지" 를 먼저
                  겪게 되고, 설명은 그 다음에 읽힌다. */}
              <p className={ui.inputMono}>{code.code}</p>
              <span className={ui.hint}>
                코드값은 변경할 수 없습니다. 이 값이 작업·발주·고객사 등 22개 컬럼에 그대로
                저장되어 있기 때문입니다. 잘못 만든 코드는 아래에서 '사용 중지' 로 내리고 올바른
                코드를 새로 등록해 주십시오.
              </span>
            </>
          ) : (
            <>
              <input
                id="code-code"
                className={`${ui.input} ${ui.inputMono}`}
                value={form.code}
                onChange={(e) => set('code', e.target.value)}
                required
              />
              <span className={ui.hintWarn}>
                저장 후에는 변경할 수 없고, 이 값이 그대로 업무 데이터에 들어갑니다. 드롭다운에
                보이는 글자는 아래 '이름' 이므로, 코드값은 짧고 안 겹치게 적어 주십시오.
              </span>
            </>
          )}
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="code-name">
            이름
          </label>
          <input
            id="code-name"
            className={ui.input}
            value={form.codeName}
            onChange={(e) => set('codeName', e.target.value)}
          />
          <span className={ui.hint}>드롭다운에 표시되는 이름입니다.</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="code-eng">
            영문명
          </label>
          <input
            id="code-eng"
            className={ui.input}
            value={form.codeEngName}
            onChange={(e) => set('codeEngName', e.target.value)}
          />
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="code-parent">
            분류
          </label>
          <select
            id="code-parent"
            className={ui.select}
            value={form.codeParent}
            onChange={(e) => set('codeParent', e.target.value)}
          >
            {/*
             * '분류 자체' 를 고를 수 있게 둔다. 여섯 번째 도메인을 만들 수 있어야 하기
             * 때문이다 — 다만 그렇게 만든 도메인을 읽는 드롭다운은 없다. 그건 화면 코드가
             * 그 도메인을 이름으로 지목해야 생긴다(neotms.codes.ts 의 CODE_DOMAIN).
             */}
            <option value="">(분류 자체 — 새 코드 분류를 만듭니다)</option>
            {domains.map((d) => (
              <option key={d.id} value={d.code}>
                {d.codeName ? `${d.codeName} (${d.code})` : d.code}
              </option>
            ))}
            {/*
             * 지금 값이 목록에 없을 때를 위한 항목. `<select>` 는 어느 option 과도 맞지 않는
             * value 를 받으면 **첫 번째** option 을 고른 것처럼 보여 주므로, 이 항목이 없으면
             * 이름만 고치려고 열었을 때 분류가 조용히 '분류 자체' 로 바뀐다.
             */}
            {form.codeParent && !domains.some((d) => d.code === form.codeParent) ? (
              <option value={form.codeParent}>
                {form.codeParent} (등록되지 않은 분류)
              </option>
            ) : null}
          </select>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="code-ord">
            표시 순서
          </label>
          <input
            id="code-ord"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="numeric"
            value={form.ordNo}
            onChange={(e) => set('ordNo', e.target.value)}
          />
          <span className={ui.hint}>작은 수가 먼저 옵니다. 비우면 목록 맨 뒤로 갑니다.</span>
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.check}>
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => set('active', e.target.checked)}
            />
            <span className={ui.checkText}>
              <span className={ui.checkLabel}>사용 중</span>
              <span className={ui.checkDesc}>
                해제하면 모든 드롭다운에서 사라집니다. 이미 이 코드를 쓰고 있는 작업·발주·고객사는
                그대로 남고 계속 정상 동작합니다 — 코드를 그만 쓰고 싶을 때는 삭제가 아니라 이쪽이
                맞습니다.
              </span>
            </span>
          </label>
        </div>
      </div>
    </Modal>
  )
}
