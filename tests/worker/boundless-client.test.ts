import { describe, expect, it } from "bun:test";
const { fetchBoundlessCycles } = await import("../../worker/boundless/sdk/client.ts?suite=real");

describe("fetchBoundlessCycles", () => {
  it("parses object payloads from the Boundless indexer", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input) =>
      new Response(
        JSON.stringify({
          program_cycles: "49183188",
          total_cycles: "51380224",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    try {
      const result = await fetchBoundlessCycles("8453", "0xabc");
      expect(result).toEqual({
        programCycles: 49183188,
        totalCycles: 51380224,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to Explorer API when primary indexer responds non-200", async () => {
    const originalFetch = globalThis.fetch;
    const calledUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input.url;
      calledUrls.push(url);
      if (calledUrls.length === 1) {
        return new Response("forbidden", { status: 403 });
      }
      return new Response(
        JSON.stringify({
          program_cycles: "391",
          total_cycles: "422",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const result = await fetchBoundlessCycles("8453", "0x123");
      expect(result).toEqual({
        programCycles: 391,
        totalCycles: 422,
      });
      expect(calledUrls[0]).toBe("https://d2mdvlnmyov1e1.cloudfront.net/v1/market/requests/0x123");
      expect(calledUrls[1]).toBe("https://explorer.boundless.network/api/orders/0x123");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses Explorer API even when chain has no configured indexer URL", async () => {
    const originalFetch = globalThis.fetch;
    const calledUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input.url;
      calledUrls.push(url);
      return new Response(
        JSON.stringify({
          program_cycles: "111",
          total_cycles: "222",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const result = await fetchBoundlessCycles("11155111", "0x987");
      expect(result).toEqual({
        programCycles: 111,
        totalCycles: 222,
      });
      expect(calledUrls).toEqual(["https://explorer.boundless.network/api/orders/0x987"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns null cycles when all sources fail", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network error");
    }) as typeof fetch;

    try {
      const result = await fetchBoundlessCycles("8453", "0xdead");
      expect(result).toEqual({
        programCycles: null,
        totalCycles: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
