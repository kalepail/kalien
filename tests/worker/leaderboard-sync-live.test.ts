/**
 * Live integration test: leaderboard sync against real Stellar testnet RPC.
 *
 * Verifies that `runLeaderboardSync` can fetch real on-chain score_submitted
 * events from the testnet RPC and produce correctly structured event records.
 *
 * The known on-chain event:
 *   Contract:  CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU
 *   TxHash:    5fd87e77d8e8cc587d153e2fa10bc37faafc5513f6e8ff16561a7c10adde1ff9
 *   Ledger:    1054047
 *   Claimant:  CDPAHIOTDASW6WULHAJ5UL4H6YH7OJ2T72LKVT75SCFDZ4YZTOVDFEQX
 *   Score:     35010
 *   Seed:      1741681574 (0x67cff3a6)
 *
 * Skipped automatically when the testnet RPC is unreachable.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { fetchLeaderboardEventsFromGalexie } from "../../worker/leaderboard-ingestion";
import type { WorkerEnv } from "../../worker/env";

const TESTNET_RPC = "https://soroban-testnet.stellar.org/";
const SCORE_CONTRACT = "CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU";
const KNOWN_LEDGER = 1054047;
const KNOWN_TX_HASH = "5fd87e77d8e8cc587d153e2fa10bc37faafc5513f6e8ff16561a7c10adde1ff9";
const KNOWN_CLAIMANT = "CDPAHIOTDASW6WULHAJ5UL4H6YH7OJ2T72LKVT75SCFDZ4YZTOVDFEQX";
const KNOWN_SCORE = 35_010;
const KNOWN_SEED = 1741681574;

let rpcReachable = false;
let rpcOldestLedger = 0;

beforeAll(async () => {
  try {
    const response = await fetch(TESTNET_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) {
      const data = (await response.json()) as {
        result?: { oldestLedger?: number; latestLedger?: number };
      };
      rpcOldestLedger = data.result?.oldestLedger ?? 0;
      // Only reachable if the known ledger is within retention
      rpcReachable = rpcOldestLedger > 0 && rpcOldestLedger <= KNOWN_LEDGER;
      if (!rpcReachable && rpcOldestLedger > KNOWN_LEDGER) {
        console.warn(
          `RPC reachable but ledger ${KNOWN_LEDGER} is outside retention ` +
            `(oldest=${rpcOldestLedger}). Skipping live sync tests.`,
        );
      }
    }
  } catch {
    rpcReachable = false;
  }
  if (!rpcReachable) {
    console.warn("Testnet RPC unreachable or event outside retention — skipping live sync tests");
  }
});

function makeEnv(): WorkerEnv {
  return {
    SCORE_CONTRACT_ID: SCORE_CONTRACT,
    GALEXIE_RPC_BASE_URL: TESTNET_RPC,
    GALEXIE_SOURCE_MODE: "rpc",
    GALEXIE_REQUEST_TIMEOUT_MS: "30000",
  } as WorkerEnv;
}

describe("live leaderboard sync against testnet RPC", () => {
  it("fetches the known score_submitted event from testnet", async () => {
    if (!rpcReachable) return;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      fromLedger: KNOWN_LEDGER,
      toLedger: KNOWN_LEDGER + 1,
      limit: 100,
      source: "rpc",
    });

    expect(result.provider).toBe("rpc");
    expect(result.sourceMode).toBe("rpc");
    expect(result.events.length).toBeGreaterThanOrEqual(1);

    // Find our known event
    const knownEvent = result.events.find(
      (e) => e.txHash === KNOWN_TX_HASH || e.claimantAddress === KNOWN_CLAIMANT,
    );
    expect(knownEvent).toBeTruthy();
    if (!knownEvent) return;

    // Verify all fields match the expected values
    expect(knownEvent.claimantAddress).toBe(KNOWN_CLAIMANT);
    expect(knownEvent.seed).toBe(KNOWN_SEED);
    expect(knownEvent.finalScore).toBe(KNOWN_SCORE);
    expect(knownEvent.frameCount).toBe(14123);
    expect(knownEvent.previousBest).toBe(0);
    expect(knownEvent.newBest).toBe(KNOWN_SCORE);
    expect(knownEvent.mintedDelta).toBe(KNOWN_SCORE);
    expect(knownEvent.txHash).toBe(KNOWN_TX_HASH);
    expect(knownEvent.ledger).toBe(KNOWN_LEDGER);
    expect(knownEvent.source).toBe("rpc");

    console.log(
      `Live event found: claimant=${knownEvent.claimantAddress}, score=${knownEvent.finalScore}, ` +
        `seed=0x${(knownEvent.seed >>> 0).toString(16)}, ledger=${knownEvent.ledger}`,
    );
  }, 30_000);

  it("event has valid closedAt timestamp", async () => {
    if (!rpcReachable) return;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      fromLedger: KNOWN_LEDGER,
      toLedger: KNOWN_LEDGER + 1,
      limit: 100,
      source: "rpc",
    });

    const knownEvent = result.events.find((e) => e.txHash === KNOWN_TX_HASH);
    expect(knownEvent).toBeTruthy();
    if (!knownEvent) return;

    // closedAt should be a valid ISO date near when the ledger closed
    const closedAt = new Date(knownEvent.closedAt);
    expect(closedAt.getTime()).toBeGreaterThan(0);
    // Ledger 1054047 closed on 2026-02-16
    expect(closedAt.getFullYear()).toBe(2026);
    expect(closedAt.getMonth()).toBe(1); // February (0-indexed)
    expect(closedAt.getDate()).toBe(16);
  }, 30_000);

  it("canonical invariants hold for live event", async () => {
    if (!rpcReachable) return;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      fromLedger: KNOWN_LEDGER,
      toLedger: KNOWN_LEDGER + 1,
      limit: 100,
      source: "rpc",
    });

    const knownEvent = result.events.find((e) => e.txHash === KNOWN_TX_HASH);
    expect(knownEvent).toBeTruthy();
    if (!knownEvent) return;

    // finalScore === newBest (first submission)
    expect(knownEvent.finalScore).toBe(knownEvent.newBest);
    // previousBest <= newBest
    expect(knownEvent.previousBest).toBeLessThanOrEqual(knownEvent.newBest);
    // mintedDelta === newBest - previousBest
    expect(knownEvent.mintedDelta).toBe(knownEvent.newBest - knownEvent.previousBest);
  }, 30_000);

  it("returns correct next cursor for pagination", async () => {
    if (!rpcReachable) return;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      fromLedger: KNOWN_LEDGER,
      toLedger: KNOWN_LEDGER + 1,
      limit: 100,
      source: "rpc",
    });

    // Should have a next cursor for forward pagination
    expect(result.nextCursor).toBeTruthy();
    // fetchedCount should be reported
    expect(result.fetchedCount).toBeGreaterThanOrEqual(result.events.length);
  }, 30_000);

  it("filters by score contract ID correctly", async () => {
    if (!rpcReachable) return;

    // Fetch with correct contract ID — should find events
    const correctResult = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      fromLedger: KNOWN_LEDGER,
      toLedger: KNOWN_LEDGER + 1,
      limit: 100,
      source: "rpc",
    });
    expect(correctResult.events.length).toBeGreaterThanOrEqual(1);

    // Fetch with wrong contract ID — should find no score events
    const wrongEnv = makeEnv();
    // Use a different valid contract address
    wrongEnv.SCORE_CONTRACT_ID = "CCYKHXM3LO5CC6X26GFOLZGPXWI3P2LWXY3EGG7JTTM5BQ3ISETDQ3DD";
    const wrongResult = await fetchLeaderboardEventsFromGalexie(wrongEnv, {
      fromLedger: KNOWN_LEDGER,
      toLedger: KNOWN_LEDGER + 1,
      limit: 100,
      source: "rpc",
    });
    expect(wrongResult.events.length).toBe(0);
  }, 30_000);
});
