import { describe, expect, it } from "bun:test";
import {
  buildRequestId,
  decodeRequestId,
  requestIdToHex,
  parseBoundlessStatusUrl,
  boundlessExplorerUrl,
  BOUNDLESS_EXPLORER_BASE_URL,
  hexToUint8Array,
  uint8ArrayToHex,
  uint8ArrayToHex0x,
} from "../../worker/boundless/sdk/utils";

// ── buildRequestId ─────────────────────────────────────────────────────────

describe("buildRequestId", () => {
  it("combines address and nonce via (address << 32) | nonce", () => {
    const address = "0x0000000000000000000000000000000000000001" as `0x${string}`;
    const nonce = 1;
    const id = buildRequestId(address, nonce);
    // 1n << 32n | 1n = 0x100000001n
    expect(id).toBe(0x100000001n);
  });

  it("returns 0 for zero address and zero nonce", () => {
    const address = "0x0000000000000000000000000000000000000000" as `0x${string}`;
    expect(buildRequestId(address, 0)).toBe(0n);
  });

  it("truncates nonce to 32 bits via >>> 0", () => {
    const address = "0x0000000000000000000000000000000000000001" as `0x${string}`;
    // 0x100000001 should truncate to nonce = 1 (lower 32 bits)
    const nonce = 0x100000001; // > 2^32, truncates to 1 via >>> 0
    const id = buildRequestId(address, nonce);
    // nonce >>> 0 = 1, so result is (1n << 32n) | 1n
    expect(id).toBe(0x100000001n);
  });

  it("handles a realistic timestamp nonce", () => {
    const address = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`;
    const nonce = 1740000000; // realistic ~2025 unix timestamp fits in uint32
    const id = buildRequestId(address, nonce);
    expect(id > 0n).toBe(true);
    // Verify the lower 32 bits are the nonce
    expect(Number(id & 0xffffffffn)).toBe(nonce);
  });
});

// ── decodeRequestId ────────────────────────────────────────────────────────

describe("decodeRequestId", () => {
  it("round-trips with buildRequestId (simple values)", () => {
    const address = "0x0000000000000000000000000000000000000042" as `0x${string}`;
    const nonce = 9999;
    const id = buildRequestId(address, nonce);
    const decoded = decodeRequestId(id);
    expect(decoded.address).toBe(address);
    expect(decoded.nonce).toBe(nonce);
  });

  it("round-trips with buildRequestId (realistic address and nonce)", () => {
    const address = "0xabcdef1234567890abcdef1234567890abcdef12" as `0x${string}`;
    const nonce = Date.now() >>> 0; // truncate to uint32
    const id = buildRequestId(address, nonce);
    const decoded = decodeRequestId(id);
    expect(decoded.address).toBe(address);
    expect(decoded.nonce).toBe(nonce);
  });

  it("returns address with 0x prefix and 40 hex chars", () => {
    const id = buildRequestId("0x1111111111111111111111111111111111111111" as `0x${string}`, 42);
    const { address } = decodeRequestId(id);
    expect(address).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("returns zero address for id=0", () => {
    const { address, nonce } = decodeRequestId(0n);
    expect(address).toBe("0x" + "0".repeat(40));
    expect(nonce).toBe(0);
  });
});

// ── requestIdToHex ─────────────────────────────────────────────────────────

describe("requestIdToHex", () => {
  it("formats bigint as 0x-prefixed lowercase hex", () => {
    expect(requestIdToHex(255n)).toBe("0xff");
    expect(requestIdToHex(0n)).toBe("0x0");
    expect(requestIdToHex(0xdeadbeefn)).toBe("0xdeadbeef");
  });

  it("works with a realistic request id", () => {
    const id = buildRequestId("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`, 12345);
    const hex = requestIdToHex(id);
    expect(hex).toMatch(/^0x[0-9a-f]+$/);
    // Should round-trip via BigInt
    expect(BigInt(hex)).toBe(id);
  });
});

// ── parseBoundlessStatusUrl ────────────────────────────────────────────────

describe("parseBoundlessStatusUrl", () => {
  it("returns null for non-boundless status URLs", () => {
    expect(parseBoundlessStatusUrl("https://vast.ai/jobs/abc")).toBeNull();
    expect(parseBoundlessStatusUrl("/api/jobs/xyz")).toBeNull();
    expect(parseBoundlessStatusUrl("")).toBeNull();
  });

  it("parses a valid 'boundless:0x...' status URL", () => {
    const id = buildRequestId("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`, 42);
    const hex = requestIdToHex(id);
    const statusUrl = `boundless:${hex}`;
    const parsed = parseBoundlessStatusUrl(statusUrl);
    expect(parsed).toBe(id);
  });

  it("parses a decimal request ID in 'boundless:' prefix", () => {
    const id = 123456789n;
    const statusUrl = `boundless:${id.toString(10)}`;
    const parsed = parseBoundlessStatusUrl(statusUrl);
    expect(parsed).toBe(id);
  });

  it("returns null for 'boundless:' prefix with non-numeric value", () => {
    expect(parseBoundlessStatusUrl("boundless:not-a-number")).toBeNull();
    expect(parseBoundlessStatusUrl("boundless:0x-invalid")).toBeNull();
  });
});

// ── boundlessExplorerUrl ───────────────────────────────────────────────────

describe("boundlessExplorerUrl", () => {
  it("uses the decimal representation of the request ID", () => {
    const id = 1000n;
    const url = boundlessExplorerUrl(id);
    expect(url).toBe(`${BOUNDLESS_EXPLORER_BASE_URL}/orders/1000`);
  });

  it("produces a valid URL for a realistic request ID", () => {
    const id = buildRequestId("0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" as `0x${string}`, 99999);
    const url = boundlessExplorerUrl(id);
    expect(url).toMatch(/^https:\/\/explorer\.beboundless\.xyz\/orders\/\d+$/);
    // The decimal in the URL should recover the original bigint
    const decimalPart = url.split("/orders/")[1];
    expect(BigInt(decimalPart)).toBe(id);
  });

  it("BOUNDLESS_EXPLORER_BASE_URL is the expected domain", () => {
    expect(BOUNDLESS_EXPLORER_BASE_URL).toBe("https://explorer.beboundless.xyz");
  });
});

// ── hexToUint8Array ────────────────────────────────────────────────────────

describe("hexToUint8Array", () => {
  it("decodes a hex string without 0x prefix", () => {
    const result = hexToUint8Array("deadbeef");
    expect(result).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it("decodes a hex string with 0x prefix", () => {
    const result = hexToUint8Array("0xdeadbeef");
    expect(result).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  it("decodes an empty string to empty Uint8Array", () => {
    expect(hexToUint8Array("")).toEqual(new Uint8Array([]));
    expect(hexToUint8Array("0x")).toEqual(new Uint8Array([]));
  });

  it("throws on odd-length hex string", () => {
    expect(() => hexToUint8Array("abc")).toThrow();
  });

  it("handles all-zeros input", () => {
    const result = hexToUint8Array("000000");
    expect(result).toEqual(new Uint8Array([0, 0, 0]));
  });
});

// ── uint8ArrayToHex ────────────────────────────────────────────────────────

describe("uint8ArrayToHex", () => {
  it("encodes bytes to lowercase hex without 0x prefix", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    expect(uint8ArrayToHex(bytes)).toBe("deadbeef");
  });

  it("pads single-byte values with leading zero", () => {
    const bytes = new Uint8Array([0x0f]);
    expect(uint8ArrayToHex(bytes)).toBe("0f");
  });

  it("returns empty string for empty array", () => {
    expect(uint8ArrayToHex(new Uint8Array())).toBe("");
  });

  it("round-trips with hexToUint8Array", () => {
    const original = "cafebabe0102030405";
    const bytes = hexToUint8Array(original);
    expect(uint8ArrayToHex(bytes)).toBe(original);
  });
});

// ── uint8ArrayToHex0x ──────────────────────────────────────────────────────

describe("uint8ArrayToHex0x", () => {
  it("adds 0x prefix to hex output", () => {
    const bytes = new Uint8Array([0xab, 0xcd]);
    expect(uint8ArrayToHex0x(bytes)).toBe("0xabcd");
  });

  it("returns '0x' for empty array", () => {
    expect(uint8ArrayToHex0x(new Uint8Array())).toBe("0x");
  });
});
