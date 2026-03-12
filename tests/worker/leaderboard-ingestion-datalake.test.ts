import { afterEach, describe, expect, it } from "bun:test";
import { fetchLeaderboardEventsFromGalexie } from "../../worker/leaderboard-ingestion";
import type { WorkerEnv } from "../../worker/env";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
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
    GALEXIE_SOURCE_MODE: "datalake",
    GALEXIE_API_BASE_URL: "https://galexie-pro.lightsail.network",
    GALEXIE_RPC_BASE_URL: "https://rpc-pro.lightsail.network",
    GALEXIE_DATASTORE_ROOT_PATH: "/v1",
    ...overrides,
  } as WorkerEnv;
}

describe("datalake ingestion object-key behavior", () => {
  it("uses single-ledger filename format without partition directories", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);

      if (url.endsWith("/v1/.config.json")) {
        return jsonResponse({
          ledgersPerBatch: 1,
          batchesPerPartition: 1,
          compression: "zstd",
        });
      }
      if (url === "https://rpc-pro.lightsail.network/") {
        return jsonResponse({ result: { latestLedger: 999_999 } });
      }

      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      fromLedger: 2,
      toLedger: 2,
      limit: 1,
    });

    expect(result.events).toHaveLength(0);
    expect(result.nextCursor).toBe("ledger:3");
    expect(
      urls.some(
        (url) =>
          url.includes("/v1/FFFFFFFD--2.xdr.zstd") || url.includes("/v1/FFFFFFFD--2.xdr.zst"),
      ),
    ).toBe(true);
    expect(urls.some((url) => url.includes("--2-2.xdr."))).toBe(false);
    expect(urls.some((url) => url.includes("/--0-"))).toBe(false);
  });

  it("accepts snake_case schema fields and derives partitioned object paths", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      urls.push(url);

      if (url.endsWith("/v1/.config.json")) {
        return jsonResponse({
          schema: {
            ledgers_per_file: 64,
            files_per_partition: 64_000,
          },
          compression: "zstd",
        });
      }
      if (url === "https://rpc-pro.lightsail.network/") {
        return jsonResponse({ result: { latestLedger: 999_999 } });
      }

      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      fromLedger: 64,
      toLedger: 64,
      limit: 1,
    });

    expect(result.events).toHaveLength(0);
    expect(result.nextCursor).toBe("ledger:128");
    expect(
      urls.some(
        (url) =>
          url.includes("/v1/FFFFFFFF--0-4095999/FFFFFFBF--64-127.xdr.zstd") ||
          url.includes("/v1/FFFFFFFF--0-4095999/FFFFFFBF--64-127.xdr.zst"),
      ),
    ).toBe(true);
  });
});
