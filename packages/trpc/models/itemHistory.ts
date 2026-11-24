/**
 * Saving, reading and deleting item history. See docs/change-history.md.
 */
import { createId } from "@paralleldrive/cuid2";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";

import type { DB, KarakeepDBTransaction } from "@karakeep/db";
import type {
  ZHistoryCursor,
  ZHistoryEntry,
  ZHistorySource,
} from "@karakeep/shared/types/itemHistory";
import {
  bookmarkAssets,
  bookmarkLinks,
  bookmarks,
  bookmarkTags,
  bookmarkTexts,
  itemHistory,
  tagsOnBookmarks,
  users,
} from "@karakeep/db/schema";

import type { FieldChange, HistoryValues } from "../lib/itemHistory";
import {
  diffFields,
  getVisibleFields,
  isSameHistoryValue,
} from "../lib/itemHistory";

// Notes save themselves shortly after typing stops, so one writing session
// would otherwise leave many entries behind.
export const NOTE_MERGE_WINDOW_MS = 5 * 60 * 1000;

type HistoryDB = DB | KarakeepDBTransaction;

interface ChangeAttribution {
  source: ZHistorySource;
  // Null for automated changes
  changedBy: string | null;
  // Pass one to group several calls into a single change
  changeId?: string;
  // Leaves out fields that were empty before. The crawler and text extraction
  // use it, so that processing a new bookmark isn't listed as a set of edits.
  skipInitialPopulation?: boolean;
}

/**
 * Folds a note edit into the latest note entry if both are part of the same
 * writing session. Returns false if it needs an entry of its own.
 */
function mergeIntoLatestNoteEntry(
  db: HistoryDB,
  bookmarkId: string,
  change: FieldChange,
  attribution: ChangeAttribution & { changeId: string },
  now: Date,
): boolean {
  if (change.field !== "note" || attribution.source !== "user") {
    return false;
  }
  const latest = db
    .select()
    .from(itemHistory)
    .where(
      and(
        eq(itemHistory.itemType, "bookmark"),
        eq(itemHistory.itemId, bookmarkId),
        eq(itemHistory.fieldName, "note"),
      ),
    )
    .orderBy(desc(itemHistory.changedAt), desc(itemHistory.id))
    .limit(1)
    .all()[0];

  if (
    !latest ||
    latest.source !== "user" ||
    latest.changedBy !== attribution.changedBy ||
    // If these differ, the note was changed by something that wasn't recorded,
    // and merging would hide that.
    !isSameHistoryValue(latest.newValue, change.oldValue) ||
    now.getTime() - latest.changedAt.getTime() > NOTE_MERGE_WINDOW_MS
  ) {
    return false;
  }

  if (isSameHistoryValue(latest.oldValue, change.newValue)) {
    // The session ended where it started, so nothing changed.
    db.delete(itemHistory).where(eq(itemHistory.id, latest.id)).run();
  } else {
    db.update(itemHistory)
      .set({
        newValue: change.newValue,
        changedAt: now,
        changeId: attribution.changeId,
      })
      .where(eq(itemHistory.id, latest.id))
      .run();
  }
  return true;
}

/**
 * Records the fields that differ between `before` and `after`. Call it in the
 * same transaction as the edit, so that one is never saved without the other.
 */
export function recordBookmarkChanges(
  db: HistoryDB,
  {
    bookmarkId,
    ownerId,
    before,
    after,
    ...rest
  }: ChangeAttribution & {
    bookmarkId: string;
    ownerId: string;
    before: HistoryValues;
    after: HistoryValues;
  },
): void {
  const attribution = { ...rest, changeId: rest.changeId ?? createId() };
  const now = new Date();

  const changes = diffFields(before, after).filter(
    (change) =>
      !(attribution.skipInitialPopulation && change.oldValue === null),
  );

  for (const change of changes) {
    if (mergeIntoLatestNoteEntry(db, bookmarkId, change, attribution, now)) {
      continue;
    }
    db.insert(itemHistory)
      .values({
        itemType: "bookmark",
        itemId: bookmarkId,
        ownerId,
        changeId: attribution.changeId,
        fieldName: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        source: attribution.source,
        changedBy: attribution.changedBy,
        changedAt: now,
      })
      .run();
  }
}

/** The current value of every tracked field, or null if there's no bookmark. */
function readBookmarkValues(db: HistoryDB, bookmarkId: string) {
  const row = db
    .select({
      ownerId: bookmarks.userId,
      title: bookmarks.title,
      createdAt: bookmarks.createdAt,
      summary: bookmarks.summary,
      note: bookmarks.note,
      favourited: bookmarks.favourited,
      archived: bookmarks.archived,
      linkTitle: bookmarkLinks.title,
      url: bookmarkLinks.url,
      description: bookmarkLinks.description,
      author: bookmarkLinks.author,
      publisher: bookmarkLinks.publisher,
      datePublished: bookmarkLinks.datePublished,
      dateModified: bookmarkLinks.dateModified,
      text: bookmarkTexts.text,
      assetContent: bookmarkAssets.content,
    })
    .from(bookmarks)
    .leftJoin(bookmarkLinks, eq(bookmarkLinks.id, bookmarks.id))
    .leftJoin(bookmarkTexts, eq(bookmarkTexts.id, bookmarks.id))
    .leftJoin(bookmarkAssets, eq(bookmarkAssets.id, bookmarks.id))
    .where(eq(bookmarks.id, bookmarkId))
    .all()[0];

  if (!row) {
    return null;
  }

  const tags = db
    .select({ name: bookmarkTags.name })
    .from(tagsOnBookmarks)
    .innerJoin(bookmarkTags, eq(bookmarkTags.id, tagsOnBookmarks.tagId))
    .where(eq(tagsOnBookmarks.bookmarkId, bookmarkId))
    .all()
    .map((tag) => tag.name);

  const { ownerId, ...values } = row;
  return { ownerId, values: { ...values, tags } satisfies HistoryValues };
}

/**
 * Runs `mutate` and records whatever it changed on the bookmark. The values are
 * read back from the database, so the history shows what was really stored,
 * including when a write ends up changing nothing.
 *
 * `tx` has to be a transaction, and `mutate` has to write through it.
 */
export function trackBookmarkChanges<T>(
  tx: KarakeepDBTransaction,
  bookmarkId: string,
  attribution: ChangeAttribution,
  mutate: () => T,
): T {
  const before = readBookmarkValues(tx, bookmarkId);
  const result = mutate();
  const after = readBookmarkValues(tx, bookmarkId);
  if (before && after) {
    recordBookmarkChanges(tx, {
      ...attribution,
      bookmarkId,
      ownerId: after.ownerId,
      before: before.values,
      after: after.values,
    });
  }
  return result;
}

/**
 * A page of a bookmark's history, newest first. The caller has to have checked
 * that the user can view the bookmark. What a non-owner may not see is filtered
 * out in the query, so it never leaves the database and pages stay full.
 */
export async function getBookmarkHistory(
  db: DB,
  {
    bookmarkId,
    isOwner,
    limit,
    cursor,
  }: {
    bookmarkId: string;
    isOwner: boolean;
    limit: number;
    cursor?: ZHistoryCursor | null;
  },
): Promise<{
  entries: ZHistoryEntry[];
  nextCursor: ZHistoryCursor | null;
}> {
  const rows = await db
    .select({
      id: itemHistory.id,
      changeId: itemHistory.changeId,
      field: itemHistory.fieldName,
      oldValue: itemHistory.oldValue,
      newValue: itemHistory.newValue,
      source: itemHistory.source,
      changedAt: itemHistory.changedAt,
      changedById: users.id,
      changedByName: users.name,
    })
    .from(itemHistory)
    .leftJoin(users, eq(users.id, itemHistory.changedBy))
    .where(
      and(
        eq(itemHistory.itemType, "bookmark"),
        eq(itemHistory.itemId, bookmarkId),
        inArray(itemHistory.fieldName, getVisibleFields(isOwner)),
        cursor
          ? or(
              lt(itemHistory.changedAt, cursor.changedAt),
              and(
                eq(itemHistory.changedAt, cursor.changedAt),
                lt(itemHistory.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(itemHistory.changedAt), desc(itemHistory.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  return {
    entries: page.map(({ changedById, changedByName, ...entry }) => ({
      ...entry,
      changedBy:
        changedById && changedByName !== null
          ? { id: changedById, name: changedByName }
          : null,
    })),
    nextCursor:
      rows.length > limit ? { changedAt: last.changedAt, id: last.id } : null,
  };
}

export function deleteBookmarkHistory(db: HistoryDB, bookmarkId: string) {
  db.delete(itemHistory)
    .where(
      and(
        eq(itemHistory.itemType, "bookmark"),
        eq(itemHistory.itemId, bookmarkId),
      ),
    )
    .run();
}
