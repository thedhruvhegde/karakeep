import { createId } from "@paralleldrive/cuid2";
import { and, desc, eq, inArray, lt, or } from "drizzle-orm";

import type { DB, KarakeepDBTransaction } from "@karakeep/db";
import { bookmarks, itemHistory, users } from "@karakeep/db/schema";
import type {
  ZGetItemHistoryResponse,
  ZItemHistoryCursor,
  ZItemHistorySource,
} from "@karakeep/shared/types/itemHistory";

import type { HistoryFieldDiff } from "../lib/itemHistory";
import {
  BOOKMARK_HISTORY_FIELDS,
  decodeHistoryValue,
  diffHistoryFields,
  encodeHistoryValue,
  isHistoryFieldVisible,
  isTrackedHistoryField,
  NOTE_GROUPING_WINDOW_MS,
} from "../lib/itemHistory";

// Every write path in the codebase runs on better-sqlite3, whose queries (and
// transactions) are synchronous. Keeping these helpers synchronous lets them be
// called from inside the same `db.transaction((tx) => ...)` callback as the
// edit itself, so an edit and its history are committed or rolled back
// together.
type DBOrTx = DB | KarakeepDBTransaction;

export interface HistoryActor {
  /** The owner of the bookmark (not necessarily the one making the change). */
  ownerId: string;
  /** The user making the change, or null for automated (AI) changes. */
  changedBy: string | null;
  source: ZItemHistorySource;
}

export class ItemHistory {
  /**
   * Reads the current value of every tracked field of a bookmark. Fields that
   * don't apply to the bookmark's type (e.g. `url` on a note) are left
   * undefined so they never show up in a diff.
   */
  static snapshotBookmark(
    db: DBOrTx,
    bookmarkId: string,
  ): Record<string, unknown> | null {
    const row = db.query.bookmarks
      .findFirst({
        where: eq(bookmarks.id, bookmarkId),
        columns: {
          title: true,
          note: true,
          favourited: true,
          archived: true,
          summary: true,
          createdAt: true,
        },
        with: {
          link: {
            columns: {
              url: true,
              description: true,
              author: true,
              publisher: true,
              datePublished: true,
              dateModified: true,
            },
          },
          text: { columns: { text: true } },
          asset: { columns: { content: true } },
          tagsOnBookmarks: { with: { tag: { columns: { name: true } } } },
        },
      })
      .sync();
    if (!row) {
      return null;
    }
    return {
      title: row.title,
      note: row.note,
      favourited: row.favourited,
      archived: row.archived,
      summary: row.summary,
      createdAt: row.createdAt,
      ...(row.link ? row.link : {}),
      ...(row.text ? { text: row.text.text } : {}),
      ...(row.asset ? { assetContent: row.asset.content } : {}),
      tags: row.tagsOnBookmarks.map((t) => t.tag.name),
    };
  }

  /**
   * Runs `mutate` (synchronously, inside the caller's transaction) and records
   * a history row for each tracked field whose value actually changed. Since
   * the comparison is made against what's really stored before and after,
   * no-op updates (same values, already-attached tags, ...) record nothing.
   */
  static trackBookmarkChanges<T>(
    tx: DBOrTx,
    bookmarkId: string,
    actor: HistoryActor,
    mutate: () => T,
  ): T {
    const before = ItemHistory.snapshotBookmark(tx, bookmarkId);
    const result = mutate();
    if (before) {
      const after = ItemHistory.snapshotBookmark(tx, bookmarkId);
      if (after) {
        ItemHistory.recordBookmarkChanges(
          tx,
          bookmarkId,
          actor,
          diffHistoryFields(before, after),
        );
      }
    }
    return result;
  }

  static recordBookmarkChanges(
    tx: DBOrTx,
    bookmarkId: string,
    actor: HistoryActor,
    diffs: HistoryFieldDiff[],
    now = new Date(),
  ) {
    const tracked = diffs.filter((d) => isTrackedHistoryField(d.fieldName));
    if (tracked.length === 0) {
      return;
    }
    const changeId = createId();
    const toInsert: (typeof itemHistory.$inferInsert)[] = [];
    for (const diff of tracked) {
      if (
        diff.fieldName === "note" &&
        ItemHistory.mergeIntoRecentNoteEntry(tx, bookmarkId, actor, diff, now)
      ) {
        continue;
      }
      toInsert.push({
        itemType: "bookmark",
        itemId: bookmarkId,
        ownerId: actor.ownerId,
        changeId,
        fieldName: diff.fieldName,
        oldValue: encodeHistoryValue(diff.fieldName, diff.oldValue),
        newValue: encodeHistoryValue(diff.fieldName, diff.newValue),
        changedBy: actor.changedBy,
        source: actor.source,
        changedAt: now,
      });
    }
    if (toInsert.length > 0) {
      tx.insert(itemHistory).values(toInsert).run();
    }
  }

  /**
   * Note autosave grouping: if the latest history entry of this bookmark is a
   * note edit by the same user within NOTE_GROUPING_WINDOW_MS, extend it
   * (keep its original old value, take the new value and time) instead of
   * adding a new entry. If the note ends up back where it started, the entry
   * is removed since nothing changed overall.
   *
   * Returns true if the diff was absorbed.
   */
  private static mergeIntoRecentNoteEntry(
    tx: DBOrTx,
    bookmarkId: string,
    actor: HistoryActor,
    diff: HistoryFieldDiff,
    now: Date,
  ): boolean {
    if (actor.source !== "user" || actor.changedBy === null) {
      return false;
    }
    const latest = tx
      .select()
      .from(itemHistory)
      .where(
        and(
          eq(itemHistory.itemType, "bookmark"),
          eq(itemHistory.itemId, bookmarkId),
        ),
      )
      .orderBy(desc(itemHistory.changedAt), desc(itemHistory.id))
      .limit(1)
      .get();
    if (
      !latest ||
      latest.fieldName !== "note" ||
      latest.source !== "user" ||
      latest.changedBy !== actor.changedBy ||
      now.getTime() - latest.changedAt.getTime() > NOTE_GROUPING_WINDOW_MS
    ) {
      return false;
    }
    const newValue = encodeHistoryValue("note", diff.newValue);
    if (newValue === latest.oldValue) {
      tx.delete(itemHistory).where(eq(itemHistory.id, latest.id)).run();
    } else {
      tx.update(itemHistory)
        .set({ newValue, changedAt: now })
        .where(eq(itemHistory.id, latest.id))
        .run();
    }
    return true;
  }

  static deleteForBookmark(tx: DBOrTx, bookmarkId: string) {
    tx.delete(itemHistory)
      .where(
        and(
          eq(itemHistory.itemType, "bookmark"),
          eq(itemHistory.itemId, bookmarkId),
        ),
      )
      .run();
  }

  /**
   * Returns the bookmark's history newest first. The caller is responsible
   * for checking that the user can view the bookmark; this only enforces
   * field-level visibility. Hidden fields are excluded in SQL (not after the
   * fact) so pages are full and the cursor never skips visible rows.
   */
  static async getForBookmark(
    db: DB,
    opts: {
      bookmarkId: string;
      isOwner: boolean;
      limit: number;
      cursor?: ZItemHistoryCursor | null;
    },
  ): Promise<ZGetItemHistoryResponse> {
    const visibleFields = Object.keys(BOOKMARK_HISTORY_FIELDS).filter((f) =>
      isHistoryFieldVisible(f, opts.isOwner),
    );
    const rows = await db
      .select({
        id: itemHistory.id,
        changeId: itemHistory.changeId,
        fieldName: itemHistory.fieldName,
        oldValue: itemHistory.oldValue,
        newValue: itemHistory.newValue,
        changedAt: itemHistory.changedAt,
        source: itemHistory.source,
        changedById: users.id,
        changedByName: users.name,
        changedByImage: users.image,
      })
      .from(itemHistory)
      .leftJoin(users, eq(users.id, itemHistory.changedBy))
      .where(
        and(
          eq(itemHistory.itemType, "bookmark"),
          eq(itemHistory.itemId, opts.bookmarkId),
          inArray(itemHistory.fieldName, visibleFields),
          opts.cursor
            ? or(
                lt(itemHistory.changedAt, opts.cursor.changedAt),
                and(
                  eq(itemHistory.changedAt, opts.cursor.changedAt),
                  lt(itemHistory.id, opts.cursor.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(itemHistory.changedAt), desc(itemHistory.id))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = page[page.length - 1];
    return {
      entries: page.map((r) => ({
        id: r.id,
        changeId: r.changeId,
        fieldName: r.fieldName,
        oldValue: decodeHistoryValue(r.fieldName, r.oldValue),
        newValue: decodeHistoryValue(r.fieldName, r.newValue),
        changedAt: r.changedAt,
        source: r.source,
        changedBy: r.changedById
          ? {
              id: r.changedById,
              name: r.changedByName ?? "",
              image: r.changedByImage ?? null,
            }
          : null,
      })),
      nextCursor:
        hasMore && last ? { changedAt: last.changedAt, id: last.id } : null,
    };
  }
}
