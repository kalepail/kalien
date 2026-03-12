import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels/dist/client";

export interface SeedBumpResult {
  success: boolean;
  seed: number | null;
  seedId: number | null;
}

interface SorobanInvokePayload {
  func: string;
  auth: string[];
}

import { SEED_INTERVAL_SECONDS } from "./constants";

function normalizeNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildInvokePayloadForContractFn(
  contractId: string,
  fnName: string,
  args: xdr.ScVal[],
): SorobanInvokePayload {
  const invokeArgs = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(contractId).toScAddress(),
    functionName: fnName,
    args,
  });
  const hostFn = xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs);
  return {
    func: hostFn.toXDR("base64"),
    auth: [],
  };
}

async function submitInvokeViaRelayer(
  client: ChannelsClient,
  payload: SorobanInvokePayload,
): Promise<string | null> {
  const result = await client.submitSorobanTransaction(payload);
  if (typeof result.hash === "string" && result.hash.trim().length > 0) {
    return result.hash.trim();
  }
  return null;
}

async function fetchSeedById(
  contractId: string,
  rpcUrl: string,
  seedId: number,
): Promise<number | null> {
  const server = new rpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith("http:"),
  });
  const key = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("SeedById"), xdr.ScVal.scvU32(seedId)]);

  try {
    const entry = await server.getContractData(contractId, key, rpc.Durability.Temporary);
    const value = entry.val.contractData().val();
    if (value.switch().name !== "scvU32") {
      return null;
    }
    return value.u32() >>> 0;
  } catch {
    return null;
  }
}

/**
 * Trigger generation of the current epoch seed (10-minute seed_id interval):
 *   current_seed()
 *
 * Returns the resolved seed/seed_id on success.
 */
export async function bumpSeedViaRelayer(
  contractId: string,
  rpcUrl: string,
  relayerBaseUrl: string,
  relayerApiKey: string,
): Promise<SeedBumpResult> {
  const normalizedRelayerBaseUrl = normalizeNonEmpty(relayerBaseUrl);
  const normalizedRelayerApiKey = normalizeNonEmpty(relayerApiKey);
  if (!normalizedRelayerBaseUrl || !normalizedRelayerApiKey) {
    console.warn("[relayer] seed refresh skipped: relayer is not configured");
    return { success: false, seed: null, seedId: null };
  }

  const channelsClient = new ChannelsClient({
    baseUrl: normalizedRelayerBaseUrl,
    apiKey: normalizedRelayerApiKey,
  });

  try {
    const currentSeedPayload = buildInvokePayloadForContractFn(contractId, "current_seed", []);
    await submitInvokeViaRelayer(channelsClient, currentSeedPayload);

    const nowSeedId = Math.floor(Date.now() / 1000 / SEED_INTERVAL_SECONDS);
    const candidateSeedIds = nowSeedId > 0 ? [nowSeedId, nowSeedId - 1] : [nowSeedId];
    let materializedSeedId: number | null = null;
    let materializedSeed: number | null = null;

    /* eslint-disable no-await-in-loop -- seed candidates must be checked in order */
    for (const candidateSeedId of candidateSeedIds) {
      const candidateSeed = await fetchSeedById(contractId, rpcUrl, candidateSeedId);
      if (candidateSeed !== null) {
        materializedSeedId = candidateSeedId;
        materializedSeed = candidateSeed;
        break;
      }
    }
    /* eslint-enable no-await-in-loop */

    if (materializedSeedId === null || materializedSeed === null) {
      console.warn(
        `[relayer] seed refresh failed: unable to read SeedById(seed_id) after current_seed; seed_ids=${candidateSeedIds.join(",")}`,
      );
      return { success: false, seed: null, seedId: null };
    }

    return {
      success: true,
      seed: materializedSeed,
      seedId: materializedSeedId,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[relayer] seed refresh failed: ${detail}`);
    return { success: false, seed: null, seedId: null };
  }
}
