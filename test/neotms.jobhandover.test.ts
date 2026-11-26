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
import { archiveLines, visibleLines, defaultCollapsed, kstYearMonth } from "../frontend/src/features/pmsheet/archiveModel";
import { PmArchiveSchema, PmRowPatchSchema } from "../lambdas/neotms/nodejs/neotms/pmsheet/NeotmsPmSheet.schemas";
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
    expect(manager).toContain('{ pmState: "인계 수령", hidden: false, ...(remark || path ? { fields: { ...(remark ? { remark } : {}), ...(path ? { path } : {}) } } : {}) }');
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
    prjPath: null,
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
    expect(mail.html).toContain("12/03 (목) 17:00");
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

describe("work sheet toolbar and numbers", () => {
  it("no decimals option; numbers get commas and keep their own decimals", async () => {
    const sheet = read("frontend/src/features/pmsheet/PmSheet.tsx");
    expect(sheet).not.toContain('title="소수 자리"');
    expect(sheet).toContain("<BorderMenu");
    const f = await import("../frontend/src/features/pmsheet/sheetFormat");
    expect(f.formatNumber(12000, null)).toBe("12,000");
    expect(f.formatNumber(1234.5, null)).toBe("1,234.5");
    expect(f.formatNumber(0.125, null)).toBe("0.125");
  });
});

describe("column hide / add / delete never moves handover data", () => {
  it("values are stored by column key, and only added columns can be deleted", () => {
    const manager = read("lambdas/neotms/nodejs/neotms/pmsheet/NeotmsPmSheetManager.ts");
    expect(manager).toContain("...(remark ? { remark } : {}), ...(path ? { path } : {})"); // handover remark/path -> their keys, wherever the columns sit
    const sheet = read("frontend/src/features/pmsheet/PmSheet.tsx");
    expect(sheet).toContain("const removable = keys.filter(isCustomKey)");
    expect(sheet).toContain("custom: (pref.custom ?? []).filter((c) => !removable.includes(`c:${c.id}`)),");
  });
});

describe("project NAS path (db/015)", () => {
  it("project has prj_path; handover keeps its own path and lands in the sheet path column", () => {
    expect(read("db/015_project_path.sql")).toContain("ADD COLUMN IF NOT EXISTS prj_path text");
    expect(read("db/015_project_path.sql")).toContain("ALTER TABLE job_handover ADD COLUMN IF NOT EXISTS path");
    const dbops = read("lambdas/neotms/nodejs/neotms/projects/NeotmsProject.dbops.ts");
    expect(dbops).toContain('{ column: "prj_path", kind: "text", read: (i) => i.prjPath }');
    const manager = read("lambdas/neotms/nodejs/neotms/pmsheet/NeotmsPmSheetManager.ts");
    expect(manager).toContain("const path = handover.path?.trim()");
  });

  it("the mail path cell uses the handover path, else the project path", async () => {
    const { composeHandoverMail } = await import("../lambdas/neotms/nodejs/neotms/handover/NeotmsHandoverMail");
    const base = { prjCode: "P1", prjPath: "\\nas\project" } as never;
    const job = { jobName: "a", jobType: null, jobSlang: "ko", jobElang: "en", jobPmName: "김", jobEday: null, jobEdayTime: null } as never;
    expect(composeHandoverMail(base, [job], { formats: ["WORD"], layouts: ["보기좋게"], note: "" }).html).toContain("nas");
    expect(composeHandoverMail(base, [job], { formats: ["WORD"], layouts: ["보기좋게"], note: "", path: "Z:\other" }).html).toContain("other");
  });

  it("one mail to every PM, and a preview that sends nothing", () => {
    const src = read("lambdas/neotms/nodejs/neotms/handover/NeotmsJobHandover.ts");
    expect(src).not.toContain("byPm");
    expect(src).toContain("hiworksSendEmail(login, recipients,");
    expect(src).toContain("export async function previewJobHandover");
    expect(read("lambdas/neotms/nodejs/neotms/neotms.handler.ts")).toContain("/:id/handover/preview`");
  });
});

describe("path in the screens", () => {
  it("project form, detail, handover info (select-all, preview) and sheet copy", () => {
    const form = read("frontend/src/features/projects/ProjectFormModal.tsx");
    expect(form.indexOf('htmlFor="prj-path"')).toBeGreaterThan(form.indexOf('htmlFor="prj-field2"'));
    expect(form.indexOf('htmlFor="prj-path"')).toBeLessThan(form.indexOf('htmlFor="prj-content"'));
    expect(read("frontend/src/features/projects/ProjectDetailView.tsx")).toContain("<PathCopy path={project.prjPath}");
    const flow = read("frontend/src/features/projects/JobHandoverFlow.tsx");
    expect(flow.indexOf('htmlFor="ho-path"')).toBeLessThan(flow.indexOf('htmlFor="ho-note"'));
    expect(flow).toContain("useState(props.projectPath ?? '')");
    expect(flow).toContain("onFocus={(e) => e.currentTarget.select()}");
    expect(flow).toContain('sandbox="" srcDoc={preview.html}');
    expect(read("frontend/src/features/pmsheet/PmSheet.tsx")).toContain("📋 경로 복사");
  });
});

describe("2026-11-26 fixes", () => {
  it("handover window uses the saved Hiworks account", () => {
    expect(read("lambdas/neotms/nodejs/neotms/handover/NeotmsJobHandover.ts")).toContain("await resolveHiworksCredentials(caller, input)");
    const flow = read("frontend/src/features/projects/JobHandoverFlow.tsx");
    expect(flow).toContain("useHiworksCredential()");
    expect(flow).toContain("...(withMail && !useStored ? { hiworksId: id.trim(), hiworksPassword } : {}),");
  });
  it("date fields commit even when no onBlur/onDone is passed (optional call must not skip commit)", () => {
    const f = read("frontend/src/shared/ui/DateField.tsx");
    expect(f).not.toContain("onBlur?.(commit())");
    expect(f).not.toContain("onDone?.(commit())");
    expect(f).toMatch(/const ok = commit\(\)\s+onBlur\?\.\(ok\)/);
  });
  it("inline date cells show yyyy-mm-dd(ddd) right after commit", () => {
    const cell = read("frontend/src/shared/ui/InlineEditCell.tsx");
    expect(cell).toContain("{shown ? formatDateField(shown) : '-'}");
    expect(cell).toContain("setPending(next)");
  });
});

describe("language favourites inside the dropdown (2026-11-26)", () => {
  it("every row has a star; no star button outside the field; all language pickers use LangCombo", () => {
    const combo = read("frontend/src/shared/ui/LangCombo.tsx");
    expect(combo).toContain("{o.star ? '★' : '☆'}");
    expect(combo).toContain("useSaveLangFav()");
    expect(combo).not.toContain("pinned?: readonly string[]");
    const pickers = read("frontend/src/features/jobs/TargetLanguages.tsx");
    expect(pickers).not.toContain("ui.langStar");
    expect(pickers).not.toContain("pinned={");
    for (const f of ["frontend/src/features/jobs/JobsView.tsx", "frontend/src/features/jobs/JobTypeSwapModal.tsx"]) {
      expect(read(f)).not.toContain("domain={CODE_DOMAIN.LANG}");
      expect(read(f)).toContain("<LangCombo");
    }
  });
});

describe("job form templates, menus and layout (2026-11-26)", () => {
  const tl = () => read("frontend/src/features/jobs/TargetLanguages.tsx");
  const form = () => read("frontend/src/features/jobs/JobFormModal.tsx");
  it("template naming: customer·language, or customer·NL for two or more", () => {
    const src = tl();
    expect(src).toContain("targetNames.length === 1 ? targetNames[0]! : `${String(targetNames.length)}L`");
    expect(src).toContain("cus ? `${cus}·${langs}` : langs");
    expect(src).toContain("+ 현재 언어·PM 설정 저장");
  });
  it("template sits between the language pickers and the target table and replaces target rows", () => {
    const f = form();
    const pick = f.indexOf("<LanguagePickers");
    const tpl = f.indexOf("<LangTemplates");
    const table = f.indexOf("<TargetTable");
    expect(pick).toBeGreaterThan(0);
    expect(tpl).toBeGreaterThan(pick);
    expect(table).toBeGreaterThan(tpl);
    expect(f).toContain("updateTargets(\n      t.targets.map(");
  });
  it("name menu closes on outside click inside a modal (capture phase)", () => {
    expect(tl()).toContain("window.addEventListener('mousedown', onDown, true)");
  });
  it("job name column is exactly half, like the date pair", () => {
    expect(form()).toContain("gridTemplateColumns: 'calc(50% - 7px) repeat(4, minmax(0, 1fr))'");
  });
  it("project detail shows the path right after 분야", () => {
    const d = read("frontend/src/features/projects/ProjectDetailView.tsx");
    const field = d.indexOf('<span className={ui.detailLabel}>분야</span>');
    const path = d.indexOf('<span className={ui.detailLabel}>경로</span>');
    const updated = d.indexOf('<span className={ui.detailLabel}>최종 수정</span>');
    expect(path).toBeGreaterThan(field);
    expect(path).toBeLessThan(updated);
  });
});

describe("PO form layout (2026-11-26)", () => {
  it("job candidates show the start date; translator/work/type on one row; wider volume number", () => {
    expect(read("frontend/src/features/purchaseorders/PoPickers.tsx")).toContain("`시작 ${formatDateField(toDateInputValue(r.jobSday))}`");
    const f = read("frontend/src/features/purchaseorders/PurchaseOrderFormModal.tsx");
    const row = f.indexOf("gridTemplateColumns: 'calc(50% - 7px) repeat(2, minmax(0, 1fr))'");
    expect(row).toBeGreaterThan(0);
    expect(f.indexOf("<PoTranslatorPicker")).toBeGreaterThan(row);
    expect(f.indexOf('htmlFor="po-type"')).toBeGreaterThan(f.indexOf('htmlFor="po-work"'));
    expect(f).toContain("${ui.inputRow} ${ui.volRow}");
  });
});

describe("완료 업무 sheet grouping (2026-11-26)", () => {
  const row = (id: string, at: string) => ({ id, handoverAt: at, archivedAt: "2026-11-26T00:00:00Z" });
  const rows = [
    row("3", "2026-03-04T02:00:00Z"),
    row("1", "2025-02-11T01:00:00Z"),
    row("2", "2025-08-14T01:00:00Z"),
    row("4", "2026-03-25T05:00:00Z"),
    row("5", "2025-06-30T16:00:00Z"), // = 2025-07-01 KST
  ];
  it("reads the month in Korean time", () => {
    expect(kstYearMonth("2025-06-30T16:00:00Z")).toEqual({ year: 2025, month: 7 });
  });
  it("past years get half-year labels above month labels; this year months only", () => {
    const lines = archiveLines(rows, 2026);
    const labels = lines.filter((l) => l.kind !== "row").map((l) => ("label" in l ? l.label : ""));
    expect(labels).toEqual(["2025년 상반기", "2025년 02월", "2025년 하반기", "2025년 07월", "2025년 08월", "2026년 03월"]);
    const march = lines.find((l) => l.kind === "month" && l.label === "2026년 03월");
    expect(march && march.kind === "month" ? [march.count, march.parent] : null).toEqual([2, null]);
    expect(lines.filter((l) => l.kind === "row").map((l) => (l.kind === "row" ? l.row.id : ""))).toEqual(["1", "5", "2", "3", "4"]);
  });
  it("collapsing a half hides its months and rows; past halves start collapsed", () => {
    const lines = archiveLines(rows, 2026);
    const shut = defaultCollapsed(lines);
    expect([...shut].sort()).toEqual(["h:2025-1", "h:2025-2"]);
    const shown = visibleLines(lines, shut);
    expect(shown.map((l) => l.kind)).toEqual(["half", "half", "month", "row", "row"]);
  });
});

describe("work sheet: translator group, PO buttons, task menu, archive (2026-11-26)", () => {
  const sheet = () => read("frontend/src/features/pmsheet/PmSheet.tsx");
  const model = () => read("frontend/src/features/pmsheet/sheetModel.ts");
  it("row fields accept the translator group; archive schema accepts snapshots", () => {
    expect(v.safeParse(PmRowPatchSchema, { jobId: "1", fields: { translator: "홍길동", trFor: "", trTid: "5" } }).success).toBe(true);
    expect(v.safeParse(PmRowPatchSchema, { jobId: "1", fields: { nope: "x" } }).success).toBe(false);
    expect(v.safeParse(PmArchiveSchema, { items: [{ jobId: null, handoverAt: null, cells: { remark: { t: "끝" } } }] }).success).toBe(true);
  });
  it("sheet values count only while bound to the current PO; buttons follow it", () => {
    const m = model();
    expect(m).toContain("(row.fields[`${group}For`] ?? '') === (poOfGroup(row, group)?.poId ?? '') ? value : undefined");
    expect(m).toContain("return sheetOverride(row, key) ?? (row.tr ? '발행' : '-')");
    expect(sheet()).toContain("{ issue: '발행', change: '변경', view: '보기' }[personAction(");
    // 2026-11-26: 프로젝트 화면으로 넘어가지 않고 시트 위에 PO 창을 띄운다.
    expect(sheet()).toContain("setSheetPo({ action: poAction, projectId: row.projectId })");
    expect(sheet()).toContain("<SheetPoModal");
    expect(sheet()).not.toContain("state: { poAction }");
  });
  it("column labels T·PO / E·PO / T·시간 / E·시간 / D·시간", () => {
    const c = read("frontend/src/features/pmsheet/sheetColumns.ts");
    for (const label of ["'T·PO'", "'E·PO'", "'T·시간'", "'E·시간'", "'D·시간'"]) expect(c).toContain(`label: ${label}`);
  });
  it("task: one click opens work codes (updates the job), double click / 직접 입력 stays on the sheet", () => {
    const s = sheet();
    expect(s).toContain("await updateJob.mutateAsync({ id: c.id, input: { workCode: c.workCode } })");
    expect(s).toContain("✎ 직접 입력…");
    expect(read("frontend/src/features/pmsheet/sheetCells.tsx")).toContain("if (e.detail > 1) return");
  });
  it("archiving asks with a custom dialog and moves 납품 완료 rows (job and free rows)", () => {
    const s = sheet();
    expect(s).toContain('message="완료된 업무를 완료 업무 시트로 보내시겠습니까?"');
    expect(s).toContain("const archiveFrees = freeRows.filter((f) => (f.values.pmState ?? '').trim() === DONE_STATE)");
    expect(read("frontend/src/features/pmsheet/PmSheetView.tsx")).toContain("['archive', '완료 업무']");
  });
  it("project page opens the PO form from the sheet's state", () => {
    expect(read("frontend/src/features/projects/ProjectDetailView.tsx")).toContain("draft={poDraft}");
    expect(read("frontend/src/features/purchaseorders/PurchaseOrderFormModal.tsx")).toContain("fetchLastPoPrice({ translatorId: priceFor");
  });
});

describe("handover group list: select groups and expand (2026-11-26)", () => {
  it("group checkbox selects every job of the group; + expands indented job rows", () => {
    const f = read("frontend/src/features/projects/JobHandoverFlow.tsx");
    expect(f).toContain("<GroupList jobs={jobs} draft={draft} checked={checked} setChecked={setChecked} />");
    expect(f).toContain("onChange={() => setMany(ids, !full)}");
    expect(f).toContain("if (el) el.indeterminate = on > 0 && !full");
    expect(f).toContain("className={`${ui.hoChild} ${sel ? '' : ui.hoOff}`}");
  });
});

describe("자주쓰는 참조 메일 (2026-11-26)", () => {
  it("default button names", async () => {
    const { ccFavName } = await import("../frontend/src/shared/ui/emailChipParse");
    expect(ccFavName([{ name: "홍길동", email: "hong@x.com" }])).toBe("홍길동");
    expect(ccFavName([{ name: null, email: "work@lion-korea.com" }])).toBe("work");
    expect(ccFavName([{ name: null, email: "a@x.com" }, { name: "B", email: "b@x.com" }, { name: null, email: "c@x.com" }])).toBe("a 외 2명");
  });
  it("sits under the cc field and is personal (prefs.view.ccFav)", () => {
    expect(read("frontend/src/features/projects/JobHandoverFlow.tsx")).toContain("<CcFavorites value={cc} onChange={setCc} disabled={busy} />");
    expect(read("frontend/src/apis/pmsheet.api.ts")).toContain("await writePmPref(undefined, 'view', { ...(fresh.view ?? {}), ccFav })");
  });
});

describe("sheet: PO window over the sheet, IME first key, free-row PRCODE link (2026-11-26)", () => {
  const read = (rel: string) => require("fs").readFileSync(require("path").join(__dirname, "..", rel), "utf8") as string;
  it("PO window opens over the sheet for new and existing POs", () => {
    const m = read("frontend/src/features/pmsheet/SheetPoModal.tsx");
    expect(m).toContain("PurchaseOrderFormModal");
    expect(m).toContain("usePurchaseOrder(action.mode === 'edit' ? action.poId : null)");
  });
  it("Korean IME: key 229 opens an empty editor before composition starts", () => {
    const c = read("frontend/src/features/pmsheet/sheetCells.tsx");
    expect(c).not.toContain("keyCode === 229 && !ctrl"); expect(read("frontend/src/features/pmsheet/imeTyping.ts")).toContain("root.addEventListener('compositionstart', onStart, true)");
  });
  it("free rows: PRCODE text links to the project found by that code", () => {
    const s = read("frontend/src/features/pmsheet/PmSheet.tsx");
    expect(s).toContain("onNavigate: () => void openProjectByCode(");
    expect(s).toContain("p.prjCode.trim().toLowerCase() === code.toLowerCase()");
  });
});

describe("sheet undo + archive undo/compaction + past-year month colour (2026-11-26)", () => {
  const read = (rel: string) => require("fs").readFileSync(require("path").join(__dirname, "..", rel), "utf8") as string;
  const sheet = () => read("frontend/src/features/pmsheet/PmSheet.tsx");
  it("undo replays through the latest render and skips the 'already equal' check", () => {
    const s = sheet();
    expect(s).toContain("latest.current = { applyValues, writeFree, rowById, columnOf }");
    expect(s).toContain("if (!force && before === parsed.value");
    expect(s).toContain("await cur.applyValues(list, false, true)");
    expect(s).toContain("text: d.before, restore: d.beforeFields");
  });
  it("translator/reviewer undo restores the whole group of sheet values", () => {
    const s = sheet();
    expect(s).toContain("[...PO_GROUP_KEYS[src], `${src}For`]");
    expect(s).toContain("await patchPmRow({ staffId: ownerId, jobId: row.jobId, fields: restore })");
  });
  it("free-row edits and the task menu are undoable", () => {
    const s = sheet();
    expect(s).toContain("undo: async () => latest.current?.writeFree(before, false)");
    expect(s).toContain("label: '업무 수정'");
  });
  it("archive removes the emptied slots and can be undone", () => {
    const s = sheet();
    expect(s).toContain("const after = removeSlots(before, [...jobIds, ...archiveFrees.map((f) => freeRowId(f.pos))])");
    expect(s).toContain("await undoArchivePmRows(ownerId, made, jobIds)");
    const h = read("lambdas/neotms/nodejs/neotms/neotms.handler.ts");
    expect(h).toContain('path: "/api/v0/pm-sheet/archive/undo"');
    const ops = read("lambdas/neotms/nodejs/neotms/pmsheet/NeotmsPmSheet.dbops.ts");
    expect(ops).toContain("DELETE FROM pm_sheet_archive\n     WHERE staff_id = :staff_id");
  });
  it("past-year month labels use their own colour", () => {
    const a = read("frontend/src/features/pmsheet/ArchiveSheet.tsx");
    expect(a).toContain("line.kind === 'month' && line.parent ? PAST_MONTH_COLOR : MONTH_COLOR");
  });
});

describe("sheet: sheet-only text appended to read-only columns (2026-11-26)", () => {
  const read = (rel: string) => require("fs").readFileSync(require("path").join(__dirname, "..", rel), "utf8") as string;
  it("appendable columns, stored as sheet cell values, shown in blue, original text kept for filters", () => {
    const cols = read("frontend/src/features/pmsheet/sheetColumns.ts");
    expect(cols).toContain("export const APPEND_KEYS = new Set(['cusCodeName', 'cusMgrName', 'prjMgrName', 'lang'])");
    const s = read("frontend/src/features/pmsheet/PmSheet.tsx");
    expect(s).toContain("customBatch.push({ jobId: row.jobId, colKey: column.key, value: value || null })");
    expect(s).toContain("raw: appendable ? extra : v.raw,");
    expect(s).toContain("text: v.shown,");
    const c = read("frontend/src/features/pmsheet/sheetCells.tsx");
    expect(c).toContain("{cell.extra ? <span style={{ color: '#1a73e8' }}>");
  });
});

describe("sheet: copy button on path cells (2026-11-26)", () => {
  const read = (rel: string) => require("fs").readFileSync(require("path").join(__dirname, "..", rel), "utf8") as string;
  it("hover copy icon on the right of path cells copies the path", () => {
    const c = read("frontend/src/features/pmsheet/sheetCells.tsx");
    expect(c).toContain("css.copyBtn");
    const s = read("frontend/src/features/pmsheet/PmSheet.tsx");
    expect(s).toContain("onCopyText: column.key === 'path' && v.shown.trim() ? () => copyText(v.shown.trim()) : undefined");
    expect(s).toContain("void navigator.clipboard.writeText(text)");
  });
});

describe("sheet: state cell cycles on click, caret opens the list; editor closes back to the grid (2026-11-26)", () => {
  const read = (rel: string) => require("fs").readFileSync(require("path").join(__dirname, "..", rel), "utf8") as string;
  it("cycle order skips the two 별도 관리 states and wraps to the first", () => {
    const s = read("frontend/src/features/pmsheet/PmSheet.tsx");
    expect(s).toContain("!d.hidden && !d.name.startsWith('별도 관리')");
    expect(s).toContain("(at + dir + order.length) % order.length");
    expect(s).toContain("onPrev: () => cycleState(row, -1), onNext: () => cycleState(row, 1)");
    expect(s).not.toContain("onCaret: column.key === 'pmState'");
    expect(s).toContain("window.addEventListener('keydown', onKey)");
    const c = read("frontend/src/features/pmsheet/sheetCells.tsx");
    expect(c).toContain("className={css.caretBtn}");
  });
  it("translator editor gives focus back to the grid so Ctrl+Z works", () => {
    const c = read("frontend/src/features/pmsheet/sheetCells.tsx");
    expect(c).toContain("document.querySelector<HTMLInputElement>('.rg-hidden-element')?.focus({ preventScroll: true })");
  });
  it("unmerge is undoable", () => {
    const s = read("frontend/src/features/pmsheet/PmSheet.tsx");
    expect(s).toContain("label: '통합 해제'");
  });
});

describe("sheet: multi-cell Delete clears every selected cell (2026-11-26)", () => {
  it("Delete over a range goes through one applyValues/writeFree", () => {
    const s = require("fs").readFileSync(require("path").join(__dirname, "..", "frontend/src/features/pmsheet/PmSheet.tsx"), "utf8") as string;
    expect(s).toContain("if (clearSelection()) {");
    expect(s).toContain("if (list.length + free.length <= 1) return false");
  });
});

describe("sheet: < > on translation/review arrival dates (2026-11-26)", () => {
  it("trEday/rvEday get step buttons, empty cells start from today", () => {
    const s = require("fs").readFileSync(require("path").join(__dirname, "..", "frontend/src/features/pmsheet/PmSheet.tsx"), "utf8") as string;
    expect(s).toContain("(column.key === 'trEday' || column.key === 'rvEday') && editable");
    expect(s).toContain("shiftYmd(cur || emptyBase || '', days)");
  });
});
