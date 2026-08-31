import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { Client as ScoreClient } from "asteroids-score";

export const SEED_INTERVAL_SECONDS = 600; // 10 minutes
const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const SEED_FETCH_TIMEOUT_MS = 6_000;

export interface SeedContext {
  seedId: number;
  seed: number | null;
}

type SeedReadResult =
  | { status: "found"; seed: number }
  | { status: "missing" }
  | { status: "unavailable" };

function resolveNetworkPassphrase(): string {
  const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return viteEnv?.VITE_NETWORK_PASSPHRASE ?? TESTNET_NETWORK_PASSPHRASE;
}

/**
 * Read the materialized seed for a specific `seed_id` by directly reading
 * the `SeedById(seed_id)` ledger entry from the contract's temporary storage.
 *
 * A successful empty response means the seed is missing. Transport, shape,
 * and decode failures remain unavailable so callers cannot mistake them for
 * confirmed absence.
 */
async function readSeedById(
  contractId: string,
  rpcUrl: string,
  seedId: number,
): Promise<SeedReadResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEED_FETCH_TIMEOUT_MS);
  try {
    const contractAddress = Address.fromString(contractId).toScAddress();
    const keyVal = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("SeedById"), xdr.ScVal.scvU32(seedId)]);
    const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contractAddress,
        key: keyVal,
        durability: xdr.ContractDataDurability.temporary(),
      }),
    );
    const keyXdr = ledgerKey.toXDR("base64");

    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getLedgerEntries",
        params: { keys: [keyXdr] },
      }),
      signal: controller.signal,
    });

    if (!response.ok) return { status: "unavailable" };

    const payload = (await response.json()) as Record<string, unknown>;
    const result = payload.result;
    if (!result || typeof result !== "object") return { status: "unavailable" };

    const entries = (result as Record<string, unknown>).entries;
    if (!Array.isArray(entries)) return { status: "unavailable" };
    if (entries.length === 0) return { status: "missing" };

    const first = entries[0] as Record<string, unknown> | undefined;
    if (!first || typeof first.xdr !== "string") return { status: "unavailable" };

    const entry = xdr.LedgerEntryData.fromXDR(first.xdr as string, "base64");
    if (entry.switch().value !== xdr.LedgerEntryType.contractData().value) {
      return { status: "unavailable" };
    }

    const value = entry.contractData().val();
    if (value.switch().value !== xdr.ScValType.scvU32().value) {
      return { status: "unavailable" };
    }

    return { status: "found", seed: value.u32() >>> 0 };
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read one materialized seed while preserving the existing nullable API.
 * The current-context path uses the detailed result above so a temporary RPC
 * failure cannot clear a previously confirmed seed.
 */
export async function fetchSeedById(
  contractId: string,
  rpcUrl: string,
  seedId: number,
): Promise<number | null> {
  const result = await readSeedById(contractId, rpcUrl, seedId);
  return result.status === "found" ? result.seed : null;
}

/**
 * Resolve the chain-authoritative current `seed_id`, then read only the exact
 * materialized seed stored for that id.
 *
 * `current_seed()` is simulated only to obtain the ledger-time-derived id. Its
 * speculative PRNG value is never trusted when storage has not been written.
 */
export async function fetchSeedContextFromContract(
  contractId: string,
  rpcUrl: string,
  networkPassphrase = resolveNetworkPassphrase(),
): Promise<SeedContext | null> {
  try {
    const server = new rpc.Server(rpcUrl, {
      allowHttp: rpcUrl.startsWith("http:"),
    });
    server.httpClient.defaults.timeout = SEED_FETCH_TIMEOUT_MS;
    const client = new ScoreClient({
      contractId,
      rpcUrl,
      networkPassphrase,
      server,
    });
    const tx = await client.current_seed();
    const seedId = tx.result.seed_id >>> 0;
    const seedRead = await readSeedById(contractId, rpcUrl, seedId);
    if (seedRead.status === "unavailable") return null;
    return { seedId, seed: seedRead.status === "found" ? seedRead.seed : null };
  } catch {
    return null;
  }
}

/**
 * Read the materialized seed for the chain-authoritative current seed window.
 *
 * Returns `null` when the seed has not been materialized on-chain yet
 * (callers should retry or trigger materialization via the relayer).
 */
export async function fetchSeedFromContract(
  contractId: string,
  rpcUrl: string,
  networkPassphrase = resolveNetworkPassphrase(),
): Promise<number | null> {
  const context = await fetchSeedContextFromContract(contractId, rpcUrl, networkPassphrase);
  return context?.seed ?? null;
}

/**
 * Read a claimant's best score for a specific seed_id from the contract.
 *
 * Returns `null` when the query fails. A successful read may still return `0`
 * when no prior score exists for that seed.
 */
export async function fetchBestScoreForSeed(
  contractId: string,
  rpcUrl: string,
  claimant: string,
  seedId: number,
): Promise<number | null> {
  try {
    const client = new ScoreClient({
      contractId,
      rpcUrl,
      networkPassphrase: resolveNetworkPassphrase(),
    });
    const tx = await client.best_score({ claimant, seed_id: seedId });
    return tx.result;
  } catch {
    return null;
  }
}
