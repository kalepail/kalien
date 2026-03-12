import { describe, expect, it } from "bun:test";
import { formatUtcDateTime } from "../../src/lib/time";

describe("formatUtcDateTime", () => {
  it("formats numeric timestamps in UTC", () => {
    expect(formatUtcDateTime(Date.UTC(2026, 1, 11, 18, 45, 9))).toBe("2026-02-11 18:45:09 UTC");
  });

  it("formats ISO strings in UTC", () => {
    expect(formatUtcDateTime("2026-02-11T18:45:09.000Z")).toBe("2026-02-11 18:45:09 UTC");
  });

  it("returns invalid date for bad input", () => {
    expect(formatUtcDateTime("not-a-date")).toBe("invalid date");
  });
});
