import { JOB_STATE_WAITING } from '@/apis/neotms.codes'
import type { JobInput, JobRow } from '@/apis/neotms.types'

/**
 * 작업 한 건을 복제할 때 보낼 등록 본문.
 *
 * ## 규칙 하나: **일과 값은 베끼고, 그 일에 일어난 사건은 베끼지 않는다**
 *
 * 복제가 필요한 이유는 "같은 고객사, 같은 언어쌍, 같은 단가의 작업이 매주 들어온다" 다. 그래서
 * 일을 설명하는 것(이름·업무 구분·언어·분류·물량·단가·통화·납기)과 값을 정하는 것은 전부
 * 그대로 간다.
 *
 * 되돌리는 것은 **진행 상태**다. '검수' 까지 간 작업을 복제했는데 새 작업이 '검수' 로 태어나면,
 * 아무도 손대지 않은 일이 검수 대기 목록에 섞인다. 그 목록을 보는 사람은 그게 복제된 빈
 * 작업인지 알 방법이 없고, 통과시키면 매출이 두 번 잡힌다.
 *
 * ## 코드는 보내지 않는다 — 보낼 수가 없다
 *
 * `JobInput` 에 `jobCode` 가 없다. 서버가 민든다. 복제 기능이 성립하는 이유가 그것이다 — 코드를
 * 받는 입력이었다면 복제는 중복 코드를 만드는 장치였을 것이다.
 *
 * ## 금액 세 칸을 그대로 보내는 것이 맞다
 *
 * `jobPriceSum`·`jobPriceKsum` 은 손으로 조정된 값일 수 있고(JobFormModal 머리말), 서버는 받은
 * 값을 그대로 저장한다. 복제의 요점이 "같은 금액" 이므로 다시 계산하지 않고 넘긴다.
 *
 * `coinRate` 도 그대로다. 이 값은 환율이 아니라 **환전되었는지**를 뜻하는 정산 플래그이고
 * (`JobRow.coinRate`), 원본이 정산된 작업이면 그 원화 금액은 이미 고정된 사실이다. 여기서
 * null 로 비우면 복제본의 원화 금액이 오늘 환율로 매일 움직이기 시작한다 — 같은 금액이 아니다.
 *
 * ## 이름을 그대로 두는 것은 의도다
 *
 * '(사본)' 을 붙이지 않는다. 복제의 목적이 같은 내용이고, 이름은 표에서 두 번 눌러 바로 고칠 수
 * 있다(ProjectDetailView). 접미사를 붙이면 열 건을 복제한 담당자는 열 번 지워야 한다.
 */
export function duplicateJobInput(row: JobRow): JobInput {
  return {
    projectId: row.projectId,
    // 서버 스키마에서 이름은 필수다. 원본이 비어 있으면 코드를 대신 쓴다 — 빈 이름으로는
    // 저장이 거절되고, 거절의 이유가 '원본에도 이름이 없었다' 임을 화면이 설명할 수 없다.
    jobName: row.jobName || row.jobCode,
    workCode: row.workCode,
    jobPmId: row.jobPmId,
    /*
     * 업무 구분과 그에 딸린 값들. 언어쌍과 업무 분류를 **둘 다** 그대로 넘기는 것이 안전한
     * 이유는, 원본이 서버에서 온 행이라는 점이다 — 서버의 제약 조건(db/011_job_types.sql)이
     * 이미 한쪽만 채워져 있음을 보증하므로, 베낀 쌍도 어긋날 수 없다.
     */
    jobType: row.jobType,
    jobSlang: row.jobSlang,
    jobElang: row.jobElang,
    jobCategory: row.jobCategory,
    jobVolume: row.jobVolume,
    unitCode: row.unitCode,
    jobPriceSel: row.jobPriceSel,
    jobPrice: row.jobPrice,
    jobPriceDis: row.jobPriceDis,
    coinCode: row.coinCode,
    coinRate: row.coinRate,
    jobPriceSum: row.jobPriceSum,
    jobPriceKsum: row.jobPriceKsum,
    jobSday: row.jobSday,
    jobSdayTime: row.jobSdayTime,
    jobEday: row.jobEday,
    jobEdayTime: row.jobEdayTime,
    jobMemo: row.jobMemo,
    /* 되돌리는 유일한 칸. 위 "규칙 하나" 참고. */
    jobState: JOB_STATE_WAITING,
  }
}
