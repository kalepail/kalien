import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
import type { WorkerEnv } from "../../worker/env";

const VALID_CLAIMANT_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4";
const EXAMPLE_GENERATED_AT = "2026-02-14T00:00:00.000Z";
const EXAMPLE_INGESTION_STATE = {
  provider: "rpc" as const,
  sourceMode: "rpc" as const,
  cursor: "ledger:10",
  highestLedger: 10,
  lastSyncedAt: EXAMPLE_GENERATED_AT,
  lastBackfillAt: null,
  totalEvents: 12,
  lastError: null,
};
const EXAMPLE_ENTRY = {
  rank: 1,
  jobId: "evt-1",
  claimantAddress: VALID_CLAIMANT_CONTRACT,
  score: 1337,
  mintedDelta: 1337,
  seed: 42,
  frameCount: 1200,
  completedAt: EXAMPLE_GENERATED_AT,
  claimStatus: "succeeded" as const,
  claimTxHash: "tx-1",
  profile: {
    claimantAddress: VALID_CLAIMANT_CONTRACT,
    username: "pilot",
    linkUrl: null,
    updatedAt: EXAMPLE_GENERATED_AT,
  },
};

function makeMockLeaderboardPlayer() {
  return {
    profile: EXAMPLE_ENTRY.profile,
    stats: {
      totalRuns: 1,
      bestScore: EXAMPLE_ENTRY.score,
      totalMinted: EXAMPLE_ENTRY.mintedDelta,
      lastPlayedAt: EXAMPLE_GENERATED_AT,
    },
    ranks: {
      tenMin: 1,
      day: 1,
      all: 1,
    },
    recentRuns: [
      {
        jobId: EXAMPLE_ENTRY.jobId,
        claimantAddress: EXAMPLE_ENTRY.claimantAddress,
        score: EXAMPLE_ENTRY.score,
        mintedDelta: EXAMPLE_ENTRY.mintedDelta,
        seed: EXAMPLE_ENTRY.seed,
        frameCount: EXAMPLE_ENTRY.frameCount,
        completedAt: EXAMPLE_ENTRY.completedAt,
        claimStatus: "succeeded" as const,
        claimTxHash: EXAMPLE_ENTRY.claimTxHash,
        proofJobId: null,
      },
    ],
    runsPagination: {
      limit: 25,
      offset: 0,
      total: 1,
      nextOffset: null,
    },
  };
}

let mockLeaderboardPlayer = makeMockLeaderboardPlayer();
const proofClaimIndexEntries: Array<{
  proofJobId: string;
  claimantAddress: string;
  txHash: string;
  seed: number;
  finalScore: number;
  completedAt: string;
  recordedAt: string;
}> = [];
let proofClaimIndexLookupCalls = 0;
let proofArtifactsHeadCalls = 0;
const proofTapeMappingWrites: Array<{ txHash: string; proofJobId: string }> = [];

function MockProofCoordinatorDO() {}

mock.module("../../worker/leaderboard-store", () => ({
  createLeaderboardProfileAuthChallenge: async () => undefined,
  getLeaderboardIngestionState: async () => EXAMPLE_INGESTION_STATE,
  getLeaderboardPage: async () => ({
    window: "all",
    generatedAt: EXAMPLE_GENERATED_AT,
    windowRange: {
      startAt: null,
      endAt: EXAMPLE_GENERATED_AT,
    },
    totalPlayers: 1,
    limit: 25,
    offset: 0,
    nextOffset: null,
    entries: [EXAMPLE_ENTRY],
    me: EXAMPLE_ENTRY,
  }),
  getLeaderboardPlayer: async () => ({
    profile: mockLeaderboardPlayer.profile,
    stats: { ...mockLeaderboardPlayer.stats },
    ranks: { ...mockLeaderboardPlayer.ranks },
    recentRuns: mockLeaderboardPlayer.recentRuns.map((run) => ({ ...run })),
    runsPagination: { ...mockLeaderboardPlayer.runsPagination },
  }),
  getLeaderboardProfileAuthChallenge: async () => null,
  getLeaderboardProfileCredential: async () => null,
  getProofClaimIndexEntriesByTxHashes: async (
    _env: WorkerEnv,
    txHashes: Array<string | null | undefined>,
  ) => {
    proofClaimIndexLookupCalls += 1;
    const normalized = new Set(
      txHashes
        .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : null))
        .filter((value): value is string => Boolean(value)),
    );
    return proofClaimIndexEntries
      .filter((entry) => normalized.has(entry.txHash))
      .map((entry) => ({ ...entry }));
  },
  markLeaderboardProfileAuthChallengeUsed: async () => false,
  purgeExpiredLeaderboardProfileAuthChallenges: async () => undefined,
  updateLeaderboardProfileCredentialCounter: async () => undefined,
  upsertLeaderboardProfile: async () => EXAMPLE_ENTRY.profile,
  upsertLeaderboardProfileCredential: async () => ({
    claimantAddress: VALID_CLAIMANT_CONTRACT,
    credentialId: "credential-1",
    publicKey: "public-key",
    counter: 0,
    transports: null,
    createdAt: EXAMPLE_GENERATED_AT,
    updatedAt: EXAMPLE_GENERATED_AT,
  }),
  writeProofTapeMapping: async (_env: WorkerEnv, txHash: string, proofJobId: string) => {
    proofTapeMappingWrites.push({ txHash, proofJobId });
  },
}));

mock.module("../../worker/durable/coordinator", () => ({
  coordinatorStub: (env: WorkerEnv) =>
    (env as WorkerEnv & { __coordinator: Record<string, unknown> }).__coordinator,
  asPublicJob: <T>(job: T): T => job,
  ProofCoordinatorDO: MockProofCoordinatorDO,
}));

afterAll(() => {
  mock.restore();
});

const { Hono } = await import("hono");
const { createApiRouter } = await import("../../worker/api/routes");
const { createLeaderboardPublicRouter } = await import("../../worker/api/leaderboard-routes");

function makeCoordinatorStub(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    getActiveJobsSummary: async () => ({
      total: 0,
      boundless: 0,
      vast: 0,
      waitingDispatch: 0,
      oldestActiveAgeSec: null,
      oldestWaitingDispatchAgeSec: null,
      statusCounts: {
        queued: 0,
        dispatching: 0,
        proverRunning: 0,
        retrying: 0,
      },
      firstJobId: null,
    }),
    getJob: async () => null,
    markFailed: async () => null,
    createJob: async () => ({ accepted: false, activeJob: null }),
    kickAlarm: async () => undefined,
    listJobsForClaimant: async () => ({ jobs: [], total: 0 }),
    retryFailedProof: async () => null,
    retryFailedClaim: async () => null,
    ...overrides,
  };
}

function makeMockD1Database(): D1Database {
  return {
    prepare: (_query: string) => ({
      bind: () => ({
        run: async () => ({ success: true }),
        all: async () => ({ results: [] }),
      }),
      run: async () => ({ success: true }),
      all: async () => ({ results: [] }),
      first: async () => null,
      raw: async () => [],
    }),
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

function makeEnv(
  overrides: (Partial<WorkerEnv> & { __coordinator?: Record<string, unknown> }) | undefined = {},
): WorkerEnv {
  const coordinator = overrides.__coordinator ?? makeCoordinatorStub();

  return {
    ASSETS: {
      fetch: async () => new Response("not found", { status: 404 }),
    } as Fetcher,
    PROOF_QUEUE: {
      send: async () => undefined,
    } as Queue<unknown>,
    VAST_QUEUE: {
      send: async () => undefined,
    } as Queue<unknown>,
    CLAIM_QUEUE: {
      send: async () => undefined,
    } as Queue<unknown>,
    PROOF_COORDINATOR: {
      idFromName: () => "coordinator-id" as unknown as DurableObjectId,
      get: () => coordinator,
    } as unknown as DurableObjectNamespace,
    PROOF_ARTIFACTS: {
      head: async () => {
        proofArtifactsHeadCalls += 1;
        return { key: "proof" } as unknown as R2Object;
      },
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    } as unknown as R2Bucket,
    LEADERBOARD_DB: makeMockD1Database(),
    PROVER_BASE_URL: "",
    __coordinator: coordinator,
    ...overrides,
  } as WorkerEnv & { __coordinator: Record<string, unknown> };
}

async function requestApi(
  path: string,
  init: RequestInit | undefined,
  env: WorkerEnv,
): Promise<Response> {
  const app = new Hono<{ Bindings: WorkerEnv }>();
  app.route("/", createApiRouter());
  app.route("/leaderboard", createLeaderboardPublicRouter());
  const request = new Request(`https://worker.test${path}`, init);
  const waitUntilPromises: Promise<unknown>[] = [];
  const executionContext = {
    waitUntil(promise: Promise<unknown>) {
      waitUntilPromises.push(promise);
    },
    passThroughOnException() {
      // no-op in tests
    },
  } as unknown as ExecutionContext;
  const response = await app.fetch(request, env, executionContext);
  await Promise.allSettled(waitUntilPromises);
  return response;
}

describe("API routes", () => {
  beforeEach(() => {
    mockLeaderboardPlayer = makeMockLeaderboardPlayer();
    proofClaimIndexEntries.length = 0;
    proofClaimIndexLookupCalls = 0;
    proofArtifactsHeadCalls = 0;
    proofTapeMappingWrites.length = 0;
  });

  it("GET /health returns degraded prover status when health validation fails", async () => {
    const response = await requestApi("/health", undefined, makeEnv({ PROVER_BASE_URL: "" }));
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      prover: { status: string };
    };
    expect(payload.success).toBe(true);
    expect(payload.prover.status).toBe("degraded");
  });

  it("GET /health returns degraded boundless funding when private key is malformed", async () => {
    const response = await requestApi(
      "/health",
      undefined,
      makeEnv({
        PROVER_BASE_URL: "",
        BOUNDLESS_RPC_URL: "https://rpc.boundless.test",
        BOUNDLESS_PRIVATE_KEY: "malformed-private-key",
        BOUNDLESS_IMAGE_URL: "https://example.com/image",
        BOUNDLESS_IMAGE_ID: "0x" + "11".repeat(32),
        __boundlessConfig: {
          rpcUrl: "https://rpc.boundless.test",
          privateKey: "0xmalformed-private-key",
          imageUrl: "https://example.com/image",
          imageId: ("0x" + "11".repeat(32)) as `0x${string}`,
          maxPriceUsd: 0.1,
          minPriceUsd: 0,
          lockCollateralBaseUnits: 5n * 10n ** 18n,
          topUpBufferBps: 1500,
          pollIntervalMs: 5000,
          pollTimeoutMs: 60000,
          flatPeriodSec: 60,
          rampPeriodSec: 660,
          lockTimeoutSec: 1740,
          timeoutSec: 3540,
          chainId: 8453n,
          marketAddress: "0xfd152dadc5183870710fe54f939eae3ab9f0fe82" as `0x${string}`,
          orderStreamUrl: "https://base-mainnet.boundless.network",
          deploymentBlock: 1n,
          pinataJwt: null,
        },
      }),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      boundless_funding: { status: string; error: string | null };
    };
    expect(payload.success).toBe(true);
    expect(payload.boundless_funding.status).toBe("degraded");
    expect(payload.boundless_funding.error).not.toBeNull();
  });

  it("GET /health reports active job summary from coordinator", async () => {
    const response = await requestApi(
      "/health",
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          getActiveJobsSummary: async () => ({
            total: 3,
            boundless: 2,
            vast: 1,
            waitingDispatch: 0,
            oldestActiveAgeSec: 45,
            oldestWaitingDispatchAgeSec: 0,
            statusCounts: {
              queued: 0,
              dispatching: 1,
              proverRunning: 2,
              retrying: 0,
            },
            firstJobId: "job-active-1",
          }),
        }),
      }),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      active_jobs: number;
      active_job_id: string | null;
      oldest_active_job_age_sec: number | null;
      oldest_waiting_dispatch_age_sec: number | null;
      active_jobs_by_backend: {
        boundless: number;
        vast: number;
        waiting_dispatch: number;
      };
      active_jobs_by_status: {
        queued: number;
        dispatching: number;
        prover_running: number;
        retrying: number;
      };
      configured_backends: {
        boundless: boolean;
        vast: boolean;
      };
    };
    expect(payload.success).toBe(true);
    expect(payload.active_jobs).toBe(3);
    expect(payload.active_job_id).toBe("job-active-1");
    expect(payload.oldest_active_job_age_sec).toBe(45);
    expect(payload.oldest_waiting_dispatch_age_sec).toBe(0);
    expect(payload.active_jobs_by_backend).toEqual({
      boundless: 2,
      vast: 1,
      waiting_dispatch: 0,
    });
    expect(payload.active_jobs_by_status).toEqual({
      queued: 0,
      dispatching: 1,
      prover_running: 2,
      retrying: 0,
    });
    expect(payload.configured_backends).toEqual({
      boundless: false,
      vast: false,
    });
  });

  it("GET /leaderboard validates window query", async () => {
    const response = await requestApi("/leaderboard?window=bad-window", undefined, makeEnv());
    expect(response.status).toBe(400);
  });

  it("GET /leaderboard returns leaderboard page for valid queries", async () => {
    const response = await requestApi(
      "/leaderboard?window=all&limit=25&offset=0",
      undefined,
      makeEnv(),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      entries: unknown[];
      pagination: { total: number };
    };
    expect(payload.success).toBe(true);
    expect(payload.entries.length).toBe(1);
    expect(payload.pagination.total).toBe(1);
  });

  it("GET /leaderboard/player/:claimantAddress validates claimant address", async () => {
    const response = await requestApi(
      "/leaderboard/player/not-a-valid-claimant",
      undefined,
      makeEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("GET /leaderboard/player/:claimantAddress returns player summary", async () => {
    const response = await requestApi(
      `/leaderboard/player/${VALID_CLAIMANT_CONTRACT}`,
      undefined,
      makeEnv(),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      player: { claimant_address: string };
    };
    expect(payload.success).toBe(true);
    expect(payload.player.claimant_address).toBe(VALID_CLAIMANT_CONTRACT);
  });

  it("GET /leaderboard/player/:claimantAddress self-heals missing replay mappings from coordinator jobs", async () => {
    const repairedTxHash = "a".repeat(64);
    const recentIso = new Date().toISOString();
    mockLeaderboardPlayer = {
      ...makeMockLeaderboardPlayer(),
      recentRuns: [
        {
          jobId: "evt-self-heal",
          claimantAddress: VALID_CLAIMANT_CONTRACT,
          score: 9_041,
          mintedDelta: 9_041,
          seed: 777,
          frameCount: 36000,
          completedAt: recentIso,
          claimStatus: "succeeded" as const,
          claimTxHash: repairedTxHash,
          proofJobId: null,
        },
      ],
    };

    const response = await requestApi(
      `/leaderboard/player/${VALID_CLAIMANT_CONTRACT}`,
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          listJobsForClaimant: async () => ({
            jobs: [
              {
                jobId: "job-prior-attempt",
                status: "succeeded",
                createdAt: EXAMPLE_GENERATED_AT,
                updatedAt: EXAMPLE_GENERATED_AT,
                completedAt: EXAMPLE_GENERATED_AT,
                tape: {
                  sizeBytes: 512,
                  key: "proof-jobs/job-prior-attempt/input.tape",
                  metadata: {
                    seed: 777,
                    seedId: 1,
                    frameCount: 36000,
                    finalScore: 9_041,
                    checksum: 0,
                  },
                },
                queue: {
                  attempts: 1,
                  lastAttemptAt: null,
                  lastError: null,
                  nextRetryAt: null,
                },
                prover: {
                  jobId: null,
                  status: null,
                  statusUrl: null,
                  segmentLimitPo2: null,
                  lastPolledAt: null,
                  pollingErrors: 0,
                },
                proverAttempts: [],
                claimAttempts: [],
                result: null,
                claim: {
                  claimantAddress: VALID_CLAIMANT_CONTRACT,
                  status: "succeeded",
                  attempts: 1,
                  lastAttemptAt: null,
                  lastError: null,
                  nextRetryAt: null,
                  submittedAt: EXAMPLE_GENERATED_AT,
                  txHash: "prior-attempt",
                },
                error: null,
              },
            ],
            total: 1,
          }),
        }),
      }),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      player: { recent_runs: Array<{ proofJobId: string | null }> };
    };
    expect(payload.success).toBe(true);
    expect(payload.player.recent_runs[0]?.proofJobId).toBe("job-prior-attempt");
    expect(proofTapeMappingWrites).toEqual([
      { txHash: repairedTxHash, proofJobId: "job-prior-attempt" },
    ]);
  });

  it("GET /leaderboard/player/:claimantAddress repairs exact replay mappings from proof claim index before DO lookup", async () => {
    const repairedTxHash = "9".repeat(64);
    const recentIso = new Date().toISOString();
    let listCalls = 0;
    mockLeaderboardPlayer = {
      ...makeMockLeaderboardPlayer(),
      recentRuns: [
        {
          jobId: "evt-claim-index",
          claimantAddress: VALID_CLAIMANT_CONTRACT,
          score: 4_242,
          mintedDelta: 4_242,
          seed: 222,
          frameCount: 36000,
          completedAt: recentIso,
          claimStatus: "succeeded" as const,
          claimTxHash: repairedTxHash,
          proofJobId: null,
        },
      ],
    };
    proofClaimIndexEntries.push({
      proofJobId: "job-from-claim-index",
      claimantAddress: VALID_CLAIMANT_CONTRACT,
      txHash: repairedTxHash,
      seed: 222,
      finalScore: 4_242,
      completedAt: recentIso,
      recordedAt: recentIso,
    });

    const response = await requestApi(
      `/leaderboard/player/${VALID_CLAIMANT_CONTRACT}`,
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          listJobsForClaimant: async () => {
            listCalls += 1;
            return { jobs: [], total: 0 };
          },
        }),
      }),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      player: { recent_runs: Array<{ proofJobId: string | null }> };
    };
    expect(payload.success).toBe(true);
    expect(payload.player.recent_runs[0]?.proofJobId).toBe("job-from-claim-index");
    expect(listCalls).toBe(0);
    expect(proofTapeMappingWrites).toEqual([
      { txHash: repairedTxHash, proofJobId: "job-from-claim-index" },
    ]);
  });

  it("GET /leaderboard/player/:claimantAddress does not infer a replay for ambiguous succeeded matches", async () => {
    const repairedTxHash = "c".repeat(64);
    const recentIso = new Date().toISOString();
    mockLeaderboardPlayer = {
      ...makeMockLeaderboardPlayer(),
      recentRuns: [
        {
          jobId: "evt-ambiguous",
          claimantAddress: VALID_CLAIMANT_CONTRACT,
          score: 8_888,
          mintedDelta: 8_888,
          seed: 333,
          frameCount: 36000,
          completedAt: recentIso,
          claimStatus: "succeeded" as const,
          claimTxHash: repairedTxHash,
          proofJobId: null,
        },
      ],
    };

    const makeSucceededJob = (jobId: string, txHash: string) => ({
      jobId,
      status: "succeeded",
      createdAt: recentIso,
      updatedAt: recentIso,
      completedAt: recentIso,
      tape: {
        sizeBytes: 512,
        key: `proof-jobs/${jobId}/input.tape`,
        metadata: {
          seed: 333,
          seedId: 1,
          frameCount: 36000,
          finalScore: 8_888,
          checksum: 0,
        },
      },
      queue: {
        attempts: 1,
        lastAttemptAt: null,
        lastError: null,
        nextRetryAt: null,
      },
      prover: {
        jobId: null,
        status: null,
        statusUrl: null,
        segmentLimitPo2: null,
        lastPolledAt: null,
        pollingErrors: 0,
      },
      proverAttempts: [],
      claimAttempts: [],
      result: null,
      claim: {
        claimantAddress: VALID_CLAIMANT_CONTRACT,
        status: "succeeded" as const,
        attempts: 1,
        lastAttemptAt: null,
        lastError: null,
        nextRetryAt: null,
        submittedAt: recentIso,
        txHash,
      },
      error: null,
    });

    const response = await requestApi(
      `/leaderboard/player/${VALID_CLAIMANT_CONTRACT}`,
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          listJobsForClaimant: async () => ({
            jobs: [
              makeSucceededJob("job-a", "prior-attempt"),
              makeSucceededJob("job-b", "superseded-by-higher-score"),
            ],
            total: 2,
          }),
        }),
      }),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      player: { recent_runs: Array<{ proofJobId: string | null }> };
    };
    expect(payload.success).toBe(true);
    expect(payload.player.recent_runs[0]?.proofJobId).toBeNull();
    expect(proofTapeMappingWrites).toEqual([]);
  });

  it("GET /leaderboard/player/:claimantAddress does not infer a replay before a paginated claimant scan is complete", async () => {
    const repairedTxHash = "e".repeat(64);
    const recentIso = new Date().toISOString();
    const listOffsets: number[] = [];
    mockLeaderboardPlayer = {
      ...makeMockLeaderboardPlayer(),
      recentRuns: [
        {
          jobId: "evt-paginated-ambiguous",
          claimantAddress: VALID_CLAIMANT_CONTRACT,
          score: 6_666,
          mintedDelta: 6_666,
          seed: 555,
          frameCount: 36000,
          completedAt: recentIso,
          claimStatus: "succeeded" as const,
          claimTxHash: repairedTxHash,
          proofJobId: null,
        },
      ],
    };

    const makeSucceededJob = (jobId: string, txHash: string, seed: number, finalScore: number) => ({
      jobId,
      status: "succeeded",
      createdAt: recentIso,
      updatedAt: recentIso,
      completedAt: recentIso,
      tape: {
        sizeBytes: 512,
        key: `proof-jobs/${jobId}/input.tape`,
        metadata: {
          seed,
          seedId: 1,
          frameCount: 36000,
          finalScore,
          checksum: 0,
        },
      },
      queue: {
        attempts: 1,
        lastAttemptAt: null,
        lastError: null,
        nextRetryAt: null,
      },
      prover: {
        jobId: null,
        status: null,
        statusUrl: null,
        segmentLimitPo2: null,
        lastPolledAt: null,
        pollingErrors: 0,
      },
      proverAttempts: [],
      claimAttempts: [],
      result: null,
      claim: {
        claimantAddress: VALID_CLAIMANT_CONTRACT,
        status: "succeeded" as const,
        attempts: 1,
        lastAttemptAt: null,
        lastError: null,
        nextRetryAt: null,
        submittedAt: recentIso,
        txHash,
      },
      error: null,
    });

    const firstPage = [
      makeSucceededJob("job-page-1", "prior-attempt", 555, 6_666),
      ...Array.from({ length: 199 }, (_, index) =>
        makeSucceededJob(`job-filler-${index}`, `filler-${index}`, 1_000 + index, 2_000 + index),
      ),
    ];

    const response = await requestApi(
      `/leaderboard/player/${VALID_CLAIMANT_CONTRACT}`,
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          listJobsForClaimant: async (_claimantAddress: string, _limit: number, offset: number) => {
            listOffsets.push(offset);
            if (offset === 0) {
              return { jobs: firstPage, total: 201 };
            }
            if (offset === 200) {
              return {
                jobs: [makeSucceededJob("job-page-2", "superseded-by-higher-score", 555, 6_666)],
                total: 201,
              };
            }
            return { jobs: [], total: 201 };
          },
        }),
      }),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      player: { recent_runs: Array<{ proofJobId: string | null }> };
    };
    expect(payload.success).toBe(true);
    expect(listOffsets).toEqual([0, 200]);
    expect(payload.player.recent_runs[0]?.proofJobId).toBeNull();
    expect(proofTapeMappingWrites).toEqual([]);
  });

  it("GET /leaderboard/player/:claimantAddress does not return repaired replay when the tape artifact is missing", async () => {
    const repairedTxHash = "d".repeat(64);
    const recentIso = new Date().toISOString();
    mockLeaderboardPlayer = {
      ...makeMockLeaderboardPlayer(),
      recentRuns: [
        {
          jobId: "evt-missing-tape",
          claimantAddress: VALID_CLAIMANT_CONTRACT,
          score: 7_777,
          mintedDelta: 7_777,
          seed: 444,
          frameCount: 36000,
          completedAt: recentIso,
          claimStatus: "succeeded" as const,
          claimTxHash: repairedTxHash,
          proofJobId: null,
        },
      ],
    };

    const response = await requestApi(
      `/leaderboard/player/${VALID_CLAIMANT_CONTRACT}`,
      undefined,
      makeEnv({
        PROOF_ARTIFACTS: {
          head: async () => null,
          get: async () => null,
          put: async () => undefined,
          delete: async () => undefined,
        } as unknown as R2Bucket,
        __coordinator: makeCoordinatorStub({
          listJobsForClaimant: async () => ({
            jobs: [
              {
                jobId: "job-no-tape",
                status: "succeeded",
                createdAt: recentIso,
                updatedAt: recentIso,
                completedAt: recentIso,
                tape: {
                  sizeBytes: 512,
                  key: "proof-jobs/job-no-tape/input.tape",
                  metadata: {
                    seed: 444,
                    seedId: 1,
                    frameCount: 36000,
                    finalScore: 7_777,
                    checksum: 0,
                  },
                },
                queue: {
                  attempts: 1,
                  lastAttemptAt: null,
                  lastError: null,
                  nextRetryAt: null,
                },
                prover: {
                  jobId: null,
                  status: null,
                  statusUrl: null,
                  segmentLimitPo2: null,
                  lastPolledAt: null,
                  pollingErrors: 0,
                },
                proverAttempts: [],
                claimAttempts: [],
                result: null,
                claim: {
                  claimantAddress: VALID_CLAIMANT_CONTRACT,
                  status: "succeeded",
                  attempts: 1,
                  lastAttemptAt: null,
                  lastError: null,
                  nextRetryAt: null,
                  submittedAt: recentIso,
                  txHash: "prior-attempt",
                },
                error: null,
              },
            ],
            total: 1,
          }),
        }),
      }),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      player: { recent_runs: Array<{ proofJobId: string | null }> };
    };
    expect(payload.success).toBe(true);
    expect(payload.player.recent_runs[0]?.proofJobId).toBeNull();
    expect(proofTapeMappingWrites).toEqual([]);
  });

  it("GET /leaderboard/player/:claimantAddress repairs old runs from proof claim index without DO lookup", async () => {
    const repairedTxHash = "8".repeat(64);
    let listCalls = 0;
    mockLeaderboardPlayer = {
      ...makeMockLeaderboardPlayer(),
      recentRuns: [
        {
          jobId: "evt-old-claim-index",
          claimantAddress: VALID_CLAIMANT_CONTRACT,
          score: 2_468,
          mintedDelta: 2_468,
          seed: 909,
          frameCount: 1200,
          completedAt: "2026-01-01T00:00:00.000Z",
          claimStatus: "succeeded" as const,
          claimTxHash: repairedTxHash,
          proofJobId: null,
        },
      ],
    };
    proofClaimIndexEntries.push({
      proofJobId: "job-old-claim-index",
      claimantAddress: VALID_CLAIMANT_CONTRACT,
      txHash: repairedTxHash,
      seed: 909,
      finalScore: 2_468,
      completedAt: "2026-01-01T00:00:00.000Z",
      recordedAt: EXAMPLE_GENERATED_AT,
    });

    const response = await requestApi(
      `/leaderboard/player/${VALID_CLAIMANT_CONTRACT}`,
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          listJobsForClaimant: async () => {
            listCalls += 1;
            return { jobs: [], total: 0 };
          },
        }),
      }),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      player: { recent_runs: Array<{ proofJobId: string | null }> };
    };
    expect(payload.success).toBe(true);
    expect(payload.player.recent_runs[0]?.proofJobId).toBe("job-old-claim-index");
    expect(listCalls).toBe(0);
    expect(proofClaimIndexLookupCalls).toBe(1);
    expect(proofArtifactsHeadCalls).toBe(1);
    expect(proofTapeMappingWrites).toEqual([
      { txHash: repairedTxHash, proofJobId: "job-old-claim-index" },
    ]);
  });

  it("GET /leaderboard/player/:claimantAddress skips replay self-heal for runs older than retention", async () => {
    let listCalls = 0;
    mockLeaderboardPlayer = {
      ...makeMockLeaderboardPlayer(),
      recentRuns: [
        {
          jobId: "evt-old-run",
          claimantAddress: VALID_CLAIMANT_CONTRACT,
          score: 1_337,
          mintedDelta: 1_337,
          seed: 42,
          frameCount: 1200,
          completedAt: "2026-01-01T00:00:00.000Z",
          claimStatus: "succeeded" as const,
          claimTxHash: "b".repeat(64),
          proofJobId: null,
        },
      ],
    };

    const response = await requestApi(
      `/leaderboard/player/${VALID_CLAIMANT_CONTRACT}`,
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          listJobsForClaimant: async () => {
            listCalls += 1;
            return { jobs: [], total: 0 };
          },
        }),
      }),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      player: { recent_runs: Array<{ proofJobId: string | null }> };
    };
    expect(payload.success).toBe(true);
    expect(payload.player.recent_runs[0]?.proofJobId).toBeNull();
    expect(listCalls).toBe(0);
    expect(proofClaimIndexLookupCalls).toBe(1);
    expect(proofArtifactsHeadCalls).toBe(0);
    expect(proofTapeMappingWrites).toEqual([]);
  });

  it("GET /leaderboard/player/:claimantAddress rejects mismatched proof claim index rows", async () => {
    const repairedTxHash = "7".repeat(64);
    const recentIso = new Date().toISOString();
    let listCalls = 0;
    mockLeaderboardPlayer = {
      ...makeMockLeaderboardPlayer(),
      recentRuns: [
        {
          jobId: "evt-claim-index-mismatch",
          claimantAddress: VALID_CLAIMANT_CONTRACT,
          score: 5_555,
          mintedDelta: 5_555,
          seed: 111,
          frameCount: 36000,
          completedAt: recentIso,
          claimStatus: "succeeded" as const,
          claimTxHash: repairedTxHash,
          proofJobId: null,
        },
      ],
    };
    proofClaimIndexEntries.push({
      proofJobId: "job-mismatch",
      claimantAddress: VALID_CLAIMANT_CONTRACT,
      txHash: repairedTxHash,
      seed: 999,
      finalScore: 5_555,
      completedAt: recentIso,
      recordedAt: recentIso,
    });

    const response = await requestApi(
      `/leaderboard/player/${VALID_CLAIMANT_CONTRACT}`,
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          listJobsForClaimant: async () => {
            listCalls += 1;
            return { jobs: [], total: 0 };
          },
        }),
      }),
    );
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      success: boolean;
      player: { recent_runs: Array<{ proofJobId: string | null }> };
    };
    expect(payload.success).toBe(true);
    expect(payload.player.recent_runs[0]?.proofJobId).toBeNull();
    expect(proofClaimIndexLookupCalls).toBe(1);
    expect(listCalls).toBeGreaterThanOrEqual(1);
    expect(proofTapeMappingWrites).toEqual([]);
  });

  it("POST /leaderboard/player/:claimantAddress/profile/auth/options validates payload", async () => {
    const response = await requestApi(
      `/leaderboard/player/${VALID_CLAIMANT_CONTRACT}/profile/auth/options`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      makeEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("PUT /leaderboard/player/:claimantAddress/profile validates auth payload", async () => {
    const response = await requestApi(
      `/leaderboard/player/${VALID_CLAIMANT_CONTRACT}/profile`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ username: "player-one" }),
      },
      makeEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("POST /proofs/jobs enforces the tape size cap before reading body", async () => {
    const response = await requestApi(
      "/proofs/jobs",
      {
        method: "POST",
        headers: {
          "content-length": "2097153",
        },
        body: "0123456789",
      },
      makeEnv(),
    );
    expect(response.status).toBe(413);
  });

  it("GET /proofs/jobs/:jobId returns 404 when job does not exist", async () => {
    const response = await requestApi("/proofs/jobs/job-missing", undefined, makeEnv());
    expect(response.status).toBe(404);
  });

  it("GET /proofs/jobs/:jobId returns job when present", async () => {
    const response = await requestApi(
      "/proofs/jobs/job-present",
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          getJob: async () => ({
            jobId: "job-present",
            status: "failed",
          }),
        }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it("GET /proofs/jobs/:jobId/result returns 404 when result artifact is not found", async () => {
    const response = await requestApi("/proofs/jobs/job-missing/result", undefined, makeEnv());
    expect(response.status).toBe(404);
  });

  it("GET /proofs/jobs/:jobId/result returns artifact payload when present", async () => {
    const response = await requestApi(
      "/proofs/jobs/job-present/result",
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          getJob: async () => ({
            result: { artifactKey: "results/job-present.json" },
          }),
        }),
        PROOF_ARTIFACTS: {
          get: async () =>
            ({
              body: '{"success":true}',
            }) as unknown as R2ObjectBody,
          put: async () => undefined,
          delete: async () => undefined,
        } as unknown as R2Bucket,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"success":true}');
  });

  it("DELETE /proofs/jobs/:jobId returns 404 when job does not exist", async () => {
    const response = await requestApi(
      "/proofs/jobs/job-missing",
      {
        method: "DELETE",
      },
      makeEnv(),
    );
    expect(response.status).toBe(404);
  });

  it("DELETE /proofs/jobs/:jobId marks job as failed when present", async () => {
    const response = await requestApi(
      "/proofs/jobs/job-present",
      {
        method: "DELETE",
      },
      makeEnv({
        __coordinator: makeCoordinatorStub({
          markFailed: async () => ({
            jobId: "job-present",
            status: "failed",
          }),
        }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it("POST /proofs/jobs/:jobId/retry-proof validates backend query param", async () => {
    const response = await requestApi(
      "/proofs/jobs/job-1/retry-proof?backend=unknown",
      {
        method: "POST",
      },
      makeEnv(),
    );
    expect(response.status).toBe(400);
  });

  it("POST /proofs/jobs/:jobId/retry-proof returns 404 when job does not exist", async () => {
    const response = await requestApi(
      "/proofs/jobs/job-missing/retry-proof",
      {
        method: "POST",
      },
      makeEnv({
        __coordinator: makeCoordinatorStub({
          retryFailedProof: async () => null,
        }),
      }),
    );
    expect(response.status).toBe(404);
  });

  it("POST /proofs/jobs/:jobId/retry-proof requeues failed proof", async () => {
    const response = await requestApi(
      "/proofs/jobs/job-1/retry-proof?backend=vast",
      {
        method: "POST",
      },
      makeEnv({
        __coordinator: makeCoordinatorStub({
          retryFailedProof: async () => ({
            jobId: "job-1",
            status: "queued",
          }),
        }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      success: boolean;
      job: { jobId: string; status: string };
    };
    expect(payload.success).toBe(true);
    expect(payload.job.jobId).toBe("job-1");
    expect(payload.job.status).toBe("queued");
  });

  // ── GET /proofs/jobs ──────────────────────────────────────────────────────

  it("GET /proofs/jobs returns 400 when address param is missing", async () => {
    const response = await requestApi("/proofs/jobs", undefined, makeEnv());
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      success: boolean;
      error: string;
    };
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("address");
  });

  it("GET /proofs/jobs returns 400 for an invalid address", async () => {
    const response = await requestApi("/proofs/jobs?address=not-valid", undefined, makeEnv());
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      success: boolean;
      error: string;
    };
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("invalid address");
  });

  it("GET /proofs/jobs returns empty list for valid address with no jobs", async () => {
    const response = await requestApi(
      `/proofs/jobs?address=${VALID_CLAIMANT_CONTRACT}`,
      undefined,
      makeEnv(),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      success: boolean;
      jobs: unknown[];
      total: number;
      offset: number;
      limit: number;
      next_offset: number | null;
    };
    expect(payload.success).toBe(true);
    expect(payload.jobs).toHaveLength(0);
    expect(payload.total).toBe(0);
    expect(payload.next_offset).toBeNull();
  });

  it("GET /proofs/jobs returns jobs and pagination metadata", async () => {
    const stubJob = {
      jobId: "job-abc",
      status: "succeeded",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      tape: {
        sizeBytes: 512,
        key: "proof-jobs/job-abc/input.tape",
        metadata: {
          seed: 1,
          seedId: 1,
          frameCount: 10,
          finalScore: 100,
          checksum: 0,
        },
      },
      queue: {
        attempts: 1,
        lastAttemptAt: null,
        lastError: null,
        nextRetryAt: null,
      },
      prover: {
        jobId: null,
        status: null,
        statusUrl: null,
        segmentLimitPo2: null,
        lastPolledAt: null,
        pollingErrors: 0,
      },
      proverAttempts: [],
      result: null,
      claim: {
        claimantAddress: VALID_CLAIMANT_CONTRACT,
        status: "queued",
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        nextRetryAt: null,
        submittedAt: null,
        txHash: null,
      },
      error: null,
    };
    const response = await requestApi(
      `/proofs/jobs?address=${VALID_CLAIMANT_CONTRACT}&limit=10&offset=0`,
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          listJobsForClaimant: async () => ({ jobs: [stubJob], total: 1 }),
        }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      success: boolean;
      jobs: Array<{ jobId: string }>;
      total: number;
      offset: number;
      limit: number;
      next_offset: number | null;
    };
    expect(payload.success).toBe(true);
    expect(payload.jobs).toHaveLength(1);
    expect(payload.jobs[0].jobId).toBe("job-abc");
    expect(payload.total).toBe(1);
    expect(payload.offset).toBe(0);
    expect(payload.limit).toBe(10);
    expect(payload.next_offset).toBeNull();
  });

  it("GET /proofs/jobs hydrates canonical summary cycles from successful attempt data", async () => {
    const stubJob = {
      jobId: "job-cycles",
      status: "succeeded",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      completedAt: "2026-01-01T00:01:00.000Z",
      tape: {
        sizeBytes: 512,
        key: "proof-jobs/job-cycles/input.tape",
        metadata: {
          seed: 1,
          seedId: 1,
          frameCount: 10,
          finalScore: 100,
          checksum: 0,
        },
      },
      queue: {
        attempts: 1,
        lastAttemptAt: null,
        lastError: null,
        nextRetryAt: null,
      },
      prover: {
        jobId: "0xabc",
        status: "succeeded",
        statusUrl: "boundless:0xabc",
        segmentLimitPo2: null,
        lastPolledAt: null,
        pollingErrors: 0,
      },
      proverAttempts: [
        {
          index: 0,
          backend: "boundless",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:01:00.000Z",
          outcome: "success",
          error: null,
          errorDetail: null,
          errorCode: null,
          proverJobId: "0xabc",
          statusUrl: "boundless:0xabc",
          actualCostUsd: null,
          proverAddress: null,
          fulfillmentTxHash: null,
          programCycles: 345,
          totalCycles: 789,
        },
      ],
      result: {
        artifactKey: "proof-jobs/job-cycles/result.json",
        summary: {
          elapsedMs: 0,
          requestedReceiptKind: "groth16",
          producedReceiptKind: "groth16",
          journal: {
            seed_id: 1,
            seed: 1,
            frame_count: 10,
            final_score: 100,
            claimant: VALID_CLAIMANT_CONTRACT,
          },
          stats: {
            segments: 0,
            total_cycles: 0,
            user_cycles: 0,
            paging_cycles: 0,
            reserved_cycles: 0,
          },
        },
      },
      claim: {
        claimantAddress: VALID_CLAIMANT_CONTRACT,
        status: "queued",
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        nextRetryAt: null,
        submittedAt: null,
        txHash: null,
      },
      error: null,
    };

    const response = await requestApi(
      `/proofs/jobs?address=${VALID_CLAIMANT_CONTRACT}&limit=10&offset=0`,
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          listJobsForClaimant: async () => ({ jobs: [stubJob], total: 1 }),
          enrichBoundlessCycles: async () => stubJob,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      success: boolean;
      jobs: Array<{
        result: {
          summary: { stats: { total_cycles: number; user_cycles: number } };
        };
      }>;
    };
    expect(payload.success).toBe(true);
    expect(payload.jobs[0].result.summary.stats.total_cycles).toBe(789);
    expect(payload.jobs[0].result.summary.stats.user_cycles).toBe(345);
  });

  it("GET /proofs/jobs computes next_offset when more pages remain", async () => {
    // 3 total jobs, limit=2, offset=0 → next_offset=2
    const stubJobs = Array.from({ length: 2 }, (_, i) => ({
      jobId: `job-${i}`,
      status: "succeeded",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
      completedAt: null,
      tape: {
        sizeBytes: 100,
        key: `proof-jobs/job-${i}/input.tape`,
        metadata: {
          seed: i,
          seedId: i,
          frameCount: 10,
          finalScore: 100,
          checksum: 0,
        },
      },
      queue: {
        attempts: 1,
        lastAttemptAt: null,
        lastError: null,
        nextRetryAt: null,
      },
      prover: {
        jobId: null,
        status: null,
        statusUrl: null,
        segmentLimitPo2: null,
        lastPolledAt: null,
        pollingErrors: 0,
      },
      proverAttempts: [],
      result: null,
      claim: {
        claimantAddress: VALID_CLAIMANT_CONTRACT,
        status: "queued",
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        nextRetryAt: null,
        submittedAt: null,
        txHash: null,
      },
      error: null,
    }));

    const response = await requestApi(
      `/proofs/jobs?address=${VALID_CLAIMANT_CONTRACT}&limit=2&offset=0`,
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          listJobsForClaimant: async () => ({ jobs: stubJobs, total: 3 }),
        }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      next_offset: number | null;
    };
    expect(payload.next_offset).toBe(2);
  });

  // ── GET /proofs/jobs/:jobId/tape ──────────────────────────────────────────

  it("GET /proofs/jobs/:jobId/tape returns 404 when job does not exist", async () => {
    const response = await requestApi("/proofs/jobs/no-such-job/tape", undefined, makeEnv());
    expect(response.status).toBe(404);
  });

  it("GET /proofs/jobs/:jobId/tape returns 404 when tape artifact is missing", async () => {
    const response = await requestApi(
      "/proofs/jobs/job-exists/tape",
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          getJob: async () => ({
            jobId: "job-exists",
            tape: {
              key: "proof-jobs/job-exists/input.tape",
              sizeBytes: 100,
              metadata: {},
            },
          }),
        }),
        // PROOF_ARTIFACTS.get returns null (tape not in R2)
        PROOF_ARTIFACTS: {
          get: async () => null,
          put: async () => undefined,
          delete: async () => undefined,
        } as unknown as R2Bucket,
      }),
    );
    expect(response.status).toBe(404);
  });

  it("GET /proofs/jobs/:jobId/tape streams tape bytes when present", async () => {
    const tapeBody = new Uint8Array([1, 2, 3, 4]);
    const response = await requestApi(
      "/proofs/jobs/job-with-tape/tape",
      undefined,
      makeEnv({
        __coordinator: makeCoordinatorStub({
          getJob: async () => ({
            jobId: "job-with-tape",
            tape: {
              key: "proof-jobs/job-with-tape/input.tape",
              sizeBytes: 4,
              metadata: {},
            },
          }),
        }),
        PROOF_ARTIFACTS: {
          get: async () => ({
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(tapeBody);
                controller.close();
              },
            }),
          }),
          put: async () => undefined,
          delete: async () => undefined,
        } as unknown as R2Bucket,
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("job-with-tape.tape");
    const buf = await response.arrayBuffer();
    expect(new Uint8Array(buf)).toEqual(tapeBody);
  });
});
