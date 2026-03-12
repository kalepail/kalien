import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseAndValidateTape } from "../../worker/tape";
import {
  TAPE_MAGIC,
  TAPE_VERSION,
  TAPE_HEADER_SIZE,
  TAPE_FOOTER_SIZE,
  EXPECTED_RULES_TAG,
  DEFAULT_MAX_TAPE_BYTES,
} from "../../worker/constants";

/**
 * Build a valid v4 tape binary for testing.
 * Header (16 bytes): magic(4) + version(1) + rulesTag(1) + reserved(2) + seed(4) + frameCount(4)
 * Body (ceil(frameCount/2) bytes): nibble-packed — low nibble = frame[2i], high nibble = frame[2i+1]
 * Footer (8 bytes): finalScore(4) + crc32(4)
 */
function buildTape(options: {
  seed?: number;
  frames?: Uint8Array;
  score?: number;
  magic?: number;
  version?: number;
  rulesTag?: number;
  reserved?: [number, number];
  frameCount?: number;
  corruptCrc?: boolean;
}): Uint8Array {
  const {
    seed = 42,
    score = 100,
    magic = TAPE_MAGIC,
    version = TAPE_VERSION,
    rulesTag = EXPECTED_RULES_TAG,
    reserved = [0, 0],
    corruptCrc = false,
  } = options;

  const frames = options.frames ?? new Uint8Array([0x01, 0x02, 0x03]);
  const frameCount = options.frameCount ?? frames.length;
  const bodyBytes = (frames.length + 1) >> 1;

  const totalLength = TAPE_HEADER_SIZE + bodyBytes + TAPE_FOOTER_SIZE;
  const buf = new Uint8Array(totalLength);
  const view = new DataView(buf.buffer);

  // Header
  view.setUint32(0, magic, true);
  view.setUint8(4, version);
  view.setUint8(5, rulesTag);
  view.setUint8(6, reserved[0]);
  view.setUint8(7, reserved[1]);
  view.setUint32(8, seed, true);
  view.setUint32(12, frameCount, true);

  // Nibble-packed body
  for (let i = 0; i < bodyBytes; i++) {
    const lo = frames[2 * i] & 0x0f;
    const hi = 2 * i + 1 < frames.length ? (frames[2 * i + 1] & 0x0f) << 4 : 0;
    buf[TAPE_HEADER_SIZE + i] = lo | hi;
  }

  // Footer
  const footerOffset = TAPE_HEADER_SIZE + bodyBytes;
  view.setUint32(footerOffset, score, true);

  // Compute CRC32 over header + packed body
  const crc = crc32(buf, footerOffset);
  view.setUint32(footerOffset + 4, corruptCrc ? (crc ^ 0xdeadbeef) >>> 0 : crc, true);

  return buf;
}

/** Standard CRC32 matching the implementation in tape.ts */
function crc32(data: Uint8Array, end: number): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }

  let crc = 0xffffffff;
  for (let i = 0; i < end; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

describe("parseAndValidateTape", () => {
  it("throws on empty payload", () => {
    expect(() => parseAndValidateTape(new Uint8Array(0), DEFAULT_MAX_TAPE_BYTES)).toThrow("empty");
  });

  it("throws on too large payload", () => {
    const big = new Uint8Array(100);
    expect(() => parseAndValidateTape(big, 50)).toThrow("too large");
  });

  it("throws on too short payload", () => {
    const tiny = new Uint8Array(TAPE_HEADER_SIZE + TAPE_FOOTER_SIZE - 1);
    tiny[0] = 1; // non-empty
    expect(() => parseAndValidateTape(tiny, DEFAULT_MAX_TAPE_BYTES)).toThrow("too short");
  });

  it("throws on invalid tape magic", () => {
    const tape = buildTape({ magic: 0x12345678 });
    expect(() => parseAndValidateTape(tape, DEFAULT_MAX_TAPE_BYTES)).toThrow("invalid tape magic");
  });

  it("throws on unsupported tape version", () => {
    const tape = buildTape({ version: 99 });
    expect(() => parseAndValidateTape(tape, DEFAULT_MAX_TAPE_BYTES)).toThrow(
      "unsupported tape version",
    );
  });

  it("throws on unknown rules tag", () => {
    const tape = buildTape({ rulesTag: 7 });
    expect(() => parseAndValidateTape(tape, DEFAULT_MAX_TAPE_BYTES)).toThrow("unknown rules tag");
  });

  it("throws on non-zero reserved bytes", () => {
    const tape = buildTape({ reserved: [1, 0] });
    expect(() => parseAndValidateTape(tape, DEFAULT_MAX_TAPE_BYTES)).toThrow("reserved bytes");
  });

  it("throws on frame count vs actual length mismatch", () => {
    const tape = buildTape({ frameCount: 999 });
    expect(() => parseAndValidateTape(tape, DEFAULT_MAX_TAPE_BYTES)).toThrow("size mismatch");
  });

  it("throws on zero final score", () => {
    const tape = buildTape({ score: 0 });
    expect(() => parseAndValidateTape(tape, DEFAULT_MAX_TAPE_BYTES)).toThrow(
      "must be greater than zero",
    );
  });

  it("throws on corrupted CRC", () => {
    const tape = buildTape({ corruptCrc: true });
    expect(() => parseAndValidateTape(tape, DEFAULT_MAX_TAPE_BYTES)).toThrow("checksum mismatch");
  });

  it("returns correct TapeMetadata for valid tape", () => {
    const tape = buildTape({ seed: 0xabcd, score: 1337 });
    const result = parseAndValidateTape(tape, DEFAULT_MAX_TAPE_BYTES);
    expect(result.seed).toBe(0xabcd);
    expect(result.frameCount).toBe(3);
    expect(result.finalScore).toBe(1337);
    expect(typeof result.checksum).toBe("number");
  });

  it("validates the test-medium.tape fixture", () => {
    const fixturePath = join(import.meta.dir, "../../test-fixtures/test-medium.tape");
    const data = new Uint8Array(readFileSync(fixturePath));
    const result = parseAndValidateTape(data, DEFAULT_MAX_TAPE_BYTES);
    expect(result.finalScore).toBeGreaterThan(0);
    expect(result.frameCount).toBeGreaterThan(0);
    expect(typeof result.seed).toBe("number");
    expect(typeof result.checksum).toBe("number");
  });
});
