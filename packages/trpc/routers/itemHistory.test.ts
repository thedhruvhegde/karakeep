import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  bookmarkAssets,
  bookmarks,
  itemHistory,
  users,
} from "@karakeep/db/schema";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import type { APICallerType, CustomTestContext, TestDB } from "../testUtils";
import { defaultBeforeEach, getApiKeyCallerForPlainKey } from "../testUtils";

beforeEach<CustomTestContext>(defaultBeforeEach(true));

// All tests run on a fake clock (Date only, so promises/IO keep working).
// This makes `changedAt` deterministic and lets us step across the note
// grouping window without sleeping.
const BASE_TIME = new Date("2026-01-01T00:00:00.000Z");
const MINUTE = 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BASE_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

let clockOffset = 0;
beforeEach(() => {
  clockOffset = 0;
});

/** Moves the fake clock forward by `ms` and returns the new time. */
function advance(ms: number): Date {
  clockOffset += ms;
  const now = new Date(BASE_TIME.getTime() + clockOffset);
  vi.setSystemTime(now);
  return now;
}

async function getHistory(api: APICallerType, bookmarkId: string, limit = 100) {
  const res = await api.bookmarks.getBookmarkHistory({ bookmarkId, limit });
  return res.entries;
}

/** Walks all pages and returns every page's entries. */
async function walkPages(
  api: APICallerType,
  bookmarkId: string,
  limit: number,
) {
  const pages: Awaited<
    ReturnType<APICallerType["bookmarks"]["getBookmarkHistory"]>
  >["entries"][] = [];
  let cursor: { changedAt: Date; id: string } | null = null;
  // Safety bound to avoid infinite loops if the cursor never terminates.
  for (let i = 0; i < 100; i++) {
    const res = await api.bookmarks.getBookmarkHistory({
      bookmarkId,
      limit,
      cursor,
    });
    pages.push(res.entries);
    if (!res.nextCursor) {
      return pages;
    }
    cursor = res.nextCursor;
  }
  throw new Error("Pagination did not terminate");
}

async function dbHistoryRows(db: TestDB, bookmarkId: string) {
  return db
    .select()
    .from(itemHistory)
    .where(eq(itemHistory.itemId, bookmarkId));
}

async function whoami(api: APICallerType) {
  return api.users.whoami();
}

async function addAndAcceptCollaborator(
  ownerApi: APICallerType,
  collaboratorApi: APICallerType,
  listId: string,
  role: "viewer" | "editor",
) {
  const collaboratorUser = await collaboratorApi.users.whoami();
  const { invitationId } = await ownerApi.lists.addCollaborator({
    listId,
    email: collaboratorUser.email!,
    role,
  });
  await collaboratorApi.lists.acceptInvitation({ invitationId });
}

/** Puts `bookmarkId` in a fresh list owned by ownerApi, shared with collaboratorApi. */
async function shareBookmark(
  ownerApi: APICallerType,
  collaboratorApi: APICallerType,
  bookmarkId: string,
  role: "viewer" | "editor",
) {
  const list = await ownerApi.lists.create({
    name: "Shared",
    icon: "📚",
    type: "manual",
  });
  await ownerApi.lists.addToList({ listId: list.id, bookmarkId });
  await addAndAcceptCollaborator(ownerApi, collaboratorApi, list.id, role);
  return list;
}

async function createLink(api: APICallerType, extra: object = {}) {
  return api.bookmarks.createBookmark({
    type: BookmarkTypes.LINK,
    url: "https://example.com/article",
    ...extra,
  });
}

function byField<T extends { fieldName: string }>(entries: T[]) {
  return Object.fromEntries(entries.map((e) => [e.fieldName, e]));
}

describe("Bookmark change history", () => {
  describe("capture", () => {
    test<CustomTestContext>("creating a brand-new bookmark writes no history", async ({
      apiCallers,
      db,
    }) => {
      const bookmark = await createLink(apiCallers[0], {
        title: "Title",
        note: "Note",
        summary: "Summary",
        favourited: true,
        archived: true,
      });
      expect(await getHistory(apiCallers[0], bookmark.id)).toEqual([]);
      expect(await dbHistoryRows(db, bookmark.id)).toHaveLength(0);
    });

    test<CustomTestContext>("records a title change with exact values, author and source", async ({
      apiCallers,
    }) => {
      const me = await whoami(apiCallers[0]);
      const bookmark = await createLink(apiCallers[0], { title: "Old title" });

      const changedAt = advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "New title",
      });

      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        fieldName: "title",
        oldValue: "Old title",
        newValue: "New title",
        source: "user",
        changedAt,
        changedBy: { id: me.id, name: "Test User 1", image: null },
      });
      expect(typeof entries[0].id).toBe("string");
      expect(typeof entries[0].changeId).toBe("string");
    });

    test<CustomTestContext>("records link fields (url, description, author, publisher) in one change", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0]);
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        url: "https://example.com/other",
        description: "Desc",
        author: "Author",
        publisher: "Publisher",
      });

      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(4);
      const f = byField(entries);
      // A freshly created link (not crawled in tests) has null metadata.
      expect(f.url).toMatchObject({
        oldValue: "https://example.com/article",
        newValue: "https://example.com/other",
      });
      expect(f.description).toMatchObject({ oldValue: null, newValue: "Desc" });
      expect(f.author).toMatchObject({ oldValue: null, newValue: "Author" });
      expect(f.publisher).toMatchObject({
        oldValue: null,
        newValue: "Publisher",
      });
      expect(new Set(entries.map((e) => e.changeId)).size).toBe(1);
      expect(new Set(entries.map((e) => e.changedAt.getTime())).size).toBe(1);
    });

    test<CustomTestContext>("records datePublished/dateModified as Dates, including clearing them", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0]);
      const published = new Date("2025-05-05T10:00:00.000Z");
      const modified = new Date("2025-06-06T11:30:00.000Z");

      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        datePublished: published,
        dateModified: modified,
      });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        datePublished: null,
      });

      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(3);
      // Newest first: the clearing change comes first.
      expect(entries[0]).toMatchObject({
        fieldName: "datePublished",
        oldValue: published,
        newValue: null,
      });
      expect(entries[0].oldValue).toBeInstanceOf(Date);
      const older = byField(entries.slice(1));
      expect(older.datePublished).toMatchObject({
        oldValue: null,
        newValue: published,
      });
      expect(older.datePublished.newValue).toBeInstanceOf(Date);
      expect(older.dateModified).toMatchObject({
        oldValue: null,
        newValue: modified,
      });
      expect(older.dateModified.newValue).toBeInstanceOf(Date);
    });

    test<CustomTestContext>("records the saved date (createdAt)", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0]);
      const newDate = new Date("2024-03-03T03:03:03.000Z");
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        createdAt: newDate,
      });

      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        fieldName: "createdAt",
        oldValue: bookmark.createdAt,
        newValue: newDate,
      });
      expect(entries[0].oldValue).toBeInstanceOf(Date);
      expect(entries[0].newValue).toBeInstanceOf(Date);
    });

    test<CustomTestContext>("records summary changes and distinguishes empty string from null", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0]);
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        summary: "",
      });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        summary: "A summary",
      });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        summary: null,
      });

      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries.map((e) => [e.fieldName, e.oldValue, e.newValue])).toEqual(
        [
          ["summary", "A summary", null],
          ["summary", "", "A summary"],
          ["summary", null, ""],
        ],
      );
    });

    test<CustomTestContext>("records note, favourited and archived changes for the owner", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0], { note: "orig" });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        note: "changed",
        favourited: true,
        archived: true,
      });

      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(3);
      const f = byField(entries);
      expect(f.note).toMatchObject({ oldValue: "orig", newValue: "changed" });
      expect(f.favourited).toMatchObject({ oldValue: false, newValue: true });
      expect(f.archived).toMatchObject({ oldValue: false, newValue: true });
      expect(new Set(entries.map((e) => e.changeId)).size).toBe(1);
    });

    test<CustomTestContext>("separate calls get distinct changeIds and entry counts add up", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0], { title: "t0" });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "t1",
        favourited: true,
      });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "t2",
      });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        archived: true,
        favourited: false,
      });

      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(5);
      const changeIds = new Set(entries.map((e) => e.changeId));
      expect(changeIds.size).toBe(3);
      // Rows of the same change are contiguous and share changedAt.
      const groups = new Map<string, Set<number>>();
      for (const e of entries) {
        const s = groups.get(e.changeId) ?? new Set();
        s.add(e.changedAt.getTime());
        groups.set(e.changeId, s);
      }
      for (const times of groups.values()) {
        expect(times.size).toBe(1);
      }
    });

    test<CustomTestContext>("records text changes on a TEXT bookmark via updateBookmark", async ({
      apiCallers,
    }) => {
      const bookmark = await apiCallers[0].bookmarks.createBookmark({
        type: BookmarkTypes.TEXT,
        text: "Hello",
      });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        text: "Hello world",
      });
      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        fieldName: "text",
        oldValue: "Hello",
        newValue: "Hello world",
        source: "user",
      });
    });

    test<CustomTestContext>("records text changes via the deprecated updateBookmarkText", async ({
      apiCallers,
    }) => {
      const me = await whoami(apiCallers[0]);
      const bookmark = await apiCallers[0].bookmarks.createBookmark({
        type: BookmarkTypes.TEXT,
        text: "HELLO WORLD",
      });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmarkText({
        bookmarkId: bookmark.id,
        text: "WORLD HELLO",
      });
      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        fieldName: "text",
        oldValue: "HELLO WORLD",
        newValue: "WORLD HELLO",
        source: "user",
        changedBy: { id: me.id },
      });
    });

    test<CustomTestContext>("records assetContent changes on an ASSET bookmark", async ({
      apiCallers,
      db,
    }) => {
      const me = await whoami(apiCallers[0]);
      // Asset bookmarks need an uploaded asset; insert the rows directly as
      // the upload + preprocessing pipeline would have.
      const [created] = await db
        .insert(bookmarks)
        .values({ userId: me.id, type: BookmarkTypes.ASSET })
        .returning();
      await db.insert(bookmarkAssets).values({
        id: created.id,
        assetId: "history-asset",
        assetType: "pdf",
        fileName: "doc.pdf",
        content: "Extracted text",
      });

      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: created.id,
        assetContent: "Corrected text",
      });
      const entries = await getHistory(apiCallers[0], created.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        fieldName: "assetContent",
        oldValue: "Extracted text",
        newValue: "Corrected text",
      });
    });

    test<CustomTestContext>("updateTags records one sorted tags row per call", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0]);
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateTags({
        bookmarkId: bookmark.id,
        attach: [{ tagName: "zeta" }, { tagName: "alpha" }, { tagName: "mu" }],
        detach: [],
      });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateTags({
        bookmarkId: bookmark.id,
        attach: [{ tagName: "beta" }],
        detach: [{ tagName: "zeta" }],
      });

      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        fieldName: "tags",
        oldValue: ["alpha", "mu", "zeta"],
        newValue: ["alpha", "beta", "mu"],
        source: "user",
      });
      expect(entries[1]).toMatchObject({
        fieldName: "tags",
        oldValue: [],
        newValue: ["alpha", "mu", "zeta"],
      });
    });

    test<CustomTestContext>("re-saving an existing link records the fields the re-save changes", async ({
      apiCallers,
    }) => {
      const me = await whoami(apiCallers[0]);
      const original = await createLink(apiCallers[0], {
        title: "Old title",
        note: "Old note",
      });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: original.id,
        archived: true,
      });

      const resavedAt = advance(24 * 60 * MINUTE);
      const dup = await createLink(apiCallers[0], {
        title: "New title",
        note: "New note",
        favourited: true,
        summary: "New summary",
      });
      expect(dup.alreadyExists).toBe(true);
      expect(dup.id).toBe(original.id);

      const entries = await getHistory(apiCallers[0], original.id);
      const resaveEntries = entries.filter(
        (e) => e.changedAt.getTime() === resavedAt.getTime(),
      );
      // Re-saving (non-exempt source) un-archives and bumps the saved date.
      expect(resaveEntries.map((e) => e.fieldName).sort()).toEqual([
        "archived",
        "createdAt",
        "favourited",
        "note",
        "summary",
        "title",
      ]);
      const f = byField(resaveEntries);
      expect(f.title).toMatchObject({
        oldValue: "Old title",
        newValue: "New title",
      });
      expect(f.note).toMatchObject({
        oldValue: "Old note",
        newValue: "New note",
      });
      expect(f.favourited).toMatchObject({ oldValue: false, newValue: true });
      expect(f.archived).toMatchObject({ oldValue: true, newValue: false });
      expect(f.summary).toMatchObject({
        oldValue: null,
        newValue: "New summary",
      });
      expect(f.createdAt).toMatchObject({
        oldValue: original.createdAt,
        newValue: resavedAt,
      });
      expect(new Set(resaveEntries.map((e) => e.changeId)).size).toBe(1);
      for (const e of resaveEntries) {
        expect(e.source).toBe("user");
        expect(e.changedBy?.id).toBe(me.id);
      }
      // archived (earlier) + 6 re-save rows.
      expect(entries).toHaveLength(7);
    });

    test<CustomTestContext>("a bare re-save only records the bumped saved date", async ({
      apiCallers,
    }) => {
      const original = await createLink(apiCallers[0], { title: "T" });
      const resavedAt = advance(60 * MINUTE);
      await createLink(apiCallers[0]);

      const entries = await getHistory(apiCallers[0], original.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        fieldName: "createdAt",
        oldValue: original.createdAt,
        newValue: resavedAt,
      });
    });
  });

  describe("no-ops and note grouping", () => {
    test<CustomTestContext>("updating with the same values writes nothing", async ({
      apiCallers,
      db,
    }) => {
      const bookmark = await createLink(apiCallers[0], {
        title: "Same",
        note: "Same note",
        summary: "Same summary",
      });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "Same",
        note: "Same note",
        summary: "Same summary",
        favourited: false,
        archived: false,
        url: "https://example.com/article",
      });
      advance(MINUTE);
      // An update with no fields at all.
      await apiCallers[0].bookmarks.updateBookmark({ bookmarkId: bookmark.id });

      expect(await getHistory(apiCallers[0], bookmark.id)).toEqual([]);
      expect(await dbHistoryRows(db, bookmark.id)).toHaveLength(0);
    });

    test<CustomTestContext>("same dates (different Date objects, same instant) are a no-op", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0]);
      const published = new Date("2025-01-01T12:00:00.000Z");
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        datePublished: published,
      });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        datePublished: new Date(published.getTime()),
        createdAt: new Date(bookmark.createdAt.getTime()),
      });

      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].fieldName).toBe("datePublished");
    });

    test<CustomTestContext>("duplicate and reordered tags produce a deduplicated row, re-attaching writes nothing", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0]);
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateTags({
        bookmarkId: bookmark.id,
        attach: [{ tagName: "b" }, { tagName: "a" }, { tagName: "b" }],
        detach: [],
      });
      advance(MINUTE);
      // Re-attach already attached tags in a different order.
      await apiCallers[0].bookmarks.updateTags({
        bookmarkId: bookmark.id,
        attach: [{ tagName: "a" }, { tagName: "b" }],
        detach: [],
      });
      advance(MINUTE);
      // Detach a tag that isn't attached.
      await apiCallers[0].bookmarks.updateTags({
        bookmarkId: bookmark.id,
        attach: [],
        detach: [{ tagName: "not-attached" }],
      });

      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        fieldName: "tags",
        oldValue: [],
        newValue: ["a", "b"],
      });
    });

    test<CustomTestContext>("attach+detach of the same tag writes a row only if the tag set changed", async ({
      apiCallers,
    }) => {
      // Assumption: the spec says this produces no row because the set is
      // unchanged. Whether the final set is unchanged depends on whether
      // updateTags applies detach before or after attach, so we assert the
      // general rule (row iff the set of tag names changed) against the
      // observed final state.
      const bookmark = await createLink(apiCallers[0]);
      await apiCallers[0].bookmarks.updateTags({
        bookmarkId: bookmark.id,
        attach: [{ tagName: "keep" }],
        detach: [],
      });
      const before = (await getHistory(apiCallers[0], bookmark.id)).length;
      expect(before).toBe(1);

      advance(MINUTE);
      await apiCallers[0].bookmarks.updateTags({
        bookmarkId: bookmark.id,
        attach: [{ tagName: "keep" }],
        detach: [{ tagName: "keep" }],
      });
      const after = await apiCallers[0].bookmarks.getBookmark({
        bookmarkId: bookmark.id,
      });
      const finalNames = after.tags.map((t) => t.name).sort();
      const entries = await getHistory(apiCallers[0], bookmark.id);
      if (finalNames.length === 1 && finalNames[0] === "keep") {
        expect(entries).toHaveLength(1);
      } else {
        expect(entries).toHaveLength(2);
        expect(entries[0]).toMatchObject({
          fieldName: "tags",
          oldValue: ["keep"],
          newValue: finalNames,
        });
      }
    });

    test<CustomTestContext>("note edits within the window are merged into one row", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0], { note: "v0" });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        note: "v1",
      });
      const [first] = await getHistory(apiCallers[0], bookmark.id);

      const secondAt = advance(2 * MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        note: "v2",
      });

      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: first.id, // updated in place
        fieldName: "note",
        oldValue: "v0",
        newValue: "v2",
        changedAt: secondAt,
      });
    });

    test<CustomTestContext>("the grouping window is measured from the last merged edit", async ({
      apiCallers,
    }) => {
      // Assumption: since a merge sets the row's changedAt to "now", a
      // following edit within 5 minutes of that merge keeps merging even if
      // it is more than 5 minutes after the first edit.
      const bookmark = await createLink(apiCallers[0], { note: "v0" });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        note: "v1",
      });
      advance(4 * MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        note: "v2",
      });
      const lastAt = advance(4 * MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        note: "v3",
      });

      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        oldValue: "v0",
        newValue: "v3",
        changedAt: lastAt,
      });
    });

    test<CustomTestContext>("note edits more than 5 minutes apart produce separate rows", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0], { note: "v0" });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        note: "v1",
      });
      advance(6 * MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        note: "v2",
      });

      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries.map((e) => [e.oldValue, e.newValue])).toEqual([
        ["v1", "v2"],
        ["v0", "v1"],
      ]);
      expect(entries[0].changeId).not.toBe(entries[1].changeId);
    });

    test<CustomTestContext>("a note edited then reverted within the window leaves no row", async ({
      apiCallers,
      db,
    }) => {
      const bookmark = await createLink(apiCallers[0], { note: "original" });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        note: "typo",
      });
      expect(await getHistory(apiCallers[0], bookmark.id)).toHaveLength(1);
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        note: "original",
      });

      expect(await getHistory(apiCallers[0], bookmark.id)).toEqual([]);
      expect(await dbHistoryRows(db, bookmark.id)).toHaveLength(0);
    });

    test<CustomTestContext>("a non-note change in between stops note grouping", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0], { note: "v0" });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        note: "v1",
      });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "A title",
      });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        note: "v2",
      });

      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries.map((e) => [e.fieldName, e.oldValue, e.newValue])).toEqual(
        [
          ["note", "v1", "v2"],
          ["title", null, "A title"],
          ["note", "v0", "v1"],
        ],
      );
    });

    test<CustomTestContext>("grouping applies only to notes: quick title edits stay separate", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0], { title: "t0" });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "t1",
      });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "t2",
      });
      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries.map((e) => [e.oldValue, e.newValue])).toEqual([
        ["t1", "t2"],
        ["t0", "t1"],
      ]);
    });
  });

  describe("authorization", () => {
    test<CustomTestContext>("owner can read; unauthenticated callers get UNAUTHORIZED", async ({
      apiCallers,
      unauthedAPICaller,
    }) => {
      const bookmark = await createLink(apiCallers[0], { title: "a" });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "b",
      });
      const res = await apiCallers[0].bookmarks.getBookmarkHistory({
        bookmarkId: bookmark.id,
      });
      expect(res.entries).toHaveLength(1);
      expect(res.nextCursor).toBeNull();

      await expect(
        unauthedAPICaller.bookmarks.getBookmarkHistory({
          bookmarkId: bookmark.id,
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    test<CustomTestContext>("outsiders and unknown bookmarks get NOT_FOUND", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0], { title: "a" });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "b",
      });
      await expect(
        apiCallers[1].bookmarks.getBookmarkHistory({ bookmarkId: bookmark.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        apiCallers[0].bookmarks.getBookmarkHistory({
          bookmarkId: "does-not-exist",
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    for (const role of ["viewer", "editor"] as const) {
      test<CustomTestContext>(`${role} collaborator sees shared-field history`, async ({
        apiCallers,
      }) => {
        const owner = await whoami(apiCallers[0]);
        const bookmark = await createLink(apiCallers[0], { title: "a" });
        await shareBookmark(apiCallers[0], apiCallers[1], bookmark.id, role);
        advance(MINUTE);
        await apiCallers[0].bookmarks.updateBookmark({
          bookmarkId: bookmark.id,
          title: "b",
        });

        const entries = await getHistory(apiCallers[1], bookmark.id);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          fieldName: "title",
          oldValue: "a",
          newValue: "b",
          changedBy: { id: owner.id, name: "Test User 1", image: null },
        });
      });
    }

    test<CustomTestContext>("a removed collaborator loses access", async ({
      apiCallers,
    }) => {
      const collaborator = await whoami(apiCallers[1]);
      const bookmark = await createLink(apiCallers[0], { title: "a" });
      const list = await shareBookmark(
        apiCallers[0],
        apiCallers[1],
        bookmark.id,
        "viewer",
      );
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "b",
      });
      expect(await getHistory(apiCallers[1], bookmark.id)).toHaveLength(1);

      await apiCallers[0].lists.removeCollaborator({
        listId: list.id,
        userId: collaborator.id,
      });
      await expect(
        apiCallers[1].bookmarks.getBookmarkHistory({ bookmarkId: bookmark.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    test<CustomTestContext>("collaborators never see note/favourited/archived rows", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0], {
        title: "a",
        note: "secret v0",
      });
      await shareBookmark(apiCallers[0], apiCallers[1], bookmark.id, "editor");
      advance(MINUTE);
      // One change mixing public and owner-only fields.
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "b",
        note: "secret v1",
        favourited: true,
        archived: true,
      });
      advance(10 * MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        note: "secret v2",
      });

      const ownerEntries = await getHistory(apiCallers[0], bookmark.id);
      expect(ownerEntries.map((e) => e.fieldName).sort()).toEqual([
        "archived",
        "favourited",
        "note",
        "note",
        "title",
      ]);

      const collabEntries = await getHistory(apiCallers[1], bookmark.id);
      expect(collabEntries.map((e) => e.fieldName)).toEqual(["title"]);
      const serialized = JSON.stringify(collabEntries);
      expect(serialized).not.toContain("secret");
    });

    test<CustomTestContext>("collaborators see history from before they joined", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0], { title: "a" });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "b",
      });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateTags({
        bookmarkId: bookmark.id,
        attach: [{ tagName: "x" }],
        detach: [],
      });
      advance(MINUTE);
      await shareBookmark(apiCallers[0], apiCallers[1], bookmark.id, "viewer");

      const entries = await getHistory(apiCallers[1], bookmark.id);
      expect(entries.map((e) => e.fieldName)).toEqual(["tags", "title"]);
    });

    test<CustomTestContext>("API keys need the bookmarks read scope", async ({
      apiCallers,
      db,
    }) => {
      const bookmark = await createLink(apiCallers[0], { title: "a" });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "b",
      });

      const readKey = await apiCallers[0].apiKeys.create({
        name: "Read",
        scopes: ["bookmarks:read"],
      });
      const readCaller = await getApiKeyCallerForPlainKey(db, readKey.key);
      expect(await getHistory(readCaller, bookmark.id)).toHaveLength(1);

      const otherKey = await apiCallers[0].apiKeys.create({
        name: "Other",
        scopes: ["users:read"],
      });
      const otherCaller = await getApiKeyCallerForPlainKey(db, otherKey.key);
      await expect(
        otherCaller.bookmarks.getBookmarkHistory({ bookmarkId: bookmark.id }),
      ).rejects.toThrow(/FORBIDDEN|missing required scope/i);
    });
  });

  describe("ordering and pagination", () => {
    test<CustomTestContext>("entries are ordered newest first", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0], { title: "t0" });
      const times: Date[] = [];
      for (let i = 1; i <= 4; i++) {
        times.push(advance(MINUTE));
        await apiCallers[0].bookmarks.updateBookmark({
          bookmarkId: bookmark.id,
          title: `t${i}`,
        });
      }
      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries.map((e) => e.newValue)).toEqual(["t4", "t3", "t2", "t1"]);
      expect(entries.map((e) => e.changedAt)).toEqual([...times].reverse());
    });

    test<CustomTestContext>("rows with the same changedAt are ordered by id descending", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0]);
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "T",
        description: "D",
        author: "A",
        publisher: "P",
        summary: "S",
        favourited: true,
      });
      const entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(6);
      const ids = entries.map((e) => e.id);
      // Plain code-unit comparison matches SQLite's default text ordering.
      const sortedDesc = [...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      expect(ids).toEqual(sortedDesc);
    });

    test<CustomTestContext>("walking pages yields every row exactly once", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0], { title: "t0" });
      // Mix single-row changes and multi-row changes (shared changedAt) so
      // page boundaries fall inside a group of identical timestamps.
      for (let i = 1; i <= 4; i++) {
        advance(MINUTE);
        await apiCallers[0].bookmarks.updateBookmark({
          bookmarkId: bookmark.id,
          title: `t${i}`,
          description: `d${i}`,
          author: `a${i}`,
        });
        advance(MINUTE);
        await apiCallers[0].bookmarks.updateBookmark({
          bookmarkId: bookmark.id,
          publisher: `p${i}`,
        });
      }
      const all = await getHistory(apiCallers[0], bookmark.id);
      expect(all).toHaveLength(16);

      for (const limit of [1, 2, 3, 5, 16]) {
        const pages = await walkPages(apiCallers[0], bookmark.id, limit);
        const flat = pages.flat();
        expect(flat.map((e) => e.id)).toEqual(all.map((e) => e.id));
        for (const page of pages.slice(0, -1)) {
          expect(page).toHaveLength(limit);
        }
      }
    });

    test<CustomTestContext>("default page size is 20 and limit is bounded to 1..100", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0], { title: "t0" });
      for (let i = 1; i <= 25; i++) {
        advance(MINUTE);
        await apiCallers[0].bookmarks.updateBookmark({
          bookmarkId: bookmark.id,
          title: `t${i}`,
        });
      }
      const first = await apiCallers[0].bookmarks.getBookmarkHistory({
        bookmarkId: bookmark.id,
      });
      expect(first.entries).toHaveLength(20);
      expect(first.nextCursor).not.toBeNull();
      const second = await apiCallers[0].bookmarks.getBookmarkHistory({
        bookmarkId: bookmark.id,
        cursor: first.nextCursor,
      });
      expect(second.entries).toHaveLength(5);
      expect(second.nextCursor).toBeNull();

      await expect(
        apiCallers[0].bookmarks.getBookmarkHistory({
          bookmarkId: bookmark.id,
          limit: 0,
        }),
      ).rejects.toThrow();
      await expect(
        apiCallers[0].bookmarks.getBookmarkHistory({
          bookmarkId: bookmark.id,
          limit: 101,
        }),
      ).rejects.toThrow();
    });

    test<CustomTestContext>("hidden rows don't break pagination for collaborators", async ({
      apiCallers,
    }) => {
      const bookmark = await createLink(apiCallers[0], {
        title: "t0",
        note: "n0",
      });
      await shareBookmark(apiCallers[0], apiCallers[1], bookmark.id, "viewer");
      // Lots of owner-only rows between the public ones (spaced > 5 minutes
      // so notes don't merge).
      for (let i = 1; i <= 5; i++) {
        advance(10 * MINUTE);
        await apiCallers[0].bookmarks.updateBookmark({
          bookmarkId: bookmark.id,
          note: `n${i}`,
        });
        advance(10 * MINUTE);
        await apiCallers[0].bookmarks.updateBookmark({
          bookmarkId: bookmark.id,
          favourited: i % 2 === 1,
          archived: i % 2 === 1,
        });
        advance(10 * MINUTE);
        await apiCallers[0].bookmarks.updateBookmark({
          bookmarkId: bookmark.id,
          title: `t${i}`,
        });
      }

      expect(await getHistory(apiCallers[0], bookmark.id)).toHaveLength(20);
      const visible = await getHistory(apiCallers[1], bookmark.id);
      expect(visible.map((e) => e.newValue)).toEqual([
        "t5",
        "t4",
        "t3",
        "t2",
        "t1",
      ]);

      const pages = await walkPages(apiCallers[1], bookmark.id, 2);
      // Non-final pages are always full; hidden rows never pad a page.
      for (const page of pages.slice(0, -1)) {
        expect(page).toHaveLength(2);
      }
      const flat = pages.flat();
      expect(flat.map((e) => e.id)).toEqual(visible.map((e) => e.id));
      for (const e of flat) {
        expect(e.fieldName).toBe("title");
      }
    });
  });

  describe("transactions and deletion", () => {
    test<CustomTestContext>("a failed update writes no history", async ({
      apiCallers,
      db,
    }) => {
      const bookmark = await apiCallers[0].bookmarks.createBookmark({
        type: BookmarkTypes.TEXT,
        text: "Some text",
        title: "Before",
      });
      advance(MINUTE);
      await expect(
        apiCallers[0].bookmarks.updateBookmark({
          bookmarkId: bookmark.id,
          title: "After",
          url: "https://should-fail.example.com",
        }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });

      expect(await getHistory(apiCallers[0], bookmark.id)).toEqual([]);
      expect(await dbHistoryRows(db, bookmark.id)).toHaveLength(0);
      const after = await apiCallers[0].bookmarks.getBookmark({
        bookmarkId: bookmark.id,
      });
      expect(after.title).toBe("Before");
    });

    test<CustomTestContext>("deleting a bookmark deletes its history only", async ({
      apiCallers,
      db,
    }) => {
      const doomed = await createLink(apiCallers[0], { title: "a" });
      const kept = await apiCallers[0].bookmarks.createBookmark({
        type: BookmarkTypes.LINK,
        url: "https://example.com/kept",
        title: "a",
      });
      advance(MINUTE);
      for (const id of [doomed.id, kept.id]) {
        await apiCallers[0].bookmarks.updateBookmark({
          bookmarkId: id,
          title: "b",
        });
        await apiCallers[0].bookmarks.updateTags({
          bookmarkId: id,
          attach: [{ tagName: "x" }],
          detach: [],
        });
      }
      expect(await dbHistoryRows(db, doomed.id)).toHaveLength(2);

      await apiCallers[0].bookmarks.deleteBookmark({ bookmarkId: doomed.id });

      expect(await dbHistoryRows(db, doomed.id)).toHaveLength(0);
      expect(await dbHistoryRows(db, kept.id)).toHaveLength(2);
    });

    test<CustomTestContext>("deleting the owner deletes the history", async ({
      apiCallers,
      db,
    }) => {
      const owner = await whoami(apiCallers[0]);
      const bookmark = await createLink(apiCallers[0], { title: "a" });
      const otherUsers = await createLink(apiCallers[1], { title: "a" });
      advance(MINUTE);
      await apiCallers[0].bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "b",
      });
      await apiCallers[1].bookmarks.updateBookmark({
        bookmarkId: otherUsers.id,
        title: "b",
      });
      expect(await dbHistoryRows(db, bookmark.id)).toHaveLength(1);

      await db.delete(users).where(eq(users.id, owner.id));

      expect(await dbHistoryRows(db, bookmark.id)).toHaveLength(0);
      expect(
        await db
          .select()
          .from(itemHistory)
          .where(eq(itemHistory.ownerId, owner.id)),
      ).toHaveLength(0);
      expect(await dbHistoryRows(db, otherUsers.id)).toHaveLength(1);
    });

    test<CustomTestContext>("deleting a non-owner author keeps the history with changedBy null", async ({
      apiCallers,
      db,
    }) => {
      // No API in the spec lets a collaborator author history directly
      // (updateBookmark is owner-only), so we insert a row authored by an
      // editor collaborator directly.
      const owner = await whoami(apiCallers[0]);
      const editor = await whoami(apiCallers[1]);
      const bookmark = await createLink(apiCallers[0], { title: "a" });
      await shareBookmark(apiCallers[0], apiCallers[1], bookmark.id, "editor");

      const changedAt = advance(MINUTE);
      await db.insert(itemHistory).values({
        id: "editor-history-row",
        itemType: "bookmark",
        itemId: bookmark.id,
        ownerId: owner.id,
        changeId: "editor-change",
        fieldName: "title",
        oldValue: JSON.stringify("a"),
        newValue: JSON.stringify("b"),
        changedBy: editor.id,
        source: "user",
        changedAt,
      });

      let entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(1);
      expect(entries[0].changedBy).toEqual({
        id: editor.id,
        name: "Test User 2",
        image: null,
      });

      await db.delete(users).where(eq(users.id, editor.id));

      const rows = await dbHistoryRows(db, bookmark.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].changedBy).toBeNull();

      entries = await getHistory(apiCallers[0], bookmark.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: "editor-history-row",
        changeId: "editor-change",
        fieldName: "title",
        oldValue: "a",
        newValue: "b",
        changedBy: null,
        changedAt,
      });
    });
  });
});
