import { Asset, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Client as ScoreClient } from "asteroids-score";
import { fetchSeedById, SEED_INTERVAL_SECONDS } from "@/chain/seed";
import { parseClaimantStrKeyFromUserInput } from "../../shared/stellar/strkey";
import type { NetworkName } from "./constants";

const API_CHECK_TIMEOUT_MS = 8_000;

interface SeedApiResponse {
  success: boolean;
  error?: string;
  seed_id?: number;
  seed?: number | null;
}

export interface CliPreflightOptions {
  network: NetworkName;
  networkPassphrase: string;
  address: string;
  apiUrl: string;
  rpcUrl: string;
  contractId: string;
  tokenContractId: string;
}

export interface CliPreflightResult {
  warnings: string[];
}

function safeErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message?: unknown }).message === "string"
  ) {
    const message = (error as { message: string }).message.trim();
    if (message.length > 0) {
      return message;
    }
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  if (error && typeof error === "object") {
    try {
      const serialized = JSON.stringify(error);
      if (typeof serialized === "string" && serialized.length > 0) {
        return serialized;
      }
    } catch {}
  }
  return String(error);
}

function normalizedBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function currentSeedId(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / SEED_INTERVAL_SECONDS) >>> 0;
}

function parseSeedApiResponse(payload: unknown): SeedApiResponse | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const obj = payload as Record<string, unknown>;
  return {
    success: obj.success === true,
    error: typeof obj.error === "string" ? obj.error : undefined,
    seed_id: typeof obj.seed_id === "number" ? obj.seed_id : undefined,
    seed:
      typeof obj.seed === "number" || obj.seed === null ? (obj.seed as number | null) : undefined,
  };
}

async function readSeedEndpoint(
  apiUrl: string,
  path: "/api/seed/current" | "/api/seed/refresh",
  method: "GET" | "POST",
): Promise<SeedApiResponse> {
  const url = `${normalizedBaseUrl(apiUrl)}${path}`;
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(API_CHECK_TIMEOUT_MS),
  });

  const rawPayload = (await response.json().catch(() => null)) as unknown;
  const payload = parseSeedApiResponse(rawPayload);
  if (!response.ok) {
    const detail = payload?.error ? `: ${payload.error}` : "";
    throw new Error(`${method} ${path} failed with HTTP ${response.status}${detail}`);
  }

  if (!payload || payload.success !== true) {
    const detail = payload?.error ? `: ${payload.error}` : "";
    throw new Error(`${method} ${path} returned an invalid response${detail}`);
  }

  return payload;
}

function parseSacAssetFromName(name: string): Asset {
  const normalized = name.trim();
  if (normalized === "native") {
    return Asset.native();
  }

  const separator = normalized.indexOf(":");
  const missingParts =
    separator <= 0 ||
    separator >= normalized.length - 1 ||
    normalized.indexOf(":", separator + 1) >= 0;
  if (missingParts) {
    throw new Error(`invalid stellar asset name "${name}"`);
  }

  const code = normalized.slice(0, separator);
  const issuer = normalized.slice(separator + 1);
  return new Asset(code, issuer);
}

function extractSacMetadataName(storage: xdr.ScMapEntry[] | null | undefined): string {
  if (!storage || storage.length === 0) {
    throw new Error("stellar asset contract instance storage is empty");
  }

  for (const entry of storage) {
    const key = scValToNative(entry.key());
    if (key !== "METADATA") {
      continue;
    }

    const value = scValToNative(entry.val());
    if (!value || typeof value !== "object") {
      throw new Error("stellar asset metadata has unexpected shape");
    }

    const name = (value as Record<string, unknown>).name;
    if (typeof name !== "string" || name.trim().length === 0) {
      throw new Error("stellar asset metadata is missing name");
    }

    return name;
  }

  throw new Error("stellar asset metadata entry is missing");
}

async function resolveSacAssetFromTokenContract(
  server: rpc.Server,
  tokenContractId: string,
): Promise<Asset> {
  const instanceEntry = await server.getContractData(
    tokenContractId,
    xdr.ScVal.scvLedgerKeyContractInstance(),
  );
  const instance = instanceEntry.val.contractData().val().instance();
  const executableKind = instance.executable().switch().name;
  if (executableKind !== "contractExecutableStellarAsset") {
    throw new Error(
      `token contract ${tokenContractId} is not a Stellar Asset Contract (${executableKind})`,
    );
  }

  return parseSacAssetFromName(extractSacMetadataName(instance.storage()));
}

async function resolveTokenContractIdFromScoreContract(opts: CliPreflightOptions): Promise<string> {
  const client = new ScoreClient({
    contractId: opts.contractId,
    rpcUrl: opts.rpcUrl,
    networkPassphrase: opts.networkPassphrase,
  });

  try {
    const tx = await client.token_id();
    const tokenId = tx.result.trim().toUpperCase();
    if (!/^C[A-Z2-7]{55}$/.test(tokenId)) {
      throw new Error(`invalid token_id returned: ${tx.result}`);
    }
    return tokenId;
  } catch (error) {
    const detail = safeErrorMessage(error);
    throw new Error(
      `cannot read token_id from score contract ${opts.contractId} on ${opts.network} (${opts.rpcUrl}): ${detail}. ` +
        `Check --network/--rpc-url/--contract-id alignment.`,
      { cause: error },
    );
  }
}

async function assertContractExistsOnNetwork(
  contractId: string,
  rpcUrl: string,
  network: NetworkName,
  label: "claimant contract" | "token contract",
): Promise<void> {
  const server = new rpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith("http:"),
  });
  try {
    await server.getContractData(contractId, xdr.ScVal.scvLedgerKeyContractInstance());
  } catch (error) {
    const detail = safeErrorMessage(error);
    if (/not found|404|entry not found|unknown|does not exist|missing/i.test(detail)) {
      throw new Error(
        `${label} ${contractId} does not exist on ${network} (${rpcUrl}); ` +
          `use a ${network} contract ID or switch --network/--rpc-url`,
        { cause: error },
      );
    }
    throw new Error(
      `failed to verify ${label} ${contractId} on ${network} (${rpcUrl}): ${detail}`,
      { cause: error },
    );
  }
}

async function assertAccountAndTrustlineOnNetwork(
  address: string,
  rpcUrl: string,
  networkPassphrase: string,
  network: NetworkName,
  tokenContractId: string,
): Promise<void> {
  const server = new rpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith("http:"),
  });

  try {
    await server.getAccount(address);
  } catch (error) {
    const detail = safeErrorMessage(error);
    if (/not found|404|unknown|does not exist|missing/i.test(detail)) {
      throw new Error(
        `claimant account ${address} does not exist on ${network} (${rpcUrl}); ` +
          `use an account on this network or switch --network/--rpc-url`,
        { cause: error },
      );
    }
    throw new Error(
      `failed to verify claimant account ${address} on ${network} (${rpcUrl}): ${detail}`,
      { cause: error },
    );
  }

  const asset = await resolveSacAssetFromTokenContract(server, tokenContractId).catch((error) => {
    const detail = safeErrorMessage(error);
    throw new Error(
      `failed to resolve KALIEN token asset from ${tokenContractId} on ${network}: ${detail}`,
      { cause: error },
    );
  });

  try {
    const balance = await server.getAssetBalance(address, asset, networkPassphrase);
    if (!balance.balanceEntry) {
      throw new Error("trustline balance entry missing");
    }
  } catch (error) {
    const detail = safeErrorMessage(error);
    if (/trustline.*not found|not found for/i.test(detail)) {
      throw new Error(
        `account ${address} does not have the required trustline for ` +
          `${asset.getCode()}:${asset.getIssuer()} on ${network}; ` +
          `open the trustline before running`,
        { cause: error },
      );
    }
    throw new Error(`failed to verify trustline for ${address} on ${network}: ${detail}`, {
      cause: error,
    });
  }
}

async function assertClaimantExistsOnNetwork(
  address: string,
  networkPassphrase: string,
  rpcUrl: string,
  network: NetworkName,
  tokenContractId: string,
): Promise<void> {
  const parsed = parseClaimantStrKeyFromUserInput(address);

  if (parsed.type === "contract") {
    await assertContractExistsOnNetwork(parsed.normalized, rpcUrl, network, "claimant contract");
    return;
  }

  await assertAccountAndTrustlineOnNetwork(
    parsed.normalized,
    rpcUrl,
    networkPassphrase,
    network,
    tokenContractId,
  );
}

async function assertScoreContractReachable(opts: CliPreflightOptions): Promise<void> {
  const parsed = parseClaimantStrKeyFromUserInput(opts.address);
  const client = new ScoreClient({
    contractId: opts.contractId,
    rpcUrl: opts.rpcUrl,
    networkPassphrase: opts.networkPassphrase,
  });

  const seedId = currentSeedId();
  try {
    await client.best_score({
      claimant: parsed.normalized,
      seed_id: seedId,
    });
  } catch (error) {
    const detail = safeErrorMessage(error);
    throw new Error(
      `cannot read score contract ${opts.contractId} on ${opts.network} (${opts.rpcUrl}): ${detail}. ` +
        `Check --network/--rpc-url/--contract-id alignment.`,
      { cause: error },
    );
  }
}

async function assertApiSeedMatchesRpc(
  opts: CliPreflightOptions,
  warnings: string[],
): Promise<void> {
  const current = await readSeedEndpoint(opts.apiUrl, "/api/seed/current", "GET");

  let seedId = typeof current.seed_id === "number" ? current.seed_id >>> 0 : null;
  let seed = typeof current.seed === "number" ? current.seed >>> 0 : null;

  if (seedId === null || seed === null) {
    try {
      const refreshed = await readSeedEndpoint(opts.apiUrl, "/api/seed/refresh", "POST");
      seedId = typeof refreshed.seed_id === "number" ? refreshed.seed_id >>> 0 : null;
      seed = typeof refreshed.seed === "number" ? refreshed.seed >>> 0 : null;
    } catch (error) {
      warnings.push(
        `could not refresh API seed (${safeErrorMessage(error)}); skipped API/RPC seed consistency check`,
      );
      return;
    }
  }

  if (seedId === null || seed === null) {
    warnings.push("API returned no materialized seed; skipped API/RPC seed consistency check");
    return;
  }

  const rpcSeed = await fetchSeedById(opts.contractId, opts.rpcUrl, seedId);
  if (rpcSeed === null) {
    throw new Error(
      `API ${opts.apiUrl} reports seed_id=${seedId} seed=${seed}, ` +
        `but RPC ${opts.rpcUrl} has no SeedById(${seedId}) for contract ${opts.contractId}. ` +
        `This likely means API and RPC/contract are on different networks.`,
    );
  }

  if (rpcSeed !== seed) {
    throw new Error(
      `network mismatch detected before run: API ${opts.apiUrl} reports seed_id=${seedId} seed=${seed}, ` +
        `but RPC ${opts.rpcUrl} reports seed=${rpcSeed}. ` +
        `This would generate proofs for one network and submit to another.`,
    );
  }
}

export async function runCliPreflight(opts: CliPreflightOptions): Promise<CliPreflightResult> {
  const warnings: string[] = [];
  const apiUrlLower = opts.apiUrl.toLowerCase();
  if (opts.network === "testnet" && !apiUrlLower.includes("testnet")) {
    warnings.push(
      `--network testnet with API URL "${opts.apiUrl}" (does not include "testnet"); verify this is intentional`,
    );
  }
  if (opts.network === "mainnet" && apiUrlLower.includes("testnet")) {
    warnings.push(
      `--network mainnet with API URL "${opts.apiUrl}" (contains "testnet"); verify this is intentional`,
    );
  }

  const onChainTokenContractId = await resolveTokenContractIdFromScoreContract(opts);
  if (opts.tokenContractId.trim().toUpperCase() !== onChainTokenContractId) {
    warnings.push(
      `configured token contract ${opts.tokenContractId} does not match on-chain token_id ${onChainTokenContractId}; using on-chain token_id for trustline checks`,
    );
  }

  await assertContractExistsOnNetwork(
    onChainTokenContractId,
    opts.rpcUrl,
    opts.network,
    "token contract",
  );
  await assertClaimantExistsOnNetwork(
    opts.address,
    opts.networkPassphrase,
    opts.rpcUrl,
    opts.network,
    onChainTokenContractId,
  );
  await assertScoreContractReachable(opts);
  await assertApiSeedMatchesRpc(opts, warnings);

  return { warnings };
}
