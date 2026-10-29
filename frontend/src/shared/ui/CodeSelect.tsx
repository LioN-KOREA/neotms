import { CODE_DOMAIN_LABELS, type CodeDomainId } from '@/apis/neotms.codes'
import { useCodeOptions } from '@/apis/queries/neotms.query'
import ui from '@/shared/ui/ui.module.css'

interface Props {
  /** `<label htmlFor>` 와 맞춘다. 라벨 없이 쓰는 자리에서는 생략하고 `ariaLabel` 을 준다. */
  id?: string
  /** 보이는 라벨이 없을 때. 둘 중 하나는 반드시 있어야 한다 — 없으면 읽히지 않는 입력란이다. */
  ariaLabel?: string
  domain: CodeDomainId
  /** 현재 값. 빈 문자열이 "선택 없음" 이다 — null 을 쓰지 않는 이유는 아래 주석에 있다. */
  value: string
  onChange: (value: string) => void
  /**
   * '선택 없음' 항목의 라벨. `null` 을 주면 그 항목이 **없어진다.**
   *
   * 필수 입력인 자리에서만 null 을 쓴다(작업의 작업 종류·단가 단위). 나머지는 비워 둘 수 있어야
   * 한다 — 분야를 모르는 고객사를 등록하지 못하게 만들면, 담당자는 아무 분야나 골라서 저장한다.
   */
  placeholder?: string | null
  disabled?: boolean
  /** 드롭다운 아래에 덧붙일 설명. 비어 있음 경고가 있으면 그쪽이 우선한다. */
  hint?: string
  /**
   * 설명·경고를 그리지 않는다. 가로로 배치된 자리(물량 + 단위)에서만 쓴다 — 거기서는 아래가
   * 아니라 **옆**에 글이 붙어서 입력란을 밀어낸다.
   *
   * 끄고도 괜찮은 자리인지 판단이 필요하다: 작업 종류와 단가 단위는 목록이 비어도 하드코딩
   * 대비책이 있으므로 경고가 뜰 일이 없다(neotms.codes.ts 의 `codesToOptions`). 분야·언어는
   * 비면 정말 비어 있으므로 경고를 끄면 안 된다.
   */
  silent?: boolean
}

/**
 * `sys_code` 한 도메인을 고르는 드롭다운.
 *
 * ## 자유 입력란을 대체한다
 *
 * 이 컴포넌트가 생긴 이유는 편의가 아니다. 22개 컬럼이 `sys_code (code)` 를 외래키로 참조하는데
 * 화면은 그 값들을 **자유 입력**으로 받고 있었고, 그래서 담당자가 '번역분야아님' 같은 값을 넣고
 * 저장을 누르면 PostgreSQL 이 `customer_cus_field_fkey` 를 거론하는 오류를 냈다. 그 오류에는
 * 담당자가 무엇을 입력해야 하는지가 적혀 있지 않았고, 애초에 `sys_code` 가 비어 있었으므로
 * **어떤 값을 넣어도 저장되지 않았다.** 고를 수 있는 것만 보여 주는 것이 유일한 해결이다.
 *
 * ## 모든 폼이 같은 하나의 요청을 공유한다
 *
 * 내부에서 `useCodeOptions` → `useCodes` 를 쓰고, 다섯 도메인이 한 응답에 함께 온다. 그래서 한
 * 모달에 이 컴포넌트가 네 개 있어도 요청은 하나다 — react-query 가 같은 키의 동시 요청을
 * 합치고, 30분 동안 캐시한다. 도메인별로 받아 오는 설계였다면 모달 하나가 왕복 네 번이 되고,
 * 그 네 번이 각각 Supavisor 커넥션을 하나씩 가져간다.
 *
 * ## 목록이 비면 그 사실을 적는다
 *
 * 씨드(db/007_codes.sql)를 적용하지 않은 환경에서는 고를 것이 없다. 그때 빈 드롭다운만 보여
 * 주면 화면이 고장난 것으로 읽히므로, 무엇을 해야 하는지 — 유지보수 화면에서 코드를 등록하라고 —
 * 적어 둔다.
 */
export function CodeSelect({
  id,
  ariaLabel,
  domain,
  value,
  onChange,
  placeholder = '선택 없음',
  disabled,
  hint,
  silent,
}: Props) {
  const { options, isEmpty, isLoading } = useCodeOptions(domain, value)
  const label = CODE_DOMAIN_LABELS[domain]

  return (
    <>
      <select
        id={id}
        aria-label={ariaLabel}
        className={ui.select}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || isLoading}
      >
        {/*
         * 로딩 중에도 현재 값은 유지된다 — `useCodeOptions` 가 목록에 없는 현재 값을 끼워
         * 넣으므로, 코드 목록이 도착하기 전에 수정 모달이 열려도 값이 첫 항목으로 튀지 않는다.
         */}
        {placeholder !== null ? <option value="">{placeholder}</option> : null}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {silent ? null : isEmpty && !isLoading ? (
        <span className={ui.hintWarn}>
          등록된 {label} 코드가 없습니다. 유지보수 화면에서 먼저 코드를 등록해 주십시오.
        </span>
      ) : hint ? (
        <span className={ui.hint}>{hint}</span>
      ) : null}
    </>
  )
}
