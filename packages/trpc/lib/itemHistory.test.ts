import { describe, expect, test } from "vitest";

import type { ZHistoryField } from "@karakeep/shared/types/itemHistory";

import { diffFields, getVisibleFields } from "./itemHistory";

const ALL_FIELDS: ZHistoryField[] = [
  "title",
  "linkTitle",
  "url",
  "description",
  "author",
  "publisher",
  "datePublished",
  "dateModified",
  "createdAt",
  "text",
  "assetContent",
  "summary",
  "tags",
  "note",
  "favourited",
  "archived",
];

const OWNER_ONLY_FIELDS: ZHistoryField[] = ["note", "favourited", "archived"];

/** The order of the returned changes isn't part of the contract. */
function sortedDiff(...args: Parameters<typeof diffFields>) {
  return diffFields(...args).sort((a, b) => a.field.localeCompare(b.field));
}

describe("diffFields", () => {
  test("returns only the fields that changed, with old and new values", () => {
    expect(
      sortedDiff(
        { title: "a", summary: "same", favourited: false, archived: true },
        { title: "b", summary: "same", favourited: true, archived: true },
      ),
    ).toEqual([
      { field: "favourited", oldValue: false, newValue: true },
      { field: "title", oldValue: "a", newValue: "b" },
    ]);
  });

  test("only compares keys supplied in `after` with a defined value", () => {
    expect(
      diffFields(
        { title: "a", note: "n", summary: "s", favourited: true },
        { title: undefined, note: undefined },
      ),
    ).toEqual([]);
    expect(diffFields({ title: "a", note: "n" }, { title: null })).toEqual([
      { field: "title", oldValue: "a", newValue: null },
    ]);
  });

  test.each([
    [null, ""],
    ["", null],
    [undefined, null],
    [undefined, ""],
    [null, null],
    ["", ""],
  ])("treats %j -> %j as unchanged", (before, after) => {
    expect(diffFields({ note: before }, { note: after })).toEqual([]);
  });

  test.each([undefined, null, ""])(
    "stores the empty value %j as null on either side",
    (empty) => {
      expect(diffFields({ title: empty }, { title: "x" })).toEqual([
        { field: "title", oldValue: null, newValue: "x" },
      ]);
      expect(diffFields({ title: "x" }, { title: empty ?? null })).toEqual([
        { field: "title", oldValue: "x", newValue: null },
      ]);
    },
  );

  test("compares urls trimmed, but not other strings", () => {
    expect(
      diffFields(
        { url: "https://example.com/a" },
        { url: "  https://example.com/a \n" },
      ),
    ).toEqual([]);
    expect(
      diffFields(
        { url: "https://example.com/a" },
        { url: " https://example.com/b " },
      ),
    ).toEqual([
      {
        field: "url",
        oldValue: "https://example.com/a",
        newValue: "https://example.com/b",
      },
    ]);
    expect(diffFields({ title: "a" }, { title: " a " })).toEqual([
      { field: "title", oldValue: "a", newValue: " a " },
    ]);
  });

  test.each(["createdAt", "datePublished", "dateModified"] as const)(
    "compares %s at second precision and returns ISO strings",
    (field) => {
      expect(
        diffFields(
          { [field]: new Date("2024-01-02T03:04:05.001Z") },
          { [field]: new Date("2024-01-02T03:04:05.999Z") },
        ),
      ).toEqual([]);
      expect(
        diffFields(
          { [field]: new Date("2024-01-02T03:04:05.999Z") },
          { [field]: new Date("2024-01-02T03:04:06.001Z") },
        ),
      ).toEqual([
        {
          field,
          oldValue: "2024-01-02T03:04:05.000Z",
          newValue: "2024-01-02T03:04:06.000Z",
        },
      ]);
    },
  );

  test("compares tags as a set, ignoring order and duplicates", () => {
    expect(diffFields({ tags: ["a", "b"] }, { tags: ["b", "a", "b"] })).toEqual(
      [],
    );
    expect(diffFields({ tags: [] }, { tags: [] })).toEqual([]);
  });

  test("returns deduplicated, default-sorted tag arrays", () => {
    expect(
      diffFields(
        { tags: ["beta", "Zeta", "beta"] },
        { tags: ["gamma", "alpha", "Zeta", "alpha"] },
      ),
    ).toEqual([
      {
        field: "tags",
        oldValue: ["Zeta", "beta"],
        newValue: ["Zeta", "alpha", "gamma"],
      },
    ]);
  });

  test("represents an empty tag set as [] rather than null", () => {
    expect(diffFields({ tags: ["a"] }, { tags: [] })).toEqual([
      { field: "tags", oldValue: ["a"], newValue: [] },
    ]);
    expect(diffFields({ tags: [] }, { tags: ["a"] })).toEqual([
      { field: "tags", oldValue: [], newValue: ["a"] },
    ]);
  });

  test("ignores unknown keys", () => {
    const before = { title: "a", modifiedAt: 1 } as Record<string, unknown>;
    const after = { title: "b", modifiedAt: 2, userId: "someone" } as Record<
      string,
      unknown
    >;

    expect(diffFields(before, after)).toEqual([
      { field: "title", oldValue: "a", newValue: "b" },
    ]);
  });
});

describe("getVisibleFields", () => {
  test("gives the owner every field", () => {
    expect([...getVisibleFields(true)].sort()).toEqual([...ALL_FIELDS].sort());
  });

  test("hides note, favourited and archived from non-owners", () => {
    expect([...getVisibleFields(false)].sort()).toEqual(
      ALL_FIELDS.filter((f) => !OWNER_ONLY_FIELDS.includes(f)).sort(),
    );
  });
});
