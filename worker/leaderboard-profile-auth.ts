const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

export const DEFAULT_SMART_ACCOUNT_INDEXER_URL =
  "https://smart-account-indexer.sdf-ecosystem.workers.dev";
export const DEFAULT_SMART_ACCOUNT_INDEXER_TIMEOUT_MS = 10_000;

import { Client } from "smart-account-kit-bindings";

export class LeaderboardCredentialBindingError extends Error {
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    message: string,
    { retryable, statusCode }: { retryable: boolean; statusCode: number },
  ) {
    super(message);
    this.name = "LeaderboardCredentialBindingError";
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

function decodeBase64UrlString(value: string): Uint8Array {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("value must be a non-empty base64url string");
  }
  if (!BASE64URL_PATTERN.test(normalized)) {
    throw new Error("value must be base64url-encoded");
  }

  const padded =
    normalized.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (normalized.length % 4)) % 4);

  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("value must be a valid base64url string");
  }

  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index) & 0xff;
  }
  return output;
}

export function base64UrlToHex(value: string): string {
  const bytes = decodeBase64UrlString(value);
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

function normalizeIndexerBaseUrl(rawBaseUrl: string | null | undefined): string {
  const baseUrl = rawBaseUrl?.trim() ?? "";
  if (baseUrl.length === 0) {
    return DEFAULT_SMART_ACCOUNT_INDEXER_URL;
  }
  return baseUrl.replace(/\/+$/u, "");
}

export async function fetchIndexedContractsForCredential({
  credentialIdBase64Url,
  baseUrl,
  timeoutMs = DEFAULT_SMART_ACCOUNT_INDEXER_TIMEOUT_MS,
  fetchImpl = fetch,
}: {
  credentialIdBase64Url: string;
  baseUrl?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const credentialIdHex = base64UrlToHex(credentialIdBase64Url);
  const resolvedBaseUrl = normalizeIndexerBaseUrl(baseUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));

  try {
    const response = await fetchImpl(`${resolvedBaseUrl}/api/lookup/${credentialIdHex}`, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
      signal: controller.signal,
    });

    if (response.status === 404) {
      return [];
    }
    if (!response.ok) {
      throw new LeaderboardCredentialBindingError(`indexer lookup failed (${response.status})`, {
        retryable: response.status >= 500 || response.status === 429,
        statusCode: 503,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LeaderboardCredentialBindingError("indexer returned malformed JSON", {
        retryable: true,
        statusCode: 503,
      });
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new LeaderboardCredentialBindingError("indexer returned unexpected payload", {
        retryable: true,
        statusCode: 503,
      });
    }

    const contractsRaw = (payload as Record<string, unknown>).contracts;
    if (!Array.isArray(contractsRaw)) {
      throw new LeaderboardCredentialBindingError("indexer payload missing contracts array", {
        retryable: true,
        statusCode: 503,
      });
    }

    const contracts: string[] = [];
    for (const contract of contractsRaw) {
      if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
        continue;
      }
      const contractId = (contract as Record<string, unknown>).contract_id;
      if (typeof contractId === "string" && contractId.length > 0) {
        contracts.push(contractId);
      }
    }
    return contracts;
  } catch (error) {
    if (error instanceof LeaderboardCredentialBindingError) {
      throw error;
    }

    if (error instanceof DOMException && error.name === "AbortError") {
      throw new LeaderboardCredentialBindingError("indexer lookup timed out", {
        retryable: true,
        statusCode: 503,
      });
    }
    throw new LeaderboardCredentialBindingError(
      `indexer lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        retryable: true,
        statusCode: 503,
      },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function encodeRawP256PublicKeyBase64UrlToCose(rawPublicKeyBase64Url: string): Uint8Array {
  const raw = decodeBase64UrlString(rawPublicKeyBase64Url);
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error("expected 65-byte uncompressed P-256 public key (0x04 || x || y)");
  }
  const x = raw.slice(1, 33);
  const y = raw.slice(33, 65);

  // COSE_Key for EC2/P-256/ES256: {1: 2, 3: -7, -1: 1, -2: x, -3: y}
  const cose = new Uint8Array(77);
  let offset = 0;
  cose[offset++] = 0xa5; // map(5)
  cose[offset++] = 0x01; // unsigned(1) - kty
  cose[offset++] = 0x02; // unsigned(2) - EC2
  cose[offset++] = 0x03; // unsigned(3) - alg
  cose[offset++] = 0x26; // negative(6) = -7 - ES256
  cose[offset++] = 0x20; // negative(0) = -1 - crv
  cose[offset++] = 0x01; // unsigned(1) - P-256
  cose[offset++] = 0x21; // negative(1) = -2 - x coordinate
  cose[offset++] = 0x58; // bstr header
  cose[offset++] = 0x20; // 32 bytes
  cose.set(x, offset);
  offset += 32;
  cose[offset++] = 0x22; // negative(2) = -3 - y coordinate
  cose[offset++] = 0x58; // bstr header
  cose[offset++] = 0x20; // 32 bytes
  cose.set(y, offset);
  return cose;
}

const DEFAULT_CHAIN_FETCH_TIMEOUT_MS = 15_000;

export async function fetchCredentialPublicKeyFromChain({
  contractAddress,
  credentialIdBase64Url,
  rpcUrl,
  networkPassphrase,
  timeoutMs = DEFAULT_CHAIN_FETCH_TIMEOUT_MS,
}: {
  contractAddress: string;
  credentialIdBase64Url: string;
  rpcUrl: string;
  networkPassphrase: string;
  timeoutMs?: number;
}): Promise<string> {
  const credentialIdBytes = decodeBase64UrlString(credentialIdBase64Url);

  const fetchFromChain = async (): Promise<string> => {
    const client = new Client({
      contractId: contractAddress,
      networkPassphrase,
      rpcUrl,
    });

    const tx = await client.get_context_rules({
      context_rule_type: {
        tag: "Default",
        values: undefined as unknown as void,
      },
    });
    const rules = tx.result;

    for (const rule of rules) {
      for (const signer of rule.signers) {
        if (signer.tag !== "External") continue;

        const keyData = signer.values[1];
        if (keyData.length < 65) continue;

        const signerCredIdBytes = keyData.slice(65);
        if (signerCredIdBytes.length !== credentialIdBytes.length) continue;

        let match = true;
        for (let i = 0; i < credentialIdBytes.length; i++) {
          if (signerCredIdBytes[i] !== credentialIdBytes[i]) {
            match = false;
            break;
          }
        }

        if (match) {
          return encodeBase64Url(new Uint8Array(keyData.slice(0, 65)));
        }
      }
    }

    throw new LeaderboardCredentialBindingError(
      "credential public key not found in smart account contract",
      { retryable: false, statusCode: 403 },
    );
  };

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(
      () =>
        reject(
          new LeaderboardCredentialBindingError("on-chain public key fetch timed out", {
            retryable: true,
            statusCode: 503,
          }),
        ),
      Math.max(1000, timeoutMs),
    );
  });

  return Promise.race([fetchFromChain(), timeout]);
}

export async function assertCredentialBelongsToClaimantContract({
  claimantAddress,
  credentialIdBase64Url,
  indexerBaseUrl,
  timeoutMs,
  fetchImpl,
}: {
  claimantAddress: string;
  credentialIdBase64Url: string;
  indexerBaseUrl?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!claimantAddress.startsWith("C")) {
    throw new LeaderboardCredentialBindingError(
      "profile updates require a smart-account contract claimant address",
      {
        retryable: false,
        statusCode: 403,
      },
    );
  }

  const contracts = await fetchIndexedContractsForCredential({
    credentialIdBase64Url,
    baseUrl: indexerBaseUrl,
    timeoutMs,
    fetchImpl,
  });
  if (!contracts.some((contractId) => contractId === claimantAddress)) {
    throw new LeaderboardCredentialBindingError(
      "credential is not linked to claimant address in smart-account indexer",
      {
        retryable: false,
        statusCode: 403,
      },
    );
  }
}
