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
  // 발주
  발주: INFO,
  수락: INFO,
  납품: OK,
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
