/**
 * Pure helpers for item change history: which fields are tracked, who may see
 * them, how values are normalized/compared and how they're (de)serialized.
 * Kept free of DB access so it's trivially unit-testable.
 */

/**
 * Tracked bookmark fields and who can see their history.
 *
 * "owner" fields mirror what `Bookmark.asZBookmark()` hides from collaborators
 * (personal note, favourite and archive state). Their history must be hidden
 * as well, including old values, otherwise it would leak the very data the
 * authorization model hides. Anything not listed here is hidden from everyone
 * so that a newly recorded field is private until someone decides otherwise.
 */
export const BOOKMARK_HISTORY_FIELDS: Record<string, "public" | "owner"> = {
  title: "public",
  url: "public",
  description: "public",
  author: "public",
  publisher: "public",
  datePublished: "public",
  dateModified: "public",
  createdAt: "public",
  text: "public",
  assetContent: "public",
  summary: "public",
  tags: "public",
  note: "owner",
  favourited: "owner",
  archived: "owner",
};

const DATE_FIELDS = new Set(["datePublished", "dateModified", "createdAt"]);

/**
 * Notes autosave shortly after the user stops typing, so a single writing
 * session would otherwise produce dozens of entries. Saves by the same user
 * within this window are merged into one entry.
 */
export const NOTE_GROUPING_WINDOW_MS = 5 * 60 * 1000;

export function isTrackedHistoryField(fieldName: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    BOOKMARK_HISTORY_FIELDS,
    fieldName,
  );
}

export function isHistoryFieldVisible(
  fieldName: string,
  isOwner: boolean,
): boolean {
  // Own-property check: a plain lookup would find inherited keys such as
  // "toString" or "__proto__" and treat them as tracked fields.
  if (!isTrackedHistoryField(fieldName)) {
    return false;
  }
  const visibility = BOOKMARK_HISTORY_FIELDS[fieldName];
  return visibility === "public" || isOwner;
}

export function normalizeHistoryValue(
  fieldName: string,
  value: unknown,
): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (fieldName === "tags" && Array.isArray(value)) {
    return [...new Set(value.map((v) => String(v)))].sort();
  }
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

export interface HistoryFieldDiff {
  fieldName: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Compares the fields present in `after` against `before` and returns only the
 * ones whose normalized values differ. `undefined` in `after` means "not part
 * of this update" and is skipped, so a no-op update yields an empty array.
 */
export function diffHistoryFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): HistoryFieldDiff[] {
  const diffs: HistoryFieldDiff[] = [];
  for (const [fieldName, rawNew] of Object.entries(after)) {
    if (rawNew === undefined) {
      continue;
    }
    const newValue = normalizeHistoryValue(fieldName, rawNew);
    const oldValue =
      normalizeHistoryValue(fieldName, before[fieldName]) ?? null;
    if (!sameValue(oldValue, newValue)) {
      diffs.push({ fieldName, oldValue, newValue });
    }
  }
  return diffs;
}

export function encodeHistoryValue(fieldName: string, value: unknown): string {
  return JSON.stringify(normalizeHistoryValue(fieldName, value) ?? null);
}

export function decodeHistoryValue(fieldName: string, raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  if (DATE_FIELDS.has(fieldName) && typeof value === "string") {
    return new Date(value);
  }
  return value;
}
