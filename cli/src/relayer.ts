import { Address, xdr } from "@stellar/stellar-sdk";
import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels/dist/client";
import { fetchSeedContextFromContract } from "@/chain/seed";

export interface SeedBumpResult {
  success: boolean;
  seed: number | null;
  seedId: number | null;
}

interface SorobanInvokePayload {
  func: string;
  auth: string[];
}

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

/**
 * Trigger generation of the current chain-authoritative seed window:
 *   current_seed()
 *
 * Returns only a seed/seed_id pair confirmed from contract storage after the
 * relayed transaction. No local wall clock is used to select the id.
 */
export async function bumpSeedViaRelayer(
  contractId: string,
  rpcUrl: string,
  networkPassphrase: string,
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

    /* eslint-disable no-await-in-loop -- materialization must be observed sequentially */
    for (let attempt = 0; attempt < 6; attempt++) {
      const context = await fetchSeedContextFromContract(
        contractId,
        rpcUrl,
        networkPassphrase,
      );
      if (context?.seed !== null && context?.seed !== undefined) {
        return {
          success: true,
          seed: context.seed,
          seedId: context.seedId,
        };
      }
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    /* eslint-enable no-await-in-loop */

    console.warn("[relayer] seed refresh failed: current chain seed did not materialize");
    return { success: false, seed: null, seedId: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[relayer] seed refresh failed: ${detail}`);
    return { success: false, seed: null, seedId: null };
  }
}
