import { describe, expect, it } from "vitest";

import {
  formatHistoryValue,
  groupHistoryEntries,
  historyFieldLabel,
} from "./historyFormat";

describe("historyFormat", () => {
  it("labels known fields and falls back to the raw name", () => {
    expect(historyFieldLabel("title")).toBe("Title");
    expect(historyFieldLabel("createdAt")).toBe("Saved date");
    expect(historyFieldLabel("assetContent")).toBe("Asset text");
    expect(historyFieldLabel("someUnknownField")).toBe("someUnknownField");
    // Every tracked field has some non-empty label.
    for (const f of [
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
      "note",
      "favourited",
      "archived",
    ]) {
      expect(historyFieldLabel(f).length).toBeGreaterThan(0);
    }
  });

  it("formats empty values and leaves other strings unchanged", () => {
    for (const field of ["title", "note", "summary", "url"]) {
      expect(formatHistoryValue(field, null)).toBe("(empty)");
      expect(formatHistoryValue(field, undefined)).toBe("(empty)");
      expect(formatHistoryValue(field, "")).toBe("(empty)");
    }
    expect(formatHistoryValue("title", "Hello 📚")).toBe("Hello 📚");
    expect(formatHistoryValue("note", "  spaced  ")).toBe("  spaced  ");
  });

  it("formats booleans as Yes/No", () => {
    expect(formatHistoryValue("favourited", true)).toBe("Yes");
    expect(formatHistoryValue("favourited", false)).toBe("No");
    expect(formatHistoryValue("archived", true)).toBe("Yes");
    expect(formatHistoryValue("archived", false)).toBe("No");
  });

  it("formats dates (Date or ISO string) with toLocaleString", () => {
    const iso = "2024-05-06T07:08:09.000Z";
    for (const field of ["datePublished", "dateModified", "createdAt"]) {
      const expected = new Date(iso).toLocaleString();
      expect(formatHistoryValue(field, new Date(iso))).toBe(expected);
      expect(formatHistoryValue(field, iso)).toBe(expected);
      expect(formatHistoryValue(field, null)).toBe("(empty)");
    }
  });

  it("formats tags and groups consecutive entries by changeId", () => {
    expect(formatHistoryValue("tags", ["a", "b", "c"])).toBe("a, b, c");
    expect(formatHistoryValue("tags", ["solo"])).toBe("solo");
    expect(formatHistoryValue("tags", [])).toBe("(empty)");

    expect(groupHistoryEntries([])).toEqual([]);
    const entries = [
      { changeId: "c1", id: 1 },
      { changeId: "c1", id: 2 },
      { changeId: "c2", id: 3 },
      { changeId: "c1", id: 4 },
      { changeId: "c3", id: 5 },
      { changeId: "c3", id: 6 },
    ];
    expect(groupHistoryEntries(entries)).toEqual([
      { changeId: "c1", entries: [entries[0], entries[1]] },
      { changeId: "c2", entries: [entries[2]] },
      // Non-consecutive entries with the same changeId form a new group.
      { changeId: "c1", entries: [entries[3]] },
      { changeId: "c3", entries: [entries[4], entries[5]] },
    ]);
  });
});
