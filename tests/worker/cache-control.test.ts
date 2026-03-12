import { describe, expect, it } from "bun:test";
import {
  API_CACHE_CONTROL,
  LEADERBOARD_CACHE_CONTROL,
  LEADERBOARD_PRIVATE_CACHE_CONTROL,
  applyApiCacheControl,
} from "../../worker/cache-control";

describe("applyApiCacheControl", () => {
  it("applies no-store when cache-control is missing", () => {
    const response = new Response(null, { status: 200 });
    const updated = applyApiCacheControl(response);
    expect(updated.headers.get("cache-control")).toBe(API_CACHE_CONTROL);
  });

  it("preserves explicit cache-control from route handlers", () => {
    const response = new Response(null, {
      status: 200,
      headers: {
        "cache-control": LEADERBOARD_CACHE_CONTROL,
      },
    });
    const updated = applyApiCacheControl(response);
    expect(updated.headers.get("cache-control")).toBe(LEADERBOARD_CACHE_CONTROL);
  });

  it("falls back to a cloned response when headers are immutable", () => {
    const response = new Response("ok", { status: 200 });
    const immutableHeaders = response.headers as Headers & {
      set: (name: string, value: string) => void;
    };
    immutableHeaders.set = () => {
      throw new TypeError("Can't modify immutable headers.");
    };

    const updated = applyApiCacheControl(response);
    expect(updated.headers.get("cache-control")).toBe(API_CACHE_CONTROL);
    expect(response.headers.get("cache-control")).toBeNull();
    expect(updated).not.toBe(response);
  });

  it("supports dedicated private leaderboard caching policy", () => {
    expect(LEADERBOARD_PRIVATE_CACHE_CONTROL).toContain("private");
    expect(LEADERBOARD_PRIVATE_CACHE_CONTROL).toContain("max-age=");
  });
});
