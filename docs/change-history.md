# Bookmark change history: summary of work

People collaborating in shared lists can now see how a bookmark changed over
time: which field, its old and new value, when, and who (or what) made the
change. The exact contract is in [`change-history-spec.md`](./change-history-spec.md).

## Scope choice

- **Item type: bookmarks.** Bookmarks cover links, text notes and assets, and
  they're what people see in shared lists. Storage and diffing are generic
  (`itemType` + `itemId`), so another item type can be added later without a
  new table.
- **Reuses existing architecture.** It adds a Drizzle table and migration, a
  model class next to `models/bookmarks.ts`, a procedure on the existing
  `bookmarks` tRPC router guarded by the existing `ensureBookmarkAccess`
  middleware, and a collapsible section in the existing preview sidebar built
  like `HighlightsBox`.

## What works

| Area | Status |
| --- | --- |
| `itemHistory` table and migration `0098_add_item_history.sql` | Done. Applied automatically by the normal migration step. |
| Capture: `updateBookmark`, `updateBookmarkText`, `updateTags`, re-saving an existing link, `summarizeBookmark` | Done. History is written in the **same transaction** as the edit. |
| Capture of automated changes: AI summary worker, AI tagging worker, rule engine (add/remove tag, favourite, archive) | Done. Recorded as `source: "ai"` (no user) or `source: "rule"` (attributed to the owner). |
| No-op updates | Write nothing. The diff is computed from the stored values before and after the write, not from the request. |
| Note autosave grouping | Saves by the same user within 5 minutes merge into one entry. If the note ends up unchanged, the entry is removed. |
| Read API `bookmarks.getBookmarkHistory` | Done. Paginated (cursor), newest first, same access rule as `getBookmark`, API keys need the `bookmarks` read scope. |
| Privacy | `note`, `favourited`, `archived` are owner-only, matching what `Bookmark.asZBookmark()` hides. Both old and new values are filtered in SQL before pagination. Fields with no visibility rule are hidden from everyone. |
| Deletion | Deleting a bookmark deletes its history in the same transaction. Deleting the owner cascades. Deleting the user who made a change sets `changedBy` to null. |
| UI | Collapsible **History** section at the bottom of the bookmark details, in both the wide sidebar and the narrow Details tab. Shows a field label, old value (struck through) and new value, author avatar or AI/Rule marker, relative time with the exact time on hover, "Show more" for long text, and "Load older changes". It refreshes after edits and when background changes bump `modifiedAt`. |

## Not done / limitations

- Not recorded: the crawler filling in metadata, tag rename/merge/delete from
  the Tags page, list membership, highlights, attachments and admin tools.
  Because of that, one entry's new value may not match the next entry's old
  value.
- Only English UI strings were added. Other locales fall back to English
  (the `fill-translations` skill can fill them).
- No history UI in the mobile app or browser extension. The tRPC endpoint
  works for them; the REST/OpenAPI layer doesn't expose it.
- No retention limit on history rows.
- `updateBookmark`/`updateTags` remain owner-only (unchanged), so in practice
  collaborators read history but don't create it.

## Files

**New**
- `packages/db/drizzle/0098_add_item_history.sql` (+ `meta/0098_snapshot.json`): migration
- `packages/shared/types/itemHistory.ts`: request/response zod schemas
- `packages/trpc/lib/itemHistory.ts`: field list, visibility, normalize/diff/encode/decode (pure)
- `packages/trpc/models/itemHistory.ts`: snapshot, `trackBookmarkChanges`, note grouping, read query, delete
- `apps/web/components/dashboard/preview/HistoryBox.tsx`: UI
- `apps/web/components/dashboard/preview/historyFormat.ts`: labels and value formatting
- Tests: `packages/trpc/routers/itemHistory.test.ts`, `packages/trpc/lib/itemHistory.test.ts`, `apps/web/components/dashboard/preview/historyFormat.test.ts`
- Docs: this file, `change-history-spec.md`, `change-history-demo/*.png`

**Changed**
- `packages/db/schema.ts`: `itemHistory` table + relation
- `packages/trpc/routers/bookmarks.ts`: capture in mutations, new `getBookmarkHistory` query
- `packages/trpc/models/bookmarks.ts`: delete history with the bookmark
- `packages/trpc/lib/ruleEngine.ts`: rule actions recorded with `source: "rule"`
- `apps/workers/workers/inference/summarize.ts`, `tagging.ts`: AI changes recorded with `source: "ai"`
- `packages/shared-react/hooks/bookmarks.ts`: refresh history after edits
- `apps/web/components/dashboard/preview/BookmarkPreview.tsx`: add `<HistoryBox>`
- `apps/web/lib/i18n/locales/en/translation.json`: `preview.history.*` strings
- `packages/trpc/lib/__tests__/ruleEngine.test.ts`: two rule-engine history tests

## How it works

```
mutation ──► db.transaction(tx =>
               ItemHistory.trackBookmarkChanges(tx, id, actor, () => {
                 snapshot before ──► existing write(s) ──► snapshot after
                 diffHistoryFields(before, after) ──► insert rows (or merge note)
               }))
```

The repo runs on better-sqlite3, so transactions are synchronous. Keeping the
history helpers synchronous lets them run inside the caller's transaction, so
a failed edit leaves no history behind.

Values are stored as JSON text. That keeps `null` vs `""`, `false`, dates (ISO)
and tag lists (sorted names) distinct. Dates are decoded back to `Date` for the
API (tRPC uses superjson).

## Tests

The tests were written by a separate agent working only from
`change-history-spec.md`, without reading the implementation. They were then
run against the implementation.

| File | Cases | Covers |
| --- | --- | --- |
| `routers/itemHistory.test.ts` | 41 | **Capture (15):** every field and capture path, exact old/new values, author, source, shared `changeId`, brand-new bookmark writes nothing, re-save. **No-ops & grouping (10):** same values, same date instants, duplicate/reordered tags, attach+detach, note window (merge, sliding window, >5 min, revert, interleaved edit, notes only). **Authorization (8):** owner, unauthenticated, outsider/unknown, viewer and editor, removed collaborator, private fields hidden, pre-join history, API key scopes. **Ordering & pagination (5):** newest first, ties by id, complete walk, page-size bounds, hidden rows don't break pages. **Transactions & deletion (4):** failed update writes nothing, bookmark delete, owner delete, author delete. |
| `lib/itemHistory.test.ts` | 10 | null vs `""`, booleans, date instants, tag sets, exact Unicode strings, diff rules, visibility (incl. `toString`/`__proto__`), encode/decode round trip |
| `lib/__tests__/ruleEngine.test.ts` (added) | 2 | Rule actions recorded with `source: "rule"`; rule no-op writes nothing |
| `historyFormat.test.ts` | 5 | Labels, empty values, booleans, dates, tags and grouping |

**Results:** all 58 new tests pass, and no existing test broke. Full suites:
`@karakeep/trpc` 614 passed (561 existing + 53 new), `@karakeep/web` 108 passed
(103 existing + 5 new), `@karakeep/workers` 96 passed. Typecheck, lint and
format pass across the monorepo (run by the pre-commit hook).

**Bug the blind tests caught:** `isHistoryFieldVisible("toString", true)`
returned `true`, because the field map is a plain object and the lookup found
inherited keys. Fixed with an own-property check (`hasOwnProperty`). The test
was kept as written.

**Checking the tests catch errors:** three parts of the code were broken on
purpose, one at a time, then restored:

| Deliberate break | Tests failing |
| --- | --- |
| No-op check removed (every field counted as changed) | 43 / 51 |
| Privacy filter removed (all fields visible) | 3 / 51 |
| Old value always stored as null | 21 / 51 |

**Not covered by automated tests:** the AI workers (they need an inference
client) and the `summarizeBookmark` mutation. The React component is covered by
the browser demo below, not by unit tests.

## Demo (real UI, no database edits)

The demo ran with `pnpm dev:worktree` and the seed data. As **test1** (owner),
edits were made through the app's own UI on "Seed snapshot bookmark 7", which
is in the shared *Reading Queue* list:

1. **Edit details** dialog: changed title, description and publisher. This
   gave one change with 3 fields.
2. Opened **Edit details** again and saved without changes. No entry.
3. Added the tag `shared-reading` inline. One tags entry.
4. Typed in the note twice (two autosaves). One grouped note entry.
5. Clicked **Unfavourite**. One favourite entry.

| Screenshot | Shows |
| --- | --- |
| `change-history-demo/1-owner-wide.png`, `1-owner-history.png` | Owner: 6 fields in 4 changes, newest first |
| `change-history-demo/2-collaborator-history.png` | **test2** (editor on Reading Queue): only title, description, publisher and tags. Note and favourite are hidden. |
| `change-history-demo/3-owner-narrow.png` | Same history in the narrow layout's Details tab |

## Run it yourself (Codespaces or locally)

```bash
pnpm install
```

```bash
pnpm dev:worktree
```

This writes `.env`, loads the seed data, applies migrations (including `0098`)
and starts the web app and workers. It prints the URL (port 3100–3199). Sign in
as `test1@example.com` / `test1234` (owner) or `test2@example.com` /
`test1234` (collaborator), open any bookmark in *Reading Queue*, edit it, and
expand **History** at the bottom of the details panel.

In Codespaces, open the codespace in **VS Code desktop** so the port is
forwarded to `localhost`. The script sets `NEXTAUTH_URL=http://localhost:<port>`,
and sign-in only works from that address. In the browser-based editor the
forwarded URL is `https://…app.github.dev`, which won't match.

Run the tests:

```bash
pnpm test --filter=@karakeep/trpc
```

```bash
pnpm test --filter=@karakeep/web
```
