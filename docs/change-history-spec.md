# Bookmark change history — behavior spec (contract for implementation and tests)

This is the contract the implementation and the test suite are both written
against. Tests must be derivable from this document alone.

## Storage: `itemHistory` table (`@karakeep/db/schema`, export name `itemHistory`)

| Column      | Type                          | Notes                                                       |
| ----------- | ----------------------------- | ----------------------------------------------------------- |
| `id`        | text PK (cuid)                |                                                             |
| `itemType`  | text enum `"bookmark"`        | Only bookmarks for now.                                     |
| `itemId`    | text, not null                | The bookmark id. No FK (generic); cleaned up explicitly.    |
| `ownerId`   | text FK users.id, cascade     | Owner of the item. Deleting the owner deletes the history.  |
| `changeId`  | text, not null                | Same value for all fields changed by one save.              |
| `fieldName` | text, not null                | See field list below.                                       |
| `oldValue`  | text (JSON), not null         | `JSON.stringify` of the normalized value (`"null"` for null)|
| `newValue`  | text (JSON), not null         | Same.                                                       |
| `changedBy` | text FK users.id, set null    | User who made the change; null for AI changes / deleted user|
| `source`    | text enum `"user" \| "ai" \| "rule"` | Who produced the change.                             |
| `changedAt` | integer timestamp_ms          |                                                             |

## Tracked fields

| fieldName       | Visible to          | Value type in API         |
| --------------- | ------------------- | ------------------------- |
| `title`         | everyone with access| `string \| null`          |
| `url`           | everyone            | `string`                  |
| `description`   | everyone            | `string \| null`          |
| `author`        | everyone            | `string \| null`          |
| `publisher`     | everyone            | `string \| null`          |
| `datePublished` | everyone            | `Date \| null`            |
| `dateModified`  | everyone            | `Date \| null`            |
| `createdAt`     | everyone            | `Date` (the "saved" date) |
| `text`          | everyone            | `string \| null`          |
| `assetContent`  | everyone            | `string \| null`          |
| `summary`       | everyone            | `string \| null`          |
| `tags`          | everyone            | `string[]` (tag names, sorted ascending, deduplicated) |
| `note`          | owner only          | `string \| null`          |
| `favourited`    | owner only          | `boolean`                 |
| `archived`      | owner only          | `boolean`                 |

Any `fieldName` not in this table is hidden from everyone (owner included).

## Pure helpers: `packages/trpc/lib/itemHistory.ts`

```ts
export const BOOKMARK_HISTORY_FIELDS: Record<string, "public" | "owner">; // table above
export const NOTE_GROUPING_WINDOW_MS = 5 * 60 * 1000;

// Normalizes a value for storage/comparison:
//   undefined -> undefined (means "not part of this update")
//   null -> null; Date -> ISO string; for "tags": array -> sorted, deduped string[];
//   other primitives unchanged.
export function normalizeHistoryValue(fieldName: string, value: unknown): unknown;

// Returns one entry per field present (value !== undefined) in `after` whose
// normalized value differs from the normalized value in `before`.
// Fields present in `after` but absent from `before` are compared against null.
// Order of returned entries follows the key order of `after`.
export function diffHistoryFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { fieldName: string; oldValue: unknown; newValue: unknown }[];

export function isHistoryFieldVisible(fieldName: string, isOwner: boolean): boolean;

export function encodeHistoryValue(fieldName: string, value: unknown): string; // JSON.stringify(normalize(...)) ; undefined -> "null"
export function decodeHistoryValue(fieldName: string, raw: string): unknown;   // JSON.parse; date fields -> Date (or null)
```

Equality notes: `""` and `null` are different values. `false` and `null` are
different. Dates compare by instant (two `Date`s with the same epoch ms are
equal). Strings compare exactly (no trimming, Unicode compared as-is).

## Capture (all in the same DB transaction as the write)

A "change" = one call. All rows from one call share a `changeId` and `changedAt`.

* `bookmarks.updateBookmark` (owner only, unchanged authz): every field in the
  input that is tracked and actually changes value produces one row,
  `source: "user"`, `changedBy: ctx.user.id`. `url` is compared after trimming
  (the stored value is trimmed). If the update throws (e.g. setting `url` on a
  text bookmark → `BAD_REQUEST`), no history rows are written.
* `bookmarks.updateBookmarkText` (deprecated): records `text`.
* `bookmarks.updateTags`: one `tags` row with the sorted list of tag names
  before and after. No row if the set of tag names is unchanged (re-attaching an
  already-attached tag, detaching a non-attached tag, attaching+detaching the
  same thing).
* `bookmarks.createBookmark` on an existing link (re-save of a duplicate URL):
  records changes to `title`, `note`, `favourited`, `archived`, `summary`,
  `createdAt` that the re-save applies. Creating a brand-new bookmark writes no
  history.
* `bookmarks.summarizeBookmark`: `summary` row, `source: "user"`.
* Automated (best effort): AI summarization worker → `summary`, `source: "ai"`,
  `changedBy: null`; AI tagging worker → `tags`, `source: "ai"`, `changedBy:
  null`; rule engine actions (add/remove tag, favourite, archive) →
  `source: "rule"`, `changedBy: <owner id>`.
* No-op: if nothing tracked changes, zero rows are written.

### Note grouping

For `fieldName = "note"` only: if the most recent history row for the same
bookmark is a `note` row by the same `changedBy` with `source: "user"` and its
`changedAt` is within `NOTE_GROUPING_WINDOW_MS` of now, that row is updated in
place instead of inserting a new one: keep its `oldValue`, set `newValue` and
`changedAt` to the new ones. If after merging `oldValue === newValue`, the row is
deleted (the note ended up unchanged). Edits more than 5 minutes apart produce
separate rows.

## Read API: `bookmarks.getBookmarkHistory`

Input (`zGetItemHistoryRequestSchema` in `@karakeep/shared/types/itemHistory`):
```ts
{ bookmarkId: string; limit?: number /* 1..100, default 20 */; cursor?: { changedAt: Date; id: string } | null }
```
Output (`zGetItemHistoryResponseSchema`):
```ts
{
  entries: {
    id: string; changeId: string; fieldName: string;
    oldValue: unknown; newValue: unknown;
    changedAt: Date; source: "user" | "ai" | "rule";
    changedBy: { id: string; name: string; image: string | null } | null;
  }[];
  nextCursor: { changedAt: Date; id: string } | null;
}
```
* Authorization: same as `getBookmark` — owner, or a user who can view a list
  containing the bookmark (viewer or editor collaborator). Others → `NOT_FOUND`.
  Unauthenticated → `UNAUTHORIZED`. API keys need the `bookmarks` read scope.
* Collaborators never see owner-only fields (`note`, `favourited`, `archived`),
  not even old values. Hidden rows are filtered before pagination so pages are
  never padded with hidden rows (a page may be returned with fewer rows only at
  the end).
* Order: `changedAt` desc, then `id` desc. Pagination is stable: walking all
  pages yields every visible row exactly once.
* Collaborators see shared-field history from before they joined.
* Deleting a bookmark deletes its history. Deleting the owner deletes it too.

## Web formatting helpers: `apps/web/components/dashboard/preview/historyFormat.ts`

```ts
export function historyFieldLabel(fieldName: string): string;        // e.g. "title" -> "Title", "createdAt" -> "Saved date", "assetContent" -> "Asset text", unknown -> fieldName
export function formatHistoryValue(fieldName: string, value: unknown): string;
//   null/undefined/"" -> "(empty)"; booleans -> "Yes"/"No";
//   Date or ISO string for date fields -> date.toLocaleString(); tags -> names joined with ", " or "(empty)" for [];
//   other strings unchanged.
export function groupHistoryEntries<T extends { changeId: string }>(entries: T[]): { changeId: string; entries: T[] }[];
//   groups consecutive entries sharing a changeId, preserving order.
```
