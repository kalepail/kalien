import { describe, expect, it } from "bun:test";
import {
  nowIso,
  parseInteger,
  parseBoolean,
  safeErrorMessage,
  isLocalHostname,
  isTerminalProofStatus,
  retryDelaySeconds,
  sleep,
} from "../../worker/utils";
import { MAX_RETRY_DELAY_SECONDS } from "../../worker/constants";

describe("worker utils", () => {
  describe("nowIso", () => {
    it("returns a valid ISO string ending in Z", () => {
      const result = nowIso();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/);
      expect(new Date(result).toISOString()).toBe(result);
    });
  });

  describe("parseInteger", () => {
    it("returns fallback when raw is undefined", () => {
      expect(parseInteger(undefined, 42)).toBe(42);
    });

    it("returns fallback for non-numeric strings", () => {
      expect(parseInteger("abc", 10)).toBe(10);
    });

    it("returns fallback when parsed value is below minimum", () => {
      expect(parseInteger("0", 10)).toBe(10);
      expect(parseInteger("-5", 10)).toBe(10);
    });

    it("returns parsed value for valid integers", () => {
      expect(parseInteger("7", 10)).toBe(7);
      expect(parseInteger("100", 10)).toBe(100);
    });

    it("respects custom minimum", () => {
      expect(parseInteger("3", 10, 5)).toBe(10);
      expect(parseInteger("5", 10, 5)).toBe(5);
      expect(parseInteger("10", 5, 5)).toBe(10);
    });

    it("returns fallback for NaN and Infinity", () => {
      expect(parseInteger("NaN", 42)).toBe(42);
      expect(parseInteger("Infinity", 42)).toBe(42);
    });
  });

  describe("parseBoolean", () => {
    it("returns fallback when raw is undefined", () => {
      expect(parseBoolean(undefined, true)).toBe(true);
      expect(parseBoolean(undefined, false)).toBe(false);
    });

    it("returns true for truthy values", () => {
      for (const v of ["1", "true", "yes", "on"]) {
        expect(parseBoolean(v, false)).toBe(true);
      }
    });

    it("returns false for falsy values", () => {
      for (const v of ["0", "false", "no", "off"]) {
        expect(parseBoolean(v, true)).toBe(false);
      }
    });

    it("is case insensitive", () => {
      expect(parseBoolean("TRUE", false)).toBe(true);
      expect(parseBoolean("False", true)).toBe(false);
      expect(parseBoolean("YES", false)).toBe(true);
    });

    it("trims whitespace", () => {
      expect(parseBoolean("  true  ", false)).toBe(true);
      expect(parseBoolean("  off  ", true)).toBe(false);
    });

    it("returns fallback for unknown strings", () => {
      expect(parseBoolean("maybe", true)).toBe(true);
      expect(parseBoolean("maybe", false)).toBe(false);
    });
  });

  describe("safeErrorMessage", () => {
    it("extracts message from Error", () => {
      expect(safeErrorMessage(new Error("something broke"))).toBe("something broke");
    });

    it("falls back to String(error) when Error has empty message", () => {
      expect(safeErrorMessage(new Error(""))).toBe("Error");
    });

    it("stringifies non-Error values", () => {
      expect(safeErrorMessage("plain string")).toBe("plain string");
      expect(safeErrorMessage(42)).toBe("42");
      expect(safeErrorMessage(null)).toBe("null");
    });

    it("collapses control characters", () => {
      expect(safeErrorMessage(new Error("bad\x00\x01\x02data"))).toBe("bad data");
    });

    it("trims result", () => {
      expect(safeErrorMessage(new Error("  spaced  "))).toBe("spaced");
    });
  });

  describe("isLocalHostname", () => {
    it("returns true for localhost", () => {
      expect(isLocalHostname("localhost")).toBe(true);
    });

    it("returns true for 127.0.0.1", () => {
      expect(isLocalHostname("127.0.0.1")).toBe(true);
    });

    it("returns true for ::1", () => {
      expect(isLocalHostname("::1")).toBe(true);
    });

    it("returns false for other hostnames", () => {
      expect(isLocalHostname("example.com")).toBe(false);
      expect(isLocalHostname("0.0.0.0")).toBe(false);
    });
  });

  describe("isTerminalProofStatus", () => {
    it("returns true for succeeded", () => {
      expect(isTerminalProofStatus("succeeded")).toBe(true);
    });

    it("returns true for failed", () => {
      expect(isTerminalProofStatus("failed")).toBe(true);
    });

    it("returns false for non-terminal statuses", () => {
      expect(isTerminalProofStatus("queued")).toBe(false);
      expect(isTerminalProofStatus("dispatching")).toBe(false);
      expect(isTerminalProofStatus("prover_running")).toBe(false);
      expect(isTerminalProofStatus("retrying")).toBe(false);
    });
  });

  describe("retryDelaySeconds", () => {
    it("returns 2 for attempt 1", () => {
      expect(retryDelaySeconds(1)).toBe(2);
    });

    it("returns 2 for attempt 2", () => {
      expect(retryDelaySeconds(2)).toBe(2);
    });

    it("returns 4 for attempt 3", () => {
      expect(retryDelaySeconds(3)).toBe(4);
    });

    it("returns 8 for attempt 4", () => {
      expect(retryDelaySeconds(4)).toBe(8);
    });

    it("caps at MAX_RETRY_DELAY_SECONDS for high attempts", () => {
      expect(retryDelaySeconds(100)).toBe(MAX_RETRY_DELAY_SECONDS);
    });

    it("always returns at least 2", () => {
      expect(retryDelaySeconds(0)).toBeGreaterThanOrEqual(2);
      expect(retryDelaySeconds(-1)).toBeGreaterThanOrEqual(2);
    });
  });

  describe("sleep", () => {
    it("resolves after the specified delay", async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });
  });
});
