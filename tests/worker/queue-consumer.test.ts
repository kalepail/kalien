import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { packJournalRaw, type JournalFields } from "../../shared/stellar/journal";
import { bytesToHex, sha256Hex, STELLAR_GROTH16_SEAL_LEN } from "../../worker/proof-artifact";
import type { WorkerEnv } from "../../worker/env";

const proofClaimIndexWrites: Array<{
  proofJobId: string;
  claimantAddress: string;
  txHash: string;
  seed: number;
  finalScore: number;
  completedAt: string;
}> = [];
const proofTapeMappingWrites: Array<{ txHash: string; proofJobId: string }> = [];
let proofClaimIndexWriteFailuresRemaining = 0;
let proofTapeMappingWriteFailuresRemaining = 0;

function MockProofCoordinatorDO() {}

// Mock coordinator and prover before importing the consumer
mock.module("../../worker/durable/coordinator", () => ({
  coordinatorStub: (env: WorkerEnv) =>
    (env as WorkerEnv & { __coordinator: Record<string, unknown> }).__coordinator,
  asPublicJob: <T>(job: T): T => job,
  ProofCoordinatorDO: MockProofCoordinatorDO,
}));

mock.module("../../worker/boundless/config", () => ({
  resolveBoundlessConfig: (env: WorkerEnv) =>
    (env as WorkerEnv & { __boundlessConfig?: unknown }).__boundlessConfig ?? null,
  IPFS_GATEWAY_PREFIX: "https://gateway.pinata.cloud/ipfs/",
  BOUNDLESS_INDEXER_URLS: {
    "8453": "https://d2mdvlnmyov1e1.cloudfront.net",
    "84532": "https://d3kkukmpiqlzm1.cloudfront.net",
  },
  MAX_INLINE_STDIN_BYTES: 3000,
}));

mock.module("../../worker/boundless/sdk/client", () => ({
  BoundlessClient: class MockBoundlessClient {
    async submitRequest(_tape: Uint8Array, _metadata: unknown) {
      return (globalThis as Record<string, unknown>).__boundlessSubmitResult;
    }
  },
  fetchBoundlessCycles: async () => ({
    programCycles: null,
    totalCycles: null,
  }),
}));

mock.module("../../worker/prover/client", () => ({
  submitToProver: async (env: WorkerEnv, _tape: Uint8Array, _opts: unknown) =>
    (env as WorkerEnv & { __submitResult: unknown }).__submitResult,
  getValidatedProverHealth: async () => {
    throw new Error("health check not mocked in queue consumer tests");
  },
  describeProverHealthError: (error: unknown) => ({
    retryable: false,
    message: error instanceof Error ? error.message : String(error),
  }),
}));

mock.module("../../worker/claim/submit", () => ({
  submitClaim: async (env: WorkerEnv, _request: unknown) => {
    const result = (env as WorkerEnv & { __claimResult: unknown }).__claimResult;
    // Fallback for when this mock leaks to other test files
    return (
      result ?? {
        type: "fatal",
        message:
          "claim submission is not configured; set SCORE_CONTRACT_ID, RELAYER_URL, and RELAYER_API_KEY for relayer-only submission",
      }
    );
  },
}));

mock.module("../../worker/leaderboard-store", () => ({
  writeProofClaimIndexEntry: async (
    _env: WorkerEnv,
    entry: {
      proofJobId: string;
      claimantAddress: string;
      txHash: string;
      seed: number;
      finalScore: number;
      completedAt: string;
    },
  ) => {
    if (proofClaimIndexWriteFailuresRemaining > 0) {
      proofClaimIndexWriteFailuresRemaining -= 1;
      throw new Error("proof claim index write failed");
    }
    proofClaimIndexWrites.push(entry);
  },
  writeProofTapeMapping: async (_env: WorkerEnv, txHash: string, proofJobId: string) => {
    if (proofTapeMappingWriteFailuresRemaining > 0) {
      proofTapeMappingWriteFailuresRemaining -= 1;
      throw new Error("proof tape mapping write failed");
    }
    proofTapeMappingWrites.push({ txHash, proofJobId });
  },
}));

const {
  handleQueueBatch,
  handleVastQueueBatch,
  handleDlqBatch,
  handleClaimQueueBatch,
  handleClaimDlqBatch,
} = await import("../../worker/queue/consumer");

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  proofClaimIndexWrites.length = 0;
  proofTapeMappingWrites.length = 0;
  proofClaimIndexWriteFailuresRemaining = 0;
  proofTapeMappingWriteFailuresRemaining = 0;
});

function makeMessage<T>(body: T, attempts = 1): Message<T> {
  let acked = false;
  let retried = false;
  return {
    body,
    id: "msg-1",
    timestamp: new Date(),
    attempts,
    ack() {
      acked = true;
    },
    retry(_options?: { delaySeconds?: number }) {
      retried = true;
    },
    get _acked() {
      return acked;
    },
    get _retried() {
      return retried;
    },
  } as Message<T> & { _acked: boolean; _retried: boolean };
}

function makeBatch<T>(messages: Message<T>[]): MessageBatch<T> {
  return {
    queue: "test-queue",
    messages,
    ackAll() {},
    retryAll() {},
  } as MessageBatch<T>;
}

function makeCoordinator(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const defaults: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    beginQueueAttempt: async () => null,
    getJob: async () => null,
    markFailed: async () => null,
    markDispatchFailedAndTryNextBackend: async () => null,
    markRetry: async () => null,
    markProverAccepted: async () => null,
    markSucceeded: async () => null,
    beginClaimAttempt: async () => null,
    markClaimFailed: async () => null,
    markClaimRetry: async () => null,
    markClaimSucceeded: async () => null,
    hasActiveVastJob: async () => false,
    getActiveVastJob: async () => null,
    kickAlarm: async () => undefined,
    listJobsForClaimant: async () => ({ jobs: [], total: 0 }),
  };

  const merged = { ...defaults, ...overrides };
  const tracked: Record<string, unknown> = { _calls: calls };
  for (const [method, fn] of Object.entries(merged)) {
    if (typeof fn === "function") {
      tracked[method] = async (...args: unknown[]) => {
        calls.push({ method, args });
        return (fn as (...a: unknown[]) => unknown)(...args);
      };
    } else {
      tracked[method] = fn;
    }
  }
  return tracked;
}

function makeEnv(overrides: Record<string, unknown> = {}): WorkerEnv {
  return {
    PROVER_BASE_URL: "https://prover.test",
    PROOF_ARTIFACTS: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    },
    PROOF_QUEUE: { send: async () => undefined },
    VAST_QUEUE: { send: async () => undefined },
    CLAIM_QUEUE: { send: async () => undefined },
    // Provide a truthy boundless config by default for Boundless queue tests
    __boundlessConfig: { rpcUrl: "https://rpc.test", privateKey: "0x1234" },
    ...overrides,
  } as unknown as WorkerEnv;
}

// ---------------------------------------------------------------------------
// Boundless queue (handleQueueBatch)
// ---------------------------------------------------------------------------

describe("handleQueueBatch (Boundless)", () => {
  it("acks message with invalid payload (missing jobId)", async () => {
    const msg = makeMessage({} as { jobId: string });
    await handleQueueBatch(makeBatch([msg]), makeEnv({ __coordinator: makeCoordinator() }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
  });

  it("acks when job is already terminal", async () => {
    const coordinator = makeCoordinator({
      beginQueueAttempt: async () => ({ jobId: "job-1", status: "succeeded" }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    await handleQueueBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
  });

  it("acks duplicate proof deliveries that do not own the active dispatch lease", async () => {
    const coordinator = makeCoordinator({
      beginQueueAttempt: async () => ({
        jobId: "job-1",
        status: "dispatching",
        tape: {
          key: "tapes/job-1",
          metadata: { finalScore: 100, seedId: 1 },
        },
        prover: { jobId: null },
        queue: { activeDeliveryId: "boundless:another-msg:1" },
        claim: { claimantAddress: "GABC" },
        createdAt: new Date().toISOString(),
      }),
      markProverAccepted: async () => null,
    });
    let tapeReads = 0;
    const msg = makeMessage({ jobId: "job-1" });
    const env = makeEnv({
      __coordinator: coordinator,
      PROOF_ARTIFACTS: {
        get: async () => {
          tapeReads += 1;
          return {
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
          };
        },
      },
    });

    await handleQueueBatch(makeBatch([msg]), env);

    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    expect(tapeReads).toBe(0);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markProverAccepted")).toBe(false);
  });

  it("continues a redelivery that still owns the active dispatch lease", async () => {
    const coordinator = makeCoordinator({
      beginQueueAttempt: async () => ({
        jobId: "job-1",
        status: "dispatching",
        tape: {
          key: "tapes/job-1",
          metadata: { finalScore: 100, seedId: 1 },
        },
        prover: { jobId: null },
        queue: { activeDeliveryId: "boundless:msg-1" },
        claim: { claimantAddress: "GABC" },
        createdAt: new Date().toISOString(),
      }),
      markProverAccepted: async () => null,
    });
    (globalThis as Record<string, unknown>).__boundlessSubmitResult = {
      type: "success",
      jobId: "boundless-job-1",
      statusUrl: "boundless:0x1234",
      segmentLimitPo2: 21,
    };
    let tapeReads = 0;
    const msg = makeMessage({ jobId: "job-1" }, 2);
    const env = makeEnv({
      __coordinator: coordinator,
      PROOF_ARTIFACTS: {
        get: async () => {
          tapeReads += 1;
          return {
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
          };
        },
      },
    });

    await handleQueueBatch(makeBatch([msg]), env);

    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    expect(tapeReads).toBe(1);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markProverAccepted")).toBe(true);
  });

  it("skips proof submission when a higher score is already claimed for the same seed_id", async () => {
    const claimant = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const coordinator = makeCoordinator({
      beginQueueAttempt: async () => ({
        jobId: "job-1",
        status: "dispatching",
        tape: {
          key: "tapes/job-1",
          metadata: { finalScore: 100, seedId: 1 },
        },
        prover: { jobId: null },
        claim: { claimantAddress: claimant },
        createdAt: new Date().toISOString(),
      }),
      listJobsForClaimant: async () => ({
        jobs: [
          {
            jobId: "job-winner",
            tape: { metadata: { finalScore: 150, seedId: 1 } },
            claim: { status: "succeeded" },
          },
        ],
        total: 1,
      }),
      markFailed: async () => null,
    });
    let tapeReads = 0;
    const msg = makeMessage({ jobId: "job-1" });
    const env = makeEnv({
      __coordinator: coordinator,
      PROOF_ARTIFACTS: {
        get: async () => {
          tapeReads += 1;
          return {
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
          };
        },
      },
    });
    await handleQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    expect(tapeReads).toBe(0);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
      args: unknown[];
    }>;
    const failedCall = calls.find((c) => c.method === "markFailed");
    expect(failedCall).toBeDefined();
    if (!failedCall) {
      throw new Error("expected markFailed call");
    }
    expect(String(failedCall.args[1])).toContain("superseded by claimed score");
    expect(calls.some((c) => c.method === "markProverAccepted")).toBe(false);
    expect(calls.some((c) => c.method === "markDispatchFailedAndTryNextBackend")).toBe(false);
  });

  it("marks prover accepted (not succeeded) on successful boundless submission", async () => {
    const coordinator = makeCoordinator({
      beginQueueAttempt: async () => ({
        jobId: "job-1",
        status: "dispatching",
        tape: {
          key: "tapes/job-1",
          metadata: { finalScore: 100, seedId: 1 },
        },
        prover: { jobId: null },
        claim: { claimantAddress: "GABC" },
        createdAt: new Date().toISOString(),
      }),
      markProverAccepted: async () => null,
    });
    (globalThis as Record<string, unknown>).__boundlessSubmitResult = {
      type: "success",
      jobId: "boundless-job-1",
      statusUrl: "boundless:0x1234",
      segmentLimitPo2: 21,
    };
    const msg = makeMessage({ jobId: "job-1" });
    const env = makeEnv({
      __coordinator: coordinator,
      PROOF_ARTIFACTS: {
        get: async () => ({
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }),
      },
    });
    await handleQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markProverAccepted")).toBe(true);
    expect(calls.some((c) => c.method === "markSucceeded")).toBe(false);
  });

  it("retries when boundless returns retry and attempts not exhausted", async () => {
    const coordinator = makeCoordinator({
      beginQueueAttempt: async () => ({
        jobId: "job-1",
        status: "dispatching",
        tape: {
          key: "tapes/job-1",
          metadata: { finalScore: 100, seedId: 1 },
        },
        prover: { jobId: null },
        claim: { claimantAddress: "GABC" },
        createdAt: new Date().toISOString(),
      }),
    });
    (globalThis as Record<string, unknown>).__boundlessSubmitResult = {
      type: "retry",
      message: "rate limited",
    };
    const msg = makeMessage({ jobId: "job-1" }, 1);
    const env = makeEnv({
      __coordinator: coordinator,
      PROOF_ARTIFACTS: {
        get: async () => ({
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }),
      },
    });
    await handleQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _retried: boolean })._retried).toBe(true);
  });

  it("falls back to the next backend when boundless returns fatal", async () => {
    const coordinator = makeCoordinator({
      beginQueueAttempt: async () => ({
        jobId: "job-1",
        status: "dispatching",
        tape: {
          key: "tapes/job-1",
          metadata: { finalScore: 100, seedId: 1 },
        },
        prover: { jobId: null },
        claim: { claimantAddress: "GABC" },
        createdAt: new Date().toISOString(),
      }),
    });
    (globalThis as Record<string, unknown>).__boundlessSubmitResult = {
      type: "fatal",
      message: "invalid tape",
    };
    const msg = makeMessage({ jobId: "job-1" });
    const env = makeEnv({
      __coordinator: coordinator,
      PROOF_ARTIFACTS: {
        get: async () => ({
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }),
      },
    });
    await handleQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markDispatchFailedAndTryNextBackend")).toBe(true);
  });

  it("falls back to the next backend when boundless delivery retries are exhausted", async () => {
    const coordinator = makeCoordinator({
      beginQueueAttempt: async () => ({
        jobId: "job-1",
        status: "dispatching",
        tape: {
          key: "tapes/job-1",
          metadata: { finalScore: 100, seedId: 1 },
        },
        prover: { jobId: null },
        claim: { claimantAddress: "GABC" },
        createdAt: new Date().toISOString(),
      }),
    });
    (globalThis as Record<string, unknown>).__boundlessSubmitResult = {
      type: "retry",
      message: "prover busy",
    };
    const msg = makeMessage({ jobId: "job-1" }, 10); // MAX_QUEUE_RETRIES = 10
    const env = makeEnv({
      __coordinator: coordinator,
      PROOF_ARTIFACTS: {
        get: async () => ({
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }),
      },
    });
    await handleQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markDispatchFailedAndTryNextBackend")).toBe(true);
  });

  it("falls back to the next backend when boundless config is missing", async () => {
    const coordinator = makeCoordinator({
      beginQueueAttempt: async () => ({
        jobId: "job-1",
        status: "dispatching",
        tape: {
          key: "tapes/job-1",
          metadata: { finalScore: 100, seedId: 1 },
        },
        prover: { jobId: null },
        claim: { claimantAddress: "GABC" },
        createdAt: new Date().toISOString(),
      }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    const env = makeEnv({
      __coordinator: coordinator,
      __boundlessConfig: null,
      PROOF_ARTIFACTS: {
        get: async () => ({
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }),
      },
    });
    await handleQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
      args: unknown[];
    }>;
    const failCall = calls.find((c) => c.method === "markDispatchFailedAndTryNextBackend");
    expect(failCall).toBeDefined();
    if (!failCall) {
      throw new Error("expected dispatch failure call");
    }
    expect(String(failCall.args[2])).toContain("boundless backend not configured");
  });
});

// ---------------------------------------------------------------------------
// VastAI queue (handleVastQueueBatch)
// ---------------------------------------------------------------------------

describe("handleVastQueueBatch (VastAI)", () => {
  it("acks message with invalid payload", async () => {
    const msg = makeMessage({} as { jobId: string });
    await handleVastQueueBatch(makeBatch([msg]), makeEnv({ __coordinator: makeCoordinator() }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
  });

  it("retries when vast slot is busy", async () => {
    const coordinator = makeCoordinator({
      hasActiveVastJob: async () => true,
      getJob: async () => ({
        jobId: "job-1",
        status: "queued",
        createdAt: new Date().toISOString(),
      }),
    });
    const msg = makeMessage({ jobId: "job-1" }, 1);
    await handleVastQueueBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));
    expect((msg as unknown as { _retried: boolean })._retried).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markRetry")).toBe(true);
  });

  it("skips waiting for vast slot when a higher score is already claimed for the same seed_id", async () => {
    const claimant = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const coordinator = makeCoordinator({
      hasActiveVastJob: async () => true,
      getJob: async () => ({
        jobId: "job-1",
        status: "queued",
        createdAt: new Date().toISOString(),
        tape: { metadata: { finalScore: 100, seedId: 1 } },
        claim: { claimantAddress: claimant },
      }),
      listJobsForClaimant: async () => ({
        jobs: [
          {
            jobId: "job-winner",
            tape: { metadata: { finalScore: 150, seedId: 1 } },
            claim: { status: "succeeded" },
          },
        ],
        total: 1,
      }),
      markFailed: async () => null,
    });
    const msg = makeMessage({ jobId: "job-1" }, 1);
    await handleVastQueueBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    expect((msg as unknown as { _retried: boolean })._retried).toBe(false);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
      args: unknown[];
    }>;
    const failedCall = calls.find((c) => c.method === "markFailed");
    expect(failedCall).toBeDefined();
    if (!failedCall) {
      throw new Error("expected markFailed call");
    }
    expect(String(failedCall.args[1])).toContain("superseded by claimed score");
    expect(calls.some((c) => c.method === "markRetry")).toBe(false);
  });

  it("recovers stale vast slot before retrying queued job", async () => {
    let slotBusy = true;
    const staleVastJob = {
      jobId: "job-active-vast",
      status: "prover_running",
      createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      prover: {
        jobId: "vast-prover-1",
        statusUrl: "https://prover.test/api/jobs/vast-prover-1",
        lastPolledAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      },
    };
    const coordinator = makeCoordinator({
      hasActiveVastJob: async () => slotBusy,
      getActiveVastJob: async () => (slotBusy ? staleVastJob : null),
      kickAlarm: async () => {
        // Current stale-slot recovery delegates timeout/fallback to kickAlarm().
        slotBusy = false;
      },
      getJob: async (jobId: string) => {
        if (jobId === "job-active-vast") {
          return slotBusy ? staleVastJob : null;
        }
        return {
          jobId: "job-1",
          status: "queued",
          createdAt: new Date().toISOString(),
          tape: { key: "tapes/job-1", metadata: { finalScore: 100, seedId: 1 } },
          prover: { jobId: null },
          claim: { claimantAddress: "GABC" },
        };
      },
      markFailed: async () => null,
      beginQueueAttempt: async () => ({
        jobId: "job-1",
        status: "dispatching",
        tape: {
          key: "tapes/job-1",
          metadata: { finalScore: 100, seedId: 1 },
        },
        prover: { jobId: null },
        claim: { claimantAddress: "GABC" },
        createdAt: new Date().toISOString(),
      }),
      markProverAccepted: async () => null,
    });

    const msg = makeMessage({ jobId: "job-1" }, 1);
    const env = makeEnv({
      __coordinator: coordinator,
      __submitResult: {
        type: "success",
        jobId: "vast-job-1",
        statusUrl: "https://prover.test/api/jobs/vast-job-1",
        segmentLimitPo2: 21,
      },
      PROOF_ARTIFACTS: {
        get: async () => ({
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }),
      },
    });

    await handleVastQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
      args: unknown[];
    }>;
    const staleFailCall = calls.find(
      (c) => c.method === "markFailed" && c.args[0] === "job-active-vast",
    );
    expect(staleFailCall).toBeUndefined();
    expect(calls.some((c) => c.method === "kickAlarm")).toBe(true);
    expect(calls.some((c) => c.method === "markProverAccepted")).toBe(true);
  });

  it("does not mark stale vast slot failed when stale job statusUrl is null", async () => {
    const staleVastJob = {
      jobId: "job-active-vast",
      status: "prover_running",
      createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      prover: {
        jobId: "vast-prover-1",
        statusUrl: null,
        lastPolledAt: new Date(Date.now() - 20 * 60_000).toISOString(),
      },
    };
    const coordinator = makeCoordinator({
      hasActiveVastJob: async () => true,
      getActiveVastJob: async () => staleVastJob,
      kickAlarm: async () => undefined,
      getJob: async (jobId: string) => {
        if (jobId === "job-active-vast") {
          return staleVastJob;
        }
        return {
          jobId: "job-1",
          status: "queued",
          createdAt: new Date().toISOString(),
        };
      },
    });

    const msg = makeMessage({ jobId: "job-1" }, 1);
    await handleVastQueueBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));

    expect((msg as unknown as { _retried: boolean })._retried).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
      args: unknown[];
    }>;
    const staleFailCall = calls.find(
      (c) => c.method === "markFailed" && c.args[0] === "job-active-vast",
    );
    expect(staleFailCall).toBeUndefined();
    expect(calls.some((c) => c.method === "markRetry")).toBe(true);
  });

  it("re-enqueues a fresh queue message when vast slot busy retries are exhausted", async () => {
    const coordinator = makeCoordinator({
      hasActiveVastJob: async () => true,
      getJob: async () => ({
        jobId: "job-1",
        status: "queued",
        createdAt: new Date().toISOString(),
      }),
    });
    let requeued = 0;
    const msg = makeMessage({ jobId: "job-1" }, 30); // MAX_VAST_QUEUE_RETRIES = 30
    await handleVastQueueBatch(
      makeBatch([msg]),
      makeEnv({
        __coordinator: coordinator,
        VAST_QUEUE: {
          send: async () => {
            requeued += 1;
          },
        },
      }),
    );
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    expect(requeued).toBe(1);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markRetry")).toBe(true);
    expect(calls.some((c) => c.method === "markFailed")).toBe(false);
  });

  it("marks failed when vast slot busy wait exceeds wall timeout", async () => {
    const createdAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const coordinator = makeCoordinator({
      hasActiveVastJob: async () => true,
      getJob: async () => ({
        jobId: "job-1",
        status: "queued",
        createdAt,
      }),
    });
    const msg = makeMessage({ jobId: "job-1" }, 1);
    await handleVastQueueBatch(
      makeBatch([msg]),
      makeEnv({
        __coordinator: coordinator,
        MAX_PROOF_TOTAL_WALL_TIME_MS: "60000",
      }),
    );
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
      args: unknown[];
    }>;
    const failCall = calls.find((c) => c.method === "markFailed");
    expect(failCall).toBeDefined();
    if (!failCall) {
      throw new Error("expected markFailed call");
    }
    expect(String(failCall.args[1])).toContain("timed out");
  });

  it("submits to vast when slot is free", async () => {
    const coordinator = makeCoordinator({
      hasActiveVastJob: async () => false,
      beginQueueAttempt: async () => ({
        jobId: "job-1",
        status: "dispatching",
        tape: {
          key: "tapes/job-1",
          metadata: { finalScore: 100, seedId: 1 },
        },
        prover: { jobId: null },
        claim: { claimantAddress: "GABC" },
        createdAt: new Date().toISOString(),
      }),
      markProverAccepted: async () => null,
    });
    const msg = makeMessage({ jobId: "job-1" });
    const env = makeEnv({
      __coordinator: coordinator,
      __submitResult: {
        type: "success",
        jobId: "vast-job-1",
        statusUrl: "https://prover.test/api/jobs/vast-job-1",
        segmentLimitPo2: 21,
      },
      PROOF_ARTIFACTS: {
        get: async () => ({
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }),
      },
    });
    await handleVastQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markProverAccepted")).toBe(true);
  });

  it("falls back to the next backend when vast returns fatal", async () => {
    const coordinator = makeCoordinator({
      hasActiveVastJob: async () => false,
      beginQueueAttempt: async () => ({
        jobId: "job-1",
        status: "dispatching",
        tape: {
          key: "tapes/job-1",
          metadata: { finalScore: 100, seedId: 1 },
        },
        prover: { jobId: null },
        claim: { claimantAddress: "GABC" },
        createdAt: new Date().toISOString(),
      }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    const env = makeEnv({
      __coordinator: coordinator,
      __submitResult: {
        type: "fatal",
        message: "prover health check failed",
      },
      PROOF_ARTIFACTS: {
        get: async () => ({
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        }),
      },
    });
    await handleVastQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markDispatchFailedAndTryNextBackend")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DLQ
// ---------------------------------------------------------------------------

describe("handleDlqBatch", () => {
  it("marks non-terminal jobs as failed", async () => {
    const coordinator = makeCoordinator({
      getJob: async () => ({ jobId: "job-1", status: "retrying" }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    await handleDlqBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markFailed")).toBe(true);
  });

  it("skips already-terminal jobs", async () => {
    const coordinator = makeCoordinator({
      getJob: async () => ({ jobId: "job-1", status: "succeeded" }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    await handleDlqBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markFailed")).toBe(false);
  });

  it("acks invalid messages", async () => {
    const msg = makeMessage({} as { jobId: string });
    await handleDlqBatch(makeBatch([msg]), makeEnv({ __coordinator: makeCoordinator() }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Claim queue
// ---------------------------------------------------------------------------

const TEST_CLAIMANT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const TEST_JOURNAL: JournalFields = {
  seed_id: 1,
  seed: 1,
  frame_count: 10,
  final_score: 100,
  claimant: TEST_CLAIMANT,
};

async function makeTestProofArtifact(journal: JournalFields) {
  const journalRaw = packJournalRaw(journal);
  return {
    version: "v4",
    stored_at: "2026-01-01T00:00:00.000Z",
    backend: "boundless",
    seal_hex: "22".repeat(STELLAR_GROTH16_SEAL_LEN),
    journal_raw_hex: bytesToHex(journalRaw),
    journal_digest_hex: await sha256Hex(journalRaw),
    requested_receipt_kind: "groth16",
    produced_receipt_kind: "groth16",
  };
}

describe("handleClaimQueueBatch", () => {
  it("acks when job not succeeded", async () => {
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({ jobId: "job-1", status: "failed" }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    await handleClaimQueueBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
  });

  it("acks when claim already succeeded", async () => {
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({
        jobId: "job-1",
        status: "succeeded",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:00.000Z",
        tape: { metadata: { seed: 1, finalScore: 100, seedId: 1 } },
        claim: {
          status: "succeeded",
          claimantAddress: TEST_CLAIMANT,
          txHash: "prior-attempt",
        },
        result: { summary: {}, artifactKey: "key" },
      }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    await handleClaimQueueBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
  });

  it("marks claim succeeded on successful claim", async () => {
    const proofArtifact = await makeTestProofArtifact(TEST_JOURNAL);
    const txHash = "a".repeat(64);
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({
        jobId: "job-1",
        status: "succeeded",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:00.000Z",
        tape: { metadata: { seed: 1, finalScore: 100, seedId: 1 } },
        claim: { status: "submitting", claimantAddress: TEST_CLAIMANT },
        result: {
          summary: {
            journal: {
              seed_id: 1,
              seed: 1,
              frame_count: 10,
              final_score: 100,
              claimant: TEST_CLAIMANT,
            },
          },
          artifactKey: "results/job-1.json",
        },
      }),
      listJobsForClaimant: async () => ({ jobs: [], total: 0 }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    const env = makeEnv({
      __coordinator: coordinator,
      __claimResult: { type: "success", txHash },
      PROOF_ARTIFACTS: {
        get: async () => ({
          json: async () => proofArtifact,
        }),
      },
    });
    await handleClaimQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markClaimSucceeded")).toBe(true);
    expect(proofClaimIndexWrites).toEqual([
      {
        proofJobId: "job-1",
        claimantAddress: TEST_CLAIMANT,
        txHash,
        seed: 1,
        finalScore: 100,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(proofTapeMappingWrites).toEqual([{ txHash, proofJobId: "job-1" }]);
  });

  it("retries to heal replay indexes when an already-succeeded claim is missing D1 persistence", async () => {
    proofClaimIndexWriteFailuresRemaining = 1;
    const txHash = "b".repeat(64);
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({
        jobId: "job-1",
        status: "succeeded",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:00.000Z",
        tape: { metadata: { seed: 7, finalScore: 222, seedId: 1 } },
        claim: {
          status: "succeeded",
          claimantAddress: TEST_CLAIMANT,
          txHash,
        },
        result: { summary: { journal: { claimant: TEST_CLAIMANT } }, artifactKey: "key" },
      }),
    });
    const msg = makeMessage({ jobId: "job-1" }, 1);
    await handleClaimQueueBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));
    expect((msg as unknown as { _retried: boolean })._retried).toBe(true);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(false);
    expect(proofClaimIndexWrites).toEqual([]);
    expect(proofTapeMappingWrites).toEqual([]);
  });

  it("retries claim on retry result", async () => {
    const proofArtifact = await makeTestProofArtifact(TEST_JOURNAL);
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({
        jobId: "job-1",
        status: "succeeded",
        tape: { metadata: { finalScore: 100, seedId: 1 } },
        claim: { status: "submitting", claimantAddress: TEST_CLAIMANT },
        result: {
          summary: {
            journal: {
              seed_id: 1,
              seed: 1,
              frame_count: 10,
              final_score: 100,
              claimant: TEST_CLAIMANT,
            },
          },
          artifactKey: "results/job-1.json",
        },
      }),
      listJobsForClaimant: async () => ({ jobs: [], total: 0 }),
    });
    const msg = makeMessage({ jobId: "job-1" }, 1);
    const env = makeEnv({
      __coordinator: coordinator,
      __claimResult: { type: "retry", message: "temporarily unavailable" },
      PROOF_ARTIFACTS: {
        get: async () => ({
          json: async () => proofArtifact,
        }),
      },
    });
    await handleClaimQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _retried: boolean })._retried).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markClaimRetry")).toBe(true);
  });

  it("marks claim failed on fatal result", async () => {
    const proofArtifact = await makeTestProofArtifact(TEST_JOURNAL);
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({
        jobId: "job-1",
        status: "succeeded",
        tape: { metadata: { finalScore: 100, seedId: 1 } },
        claim: { status: "submitting", claimantAddress: TEST_CLAIMANT },
        result: {
          summary: {
            journal: {
              seed_id: 1,
              seed: 1,
              frame_count: 10,
              final_score: 100,
              claimant: TEST_CLAIMANT,
            },
          },
          artifactKey: "results/job-1.json",
        },
      }),
      listJobsForClaimant: async () => ({ jobs: [], total: 0 }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    const env = makeEnv({
      __coordinator: coordinator,
      __claimResult: { type: "fatal", message: "contract error" },
      PROOF_ARTIFACTS: {
        get: async () => ({
          json: async () => proofArtifact,
        }),
      },
    });
    await handleClaimQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markClaimFailed")).toBe(true);
  });

  it("treats fatal contract #3 as prior on-chain success", async () => {
    const proofArtifact = await makeTestProofArtifact(TEST_JOURNAL);
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({
        jobId: "job-1",
        status: "succeeded",
        tape: { metadata: { finalScore: 100, seedId: 1 } },
        claim: { status: "submitting", claimantAddress: TEST_CLAIMANT },
        result: {
          summary: {
            journal: {
              seed_id: 1,
              seed: 1,
              frame_count: 10,
              final_score: 100,
              claimant: TEST_CLAIMANT,
            },
          },
          artifactKey: "results/job-1.json",
        },
      }),
      listJobsForClaimant: async () => ({ jobs: [], total: 0 }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    const env = makeEnv({
      __coordinator: coordinator,
      __claimResult: {
        type: "fatal",
        message: "claim rejected",
        errorDetail:
          'errorDetails: { details: { error: "escalating Ok(ScErrorType::Contract) frame-exit to Err (Contract, #3)" } }',
      },
      PROOF_ARTIFACTS: {
        get: async () => ({
          json: async () => proofArtifact,
        }),
      },
    });
    await handleClaimQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markClaimSucceeded")).toBe(true);
    expect(calls.some((c) => c.method === "markClaimFailed")).toBe(false);
  });

  it("treats fatal contract #5 as prior on-chain success", async () => {
    const proofArtifact = await makeTestProofArtifact(TEST_JOURNAL);
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({
        jobId: "job-1",
        status: "succeeded",
        tape: { metadata: { finalScore: 100, seedId: 1 } },
        claim: { status: "submitting", claimantAddress: TEST_CLAIMANT },
        result: {
          summary: {
            journal: {
              seed_id: 1,
              seed: 1,
              frame_count: 10,
              final_score: 100,
              claimant: TEST_CLAIMANT,
            },
          },
          artifactKey: "results/job-1.json",
        },
      }),
      listJobsForClaimant: async () => ({ jobs: [], total: 0 }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    const env = makeEnv({
      __coordinator: coordinator,
      __claimResult: {
        type: "fatal",
        message: "claim rejected",
        errorDetail:
          'errorDetails: { details: { error: "escalating Ok(ScErrorType::Contract) frame-exit to Err (Contract, #5)" } }',
      },
      PROOF_ARTIFACTS: {
        get: async () => ({
          json: async () => proofArtifact,
        }),
      },
    });
    await handleClaimQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markClaimSucceeded")).toBe(true);
    expect(calls.some((c) => c.method === "markClaimFailed")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Claim queue — R2 artifact retry tests
// ---------------------------------------------------------------------------

describe("handleClaimQueueBatch — R2 artifact retry", () => {
  it("retries (not fails) when R2 artifact is missing on first attempt", async () => {
    const _proofArtifact = await makeTestProofArtifact(TEST_JOURNAL);
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({
        jobId: "job-1",
        status: "succeeded",
        tape: { metadata: { seed: 1, finalScore: 100, seedId: 1 } },
        claim: { status: "submitting", claimantAddress: TEST_CLAIMANT },
        result: {
          summary: {
            journal: {
              seed_id: 1,
              seed: 1,
              frame_count: 10,
              final_score: 100,
              claimant: TEST_CLAIMANT,
            },
          },
          artifactKey: "results/job-1.json",
        },
      }),
      listJobsForClaimant: async () => ({ jobs: [], total: 0 }),
    });
    const msg = makeMessage({ jobId: "job-1" }, 1);
    const env = makeEnv({
      __coordinator: coordinator,
      PROOF_ARTIFACTS: {
        get: async () => null, // R2 returns null (transient consistency)
      },
    });
    await handleClaimQueueBatch(makeBatch([msg]), env);
    // Should retry, NOT permanently fail
    expect((msg as unknown as { _retried: boolean })._retried).toBe(true);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(false);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markClaimRetry")).toBe(true);
    expect(calls.some((c) => c.method === "markClaimFailed")).toBe(false);
  });

  it("permanently fails R2 artifact miss only after exhausting queue retries", async () => {
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({
        jobId: "job-1",
        status: "succeeded",
        tape: { metadata: { seed: 1, finalScore: 100, seedId: 1 } },
        claim: { status: "submitting", claimantAddress: TEST_CLAIMANT },
        result: {
          summary: {
            journal: {
              seed_id: 1,
              seed: 1,
              frame_count: 10,
              final_score: 100,
              claimant: TEST_CLAIMANT,
            },
          },
          artifactKey: "results/job-1.json",
        },
      }),
      listJobsForClaimant: async () => ({ jobs: [], total: 0 }),
    });
    const msg = makeMessage({ jobId: "job-1" }, 10); // MAX_QUEUE_RETRIES
    const env = makeEnv({
      __coordinator: coordinator,
      PROOF_ARTIFACTS: {
        get: async () => null,
      },
    });
    await handleClaimQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markClaimFailed")).toBe(true);
  });

  it("retries when artifact.json() throws (transient R2 body error)", async () => {
    const coordinator = makeCoordinator({
      beginClaimAttempt: async () => ({
        jobId: "job-1",
        status: "succeeded",
        tape: { metadata: { seed: 1, finalScore: 100, seedId: 1 } },
        claim: { status: "submitting", claimantAddress: TEST_CLAIMANT },
        result: {
          summary: {
            journal: {
              seed_id: 1,
              seed: 1,
              frame_count: 10,
              final_score: 100,
              claimant: TEST_CLAIMANT,
            },
          },
          artifactKey: "results/job-1.json",
        },
      }),
      listJobsForClaimant: async () => ({ jobs: [], total: 0 }),
    });
    const msg = makeMessage({ jobId: "job-1" }, 1);
    const env = makeEnv({
      __coordinator: coordinator,
      PROOF_ARTIFACTS: {
        get: async () => ({
          json: async () => {
            throw new Error("ReadableStream body error");
          },
        }),
      },
    });
    await handleClaimQueueBatch(makeBatch([msg]), env);
    expect((msg as unknown as { _retried: boolean })._retried).toBe(true);
    expect((msg as unknown as { _acked: boolean })._acked).toBe(false);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
    }>;
    expect(calls.some((c) => c.method === "markClaimRetry")).toBe(true);
    expect(calls.some((c) => c.method === "markClaimFailed")).toBe(false);
  });
});

describe("handleClaimDlqBatch", () => {
  it("marks claim as failed with dead-letter message", async () => {
    const coordinator = makeCoordinator({
      getJob: async () => ({
        jobId: "job-1",
        claim: { lastError: "previous error" },
      }),
    });
    const msg = makeMessage({ jobId: "job-1" });
    await handleClaimDlqBatch(makeBatch([msg]), makeEnv({ __coordinator: coordinator }));
    expect((msg as unknown as { _acked: boolean })._acked).toBe(true);
    const calls = (coordinator as Record<string, unknown>)._calls as Array<{
      method: string;
      args: unknown[];
    }>;
    const failCall = calls.find((c) => c.method === "markClaimFailed");
    expect(failCall).toBeDefined();
    if (!failCall) {
      throw new Error("expected markClaimFailed call");
    }
    expect(String(failCall.args[1])).toContain("dead-letter");
  });
});
