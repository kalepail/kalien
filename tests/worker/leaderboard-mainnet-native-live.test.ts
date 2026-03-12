/**
 * Optional live integration test against mainnet native XLM SAC events.
 *
 * Purpose:
 * - Prove RPC connectivity can discover real contract events on mainnet.
 * - Prove leaderboard ingestion filtering keeps only score_submitted events
 *   (so a busy non-score contract yields fetchedCount > 0 and events.length = 0).
 *
 * This test is opt-in and disabled by default.
 * Enable with:
 *   RUN_MAINNET_NATIVE_INGESTION_LIVE=1 bun test tests/worker/leaderboard-mainnet-native-live.test.ts
 */
import { Asset, Networks } from "@stellar/stellar-sdk";
import { beforeAll, describe, expect, it } from "bun:test";
import { fetchLeaderboardEventsFromGalexie } from "../../worker/leaderboard-ingestion";
import type { WorkerEnv } from "../../worker/env";

const RUN_LIVE = Bun.env.RUN_MAINNET_NATIVE_INGESTION_LIVE === "1";
const MAINNET_SHORT_RPC = Bun.env.MAINNET_SHORT_RPC_URL ?? "https://rpc-pro.lightsail.network/";
const MAINNET_ARCHIVE_RPC =
  Bun.env.MAINNET_ARCHIVE_RPC_URL ?? "https://archive-rpc-pro.lightsail.network/";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const NATIVE_XLM_CONTRACT_ID = Asset.native().contractId(Networks.PUBLIC);

let shortRpcRange: { fromLedger: number; toLedger: number } | null = null;
let archiveRpcRange: { fromLedger: number; toLedger: number } | null = null;

function lightsailAuthHeaders(): Record<string, string> {
  const key = Bun.env.GALEXIE_API_KEY?.trim();
  if (!key) return {};
  return {
    Authorization: `Bearer ${key}`,
    "x-api-key": key,
    "api-key": key,
  };
}

async function fetchRecentRange(
  rpcUrl: string,
): Promise<{ fromLedger: number; toLedger: number } | null> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...lightsailAuthHeaders(),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getHealth",
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json()) as {
    result?: { latestLedger?: number; oldestLedger?: number };
  };
  const latest = payload.result?.latestLedger ?? 0;
  const oldest = payload.result?.oldestLedger ?? 0;
  if (!Number.isFinite(latest) || latest <= 0) return null;
  const fromLedger = Math.max(2, latest - 8_000, oldest > 0 ? oldest : 2);
  return { fromLedger, toLedger: latest };
}

async function fetchRawContractEventsCount(
  rpcUrl: string,
  fromLedger: number,
  toLedger: number,
): Promise<number> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...lightsailAuthHeaders(),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getEvents",
      params: {
        filters: [
          {
            type: "contract",
            contractIds: [NATIVE_XLM_CONTRACT_ID],
          },
        ],
        startLedger: fromLedger,
        endLedger: toLedger,
        pagination: {
          limit: 200,
        },
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    return 0;
  }
  const payload = (await response.json()) as {
    result?: { events?: unknown[] };
  };
  const events = payload.result?.events;
  return Array.isArray(events) ? events.length : 0;
}

function makeEnv(rpcUrl: string): WorkerEnv {
  return {
    SCORE_CONTRACT_ID: NATIVE_XLM_CONTRACT_ID,
    GALEXIE_SOURCE_MODE: "rpc",
    GALEXIE_RPC_BASE_URL: rpcUrl,
    CLAIM_NETWORK_PASSPHRASE: MAINNET_PASSPHRASE,
    GALEXIE_REQUEST_TIMEOUT_MS: "30000",
    GALEXIE_API_KEY: Bun.env.GALEXIE_API_KEY,
  } as WorkerEnv;
}

beforeAll(async () => {
  if (!RUN_LIVE) {
    console.warn(
      "RUN_MAINNET_NATIVE_INGESTION_LIVE is not set; skipping mainnet native ingestion live tests",
    );
    return;
  }

  try {
    shortRpcRange = await fetchRecentRange(MAINNET_SHORT_RPC);
  } catch {
    shortRpcRange = null;
  }

  try {
    archiveRpcRange = await fetchRecentRange(MAINNET_ARCHIVE_RPC);
  } catch {
    archiveRpcRange = null;
  }
});

describe("mainnet native XLM live ingestion", () => {
  it("short RPC finds native contract events and ingestion filters non-score topics", async () => {
    if (!RUN_LIVE) return;
    if (!shortRpcRange) {
      console.warn("short RPC is unreachable; skipping short RPC native live test");
      return;
    }

    const rawCount = await fetchRawContractEventsCount(
      MAINNET_SHORT_RPC,
      shortRpcRange.fromLedger,
      shortRpcRange.toLedger,
    );
    expect(rawCount).toBeGreaterThan(0);

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(MAINNET_SHORT_RPC), {
      source: "rpc",
      fromLedger: shortRpcRange.fromLedger,
      toLedger: shortRpcRange.toLedger,
      limit: 200,
    });

    expect(result.provider).toBe("rpc");
    expect(result.sourceMode).toBe("rpc");
    expect(result.fetchedCount).toBeGreaterThan(0);
    expect(result.events).toHaveLength(0);
  }, 45_000);

  it("archive RPC finds native contract events and ingestion filters non-score topics", async () => {
    if (!RUN_LIVE) return;
    if (!archiveRpcRange) {
      console.warn("archive RPC is unreachable; skipping archive RPC native live test");
      return;
    }

    const rawCount = await fetchRawContractEventsCount(
      MAINNET_ARCHIVE_RPC,
      archiveRpcRange.fromLedger,
      archiveRpcRange.toLedger,
    );
    expect(rawCount).toBeGreaterThan(0);

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(MAINNET_ARCHIVE_RPC), {
      source: "rpc",
      fromLedger: archiveRpcRange.fromLedger,
      toLedger: archiveRpcRange.toLedger,
      limit: 200,
    });

    expect(result.provider).toBe("rpc");
    expect(result.sourceMode).toBe("rpc");
    expect(result.fetchedCount).toBeGreaterThan(0);
    expect(result.events).toHaveLength(0);
  }, 45_000);
});
