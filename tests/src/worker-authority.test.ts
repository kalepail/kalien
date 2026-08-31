import { describe, expect, it } from "bun:test";
import { isCurrentAuthorityResult } from "../../cli/src/worker/messages";

describe("isCurrentAuthorityResult", () => {
  it("accepts a fresh result from the current seed and authority generation", () => {
    expect(isCurrentAuthorityResult({ seedId: 42, authorityGeneration: 7 }, 42, 7, true)).toBe(
      true,
    );
  });

  it("rejects an old result after pause and recovery to the same seed", () => {
    expect(isCurrentAuthorityResult({ seedId: 42, authorityGeneration: 6 }, 42, 7, true)).toBe(
      false,
    );
  });

  it("rejects a result from another seed or stale authority", () => {
    expect(isCurrentAuthorityResult({ seedId: 41, authorityGeneration: 7 }, 42, 7, true)).toBe(
      false,
    );
    expect(isCurrentAuthorityResult({ seedId: 42, authorityGeneration: 7 }, 42, 7, false)).toBe(
      false,
    );
  });
});
