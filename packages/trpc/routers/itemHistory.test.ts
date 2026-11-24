import { eq, getTableName, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  bookmarkAssets,
  bookmarkLinks,
  bookmarks,
  itemHistory,
  ruleEngineActionsTable,
  ruleEngineRulesTable,
  users,
} from "@karakeep/db/schema";
import type { InferenceClient } from "@karakeep/shared/inference";
import { InferenceClientFactory } from "@karakeep/shared/inference";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";
import type { RuleEngineAction } from "@karakeep/shared/types/rules";

import type { AuthedContext } from "..";
import type { APICallerType, CustomTestContext, TestDB } from "../testUtils";
// testUtils has to come before anything that loads @karakeep/shared-server:
// importing it is what registers the queue mocks.
import { defaultBeforeEach, getApiKeyCallerForPlainKey } from "../testUtils";
import { RuleEngine } from "../lib/ruleEngine";
import { recordBookmarkChanges } from "../models/itemHistory";

const T0 = new Date("2025-06-01T12:00:00.123Z").getTime();
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Moves the (faked) clock to T0 + offset and returns that instant. */
function at(offsetMs: number) {
  const now = new Date(T0 + offsetMs);
  vi.setSystemTime(now);
  return now;
}

beforeEach<CustomTestContext>(defaultBeforeEach(true));

// Only Date is faked: it makes changedAt deterministic without freezing timers.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function getHistory(api: APICallerType, bookmarkId: string) {
  const res = await api.bookmarks.getBookmarkHistory({
    bookmarkId,
    limit: 100,
  });
  expect(res.nextCursor).toBeNull();
  return res.entries;
}

type Entry = Awaited<ReturnType<typeof getHistory>>[number];

function simplify(e: Entry) {
  return {
    field: e.field,
    oldValue: e.oldValue,
    newValue: e.newValue,
    source: e.source,
    changedBy: e.changedBy?.id ?? null,
  };
}

/** Entries of a single save have no meaningful relative order. */
function byField(entries: Entry[]) {
  return entries.map(simplify).sort((a, b) => a.field.localeCompare(b.field));
}

function change(
  field: string,
  oldValue: unknown,
  newValue: unknown,
  changedBy: string | null,
  source = "user",
) {
  return { field, oldValue, newValue, source, changedBy };
}

async function userId(api: APICallerType) {
  return (await api.users.whoami()).id;
}

async function createLink(
  api: APICallerType,
  url = "https://example.com/article",
) {
  return await api.bookmarks.createBookmark({
    type: BookmarkTypes.LINK,
    url,
  });
}

async function createText(api: APICallerType, text = "original text") {
  return await api.bookmarks.createBookmark({
    type: BookmarkTypes.TEXT,
    text,
  });
}

async function createAsset(db: TestDB, ownerId: string, content: string) {
  const [created] = await db
    .insert(bookmarks)
    .values({ userId: ownerId, type: BookmarkTypes.ASSET })
    .returning();
  await db.insert(bookmarkAssets).values({
    id: created.id,
    assetId: `asset-${created.id}`,
    assetType: "pdf",
    fileName: "paper.pdf",
    content,
  });
  return created;
}

async function createSharedList(
  owner: APICallerType,
  bookmarkIds: string[],
  name = "Shared",
) {
  const list = await owner.lists.create({ name, icon: "x", type: "manual" });
  for (const bookmarkId of bookmarkIds) {
    await owner.lists.addToList({ listId: list.id, bookmarkId });
  }
  return list;
}

async function invite(
  owner: APICallerType,
  collaborator: APICallerType,
  listId: string,
  role: "viewer" | "editor",
) {
  const { email } = await collaborator.users.whoami();
  return await owner.lists.addCollaborator({ listId, email: email!, role });
}

async function share(
  owner: APICallerType,
  collaborator: APICallerType,
  listId: string,
  role: "viewer" | "editor",
) {
  const { invitationId } = await invite(owner, collaborator, listId, role);
  await collaborator.lists.acceptInvitation({ invitationId });
}

async function historyRows(db: TestDB, bookmarkId: string) {
  return await db
    .select()
    .from(itemHistory)
    .where(eq(itemHistory.itemId, bookmarkId));
}

async function readAllPages(
  api: APICallerType,
  bookmarkId: string,
  limit: number,
) {
  const pages: Entry[][] = [];
  let cursor: { changedAt: Date; id: string } | null = null;
  do {
    const res: Awaited<
      ReturnType<APICallerType["bookmarks"]["getBookmarkHistory"]>
    > = await api.bookmarks.getBookmarkHistory({ bookmarkId, limit, cursor });
    pages.push(res.entries);
    cursor = res.nextCursor;
    // Guards against a cursor that never advances
    expect(pages.length).toBeLessThanOrEqual(200);
  } while (cursor);
  return pages;
}

/** The documented order: changedAt desc, then id desc. */
function expectedOrder(entries: Entry[]) {
  return [...entries].sort(
    (a, b) =>
      b.changedAt.getTime() - a.changedAt.getTime() ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

describe("Bookmark history: capturing user changes", () => {
  test<CustomTestContext>("creating a bookmark records nothing", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const link = await api.bookmarks.createBookmark({
      type: BookmarkTypes.LINK,
      url: "https://example.com/new",
      title: "Title",
      note: "Note",
      summary: "Summary",
      favourited: true,
      archived: true,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    const text = await createText(api);

    expect(await getHistory(api, link.id)).toEqual([]);
    expect(await getHistory(api, text.id)).toEqual([]);
    expect(await db.select().from(itemHistory)).toEqual([]);
  });

  test<CustomTestContext>("records a single title change with full metadata", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await api.users.whoami();
    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "body",
      title: "Before",
    });

    const savedAt = at(10 * MINUTE + 456);
    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      title: "After",
    });

    const entries = await getHistory(api, bookmark.id);
    expect(entries).toEqual([
      {
        id: expect.any(String),
        changeId: expect.any(String),
        field: "title",
        oldValue: "Before",
        newValue: "After",
        source: "user",
        changedAt: savedAt,
        changedBy: { id: me.id, name: "Test User 1" },
      },
    ]);

    const rows = await historyRows(db, bookmark.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: entries[0].id,
      itemType: "bookmark",
      itemId: bookmark.id,
      ownerId: me.id,
      changeId: entries[0].changeId,
      fieldName: "title",
      source: "user",
      changedBy: me.id,
      changedAt: savedAt,
    });
  });

  test<CustomTestContext>("fields changed in one save share a changeId and timestamp", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createText(api);

    const savedAt = at(MINUTE);
    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      title: "T",
      note: "N",
      summary: "S",
      favourited: true,
      archived: true,
    });

    const entries = await getHistory(api, bookmark.id);
    expect(byField(entries)).toEqual([
      change("archived", false, true, me),
      change("favourited", false, true, me),
      change("note", null, "N", me),
      change("summary", null, "S", me),
      change("title", null, "T", me),
    ]);
    expect(new Set(entries.map((e) => e.changeId)).size).toBe(1);
    expect(entries.map((e) => e.changedAt)).toEqual(Array(5).fill(savedAt));
  });

  test<CustomTestContext>("records previous and new values of link metadata", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createLink(api, "https://example.com/old");
    await db
      .update(bookmarkLinks)
      .set({
        title: "Crawled title",
        description: "old description",
        author: "old author",
        publisher: "old publisher",
        datePublished: new Date("2020-01-02T03:04:05.000Z"),
        dateModified: new Date("2020-02-03T04:05:06.000Z"),
      })
      .where(eq(bookmarkLinks.id, bookmark.id));

    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      url: "https://example.com/new",
      description: "new description",
      author: null,
      publisher: "new publisher",
      datePublished: new Date("2021-01-02T03:04:05.678Z"),
      dateModified: null,
    });

    expect(byField(await getHistory(api, bookmark.id))).toEqual([
      change("author", "old author", null, me),
      change("dateModified", "2020-02-03T04:05:06.000Z", null, me),
      change(
        "datePublished",
        "2020-01-02T03:04:05.000Z",
        "2021-01-02T03:04:05.000Z",
        me,
      ),
      change("description", "old description", "new description", me),
      change("publisher", "old publisher", "new publisher", me),
      change("url", "https://example.com/old", "https://example.com/new", me),
    ]);
  });

  test<CustomTestContext>("records saved date changes as second precision ISO strings", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "dated",
      createdAt: new Date("2024-01-02T03:04:05.000Z"),
    });

    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      createdAt: new Date("2023-05-06T07:08:09.987Z"),
    });

    expect((await getHistory(api, bookmark.id)).map(simplify)).toEqual([
      change(
        "createdAt",
        "2024-01-02T03:04:05.000Z",
        "2023-05-06T07:08:09.000Z",
        me,
      ),
    ]);
  });

  test<CustomTestContext>("records text and asset content edits", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const text = await createText(api, "first text");
    const asset = await createAsset(db, me, "first content");

    await api.bookmarks.updateBookmark({
      bookmarkId: text.id,
      text: "second text",
    });
    await api.bookmarks.updateBookmark({
      bookmarkId: asset.id,
      assetContent: "second content",
    });

    expect((await getHistory(api, text.id)).map(simplify)).toEqual([
      change("text", "first text", "second text", me),
    ]);
    expect((await getHistory(api, asset.id)).map(simplify)).toEqual([
      change("assetContent", "first content", "second content", me),
    ]);
  });

  test<CustomTestContext>("deprecated updateBookmarkText records edits, including clearing", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createText(api, "v1");

    at(MINUTE);
    await api.bookmarks.updateBookmarkText({
      bookmarkId: bookmark.id,
      text: "v2",
    });
    at(2 * MINUTE);
    await api.bookmarks.updateBookmarkText({
      bookmarkId: bookmark.id,
      text: "v2",
    });
    at(3 * MINUTE);
    await api.bookmarks.updateBookmarkText({
      bookmarkId: bookmark.id,
      text: "",
    });

    expect((await getHistory(api, bookmark.id)).map(simplify)).toEqual([
      change("text", "v2", null, me),
      change("text", "v1", "v2", me),
    ]);
  });

  test<CustomTestContext>("updateTags records the full sorted tag sets before and after", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createText(api);

    at(MINUTE);
    await api.bookmarks.updateTags({
      bookmarkId: bookmark.id,
      attach: [
        { tagName: "beta", attachedBy: "ai" },
        { tagName: "#alpha" },
        { tagName: "Zeta" },
      ],
      detach: [],
    });
    at(2 * MINUTE);
    await api.bookmarks.updateTags({
      bookmarkId: bookmark.id,
      attach: [{ tagName: "gamma" }],
      detach: [{ tagName: "beta" }],
    });
    at(3 * MINUTE);
    await api.bookmarks.updateTags({
      bookmarkId: bookmark.id,
      attach: [],
      detach: [{ tagName: "gamma" }, { tagName: "alpha" }, { tagName: "Zeta" }],
    });

    const entries = await getHistory(api, bookmark.id);
    expect(entries.map(simplify)).toEqual([
      change("tags", ["Zeta", "alpha", "gamma"], [], me),
      change("tags", ["Zeta", "alpha", "beta"], ["Zeta", "alpha", "gamma"], me),
      change("tags", [], ["Zeta", "alpha", "beta"], me),
    ]);
    expect(new Set(entries.map((e) => e.changeId)).size).toBe(3);
  });

  test<CustomTestContext>("separate saves get distinct changeIds and A -> B -> A keeps both entries", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "body",
      title: "A",
    });

    const first = at(SECOND);
    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      title: "B",
      summary: "one",
      favourited: true,
    });
    const second = at(2 * SECOND);
    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      title: "A",
    });
    at(3 * SECOND);
    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      summary: "two",
    });
    at(4 * SECOND);
    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      favourited: false,
    });

    const entries = await getHistory(api, bookmark.id);
    expect(entries).toHaveLength(6);
    expect(entries.slice(0, 3).map(simplify)).toEqual([
      change("favourited", true, false, me),
      change("summary", "one", "two", me),
      change("title", "B", "A", me),
    ]);
    expect(byField(entries.slice(3))).toEqual([
      change("favourited", false, true, me),
      change("summary", null, "one", me),
      change("title", "A", "B", me),
    ]);
    expect(entries.slice(3).map((e) => e.changedAt)).toEqual([
      first,
      first,
      first,
    ]);
    expect(entries[2].changedAt).toEqual(second);
    expect(new Set(entries.slice(3).map((e) => e.changeId)).size).toBe(1);
    expect(new Set(entries.map((e) => e.changeId)).size).toBe(4);
  });

  test<CustomTestContext>("re-saving a link records every field that actually changed", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const url = "https://example.com/resave";
    const original = await api.bookmarks.createBookmark({
      type: BookmarkTypes.LINK,
      url,
      title: "Old title",
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    });

    const resave = await api.bookmarks.createBookmark({
      type: BookmarkTypes.LINK,
      url,
      title: "New title",
      favourited: true,
      note: "resave note",
      summary: "resave summary",
      createdAt: new Date("2024-02-02T00:00:00.000Z"),
    });
    expect(resave).toMatchObject({ id: original.id, alreadyExists: true });

    const entries = await getHistory(api, original.id);
    expect(byField(entries)).toEqual([
      change(
        "createdAt",
        "2024-01-01T00:00:00.000Z",
        "2024-02-02T00:00:00.000Z",
        me,
      ),
      change("favourited", false, true, me),
      change("note", null, "resave note", me),
      change("summary", null, "resave summary", me),
      change("title", "Old title", "New title", me),
    ]);
    expect(new Set(entries.map((e) => e.changeId)).size).toBe(1);
  });

  test<CustomTestContext>("a bare re-save records only the bumped date and unarchiving", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const url = "https://example.com/bare-resave";
    const original = await api.bookmarks.createBookmark({
      type: BookmarkTypes.LINK,
      url,
      title: "Keep me",
      note: "keep note",
      favourited: true,
      archived: true,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    });

    at(HOUR);
    await api.bookmarks.createBookmark({ type: BookmarkTypes.LINK, url });

    expect(byField(await getHistory(api, original.id))).toEqual([
      change("archived", true, false, me),
      change(
        "createdAt",
        "2024-01-01T00:00:00.000Z",
        "2025-06-01T13:00:00.000Z",
        me,
      ),
    ]);
  });

  test<CustomTestContext>("summarizeBookmark records the summary change once", async ({
    apiCallers,
  }) => {
    const inferFromText = vi.fn<InferenceClient["inferFromText"]>();
    inferFromText.mockResolvedValue({
      response: "Generated summary",
      totalTokens: 10,
    });
    vi.spyOn(InferenceClientFactory, "build").mockReturnValue({
      inferFromText,
      inferFromImage: vi.fn(),
      generateEmbeddingFromText: vi.fn(),
    });
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createText(api, "Something worth summarizing");

    at(MINUTE);
    await api.bookmarks.summarizeBookmark({ bookmarkId: bookmark.id });
    at(2 * MINUTE);
    await api.bookmarks.summarizeBookmark({ bookmarkId: bookmark.id });

    expect(inferFromText).toHaveBeenCalledTimes(2);
    expect((await getHistory(api, bookmark.id)).map(simplify)).toEqual([
      change("summary", null, "Generated summary", me),
    ]);
  });
});

describe("Bookmark history: no-op updates", () => {
  test<CustomTestContext>("re-submitting current or equivalent link values records nothing", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const url = "https://example.com/noop";
    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.LINK,
      url,
      createdAt: new Date("2024-01-02T03:04:05.000Z"),
    });

    const updates = [
      { favourited: false, archived: false },
      { title: null },
      { title: "" },
      { note: "" },
      { summary: null },
      { summary: "" },
      { description: null, author: "", publisher: null },
      { datePublished: null, dateModified: null },
      { url },
      { url: `  ${url}  ` },
      { createdAt: new Date("2024-01-02T03:04:05.999Z") },
      {},
    ];
    for (const update of updates) {
      await api.bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        ...update,
      });
      expect(
        await getHistory(api, bookmark.id),
        JSON.stringify(update),
      ).toEqual([]);
    }
  });

  test<CustomTestContext>("dates differing only in milliseconds are unchanged", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createLink(api);

    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      datePublished: new Date("2024-01-02T03:04:05.100Z"),
    });
    at(MINUTE);
    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      datePublished: new Date("2024-01-02T03:04:05.900Z"),
    });

    expect((await getHistory(api, bookmark.id)).map(simplify)).toEqual([
      change("datePublished", null, "2024-01-02T03:04:05.000Z", me),
    ]);
  });

  test<CustomTestContext>("a mixed save records only supplied fields that changed", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "same text",
      title: "same title",
      note: "untouched note",
      summary: "old summary",
    });

    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      title: "same title",
      text: "same text",
      summary: "new summary",
      archived: false,
    });
    // The existing behaviour ignores an empty text in updateBookmark
    await api.bookmarks.updateBookmark({ bookmarkId: bookmark.id, text: "" });

    expect((await getHistory(api, bookmark.id)).map(simplify)).toEqual([
      change("summary", "old summary", "new summary", me),
    ]);
    expect(await historyRows(db, bookmark.id)).toHaveLength(1);
  });

  test<CustomTestContext>("tag operations that don't change the tag set record nothing", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createText(api);
    await api.tags.create({ name: "unattached" });
    await api.bookmarks.updateTags({
      bookmarkId: bookmark.id,
      attach: [{ tagName: "kept" }],
      detach: [],
    });
    const before = await getHistory(api, bookmark.id);
    expect(before).toHaveLength(1);

    at(MINUTE);
    const operations = [
      { attach: [{ tagName: "kept" }], detach: [] },
      { attach: [], detach: [{ tagName: "unattached" }] },
      { attach: [], detach: [{ tagName: "does-not-exist" }] },
      { attach: [{ tagName: "kept" }], detach: [{ tagName: "kept" }] },
      { attach: [], detach: [] },
    ];
    for (const op of operations) {
      await api.bookmarks.updateTags({ bookmarkId: bookmark.id, ...op });
      expect(await getHistory(api, bookmark.id), JSON.stringify(op)).toEqual(
        before,
      );
    }
  });

  test<CustomTestContext>("re-saves that write nothing or change nothing record nothing", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const url = "https://example.com/noop-resave";
    const createdAt = new Date("2024-01-01T00:00:00.000Z");
    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.LINK,
      url,
      title: "T",
      createdAt,
    });

    for (const source of ["rss", "import"] as const) {
      await api.bookmarks.createBookmark({
        type: BookmarkTypes.LINK,
        url,
        source,
        title: "Ignored",
        note: "Ignored",
        favourited: true,
      });
    }
    await api.bookmarks.createBookmark({
      type: BookmarkTypes.LINK,
      url,
      title: "T",
      note: "",
      favourited: false,
      createdAt,
    });

    expect(await getHistory(api, bookmark.id)).toEqual([]);
  });
});

describe("Bookmark history: note grouping", () => {
  async function saveNote(
    api: APICallerType,
    bookmarkId: string,
    offsetMs: number,
    note: string,
  ) {
    const now = at(offsetMs);
    await api.bookmarks.updateBookmark({ bookmarkId, note });
    return now;
  }

  test<CustomTestContext>("quick note saves merge into one entry using a sliding window", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createText(api);

    await saveNote(api, bookmark.id, 0, "d");
    const [first] = await getHistory(api, bookmark.id);
    await saveNote(api, bookmark.id, 4 * MINUTE, "dr");
    // 8 minutes after the first save, but only 4 after the latest merged one
    const last = at(8 * MINUTE);
    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      note: "draft",
      title: "same save",
    });

    const entries = await getHistory(api, bookmark.id);
    expect(byField(entries)).toEqual([
      change("note", null, "draft", me),
      change("title", null, "same save", me),
    ]);
    expect(entries.map((e) => e.changedAt)).toEqual([last, last]);
    expect(entries[0].changeId).toBe(entries[1].changeId);
    expect(entries[0].changeId).not.toBe(first.changeId);
    expect(await historyRows(db, bookmark.id)).toHaveLength(2);
  });

  test<CustomTestContext>("the five minute window is inclusive", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const inside = await createText(api, "inside");
    const outside = await createText(api, "outside");

    await saveNote(api, inside.id, 0, "a");
    await saveNote(api, inside.id, 5 * MINUTE, "b");
    await saveNote(api, outside.id, 10 * MINUTE, "a");
    await saveNote(api, outside.id, 15 * MINUTE + 1, "b");

    expect((await getHistory(api, inside.id)).map(simplify)).toEqual([
      change("note", null, "b", me),
    ]);
    const separate = await getHistory(api, outside.id);
    expect(separate.map(simplify)).toEqual([
      change("note", "a", "b", me),
      change("note", null, "a", me),
    ]);
    expect(separate[0].changeId).not.toBe(separate[1].changeId);
  });

  test<CustomTestContext>("reverting a grouped note to its original value removes the entry", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "body",
      note: "original",
    });

    // An older entry which must survive the revert
    await saveNote(api, bookmark.id, 0, "kept");
    await saveNote(api, bookmark.id, 10 * MINUTE, "temporary");
    await saveNote(api, bookmark.id, 11 * MINUTE, "kept");

    expect((await getHistory(api, bookmark.id)).map(simplify)).toEqual([
      change("note", "original", "kept", me),
    ]);
    expect(await historyRows(db, bookmark.id)).toHaveLength(1);
  });

  test<CustomTestContext>("merges into the latest note entry even with other changes in between", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createText(api);

    await saveNote(api, bookmark.id, 0, "a");
    at(MINUTE);
    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      title: "between",
    });
    await saveNote(api, bookmark.id, 2 * MINUTE, "ab");

    expect((await getHistory(api, bookmark.id)).map(simplify)).toEqual([
      change("note", null, "ab", me),
      change("title", null, "between", me),
    ]);
  });

  test<CustomTestContext>("does not merge when the note was changed without history in between", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createText(api);

    await saveNote(api, bookmark.id, 0, "a");
    await db
      .update(bookmarks)
      .set({ note: "external" })
      .where(eq(bookmarks.id, bookmark.id));
    await saveNote(api, bookmark.id, MINUTE, "b");

    expect((await getHistory(api, bookmark.id)).map(simplify)).toEqual([
      change("note", "external", "b", me),
      change("note", null, "a", me),
    ]);
  });

  test<CustomTestContext>("does not merge into another source's or another user's entry", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const other = await userId(apiCallers[1]);

    for (const previous of [
      { source: "ai" as const, changedBy: null },
      { source: "user" as const, changedBy: other },
    ]) {
      const bookmark = await createText(api);
      at(0);
      recordBookmarkChanges(db, {
        bookmarkId: bookmark.id,
        ownerId: me,
        before: { note: null },
        after: { note: "a" },
        ...previous,
      });
      await db
        .update(bookmarks)
        .set({ note: "a" })
        .where(eq(bookmarks.id, bookmark.id));
      await saveNote(api, bookmark.id, MINUTE, "b");

      expect((await getHistory(api, bookmark.id)).map(simplify)).toEqual([
        change("note", "a", "b", me),
        change("note", null, "a", previous.changedBy, previous.source),
      ]);
    }
  });

  test<CustomTestContext>("a non-user note change is not merged into a user entry", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createText(api);

    await saveNote(api, bookmark.id, 0, "a");
    at(MINUTE);
    recordBookmarkChanges(db, {
      bookmarkId: bookmark.id,
      ownerId: me,
      before: { note: "a" },
      after: { note: "b" },
      source: "ai",
      changedBy: null,
    });

    expect((await getHistory(api, bookmark.id)).map(simplify)).toEqual([
      change("note", "a", "b", null, "ai"),
      change("note", null, "a", me),
    ]);
  });
});

describe("Bookmark history: authorization and privacy", () => {
  const SECRET_OLD_NOTE = "SECRET-NOTE-OLD-7f3a";
  const SECRET_NEW_NOTE = "SECRET-NOTE-NEW-9c1d";
  const PRIVATE_FIELDS = ["note", "favourited", "archived"];

  /** A bookmark of user 0 with both public and owner-only history. */
  async function bookmarkWithMixedHistory(owner: APICallerType) {
    const bookmark = await owner.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "body",
      note: SECRET_OLD_NOTE,
    });
    at(MINUTE);
    await owner.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      title: "public title",
      note: SECRET_NEW_NOTE,
      favourited: true,
    });
    at(10 * MINUTE);
    await owner.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      archived: true,
    });
    return bookmark;
  }

  test<CustomTestContext>("signed out callers are rejected", async ({
    apiCallers,
    unauthedAPICaller,
  }) => {
    const bookmark = await createText(apiCallers[0]);

    await expect(
      unauthedAPICaller.bookmarks.getBookmarkHistory({
        bookmarkId: bookmark.id,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  test<CustomTestContext>("unrelated users and unknown bookmarks get NOT_FOUND", async ({
    apiCallers,
  }) => {
    const [owner, collaborator, stranger] = apiCallers;
    const bookmark = await bookmarkWithMixedHistory(owner);
    const otherBookmark = await createText(owner, "other");
    await createSharedList(owner, [bookmark.id]);
    const otherList = await createSharedList(owner, [otherBookmark.id], "b");
    await share(owner, collaborator, otherList.id, "editor");

    for (const caller of [stranger, collaborator]) {
      await expect(
        caller.bookmarks.getBookmarkHistory({ bookmarkId: bookmark.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(
      owner.bookmarks.getBookmarkHistory({ bookmarkId: "does-not-exist" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test<CustomTestContext>("the owner sees private field history", async ({
    apiCallers,
  }) => {
    const owner = apiCallers[0];
    const me = await userId(owner);
    const bookmark = await bookmarkWithMixedHistory(owner);

    const entries = await getHistory(owner, bookmark.id);
    expect(entries[0] && simplify(entries[0])).toEqual(
      change("archived", false, true, me),
    );
    expect(byField(entries.slice(1))).toEqual([
      change("favourited", false, true, me),
      change("note", SECRET_OLD_NOTE, SECRET_NEW_NOTE, me),
      change("title", null, "public title", me),
    ]);
  });

  for (const role of ["viewer", "editor"] as const) {
    test<CustomTestContext>(`a ${role} sees public history from before joining, without private fields`, async ({
      apiCallers,
    }) => {
      const [owner, collaborator] = apiCallers;
      const me = await userId(owner);
      const bookmark = await bookmarkWithMixedHistory(owner);
      const list = await createSharedList(owner, [bookmark.id]);
      at(HOUR);
      await share(owner, collaborator, list.id, role);

      const res = await collaborator.bookmarks.getBookmarkHistory({
        bookmarkId: bookmark.id,
      });

      expect(res.nextCursor).toBeNull();
      expect(res.entries.map(simplify)).toEqual([
        change("title", null, "public title", me),
      ]);
      expect(res.entries[0].changedBy).toEqual({
        id: me,
        name: "Test User 1",
      });
      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain(SECRET_OLD_NOTE);
      expect(serialized).not.toContain(SECRET_NEW_NOTE);
      for (const field of PRIVATE_FIELDS) {
        expect(serialized).not.toContain(`"${field}"`);
      }
    });
  }

  test<CustomTestContext>("private entries are filtered before pagination so pages stay full", async ({
    apiCallers,
  }) => {
    const [owner, collaborator] = apiCallers;
    const bookmark = await createText(owner);
    // Oldest entries are private only
    await owner.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      archived: true,
    });
    for (let i = 1; i <= 5; i++) {
      at(i * 10 * MINUTE);
      await owner.bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: `title ${i}`,
      });
      for (let j = 0; j < 3; j++) {
        at(i * 10 * MINUTE + (j + 1) * SECOND);
        await owner.bookmarks.updateBookmark({
          bookmarkId: bookmark.id,
          favourited: j % 2 === 0,
        });
      }
      at(i * 10 * MINUTE + 10 * SECOND);
      await owner.bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        note: `SECRET-PAGE-NOTE-${i}`,
      });
    }
    const list = await createSharedList(owner, [bookmark.id]);
    await share(owner, collaborator, list.id, "viewer");

    const pages = await readAllPages(collaborator, bookmark.id, 2);

    expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
    expect(pages.flat().map((e) => [e.field, e.newValue])).toEqual(
      [5, 4, 3, 2, 1].map((i) => ["title", `title ${i}`]),
    );
    expect(JSON.stringify(pages)).not.toContain("SECRET-PAGE-NOTE");

    // A page exactly the size of the visible set must not advertise more
    const exact = await collaborator.bookmarks.getBookmarkHistory({
      bookmarkId: bookmark.id,
      limit: 5,
    });
    expect(exact.entries).toHaveLength(5);
    expect(exact.nextCursor).toBeNull();
  });

  test<CustomTestContext>("a collaborator gets an empty result when all history is private", async ({
    apiCallers,
  }) => {
    const [owner, collaborator] = apiCallers;
    const bookmark = await createText(owner);
    await owner.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      note: SECRET_NEW_NOTE,
      favourited: true,
      archived: true,
    });
    const list = await createSharedList(owner, [bookmark.id]);
    await share(owner, collaborator, list.id, "editor");

    await expect(
      collaborator.bookmarks.getBookmarkHistory({
        bookmarkId: bookmark.id,
        limit: 1,
      }),
    ).resolves.toEqual({ entries: [], nextCursor: null });
  });

  test<CustomTestContext>("a pending invitation does not grant access", async ({
    apiCallers,
  }) => {
    const [owner, invitee] = apiCallers;
    const bookmark = await bookmarkWithMixedHistory(owner);
    const list = await createSharedList(owner, [bookmark.id]);
    await invite(owner, invitee, list.id, "viewer");

    await expect(
      invitee.bookmarks.getBookmarkHistory({ bookmarkId: bookmark.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test<CustomTestContext>("access ends when the collaborator or the bookmark is removed", async ({
    apiCallers,
  }) => {
    const [owner, removed, remaining] = apiCallers;
    const bookmark = await bookmarkWithMixedHistory(owner);
    const list = await createSharedList(owner, [bookmark.id]);
    await share(owner, removed, list.id, "viewer");
    await share(owner, remaining, list.id, "viewer");
    const input = { bookmarkId: bookmark.id };
    expect(
      (await removed.bookmarks.getBookmarkHistory(input)).entries,
    ).toHaveLength(1);

    await owner.lists.removeCollaborator({
      listId: list.id,
      userId: await userId(removed),
    });
    await expect(
      removed.bookmarks.getBookmarkHistory(input),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (await remaining.bookmarks.getBookmarkHistory(input)).entries,
    ).toHaveLength(1);

    await owner.lists.removeFromList({
      listId: list.id,
      bookmarkId: bookmark.id,
    });
    await expect(
      remaining.bookmarks.getBookmarkHistory(input),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test<CustomTestContext>("an editor cannot edit another user's bookmark and nothing is recorded", async ({
    apiCallers,
    db,
  }) => {
    const [owner, editor] = apiCallers;
    const bookmark = await createText(owner, "owner text");
    const list = await createSharedList(owner, [bookmark.id]);
    await share(owner, editor, list.id, "editor");
    const bookmarkId = bookmark.id;

    await expect(
      editor.bookmarks.updateBookmark({ bookmarkId, title: "hijack" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      editor.bookmarks.updateBookmarkText({ bookmarkId, text: "hijack" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      editor.bookmarks.updateTags({
        bookmarkId,
        attach: [{ tagName: "hijack" }],
        detach: [],
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(await historyRows(db, bookmarkId)).toEqual([]);
  });

  for (const scope of ["bookmarks:read", "bookmarks:readwrite"] as const) {
    test<CustomTestContext>(`an API key with ${scope} can read history`, async ({
      apiCallers,
      db,
    }) => {
      const owner = apiCallers[0];
      const bookmark = await bookmarkWithMixedHistory(owner);
      const key = await owner.apiKeys.create({ name: scope, scopes: [scope] });
      const keyCaller = await getApiKeyCallerForPlainKey(db, key.key);

      expect(await getHistory(keyCaller, bookmark.id)).toHaveLength(4);
    });
  }

  test<CustomTestContext>("an API key without bookmarks access is refused", async ({
    apiCallers,
    db,
  }) => {
    const owner = apiCallers[0];
    const bookmark = await bookmarkWithMixedHistory(owner);
    const key = await owner.apiKeys.create({
      name: "No bookmarks",
      scopes: ["users:readwrite", "lists:readwrite", "tags:readwrite"],
    });
    const keyCaller = await getApiKeyCallerForPlainKey(db, key.key);

    await expect(
      keyCaller.bookmarks.getBookmarkHistory({ bookmarkId: bookmark.id }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("bookmarks:read"),
    });
  });
});

describe("Bookmark history: ordering and pagination", () => {
  test<CustomTestContext>("returns entries newest first with a default page size of 20", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createText(api);
    const other = await createText(api, "other");
    // 1ms apart: ordering needs millisecond precision
    for (let i = 1; i <= 25; i++) {
      at(i);
      await api.bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: `title ${i}`,
      });
      await api.bookmarks.updateBookmark({
        bookmarkId: other.id,
        title: `other ${i}`,
      });
    }

    const first = await api.bookmarks.getBookmarkHistory({
      bookmarkId: bookmark.id,
    });
    expect(first.entries.map((e) => e.newValue)).toEqual(
      Array.from({ length: 20 }, (_, i) => `title ${25 - i}`),
    );
    expect(first.entries.map((e) => e.changedAt.getTime())).toEqual(
      Array.from({ length: 20 }, (_, i) => T0 + 25 - i),
    );
    expect(first.nextCursor).not.toBeNull();

    const second = await api.bookmarks.getBookmarkHistory({
      bookmarkId: bookmark.id,
      cursor: first.nextCursor,
    });
    expect(second.entries.map((e) => e.newValue)).toEqual(
      [5, 4, 3, 2, 1].map((i) => `title ${i}`),
    );
    expect(second.nextCursor).toBeNull();
  });

  test<CustomTestContext>("paginates per entry without gaps or duplicates when timestamps tie", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createText(api);
    at(0);
    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      title: "older",
    });
    // Two saves at the exact same instant: 7 tied entries
    at(MINUTE);
    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      title: "tied",
      summary: "tied",
      note: "tied",
      favourited: true,
      archived: true,
    });
    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      title: "tied again",
      summary: "tied again",
    });
    at(2 * MINUTE);
    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      title: "newer",
    });

    const all = await getHistory(api, bookmark.id);
    expect(all).toHaveLength(9);
    expect(all.map((e) => e.id)).toEqual(expectedOrder(all).map((e) => e.id));
    expect(all[0].newValue).toBe("newer");
    expect(all[8].newValue).toBe("older");

    for (const limit of [1, 2, 3, 4, 8, 9]) {
      const pages = await readAllPages(api, bookmark.id, limit);
      expect(
        pages.flat().map((e) => e.id),
        `limit ${limit}`,
      ).toEqual(all.map((e) => e.id));
      for (const page of pages.slice(0, -1)) {
        expect(page).toHaveLength(limit);
      }
      expect(pages).toHaveLength(Math.ceil(9 / limit));
    }
  });

  test<CustomTestContext>("rejects limits outside 1..100", async ({
    apiCallers,
  }) => {
    const api = apiCallers[0];
    const bookmark = await createText(api);

    for (const limit of [0, 101]) {
      await expect(
        api.bookmarks.getBookmarkHistory({ bookmarkId: bookmark.id, limit }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    for (const limit of [1, 100]) {
      await expect(
        api.bookmarks.getBookmarkHistory({ bookmarkId: bookmark.id, limit }),
      ).resolves.toEqual({ entries: [], nextCursor: null });
    }
  });
});

describe("Bookmark history: transactions and lifecycle", () => {
  test<CustomTestContext>("a rejected update changes nothing and records nothing", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "body",
      title: "original",
    });
    await api.bookmarks.updateBookmark({
      bookmarkId: bookmark.id,
      note: "first note",
    });
    const before = await getHistory(api, bookmark.id);

    // Within the grouping window: the existing note entry must stay untouched
    at(MINUTE);
    await expect(
      api.bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "should not stick",
        note: "should not stick",
        url: "https://example.com/nope",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(
      await api.bookmarks.getBookmark({ bookmarkId: bookmark.id }),
    ).toMatchObject({ title: "original", note: "first note" });
    expect(await getHistory(api, bookmark.id)).toEqual(before);
    expect(before.map(simplify)).toEqual([
      change("note", null, "first note", me),
    ]);
    expect(await historyRows(db, bookmark.id)).toHaveLength(1);
  });

  test<CustomTestContext>("an edit is rolled back if its history cannot be written", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "original text",
      title: "original",
    });
    db.run(
      sql.raw(
        `CREATE TRIGGER fail_history BEFORE INSERT ON "${getTableName(itemHistory)}" BEGIN SELECT RAISE(ABORT, 'history write failed'); END`,
      ),
    );

    await expect(
      api.bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "changed",
      }),
    ).rejects.toThrow();
    await expect(
      api.bookmarks.updateBookmarkText({
        bookmarkId: bookmark.id,
        text: "changed text",
      }),
    ).rejects.toThrow();
    await expect(
      api.bookmarks.updateTags({
        bookmarkId: bookmark.id,
        attach: [{ tagName: "changed" }],
        detach: [],
      }),
    ).rejects.toThrow();

    const current = await api.bookmarks.getBookmark({
      bookmarkId: bookmark.id,
    });
    expect(current.title).toBe("original");
    expect(current.content).toMatchObject({ text: "original text" });
    expect(current.tags).toEqual([]);
    expect(await historyRows(db, bookmark.id)).toEqual([]);
  });

  test<CustomTestContext>("the recorder participates in the caller's transaction", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createText(api);

    expect(() =>
      db.transaction((tx) => {
        recordBookmarkChanges(tx, {
          bookmarkId: bookmark.id,
          ownerId: me,
          before: { title: null },
          after: { title: "rolled back" },
          source: "ai",
          changedBy: null,
        });
        throw new Error("abort");
      }),
    ).toThrow("abort");

    expect(await historyRows(db, bookmark.id)).toEqual([]);
  });

  test<CustomTestContext>("deleting a bookmark deletes only its history", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const doomed = await createText(api, "doomed");
    const survivor = await createText(api, "survivor");
    for (const bookmark of [doomed, survivor]) {
      await api.bookmarks.updateBookmark({
        bookmarkId: bookmark.id,
        title: "t",
        note: "n",
      });
    }
    expect(await historyRows(db, doomed.id)).toHaveLength(2);

    await api.bookmarks.deleteBookmark({ bookmarkId: doomed.id });

    expect(await historyRows(db, doomed.id)).toEqual([]);
    expect(await historyRows(db, survivor.id)).toHaveLength(2);
  });

  test<CustomTestContext>("deleting users removes owned history and anonymizes their changes elsewhere", async ({
    apiCallers,
    db,
  }) => {
    const [first, second] = apiCallers;
    const firstId = await userId(first);
    const secondId = await userId(second);
    const kept = await createText(first, "kept");
    const removed = await createText(second, "removed");
    await second.bookmarks.updateBookmark({
      bookmarkId: removed.id,
      title: "owned by second",
    });
    recordBookmarkChanges(db, {
      bookmarkId: kept.id,
      ownerId: firstId,
      before: { title: "a" },
      after: { title: "b" },
      source: "user",
      changedBy: secondId,
    });

    await db.delete(users).where(eq(users.id, secondId));

    expect(
      await db
        .select()
        .from(itemHistory)
        .where(eq(itemHistory.ownerId, secondId)),
    ).toEqual([]);
    expect(await historyRows(db, removed.id)).toEqual([]);
    const entries = await getHistory(first, kept.id);
    expect(entries.map(simplify)).toEqual([change("title", "a", "b", null)]);
    expect(entries[0].changedBy).toBeNull();
  });
});

describe("Bookmark history: automated changes", () => {
  async function engineFor(
    db: TestDB,
    ownerId: string,
    bookmarkId: string,
  ): Promise<RuleEngine> {
    const ctx: AuthedContext = {
      user: { id: ownerId, role: "user" },
      db,
      req: { ip: null },
    };
    const engine = await RuleEngine.forBookmark(ctx, bookmarkId);
    expect(engine).not.toBeNull();
    return engine!;
  }

  async function runAction(
    db: TestDB,
    ownerId: string,
    bookmarkId: string,
    action: RuleEngineAction,
  ) {
    const engine = await engineFor(db, ownerId, bookmarkId);
    await engine.executeAction(action);
  }

  test<CustomTestContext>("rule tag actions record the full tag sets with source rule", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createText(api);
    const existing = await api.tags.create({ name: "manual" });
    const added = await api.tags.create({ name: "Auto" });
    await api.bookmarks.updateTags({
      bookmarkId: bookmark.id,
      attach: [{ tagId: existing.id }],
      detach: [],
    });

    at(MINUTE);
    await runAction(db, me, bookmark.id, { type: "addTag", tagId: added.id });
    at(2 * MINUTE);
    await runAction(db, me, bookmark.id, {
      type: "removeTag",
      tagId: existing.id,
    });

    expect((await getHistory(api, bookmark.id)).map(simplify)).toEqual([
      change("tags", ["Auto", "manual"], ["Auto"], null, "rule"),
      change("tags", ["manual"], ["Auto", "manual"], null, "rule"),
      change("tags", [], ["manual"], me),
    ]);
  });

  test<CustomTestContext>("rule favourite and archive actions are recorded", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createText(api);

    at(MINUTE);
    await runAction(db, me, bookmark.id, { type: "favouriteBookmark" });
    at(2 * MINUTE);
    await runAction(db, me, bookmark.id, { type: "archiveBookmark" });

    const entries = await getHistory(api, bookmark.id);
    expect(entries.map(simplify)).toEqual([
      change("archived", false, true, null, "rule"),
      change("favourited", false, true, null, "rule"),
    ]);
    expect(entries.map((e) => e.changedBy)).toEqual([null, null]);
  });

  test<CustomTestContext>("rule actions that change nothing record nothing", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await api.bookmarks.createBookmark({
      type: BookmarkTypes.TEXT,
      text: "body",
      favourited: true,
      archived: true,
    });
    const attached = await api.tags.create({ name: "attached" });
    const absent = await api.tags.create({ name: "absent" });
    await api.bookmarks.updateTags({
      bookmarkId: bookmark.id,
      attach: [{ tagId: attached.id }],
      detach: [],
    });
    const before = await getHistory(api, bookmark.id);
    expect(before).toHaveLength(1);

    at(MINUTE);
    const actions: RuleEngineAction[] = [
      { type: "addTag", tagId: attached.id },
      { type: "removeTag", tagId: absent.id },
      { type: "favouriteBookmark" },
      { type: "archiveBookmark" },
    ];
    for (const action of actions) {
      await runAction(db, me, bookmark.id, action);
    }

    expect(await getHistory(api, bookmark.id)).toEqual(before);
  });

  test<CustomTestContext>("history from a triggered rule respects collaborator visibility", async ({
    apiCallers,
    db,
  }) => {
    const [owner, viewer] = apiCallers;
    const me = await userId(owner);
    const bookmark = await createText(owner);
    const tag = await owner.tags.create({ name: "ruled" });
    const [rule] = await db
      .insert(ruleEngineRulesTable)
      .values({
        userId: me,
        name: "rule",
        description: "",
        enabled: true,
        event: JSON.stringify({ type: "bookmarkAdded" }),
        condition: JSON.stringify({ type: "alwaysTrue" }),
      })
      .returning();
    const actions: RuleEngineAction[] = [
      { type: "addTag", tagId: tag.id },
      { type: "favouriteBookmark" },
      { type: "archiveBookmark" },
    ];
    await db.insert(ruleEngineActionsTable).values(
      actions.map((action) => ({
        ruleId: rule.id,
        userId: me,
        action: JSON.stringify(action),
      })),
    );

    const engine = await engineFor(db, me, bookmark.id);
    const results = await engine.onEvent({ type: "bookmarkAdded" });
    expect(results.map((r) => r.type)).toEqual([
      "success",
      "success",
      "success",
    ]);

    expect(byField(await getHistory(owner, bookmark.id))).toEqual([
      change("archived", false, true, null, "rule"),
      change("favourited", false, true, null, "rule"),
      change("tags", [], ["ruled"], null, "rule"),
    ]);

    const list = await createSharedList(owner, [bookmark.id]);
    await share(owner, viewer, list.id, "viewer");
    expect((await getHistory(viewer, bookmark.id)).map(simplify)).toEqual([
      change("tags", [], ["ruled"], null, "rule"),
    ]);
  });

  test<CustomTestContext>("AI changes are recorded without a user, including first population", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createText(api);

    const result = recordBookmarkChanges(db, {
      bookmarkId: bookmark.id,
      ownerId: me,
      before: { tags: [], summary: null },
      after: { tags: ["b", "a", "b"], summary: "AI summary" },
      source: "ai",
      changedBy: null,
      changeId: "ai-change-1",
    });
    // Synchronous so it can be used inside better-sqlite3 transactions
    expect(result).toBeUndefined();

    const entries = await getHistory(api, bookmark.id);
    expect(byField(entries)).toEqual([
      change("summary", null, "AI summary", null, "ai"),
      change("tags", [], ["a", "b"], null, "ai"),
    ]);
    expect(entries.map((e) => e.changeId)).toEqual([
      "ai-change-1",
      "ai-change-1",
    ]);
    expect(entries.map((e) => e.changedAt)).toEqual([
      new Date(T0),
      new Date(T0),
    ]);
  });

  test<CustomTestContext>("crawler first-time population of empty fields records nothing", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createLink(api);

    recordBookmarkChanges(db, {
      bookmarkId: bookmark.id,
      ownerId: me,
      before: {
        linkTitle: null,
        description: "",
        author: undefined,
        publisher: null,
        datePublished: null,
      },
      after: {
        linkTitle: "Title",
        description: "Description",
        author: "Author",
        publisher: "Publisher",
        datePublished: new Date("2024-01-01T00:00:00.000Z"),
        dateModified: new Date("2024-01-01T00:00:00.000Z"),
      },
      source: "crawler",
      changedBy: null,
      skipInitialPopulation: true,
    });

    expect(await historyRows(db, bookmark.id)).toEqual([]);
  });

  test<CustomTestContext>("crawler replacements and removals are recorded", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createLink(api);

    recordBookmarkChanges(db, {
      bookmarkId: bookmark.id,
      ownerId: me,
      before: {
        linkTitle: "Old title",
        description: "Old description",
        author: null,
        publisher: "Same publisher",
        datePublished: new Date("2024-01-01T00:00:00.000Z"),
        dateModified: new Date("2024-01-01T00:00:00.100Z"),
      },
      after: {
        linkTitle: "New title",
        description: null,
        author: "First author",
        publisher: "Same publisher",
        datePublished: new Date("2024-03-01T00:00:00.500Z"),
        dateModified: new Date("2024-01-01T00:00:00.900Z"),
      },
      source: "crawler",
      changedBy: null,
      skipInitialPopulation: true,
    });

    expect(byField(await getHistory(api, bookmark.id))).toEqual([
      change(
        "datePublished",
        "2024-01-01T00:00:00.000Z",
        "2024-03-01T00:00:00.000Z",
        null,
        "crawler",
      ),
      change("description", "Old description", null, null, "crawler"),
      change("linkTitle", "Old title", "New title", null, "crawler"),
    ]);
  });

  test<CustomTestContext>("asset extraction records only changes to existing content", async ({
    apiCallers,
    db,
  }) => {
    const api = apiCallers[0];
    const me = await userId(api);
    const bookmark = await createAsset(db, me, "irrelevant");
    const extract = (
      offsetMs: number,
      before: string | null,
      after: string | null,
    ) => {
      at(offsetMs);
      recordBookmarkChanges(db, {
        bookmarkId: bookmark.id,
        ownerId: me,
        before: { assetContent: before },
        after: { assetContent: after },
        source: "extraction",
        changedBy: null,
        skipInitialPopulation: true,
      });
    };

    extract(0, null, "first");
    extract(SECOND, "first", "first");
    extract(2 * SECOND, "first", "second");
    extract(3 * SECOND, "second", "");

    expect((await getHistory(api, bookmark.id)).map(simplify)).toEqual([
      change("assetContent", "second", null, null, "extraction"),
      change("assetContent", "first", "second", null, "extraction"),
    ]);
  });
});
