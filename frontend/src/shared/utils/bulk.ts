/**
 * 선택한 여러 건에 같은 작업을 돌린다.
 *
 * ## 순차다. 병렬이 아니다
 *
 * `Promise.all` 로 열 건을 한꺼번에 보내면 두 가지가 동시에 터진다.
 *
 * 첫째, **커넥션**이다. 이 시스템의 PostgreSQL 커넥션 예산은 40 이고 람다가 Supavisor 를 통해
 * 공유한다. 서른 건 선택이 흔한 조작이므로, 그걸 동시에 보내는 것은 한 담당자의 클릭 한 번으로
 * 예산을 다 쓰는 일이다 — 그 순간 다른 모든 화면이 커넥션을 못 받는다.
 *
 * 둘째, **무효화 폭풍**이다. 작업·발주 수정은 다섯 종류 이상의 질의 키를 무효화한다
 * (neotms.mutation.ts 의 `JOB_AFFECTS`). 열 건이 동시에 끝나면 그 무효화가 열 번 겹쳐 들어오고,
 * 목록·프로젝트·리포트·대시보드를 각각 다시 읽는 요청이 쏟아진다. 결과적으로 쓰기 열 번이
 * 읽기 수십 번을 만든다.
 *
 * 순차로 돌리면 둘 다 없다. 느리지만, 이 조작의 체감 시간은 사람이 확인 대화상자를 읽는 시간에
 * 묻힌다.
 *
 * ## 실패를 멈추지 않는다 — **부분 실패가 정상 동작이다**
 *
 * 작업 삭제는 발주가 달려 있으면 서버가 거절한다. 열 건 중 셋이 그런 경우는 이상한 상황이 아니라
 * 흔한 상황이다. 거기서 전체를 중단하면 (a) 지울 수 있었던 일곱 건이 남고 (b) 다시 눌러도 같은
 * 자리에서 멈춘다. 그래서 끝까지 돌고, **몇 건이 되고 몇 건이 안 됐는지를 세어서 돌려준다.**
 *
 * 요약을 정직하게 적는 것이 이 함수의 존재 이유다. "삭제했습니다" 만 띄우고 세 건이 남아 있으면
 * 담당자는 목록을 새로고침해서야 그 사실을 발견하고, 그때는 이유를 알 수 없다.
 */
export interface BulkResult {
  /** 성공한 건수. */
  ok: number
  /** 실패한 건수. */
  failed: number
  /**
   * 첫 번째 실패의 오류. 화면이 `ErrorNotice` 로 그대로 내보낸다.
   *
   * 전부 모으지 않고 첫 건만 남긴다. 같은 이유로 실패하는 경우가 대부분이고(발주가 달림),
   * 같은 문장 여덟 개는 한 개보다 읽히지 않는다.
   */
  firstError: unknown
}

export async function runSequential<T>(
  items: readonly T[],
  run: (item: T) => Promise<unknown>,
): Promise<BulkResult> {
  let ok = 0
  let failed = 0
  let firstError: unknown = null

  for (const item of items) {
    try {
      await run(item)
      ok += 1
    } catch (error) {
      failed += 1
      if (firstError === null) firstError = error
    }
  }

  return { ok, failed, firstError }
}

/**
 * 일괄 작업의 결과를 한 문장으로.
 *
 * 전부 성공했을 때도 건수를 적는다 — 선택한 수와 처리된 수가 같다는 확인이 그 문장의 요점이다.
 */
export function describeBulk(result: BulkResult, total: number, verb: string): string {
  if (result.failed === 0) return `${total}건을 ${verb}했습니다.`
  return `${total}건 중 ${result.ok}건을 ${verb}했습니다. ${result.failed}건은 실패했습니다.`
}
