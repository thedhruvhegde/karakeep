// Pure formatting helpers for the bookmark History section. The English labels
// here double as the i18n fallback (see HistoryBox).

const FIELD_LABELS: Record<string, string> = {
  title: "Title",
  url: "URL",
  description: "Description",
  author: "Author",
  publisher: "Publisher",
  datePublished: "Published date",
  dateModified: "Modified date",
  createdAt: "Saved date",
  text: "Text",
  assetContent: "Asset text",
  summary: "Summary",
  tags: "Tags",
  note: "Note",
  favourited: "Favourite",
  archived: "Archived",
};

const DATE_FIELDS = new Set(["datePublished", "dateModified", "createdAt"]);

export const EMPTY_HISTORY_VALUE = "(empty)";

export function historyFieldLabel(fieldName: string): string {
  return FIELD_LABELS[fieldName] ?? fieldName;
}

export function formatHistoryValue(fieldName: string, value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return EMPTY_HISTORY_VALUE;
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (DATE_FIELDS.has(fieldName)) {
    const date = value instanceof Date ? value : new Date(String(value));
    if (!isNaN(date.getTime())) {
      return date.toLocaleString();
    }
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? EMPTY_HISTORY_VALUE
      : value.map((v) => String(v)).join(", ");
  }
  if (value instanceof Date) {
    return value.toLocaleString();
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Groups consecutive entries of the same save, keeping their order. */
export function groupHistoryEntries<T extends { changeId: string }>(
  entries: T[],
): { changeId: string; entries: T[] }[] {
  const groups: { changeId: string; entries: T[] }[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last && last.changeId === entry.changeId) {
      last.entries.push(entry);
    } else {
      groups.push({ changeId: entry.changeId, entries: [entry] });
    }
  }
  return groups;
}
