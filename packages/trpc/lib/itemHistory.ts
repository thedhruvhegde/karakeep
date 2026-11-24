/**
 * The rules for item history that don't touch the database: what counts as a
 * change, and who may see it. See docs/change-history.md.
 */
import type {
  ZHistoryField,
  ZHistoryValue,
} from "@karakeep/shared/types/itemHistory";
import { zHistoryFieldSchema } from "@karakeep/shared/types/itemHistory";

export type HistoryValues = Partial<Record<ZHistoryField, unknown>>;

export interface FieldChange {
  field: ZHistoryField;
  oldValue: ZHistoryValue;
  newValue: ZHistoryValue;
}

// "ownerOnly" has to match what Bookmark.asZBookmark() hides from
// collaborators. Being a Record, a new field doesn't compile until someone has
// decided who may see it.
const FIELD_VISIBILITY: Record<ZHistoryField, "shared" | "ownerOnly"> = {
  title: "shared",
  linkTitle: "shared",
  url: "shared",
  description: "shared",
  author: "shared",
  publisher: "shared",
  datePublished: "shared",
  dateModified: "shared",
  createdAt: "shared",
  text: "shared",
  assetContent: "shared",
  summary: "shared",
  tags: "shared",
  note: "ownerOnly",
  favourited: "ownerOnly",
  archived: "ownerOnly",
};

export function getVisibleFields(isOwner: boolean): ZHistoryField[] {
  return zHistoryFieldSchema.options.filter(
    (field) => isOwner || FIELD_VISIBILITY[field] === "shared",
  );
}

const DATE_FIELDS: ReadonlySet<ZHistoryField> = new Set([
  "createdAt",
  "datePublished",
  "dateModified",
]);

function normalizeValue(field: ZHistoryField, value: unknown): ZHistoryValue {
  if (field === "tags") {
    // Tags are a set, so neither order nor duplicates are a change.
    return Array.isArray(value) ? [...new Set(value as string[])].sort() : [];
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (DATE_FIELDS.has(field)) {
    const date = new Date(value as Date | string);
    if (isNaN(date.getTime())) {
      return null;
    }
    // These columns are stored in whole seconds, so a difference in
    // milliseconds is never saved.
    date.setUTCMilliseconds(0);
    return date.toISOString();
  }
  const str = field === "url" ? String(value).trim() : String(value);
  // An empty string and a missing value look the same to the reader.
  return str === "" ? null : str;
}

export function isSameHistoryValue(a: ZHistoryValue, b: ZHistoryValue) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The fields that really differ. Only the fields set in `after` are compared, so
 * a partial update never reads as clearing the fields it leaves out.
 */
export function diffFields(
  before: HistoryValues,
  after: HistoryValues,
): FieldChange[] {
  return zHistoryFieldSchema.options.flatMap((field) => {
    if (after[field] === undefined) {
      return [];
    }
    const oldValue = normalizeValue(field, before[field]);
    const newValue = normalizeValue(field, after[field]);
    return isSameHistoryValue(oldValue, newValue)
      ? []
      : [{ field, oldValue, newValue }];
  });
}
