import { useState } from 'react'
import { useCreateTranslator, useUpdateTranslator } from '@/apis/queries/neotms.mutation'
import { CODE_DOMAIN, codeOptions, COIN_CODES } from '@/apis/neotms.codes'
import type { TranslatorInput, TranslatorRow } from '@/apis/neotms.types'
import { CodeSelect } from '@/shared/ui/CodeSelect'
import { ErrorNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import { toDateInputValue } from '@/shared/utils/format'
import ui from '@/shared/ui/ui.module.css'

interface Props {
  /** null 이면 신규. */
  translator: TranslatorRow | null
  onClose: () => void
  onSaved: (message: string) => void
}

/**
 * 번역가 등록·수정.
 *
 * ## 금액 입력란이 하나도 없다
 *
 * `tranUpro`(사용 프로그램)와 `tranIctax`(원천징수)는 이름이 숫자처럼 읽히지만 둘 다 문자열이다.
 * `tranUpro` 는 `sys_code` 를 참조하는 코드값 — 한때 이 주석과 화면 라벨이 '등급' 이라고 적고
 * 있었고 그건 틀렸다 — 이고, 원천징수는 세율(`3.3`)인지 구분 코드인지 **운영 데이터를 확인하기
 * 전에는 알 수 없다**(db/002_tables.sql 의 COMMENT). 숫자 입력란으로 만들면 둘 중 하나는
 * 반드시 틀린다.
 *
 * 계좌번호도 문자열이다 — 앞자리 0 과 하이픈이 의미를 가진다.
 *
 * ## 중복 등록 메모(`tranDup`)
 *
 * 같은 사람이 "김민수 / Minsu Kim / M. Kim" 으로 세 번 등록되어 있던 것이 레거시의 실제 상태다.
 * 이 칸은 그 다른 표기를 적어 두는 곳이고, 적어 두면 다음 사람이 검색으로 찾는다.
 */
export function TranslatorFormModal({ translator, onClose, onSaved }: Props) {
  const isEdit = !!translator
  const createTranslator = useCreateTranslator()
  const updateTranslator = useUpdateTranslator()
  const pending = createTranslator.isPending || updateTranslator.isPending

  const [form, setForm] = useState({
    tranName: translator?.tranName ?? '',
    tranEmail: translator?.tranEmail ?? '',
    tranPhone: translator?.tranPhone ?? '',
    tranDup: translator?.tranDup ?? '',
    tranUpro: translator?.tranUpro ?? '',
    tranField: translator?.tranField ?? '',
    tranUnfield: translator?.tranUnfield ?? '',
    tranWorkCon: translator?.tranWorkCon ?? '',
    tranCalc: translator?.tranCalc ?? '',
    tranCatUse: translator?.tranCatUse ?? false,
    tranCoin: translator?.tranCoin ?? 'KRW',
    tranGive: translator?.tranGive ?? '',
    tranIctax: translator?.tranIctax ?? '',
    tranBank: translator?.tranBank ?? '',
    tranAcc: translator?.tranAcc ?? '',
    tranPaypal: translator?.tranPaypal ?? '',
    // `<input type="date">` 는 YYYY-MM-DD 만 받는다. 서버가 주는 날짜 문자열을 그 형태로 맞춘다.
    tranRegDay: toDateInputValue(translator?.tranRegDay),
    tranMsg: translator?.tranMsg ?? '',
    active: translator?.active ?? true,
  })
  const [dirty, setDirty] = useState(false)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setDirty(true)
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const onSubmit = async () => {
    const name = form.tranName.trim()
    if (name.length === 0) return

    const input: TranslatorInput = {
      tranName: name,
      tranEmail: form.tranEmail.trim() || null,
      tranPhone: form.tranPhone.trim() || null,
      tranDup: form.tranDup.trim() || null,
      tranUpro: form.tranUpro.trim() || null,
      tranField: form.tranField.trim() || null,
      tranUnfield: form.tranUnfield.trim() || null,
      tranWorkCon: form.tranWorkCon.trim() || null,
      tranCalc: form.tranCalc.trim() || null,
      tranCatUse: form.tranCatUse,
      tranCoin: form.tranCoin.trim() || null,
      tranGive: form.tranGive.trim() || null,
      tranIctax: form.tranIctax.trim() || null,
      tranBank: form.tranBank.trim() || null,
      tranAcc: form.tranAcc.trim() || null,
      tranPaypal: form.tranPaypal.trim() || null,
      tranRegDay: form.tranRegDay || null,
      tranMsg: form.tranMsg.trim() || null,
      active: form.active,
    }

    if (translator) {
      await updateTranslator.mutateAsync({ id: translator.id, input })
      onSaved(`${name} 번역가 정보를 수정했습니다.`)
    } else {
      const created = await createTranslator.mutateAsync(input)
      onSaved(`${name} 번역가를 등록했습니다. (코드: ${created.tranCode})`)
    }
    onClose()
  }

  return (
    <Modal
      title={isEdit ? '번역가 수정' : '번역가 등록'}
      onClose={onClose}
      isDirty={dirty && !pending}
      width={680}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose} disabled={pending}>
            취소
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void onSubmit()}
            disabled={pending || form.tranName.trim().length === 0}
          >
            {pending ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      <ErrorNotice error={createTranslator.error ?? updateTranslator.error} />

      {isEdit ? (
        <p className={ui.hint}>
          번역가 코드 <strong>{translator.tranCode}</strong> — 코드는 변경할 수 없습니다.
        </p>
      ) : null}

      <div className={ui.formGrid}>
        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="tran-name">
            번역가명 <span className={ui.required}>*</span>
          </label>
          <input
            id="tran-name"
            className={ui.input}
            value={form.tranName}
            onChange={(e) => set('tranName', e.target.value)}
            required
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="tran-email">
            이메일
          </label>
          <input
            id="tran-email"
            className={ui.input}
            type="email"
            value={form.tranEmail}
            onChange={(e) => set('tranEmail', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="tran-phone">
            전화
          </label>
          <input
            id="tran-phone"
            className={ui.input}
            value={form.tranPhone}
            onChange={(e) => set('tranPhone', e.target.value)}
          />
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="tran-dup">
            다른 표기
          </label>
          <input
            id="tran-dup"
            className={ui.input}
            value={form.tranDup}
            onChange={(e) => set('tranDup', e.target.value)}
            placeholder="로마자 표기, 이전 이름 등"
          />
          <span className={ui.hint}>
            같은 사람이 두 번 등록되는 것을 막는 칸입니다. 적어 두면 다음 사람이 검색으로 찾습니다.
          </span>
        </div>

        {/*
         * 아래 네 칸은 모두 `sys_code` 참조 코드값이고, 전부 자유 입력이었다.
         *
         * "등록된 코드값만 저장됩니다" 라는 안내가 붙어 있었는데, 그것은 사실이면서 쓸모가
         * 없었다 — 어떤 코드가 등록되어 있는지 화면이 알려 주지 않았고, 코드 테이블이 비어
         * 있던 동안에는 등록된 코드가 아예 없어서 **무엇을 입력해도 저장되지 않았다.**
         * 이제 목록에서 고른다.
         */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="tran-upro">
            사용 프로그램
          </label>
          {/*
           * 라벨이 '등급' 이었다. 틀린 라벨이었다 — `TRAN_UPRO` 의 UPRO 는 이 번역가가 쓰는
           * 번역 프로그램(Trados 등)이고, 002_tables.sql 의 COMMENT 가 '등급' 이라고 적어 둔
           * 것을 화면이 따라 적은 것이다. 단가와 아무 관계가 없고, 배포할 때 쓰는 값이다:
           * Trados 패키지를 Trados 를 쓰지 않는 번역가에게 보내면 그대로 되돌아온다.
           */}
          <CodeSelect
            id="tran-upro"
            domain={CODE_DOMAIN.UPRO}
            value={form.tranUpro}
            onChange={(v) => set('tranUpro', v)}
            hint="이 번역가가 쓰는 번역 프로그램입니다. 단가와는 무관합니다."
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="tran-workcon">
            작업 조건
          </label>
          {/*
           * `tran_work_con` 은 작업 종류 도메인을 참조한다 — 라벨이 '작업 조건' 이라 다른
           * 것처럼 읽히지만, 이 번역가가 맡는 작업의 종류(번역/감수/DTP)를 담는 칸이다.
           */}
          <CodeSelect
            id="tran-workcon"
            domain={CODE_DOMAIN.WORK}
            value={form.tranWorkCon}
            onChange={(v) => set('tranWorkCon', v)}
            hint="주로 맡는 작업 종류입니다."
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="tran-field">
            가능 분야
          </label>
          <CodeSelect
            id="tran-field"
            domain={CODE_DOMAIN.FIELD}
            value={form.tranField}
            onChange={(v) => set('tranField', v)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="tran-unfield">
            불가 분야
          </label>
          <CodeSelect
            id="tran-unfield"
            domain={CODE_DOMAIN.FIELD}
            value={form.tranUnfield}
            onChange={(v) => set('tranUnfield', v)}
            hint="맡기지 않아야 하는 분야입니다."
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="tran-coin">
            정산 통화
          </label>
          <select
            id="tran-coin"
            className={ui.select}
            value={form.tranCoin}
            onChange={(e) => set('tranCoin', e.target.value)}
          >
            <option value="">선택 없음</option>
            {codeOptions(COIN_CODES, form.tranCoin).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="tran-calc">
            정산 기준
          </label>
          <input
            id="tran-calc"
            className={ui.input}
            value={form.tranCalc}
            onChange={(e) => set('tranCalc', e.target.value)}
            placeholder="출발어 기준 / 도착어 기준 등"
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="tran-give">
            지급 방법
          </label>
          <input
            id="tran-give"
            className={ui.input}
            value={form.tranGive}
            onChange={(e) => set('tranGive', e.target.value)}
            placeholder="계좌이체 / PayPal 등"
          />
        </div>

        {/*
         * 원천징수는 텍스트다.
         *
         * 레거시 값이 세율(3.3)인지 소득 구분 코드인지 아직 확인되지 않았다. 숫자 칸으로 만들면
         * 코드였을 때 입력이 막히고, 세율이었을 때는 `3.3` 이 `3` 으로 잘린다. 확인된 뒤에
         * 바꾸는 쪽이 지금 추측하는 쪽보다 싸다.
         */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="tran-ictax">
            원천징수
          </label>
          <input
            id="tran-ictax"
            className={ui.input}
            value={form.tranIctax}
            onChange={(e) => set('tranIctax', e.target.value)}
            placeholder="3.3"
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="tran-bank">
            은행
          </label>
          <input
            id="tran-bank"
            className={ui.input}
            value={form.tranBank}
            onChange={(e) => set('tranBank', e.target.value)}
          />
        </div>

        {/* 계좌번호는 숫자가 아니다 — 앞자리 0 과 하이픈이 의미를 가진다. */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="tran-acc">
            계좌번호
          </label>
          <input
            id="tran-acc"
            className={ui.input}
            value={form.tranAcc}
            onChange={(e) => set('tranAcc', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="tran-paypal">
            PayPal
          </label>
          <input
            id="tran-paypal"
            className={ui.input}
            value={form.tranPaypal}
            onChange={(e) => set('tranPaypal', e.target.value)}
          />
        </div>

        {/* 등록일은 업무상의 사실이고, 행이 만들어진 시각(`createdAt`)과 다른 값이다. */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="tran-regday">
            등록일
          </label>
          <input
            id="tran-regday"
            className={ui.input}
            type="date"
            value={form.tranRegDay}
            onChange={(e) => set('tranRegDay', e.target.value)}
          />
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="tran-msg">
            배정 시 참고사항
          </label>
          <textarea
            id="tran-msg"
            className={ui.textarea}
            rows={3}
            value={form.tranMsg}
            onChange={(e) => set('tranMsg', e.target.value)}
            placeholder="가능 시간대, 품질 주의사항 등"
          />
          <span className={ui.hint}>발주를 배정하는 담당자가 이 내용을 먼저 봅니다.</span>
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.check}>
            <input
              type="checkbox"
              checked={form.tranCatUse}
              onChange={(e) => set('tranCatUse', e.target.checked)}
            />
            <span className={ui.checkText}>
              <span className={ui.checkLabel}>CAT 툴 사용</span>
              <span className={ui.checkDesc}>
                CAT 분석 기반으로 발주 물량을 산정할 수 있는 번역가입니다.
              </span>
            </span>
          </label>
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.check}>
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => set('active', e.target.checked)}
            />
            <span className={ui.checkText}>
              <span className={ui.checkLabel}>거래 중</span>
              <span className={ui.checkDesc}>
                해제하면 새 발주의 번역가 선택 목록에서 빠집니다. 기존 발주와 정산 기록은 그대로
                남습니다.
              </span>
            </span>
          </label>
        </div>
      </div>
    </Modal>
  )
}
