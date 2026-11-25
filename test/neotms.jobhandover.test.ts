/**
 * 프로젝트 '인계' (2026-11-25): 작업 선택 → 인계정보 입력 → 인계 / 인계·발송.
 * 비고 글 만들기, 재인계 비고 덧붙이기, 메일의 직접 입력 줄과 작업별 납기, 메일 칩 해석, 시트 기본 꾸밈.
 */
import { describe, expect, it } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import {
  appendRehandoverRemark,
  bracketEmails,
  composeHandoverRemark,
} from "../lambdas/neotms/nodejs/neotms/handover/handoverRemark";
import { composeHandoverMail } from "../lambdas/neotms/nodejs/neotms/handover/NeotmsHandoverMail";
import { JobHandoverSchema } from "../lambdas/neotms/nodejs/neotms/neotms.schemas";
import { parseEmailChip, parseEmailList } from "../frontend/src/shared/ui/emailChipParse";
import { DEFAULT_COLUMN_STYLES } from "../frontend/src/features/pmsheet/columnDefaults";
import { handoverStamp, latestHandoverByJob, tidyNumber } from "../frontend/src/features/projects/handoverState";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...p: string[]) => readFileSync(path.join(root, ...p), "utf8");

describe("handover remark — what lands in the PM's 비고 cell", () => {
  it("first line is formats / layouts, typed text included", () => {
    expect(
      composeHandoverRemark({ formats: ["WORD", "HWP"], formatText: "", layouts: ["보기좋게"], layoutText: "원본 유지" }),
    ).toBe("* WORD, HWP / 보기좋게, 원본 유지");
    expect(composeHandoverRemark({ formats: [], formatText: "PDF", layouts: ["DTP"] })).toBe("* PDF / DTP");
  });

  it("each note line becomes a '*' item, blank lines go, emails get <> and no '*'", () => {
    const note = "분량 3,000단어\n\n  - 납품처 확인 바랍니다  \nabc@lion-korea.com\n담당: kim@x.co.kr 에게\n<b@y.com>, c@z.com\n";
    expect(composeHandoverRemark({ formats: ["WORD"], layouts: ["DTP"], note })).toBe(
      [
        "* WORD / DTP",
        "* 분량 3,000단어",
        "* 납품처 확인 바랍니다",
        "<abc@lion-korea.com>",
        "* 담당: <kim@x.co.kr> 에게",
        "<b@y.com>, <c@z.com>",
      ].join("\n"),
    );
    expect(bracketEmails("<a@b.com>")).toBe("<a@b.com>");
  });

  it("a re-handover appends under the old remark with a <재인계 비고> head", () => {
    expect(appendRehandoverRemark("* WORD / DTP\n", "* 분량 변경")).toBe("* WORD / DTP\n<재인계 비고>\n* 분량 변경");
    expect(appendRehandoverRemark(null, "* x")).toBe("<재인계 비고>\n* x");
    expect(appendRehandoverRemark("old", "  ")).toBeNull();
  });

  it("accepting writes the remark; confirming a re-handover appends it", () => {
    const manager = read("lambdas/neotms/nodejs/neotms/pmsheet/NeotmsPmSheetManager.ts");
    expect(manager).toContain("appendRehandoverRemark(current, handover.message)");
    expect(manager).toContain('{ pmState: "인계 수령", hidden: false, ...(remark ? { fields: { remark } } : {}) }');
  });
});

describe("handover mail — typed options and per-job deadlines", () => {
  const project = {
    prjCode: "PRJ_1",
    prjName: "p",
    cusCodeName: "고객",
    prjMgrName: "영업",
    prjPmName: null,
    prjContent: null,
    prjEday: "2026-12-31",
    prjEdayTime: null,
  } as unknown as Parameters<typeof composeHandoverMail>[0];
  const job = (elang: string, eday: string, time: string | null) => ({
    jobName: elang,
    jobType: "LINGUISTICS",
    jobSlang: "한국어",
    jobElang: elang,
    jobPmName: "김PM",
    jobEday: eday,
    jobEdayTime: time,
  });

  it("typed format and layout get their own green rows", () => {
    const mail = composeHandoverMail(project, [job("영어", "2026-12-03", "17:00")], {
      formats: [],
      layouts: ["DTP"],
      note: "",
      formatText: "PDF",
      layoutText: "원본 그대로",
      deadlineFromJobs: true,
    });
    expect(mail.html).toContain("편집포맷 직접입력");
    expect(mail.html).toContain(">PDF</td>");
    expect(mail.html).toContain("원본 그대로");
    expect(mail.html).toContain("12/03 (목) 5:00");
    expect(mail.html).not.toContain("12/31");
  });

  it("differing deadlines list one line per date with its languages", () => {
    const mail = composeHandoverMail(project, [job("영어", "2026-12-03", null), job("일본어", "2026-12-05", null)], {
      formats: ["WORD"],
      layouts: ["DTP"],
      note: "",
      deadlineFromJobs: true,
    });
    expect(mail.html).toContain("12/03 (목) 영어<br>12/05 (토) 일본어");
  });

  it("the old project mail keeps the project deadline", () => {
    const mail = composeHandoverMail(project, [job("영어", "2026-12-03", null)], { formats: ["WORD"], layouts: ["DTP"], note: "" });
    expect(mail.html).toContain("12/31");
  });
});

describe("handover request body", () => {
  it("cc must be email addresses; send is required", () => {
    const base = { jobIds: ["1"], formats: ["WORD"], layouts: ["DTP"], send: false };
    expect(v.safeParse(JobHandoverSchema, base).success).toBe(true);
    expect(v.safeParse(JobHandoverSchema, { ...base, cc: ["work1@lion-korea.com"] }).success).toBe(true);
    expect(v.safeParse(JobHandoverSchema, { ...base, cc: ["work"] }).success).toBe(false);
    expect(v.safeParse(JobHandoverSchema, { jobIds: ["1"] }).success).toBe(false);
  });

  it("the route needs PROJECT:update, and sending also needs the handover-mail permission", () => {
    const handler = read("lambdas/neotms/nodejs/neotms/neotms.handler.ts");
    expect(handler).toContain("path: `${PROJECTS}/:id/handover`, method: \"POST\", handler: handleJobHandover, permission: NEOTMS_PERMISSION_PROJECT_UPDATE");
    expect(handler).toContain("parsed.value.send && !hasPermission(caller, NEOTMS_PERMISSION_PROJECT_EMAIL)");
  });

  it("credentials are only passed to Hiworks — never logged or returned", () => {
    const code = read("lambdas/neotms/nodejs/neotms/handover/NeotmsJobHandover.ts").replace(/\/\/[^\n]*/g, " ");
    expect(code).not.toMatch(/console\./);
    expect(code).not.toMatch(/body:[^\n]*hiworks(Id|Password)/i);
    // sign-in happens before any handover is created
    expect(code.indexOf("hiworksLogin(id, pw)")).toBeLessThan(code.indexOf("createHandovers(caller"));
  });
});

describe("mail chips — Gmail-like address input", () => {
  it("reads name <address>, bare addresses, and flags plain text", () => {
    expect(parseEmailChip("work <work1@lion-korea.com>")).toEqual({ name: "work", email: "work1@lion-korea.com", valid: true, raw: "work <work1@lion-korea.com>" });
    expect(parseEmailChip('"Kim, J" <k@x.com>')?.name).toBe("Kim, J");
    expect(parseEmailChip("a@b.co.kr")?.valid).toBe(true);
    expect(parseEmailChip("홍길동")?.valid).toBe(false);
    expect(parseEmailList('"Kim, J" <k@x.com>, a@b.com; 홍길동').map((c) => c.valid)).toEqual([true, true, false]);
  });
});

describe("PM sheet defaults", () => {
  it("centered columns and a wrapping 비고 for everyone, overridable per column", () => {
    const style = (k: string) => DEFAULT_COLUMN_STYLES[k] ?? {};
    for (const k of ["rowNo", "handoverAt", "task", "trPo", "trEday", "trTime", "rvPo", "rvEday", "rvTime", "jobEday", "jobTime", "pmState", "prjCode"]) {
      expect(style(k).align).toBe("center");
    }
    expect(style("cusCodeName").align).toBeUndefined();
    expect(style("remark").wrap).toBe("wrap");
    // the user's own column style wins, property by property
    expect(read("frontend/src/features/pmsheet/sheetColumns.ts")).toContain(
      "style: { ...(DEFAULT_COLUMN_STYLES[key] ?? {}), ...(pref?.styles?.[key] ?? {}) },",
    );
  });

  it("the M badge sits after the row number; freeze is one icon menu", () => {
    const cells = read("frontend/src/features/pmsheet/sheetCells.tsx");
    expect(cells.indexOf("{body}")).toBeLessThan(cells.indexOf("cell.badge ? ("));
    const sheet = read("frontend/src/features/pmsheet/PmSheet.tsx");
    expect(sheet).toContain("<FreezeMenu");
    expect(sheet).not.toContain('title="열 고정"');
  });
});

describe("project detail — 인계 여부, numbers, and the 대기 -> 진행 move", () => {
  it("numbers drop all-zero decimals and gain thousands commas", () => {
    expect(tidyNumber("12000.00")).toBe("12,000");
    expect(tidyNumber("1234567.50")).toBe("1,234,567.50");
    expect(tidyNumber("40")).toBe("40");
    expect(tidyNumber(null)).toBe("");
    expect(tidyNumber("abc")).toBe("abc");
  });

  it("the stamp is yy/mm/dd(ddd) hh:mm in Korean time, and the newest handover wins", () => {
    expect(handoverStamp("2026-11-25T05:30:00Z")).toBe("26/11/25(수) 14:30");
    const m = latestHandoverByJob([
      { id: "3", jobId: "a" },
      { id: "10", jobId: "a" },
      { id: "4", jobId: "b" },
    ]);
    expect(m.get("a")?.id).toBe("10");
  });

  it("handing over moves 대기 jobs to 진행, nothing else", () => {
    const code = read("lambdas/neotms/nodejs/neotms/handover/NeotmsJobHandover.ts");
    expect(code).toContain("WHERE id = ANY(:job_ids) AND job_state = :waiting AND deleted = false");
    expect(code).toContain("if (handed.length > 0) await pgExecute(StartWaitingJobsOps(handed));");
    const view = read("frontend/src/features/projects/ProjectDetailView.tsx");
    expect(view).not.toContain("ProjectHandoverStatus");
    expect(view).toContain("<span className={ui.detailLabel}>고객사</span>");
  });
});

describe("job form — language combo, auto-add target, bulk apply", () => {
  it("picking a target adds it at once and keeps it in the box", () => {
    const tl = read("frontend/src/features/jobs/TargetLanguages.tsx");
    expect(tl).toContain("if (code) props.onAddTarget?.(code)");
    expect(tl).not.toMatch(/setPending\(''\)/);
    expect(tl).toContain("모두적용 (전체)");
    expect(tl).toContain("const applyEverything = () =>");
    const combo = read("frontend/src/shared/ui/LangCombo.tsx");
    expect(combo).toContain("e.key === 'Tab' && top");
  });
});
