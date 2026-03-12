/**
 * Live integration tests against the real Vast.ai prover.
 *
 * These tests hit the actual prover at PROVER_BASE_URL and generate real proofs.
 * They verify the full worker prover client pipeline:
 *   getValidatedProverHealth → submitToProver → pollProverOnce → summarizeProof
 *
 * Skipped automatically when PROVER_BASE_URL is not set or prover is unreachable.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getValidatedProverHealth,
  submitToProver,
  pollProverOnce,
} from "../../worker/prover/client";
import type { WorkerEnv } from "../../worker/env";

const PROVER_BASE_URL = "https://risc0-kalien.stellar.buzz";
const TAPE_DIR = join(import.meta.dir, "../../test-fixtures");
const TEST_CLAIMANT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function makeEnv(overrides?: Partial<WorkerEnv>): WorkerEnv {
  return {
    PROVER_BASE_URL,
    PROVER_API_KEY: "",
    ALLOW_INSECURE_PROVER_URL: "0",
    ...overrides,
  } as WorkerEnv;
}

let proverReachable = false;

beforeAll(async () => {
  try {
    const response = await fetch(`${PROVER_BASE_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    proverReachable = response.ok;
  } catch {
    proverReachable = false;
  }
  if (!proverReachable) {
    console.warn("Prover unreachable — skipping live prover tests");
  }
});

function skipIfUnreachable() {
  if (!proverReachable) {
    return true;
  }
  return false;
}

describe("live prover integration", () => {
  // ───── Health check ─────

  it("getValidatedProverHealth returns valid health", async () => {
    if (skipIfUnreachable()) return;

    const env = makeEnv();
    const health = await getValidatedProverHealth(env, { forceRefresh: true });

    expect(health.imageId).toMatch(/^[0-9a-f]{64}$/);
    expect(health.rulesDigest).toBe(0x41535434 >>> 0);
    expect(health.rulesDigestHex).toBe("0x41535434");
    expect(health.ruleset).toBe("AST4");
  });

  it("getValidatedProverHealth rejects wrong expected image_id", async () => {
    if (skipIfUnreachable()) return;

    const env = makeEnv({
      PROVER_EXPECTED_IMAGE_ID: "0000000000000000000000000000000000000000000000000000000000000000",
    });

    await expect(getValidatedProverHealth(env, { forceRefresh: true })).rejects.toThrow(
      /image_id mismatch/,
    );
  });

  // ───── Submit + poll (medium tape, groth16) ─────

  it("submit → poll → summarize produces valid Groth16 proof for medium tape", async () => {
    if (skipIfUnreachable()) return;

    const env = makeEnv();
    const tapeBytes = new Uint8Array(readFileSync(join(TAPE_DIR, "test-medium.tape")));

    // Submit
    const seedId = 1;
    const submitResult = await submitToProver(env, tapeBytes, {
      segmentLimitPo2: 21,
      seedId,
      claimantAddress: TEST_CLAIMANT,
    });
    expect(submitResult.type).toBe("success");
    if (submitResult.type !== "success") return;

    expect(submitResult.jobId).toBeTruthy();
    expect(submitResult.statusUrl).toContain(submitResult.jobId);
    expect(submitResult.segmentLimitPo2).toBe(21);

    // Poll until done (max 5 minutes)
    const deadline = Date.now() + 300_000;
    let pollResult = await pollProverOnce(env, submitResult.jobId);

    /* eslint-disable no-await-in-loop -- live prover polling must remain sequential */
    while (pollResult.type === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      pollResult = await pollProverOnce(env, submitResult.jobId);
    }
    /* eslint-enable no-await-in-loop */

    expect(pollResult.type).toBe("success");
    if (pollResult.type !== "success") return;

    const summary = pollResult.summary;
    const journal = summary.journal;
    expect(journal.seed).toBe(0xdeadbeef >>> 0);
    expect(journal.seed_id).toBe(seedId);
    expect(journal.claimant).toBe(TEST_CLAIMANT);
    expect(journal.frame_count).toBe(5000);
    expect(journal.final_score).toBe(11190);

    expect(summary.requestedReceiptKind).toBe("groth16");
    expect(summary.producedReceiptKind).toBe("groth16");

    const stats = summary.stats;
    expect(stats.segments).toBeGreaterThan(0);
    expect(stats.total_cycles).toBeGreaterThan(0);

    const artifact = pollResult.artifact;
    expect(artifact.version).toBe("v4");
    expect(artifact.backend).toBe("vast");
    expect(artifact.seal_hex).toMatch(/^[0-9a-f]{520}$/);
    expect(artifact.journal_raw_hex).toMatch(/^[0-9a-f]{98}$/);
    expect(artifact.journal_digest_hex).toMatch(/^[0-9a-f]{64}$/);
  }, 300_000);

  // ───── Submit + poll (real game tape, groth16) ─────

  it("submit → poll → summarize produces valid proof for real game tape (score=14870)", async () => {
    if (skipIfUnreachable()) return;

    const env = makeEnv();
    const tapeBytes = new Uint8Array(readFileSync(join(TAPE_DIR, "test-real-game.tape")));

    const seedId = 2;
    const submitResult = await submitToProver(env, tapeBytes, {
      segmentLimitPo2: 21,
      seedId,
      claimantAddress: TEST_CLAIMANT,
    });
    expect(submitResult.type).toBe("success");
    if (submitResult.type !== "success") return;

    const deadline = Date.now() + 300_000;
    let pollResult = await pollProverOnce(env, submitResult.jobId);

    /* eslint-disable no-await-in-loop -- live prover polling must remain sequential */
    while (pollResult.type === "running" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5_000));
      pollResult = await pollProverOnce(env, submitResult.jobId);
    }
    /* eslint-enable no-await-in-loop */

    expect(pollResult.type).toBe("success");
    if (pollResult.type !== "success") return;

    const journal = pollResult.summary.journal;
    expect(journal.seed).toBe(0x43c9c6cd >>> 0);
    expect(journal.seed_id).toBe(seedId);
    expect(journal.claimant).toBe(TEST_CLAIMANT);
    expect(journal.frame_count).toBe(6643);
    expect(journal.final_score).toBe(14870);

    expect(pollResult.summary.producedReceiptKind).toBe("groth16");
    expect(pollResult.summary.journal.final_score).toBe(14870);
  }, 300_000);

  // ───── Short tape acceptance ─────

  it("accepts short tape (test-short, score=1480)", async () => {
    if (skipIfUnreachable()) return;

    const env = makeEnv();
    const tapeBytes = new Uint8Array(readFileSync(join(TAPE_DIR, "test-short.tape")));

    const submitResult = await submitToProver(env, tapeBytes, {
      segmentLimitPo2: 21,
      seedId: 3,
      claimantAddress: TEST_CLAIMANT,
    });
    // test-short.tape has score=1480 — valid tape, prover should accept
    expect(submitResult.type).toBe("success");
  });

  // ───── Poll nonexistent job ─────

  it("pollProverOnce returns retry for nonexistent job", async () => {
    if (skipIfUnreachable()) return;

    const env = makeEnv();
    const result = await pollProverOnce(env, "00000000-0000-0000-0000-000000000000");

    expect(result.type).toBe("retry");
    if (result.type === "retry") {
      expect(result.clearProverJob).toBe(true);
      expect(result.message).toMatch(/not found/i);
    }
  });
});
