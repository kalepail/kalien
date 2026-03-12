import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";

// ── usdToWei tests (pure math, no mocking needed) ──────────────────────────

describe("usdToWei", () => {
  it("converts $1 at $2000/ETH to 0.0005 ETH", () => {
    const wei = usdToWei(1, 2000);
    // $1 / $2000/ETH = 0.0005 ETH = 5e14 wei
    expect(wei).toBe(500_000_000_000_000n);
  });

  it("converts $0.02 at $1900/ETH correctly", () => {
    const wei = usdToWei(0.02, 1900);
    // $0.02 / $1900 = 0.00001052631... ETH ≈ 10_526_315_789_473n wei
    // Verify within ±1 wei of expected (integer division truncation)
    const expected = (20_000n * 10n ** 18n) / 1_900_000_000n;
    expect(wei).toBe(expected);
  });

  it("converts $0.0002 at $1900/ETH (auction floor)", () => {
    const wei = usdToWei(0.0002, 1900);
    const expected = (200n * 10n ** 18n) / 1_900_000_000n;
    expect(wei).toBe(expected);
  });

  it("returns 0 for $0", () => {
    expect(usdToWei(0, 2000)).toBe(0n);
  });

  it("handles very high ETH price ($100,000)", () => {
    const wei = usdToWei(0.02, 100_000);
    // $0.02 / $100,000 = 2e-7 ETH = 200_000_000_000 wei
    const expected = (20_000n * 10n ** 18n) / 100_000_000_000n;
    expect(wei).toBe(expected);
    expect(wei).toBeGreaterThan(0n);
  });

  it("handles very low ETH price ($100)", () => {
    const wei = usdToWei(0.02, 100);
    // $0.02 / $100 = 0.0002 ETH = 200_000_000_000_000 wei
    const expected = (20_000n * 10n ** 18n) / 100_000_000n;
    expect(wei).toBe(expected);
  });

  it("maintains precision — maxPrice > minPrice for same ETH price", () => {
    const ethPrice = 1896.42;
    const min = usdToWei(0.0002, ethPrice);
    const max = usdToWei(0.02, ethPrice);
    expect(max).toBeGreaterThan(min);
    // max should be ~100x min (ratio of 0.02 / 0.0002)
    // Allow ±1 for rounding
    expect(max / min).toBe(100n);
  });

  it("scales linearly — doubling USD doubles wei", () => {
    const ethPrice = 2500;
    const single = usdToWei(0.01, ethPrice);
    const double = usdToWei(0.02, ethPrice);
    expect(double).toBe(single * 2n);
  });

  it("uses integer arithmetic to avoid float precision issues", () => {
    // 0.1 + 0.2 !== 0.3 in floats, but our micro-scaling should handle it
    const a = usdToWei(0.1, 3000);
    const b = usdToWei(0.2, 3000);
    const c = usdToWei(0.3, 3000);
    // a + b should equal c (within ±1 wei for rounding)
    const diff = a + b - c;
    expect(diff >= -1n && diff <= 1n).toBe(true);
  });
});

// ── fetchEthPriceUsd tests (mocked RPC) ─────────────────────────────────────

// Mock the viem module to intercept createPublicClient
let mockReadContract: ReturnType<typeof mock> | null = null;

function getMockReadContract(): ReturnType<typeof mock> {
  if (!mockReadContract) {
    throw new Error("mockReadContract was not initialized");
  }
  return mockReadContract;
}

mock.module("viem", () => {
  mockReadContract = mock();
  return {
    createPublicClient: () => ({
      readContract: mockReadContract,
    }),
    defineChain: (config: unknown) => config,
    http: (url: string) => url,
  };
});

// Import after mock is set up
const { fetchEthPriceUsd, resetEthPriceCache, resolveUsdOfferToWei, usdToWei } =
  await import("../../worker/boundless/pricing");

afterAll(() => {
  mock.restore();
});

describe("fetchEthPriceUsd", () => {
  beforeEach(() => {
    getMockReadContract().mockReset();
    resetEthPriceCache();
  });

  it("returns correct price from Chainlink response ($1,900)", async () => {
    // Chainlink returns 8-decimal fixed point: 190000000000 = $1,900.00
    getMockReadContract().mockResolvedValueOnce([0n, 190_000_000_000n, 0n, 0n, 0n]);
    const price = await fetchEthPriceUsd("https://rpc.example.com", 8453);
    expect(price).toBe(1900);
  });

  it("returns fractional prices ($2,456.78)", async () => {
    getMockReadContract().mockResolvedValueOnce([0n, 245_678_000_000n, 0n, 0n, 0n]);
    const price = await fetchEthPriceUsd("https://rpc.example.com", 8453);
    expect(price).toBe(2456.78);
  });

  it("works with Base Sepolia chainId", async () => {
    getMockReadContract().mockResolvedValueOnce([0n, 200_000_000_000n, 0n, 0n, 0n]);
    const price = await fetchEthPriceUsd("https://rpc.example.com", 84532);
    expect(price).toBe(2000);
  });

  it("works with Ethereum Sepolia chainId", async () => {
    getMockReadContract().mockResolvedValueOnce([0n, 150_000_000_000n, 0n, 0n, 0n]);
    const price = await fetchEthPriceUsd("https://rpc.example.com", 11155111);
    expect(price).toBe(1500);
  });

  it("throws for unsupported chainId", async () => {
    await expect(fetchEthPriceUsd("https://rpc.example.com", 999)).rejects.toThrow(
      "no Chainlink ETH/USD feed configured for chainId 999",
    );
  });

  it("throws when Chainlink returns zero price", async () => {
    getMockReadContract().mockResolvedValueOnce([0n, 0n, 0n, 0n, 0n]);
    await expect(fetchEthPriceUsd("https://rpc.example.com", 8453)).rejects.toThrow(
      "Chainlink returned invalid ETH price: 0",
    );
  });

  it("throws when Chainlink returns negative price", async () => {
    getMockReadContract().mockResolvedValueOnce([0n, -100_000_000n, 0n, 0n, 0n]);
    await expect(fetchEthPriceUsd("https://rpc.example.com", 8453)).rejects.toThrow(
      "Chainlink returned invalid ETH price",
    );
  });

  it("propagates RPC errors", async () => {
    getMockReadContract().mockRejectedValueOnce(new Error("RPC timeout"));
    await expect(fetchEthPriceUsd("https://rpc.example.com", 8453)).rejects.toThrow("RPC timeout");
  });
});

describe("resolveUsdOfferToWei", () => {
  beforeEach(() => {
    getMockReadContract().mockReset();
    resetEthPriceCache();
  });

  it("skips ETH price lookup when both offer prices are zero", async () => {
    const result = await resolveUsdOfferToWei({
      rpcUrl: "https://rpc.example.com",
      chainId: 8453,
      minPriceUsd: 0,
      maxPriceUsd: 0,
    });

    expect(result).toEqual({
      ethPriceUsd: null,
      minPriceWei: 0n,
      maxPriceWei: 0n,
    });
    expect(getMockReadContract()).not.toHaveBeenCalled();
  });

  it("only converts non-zero offer legs", async () => {
    getMockReadContract().mockResolvedValueOnce([0n, 190_000_000_000n, 0n, 0n, 0n]);

    const result = await resolveUsdOfferToWei({
      rpcUrl: "https://rpc.example.com",
      chainId: 8453,
      minPriceUsd: 0,
      maxPriceUsd: 0.1,
    });

    expect(result.ethPriceUsd).toBe(1900);
    expect(result.minPriceWei).toBe(0n);
    expect(result.maxPriceWei).toBe(usdToWei(0.1, 1900));
    expect(getMockReadContract()).toHaveBeenCalledTimes(1);
  });
});

// ── resolveBoundlessConfig tests (USD pricing fields) ───────────────────────

import { resolveBoundlessConfig } from "../../worker/boundless/config";
import type { WorkerEnv } from "../../worker/env";

function makeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    BOUNDLESS_RPC_URL: "https://base-mainnet.public.blastapi.io",
    BOUNDLESS_PRIVATE_KEY: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    BOUNDLESS_IMAGE_URL: "https://gateway.pinata.cloud/ipfs/QmTest",
    BOUNDLESS_IMAGE_ID: "0x37dfd7b9ca6490f5db1e9cd4dfa5ceadae573e44c6fd351e9cdc2cb7138b8111",
    ...overrides,
  } as WorkerEnv;
}

function expectBoundlessConfig(overrides: Partial<WorkerEnv> = {}) {
  const config = resolveBoundlessConfig(makeEnv(overrides));
  expect(config).not.toBeNull();
  if (!config) {
    throw new Error("expected boundless config");
  }
  return config;
}

describe("resolveBoundlessConfig", () => {
  it("returns null when required vars are missing", () => {
    expect(resolveBoundlessConfig(makeEnv({ BOUNDLESS_RPC_URL: "" }))).toBeNull();
    expect(resolveBoundlessConfig(makeEnv({ BOUNDLESS_PRIVATE_KEY: undefined }))).toBeNull();
    expect(resolveBoundlessConfig(makeEnv({ BOUNDLESS_IMAGE_URL: "" }))).toBeNull();
    expect(resolveBoundlessConfig(makeEnv({ BOUNDLESS_IMAGE_ID: undefined }))).toBeNull();
  });

  it("returns config with updated default pricing and collateral", () => {
    const config = expectBoundlessConfig();
    expect(config.maxPriceUsd).toBe(0.1);
    expect(config.minPriceUsd).toBe(0);
    expect(config.lockCollateralBaseUnits).toBe(5n * 10n ** 18n);
    expect(config.topUpBufferBps).toBe(1500);
  });

  it("reads custom pricing, collateral, and buffer from env vars", () => {
    const config = expectBoundlessConfig({
      BOUNDLESS_MAX_PRICE_USD: "0.05",
      BOUNDLESS_MIN_PRICE_USD: "0",
      BOUNDLESS_LOCK_COLLATERAL_ZKC: "7",
      BOUNDLESS_TOP_UP_BUFFER_BPS: "350",
    });
    expect(config.maxPriceUsd).toBe(0.05);
    expect(config.minPriceUsd).toBe(0);
    expect(config.lockCollateralBaseUnits).toBe(7n * 10n ** 18n);
    expect(config.topUpBufferBps).toBe(350);
  });

  it("defaults to Base Mainnet auction timing", () => {
    const config = expectBoundlessConfig();
    expect(config.flatPeriodSec).toBe(60); // 1 min
    expect(config.rampPeriodSec).toBe(660); // 11 min
    expect(config.lockTimeoutSec).toBe(1740); // 29 min
    expect(config.timeoutSec).toBe(3540); // 59 min
  });

  it("defaults to Base Mainnet chain config", () => {
    const config = expectBoundlessConfig();
    expect(config.chainId).toBe(8453n);
    expect(config.marketAddress).toBe("0xfd152dadc5183870710fe54f939eae3ab9f0fe82");
    expect(config.orderStreamUrl).toBe("https://base-mainnet.boundless.network");
  });

  it("normalizes private key with 0x prefix", () => {
    const config = expectBoundlessConfig({
      BOUNDLESS_PRIVATE_KEY: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });
    expect(config.privateKey.startsWith("0x")).toBe(true);
  });

  it("normalizes image ID with 0x prefix", () => {
    const config = expectBoundlessConfig({
      BOUNDLESS_IMAGE_ID: "37dfd7b9ca6490f5db1e9cd4dfa5ceadae573e44c6fd351e9cdc2cb7138b8111",
    });
    expect(config.imageId.startsWith("0x")).toBe(true);
  });
});

// ── Integration: usdToWei with realistic config values ──────────────────────

describe("usdToWei integration with config defaults", () => {
  it("produces reasonable wei values for default config at current ETH prices", () => {
    const ethPrices = [1500, 1900, 2500, 5000, 10000];
    for (const ethPrice of ethPrices) {
      const maxWei = usdToWei(0.1, ethPrice);
      const minWei = 0n;

      // Max should always be positive
      expect(maxWei).toBeGreaterThan(0n);
      expect(minWei).toBe(0n);
      expect(maxWei).toBeGreaterThan(minWei);
      // Max should be less than 1 ETH (sanity check: $0.10 << 1 ETH)
      expect(maxWei).toBeLessThan(10n ** 18n);
      expect(minWei).toBeLessThan(maxWei);
    }
  });
});
