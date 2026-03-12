/**
 * Unit tests for Boundless integration helpers.
 *
 * Usage: bun run scripts/test-boundless-units.ts
 */

import { encodeGuestEnvV1, encodeStdin } from "../worker/boundless/stdin";
import { DEFAULT_BOUNDLESS_MAX_FRAMES } from "../worker/constants";
import { buildProofArtifactV4, parseProofArtifactV4, sha256Hex } from "../worker/proof-artifact";
import {
  decodeClaimantFromJournal,
  JOURNAL_CLAIMANT_ENCODED_LEN,
  JOURNAL_LEN,
  packJournalRaw,
} from "../shared/stellar/journal";

let passed = 0;
let failed = 0;
const pendingTests: Promise<void>[] = [];

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function test(name: string, fn: () => void | Promise<void>): void {
  const run = (async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  PASS: ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`  FAIL: ${name}`);
      if (error instanceof Error) {
        console.error(`        ${error.message}`);
      }
    }
  })();
  pendingTests.push(run);
}

function decodeGuestEnvV1(encoded: Uint8Array): Uint8Array {
  let pos = 0;
  assert(encoded[pos++] === 0x01, "missing GuestEnv v1 marker");
  assert(encoded[pos++] === 0x81, "missing msgpack map(1)");
  assert(encoded[pos++] === 0xa5, "missing msgpack key header");
  assert(encoded[pos++] === 0x73, "missing 's'");
  assert(encoded[pos++] === 0x74, "missing 't'");
  assert(encoded[pos++] === 0x64, "missing 'd'");
  assert(encoded[pos++] === 0x69, "missing 'i'");
  assert(encoded[pos++] === 0x6e, "missing 'n'");

  const arrTag = encoded[pos++];
  let arrLen = 0;
  if ((arrTag & 0xf0) === 0x90) {
    arrLen = arrTag & 0x0f;
  } else if (arrTag === 0xdc) {
    arrLen = (encoded[pos++] << 8) | encoded[pos++];
  } else if (arrTag === 0xdd) {
    arrLen =
      (encoded[pos++] << 24) | (encoded[pos++] << 16) | (encoded[pos++] << 8) | encoded[pos++];
  } else {
    throw new Error(`unexpected msgpack array tag 0x${arrTag.toString(16)}`);
  }

  const result = new Uint8Array(arrLen);
  for (let i = 0; i < arrLen; i += 1) {
    const tag = encoded[pos++];
    if (tag < 0x80) {
      result[i] = tag;
    } else if (tag === 0xcc) {
      result[i] = encoded[pos++];
    } else {
      throw new Error(`unexpected msgpack element tag 0x${tag.toString(16)} at ${i}`);
    }
  }

  assert(pos === encoded.length, "unexpected trailing bytes after stdin array");
  return result;
}

function decodeStdinEnvelope(encoded: Uint8Array): {
  maxFrames: number;
  seedId: number;
  claimant: string;
  tapeLen: number;
  tape: Uint8Array;
} {
  const stdin = decodeGuestEnvV1(encoded);
  const view = new DataView(stdin.buffer, stdin.byteOffset, stdin.byteLength);

  const maxFrames = view.getUint32(0, true);
  const seedId = view.getUint32(4, true);
  const claimantBytes = stdin.slice(8, 8 + JOURNAL_CLAIMANT_ENCODED_LEN);
  const claimant = decodeClaimantFromJournal(claimantBytes);
  const tapeLenOffset = 8 + JOURNAL_CLAIMANT_ENCODED_LEN;
  const tapeLen = view.getUint32(tapeLenOffset, true);
  const tapeOffset = tapeLenOffset + 4;
  const tape = stdin.slice(tapeOffset, tapeOffset + tapeLen);

  return {
    maxFrames,
    seedId,
    claimant,
    tapeLen,
    tape,
  };
}

console.log("\n=== encodeGuestEnvV1 ===\n");

test("round-trips mixed low/high stdin bytes", () => {
  const input = new Uint8Array([0, 1, 2, 127, 128, 200, 255]);
  const encoded = encodeGuestEnvV1(input);
  const decoded = decodeGuestEnvV1(encoded);
  assert(decoded.length === input.length, "decoded length mismatch");
  for (let i = 0; i < input.length; i += 1) {
    assert(decoded[i] === input[i], `decoded byte mismatch at ${i}`);
  }
});

test("uses array16 for stdin >= 16 bytes", () => {
  const input = new Uint8Array(16);
  const encoded = encodeGuestEnvV1(input);
  assert(encoded[8] === 0xdc, "expected array16 tag (0xdc)");
});

console.log("\n=== encodeStdin ===\n");

const CLAIMANT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

test("encodes default max_frames and caller seed_id/claimant/tape", () => {
  const tape = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
  const encoded = encodeStdin(tape, {
    seedId: 4242,
    claimantAddress: CLAIMANT,
  });

  const decoded = decodeStdinEnvelope(encoded);
  assert(decoded.maxFrames === DEFAULT_BOUNDLESS_MAX_FRAMES, "default max_frames mismatch");
  assert(decoded.seedId === 4242, "seed_id mismatch");
  assert(decoded.claimant === CLAIMANT, "claimant mismatch");
  assert(decoded.tapeLen === tape.length, "tape_len mismatch");
  assert(decoded.tape.length === tape.length, "decoded tape length mismatch");
  for (let i = 0; i < tape.length; i += 1) {
    assert(decoded.tape[i] === tape[i], `decoded tape byte mismatch at ${i}`);
  }
});

test("encodes custom max_frames", () => {
  const tape = new Uint8Array([0xaa]);
  const encoded = encodeStdin(tape, {
    maxFrames: 777,
    seedId: 7,
    claimantAddress: CLAIMANT,
  });
  const decoded = decodeStdinEnvelope(encoded);
  assert(decoded.maxFrames === 777, "custom max_frames mismatch");
});

test("throws when claimant is not a valid Stellar address", () => {
  let threw = false;
  try {
    encodeStdin(new Uint8Array([1, 2, 3]), {
      seedId: 1,
      claimantAddress: "GSHORT",
    });
  } catch {
    threw = true;
  }
  assert(threw, "expected invalid claimant length to throw");
});

console.log("\n=== proof artifact v4 ===\n");

function makeFakeSeal(selector: [number, number, number, number]): Uint8Array {
  const seal = new Uint8Array(260);
  seal.set(selector, 0);
  for (let i = 4; i < 260; i += 1) {
    seal[i] = (i - 4) & 0xff;
  }
  return seal;
}

function makeFakeJournal(fields: {
  seed_id: number;
  seed: number;
  frame_count: number;
  final_score: number;
  claimant: string;
}): Uint8Array {
  return packJournalRaw({
    seed_id: fields.seed_id >>> 0,
    seed: fields.seed >>> 0,
    frame_count: fields.frame_count >>> 0,
    final_score: fields.final_score >>> 0,
    claimant: fields.claimant,
  });
}

const TEST_SELECTOR: [number, number, number, number] = [0xde, 0xad, 0xbe, 0xef];
const TEST_JOURNAL = {
  seed_id: 778899,
  seed: 0x12345678,
  frame_count: 1000,
  final_score: 42,
  claimant: CLAIMANT,
};

test("builds + parses v4 artifact from known compact journal byte layout", async () => {
  const literalJournal = new Uint8Array(JOURNAL_LEN);
  const view = new DataView(literalJournal.buffer);
  view.setUint32(0, 0x01020304, true); // seed_id
  view.setUint32(4, 0x05060708, true); // seed
  view.setUint32(8, 0x11121314, true); // frame_count
  view.setUint32(12, 0x21222324, true); // final_score
  literalJournal[16] = 0; // claimant kind = account
  // claimant payload bytes remain zero => GAAAA...WHF

  const artifact = await buildProofArtifactV4(
    "boundless",
    "2026-01-01T00:00:00.000Z",
    makeFakeSeal(TEST_SELECTOR),
    literalJournal,
  );
  const parsed = parseProofArtifactV4(artifact);
  const journal = decodeClaimantFromJournal(literalJournal.slice(16, 49));
  const digest = await sha256Hex(literalJournal);

  assert(parsed.version === "v4", "version mismatch");
  assert(parsed.backend === "boundless", "backend mismatch");
  assert(parsed.journal_digest_hex === digest, "journal digest mismatch");
  assert(journal === CLAIMANT, "literal journal claimant mismatch");
});

test("builds v4 artifact with canonical fields", async () => {
  const journalBytes = makeFakeJournal(TEST_JOURNAL);
  const sealBytes = makeFakeSeal(TEST_SELECTOR);
  const artifact = await buildProofArtifactV4(
    "boundless",
    "2026-01-01T00:00:00.000Z",
    sealBytes,
    journalBytes,
  );
  const parsed = parseProofArtifactV4(artifact);

  assert(parsed.requested_receipt_kind === "groth16", "requested receipt kind mismatch");
  assert(parsed.produced_receipt_kind === "groth16", "produced receipt kind mismatch");
  assert(parsed.seal_hex.length === 520, "seal_hex length mismatch");
  assert(parsed.journal_raw_hex.length === 98, "journal_raw_hex length mismatch");
});

test("throws when parsing artifact with non-v4 version", () => {
  let threw = false;
  try {
    parseProofArtifactV4({
      version: "v3",
      stored_at: "2026-01-01T00:00:00.000Z",
      backend: "boundless",
      seal_hex: "00".repeat(260),
      journal_raw_hex: "11".repeat(49),
      journal_digest_hex: "22".repeat(32),
      requested_receipt_kind: "groth16",
      produced_receipt_kind: "groth16",
    });
  } catch {
    threw = true;
  }
  assert(threw, "expected non-v4 version to throw");
});

test("throws when journal length is not 49 bytes", async () => {
  let threw = false;
  try {
    await buildProofArtifactV4(
      "boundless",
      "2026-01-01T00:00:00.000Z",
      makeFakeSeal(TEST_SELECTOR),
      new Uint8Array(32),
    );
  } catch {
    threw = true;
  }
  assert(threw, "expected short journal to throw");
});

test("throws when seal length is not 260 bytes", async () => {
  let threw = false;
  try {
    await buildProofArtifactV4(
      "boundless",
      "2026-01-01T00:00:00.000Z",
      new Uint8Array(32),
      makeFakeJournal(TEST_JOURNAL),
    );
  } catch {
    threw = true;
  }
  assert(threw, "expected short seal to throw");
});

await Promise.all(pendingTests);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  process.exit(1);
}
