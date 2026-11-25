// SPDX-License-Identifier: MIT
//
// Request bodies of the PM work sheet. Kept next to the module rather than in neotms.schemas.ts so
// the two sheet models can be developed (and later folded) independently.

import * as v from "valibot";
import { IdSchema } from "../neotms.schemas.js";

/**
 * The PM status vocabulary (기획서). Order is the dropdown's order. The two 별도 관리 markers are
 * grouping markers, not states of work.
 */
export const PM_STATES = [
  "인계 수령",
  "배포 대기",
  "선편집 요청",
  "선편집 중",
  "선편집 완",
  "번역 의뢰",
  "번역 중",
  "번역 완",
  "감수 의뢰",
  "감수 중",
  "감수 완",
  "후편집 요청",
  "후편집 중",
  "후편집 완",
  "납품 대기",
  "납품 완료",
  "홀딩/캔슬",
  "별도 관리 프로젝트(시작)",
  "별도 관리 프로젝트(종료)",
] as const;

/** Sheet-only values of fixed columns. Anything else is refused rather than stored silently. */
export const PM_ROW_FIELDS = ["task", "remark", "backup", "path"] as const;

const Colour = v.pipe(v.string(), v.regex(/^#[0-9A-Fa-f]{6}$/, "must be a colour like #FF9900"));

/**
 * One style. Every property optional; null means "inherit". The narrow types matter: these values
 * end up in a style attribute, so nothing that is not literally a colour/number/keyword gets in.
 */
export const PmStyleSchema = v.strictObject({
  bg: v.optional(v.nullable(Colour)),
  fg: v.optional(v.nullable(Colour)),
  size: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(8), v.maxValue(24)))),
  bold: v.optional(v.nullable(v.boolean())),
  italic: v.optional(v.nullable(v.boolean())),
  underline: v.optional(v.nullable(v.boolean())),
  strike: v.optional(v.nullable(v.boolean())),
  align: v.optional(v.nullable(v.picklist(["left", "center", "right"]))),
  valign: v.optional(v.nullable(v.picklist(["top", "middle", "bottom"]))),
  /** Border weight; `borderSides` says which sides (t/b/l/r) - an outer border on a range gives each cell its edge sides. */
  border: v.optional(v.nullable(v.picklist(["none", "thin", "thick"]))),
  borderSides: v.optional(v.nullable(v.pipe(v.string(), v.regex(/^[tblr]{0,4}$/, "border sides are t, b, l, r")))),
  borderColor: v.optional(v.nullable(Colour)),
  decimals: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(6)))),
  /** Overflowing text: spill over (default), wrap onto more lines, or clip. */
  wrap: v.optional(v.nullable(v.picklist(["overflow", "wrap", "clip"]))),
});

const SheetOwner = { staffId: v.optional(IdSchema) };

export const PmRowPatchSchema = v.object({
  ...SheetOwner,
  jobId: IdSchema,
  /**
   * A state from the built-in list or one the PM added in their own state settings (personal -
   * stored in their `columns` preference). Free text, bounded; how a custom state moves the
   * project is read from that preference by `PmProjectStateSyncOps`.
   */
  pmState: v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(50)))),
  fields: v.optional(
    v.record(v.picklist(PM_ROW_FIELDS), v.pipe(v.string(), v.maxLength(2000))),
  ),
  rowStyle: v.optional(PmStyleSchema),
  ordNo: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(-1_000_000), v.maxValue(1_000_000)))),
  groupMonthly: v.optional(v.boolean()),
  mergedInto: v.optional(v.nullable(IdSchema)),
  hidden: v.optional(v.boolean()),
});

const ColKey = v.pipe(v.string(), v.regex(/^(c:[A-Za-z0-9_-]{1,40}|[A-Za-z][A-Za-z0-9]{0,40})$/, "not a column key"));

export const PmCellsSchema = v.object({
  ...SheetOwner,
  items: v.pipe(
    v.array(
      v.object({
        jobId: IdSchema,
        colKey: ColKey,
        value: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2000)))),
        style: v.optional(PmStyleSchema),
        note: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2000)))),
      }),
    ),
    v.minLength(1),
    v.maxLength(2000),
  ),
});

export const PM_PREF_KINDS = ["columns", "cf", "filters", "shortcuts", "view"] as const;

/**
 * A preference document. Its inner shape belongs to the screen; the server bounds its size (and the
 * table CHECKs it again) because it is otherwise opaque here.
 */
export const PmPrefSchema = v.object({
  ...SheetOwner,
  data: v.pipe(
    v.unknown(),
    v.check((value) => {
      try {
        return JSON.stringify(value).length <= 60_000;
      } catch {
        return false;
      }
    }, "preference document is too large"),
  ),
});

export const PmHandoverCreateSchema = v.object({
  jobIds: v.pipe(v.array(IdSchema), v.minLength(1), v.maxLength(100)),
  message: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2000)))),
});

export const PmHandoverAnswerSchema = v.object({
  action: v.picklist(["accept", "revision", "reject"]),
  reply: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2000)))),
});

export const PmNoticesReadSchema = v.object({
  ids: v.optional(v.nullable(v.pipe(v.array(IdSchema), v.maxLength(200)))),
});

export type PmRowPatch = v.InferOutput<typeof PmRowPatchSchema>;
export type PmCellsInput = v.InferOutput<typeof PmCellsSchema>;
export type PmPrefInput = v.InferOutput<typeof PmPrefSchema>;
export type PmHandoverCreate = v.InferOutput<typeof PmHandoverCreateSchema>;
export type PmHandoverAnswer = v.InferOutput<typeof PmHandoverAnswerSchema>;
export type PmNoticesRead = v.InferOutput<typeof PmNoticesReadSchema>;
