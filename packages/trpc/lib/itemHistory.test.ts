import { describe, expect, test } from "vitest";

import {
  BOOKMARK_HISTORY_FIELDS,
  decodeHistoryValue,
  diffHistoryFields,
  encodeHistoryValue,
  isHistoryFieldVisible,
  normalizeHistoryValue,
  NOTE_GROUPING_WINDOW_MS,
} from "./itemHistory";

const PUBLIC_FIELDS = [
  "title",
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
];
const OWNER_FIELDS = ["note", "favourited", "archived"];
const DATE_FIELDS = ["datePublished", "dateModified", "createdAt"];

describe("itemHistory helpers", () => {
  test("field table and grouping window match the spec", () => {
    const expected: Record<string, "public" | "owner"> = {};
    for (const f of PUBLIC_FIELDS) expected[f] = "public";
    for (const f of OWNER_FIELDS) expected[f] = "owner";
    expect(BOOKMARK_HISTORY_FIELDS).toEqual(expected);
    expect(NOTE_GROUPING_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  test("normalizeHistoryValue handles undefined, null, dates, tags and primitives", () => {
    expect(normalizeHistoryValue("title", undefined)).toBeUndefined();
    expect(normalizeHistoryValue("title", null)).toBeNull();
    expect(normalizeHistoryValue("title", "")).toBe("");
    expect(normalizeHistoryValue("favourited", false)).toBe(false);
    const d = new Date("2025-02-03T04:05:06.789Z");
    expect(normalizeHistoryValue("datePublished", d)).toBe(
      "2025-02-03T04:05:06.789Z",
    );
    expect(normalizeHistoryValue("tags", ["b", "a", "b", "c"])).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(normalizeHistoryValue("tags", [])).toEqual([]);
  });

  test("null and empty string are different values", () => {
    expect(diffHistoryFields({ title: null }, { title: "" })).toEqual([
      { fieldName: "title", oldValue: null, newValue: "" },
    ]);
    expect(diffHistoryFields({ note: "" }, { note: null })).toEqual([
      { fieldName: "note", oldValue: "", newValue: null },
    ]);
    expect(diffHistoryFields({ title: null }, { title: null })).toEqual([]);
    expect(diffHistoryFields({ title: "" }, { title: "" })).toEqual([]);
  });

  test("booleans: false differs from null, equal booleans are a no-op", () => {
    expect(diffHistoryFields({ archived: null }, { archived: false })).toEqual([
      { fieldName: "archived", oldValue: null, newValue: false },
    ]);
    expect(
      diffHistoryFields({ favourited: false }, { favourited: true }),
    ).toEqual([{ fieldName: "favourited", oldValue: false, newValue: true }]);
    expect(diffHistoryFields({ archived: true }, { archived: true })).toEqual(
      [],
    );
  });

  test("dates compare by instant", () => {
    const ms = Date.UTC(2024, 0, 15, 8, 30, 0, 123);
    expect(
      diffHistoryFields(
        { datePublished: new Date(ms) },
        { datePublished: new Date(ms) },
      ),
    ).toEqual([]);
    // Assumption: a Date and its ISO string normalize to the same value.
    expect(
      diffHistoryFields(
        { createdAt: new Date(ms) },
        { createdAt: new Date(ms).toISOString() },
      ),
    ).toEqual([]);
    const changed = diffHistoryFields(
      { dateModified: new Date(ms) },
      { dateModified: new Date(ms + 1) },
    );
    // The spec doesn't say whether entries carry raw or normalized values,
    // so only the field (and that something changed) is asserted here.
    expect(changed.map((c) => c.fieldName)).toEqual(["dateModified"]);
    expect(
      diffHistoryFields(
        { datePublished: new Date(ms) },
        { datePublished: null },
      ).length,
    ).toBe(1);
  });

  test("tags compare as sets of names", () => {
    expect(
      diffHistoryFields({ tags: ["a", "b"] }, { tags: ["b", "a", "a"] }),
    ).toEqual([]);
    const changed = diffHistoryFields({ tags: ["a", "b"] }, { tags: ["a"] });
    expect(changed.map((c) => c.fieldName)).toEqual(["tags"]);
    // Tag names are case sensitive strings.
    expect(diffHistoryFields({ tags: ["a"] }, { tags: ["A"] })).toHaveLength(1);
  });

  test("strings compare exactly: no trimming, Unicode as-is", () => {
    expect(diffHistoryFields({ title: "a" }, { title: "a " })).toHaveLength(1);
    expect(diffHistoryFields({ title: "café" }, { title: "café" })).toEqual([]);
    // NFC vs NFD forms of "é" are different code unit sequences.
    const nfc = "café";
    const nfd = "café";
    expect(diffHistoryFields({ title: nfc }, { title: nfd })).toEqual([
      { fieldName: "title", oldValue: nfc, newValue: nfd },
    ]);
    expect(
      diffHistoryFields({ note: "📚 日本語" }, { note: "📚 日本語" }),
    ).toEqual([]);
  });

  test("diff skips undefined, compares missing before-fields to null, keeps key order of `after`", () => {
    expect(diffHistoryFields({ title: "a" }, { title: undefined })).toEqual([]);
    expect(diffHistoryFields({}, { summary: null })).toEqual([]);
    expect(diffHistoryFields({}, { summary: "x" })).toEqual([
      { fieldName: "summary", oldValue: null, newValue: "x" },
    ]);
    const res = diffHistoryFields(
      { title: "t", author: "a", note: "n" },
      { note: "n2", title: "t2", author: "a", publisher: "p" },
    );
    expect(res.map((r) => r.fieldName)).toEqual(["note", "title", "publisher"]);
  });

  test("visibility: public fields for all, owner fields for the owner, unknown for nobody", () => {
    for (const f of PUBLIC_FIELDS) {
      expect(isHistoryFieldVisible(f, true)).toBe(true);
      expect(isHistoryFieldVisible(f, false)).toBe(true);
    }
    for (const f of OWNER_FIELDS) {
      expect(isHistoryFieldVisible(f, true)).toBe(true);
      expect(isHistoryFieldVisible(f, false)).toBe(false);
    }
    for (const f of ["unknownField", "", "Title", "toString", "__proto__"]) {
      expect(isHistoryFieldVisible(f, true)).toBe(false);
      expect(isHistoryFieldVisible(f, false)).toBe(false);
    }
  });

  test("encode/decode round trip", () => {
    expect(encodeHistoryValue("title", undefined)).toBe("null");
    expect(encodeHistoryValue("title", null)).toBe("null");
    expect(encodeHistoryValue("title", "")).toBe('""');
    expect(encodeHistoryValue("tags", ["b", "a", "b"])).toBe('["a","b"]');

    const cases: [string, unknown][] = [
      ["title", 'Hello "world" 📚 café'],
      ["title", ""],
      ["title", null],
      ["favourited", true],
      ["archived", false],
      ["tags", ["a", "b"]],
      ["tags", []],
      ["text", "line1\nline2\ttab"],
    ];
    for (const [field, value] of cases) {
      expect(
        decodeHistoryValue(field, encodeHistoryValue(field, value)),
      ).toEqual(value);
    }

    for (const field of DATE_FIELDS) {
      const d = new Date("2023-07-08T09:10:11.012Z");
      const decoded = decodeHistoryValue(field, encodeHistoryValue(field, d));
      expect(decoded).toBeInstanceOf(Date);
      expect((decoded as Date).getTime()).toBe(d.getTime());
      expect(decodeHistoryValue(field, encodeHistoryValue(field, null))).toBe(
        null,
      );
    }
    // Non-date fields holding ISO-looking strings stay strings.
    expect(
      decodeHistoryValue("title", JSON.stringify("2023-07-08T09:10:11.012Z")),
    ).toBe("2023-07-08T09:10:11.012Z");
  });
});
