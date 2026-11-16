// SPDX-License-Identifier: MIT
//
// 인계메일 엔드포인트. 프로젝트 하나를 읽어 양식으로 접고, 보낸 사람 자신의 Hiworks 계정으로
// 운영 PM 에게 보낸다.
//
// ## 이 엔드포인트가 새로 주는 권한은 없다
//
// 라우트가 `PROJECT:read` 인 것이 의아해 보일 수 있다 - 메일을 보내는 일인데 읽기 권한이다. 하지만
// 여기서 바깥으로 나가는 것은 **호출자가 이미 화면에서 읽을 수 있는 값들뿐**이고, 프로젝트는
// `ProjectGetOps` 의 행 범위를 그대로 통과한 것이다. 즉 자기 프로젝트가 아니면 메일을 만들 수조차
// 없다. 그리고 메일은 호출자 **자신의** Hiworks 계정에서 나간다 - 회사 공용 발신 계정이 없으므로,
// 이 엔드포인트는 그 사람이 Hiworks 에 직접 로그인해 할 수 있는 일을 대신해 줄 뿐이다.
//
// 이것이 대체하는 것이 무엇인지 보면 더 분명하다. 요구사항 문서의 원래 설계는 "클립보드로 복사해서
// 하이웍스 메일 쓰기란에 붙여넣기" 였다. 그 동작의 권한은 화면을 볼 수 있다는 것뿐이었다.
//
// ## 자격증명은 지나갈 뿐이다
//
// `hiworksId` 와 `hiworksPassword` 는 본문으로 받아 `hiworksLogin` 에 넘기고 그걸로 끝이다.
// 저장하지 않고, 로그에 쓰지 않고, 응답에 담지 않는다. `parseBody` 의 400 메시지가 필드 **이름만**
// 적고 값을 적지 않는 것도 같은 이유이고(NeotmsResult 의 주석), 그래서 비밀번호가 검증에 걸려도
// 로그 수집기로 새지 않는다.
//
// ## 알려진 한계: Hiworks 쪽 타임아웃이 없다
//
// 한 통을 보내는 데 Hiworks 호출이 다섯 번 연달아 일어난다(로그인 → 발신자 목록 → 인증키 →
// 사전검사 → 전송). 정상일 때는 1~2초지만, Hiworks 가 응답하지 않으면 이 함수는 Lambda 의 29초
// 상한까지 기다리고 API Gateway 가 504 로 끊는다. 그때 사용자는 메일이 나갔는지 알 수 없다 -
// 보낸 뒤에 끊겼을 수도 있기 때문이다. 고치려면 `HiworksClient` 의 각 fetch 에 AbortSignal 을
// 달아야 하고, 그건 그 파일의 서명을 바꾸는 일이라 지금은 하지 않았다. 당장의 완화책은 전송이
// 저장까지 하도록(`is_save: true`) 되어 있다는 것 - 끊긴 뒤에도 보낸메일함을 열어 확인할 수 있다.

import { pgQuery } from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { notFound, ok, runDb } from "../NeotmsResult.js";
import { ProjectGetOps } from "../projects/NeotmsProject.dbops.js";
import type { HandoverMailSend } from "../neotms.schemas.js";
import { hiworksLogin, hiworksSendEmail } from "./HiworksClient.js";
import { HandoverJobsOps } from "./NeotmsHandover.dbops.js";
import { composeHandoverMail } from "./NeotmsHandoverMail.js";

/** 보낸 뒤 화면이 사용자에게 보여 줄 것. 본문은 돌려주지 않는다 - 화면이 쓸 데가 없다. */
export type HandoverMailSent = { subject: string; recipient: string };

/**
 * 인계메일 한 통.
 *
 * 순서가 곧 권한 검사다. 프로젝트를 **범위 안에서** 먼저 읽고, 보이지 않으면 404 로 끝난다 -
 * 그 뒤에야 작업을 읽고(`HandoverJobsOps` 가 범위 절을 생략해도 되는 이유), 그 뒤에야 로그인한다.
 * 자격증명을 먼저 써 보고 권한을 나중에 보면, 남의 프로젝트 번호를 찍어 본 사람에게 "하이웍스
 * 로그인은 됐는데 프로젝트가 없다" 는 두 가지 정보를 주게 된다.
 */
export async function sendHandoverMail(
  caller: NeotmsCaller,
  projectId: string,
  input: HandoverMailSend,
): Promise<ResponseData<HandoverMailSent | string>> {
  return runDb("send handover mail", async () => {
    const project = (await pgQuery(ProjectGetOps(caller, projectId))).data;
    if (!project) return notFound("project");

    const jobs = (await pgQuery(HandoverJobsOps(projectId))).data;
    const mail = composeHandoverMail(project, jobs, {
      formats: input.formats,
      layouts: input.layouts,
    });

    const login = await hiworksLogin(input.hiworksId, input.hiworksPassword);
    if (!login.result) {
      /*
       * 로그인 실패를 두 가지로 가른다. Hiworks 는 비밀번호가 틀려도 200 을 주면서 세션 쿠키만
       * 빼는 경우가 있어서(`hiworksLogin` 이 그때 500 을 만든다), 상태 코드만으로는 "틀렸다" 와
       * "연결이 안 된다" 가 구분되지 않는다. 그래서 200 과 4xx 는 자격증명 문제로, 나머지는
       * 하이웍스 쪽 문제로 읽는다 - 사용자가 할 일이 각각 다르기 때문이다(다시 입력 / 잠시 후).
       */
      const credentialProblem = login.status === 200 || (login.status >= 400 && login.status < 500);
      return credentialProblem
        ? {
            status: 400,
            body: "하이웍스 로그인에 실패했습니다. ID 와 비밀번호를 확인해 주세요.",
          }
        : {
            status: 502,
            body: "하이웍스에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
          };
    }

    const sent = await hiworksSendEmail(
      login.result,
      [input.recipient],
      [],
      [],
      mail.subject,
      mail.html,
    );
    if (sent.status !== 200) {
      // 상태 코드를 문장에 넣는다. 전송 단계는 다섯 번의 호출 중 어디서든 실패할 수 있고, 숫자가
      // 있어야 운영자가 "로그인은 됐는데 발신자 목록이 비어 있다" 같은 경우를 구분해 낼 수 있다.
      return {
        status: 502,
        body: `하이웍스가 메일 전송을 거절했습니다 (HTTP ${sent.status}). 하이웍스에서 직접 보내 주세요.`,
      };
    }

    return ok({ subject: mail.subject, recipient: input.recipient });
  });
}
