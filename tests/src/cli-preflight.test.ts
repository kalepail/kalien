import { beforeEach, describe, expect, it, mock } from "bun:test";

const SAMPLE_G = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEGWF";
const SAMPLE_C = "CDPAHIOTDASW6WULHAJ5UL4H6YH7OJ2T72LKVT75SCFDZ4YZTOVDFEQX";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const TESTNET_CONTRACT = "CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU";
const TESTNET_TOKEN_CONTRACT = "CBUCDXT6BY3WWP764AMW66QJA6ZRWL2TRV6VTYCWPZF4FUZRAXK2S253";
const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_API = "https://testnet.kalien.xyz";
const KALIEN_ISSUER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

type GetAccountFn = (address: string) => Promise<unknown>;
type GetContractDataFn = (contractId: string, key: unknown) => Promise<unknown>;
type GetAssetBalanceFn = (
  address: string,
  asset: { getCode(): string; getIssuer(): string },
  networkPassphrase: string,
) => Promise<{ balanceEntry?: unknown }>;
type BestScoreFn = (args: { claimant: string; seed_id: number }) => Promise<{ result: number }>;
type TokenIdFn = () => Promise<{ result: string }>;
type FetchSeedByIdFn = (
  contractId: string,
  rpcUrl: string,
  seedId: number,
) => Promise<number | null>;

let getAccountImpl: GetAccountFn = async () => undefined;
let getContractDataImpl: GetContractDataFn = async () => ({
  val: {
    contractData: () => ({
      val: () => ({
        instance: () => ({
          executable: () => ({
            switch: () => ({ name: "contractExecutableStellarAsset" }),
          }),
          storage: () => [
            {
              key: () => ({ __native: "METADATA" }),
              val: () => ({ __native: { name: `KALIEN:${KALIEN_ISSUER}` } }),
            },
          ],
        }),
      }),
    }),
  },
});
let getAssetBalanceImpl: GetAssetBalanceFn = async () => ({ balanceEntry: {} });
let bestScoreImpl: BestScoreFn = async () => ({ result: 0 });
let tokenIdImpl: TokenIdFn = async () => ({ result: TESTNET_TOKEN_CONTRACT });
let fetchSeedByIdImpl: FetchSeedByIdFn = async () => 1234;

mock.module("@stellar/stellar-sdk", () => ({
  Asset: class MockAsset {
    code: string;
    issuer: string;

    constructor(code: string, issuer: string) {
      this.code = code;
      this.issuer = issuer;
    }

    static native(): { getCode(): string; getIssuer(): string } {
      return {
        getCode: () => "XLM",
        getIssuer: () => "",
      };
    }

    getCode(): string {
      return this.code;
    }

    getIssuer(): string {
      return this.issuer;
    }
  },
  rpc: {
    Server: class MockRpcServer {
      getAccount(address: string): Promise<unknown> {
        return getAccountImpl(address);
      }

      getContractData(contractId: string, key: unknown): Promise<unknown> {
        return getContractDataImpl(contractId, key);
      }

      getAssetBalance(
        address: string,
        asset: { getCode(): string; getIssuer(): string },
        networkPassphrase: string,
      ): Promise<{ balanceEntry?: unknown }> {
        return getAssetBalanceImpl(address, asset, networkPassphrase);
      }
    },
  },
  scValToNative: (value: { __native: unknown }): unknown => value.__native,
  xdr: {
    ScVal: {
      scvLedgerKeyContractInstance: (): { __ledger_key_contract_instance: true } => ({
        __ledger_key_contract_instance: true,
      }),
    },
  },
}));

mock.module("../../shared/stellar/strkey", () => ({
  parseClaimantStrKeyFromUserInput: (
    value: string,
  ): { normalized: string; type: "account" | "contract" } => {
    const normalized = value.trim().toUpperCase();
    if (normalized.startsWith("G")) {
      return { normalized, type: "account" };
    }
    if (normalized.startsWith("C")) {
      return { normalized, type: "contract" };
    }
    throw new Error("claimant address must be a valid Stellar G... or C... address");
  },
}));

mock.module("asteroids-score", () => ({
  Client: class MockScoreClient {
    best_score(args: { claimant: string; seed_id: number }): Promise<{ result: number }> {
      return bestScoreImpl(args);
    }

    token_id(): Promise<{ result: string }> {
      return tokenIdImpl();
    }
  },
}));

mock.module("@/chain/seed", () => ({
  SEED_INTERVAL_SECONDS: 600,
  fetchSeedById: (contractId: string, rpcUrl: string, seedId: number): Promise<number | null> =>
    fetchSeedByIdImpl(contractId, rpcUrl, seedId),
}));

const { runCliPreflight } = await import("../../cli/src/preflight.ts?test=preflight");
const originalFetch = globalThis.fetch;

beforeEach(() => {
  getAccountImpl = async () => undefined;
  getContractDataImpl = async (contractId: string) => {
    if (
      contractId === TESTNET_CONTRACT ||
      contractId === TESTNET_TOKEN_CONTRACT ||
      contractId === SAMPLE_C
    ) {
      return {
        val: {
          contractData: () => ({
            val: () => ({
              instance: () => ({
                executable: () => ({
                  switch: () => ({ name: "contractExecutableStellarAsset" }),
                }),
                storage: () => [
                  {
                    key: () => ({ __native: "METADATA" }),
                    val: () => ({ __native: { name: `KALIEN:${KALIEN_ISSUER}` } }),
                  },
                ],
              }),
            }),
          }),
        },
      };
    }
    throw new Error("404 entry not found");
  };
  getAssetBalanceImpl = async () => ({ balanceEntry: {} });
  bestScoreImpl = async () => ({ result: 0 });
  tokenIdImpl = async () => ({ result: TESTNET_TOKEN_CONTRACT });
  fetchSeedByIdImpl = async () => 1234;
  globalThis.fetch = originalFetch;
});

describe("runCliPreflight", () => {
  it("passes for aligned network, API, RPC, and contract settings", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/api/seed/current")) {
        return new Response(
          JSON.stringify({
            success: true,
            seed_id: 200,
            seed: 1234,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const result = await runCliPreflight({
      network: "testnet",
      networkPassphrase: TESTNET_PASSPHRASE,
      address: SAMPLE_G,
      apiUrl: TESTNET_API,
      rpcUrl: TESTNET_RPC,
      contractId: TESTNET_CONTRACT,
      tokenContractId: TESTNET_TOKEN_CONTRACT,
    });

    expect(result).toEqual({ warnings: [] });
  });

  it("throws a clear error when a G-address account is missing on the selected network", async () => {
    getAccountImpl = async () => {
      throw new Error("404 account not found");
    };

    await expect(
      runCliPreflight({
        network: "testnet",
        networkPassphrase: TESTNET_PASSPHRASE,
        address: SAMPLE_G,
        apiUrl: TESTNET_API,
        rpcUrl: TESTNET_RPC,
        contractId: TESTNET_CONTRACT,
        tokenContractId: TESTNET_TOKEN_CONTRACT,
      }),
    ).rejects.toThrow("does not exist on testnet");
  });

  it("throws a clear error when the score contract is not readable on the selected network", async () => {
    bestScoreImpl = async () => {
      throw new Error("simulation failed");
    };

    await expect(
      runCliPreflight({
        network: "testnet",
        networkPassphrase: TESTNET_PASSPHRASE,
        address: SAMPLE_G,
        apiUrl: TESTNET_API,
        rpcUrl: TESTNET_RPC,
        contractId: TESTNET_CONTRACT,
        tokenContractId: TESTNET_TOKEN_CONTRACT,
      }),
    ).rejects.toThrow("cannot read score contract");
  });

  it("throws before run when API seed does not match RPC seed for the same seed_id", async () => {
    fetchSeedByIdImpl = async () => 777;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/api/seed/current")) {
        return new Response(
          JSON.stringify({
            success: true,
            seed_id: 201,
            seed: 888,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    await expect(
      runCliPreflight({
        network: "testnet",
        networkPassphrase: TESTNET_PASSPHRASE,
        address: SAMPLE_G,
        apiUrl: TESTNET_API,
        rpcUrl: TESTNET_RPC,
        contractId: TESTNET_CONTRACT,
        tokenContractId: TESTNET_TOKEN_CONTRACT,
      }),
    ).rejects.toThrow("network mismatch detected before run");
  });

  it("returns a warning for suspicious network/api pairing while still passing if data aligns", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/api/seed/current")) {
        return new Response(
          JSON.stringify({
            success: true,
            seed_id: 202,
            seed: 1234,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as typeof fetch;

    const result = await runCliPreflight({
      network: "testnet",
      networkPassphrase: TESTNET_PASSPHRASE,
      address: SAMPLE_G,
      apiUrl: "https://kalien.xyz",
      rpcUrl: TESTNET_RPC,
      contractId: TESTNET_CONTRACT,
      tokenContractId: TESTNET_TOKEN_CONTRACT,
    });

    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("--network testnet");
  });

  it("throws a clear error when a C-address claimant contract is missing on the selected network", async () => {
    await expect(
      runCliPreflight({
        network: "testnet",
        networkPassphrase: TESTNET_PASSPHRASE,
        address: "CC5HARVVAA7QWAIYOZHWV57KO2Z7XJ6TRXZECNUCDYH53TSUZAXK36DS",
        apiUrl: TESTNET_API,
        rpcUrl: TESTNET_RPC,
        contractId: TESTNET_CONTRACT,
        tokenContractId: TESTNET_TOKEN_CONTRACT,
      }),
    ).rejects.toThrow("claimant contract");
  });

  it("throws a clear error when the claimant account is missing the KALIEN trustline", async () => {
    getAssetBalanceImpl = async () => {
      throw new Error("trustline not found for asset");
    };

    await expect(
      runCliPreflight({
        network: "testnet",
        networkPassphrase: TESTNET_PASSPHRASE,
        address: SAMPLE_G,
        apiUrl: TESTNET_API,
        rpcUrl: TESTNET_RPC,
        contractId: TESTNET_CONTRACT,
        tokenContractId: TESTNET_TOKEN_CONTRACT,
      }),
    ).rejects.toThrow("does not have the required trustline");
  });

  it("throws a clear error when on-chain token contract does not exist on selected network", async () => {
    tokenIdImpl = async () => ({
      // valid contract StrKey, but not deployed on testnet
      result: "CC5HARVVAA7QWAIYOZHWV57KO2Z7XJ6TRXZECNUCDYH53TSUZAXK36DS",
    });

    await expect(
      runCliPreflight({
        network: "testnet",
        networkPassphrase: TESTNET_PASSPHRASE,
        address: SAMPLE_G,
        apiUrl: TESTNET_API,
        rpcUrl: TESTNET_RPC,
        contractId: TESTNET_CONTRACT,
        tokenContractId: TESTNET_TOKEN_CONTRACT,
      }),
    ).rejects.toThrow("token contract");
  });
});
