/**
 * Tests for leaderboard ingestion using real on-chain event data.
 *
 * Fixture source:
 * - Stellar testnet
 * - score_submitted event
 * - txHash 5fd87e77d8e8cc587d153e2fa10bc37faafc5513f6e8ff16561a7c10adde1ff9
 */
import { afterEach, describe, expect, it } from "bun:test";
import { scValToNative, xdr } from "@stellar/stellar-base";
import {
  fetchLeaderboardEventsFromGalexie,
  normalizeGalexieScoreEvents,
} from "../../worker/leaderboard-ingestion";
import type { WorkerEnv } from "../../worker/env";

const REAL_RPC_EVENT = {
  type: "contract",
  ledger: 1054047,
  ledgerClosedAt: "2026-02-16T19:01:25Z",
  contractId: "CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU",
  id: "0004527097393475584-0000000001",
  operationIndex: 0,
  transactionIndex: 7,
  txHash: "5fd87e77d8e8cc587d153e2fa10bc37faafc5513f6e8ff16561a7c10adde1ff9",
  inSuccessfulContractCall: true,
  topic: ["AAAADwAAAA9zY29yZV9zdWJtaXR0ZWQA"],
  value:
    "AAAAEQAAAAEAAAALAAAADwAAAAhjbGFpbWFudAAAABIAAAAB3gOh0xglb1qLOBPaL4f2D/cnU/6Wqs/9kIo88xmbqjIAAAAPAAAAD2ZpbmFsX3JuZ19zdGF0ZQAAAAADsW4HwAAAAA8AAAALZmluYWxfc2NvcmUAAAAAAwAAiMIAAAAPAAAAC2ZyYW1lX2NvdW50AAAAAAMAADcrAAAADwAAAA5qb3VybmFsX2RpZ2VzdAAAAAAADQAAACAHy7Tac4D+rLO6J6xjcJ0aD9ch79TYpxwo+O5b1Z0zWwAAAA8AAAAMbWludGVkX2RlbHRhAAAAAwAAiMIAAAAPAAAACG5ld19iZXN0AAAAAwAAiMIAAAAPAAAADXByZXZpb3VzX2Jlc3QAAAAAAAADAAAAAAAAAA8AAAAMcnVsZXNfZGlnZXN0AAAAA0FTVDQAAAAPAAAABHNlZWQAAAADZ8/zpgAAAA8AAAANdGFwZV9jaGVja3N1bQAAAAAAAAPo3uG2",
};

const EXPECTED = {
  claimantAddress: "CDPAHIOTDASW6WULHAJ5UL4H6YH7OJ2T72LKVT75SCFDZ4YZTOVDFEQX",
  seed: 1741681574,
  frameCount: 14123,
  finalScore: 35_010,
  previousBest: 0,
  newBest: 35_010,
  mintedDelta: 35_010,
  txHash: "5fd87e77d8e8cc587d153e2fa10bc37faafc5513f6e8ff16561a7c10adde1ff9",
  ledger: 1054047,
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    ASSETS: {} as Fetcher,
    PROOF_QUEUE: {} as Queue<unknown>,
    CLAIM_QUEUE: {} as Queue<unknown>,
    PROOF_COORDINATOR: {} as DurableObjectNamespace<never>,
    PROOF_ARTIFACTS: {} as R2Bucket,
    PROVER_BASE_URL: "http://127.0.0.1:8088",
    GALEXIE_RPC_BASE_URL: "https://rpc-test.example.com",
    CLAIM_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    SCORE_CONTRACT_ID: "CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU",
    ...overrides,
  } as WorkerEnv;
}

describe("real event XDR decoding", () => {
  it("decodes the topic to score_submitted", () => {
    const topicScVal = xdr.ScVal.fromXDR(REAL_RPC_EVENT.topic[0], "base64");
    const topicNative = scValToNative(topicScVal);
    expect(topicNative).toBe("score_submitted");
  });

  it("contains required score fields in decoded payload", () => {
    const valueScVal = xdr.ScVal.fromXDR(REAL_RPC_EVENT.value, "base64");
    const valueNative = scValToNative(valueScVal) as Record<string, unknown>;

    const requiredKeys = [
      "claimant",
      "seed",
      "frame_count",
      "final_score",
      "previous_best",
      "new_best",
      "minted_delta",
    ];
    for (const key of requiredKeys) {
      expect(key in valueNative).toBe(true);
    }

    expect(valueNative.claimant).toBe(EXPECTED.claimantAddress);
    expect(Number(valueNative.seed)).toBe(EXPECTED.seed);
    expect(Number(valueNative.frame_count)).toBe(EXPECTED.frameCount);
    expect(Number(valueNative.final_score)).toBe(EXPECTED.finalScore);
    expect(Number(valueNative.previous_best)).toBe(EXPECTED.previousBest);
    expect(Number(valueNative.new_best)).toBe(EXPECTED.newBest);
    expect(Number(valueNative.minted_delta)).toBe(EXPECTED.mintedDelta);
  });
});

describe("real event RPC ingestion", () => {
  it("parses real getEvents response into leaderboard records", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url !== "https://rpc-test.example.com/") {
        return new Response(null, { status: 404 });
      }

      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (body.method === "getHealth") {
        return jsonResponse({
          result: {
            latestLedger: 1054109,
            oldestLedger: 933150,
          },
        });
      }
      if (body.method === "getEvents") {
        return jsonResponse({
          result: {
            events: [REAL_RPC_EVENT],
            cursor: "0004527367976386559-4294967295",
            latestLedger: 1054109,
          },
        });
      }

      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      fromLedger: 1050000,
      toLedger: 1054109,
      limit: 100,
      source: "rpc",
    });

    expect(result.provider).toBe("rpc");
    expect(result.sourceMode).toBe("rpc");
    expect(result.fetchedCount).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.nextCursor).toBe("0004527367976386559-4294967295");

    const [event] = result.events;
    expect(event).toBeDefined();
    if (!event) {
      throw new Error("expected normalized event");
    }
    expect(event.eventId).toBe("0004527097393475584-0000000001");
    expect(event.claimantAddress).toBe(EXPECTED.claimantAddress);
    expect(event.seed).toBe(EXPECTED.seed >>> 0);
    expect(event.frameCount).toBe(EXPECTED.frameCount);
    expect(event.finalScore).toBe(EXPECTED.finalScore);
    expect(event.previousBest).toBe(EXPECTED.previousBest);
    expect(event.newBest).toBe(EXPECTED.newBest);
    expect(event.mintedDelta).toBe(EXPECTED.mintedDelta);
    expect(event.txHash).toBe(EXPECTED.txHash);
    expect(event.ledger).toBe(EXPECTED.ledger);
    expect(event.closedAt).toBe("2026-02-16T19:01:25.000Z");
    expect(event.source).toBe("rpc");
  });

  it("filters out non-score topics", async () => {
    const nonScoreEvent = {
      ...REAL_RPC_EVENT,
      topic: ["AAAADwAAAAtub3Rfc2NvcmU="],
    };

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (body.method === "getHealth") {
        return jsonResponse({
          result: { latestLedger: 1054109, oldestLedger: 933150 },
        });
      }
      if (body.method === "getEvents") {
        return jsonResponse({
          result: {
            events: [nonScoreEvent],
            cursor: null,
            latestLedger: 1054109,
          },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      fromLedger: 1050000,
      toLedger: 1054109,
      limit: 100,
      source: "rpc",
    });

    expect(result.events).toHaveLength(0);
  });
});

describe("events_api normalization", () => {
  it("normalizes forward-only payload shape", () => {
    const normalized = normalizeGalexieScoreEvents({
      events: [
        {
          id: "evt-1",
          claimant: EXPECTED.claimantAddress,
          seed: String(EXPECTED.seed),
          frame_count: String(EXPECTED.frameCount),
          final_score: String(EXPECTED.finalScore),
          previous_best: String(EXPECTED.previousBest),
          new_best: String(EXPECTED.newBest),
          minted_delta: String(EXPECTED.mintedDelta),
          tx_hash: EXPECTED.txHash,
          event_index: 1,
          ledger: EXPECTED.ledger,
          closed_at: "2026-02-16T19:01:25Z",
        },
      ],
      next_cursor: "cursor-1",
    });

    expect(normalized.events).toHaveLength(1);
    expect(normalized.nextCursor).toBe("cursor-1");
    const [event] = normalized.events;
    expect(event).toBeDefined();
    if (!event) {
      throw new Error("expected normalized event");
    }
    expect(event.claimantAddress).toBe(EXPECTED.claimantAddress);
    expect(event.seed).toBe(EXPECTED.seed >>> 0);
    expect(event.finalScore).toBe(EXPECTED.finalScore >>> 0);
    expect(event.previousBest).toBe(EXPECTED.previousBest >>> 0);
    expect(event.newBest).toBe(EXPECTED.newBest >>> 0);
    expect(event.mintedDelta).toBe(EXPECTED.mintedDelta >>> 0);
  });

  it("rejects non-canonical score invariants", () => {
    const normalized = normalizeGalexieScoreEvents({
      events: [
        {
          id: "evt-bad",
          claimant: EXPECTED.claimantAddress,
          seed: 1,
          frame_count: 10,
          final_score: 100,
          previous_best: 0,
          new_best: 99,
          minted_delta: 100,
          closed_at: "2026-02-16T19:01:25Z",
        },
      ],
    });

    expect(normalized.events).toHaveLength(0);
  });
});
