import { describe, expect, it } from "vitest";

import type { ZHistoryEntry } from "@karakeep/shared/types/itemHistory";

import {
  formatHistoryValue,
  groupHistoryEntries,
  historyFieldLabelKey,
} from "./historyFormat";

const opts = { locale: "en-US", yes: "Yep", no: "Nope" };

describe("formatHistoryValue", () => {
  it("returns null for empty values", () => {
    expect(formatHistoryValue("title", null, opts)).toBeNull();
    expect(formatHistoryValue("note", "", opts)).toBeNull();
    expect(formatHistoryValue("tags", [], opts)).toBeNull();
    expect(formatHistoryValue("createdAt", null, opts)).toBeNull();
  });

  it("formats tags, booleans and plain strings", () => {
    expect(formatHistoryValue("tags", ["a", "b c", "d"], opts)).toBe(
      "a, b c, d",
    );
    expect(formatHistoryValue("favourited", true, opts)).toBe("Yep");
    expect(formatHistoryValue("archived", false, opts)).toBe("Nope");
    expect(formatHistoryValue("note", "  line 1\nline 2 ", opts)).toBe(
      "  line 1\nline 2 ",
    );
    // Only date fields get date formatting
    expect(formatHistoryValue("title", "2024-03-15T12:00:00.000Z", opts)).toBe(
      "2024-03-15T12:00:00.000Z",
    );
  });

  it.each(["createdAt", "datePublished", "dateModified"] as const)(
    "formats %s as a localized date",
    (field) => {
      const iso = "2024-03-15T12:00:00.000Z";
      const english = formatHistoryValue(field, iso, opts);
      const german = formatHistoryValue(field, iso, {
        ...opts,
        locale: "de-DE",
      });

      for (const formatted of [english, german]) {
        expect(formatted).toContain("2024");
        expect(formatted).toContain("15");
        expect(formatted).not.toContain(iso);
        expect(formatted).not.toContain("2024-03-15T");
      }
      expect(english).not.toBe(german);
    },
  );
});

describe("historyFieldLabelKey", () => {
  it("builds the translation key for a field", () => {
    expect(historyFieldLabelKey("title")).toBe("preview.history.fields.title");
    expect(historyFieldLabelKey("assetContent")).toBe(
      "preview.history.fields.assetContent",
    );
  });
});

describe("groupHistoryEntries", () => {
  function entry(
    id: string,
    changeId: string,
    overrides: Partial<ZHistoryEntry> = {},
  ): ZHistoryEntry {
    return {
      id,
      changeId,
      field: "title",
      oldValue: null,
      newValue: id,
      source: "user",
      changedAt: new Date("2024-03-15T12:00:00.000Z"),
      changedBy: { id: "u1", name: "User" },
      ...overrides,
    };
  }

  it("groups by changeId, preserving first appearance and entry order", () => {
    const newer = {
      changedAt: new Date("2024-03-16T12:00:00.000Z"),
      source: "rule" as const,
      changedBy: null,
    };
    const first = entry("3", "change-b", newer);
    const second = entry("2", "change-a");
    // Entries of a change aren't necessarily adjacent when timestamps tie
    const third = entry("4", "change-b", { ...newer, field: "tags" });
    const fourth = entry("1", "change-a", { field: "note" });

    expect(groupHistoryEntries([first, second, third, fourth])).toEqual([
      {
        changeId: "change-b",
        changedAt: newer.changedAt,
        source: "rule",
        changedBy: null,
        entries: [first, third],
      },
      {
        changeId: "change-a",
        changedAt: second.changedAt,
        source: "user",
        changedBy: { id: "u1", name: "User" },
        entries: [second, fourth],
      },
    ]);
  });

  it("returns no groups for no entries", () => {
    expect(groupHistoryEntries([])).toEqual([]);
  });
});
