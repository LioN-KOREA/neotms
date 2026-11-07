import styles from './StatusChip.module.css'

/**
 * 상태값 하나를 칩으로 그린다.
 *
 * ## 색을 고르는 책임을 화면에서 가져왔다
 *
 * 이전에는 화면마다 삼항 연산자로 색을 골랐다:
 *
 * ```tsx
 * <span className={`${ui.badge} ${row.prjMoneyState === '정산완료' ? ui.badgeSuccess : ''}`}>
 * ```
 *
 * 그 방식의 비용은 색 하나를 추가할 때 드러난다 — 같은 '정산완료' 가 프로젝트 목록·발주 목록·
 * 프로젝트 상세의 세 곳에 따로 적혀 있고, 한 곳만 고치면 같은 값이 화면에 따라 다른 색으로
 * 나온다. 담당자는 그걸 "발주 쪽은 정산이 안 끝난 것" 으로 읽는다. 아래 `TONES` 표 하나가
 * 그 판단을 들고 있으면 그런 상태가 만들어지지 않는다.
 *
 * ## 모르는 값도 반드시 그려야 한다
 *
 * 이 컬럼들은 코드 테이블이 없는 자유 입력이고(`neotms.codes.ts` 의 "전부 잠정" 주석), 레거시
 * 데이터에는 여기 없는 값이 들어 있다. 그래서 표에 없는 값은 **중립색으로 그대로 보여 준다** —
 * 숨기거나 '기타' 로 바꾸면 그 행의 진짜 상태가 화면에서 사라지고, 사라진 줄도 모른다.
 */

/** 칩의 색과 점 모양. `open` 은 "아직 할 일이 남았다" 는 뜻이고, 색과 무관한 두 번째 축이다. */
interface Tone {
  readonly cls: string
  readonly open: boolean
}

const PROG: Tone = { cls: styles.prog, open: true }
const OK: Tone = { cls: styles.ok, open: false }
const INFO: Tone = { cls: styles.info, open: true }
const WAIT: Tone = { cls: styles.wait, open: true }
const WARN: Tone = { cls: styles.warn, open: true }
const OFF: Tone = { cls: styles.off, open: false }

/*
 * 값 → 색.
 *
 * 키는 `neotms.codes.ts` 의 다섯 목록(PROJECT_STATES, JOB_STATES, PO_STATES, INVOICE_STATES,
 * MONEY_STATES)에 있는 값 전부다. 겹치는 글자가 있지만 뜻이 충돌하지는 않는다 — '보류' 는
 * 프로젝트에서도 세금계산서에서도 "멈춰 있다" 이고, '완료' 는 어디서나 끝난 것이다. 그래서
 * 컬럼별로 표를 나누지 않았다. 나중에 한 글자가 두 뜻을 갖게 되면 그때 나눠야 한다.
 *
 * ## 설계안과 다른 한 곳
 *
 * 설계안의 팔레트는 '진행' 을 초록(Success)으로 적는다. 여기서는 인디고다. 설계안의 상태
 * 집합에는 '완료' 가 없어서 진행이 곧 건강한 끝 상태였지만, 이 시스템에는 둘 다 있다 —
 * 진행과 완료를 같은 초록으로 두면 목록에서 "지금 해야 할 일" 과 "끝난 일" 이 구분되지 않고,
 * 이 화면을 여는 가장 흔한 이유가 정확히 그 구분이다.
 */
const TONES: Readonly<Record<string, Tone>> = {
  // 프로젝트
  견적: INFO,
  진행: PROG,
  완료: OK,
  보류: WAIT,
  취소: OFF,
  // 작업
  대기: WAIT,
  검수: INFO,
  /*
   * 발주.
   *
   * '납품' 이 `OK`(초록, 채운 점)였다가 `WARN`(주황, 빈 점)으로 바뀌었다. 뜻이 바뀐 것이 아니라
   * 전에 잘못 적혀 있었다 — 납품은 **일이 끝났고 돈은 아직**인 칸이고(NeotmsPoStates.ts), 일부만
   * 지급된 발주가 머무는 칸이기도 하다. 초록 + 채운 점은 "끝난 일" 이라는 뜻이어서, 번역가에게
   * 줄 돈이 남은 행이 목록에서 정산 끝난 행과 똑같이 보였다. `.warn` 의 주석이 말하는 "끝나지
   * 않은 채로 잊히는 것이 실제로 손실이 되는 유일한 상태" 가 바로 이 칸이다.
   *
   * '미승인' 은 레거시 '발주'·'수락' 을 대신하며 색은 그대로 `INFO` 다 — `.info` 의 설명("흘러가는
   * 중이지만 아직 '진행' 은 아닌 것")이 그대로 맞는다. 승인되지 않았다는 사실 자체는 이 칩이
   * 아니라 결제 화면의 승인 배지가 말한다. 모든 새 발주가 이 칸에서 시작하므로, 여기에 경고색을
   * 쓰면 목록의 절반이 주황이 되고 주황은 아무 뜻도 전하지 않게 된다.
   */
  미승인: INFO,
  납품: WARN,
  // 세금계산서
  미발행: WAIT,
  발행: OK,
  // 입·출금
  미정산: WARN,
  부분정산: WARN,
  정산완료: OK,
}

interface Props {
  /** `row.prjState` 처럼 서버에서 온 값 그대로. 비어 있어도 된다. */
  value: string | null | undefined
}

export function StatusChip({ value }: Props) {
  const label = value?.trim()

  /*
   * 값이 없으면 칩이 아니라 줄표 하나.
   *
   * `aria-label` 을 붙인 이유는 `-` 한 글자가 스크린 리더에서 "하이픈" 으로 읽히기 때문이다.
   * 표 안에서 그 소리는 아무 뜻도 전하지 않는다.
   */
  if (!label) {
    return (
      <span className={styles.none} aria-label="상태 없음">
        –
      </span>
    )
  }

  const tone = TONES[label] ?? WAIT

  return (
    <span className={`${styles.chip} ${tone.cls}`}>
      <span className={`${styles.dot} ${tone.open ? styles.dotOpen : ''}`} aria-hidden="true" />
      {label}
    </span>
  )
}

/**
 * 쓰이는지 / 안 쓰이는지 하나를 칩으로 그린다 — 고객사·번역가의 '거래 중', 계정·코드의 '사용 중'.
 *
 * ## 왜 `StatusChip` 과 따로인가
 *
 * 위의 `TONES` 표는 **서버에서 온 문자열**을 키로 받는다. 여기서 다루는 값은 `active` 불리언이고,
 * 화면에 적히는 '거래 중' / '사용 중' 은 그 불리언을 사람 말로 옮긴 **라벨**이다. 그 라벨을
 * `TONES` 에 키로 넣으면, 나중에 누가 문구를 '거래중'(공백 없이)으로 고치는 순간 색이 조용히
 * 중립으로 떨어진다 — 표에서 키를 못 찾은 것이고, 화면에는 아무 오류도 안 뜬다.
 *
 * 라벨을 받는 이유는 같은 불리언이 화면마다 다른 말로 불리기 때문이다(고객사는 '거래', 계정은
 * '사용'). 색만 여기서 정하고 말은 부르는 쪽이 고른다.
 *
 * ## 꺼진 쪽을 빨강으로 칠하지 않는다
 *
 * 거래가 끝난 고객사도, 중지된 코드도 담당자가 **의도한** 상태다. 경고색을 쓰면 목록을 훑을 때
 * 눈이 거기로 먼저 가고, 정작 봐야 하는 '미정산' 이 묻힌다.
 */
export function ActiveChip({ active, on, off }: { active: boolean; on: string; off: string }) {
  return active ? (
    <span className={`${styles.chip} ${styles.ok}`}>
      <span className={styles.dot} aria-hidden="true" />
      {on}
    </span>
  ) : (
    <span className={`${styles.chip} ${styles.off}`}>
      <span className={styles.dot} aria-hidden="true" />
      {off}
    </span>
  )
}

/**
 * 발주 금액의 승인 여부 — `purchase_order.po_approved` 하나를 칩으로.
 *
 * ## `ActiveChip` 을 쓰지 않는 이유는 위 주석이 직접 말하고 있다
 *
 * `ActiveChip` 이 꺼진 쪽을 중립색으로 칠하는 근거는 "**담당자가 의도한** 상태" 다. 거래가 끝난
 * 고객사도 중지된 코드도 그렇게 되기로 정해진 것이라, 경고색을 쓰면 정작 봐야 할 '미정산' 이
 * 묻힌다.
 *
 * 미승인 발주는 그 반대다. **아무도 그렇게 되기로 정하지 않았다** — 승인할 사람이 아직 보지
 * 않았다는 뜻이고, 이 화면이 존재하는 이유가 바로 그 목록이다. 그래서 꺼진 쪽이 `.warn` 이고
 * 점이 비어 있다(`.dotOpen` = "아직 할 일이 남았다"). `ActiveChip` 에 플래그를 하나 더 받는
 * 쪽은 택하지 않았다: 두 컴포넌트가 갈라지는 지점은 색이 아니라 **꺼짐이 무슨 뜻인가**이고,
 * 그 질문에 두 답을 가진 하나의 컴포넌트는 부르는 쪽에서 매번 다시 판단해야 한다.
 *
 * 켜진 쪽은 `ActiveChip` 과 같은 `.ok` 다. 승인은 끝난 일이다.
 *
 * ## 꺼진 쪽의 말이 '미승인' 이 아니라 '승인 대기' 다
 *
 * '미승인' 은 **`po_state` 의 값이기도 하다**(위 `TONES` 에 `INFO` 로 들어 있다). 두 칩이 한
 * 행에 나란히 서는 화면이므로, 같은 글자가 파란 칩과 주황 칩으로 두 번 나오면 읽는 사람은 둘
 * 중 하나가 고장 났다고 생각한다. 두 값은 실제로 서로 독립이고 — 승인된 채 '미승인' 상태로
 * 있는 발주가 정상이다(NeotmsPoStates.ts) — 그 독립성을 말로 드러내는 쪽이 맞다.
 */
export function ApprovalChip({ approved }: { approved: boolean }) {
  return approved ? (
    <span className={`${styles.chip} ${styles.ok}`}>
      <span className={styles.dot} aria-hidden="true" />
      승인
    </span>
  ) : (
    <span className={`${styles.chip} ${styles.warn}`}>
      <span className={`${styles.dot} ${styles.dotOpen}`} aria-hidden="true" />
      승인 대기
    </span>
  )
}

/**
 * 작업 종류 태그 — 번역 / 감수 / 편집 / DTP / 감리 / 기타.
 *
 * 상태 칩과 모양을 나눈 이유는 무게다. 작업 목록의 한 행에는 상태 칩과 이 태그가 같이 서는데,
 * 둘이 같은 무게면 어느 쪽이 "지금 해야 할 일인가" 를 말하는지 알 수 없다. 작업 종류는
 * 걸러낼 때(필터) 쓰는 값이고 훑을 때 쓰는 값이 아니므로 더 조용해야 한다.
 *
 * 값은 `sys_code` 의 WORK 도메인에서 오므로 여기 적힌 '번역' 외의 값이 얼마든지 올 수 있다 —
 * 유지보수 화면에서 추가할 수 있기 때문이다. 그래서 강조는 '번역' 하나뿐이고 나머지는 전부
 * 같은 중립색이다. 종류마다 색을 배정하면 새 종류가 추가될 때 색이 없는 종류가 생긴다.
 */
export function KindTag({ value }: Props) {
  const label = value?.trim()
  if (!label) {
    return (
      <span className={styles.none} aria-label="종류 없음">
        –
      </span>
    )
  }
  return (
    <span className={`${styles.kind} ${label === '번역' ? styles.kindMain : ''}`}>{label}</span>
  )
}
