import { Address, xdr } from "@stellar/stellar-sdk";
import { Client as ScoreClient } from "asteroids-score";

export const SEED_INTERVAL_SECONDS = 600; // 10 minutes
const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const SEED_FETCH_TIMEOUT_MS = 6_000;

export interface SeedContext {
  seedId: number;
  seed: number | null;
}

function resolveNetworkPassphrase(): string {
  const viteEnv = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return viteEnv?.VITE_NETWORK_PASSPHRASE ?? TESTNET_NETWORK_PASSPHRASE;
}

/**
 * Read the materialized seed for a specific `seed_id` by directly reading
 * the `SeedById(seed_id)` ledger entry from the contract's temporary storage.
 *
 * Unlike simulating `current_seed()`, this returns `null` when the seed
 * has not been materialized on-chain yet — no speculative PRNG values.
 */
export async function fetchSeedById(
  contractId: string,
  rpcUrl: string,
  seedId: number,
): Promise<number | null> {
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

    if (!response.ok) return null;

    const payload = (await response.json()) as Record<string, unknown>;
    const result = payload.result as Record<string, unknown> | undefined;
    const entries = Array.isArray(result?.entries) ? result.entries : [];
    const first = entries[0] as Record<string, unknown> | undefined;
    if (!first || typeof first.xdr !== "string") return null;

    const entry = xdr.LedgerEntryData.fromXDR(first.xdr as string, "base64");
    if (entry.switch().value !== xdr.LedgerEntryType.contractData().value) return null;

    const value = entry.contractData().val();
    if (value.switch().value !== xdr.ScValType.scvU32().value) return null;

    return value.u32() >>> 0;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
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
    const client = new ScoreClient({
      contractId,
      rpcUrl,
      networkPassphrase,
    });
    const tx = await client.current_seed();
    const seedId = tx.result.seed_id >>> 0;
    const seed = await fetchSeedById(contractId, rpcUrl, seedId);
    return { seedId, seed };
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
