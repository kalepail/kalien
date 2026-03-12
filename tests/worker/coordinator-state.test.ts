import { afterAll, describe, expect, it, mock } from "bun:test";
import type { WorkerEnv } from "../../worker/env";
import type { ProofJobRecord, ProofResultSummary } from "../../worker/types";
import { CLAIM_AUTO_RETRY_COOLDOWN_MS } from "../../worker/constants";

mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject<Env = unknown> {
    protected ctx: unknown;
    protected env: Env;

    constructor(ctx: unknown, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { ProofCoordinatorDO } = await import("../../worker/durable/coordinator");

afterAll(() => {
  mock.restore();
});

const TEST_CLAIMANT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const BASE_SUMMARY: ProofResultSummary = {
  elapsedMs: 5_000,
  requestedReceiptKind: "groth16",
  producedReceiptKind: "groth16",
  journal: {
    seed_id: 1,
    seed: 42,
    frame_count: 120,
    final_score: 777,
    claimant: TEST_CLAIMANT,
  },
  stats: {
    segments: 2,
    total_cycles: 10_000,
    user_cycles: 8_000,
    paging_cycles: 1_000,
    reserved_cycles: 1_000,
  },
};

type StoredJobRow = {
  job_id: string;
  status: ProofJobRecord["status"];
  claimant_address: string;
  created_at: string;
  completed_at: string | null;
  data: string;
};

class MockSqlResult {
  constructor(private readonly rows: Array<Record<string, unknown>>) {}

  toArray(): Array<Record<string, unknown>> {
    return [...this.rows];
  }
}

class MockSql {
  readonly rows = new Map<string, StoredJobRow>();

  exec(query: string, ...params: unknown[]): MockSqlResult {
    const normalized = query.replaceAll(/\s+/g, " ").trim();

    if (normalized.startsWith("CREATE TABLE") || normalized.startsWith("CREATE INDEX")) {
      return new MockSqlResult([]);
    }

    if (normalized.startsWith("INSERT OR REPLACE INTO jobs")) {
      const [jobId, status, claimantAddress, createdAt, completedAt, data] = params as [
        string,
        ProofJobRecord["status"],
        string,
        string,
        string | null,
        string,
      ];
      this.rows.set(jobId, {
        job_id: jobId,
        status,
        claimant_address: claimantAddress,
        created_at: createdAt,
        completed_at: completedAt,
        data,
      });
      return new MockSqlResult([]);
    }

    if (normalized === "SELECT data FROM jobs WHERE job_id = ?") {
      const jobId = params[0] as string;
      const row = this.rows.get(jobId);
      return new MockSqlResult(row ? [{ data: row.data }] : []);
    }

    if (normalized === "SELECT job_id FROM jobs WHERE status NOT IN ('succeeded', 'failed')") {
      return new MockSqlResult(
        [...this.rows.values()]
          .filter((row) => row.status !== "succeeded" && row.status !== "failed")
          .map((row) => ({ job_id: row.job_id })),
      );
    }

    if (normalized === "SELECT job_id FROM jobs WHERE status = 'succeeded'") {
      return new MockSqlResult(
        [...this.rows.values()]
          .filter((row) => row.status === "succeeded")
          .map((row) => ({ job_id: row.job_id })),
      );
    }

    if (normalized === "SELECT data FROM jobs WHERE status = 'succeeded'") {
      return new MockSqlResult(
        [...this.rows.values()]
          .filter((row) => row.status === "succeeded")
          .map((row) => ({ data: row.data })),
      );
    }

    if (
      normalized ===
      "SELECT job_id, status, completed_at, created_at, data FROM jobs WHERE status IN ('succeeded', 'failed')"
    ) {
      return new MockSqlResult(
        [...this.rows.values()]
          .filter((row) => row.status === "succeeded" || row.status === "failed")
          .map((row) => ({
            job_id: row.job_id,
            status: row.status,
            completed_at: row.completed_at,
            created_at: row.created_at,
            data: row.data,
          })),
      );
    }

    if (normalized === "DELETE FROM jobs WHERE job_id = ?") {
      this.rows.delete(params[0] as string);
      return new MockSqlResult([]);
    }

    if (normalized === "SELECT 1 FROM jobs LIMIT 1") {
      const [firstRow] = this.rows.values();
      return new MockSqlResult(firstRow ? [{ 1: 1 }] : []);
    }

    if (normalized === "SELECT COUNT(*) as cnt FROM jobs WHERE claimant_address = ?") {
      const claimantAddress = params[0] as string;
      const count = [...this.rows.values()].filter(
        (row) => row.claimant_address === claimantAddress,
      ).length;
      return new MockSqlResult([{ cnt: count }]);
    }

    if (
      normalized ===
      "SELECT data FROM jobs WHERE claimant_address = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ) {
      const [claimantAddress, limitRaw, offsetRaw] = params as [string, number, number];
      const rows = [...this.rows.values()]
        .filter((row) => row.claimant_address === claimantAddress)
        .toSorted((left, right) => right.created_at.localeCompare(left.created_at))
        .slice(offsetRaw, offsetRaw + limitRaw)
        .map((row) => ({ data: row.data }));
      return new MockSqlResult(rows);
    }

    throw new Error(`Unhandled SQL in test harness: ${normalized}`);
  }
}

class MockStorage {
  readonly sql = new MockSql();
  private alarmAt: number | null = null;

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(value: number): Promise<void> {
    this.alarmAt = value;
  }

  async deleteAll(): Promise<void> {
    this.sql.rows.clear();
    this.alarmAt = null;
  }
}

type CoordinatorHarness = ReturnType<typeof createCoordinatorHarness>;

function createCoordinatorHarness(envOverrides: Partial<WorkerEnv> = {}): {
  coordinator: ProofCoordinatorDO;
  storage: MockStorage;
  claimQueueSends: Array<{ jobId: string }>;
  proofQueueSends: Array<{ jobId: string }>;
  vastQueueSends: Array<{ jobId: string }>;
} {
  const storage = new MockStorage();
  const claimQueueSends: Array<{ jobId: string }> = [];
  const proofQueueSends: Array<{ jobId: string }> = [];
  const vastQueueSends: Array<{ jobId: string }> = [];

  const env = {
    CLAIM_QUEUE: {
      send: async (message: { jobId: string }) => {
        claimQueueSends.push(message);
      },
    },
    PROOF_QUEUE: {
      send: async (message: { jobId: string }) => {
        proofQueueSends.push(message);
      },
    },
    VAST_QUEUE: {
      send: async (message: { jobId: string }) => {
        vastQueueSends.push(message);
      },
    },
    PROVER_BASE_URL: "https://prover.test",
    ...envOverrides,
  } as unknown as WorkerEnv;

  const state = {
    storage,
    waitUntil(_promise: Promise<unknown>) {
      // no-op in tests
    },
  } as unknown;

  const coordinator = new ProofCoordinatorDO(state as never, env);
  return {
    coordinator,
    storage,
    claimQueueSends,
    proofQueueSends,
    vastQueueSends,
  };
}

function readStoredJob(harness: CoordinatorHarness, jobId: string): ProofJobRecord | null {
  const row = harness.storage.sql.rows.get(jobId);
  if (!row) {
    return null;
  }
  return JSON.parse(row.data) as ProofJobRecord;
}

function writeStoredJob(harness: CoordinatorHarness, job: ProofJobRecord): void {
  harness.storage.sql.rows.set(job.jobId, {
    job_id: job.jobId,
    status: job.status,
    claimant_address: job.claim.claimantAddress,
    created_at: job.createdAt,
    completed_at: job.completedAt,
    data: JSON.stringify(job),
  });
}

function mutateStoredJob(
  harness: CoordinatorHarness,
  jobId: string,
  mutate: (job: ProofJobRecord) => void,
): ProofJobRecord {
  const job = readStoredJob(harness, jobId);
  if (!job) {
    throw new Error(`missing job ${jobId}`);
  }
  mutate(job);
  writeStoredJob(harness, job);
  return job;
}

function staleIso(offsetMs = CLAIM_AUTO_RETRY_COOLDOWN_MS + 5_000): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

async function createSucceededJob(harness: CoordinatorHarness): Promise<string> {
  const accepted = await harness.coordinator.createJob({
    claimantAddress: TEST_CLAIMANT,
    sizeBytes: 1_024,
    metadata: {
      seed: 42,
      seedId: 1,
      frameCount: 120,
      finalScore: 777,
      checksum: 1234,
    },
  });
  const jobId = accepted.job.jobId;
  await harness.coordinator.markProverAccepted(jobId, "req-0x1", "boundless:0x1", 21);
  await harness.coordinator.markSucceeded(jobId, BASE_SUMMARY, `proof-jobs/${jobId}/result.json`);
  return jobId;
}

describe("ProofCoordinatorDO state machine", () => {
  it("leases proof dispatch to a single delivery before prover acceptance", async () => {
    const harness = createCoordinatorHarness();
    const accepted = await harness.coordinator.createJob({
      claimantAddress: TEST_CLAIMANT,
      sizeBytes: 512,
      metadata: {
        seed: 7,
        seedId: 77,
        frameCount: 30,
        finalScore: 500,
        checksum: 42,
      },
    });
    const jobId = accepted.job.jobId;

    const first = await harness.coordinator.beginQueueAttempt(
      jobId,
      1,
      "boundless",
      "boundless:msg-1:1",
    );
    const second = await harness.coordinator.beginQueueAttempt(
      jobId,
      1,
      "boundless",
      "boundless:msg-2:1",
    );

    expect(first?.queue.activeDeliveryId).toBe("boundless:msg-1:1");
    expect(second?.queue.activeDeliveryId).toBe("boundless:msg-1:1");

    await harness.coordinator.markProverAccepted(jobId, "req-0xabc", "boundless:0xabc", 21);
    await harness.coordinator.markProverAccepted(jobId, "req-0xabc", "boundless:0xabc", 21);

    const stored = readStoredJob(harness, jobId);
    expect(stored?.queue.activeDeliveryId).toBeNull();
    expect(stored?.prover.jobId).toBe("req-0xabc");
    expect(stored?.proverAttempts).toHaveLength(1);
    expect(stored?.prover.activeAttemptIndex).toBe(0);
  });

  it("reuses the active claim attempt instead of appending duplicates", async () => {
    const harness = createCoordinatorHarness();
    const jobId = await createSucceededJob(harness);

    const first = await harness.coordinator.beginClaimAttempt(jobId, 1);
    const second = await harness.coordinator.beginClaimAttempt(jobId, 2);
    const stored = readStoredJob(harness, jobId);

    expect(first?.claim.activeAttemptIndex).toBe(0);
    expect(second?.claim.activeAttemptIndex).toBe(0);
    expect(stored?.claimAttempts).toHaveLength(1);
    expect(stored?.claimAttempts[0]?.outcome).toBe("in_progress");
    expect(stored?.claim.attempts).toBe(2);
  });

  it("does not duplicate queued claims during maintenance when they have not started yet", async () => {
    const harness = createCoordinatorHarness();
    const jobId = await createSucceededJob(harness);
    harness.claimQueueSends.length = 0;

    mutateStoredJob(harness, jobId, (job) => {
      const staleAt = staleIso();
      job.updatedAt = staleAt;
      job.completedAt = staleAt;
      job.claim.status = "queued";
      job.claim.lastAttemptAt = staleAt;
      job.claim.lastError = null;
      job.claim.nextRetryAt = null;
    });

    const summary = await harness.coordinator.runMaintenance();
    const stored = readStoredJob(harness, jobId);

    expect(summary.claimsRequeued).toBe(0);
    expect(summary.staleQueuedClaimsRequeued).toBe(0);
    expect(harness.claimQueueSends).toHaveLength(0);
    expect(stored?.claim.status).toBe("queued");
  });

  it("requeues stale retrying claims during maintenance", async () => {
    const harness = createCoordinatorHarness();
    const jobId = await createSucceededJob(harness);
    await harness.coordinator.beginClaimAttempt(jobId, 1);
    await harness.coordinator.markClaimRetry(jobId, "relay timeout", staleIso(20_000), "timeout");
    harness.claimQueueSends.length = 0;

    mutateStoredJob(harness, jobId, (job) => {
      const staleAt = staleIso();
      job.updatedAt = staleAt;
      job.completedAt = staleAt;
      job.claim.lastAttemptAt = staleAt;
      job.claim.nextRetryAt = staleIso(20_000);
      job.claimAttempts[0].startedAt = staleAt;
      job.claimAttempts[0].endedAt = staleAt;
    });

    const summary = await harness.coordinator.runMaintenance();
    const stored = readStoredJob(harness, jobId);

    expect(summary.claimsRequeued).toBe(1);
    expect(summary.staleRetryingClaimsRequeued).toBe(1);
    expect(harness.claimQueueSends).toEqual([{ jobId }]);
    expect(stored?.claim.status).toBe("queued");
  });

  it("recovers stale submitting claims during maintenance", async () => {
    const harness = createCoordinatorHarness();
    const jobId = await createSucceededJob(harness);
    await harness.coordinator.beginClaimAttempt(jobId, 1);
    harness.claimQueueSends.length = 0;

    mutateStoredJob(harness, jobId, (job) => {
      const staleAt = staleIso();
      job.updatedAt = staleAt;
      job.completedAt = staleAt;
      job.claim.lastAttemptAt = staleAt;
      job.claim.status = "submitting";
      job.claim.activeAttemptIndex = 0;
      job.claimAttempts[0].startedAt = staleAt;
      job.claimAttempts[0].endedAt = null;
      job.claimAttempts[0].outcome = "in_progress";
    });

    const summary = await harness.coordinator.runMaintenance();
    const stored = readStoredJob(harness, jobId);

    expect(summary.claimsRequeued).toBe(1);
    expect(summary.staleSubmittingClaimsRecovered).toBe(1);
    expect(harness.claimQueueSends).toEqual([{ jobId }]);
    expect(stored?.claim.status).toBe("queued");
    expect(stored?.claim.activeAttemptIndex).toBeNull();
    expect(stored?.claimAttempts[0]?.outcome).toBe("failed");
    expect(stored?.claimAttempts[0]?.error).toContain("maintenance recovered stale claim");
  });

  it("skips automatic retries for deterministic fatal claim errors recorded on attempts", async () => {
    const harness = createCoordinatorHarness();
    const jobId = await createSucceededJob(harness);
    await harness.coordinator.beginClaimAttempt(jobId, 1);
    await harness.coordinator.markClaimFailed(jobId, "submission failed", "contract, #1");
    harness.claimQueueSends.length = 0;

    mutateStoredJob(harness, jobId, (job) => {
      const staleAt = staleIso();
      job.updatedAt = staleAt;
      job.completedAt = staleAt;
      job.claim.lastAttemptAt = staleAt;
    });

    const summary = await harness.coordinator.runMaintenance();
    const stored = readStoredJob(harness, jobId);

    expect(summary.claimsRequeued).toBe(0);
    expect(harness.claimQueueSends).toHaveLength(0);
    expect(stored?.claim.status).toBe("failed");
  });

  it("skips automatic retries for deterministic local artifact validation failures", async () => {
    const harness = createCoordinatorHarness();
    const jobId = await createSucceededJob(harness);
    await harness.coordinator.beginClaimAttempt(jobId, 1);
    await harness.coordinator.markClaimFailed(
      jobId,
      "invalid proof artifact payload: missing journal_digest_hex",
    );
    harness.claimQueueSends.length = 0;

    mutateStoredJob(harness, jobId, (job) => {
      const staleAt = staleIso();
      job.updatedAt = staleAt;
      job.completedAt = staleAt;
      job.claim.lastAttemptAt = staleAt;
    });

    const summary = await harness.coordinator.runMaintenance();
    const stored = readStoredJob(harness, jobId);

    expect(summary.claimsRequeued).toBe(0);
    expect(harness.claimQueueSends).toHaveLength(0);
    expect(stored?.claim.status).toBe("failed");
  });

  it("keeps succeeded proofs with unfinished claims while pruning fully terminal jobs", async () => {
    const harness = createCoordinatorHarness({
      COMPLETED_JOB_RETENTION_MS: "60000",
    });

    const queuedJobId = await createSucceededJob(harness);
    const fullyClaimedJobId = await createSucceededJob(harness);
    await harness.coordinator.beginClaimAttempt(fullyClaimedJobId, 1);
    await harness.coordinator.markClaimSucceeded(fullyClaimedJobId, "tx-123");

    const failedAccepted = await harness.coordinator.createJob({
      claimantAddress: TEST_CLAIMANT,
      sizeBytes: 256,
      metadata: {
        seed: 8,
        seedId: 88,
        frameCount: 10,
        finalScore: 10,
        checksum: 8,
      },
    });
    const failedJobId = failedAccepted.job.jobId;
    await harness.coordinator.markFailed(failedJobId, "fatal proof failure");

    for (const jobId of [queuedJobId, fullyClaimedJobId, failedJobId]) {
      mutateStoredJob(harness, jobId, (job) => {
        const staleAt = new Date(Date.now() - 120_000).toISOString();
        job.createdAt = staleAt;
        job.updatedAt = staleAt;
        job.completedAt = staleAt;
        if (job.claim.lastAttemptAt) {
          job.claim.lastAttemptAt = staleAt;
        }
        if (job.claim.submittedAt) {
          job.claim.submittedAt = staleAt;
        }
      });
    }

    await harness.coordinator.runMaintenance();

    expect(readStoredJob(harness, queuedJobId)?.claim.status).toBe("queued");
    expect(readStoredJob(harness, fullyClaimedJobId)).toBeNull();
    expect(readStoredJob(harness, failedJobId)).toBeNull();
  });

  it("normalizes legacy jobs with multiple open attempts on load", async () => {
    const harness = createCoordinatorHarness();
    const staleAt = staleIso();
    const jobId = "legacy-job";

    writeStoredJob(harness, {
      jobId,
      status: "succeeded",
      createdAt: staleAt,
      updatedAt: staleAt,
      completedAt: staleAt,
      tape: {
        sizeBytes: 1,
        key: `proof-jobs/${jobId}/input.tape`,
        metadata: {
          seed: 42,
          seedId: 1,
          frameCount: 120,
          finalScore: 777,
          checksum: 111,
        },
      },
      queue: {
        attempts: 1,
        lastAttemptAt: staleAt,
        lastError: null,
        nextRetryAt: null,
      },
      prover: {
        jobId: "req-legacy",
        status: "running",
        statusUrl: "boundless:0xlegacy",
        segmentLimitPo2: 21,
        lastPolledAt: staleAt,
        pollingErrors: 0,
      },
      proverAttempts: [
        {
          index: 0,
          backend: "boundless",
          startedAt: staleAt,
          endedAt: null,
          outcome: "in_progress",
          error: null,
          errorDetail: null,
          errorCode: null,
          proverJobId: "req-old",
          statusUrl: "boundless:0xold",
          actualCostUsd: null,
          proverAddress: null,
          fulfillmentTxHash: null,
          programCycles: null,
          totalCycles: null,
        },
        {
          index: 1,
          backend: "vast",
          startedAt: staleAt,
          endedAt: null,
          outcome: "in_progress",
          error: null,
          errorDetail: null,
          errorCode: null,
          proverJobId: "req-new",
          statusUrl: "https://prover.test/api/jobs/req-new",
          actualCostUsd: null,
          proverAddress: null,
          fulfillmentTxHash: null,
          programCycles: null,
          totalCycles: null,
        },
      ],
      claimAttempts: [
        {
          index: 0,
          startedAt: staleAt,
          endedAt: null,
          outcome: "in_progress",
          error: null,
          errorDetail: null,
          txHash: null,
        },
        {
          index: 1,
          startedAt: staleAt,
          endedAt: null,
          outcome: "in_progress",
          error: null,
          errorDetail: null,
          txHash: null,
        },
      ],
      result: {
        artifactKey: `proof-jobs/${jobId}/result.json`,
        summary: BASE_SUMMARY,
      },
      claim: {
        claimantAddress: TEST_CLAIMANT,
        status: "submitting",
        attempts: 2,
        lastAttemptAt: staleAt,
        lastError: null,
        nextRetryAt: null,
        submittedAt: null,
        txHash: null,
      },
      error: null,
    });

    const job = await harness.coordinator.getJob(jobId);
    const stored = readStoredJob(harness, jobId);

    expect(job?.prover.activeAttemptIndex).toBe(1);
    expect(job?.claim.activeAttemptIndex).toBe(1);
    expect(stored?.proverAttempts[0]?.outcome).toBe("failed");
    expect(stored?.proverAttempts[0]?.error).toContain(
      "recovered stale in-progress prover attempt",
    );
    expect(stored?.claimAttempts[0]?.outcome).toBe("failed");
    expect(stored?.claimAttempts[0]?.error).toContain("recovered stale in-progress claim attempt");
    expect(stored?.queue.activeDeliveryId).toBeNull();
  });
});
