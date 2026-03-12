import { Address, Asset, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Client as ScoreClient } from "asteroids-score";
import { DEFAULT_RPC_URL, TESTNET_NETWORK_PASSPHRASE } from "../consts";

export interface TokenBalanceInput {
  walletAddress: string;
  scoreContractId?: string | null;
  tokenContractId?: string | null;
}

export interface TokenBalanceResult {
  tokenContractId: string;
  balance: bigint;
}

function nonEmptyEnv(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function getEnvValue(key: keyof ImportMetaEnv): string | undefined {
  const value = import.meta.env[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  return undefined;
}

export function getScoreContractIdFromEnv(): string | null {
  return nonEmptyEnv(import.meta.env.VITE_SCORE_CONTRACT_ID);
}

export function getTokenContractIdFromEnv(): string | null {
  return nonEmptyEnv(import.meta.env.VITE_TOKEN_CONTRACT_ID);
}

function resolveRpcConfig(): { rpcUrl: string; networkPassphrase: string } {
  return {
    rpcUrl: getEnvValue("VITE_RPC_URL") ?? DEFAULT_RPC_URL,
    networkPassphrase: getEnvValue("VITE_NETWORK_PASSPHRASE") ?? TESTNET_NETWORK_PASSPHRASE,
  };
}

export function parseSacAssetFromName(name: string): Asset {
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

  try {
    return new Asset(code, issuer);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid stellar asset name "${name}": ${detail}`, {
      cause: error,
    });
  }
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

async function resolveSacAssetFromContractId(
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

async function resolveTokenContractId(scoreContractId: string): Promise<string> {
  const config = resolveRpcConfig();

  const scoreClient = new ScoreClient({
    contractId: scoreContractId,
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
  });

  const tx = await scoreClient.token_id();
  return tx.result;
}

export async function readTokenBalance(input: TokenBalanceInput): Promise<TokenBalanceResult> {
  const tokenContractId =
    input.tokenContractId?.trim() ||
    (input.scoreContractId ? await resolveTokenContractId(input.scoreContractId) : "");
  if (!tokenContractId) {
    throw new Error(
      "token contract is not configured; set VITE_TOKEN_CONTRACT_ID or VITE_SCORE_CONTRACT_ID",
    );
  }

  const config = resolveRpcConfig();
  const server = new rpc.Server(config.rpcUrl);
  const holderAddress = Address.fromString(input.walletAddress).toString();
  const asset = await resolveSacAssetFromContractId(server, tokenContractId);
  const balance = await server.getAssetBalance(holderAddress, asset, config.networkPassphrase);

  return {
    tokenContractId,
    balance: balance.balanceEntry?.amount ? BigInt(balance.balanceEntry.amount) : 0n,
  };
}
