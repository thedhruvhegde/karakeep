import { z } from "zod";

export const zItemHistorySourceSchema = z.enum(["user", "ai", "rule"]);
export type ZItemHistorySource = z.infer<typeof zItemHistorySourceSchema>;

export const zItemHistoryCursorSchema = z.object({
  changedAt: z.date(),
  id: z.string(),
});
export type ZItemHistoryCursor = z.infer<typeof zItemHistoryCursorSchema>;

export const DEFAULT_ITEM_HISTORY_PAGE_SIZE = 20;
export const MAX_ITEM_HISTORY_PAGE_SIZE = 100;

export const zGetItemHistoryRequestSchema = z.object({
  bookmarkId: z.string(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_ITEM_HISTORY_PAGE_SIZE)
    .optional()
    .default(DEFAULT_ITEM_HISTORY_PAGE_SIZE),
  cursor: zItemHistoryCursorSchema.nullish(),
});
export type ZGetItemHistoryRequest = z.input<
  typeof zGetItemHistoryRequestSchema
>;

export const zItemHistoryEntrySchema = z.object({
  id: z.string(),
  changeId: z.string(),
  fieldName: z.string(),
  // Already decoded: strings, null, booleans, Dates (for date fields) or
  // string[] (for tags).
  oldValue: z.unknown(),
  newValue: z.unknown(),
  changedAt: z.date(),
  source: zItemHistorySourceSchema,
  changedBy: z
    .object({
      id: z.string(),
      name: z.string(),
      image: z.string().nullable(),
    })
    .nullable(),
});
export type ZItemHistoryEntry = z.infer<typeof zItemHistoryEntrySchema>;

export const zGetItemHistoryResponseSchema = z.object({
  entries: z.array(zItemHistoryEntrySchema),
  nextCursor: zItemHistoryCursorSchema.nullable(),
});
export type ZGetItemHistoryResponse = z.infer<
  typeof zGetItemHistoryResponseSchema
>;
