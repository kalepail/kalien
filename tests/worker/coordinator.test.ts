import { afterAll, describe, expect, it, mock } from "bun:test";

// Mock cloudflare:workers before importing coordinator
function MockDurableObject() {}

mock.module("cloudflare:workers", () => ({
  DurableObject: MockDurableObject,
}));

const { asPublicJob } = await import("../../worker/durable/coordinator");
import type { ProofJobRecord, ProverAttempt } from "../../worker/types";

afterAll(() => {
  mock.restore();
});

function makeAttempt(overrides: Partial<ProverAttempt> = {}): ProverAttempt {
  return {
    index: 0,
    backend: "boundless",
    startedAt: "2026-01-01T00:00:30.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    outcome: "success",
    error: null,
    errorDetail: null,
    errorCode: null,
    proverJobId: "req-0x1234",
    statusUrl: "boundless:0x1234",
    actualCostUsd: null,
    proverAddress: null,
    fulfillmentTxHash: null,
    ...overrides,
  };
}

function makeJob(overrides: Partial<ProofJobRecord> = {}): ProofJobRecord {
  return {
    jobId: "job-1",
    status: "succeeded",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    tape: {
      sizeBytes: 1024,
      key: "proof-jobs/job-1/input.tape",
      metadata: {
        seed: 42,
        frameCount: 100,
        finalScore: 1337,
        checksum: 0xabcd,
      },
    },
    queue: {
      attempts: 1,
      lastAttemptAt: "2026-01-01T00:00:30.000Z",
      lastError: null,
      nextRetryAt: null,
    },
    prover: {
      jobId: "prover-job-1",
      status: "succeeded",
      statusUrl: "/api/jobs/prover-job-1",
      segmentLimitPo2: 21,
      lastPolledAt: "2026-01-01T00:01:00.000Z",
      pollingErrors: 0,
    },
    proverAttempts: [makeAttempt()],
    result: {
      artifactKey: "proof-jobs/job-1/result.json",
      summary: {
        elapsedMs: 5000,
        requestedReceiptKind: "groth16",
        producedReceiptKind: "groth16",
        journal: {
          seed_id: 123,
          seed: 42,
          frame_count: 100,
          final_score: 1337,
          claimant: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        },
        stats: {
          segments: 4,
          total_cycles: 10000,
          user_cycles: 8000,
          paging_cycles: 1000,
          reserved_cycles: 1000,
        },
      },
    },
    claim: {
      claimantAddress: "GCHPTWXMT3HYF4RLZHWBNRF4MPXLTJ76ISHMSYIWCCDXWUYOQG5MR2AB",
      status: "succeeded",
      attempts: 1,
      lastAttemptAt: "2026-01-01T00:01:30.000Z",
      lastError: null,
      nextRetryAt: null,
      submittedAt: "2026-01-01T00:01:30.000Z",
      txHash: "tx-hash-1",
    },
    error: null,
    ...overrides,
  };
}

describe("coordinator helpers", () => {
  describe("asPublicJob", () => {
    it("strips tape.key from the result", () => {
      const job = makeJob();
      const publicJob = asPublicJob(job);
      expect((publicJob.tape as Record<string, unknown>).key).toBeUndefined();
      expect(publicJob.tape.sizeBytes).toBe(1024);
      expect(publicJob.tape.metadata.seed).toBe(42);
    });

    it("preserves all other fields", () => {
      const job = makeJob();
      const publicJob = asPublicJob(job);
      expect(publicJob.jobId).toBe("job-1");
      expect(publicJob.status).toBe("succeeded");
      expect(publicJob.queue.attempts).toBe(1);
      expect(publicJob.prover.jobId).toBe("prover-job-1");
      expect(publicJob.result?.artifactKey).toBe("proof-jobs/job-1/result.json");
      expect(publicJob.claim.txHash).toBe("tx-hash-1");
      expect(publicJob.error).toBeNull();
    });

    it("handles null result", () => {
      const job = makeJob({ result: null });
      const publicJob = asPublicJob(job);
      expect(publicJob.result).toBeNull();
    });

    it("includes proverAttempts array", () => {
      const attempts = [
        makeAttempt({
          index: 0,
          backend: "boundless",
          outcome: "failed",
          error: "timeout",
        }),
        makeAttempt({
          index: 1,
          backend: "vast",
          outcome: "success",
          error: null,
        }),
      ];
      const job = makeJob({ proverAttempts: attempts });
      const publicJob = asPublicJob(job);
      expect(publicJob.proverAttempts).toHaveLength(2);
      expect(publicJob.proverAttempts[0].backend).toBe("boundless");
      expect(publicJob.proverAttempts[0].outcome).toBe("failed");
      expect(publicJob.proverAttempts[1].backend).toBe("vast");
      expect(publicJob.proverAttempts[1].outcome).toBe("success");
    });

    it("preserves in_progress attempt (currently running)", () => {
      const attempt = makeAttempt({
        index: 0,
        backend: "boundless",
        outcome: "in_progress",
        endedAt: null,
        error: null,
      });
      const job = makeJob({ proverAttempts: [attempt] });
      const publicJob = asPublicJob(job);
      expect(publicJob.proverAttempts[0].outcome).toBe("in_progress");
      expect(publicJob.proverAttempts[0].endedAt).toBeNull();
    });

    it("strips internal lease and active-attempt bookkeeping fields", () => {
      const job = makeJob({
        queue: {
          attempts: 1,
          lastAttemptAt: "2026-01-01T00:00:30.000Z",
          lastError: null,
          nextRetryAt: null,
          activeDeliveryId: "boundless:msg-1:1",
          activeBackend: "boundless",
          activeDeliveryStartedAt: "2026-01-01T00:00:30.000Z",
        },
        prover: {
          jobId: "prover-job-1",
          status: "succeeded",
          statusUrl: "/api/jobs/prover-job-1",
          segmentLimitPo2: 21,
          lastPolledAt: "2026-01-01T00:01:00.000Z",
          pollingErrors: 0,
          activeAttemptIndex: 0,
        },
        claim: {
          claimantAddress: "GCHPTWXMT3HYF4RLZHWBNRF4MPXLTJ76ISHMSYIWCCDXWUYOQG5MR2AB",
          status: "succeeded",
          attempts: 1,
          lastAttemptAt: "2026-01-01T00:01:30.000Z",
          lastError: null,
          nextRetryAt: null,
          submittedAt: "2026-01-01T00:01:30.000Z",
          txHash: "tx-hash-1",
          activeAttemptIndex: 0,
        },
      });

      const publicJob = asPublicJob(job);

      expect((publicJob.queue as Record<string, unknown>).activeDeliveryId).toBeUndefined();
      expect((publicJob.queue as Record<string, unknown>).activeBackend).toBeUndefined();
      expect((publicJob.prover as Record<string, unknown>).activeAttemptIndex).toBeUndefined();
      expect((publicJob.claim as Record<string, unknown>).activeAttemptIndex).toBeUndefined();
    });
  });
});
