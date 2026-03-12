import { afterEach, describe, expect, it } from "bun:test";
import {
  fetchLeaderboardEventsFromGalexie,
  parseLeaderboardSourceMode,
} from "../../worker/leaderboard-ingestion";
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
    GALEXIE_RPC_BASE_URL: "https://rpc-pro.lightsail.network",
    CLAIM_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
    ...overrides,
  } as WorkerEnv;
}

describe("leaderboard ingestion source selection", () => {
  it("defaults source mode to auto so rpc uses fallback chain when configured", () => {
    expect(parseLeaderboardSourceMode(makeEnv({ GALEXIE_SOURCE_MODE: undefined }))).toBe("auto");
  });

  it("defaults to rpc getEvents when source mode is not configured", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://rpc-pro.lightsail.network/") {
        return jsonResponse({
          result: {
            events: [],
            cursor: "rpc-cursor-1",
          },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      limit: 50,
    });

    expect(result.provider).toBe("rpc");
    expect(result.sourceMode).toBe("rpc");
    expect(result.nextCursor).toBe("rpc-cursor-1");
  });

  it("falls back from mainnet rpc-pro to archive-rpc-pro before galexie modes", async () => {
    const calledUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calledUrls.push(url);
      if (url === "https://rpc-pro.lightsail.network/") {
        return new Response("rpc down", { status: 503 });
      }
      if (url === "https://archive-rpc-pro.lightsail.network/") {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload?.method === "getHealth") {
          return jsonResponse({
            result: {
              latestLedger: 51_000_000,
              oldestLedger: 1,
            },
          });
        }
        return jsonResponse({
          result: {
            events: [],
            cursor: "rpc-cursor-archive",
          },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(
      makeEnv({
        GALEXIE_SOURCE_MODE: "auto",
        GALEXIE_API_BASE_URL: "https://galexie-pro.lightsail.network",
        GALEXIE_RPC_BASE_URL: "",
      }),
      {
        limit: 50,
      },
    );

    expect(result.provider).toBe("rpc");
    expect(result.sourceMode).toBe("rpc");
    expect(result.nextCursor).toBe("rpc-cursor-archive");
    expect(calledUrls).toContain("https://rpc-pro.lightsail.network/");
    expect(calledUrls).toContain("https://archive-rpc-pro.lightsail.network/");
  });

  it("accepts comma-separated GALEXIE_RPC_BASE_URL candidates in priority order", async () => {
    const calledUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calledUrls.push(url);
      if (url === "https://rpc-pro.lightsail.network/") {
        return new Response("rpc down", { status: 503 });
      }
      if (url === "https://archive-rpc-pro.lightsail.network/") {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload?.method === "getHealth") {
          return jsonResponse({
            result: {
              latestLedger: 51_000_000,
              oldestLedger: 1,
            },
          });
        }
        return jsonResponse({
          result: {
            events: [],
            cursor: "rpc-cursor-from-config-list",
          },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(
      makeEnv({
        GALEXIE_RPC_BASE_URL:
          "https://rpc-pro.lightsail.network, https://archive-rpc-pro.lightsail.network",
      }),
      {
        limit: 50,
      },
    );

    expect(result.provider).toBe("rpc");
    expect(result.sourceMode).toBe("rpc");
    expect(result.nextCursor).toBe("rpc-cursor-from-config-list");
    expect(calledUrls[0]).toBe("https://rpc-pro.lightsail.network/");
    expect(calledUrls).toContain("https://archive-rpc-pro.lightsail.network/");
  });

  it("falls back from rpc to datalake in auto mode", async () => {
    let rpcGetEventsCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://rpc-pro.lightsail.network/") {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        const method = payload?.method;
        if (method === "getEvents") {
          rpcGetEventsCalls += 1;
          return new Response("rpc down", { status: 503 });
        }
        if (method === "getHealth") {
          return jsonResponse({ result: { latestLedger: 2 } });
        }
      }
      if (url.endsWith("/v1/.config.json")) {
        return jsonResponse({
          ledgersPerBatch: 1,
          batchesPerPartition: 1,
          compression: "zstd",
        });
      }
      if (url.includes(".xdr.zstd") || url.includes(".xdr.zst")) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(
      makeEnv({
        GALEXIE_SOURCE_MODE: "auto",
        GALEXIE_API_BASE_URL: "https://galexie-pro.lightsail.network",
        GALEXIE_DATASTORE_ROOT_PATH: "/v1",
      }),
      {
        fromLedger: 2,
        toLedger: 2,
        limit: 1,
      },
    );

    expect(rpcGetEventsCalls).toBe(1);
    expect(result.provider).toBe("galexie");
    expect(result.sourceMode).toBe("datalake");
    expect(result.nextCursor).toBe("ledger:3");
  });

  it("falls back in strict order: rpc-pro -> archive-rpc-pro -> datalake", async () => {
    const calledUrls: string[] = [];
    let rpcGetEventsCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calledUrls.push(url);
      if (
        url === "https://rpc-pro.lightsail.network/" ||
        url === "https://archive-rpc-pro.lightsail.network/"
      ) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        const method = payload?.method;
        if (method === "getEvents") {
          rpcGetEventsCalls += 1;
          return new Response("rpc down", { status: 503 });
        }
        if (method === "getHealth") {
          return jsonResponse({ result: { latestLedger: 2 } });
        }
      }
      if (url.endsWith("/v1/.config.json")) {
        return jsonResponse({
          ledgersPerBatch: 1,
          batchesPerPartition: 1,
          compression: "zstd",
        });
      }
      if (url.includes(".xdr.zstd") || url.includes(".xdr.zst")) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(
      makeEnv({
        GALEXIE_RPC_BASE_URL: "",
        GALEXIE_SOURCE_MODE: "auto",
        GALEXIE_API_BASE_URL: "https://galexie-pro.lightsail.network",
        GALEXIE_DATASTORE_ROOT_PATH: "/v1",
      }),
      {
        fromLedger: 2,
        toLedger: 2,
        limit: 1,
      },
    );

    expect(rpcGetEventsCalls).toBe(2);
    expect(result.provider).toBe("galexie");
    expect(result.sourceMode).toBe("datalake");
    expect(result.nextCursor).toBe("ledger:3");

    const rpcProIndex = calledUrls.indexOf("https://rpc-pro.lightsail.network/");
    const archiveIndex = calledUrls.indexOf("https://archive-rpc-pro.lightsail.network/");
    const datalakeConfigIndex = calledUrls.findIndex((url) =>
      url.includes("galexie-pro.lightsail.network/v1/.config.json"),
    );
    expect(rpcProIndex).toBeGreaterThanOrEqual(0);
    expect(archiveIndex).toBeGreaterThanOrEqual(0);
    expect(datalakeConfigIndex).toBeGreaterThanOrEqual(0);
    expect(rpcProIndex).toBeLessThan(archiveIndex);
    expect(archiveIndex).toBeLessThan(datalakeConfigIndex);
  });

  it("does not attempt events_api fallback in auto mode unless explicitly enabled", async () => {
    let eventsApiCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (
        url === "https://rpc-pro.lightsail.network/" ||
        url === "https://archive-rpc-pro.lightsail.network/"
      ) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload?.method === "getHealth") {
          return jsonResponse({
            result: {
              latestLedger: 51_000_000,
              oldestLedger: 1,
            },
          });
        }
        return new Response("rpc down", { status: 503 });
      }
      if (url.endsWith("/v1/.config.json")) {
        return new Response("datalake down", { status: 503 });
      }
      if (url.includes("/events")) {
        eventsApiCalls += 1;
        return jsonResponse({ events: [] });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    await expect(
      fetchLeaderboardEventsFromGalexie(
        makeEnv({
          GALEXIE_SOURCE_MODE: "auto",
          GALEXIE_API_BASE_URL: "https://galexie-pro.lightsail.network",
          GALEXIE_RPC_BASE_URL: "",
        }),
        {
          limit: 10,
        },
      ),
    ).rejects.toThrow("all leaderboard ingestion sources failed");

    expect(eventsApiCalls).toBe(0);
  });

  it("attempts events_api fallback in auto mode when explicitly enabled", async () => {
    let eventsApiCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (
        url === "https://rpc-pro.lightsail.network/" ||
        url === "https://archive-rpc-pro.lightsail.network/"
      ) {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload?.method === "getHealth") {
          return jsonResponse({
            result: {
              latestLedger: 51_000_000,
              oldestLedger: 1,
            },
          });
        }
        return new Response("rpc down", { status: 503 });
      }
      if (url.endsWith("/v1/.config.json")) {
        return new Response("datalake down", { status: 503 });
      }
      if (url.includes("/events")) {
        eventsApiCalls += 1;
        return jsonResponse({ events: [], next_cursor: "events-cursor-1" });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(
      makeEnv({
        GALEXIE_SOURCE_MODE: "auto",
        GALEXIE_ENABLE_EVENTS_API_FALLBACK: "1",
        GALEXIE_API_BASE_URL: "https://galexie-pro.lightsail.network",
        GALEXIE_RPC_BASE_URL: "",
      }),
      {
        limit: 10,
      },
    );

    expect(result.provider).toBe("galexie");
    expect(result.sourceMode).toBe("events_api");
    expect(result.nextCursor).toBe("events-cursor-1");
    expect(eventsApiCalls).toBe(1);
  });

  it("falls back to rpc when datalake mode is configured but galexie is missing", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://rpc-pro.lightsail.network/") {
        return jsonResponse({
          result: {
            events: [],
            cursor: "rpc-cursor-2",
          },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(
      makeEnv({
        GALEXIE_SOURCE_MODE: "datalake",
      }),
      {
        limit: 50,
      },
    );

    expect(result.provider).toBe("rpc");
    expect(result.sourceMode).toBe("rpc");
    expect(result.nextCursor).toBe("rpc-cursor-2");
  });

  it("prefers testnet Lightsail RPC and falls back to soroban-testnet when unresolved", async () => {
    const calledUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calledUrls.push(url);
      if (url === "https://rpc-testnet.lightsail.network/") {
        return new Response("rpc down", { status: 503 });
      }
      if (url === "https://soroban-testnet.stellar.org/") {
        const payload = init?.body ? JSON.parse(String(init.body)) : {};
        if (payload?.method === "getHealth") {
          return jsonResponse({
            result: {
              latestLedger: 1_000_000,
            },
          });
        }
        return jsonResponse({
          result: {
            events: [],
            cursor: "rpc-cursor-testnet",
          },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(
      makeEnv({
        GALEXIE_RPC_BASE_URL: "",
        CLAIM_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      }),
      {
        limit: 50,
      },
    );

    expect(result.provider).toBe("rpc");
    expect(result.sourceMode).toBe("rpc");
    expect(result.nextCursor).toBe("rpc-cursor-testnet");
    expect(calledUrls[0]).toBe("https://rpc-testnet.lightsail.network/");
    expect(calledUrls).toContain("https://soroban-testnet.stellar.org/");
  });

  it("does not forward datalake ledger cursors as rpc pagination cursor", async () => {
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://rpc-pro.lightsail.network/") {
        requestBody = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : null;
        return jsonResponse({
          result: {
            events: [],
            cursor: "rpc-cursor-3",
          },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      cursor: "ledger:61186328",
      limit: 50,
    });

    expect(result.provider).toBe("rpc");
    const params = requestBody?.params as Record<string, unknown>;
    const pagination = params.pagination as Record<string, unknown>;
    expect(pagination.cursor).toBeUndefined();
  });

  it("injects startLedger for soroban-testnet rpc when no cursor is available", async () => {
    const requestPayloads: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://soroban-testnet.stellar.org/") {
        const payload = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : {};
        requestPayloads.push(payload);
        if (payload.method === "getHealth") {
          return jsonResponse({
            result: {
              latestLedger: 1_000_000,
            },
          });
        }
        return jsonResponse({
          result: {
            events: [],
            cursor: "rpc-cursor-testnet-2",
          },
        });
      }
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(
      makeEnv({
        GALEXIE_RPC_BASE_URL: "https://soroban-testnet.stellar.org",
        CLAIM_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      }),
      {
        limit: 50,
      },
    );

    expect(result.provider).toBe("rpc");
    expect(result.nextCursor).toBe("rpc-cursor-testnet-2");
    const getEventsPayload = requestPayloads.find((payload) => payload.method === "getEvents");
    expect(getEventsPayload).toBeDefined();
    const params = getEventsPayload?.params as Record<string, unknown>;
    expect(params.startLedger).toBe(995905);
  });

  it("keeps auto mode rpc-only on testnet when galexie base is not testnet-compatible", async () => {
    let rpcCalls = 0;
    const calledUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calledUrls.push(url);
      if (url === "https://soroban-testnet.stellar.org/") {
        const payload = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : {};
        if (payload.method === "getHealth") {
          return jsonResponse({
            result: {
              latestLedger: 1_000_000,
              oldestLedger: 900_000,
            },
          });
        }
        rpcCalls += 1;
        return jsonResponse({
          result: {
            events: [],
            cursor: "rpc-cursor-testnet-only",
          },
        });
      }
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(
      makeEnv({
        GALEXIE_RPC_BASE_URL: "https://soroban-testnet.stellar.org",
        GALEXIE_SOURCE_MODE: "auto",
        GALEXIE_API_BASE_URL: "https://galexie-pro.lightsail.network",
        CLAIM_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
      }),
      {
        limit: 50,
      },
    );

    expect(result.provider).toBe("rpc");
    expect(result.sourceMode).toBe("rpc");
    expect(result.nextCursor).toBe("rpc-cursor-testnet-only");
    expect(rpcCalls).toBe(1);
    expect(calledUrls.some((url) => url.includes("galexie-pro.lightsail.network"))).toBe(false);
  });

  it("omits start/end ledger when rpc pagination cursor is provided", async () => {
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://rpc-pro.lightsail.network/") {
        requestBody = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : null;
        return jsonResponse({
          result: {
            events: [],
            cursor: "rpc-cursor-opaque-next",
          },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const result = await fetchLeaderboardEventsFromGalexie(makeEnv(), {
      cursor: "0004302736891858944-0000000001",
      fromLedger: 995000,
      toLedger: 1008000,
      limit: 100,
    });

    expect(result.provider).toBe("rpc");
    expect(result.sourceMode).toBe("rpc");
    expect(result.nextCursor).toBe("rpc-cursor-opaque-next");
    const params = requestBody?.params as Record<string, unknown>;
    const pagination = params.pagination as Record<string, unknown>;
    expect(pagination.cursor).toBe("0004302736891858944-0000000001");
    expect(params.startLedger).toBeUndefined();
    expect(params.endLedger).toBeUndefined();
  });
});
