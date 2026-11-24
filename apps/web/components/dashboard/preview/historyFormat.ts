import { formatLocalDate } from "@/lib/date-format";

import type {
  ZHistoryEntry,
  ZHistoryField,
  ZHistoryValue,
} from "@karakeep/shared/types/itemHistory";

const DATE_FIELDS: ReadonlySet<ZHistoryField> = new Set([
  "createdAt",
  "datePublished",
  "dateModified",
]);

export function historyFieldLabelKey<F extends ZHistoryField>(field: F) {
  return `preview.history.fields.${field}` as const;
}

/** A value as the reader should see it, or null if the field was empty. */
export function formatHistoryValue(
  field: ZHistoryField,
  value: ZHistoryValue,
  { locale, yes, no }: { locale: string; yes: string; no: string },
): string | null {
  if (typeof value === "boolean") {
    return value ? yes : no;
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : null;
  }
  if (!value) {
    return null;
  }
  if (DATE_FIELDS.has(field)) {
    const date = new Date(value);
    return isNaN(date.getTime())
      ? value
      : formatLocalDate(date, "PP, p", locale);
  }
  return value;
}

export type HistoryGroup = Pick<
  ZHistoryEntry,
  "changeId" | "changedAt" | "source" | "changedBy"
> & { entries: ZHistoryEntry[] };

/**
 * Puts the fields changed in one save together. Entries arrive newest first and
 * that order is kept.
 */
export function groupHistoryEntries(entries: ZHistoryEntry[]): HistoryGroup[] {
  // A Map because entries of one change needn't be next to each other when
  // timestamps tie.
  const groups = new Map<string, HistoryGroup>();
  for (const entry of entries) {
    const group = groups.get(entry.changeId);
    if (group) {
      group.entries.push(entry);
    } else {
      const { changeId, changedAt, source, changedBy } = entry;
      groups.set(changeId, {
        changeId,
        changedAt,
        source,
        changedBy,
        entries: [entry],
      });
    }
  }
  return [...groups.values()];
}
