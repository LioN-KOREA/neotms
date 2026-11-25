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

describe("PO form — CAT table, pickers, finance-only fields", () => {
  it("subtotal rounds words x weight to a whole number; total is the sum", async () => {
    const m = await import("../frontend/src/features/purchaseorders/catMath");
    expect(m.catSubtotal(125, 30)).toBe(38);
    expect(m.catSubtotal(1000, 10)).toBe(100);
    expect(m.catSubtotal(null, 30)).toBe(0);
    expect(m.catTotal([100, 200, 125, 0, null, 10, 50], m.DEFAULT_CAT_WEIGHTS)).toBe(10 + 0 + 38 + 0 + 0 + 3 + 50);
  });

  it("weights are fixed; only [거래처] Taijia differs", async () => {
    const m = await import("../frontend/src/features/purchaseorders/catMath");
    expect(m.catWeightsFor("홍길동")).toEqual([10, 0, 30, 30, 30, 30, 100]);
    expect(m.catWeightsFor("[거래처] Taijia")).toEqual([10, 0, 30, 60, 60, 100, 100]);
    expect(m.catWeightsFor(" [거래처]  taijia ")).toEqual(m.TAIJIA_CAT_WEIGHTS);
  });

  it("pastes a spreadsheet row or column, skipping a header row", async () => {
    const m = await import("../frontend/src/features/purchaseorders/catMath");
    expect(m.parseCatPaste("1,200\t300\t40\r\n")).toEqual(["1,200", "300", "40"]);
    expect(m.parseCatPaste("10\n20\n30")).toEqual(["10", "20", "30"]);
    expect(m.parseCatPaste("반복\t100%\t95%\n5\t6\t7")).toEqual(["5", "6", "7"]);
    const d = m.catDetail(["", "", "100", "100", "", "", "50"], m.DEFAULT_CAT_WEIGHTS);
    expect(d?.total).toBe(30 + 30 + 50);
    expect(d?.midWords).toBe(200);
    expect(d?.newWords).toBe(50);
    expect(m.catDetail(["", "", "", "", "", "", ""], m.DEFAULT_CAT_WEIGHTS)).toBeNull();
  });

  it("the form hides state and KRW total, gates tax/payment, and saves the table", () => {
    const form = read("frontend/src/features/purchaseorders/PurchaseOrderFormModal.tsx");
    expect(form).not.toContain('htmlFor="po-state"');
    expect(form).not.toContain('htmlFor="po-ksum"');
    expect(form).toContain("{mayFinance ? (");
    expect(form.indexOf("{mayFinance ? (")).toBeLessThan(form.indexOf('htmlFor="po-tax"'));
    expect(form).toContain("poCatDetail: catInfo.detail");
    expect(form).toContain("<PoJobPicker");
    expect(form).toContain("<PoTranslatorPicker");
    const dbops = read("lambdas/neotms/nodejs/neotms/purchase-orders/NeotmsPurchaseOrder.dbops.ts");
    expect(dbops).toContain('{ column: "po_cat_detail", kind: "json", read: (i) => i.poCatDetail }');
    expect(read("db/013_po_cat_detail.sql")).toContain("ADD COLUMN IF NOT EXISTS po_cat_detail jsonb");
  });
});

describe("work sheet fills the screen", () => {
  it("no side panel / breadcrumb on /workspace, tabs at the bottom, zoom reaches the text", () => {
    const app = read("frontend/src/NeotmsApp.tsx");
    expect(app).toContain("const full = location.pathname.startsWith('/workspace')");
    expect(app).toContain("{full ? null : (\n        <nav className={styles.crumb}");
    const view = read("frontend/src/features/pmsheet/PmSheetView.tsx");
    expect(view.indexOf("css.fullBody")).toBeLessThan(view.indexOf("{tabs}"));
    expect(view).not.toContain("<h1");
    const cssText = read("frontend/src/features/pmsheet/PmSheet.module.css");
    expect(cssText).toContain(".gridWrap :global(.reactgrid-content .rg-pane .rg-cell) { font-size: calc(13px * var(--pm-zoom, 1)); }");
  });
});

describe("date fields accept short forms", () => {
  it("mmdd and mm/dd take this year; output stays yyyy-mm-dd(ddd)", async () => {
    const f = await import("../frontend/src/shared/utils/format");
    const year = f.todayKst().slice(0, 4);
    expect(f.parseDateField("1203")).toEqual({ ok: true, value: `${year}-12-03` });
    expect(f.parseDateField("12/3")).toEqual({ ok: true, value: `${year}-12-03` });
    expect(f.parseDateField("26/12/03")).toEqual({ ok: true, value: "2026-12-03" });
    expect(f.parseDateField("261203")).toEqual({ ok: true, value: "2026-12-03" });
    expect(f.parseDateField("1340").ok).toBe(false);
    expect(f.formatDateField("2026-12-03")).toBe("2026-12-03(목)");
  });

  it("no native date pickers are left in the screens", () => {
    for (const file of ["payment/InvoiceFormModal.tsx", "payment/PoPaymentView.tsx", "projects/ProjectsView.tsx", "reports/ReportsView.tsx", "translators/TranslatorFormModal.tsx", "projects/JobHandoverFlow.tsx"]) {
      expect(read("frontend/src/features", ...file.split("/"))).not.toMatch(/<input[^>]*type="date"/);
    }
  });
});

describe("job groups", () => {
  it("db/014 adds the columns, the company-wide sequence from 6000 and the letter rules", () => {
    const sql = read("db/014_job_group.sql");
    expect(sql).toContain("CREATE SEQUENCE IF NOT EXISTS job_group_seq START WITH 6000");
    expect(sql).toContain("WHEN '조선미' THEN 'J' WHEN '유나경' THEN 'N' WHEN '조수현' THEN 'H' WHEN '이하경' THEN 'L'");
    expect(sql).toContain("NEOTMS_USER_ATTRIBUTE_SALES_MANAGER");
  });

  it("a given group must already be in the project; a form shares one code across its jobs", () => {
    const ops = read("lambdas/neotms/nodejs/neotms/jobs/NeotmsJobGroup.ts");
    expect(ops).toContain("o.project_id = j.project_id AND o.id <> j.id");
    const form = read("frontend/src/features/jobs/JobFormModal.tsx");
    expect(form).toContain("if (!shared && created.jobGroup) {");
    expect(form).not.toMatch(/<input[^>]*id="job-group"/);
  });

  it("merge picks the lowest number; the group list joins values", async () => {
    const g = await import("../frontend/src/apis/jobGroupCode");
    expect(["N6010", "J6003", "X6100"].sort((a, b) => g.groupNumber(a) - g.groupNumber(b))[0]).toBe("J6003");
    const flow = read("frontend/src/features/projects/JobHandoverFlow.tsx");
    expect(flow).toContain("domain={CODE_DOMAIN.WORK} value={d.workCode}");
    expect(flow).toContain("`${src.join(', ') || '-'} → ${tgt.join(', ') || '-'}`");
  });
});
