import { z } from "zod";

// Only bookmarks are tracked today. Storage is keyed on (itemType, itemId) so
// that other item types can be added without a new table.
export const zHistoryItemTypeSchema = z.enum(["bookmark"]);
export type ZHistoryItemType = z.infer<typeof zHistoryItemTypeSchema>;

export const zHistoryFieldSchema = z.enum([
  // The title set on the bookmark
  "title",
  // The page title found by the crawler
  "linkTitle",
  "url",
  "description",
  "author",
  "publisher",
  "datePublished",
  "dateModified",
  // The "saved on" date
  "createdAt",
  "text",
  "assetContent",
  "summary",
  "tags",
  "note",
  "favourited",
  "archived",
]);
export type ZHistoryField = z.infer<typeof zHistoryFieldSchema>;

export const zHistorySourceSchema = z.enum([
  "user",
  "rule",
  "ai",
  "crawler",
  "extraction",
]);
export type ZHistorySource = z.infer<typeof zHistorySourceSchema>;

// Dates are ISO strings and tags are sorted arrays of names. Empty values are
// null, except for an empty tag set, which is [].
export const zHistoryValueSchema = z.union([
  z.string(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);
export type ZHistoryValue = z.infer<typeof zHistoryValueSchema>;

export const zHistoryEntrySchema = z.object({
  id: z.string(),
  // Shared by all the fields changed in one save
  changeId: z.string(),
  field: zHistoryFieldSchema,
  oldValue: zHistoryValueSchema,
  newValue: zHistoryValueSchema,
  source: zHistorySourceSchema,
  changedAt: z.date(),
  // Null for automated changes, and for users who've since been deleted
  changedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type ZHistoryEntry = z.infer<typeof zHistoryEntrySchema>;

export const zHistoryCursorSchema = z.object({
  changedAt: z.date(),
  id: z.string(),
});
export type ZHistoryCursor = z.infer<typeof zHistoryCursorSchema>;

export const MAX_NUM_HISTORY_ENTRIES_PER_PAGE = 100;

export const zGetBookmarkHistoryRequestSchema = z.object({
  bookmarkId: z.string(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_NUM_HISTORY_ENTRIES_PER_PAGE)
    .default(20),
  cursor: zHistoryCursorSchema.nullish(),
});

export const zGetBookmarkHistoryResponseSchema = z.object({
  entries: z.array(zHistoryEntrySchema),
  nextCursor: zHistoryCursorSchema.nullable(),
});
