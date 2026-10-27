import { useState } from 'react'
import { useCreateCustomer, useUpdateCustomer } from '@/apis/queries/neotms.mutation'
import { codeOptions, COIN_CODES } from '@/apis/neotms.codes'
import type { CustomerInput, CustomerRow } from '@/apis/neotms.types'
import { ErrorNotice } from '@/shared/ui/Feedback'
import { Modal } from '@/shared/ui/Modal'
import { toDecimalInput } from '@/shared/utils/money'
import ui from '@/shared/ui/ui.module.css'

interface Props {
  /** null 이면 신규. */
  customer: CustomerRow | null
  onClose: () => void
  onSaved: (message: string) => void
}

/**
 * 고객사 등록·수정.
 *
 * 코드(`cusCode`)는 입력란이 없다. 서버가 시퀀스로 발급하고(`CUS_000001`), 발급 시점은 INSERT
 * 안이다 — 화면에서 미리 보여 줄 수 있는 값이 아니고, 보여 주면 두 사람이 동시에 등록할 때
 * 같은 코드를 본 뒤 하나가 실패한다.
 */
export function CustomerFormModal({ customer, onClose, onSaved }: Props) {
  const isEdit = !!customer
  const createCustomer = useCreateCustomer()
  const updateCustomer = useUpdateCustomer()
  const pending = createCustomer.isPending || updateCustomer.isPending

  const [form, setForm] = useState({
    cusName: customer?.cusName ?? '',
    cusEmail: customer?.cusEmail ?? '',
    cusPhone: customer?.cusPhone ?? '',
    cusNation: customer?.cusNation ?? '',
    cusCoin: customer?.cusCoin ?? 'KRW',
    cusUpro: customer?.cusUpro ?? '',
    cusMincost: customer?.cusMincost ?? '',
    cusField: customer?.cusField ?? '',
    cusZip: customer?.cusZip ?? '',
    cusAddr: customer?.cusAddr ?? '',
    active: customer?.active ?? true,
  })
  const [dirty, setDirty] = useState(false)

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setDirty(true)
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const onSubmit = async () => {
    const name = form.cusName.trim()
    if (name.length === 0) return

    /*
     * 빈 문자열은 null 로 보낸다.
     *
     * `''` 를 그대로 보내면 "값이 빈 문자열인 고객사" 가 저장된다. 그러면 이메일이 없는
     * 고객사와 이메일이 빈 문자열인 고객사가 DB 안에서 다른 행이 되고, `IS NULL` 로 거르는
     * 조회에 걸리지 않는다. 레거시가 정확히 그 상태였다.
     */
    const input: CustomerInput = {
      cusName: name,
      cusEmail: form.cusEmail.trim() || null,
      cusPhone: form.cusPhone.trim() || null,
      cusNation: form.cusNation.trim() || null,
      cusCoin: form.cusCoin.trim() || null,
      // 등급·분야는 코드값이므로 다듬지 않고 그대로 보낸다. 금액은 최소 수주 금액 하나뿐이다.
      cusUpro: form.cusUpro.trim() || null,
      cusMincost: toDecimalInput(form.cusMincost),
      cusField: form.cusField.trim() || null,
      cusZip: form.cusZip.trim() || null,
      cusAddr: form.cusAddr.trim() || null,
      active: form.active,
    }

    if (customer) {
      await updateCustomer.mutateAsync({ id: customer.id, input })
      onSaved(`${name} 고객사를 수정했습니다.`)
    } else {
      const created = await createCustomer.mutateAsync(input)
      onSaved(`${name} 고객사를 등록했습니다. (코드: ${created.cusCode})`)
    }
    onClose()
  }

  return (
    <Modal
      title={isEdit ? '고객사 수정' : '고객사 등록'}
      onClose={onClose}
      isDirty={dirty && !pending}
      width={620}
      footer={
        <>
          <button type="button" className={ui.btn} onClick={onClose} disabled={pending}>
            취소
          </button>
          <button
            type="button"
            className={`${ui.btn} ${ui.btnPrimary}`}
            onClick={() => void onSubmit()}
            disabled={pending || form.cusName.trim().length === 0}
          >
            {pending ? '저장 중…' : '저장'}
          </button>
        </>
      }
    >
      <ErrorNotice error={createCustomer.error ?? updateCustomer.error} />

      {isEdit ? (
        <p className={ui.hint}>
          고객사 코드 <strong>{customer.cusCode}</strong> — 코드는 변경할 수 없습니다.
        </p>
      ) : null}

      <div className={ui.formGrid}>
        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="cus-name">
            고객사명 <span className={ui.required}>*</span>
          </label>
          <input
            id="cus-name"
            className={ui.input}
            value={form.cusName}
            onChange={(e) => set('cusName', e.target.value)}
            required
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="cus-email">
            이메일
          </label>
          <input
            id="cus-email"
            className={ui.input}
            type="email"
            value={form.cusEmail}
            onChange={(e) => set('cusEmail', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="cus-phone">
            전화
          </label>
          <input
            id="cus-phone"
            className={ui.input}
            value={form.cusPhone}
            onChange={(e) => set('cusPhone', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="cus-nation">
            국가
          </label>
          <input
            id="cus-nation"
            className={ui.input}
            value={form.cusNation}
            onChange={(e) => set('cusNation', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="cus-coin">
            기본 통화
          </label>
          <select
            id="cus-coin"
            className={ui.select}
            value={form.cusCoin}
            onChange={(e) => set('cusCoin', e.target.value)}
          >
            <option value="">선택 없음</option>
            {/* 운영 데이터에 없는 통화 코드가 들어 있어도 지워지지 않게 한다 — neotms.codes.ts */}
            {codeOptions(COIN_CODES, form.cusCoin).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/*
         * 등급(UPRO)은 금액이 아니다.
         *
         * 레거시 컬럼명 때문에 "단가" 로 읽히지만 `sys_code` 를 참조하는 코드값이고, 그 코드가
         * 기본 단가 밴드를 고른다(db/002_tables.sql 의 COMMENT). 금액 입력란으로 만들면
         * 담당자가 `35000` 을 넣고 저장이 409 로 실패한다.
         *
         * 코드 목록을 주는 엔드포인트가 아직 없어서 자유 입력이다. 그래서 안내 문구가 필수다 —
         * 없으면 틀린 값을 넣는 쪽이 자연스럽다.
         */}
        <div className={ui.field}>
          <label className={ui.label} htmlFor="cus-upro">
            등급
          </label>
          <input
            id="cus-upro"
            className={ui.input}
            value={form.cusUpro}
            onChange={(e) => set('cusUpro', e.target.value)}
          />
          <span className={ui.hint}>등록된 코드값만 저장됩니다. 금액이 아닙니다.</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="cus-mincost">
            최소 수주 금액
          </label>
          <input
            id="cus-mincost"
            className={`${ui.input} ${ui.inputNum}`}
            inputMode="decimal"
            value={form.cusMincost}
            onChange={(e) => set('cusMincost', e.target.value)}
          />
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="cus-field">
            분야
          </label>
          <input
            id="cus-field"
            className={ui.input}
            value={form.cusField}
            onChange={(e) => set('cusField', e.target.value)}
          />
          <span className={ui.hint}>등록된 코드값만 저장됩니다.</span>
        </div>

        <div className={ui.field}>
          <label className={ui.label} htmlFor="cus-zip">
            우편번호
          </label>
          <input
            id="cus-zip"
            className={ui.input}
            value={form.cusZip}
            onChange={(e) => set('cusZip', e.target.value)}
          />
        </div>

        <div className={ui.fieldWide}>
          <label className={ui.label} htmlFor="cus-addr">
            주소
          </label>
          <input
            id="cus-addr"
            className={ui.input}
            value={form.cusAddr}
            onChange={(e) => set('cusAddr', e.target.value)}
          />
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
                해제하면 신규 프로젝트의 고객사 선택 목록에서 빠집니다. 기존 프로젝트와 매출
                기록은 그대로 남습니다.
              </span>
            </span>
          </label>
        </div>
      </div>
    </Modal>
  )
}
