import { describe, expect, it } from "bun:test";
import { resolveDirectClaimConfig, isDirectClaimConfigured } from "../../worker/claim/direct";
import type { WorkerEnv } from "../../worker/env";

function makeEnv(overrides: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    SCORE_CONTRACT_ID: "CABC123",
    RELAYER_URL: "https://channels.openzeppelin.com/relay",
    RELAYER_API_KEY: "test-api-key",
    ...overrides,
  } as WorkerEnv;
}

function expectDirectClaimConfig(overrides: Partial<WorkerEnv> = {}) {
  const config = resolveDirectClaimConfig(makeEnv(overrides));
  expect(config).not.toBeNull();
  if (!config) {
    throw new Error("expected direct claim config");
  }
  return config;
}

describe("resolveDirectClaimConfig", () => {
  it("returns config when all vars are set (managed channels)", () => {
    const config = expectDirectClaimConfig();
    expect(config.scoreContractId).toBe("CABC123");
  });

  it("returns null when SCORE_CONTRACT_ID is missing", () => {
    expect(resolveDirectClaimConfig(makeEnv({ SCORE_CONTRACT_ID: "" }))).toBeNull();
    expect(resolveDirectClaimConfig(makeEnv({ SCORE_CONTRACT_ID: undefined }))).toBeNull();
  });

  it("returns null when RELAYER_URL is missing", () => {
    expect(resolveDirectClaimConfig(makeEnv({ RELAYER_URL: "" }))).toBeNull();
    expect(resolveDirectClaimConfig(makeEnv({ RELAYER_URL: undefined }))).toBeNull();
  });

  it("returns null when RELAYER_API_KEY is missing", () => {
    expect(resolveDirectClaimConfig(makeEnv({ RELAYER_API_KEY: "" }))).toBeNull();
    expect(resolveDirectClaimConfig(makeEnv({ RELAYER_API_KEY: undefined }))).toBeNull();
  });

  it("works without pluginId for managed channels hostname", () => {
    const config = resolveDirectClaimConfig(
      makeEnv({
        RELAYER_URL: "https://channels.openzeppelin.com/relay",
        RELAYER_PLUGIN_ID: undefined,
      }),
    );
    expect(config).not.toBeNull();
  });

  it("returns null for custom relayer without pluginId", () => {
    const config = resolveDirectClaimConfig(
      makeEnv({
        RELAYER_URL: "https://custom-relay.example.com/relay",
        RELAYER_PLUGIN_ID: undefined,
      }),
    );
    expect(config).toBeNull();
  });

  it("returns config for custom relayer with pluginId", () => {
    const config = resolveDirectClaimConfig(
      makeEnv({
        RELAYER_URL: "https://custom-relay.example.com/relay",
        RELAYER_PLUGIN_ID: "my-plugin",
      }),
    );
    expect(config).not.toBeNull();
  });

  it("returns null for invalid URL", () => {
    const config = resolveDirectClaimConfig(makeEnv({ RELAYER_URL: "not a url" }));
    expect(config).toBeNull();
  });
});

describe("isDirectClaimConfigured", () => {
  it("returns true when configured", () => {
    expect(isDirectClaimConfigured(makeEnv())).toBe(true);
  });

  it("returns false when not configured", () => {
    expect(isDirectClaimConfigured(makeEnv({ SCORE_CONTRACT_ID: "" }))).toBe(false);
  });
});
