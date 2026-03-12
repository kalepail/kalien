import { afterAll, describe, expect, it, mock } from "bun:test";
import type { WorkerEnv } from "../../worker/env";
import {
  HEALTH_CACHE_CONTROL,
  LEADERBOARD_CACHE_CONTROL,
  LEADERBOARD_PRIVATE_CACHE_CONTROL,
} from "../../worker/cache-control";

const VALID_CLAIMANT_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4";
const EXAMPLE_GENERATED_AT = "2026-02-14T00:00:00.000Z";

mock.module("../../worker/queue/consumer", () => ({
  handleDlqBatch: async () => undefined,
  handleQueueBatch: async () => undefined,
  handleVastQueueBatch: async () => undefined,
  handleClaimQueueBatch: async () => undefined,
  handleClaimDlqBatch: async () => undefined,
}));

mock.module("../../worker/leaderboard-sync", () => ({
  runScheduledLeaderboardSync: async () => ({
    enabled: false,
    warning: null,
  }),
  recordLeaderboardSyncFailure: async () => undefined,
}));

mock.module("../../worker/leaderboard-profile-auth", () => ({
  assertCredentialBelongsToClaimantContract: async () => undefined,
  encodeRawP256PublicKeyBase64UrlToCose: () => new Uint8Array([1]),
  fetchCredentialPublicKeyFromChain: async () => "mock-public-key",
  LeaderboardCredentialBindingError: class LeaderboardCredentialBindingError extends Error {
    statusCode = 400;
  },
}));

mock.module("@simplewebauthn/server", () => ({
  generateAuthenticationOptions: async () => ({
    challenge: "mock-challenge",
  }),
  verifyAuthenticationResponse: async () => ({
    verified: false,
    authenticationInfo: {
      newCounter: 0,
    },
  }),
}));

mock.module("../../worker/leaderboard-store", () => ({
  createLeaderboardProfileAuthChallenge: async () => undefined,
  getLeaderboardIngestionState: async () => ({
    provider: "rpc",
    sourceMode: "rpc",
    cursor: "ledger:1",
    highestLedger: 1,
    lastSyncedAt: EXAMPLE_GENERATED_AT,
    lastBackfillAt: null,
    totalEvents: 1,
    lastError: null,
  }),
  getLeaderboardPage: async (env: WorkerEnv, options: { claimantAddress: string | null }) => ({
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
    entries: [
      {
        rank: 1,
        jobId: "evt-1",
        claimantAddress: VALID_CLAIMANT_CONTRACT,
        score: 1337,
        mintedDelta: 1337,
        seed: 42,
        frameCount: 1200,
        completedAt: EXAMPLE_GENERATED_AT,
        claimStatus: "succeeded",
        claimTxHash: "tx-1",
        profile: {
          claimantAddress: VALID_CLAIMANT_CONTRACT,
          username: "pilot",
          linkUrl: null,
          updatedAt: EXAMPLE_GENERATED_AT,
        },
      },
    ],
    me:
      options.claimantAddress === VALID_CLAIMANT_CONTRACT
        ? {
            rank: 1,
            jobId: "evt-1",
            claimantAddress: VALID_CLAIMANT_CONTRACT,
            score: 1337,
            mintedDelta: 1337,
            seed: 42,
            frameCount: 1200,
            completedAt: EXAMPLE_GENERATED_AT,
            claimStatus: "succeeded",
            claimTxHash: "tx-1",
            profile: {
              claimantAddress: VALID_CLAIMANT_CONTRACT,
              username: "pilot",
              linkUrl: null,
              updatedAt: EXAMPLE_GENERATED_AT,
            },
          }
        : null,
  }),
  getLeaderboardPlayer: async () => ({
    profile: null,
    stats: {
      totalRuns: 0,
      bestScore: 0,
      totalMinted: 0,
      lastPlayedAt: null,
    },
    ranks: {
      tenMin: null,
      day: null,
      all: null,
    },
    recentRuns: [],
  }),
  getProofClaimIndexEntriesByTxHashes: async () => [],
  getLeaderboardProfileAuthChallenge: async () => null,
  getLeaderboardProfileCredential: async () => null,
  markLeaderboardProfileAuthChallengeUsed: async () => false,
  purgeExpiredLeaderboardProfileAuthChallenges: async () => undefined,
  updateLeaderboardProfileCredentialCounter: async () => undefined,
  upsertLeaderboardProfile: async () => null,
  upsertLeaderboardProfileCredential: async () => ({
    claimantAddress: VALID_CLAIMANT_CONTRACT,
    credentialId: "credential-1",
    publicKey: "mock-public-key",
    counter: 0,
    transports: null,
    createdAt: EXAMPLE_GENERATED_AT,
    updatedAt: EXAMPLE_GENERATED_AT,
  }),
  writeProofTapeMapping: async () => undefined,
}));

function MockProofCoordinatorDO() {}

mock.module("../../worker/durable/coordinator", () => ({
  coordinatorStub: (env: WorkerEnv) =>
    (env as WorkerEnv & { __coordinator: Record<string, unknown> }).__coordinator,
  asPublicJob: <T>(job: T): T => job,
  ProofCoordinatorDO: MockProofCoordinatorDO,
}));

afterAll(() => {
  mock.restore();
});

const workerModule = await import("../../worker/index");
const handler = workerModule.default;

function makeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  const assetsCalls: string[] = [];
  const defaultCoordinator = {
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
    runMaintenance: async () => ({
      alarmsRescheduled: 0,
      claimsRequeued: 0,
      staleQueuedClaimsRequeued: 0,
      staleRetryingClaimsRequeued: 0,
      staleSubmittingClaimsRecovered: 0,
    }),
  };
  const env = {
    ASSETS: {
      fetch: async (request: Request) => {
        assetsCalls.push(request.url);
        return new Response("asset-ok", {
          status: 200,
          headers: {
            "cache-control": "public, max-age=3600",
          },
        });
      },
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
      get: () => defaultCoordinator as unknown as DurableObjectStub,
    } as unknown as DurableObjectNamespace,
    PROOF_ARTIFACTS: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    } as unknown as R2Bucket,
    PROVER_BASE_URL: "",
    __coordinator: defaultCoordinator,
    __assetsCalls: assetsCalls,
    ...overrides,
  } as WorkerEnv & {
    __coordinator: Record<string, unknown>;
    __assetsCalls: string[];
  };
  return env;
}

const noopExecutionContext = {
  waitUntil() {
    // no-op in tests
  },
  passThroughOnException() {
    // no-op in tests
  },
} as unknown as ExecutionContext;

async function requestWorker(path: string, init: RequestInit | undefined, env: WorkerEnv) {
  const request = new Request(`https://worker.test${path}`, init);
  return handler.fetch(request, env, noopExecutionContext);
}

describe("Worker live interface", () => {
  it("applies health cache-control to /api/health", async () => {
    const response = await requestWorker("/api/health", undefined, makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(HEALTH_CACHE_CONTROL);
  });

  it("preserves public leaderboard cache policy for public reads", async () => {
    const response = await requestWorker("/api/leaderboard?window=all", undefined, makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(LEADERBOARD_CACHE_CONTROL);
    expect(response.headers.get("etag")).toBeTruthy();
  });

  it("preserves private leaderboard cache policy for address-scoped reads", async () => {
    const response = await requestWorker(
      `/api/leaderboard?window=all&address=${VALID_CLAIMANT_CONTRACT}`,
      undefined,
      makeEnv(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(LEADERBOARD_PRIVATE_CACHE_CONTROL);
  });

  it("supports conditional ETag revalidation on leaderboard route", async () => {
    const env = makeEnv();
    const first = await requestWorker("/api/leaderboard?window=all", undefined, env);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const second = await requestWorker(
      "/api/leaderboard?window=all",
      {
        headers: {
          "if-none-match": etag ?? "",
        },
      },
      env,
    );
    expect(second.status).toBe(304);
    expect(second.headers.get("cache-control")).toBe(LEADERBOARD_CACHE_CONTROL);
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("sets no-store for profile auth challenge options", async () => {
    const response = await requestWorker(
      `/api/leaderboard/player/${VALID_CLAIMANT_CONTRACT}/profile/auth/options`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          credential_id: "credential-1",
        }),
      },
      makeEnv(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns API not-found payload for unknown /api route", async () => {
    const response = await requestWorker("/api/does-not-exist", undefined, makeEnv());
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const payload = (await response.json()) as {
      success: boolean;
      error: string;
    };
    expect(payload.success).toBe(false);
    expect(payload.error).toContain("unknown api route");
  });

  it("runs proof maintenance from the dev endpoint when authorized", async () => {
    const env = makeEnv({
      DEV_API_KEY: "dev-secret",
      __coordinator: {
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
        runMaintenance: async () => ({
          alarmsRescheduled: 1,
          claimsRequeued: 2,
          staleQueuedClaimsRequeued: 1,
          staleRetryingClaimsRequeued: 1,
          staleSubmittingClaimsRecovered: 0,
        }),
      } as Record<string, unknown>,
      PROOF_COORDINATOR: {
        idFromName: () => "coordinator-id" as unknown as DurableObjectId,
        get: () =>
          ({
            runMaintenance: async () => ({
              alarmsRescheduled: 1,
              claimsRequeued: 2,
              staleQueuedClaimsRequeued: 1,
              staleRetryingClaimsRequeued: 1,
              staleSubmittingClaimsRecovered: 0,
            }),
          }) as DurableObjectStub,
      } as unknown as DurableObjectNamespace,
    });
    const response = await requestWorker(
      "/api/dev/proofs/maintenance",
      {
        method: "POST",
        headers: {
          authorization: "Bearer dev-secret",
        },
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = (await response.json()) as {
      success: boolean;
      result: {
        alarmsRescheduled: number;
        claimsRequeued: number;
        staleQueuedClaimsRequeued: number;
        staleRetryingClaimsRequeued: number;
        staleSubmittingClaimsRecovered: number;
      };
    };
    expect(payload.success).toBe(true);
    expect(payload.result.claimsRequeued).toBe(2);
    expect(payload.result.staleRetryingClaimsRequeued).toBe(1);
  });

  it("falls back to ASSETS fetch for non-api routes", async () => {
    const env = makeEnv() as WorkerEnv & { __assetsCalls: string[] };
    const response = await requestWorker("/leaderboard-ui", undefined, env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("asset-ok");
    expect(env.__assetsCalls.length).toBe(1);
    expect(env.__assetsCalls[0]?.endsWith("/leaderboard-ui")).toBe(true);
  });
});
