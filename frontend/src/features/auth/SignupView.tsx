import { useState } from 'react'
import { useRegisterSelf } from '@/apis/queries/neotms.mutation'
import type { ProfilePrefill, SelfProfileInput } from '@/apis/neotms.types'
import { ErrorNotice } from '@/shared/ui/Feedback'
import ui from '@/shared/ui/ui.module.css'
import { AuthGateCard } from './AuthGate'
import styles from './AuthGate.module.css'

/**
 * 회원가입 폼. `registration === 'unregistered'` 일 때만 보인다.
 *
 * ## 이 화면이 존재하는 이유
 *
 * NEOTMS 에는 관리자가 남의 계정을 만들어 주는 화면이 **없다**. `staff` 행은 `lpx_sub`(OIDC
 * subject)이 채워져야 쓸 수 있고 그 값은 남이 알 수 없는 값이므로, 관리자가 만든 행은 이메일이
 * 일치할 때까지 주인 없이 떠 있는 행이 된다. 그래서 신규 직원이 들어오는 경로는 이것 하나다.
 *
 * ## 제출하면 계정이 아니라 **요청**이 만들어진다
 *
 * 서버가 만드는 행은 `role_id` 가 비어 있다(db/009_selfservice.sql). 권한 행렬이 비므로 메뉴를
 * 보는 모든 API 가 여전히 거절한다. 달라지는 것은 `/api/v0/me` 가 `'unregistered'` 대신
 * `'pending'` 을 답하기 시작하는 것뿐이고, 그러면 셸이 이 폼을 승인 대기 안내로 바꾼다.
 *
 * ## 보낼 수 없는 것
 *
 * 역할·열람 범위·사용 여부·`mgr_id`·소속 법인·`lpx_sub`. 앞의 셋은 권한 체계이고 뒤의 셋은
 * 신원이다. 이 폼에 그중 하나라도 입력란이 생기면, 쿠키를 고쳐 역할을 바꿀 수 있었던 레거시의
 * 구멍을 다시 만드는 셈이 된다. 서버의 `SelfProfileSchema` 가 나머지를 전부 버리므로 실제로
 * 뚫리지는 않지만, 폼에 없는 것이 1차 방어선이다.
 *
 * ## 제출 성공 후에 이 컴포넌트는 사라지지 않는다 — 한 번은 더 그려진다
 *
 * `useRegisterSelf` 가 응답으로 받은 `ProfileView` 를 캐시에 바로 심으므로 셸이 다음 렌더에서
 * 대기 화면으로 바꾼다. 그 사이의 한 렌더를 위해 `submitted` 상태로 접수 확인 문구를 보여 준다.
 * 비워 두면 그 한 프레임 동안 방금 제출한 폼이 그대로 보이고, 사용자가 그 순간에 보는 것은
 * "저장이 안 됐다" 다.
 */

/** 폼이 들고 있는 값. 전부 문자열이다 — 입력란에서 나오는 것이 문자열뿐이기 때문이다. */
type FormState = {
  name: string
  nameEng: string
  email: string
  phone: string
  position: string
}

/**
 * 빈 문자열을 null 로 바꿔서 보낸다.
 *
 * 서버의 `settable(...)` 은 `undefined`("건드리지 말 것")와 `null`("비울 것")을 구분하지만,
 * 생성에는 구분할 것이 없다 — 둘 다 결국 NULL 로 저장된다(함수가 `NULLIF(btrim(...), '')` 로
 * 감싼다). 그래도 `''` 를 그대로 보내지 않는 이유는 `mgr_email IS NULL` 로 비교하는 코드가
 * 서버에 있기 때문이다: `''` 로 저장된 행은 그 비교에서 "이메일이 있는 행" 으로 분류되고,
 * 그러면 이메일로 하는 모든 조회가 조용히 틀린다.
 */
const nullIfBlank = (value: string): string | null => {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function SignupView({
  prefill,
  onLogout,
}: {
  prefill: ProfilePrefill
  onLogout: () => void
}) {
  /*
   * 초기값은 LPX `/userInfo` 에서 온 것이고, **이름까지 고칠 수 있다.**
   *
   * 의도적이다. `mgr_name` 은 발주서와 청구서에 찍히는 담당자 이름이고, SSO 계정의 이름이 그
   * 사람이 업무에서 쓰는 이름과 항상 같지는 않다(영문 표기만 등록된 계정, 개명, 사내 통용명).
   * 고칠 수 있게 두는 것이 공식 문서로 보이는 서류와 잘못 보이는 서류의 차이다.
   *
   * `useState` 초기값으로만 쓰므로 prefill 이 뒤늦게 바뀌어도 입력 중인 값을 덮지 않는다 —
   * 프로필 재조회가 사용자가 타이핑하던 이름을 되돌리는 일은 이 앱에서 가장 알아내기 어려운
   * 버그가 될 것이다.
   */
  const [form, setForm] = useState<FormState>({
    name: prefill.name,
    nameEng: '',
    email: prefill.email,
    phone: '',
    position: '',
  })
  const [submitted, setSubmitted] = useState(false)
  const register = useRegisterSelf()

  const set = (key: keyof FormState) => (event: { target: { value: string } }) =>
    setForm((previous) => ({ ...previous, [key]: event.target.value }))

  // 서버의 `v.minLength(1)` 과 같은 조건. 버튼을 잠가서 400 을 한 번 덜 받는다.
  const nameGiven = form.name.trim().length > 0

  const submit = () => {
    if (!nameGiven || register.isPending) return
    const input: SelfProfileInput = {
      name: form.name.trim(),
      nameEng: nullIfBlank(form.nameEng),
      email: nullIfBlank(form.email),
      phone: nullIfBlank(form.phone),
      position: nullIfBlank(form.position),
    }
    register.mutate(input, { onSuccess: () => setSubmitted(true) })
  }

  if (submitted) {
    /*
     * 접수 확인. 위에서 말한 한 렌더를 위한 화면이고, 셸이 대기 화면으로 바꾸기 전까지만 보인다.
     *
     * 대기 화면(`PendingApprovalView`)과 문장이 다르다. 여기는 **방금 일어난 일**을 알리는
     * 자리이고("접수되었습니다"), 그쪽은 **지금 상태**를 설명하는 자리다("검토하고 있습니다").
     * 다시 로그인해서 들어온 사람에게 "접수되었습니다" 라고 하면 방금 한 번 더 신청한 것처럼
     * 읽힌다.
     */
    return (
      <AuthGateCard>
        <div className={`${ui.alert} ${ui.alertSuccess}`} role="status">
          회원가입 요청이 정상적으로 접수되었습니다.
        </div>
        <p className={styles.lead}>
          시스템 관리자님께서 요청을 신속히 검토한 후, 승인 처리를 진행할 예정입니다. 잠시만
          기다려주시면 감사드리겠습니다.
        </p>
      </AuthGateCard>
    )
  }

  return (
    <AuthGateCard wide>
      <p className={styles.lead}>
        TMS 를 처음 사용하는 계정입니다. 아래 정보로 회원가입을 요청하면 관리자 승인 후 사용할 수
        있습니다.
      </p>

      {/*
        폼 요소로 감싼다. `onSubmit` 이 있으면 입력란에서 Enter 를 눌러도 제출되고, 그게 이
        화면에서 사람이 가장 자연스럽게 하는 동작이다. `preventDefault` 가 없으면 브라우저가
        페이지를 다시 불러오면서 방금 받은 토큰을 들고 처음부터 시작한다.
      */}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className={ui.formGrid}>
          <div className={ui.field}>
            <label className={`${ui.label} ${ui.required}`} htmlFor="signup-name">
              이름
            </label>
            <input
              id="signup-name"
              className={ui.input}
              value={form.name}
              onChange={set('name')}
              // 비어 있으면 안 되는 유일한 칸이라 포커스를 여기에 둔다.
              autoFocus
              maxLength={300}
            />
            <span className={ui.hint}>발주서·청구서에 담당자로 표시되는 이름입니다.</span>
          </div>

          <div className={ui.field}>
            <label className={ui.label} htmlFor="signup-name-eng">
              영문 이름
            </label>
            <input
              id="signup-name-eng"
              className={ui.input}
              value={form.nameEng}
              onChange={set('nameEng')}
              maxLength={300}
            />
            <span className={ui.hint}>영문 서류에 쓰입니다. 비워 두어도 됩니다.</span>
          </div>

          <div className={ui.field}>
            <label className={ui.label} htmlFor="signup-email">
              이메일
            </label>
            <input
              id="signup-email"
              className={ui.input}
              type="email"
              value={form.email}
              onChange={set('email')}
              maxLength={300}
            />
          </div>

          <div className={ui.field}>
            <label className={ui.label} htmlFor="signup-phone">
              연락처
            </label>
            <input
              id="signup-phone"
              className={ui.input}
              value={form.phone}
              onChange={set('phone')}
              maxLength={100}
            />
          </div>

          <div className={ui.field}>
            <label className={ui.label} htmlFor="signup-position">
              직위
            </label>
            <input
              id="signup-position"
              className={ui.input}
              value={form.position}
              onChange={set('position')}
              maxLength={100}
            />
          </div>
        </div>

        {/*
          오류를 서버 본문 그대로 보여 준다(`ErrorNotice`). 이 엔드포인트의 거절은 전부 사람이
          읽어야 하는 문장이다 — 409 는 "이미 신청되어 있습니다", 403 은 "비활성화된
          계정입니다" 이고, 둘 다 "실패했습니다" 로 뭉개면 무엇을 해야 하는지 알 수 없다.
        */}
        {register.isError ? <ErrorNotice error={register.error} /> : null}

        <div className={ui.formActions}>
          <button
            type="submit"
            className={`${ui.btn} ${ui.btnPrimary}`}
            disabled={!nameGiven || register.isPending}
          >
            {register.isPending ? '요청 중…' : '회원가입 요청'}
          </button>
        </div>
      </form>

      <div className={styles.altActions}>
        {/* 다른 계정으로 신청해야 하는 경우가 실제로 있다 — 개인 계정으로 먼저 로그인된 상태. */}
        <button type="button" className={styles.linkButton} onClick={onLogout}>
          다른 계정으로 로그인
        </button>
      </div>
    </AuthGateCard>
  )
}
