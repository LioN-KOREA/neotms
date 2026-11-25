// SPDX-License-Identifier: MIT
//
// The handover-mail endpoint. Reads one project, folds it into the form, and sends it to the
// operating PM from the SENDER'S OWN Hiworks account.
//
// ## This endpoint grants no authority that did not already exist
//
// The route being `PROJECT:read` looks wrong for something that sends mail. But everything leaving
// this server is a value the caller can ALREADY read on screen, and the project passes the same row
// scope a GET of it does - so a project that is not theirs cannot even be composed into a mail. And
// the mail goes out through the caller's OWN Hiworks account: there is no shared company sender, so
// all this does is perform, on their behalf, something they could do by signing in to Hiworks
// directly.
//
// What it replaces makes that clearer still. The requirements document's original design was "copy
// to the clipboard, paste into the Hiworks compose window". The authority that needed was being
// able to look at the screen.
//
// ## The credentials only pass through
//
// `hiworksId` and `hiworksPassword` arrive in the body, go to `hiworksLogin`, and that is the end
// of them. Not stored, not logged, not returned. `parseBody` reporting only field NAMES and never
// values on a 400 (see the comment in NeotmsResult) is the same rule, which is why a password that
// fails validation does not reach a log aggregator either.
//
// ## Known limit: there is no timeout on the Hiworks side
//
// One mail costs five sequential Hiworks calls - sign in, list senders, fetch the cert key,
// pre-check, send. Healthy that is one or two seconds, but if Hiworks stops answering this function
// waits until Lambda's 29-second ceiling and API Gateway cuts in with a 504. At that point the user
// cannot tell whether the mail went, because the cut may have come after the send. Fixing it means
// attaching an AbortSignal to each fetch in `HiworksClient`, which changes that file's signatures,
// so it has been left alone. The mitigation available now is that sending also saves (
// `is_save: true`) - the sent-items folder can be opened afterwards to check.

import { pgQuery } from "../../utils/PostgresUtils.js";
import type { NeotmsCaller } from "../../auth/NeotmsAuthGuard.js";
import type { ResponseData } from "../../reqres/RequestResponse.js";
import { notFound, ok, runDb } from "../NeotmsResult.js";
import { ProjectGetOps } from "../projects/NeotmsProject.dbops.js";
import type { HandoverMailSend } from "../neotms.schemas.js";
import { hiworksLogin, hiworksSendEmail } from "./HiworksClient.js";
import { resolveHiworksCredentials } from "../hiworks/NeotmsHiworksManager.js";
import { HandoverJobsOps } from "./NeotmsHandover.dbops.js";
import { composeHandoverMail } from "./NeotmsHandoverMail.js";

/** What the screen shows the user afterwards. The body is not returned - nothing would use it. */
export type HandoverMailSent = { subject: string; recipient: string };

/**
 * One handover mail.
 *
 * The call order IS the authorization. The project is read first, THROUGH ITS SCOPE, and a project
 * that is not visible ends the request with a 404 - only then are the jobs read (which is why
 * `HandoverJobsOps` may omit a scope clause of its own), and only then is anything signed in to.
 * Trying the credentials first and checking the permission afterwards would hand somebody guessing
 * at project ids two facts instead of none: that the Hiworks sign-in worked, and that the project
 * does not exist.
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
      note: input.note,
    });

    /*
     * Typed in the dialog, or stored on 내 정보 - one resolver decides, shared with the PO request
     * mail so the precedence cannot differ between the two screens (neotms/hiworks/). It answers
     * with the response to send when there is nothing usable, which is a 400 naming what to do
     * rather than a sign-in attempt with an empty password.
     */
    const credentials = await resolveHiworksCredentials(caller, input);
    if (!credentials.ok) return credentials.response;

    const login = await hiworksLogin(credentials.credentials.id, credentials.credentials.password);
    if (!login.result) {
      /*
       * Two different failures, told apart. Hiworks sometimes answers a wrong password with a 200
       * that simply carries no session cookie (`hiworksLogin` turns that into a 500), so the
       * status code alone cannot separate "the password is wrong" from "we cannot reach Hiworks".
       * Treat 200 and 4xx as a credential problem and everything else as a Hiworks-side one - the
       * user's next action differs between them (type it again, or wait and retry).
       */
      const credentialProblem = login.status === 200 || (login.status >= 400 && login.status < 500);
      return credentialProblem
        ? {
            status: 400,
            body: "Failed to log into Hiworks. Please check your credentials, and try again",
          }
        : {
            status: 502,
            body: "Unable to connect to the Hiworks APIs. Please try again later",
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
      // The status code goes into the sentence. Sending can fail at any of five calls, and the
      // number is what lets an operator separate cases like "signed in, but the sender list came
      // back empty" from a refusal of the message itself.
      return {
        status: 502,
        body: `The E-mail send request was rejected by Hiworks server (HTTP ${sent.status}).`,
      };
    }

    return ok({ subject: mail.subject, recipient: input.recipient });
  });
}
