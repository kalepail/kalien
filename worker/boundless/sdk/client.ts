/**
 * Boundless SDK — BoundlessClient class.
 *
 * Provides a clean, typed interface for submitting proof requests to the
 * Boundless ZK proof marketplace and polling for fulfillment.
 *
 * The Boundless flow:
 *   1. Encode the guest input (stdin) into GuestEnv V1 msgpack format
 *   2. Upload to IPFS (Pinata) if stdin > MAX_INLINE_STDIN_BYTES
 *   3. Build a ProofRequest with a reverse Dutch auction offer
 *   4. Sign the request with EIP-712
 *   5. Submit on-chain (up to 3 attempts) and optionally broadcast to order stream
 *   6. Poll `requestIsFulfilled` until true, then fetch the ProofDelivered event
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  hashTypedData,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { retryDelaySeconds, safeErrorMessage, sleep } from "../../utils";
import { BOUNDLESS_INDEXER_URLS, MAX_INLINE_STDIN_BYTES } from "../config";
import { boundlessMarketAbi, eip712Types } from "../abi";
import { encodeStdin } from "../stdin";
import { uploadInput } from "../storage";
import { fetchEthPriceUsd, resolveUsdOfferToWei, weiToUsd } from "../pricing";
import { buildProofArtifactV4 } from "../../proof-artifact";
import { parseAndValidateTape } from "../../tape";
import { DEFAULT_MAX_TAPE_BYTES } from "../../constants";
import type {
  BoundlessFundingModeUsed,
  ProverPollResult,
  ProverSubmitResult,
  ProofResultSummary,
} from "../../types";
import type {
  BoundlessClientConfig,
  BoundlessFulfillmentData,
  BoundlessProofRequest,
} from "./types";
import {
  buildRequestId,
  boundlessExplorerUrl,
  hexToUint8Array,
  requestIdToHex,
  uint8ArrayToHex,
} from "./utils";
import { JOURNAL_LEN, packJournalRaw, unpackJournalRaw } from "../../../shared/stellar/journal";

function parsePositiveNumber(value: string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

// Predicate type name mapping for the order stream JSON format
const PREDICATE_TYPE_NAMES: Record<number, string> = {
  0: "DigestMatch",
  1: "PrefixMatch",
  2: "ClaimDigestMatch",
};
const INPUT_TYPE_NAMES: Record<number, string> = { 0: "Inline", 1: "Url" };

function isRetryableSubmitError(msg: string): boolean {
  const normalized = msg.toLowerCase();
  return (
    normalized.includes("nonce") ||
    normalized.includes("timeout") ||
    normalized.includes("429") ||
    normalized.includes("502") ||
    normalized.includes("503")
  );
}

export class BoundlessClient {
  private readonly config: BoundlessClientConfig;

  constructor(config: BoundlessClientConfig) {
    this.config = config;
  }

  // ── Public API ────────────────────────────────────────────────────────

  /**
   * Submit a tape to Boundless for proving.
   *
   * Encodes the tape into GuestEnv V1 msgpack format, uploads to IPFS if
   * needed, builds + signs + submits on-chain (up to 3 attempts), then
   * optionally broadcasts to order stream (best-effort only).
   * Funding first tries market-balance top-up (delta + buffer), then falls
   * back to attached-value submission if needed.
   * Each transport strategy attempts up to 3 times.
   *
   * Returns a ProverSubmitResult consumed by the coordinator flow.
   */
  async submitRequest(
    tapeBytes: Uint8Array,
    metadata: { seedId: number; claimantAddress: string },
  ): Promise<ProverSubmitResult> {
    const config = this.config;
    const account = privateKeyToAccount(config.privateKey);

    // 1. Resolve USD pricing to wei via Chainlink ETH/USD feed
    let ethPriceUsd: number | null;
    let minPrice: bigint;
    let maxPrice: bigint;
    try {
      ({
        ethPriceUsd,
        minPriceWei: minPrice,
        maxPriceWei: maxPrice,
      } = await resolveUsdOfferToWei({
        rpcUrl: config.rpcUrl,
        chainId: Number(config.chainId),
        minPriceUsd: config.minPriceUsd,
        maxPriceUsd: config.maxPriceUsd,
      }));
      console.log("[boundless] ETH price", {
        ethPriceUsd: ethPriceUsd?.toFixed(2) ?? null,
        maxPriceUsd: config.maxPriceUsd,
        maxPriceWei: maxPrice.toString(),
        minPriceUsd: config.minPriceUsd,
        minPriceWei: minPrice.toString(),
      });
    } catch (error) {
      return {
        type: "retry",
        message: `failed fetching ETH price for USD pricing: ${safeErrorMessage(error)}`,
      };
    }

    // 2. Encode stdin into GuestEnv V1 msgpack format
    const stdinBytes = encodeStdin(tapeBytes, {
      seedId: metadata.seedId >>> 0,
      claimantAddress: metadata.claimantAddress,
    });

    // 2. Determine input type: upload to IPFS if too large for inline
    let inputType: number;
    let inputData: Hex;
    let ipfsCid: string | undefined;

    if (stdinBytes.length > MAX_INLINE_STDIN_BYTES) {
      if (!config.pinataJwt) {
        return {
          type: "fatal",
          message: `stdin is ${stdinBytes.length} bytes (exceeds ${MAX_INLINE_STDIN_BYTES} inline limit) but PINATA_JWT is not configured`,
        };
      }

      try {
        const upload = await uploadInput(config.pinataJwt, stdinBytes);
        ipfsCid = upload.cid;
        const urlBytes = new TextEncoder().encode(upload.url);
        inputData = `0x${uint8ArrayToHex(new Uint8Array(urlBytes))}` as Hex;
        inputType = 1; // Url
        console.log("[boundless] uploaded stdin to IPFS", {
          url: upload.url,
          cid: ipfsCid,
          stdinBytes: stdinBytes.length,
        });
      } catch (error) {
        return {
          type: "retry",
          message: `failed uploading stdin to IPFS: ${safeErrorMessage(error)}`,
        };
      }
    } else {
      inputData = `0x${uint8ArrayToHex(stdinBytes)}` as Hex;
      inputType = 0; // Inline
    }

    // 3. Build the ProofRequest with a reverse Dutch auction
    //    nonce = Date.now() truncated to uint32 via >>> 0
    const nonce = Date.now() >>> 0;
    const requestId = buildRequestId(account.address, nonce);

    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const rampUpStart = nowSec + BigInt(config.flatPeriodSec);

    // Compute DigestMatch predicate: bind proof request to this exact tape by
    // precomputing the expected journal.
    // and using sha256(journal) as the predicate data.
    const tapeMeta = parseAndValidateTape(tapeBytes, DEFAULT_MAX_TAPE_BYTES);
    let expectedJournal: Uint8Array;
    try {
      expectedJournal = packJournalRaw({
        seed_id: metadata.seedId >>> 0,
        seed: tapeMeta.seed,
        frame_count: tapeMeta.frameCount,
        final_score: tapeMeta.finalScore,
        claimant: metadata.claimantAddress,
      });
    } catch (error) {
      return {
        type: "fatal",
        message: `failed building expected journal: ${safeErrorMessage(error)}`,
      };
    }
    const journalDigest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", expectedJournal as unknown as BufferSource),
    );
    // DigestMatch data = abi.encodePacked(imageId, sha256(journal)) = 64 bytes
    const imageIdBytes = hexToUint8Array(config.imageId as Hex);
    const predicateData = new Uint8Array(64);
    predicateData.set(imageIdBytes, 0);
    predicateData.set(journalDigest, 32);
    const predicateDataHex = `0x${uint8ArrayToHex(predicateData)}` as Hex;

    const proofRequest: BoundlessProofRequest = {
      id: requestId,
      requirements: {
        callback: {
          addr: "0x0000000000000000000000000000000000000000",
          gasLimit: 0n,
        },
        predicate: {
          predicateType: 0, // DigestMatch — proof must produce this exact journal from this image
          data: predicateDataHex,
        },
        selector: "0x73c457ba", // Groth16V3_0 — Stellar requires standalone Groth16 proofs
      },
      imageUrl: config.imageUrl,
      input: {
        inputType,
        data: inputData,
      },
      offer: {
        minPrice,
        maxPrice,
        rampUpStart,
        rampUpPeriod: config.rampPeriodSec,
        lockTimeout: config.lockTimeoutSec,
        timeout: config.timeoutSec,
        lockCollateral: config.lockCollateralBaseUnits,
      },
    };

    // Build viem chain config from chainId + rpcUrl
    const chain = defineChain({
      id: Number(config.chainId),
      name: `chain-${config.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });

    const domain = {
      name: "IBoundlessMarket" as const,
      version: "1" as const,
      chainId: config.chainId,
      verifyingContract: config.marketAddress,
    };

    // 4. Sign the request with EIP-712
    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(config.rpcUrl),
    });
    const publicClient = createPublicClient({
      chain,
      transport: http(config.rpcUrl),
    });

    let signature: Hex;
    try {
      signature = await walletClient.signTypedData({
        domain,
        types: eip712Types,
        primaryType: "ProofRequest",
        message: proofRequest,
      });
    } catch (error) {
      return {
        type: "retry",
        message: `failed signing proof request: ${safeErrorMessage(error)}`,
      };
    }

    const requestIdHex = requestIdToHex(requestId);
    const onchainSubmit = (value: bigint) =>
      walletClient.writeContract({
        address: config.marketAddress,
        abi: boundlessMarketAbi,
        functionName: "submitRequest",
        args: [proofRequest, signature],
        value,
      });

    // Funding plans:
    // 1) market-balance path: delta + buffer top-up (3 attempts)
    // 2) attached-value fallback: submit with maxPrice attached (3 attempts)
    const fundingPlans: Array<{
      mode: BoundlessFundingModeUsed;
      submitValueWei: bigint;
      marketBalanceBeforeWei?: bigint;
      autoDepositWei?: bigint;
    }> = [];

    let marketFundingError: string | undefined;
    let marketFundingErrorRetryable = false;
    let marketFundingPrepared = false;
    let preparedMarketBalanceBeforeWei: bigint | undefined;
    let preparedAutoDepositWei: bigint | undefined;

    /* eslint-disable no-await-in-loop */
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const marketBalanceBeforeWei = await publicClient.readContract({
          address: config.marketAddress,
          abi: boundlessMarketAbi,
          functionName: "balanceOf",
          args: [account.address],
        });

        let autoDepositWei: bigint | undefined;
        if (marketBalanceBeforeWei < maxPrice) {
          const deficitWei = maxPrice - marketBalanceBeforeWei;
          const bufferWei =
            config.topUpBufferBps > 0
              ? (deficitWei * BigInt(config.topUpBufferBps) + 9_999n) / 10_000n
              : 0n;
          autoDepositWei = deficitWei + bufferWei;

          if (autoDepositWei > 0n) {
            await walletClient.writeContract({
              address: config.marketAddress,
              abi: boundlessMarketAbi,
              functionName: "deposit",
              args: [],
              value: autoDepositWei,
            });
          }
        }

        preparedMarketBalanceBeforeWei = marketBalanceBeforeWei;
        preparedAutoDepositWei = autoDepositWei;
        marketFundingPrepared = true;
        break;
      } catch (error) {
        const msg = safeErrorMessage(error);
        marketFundingError = msg;
        marketFundingErrorRetryable = isRetryableSubmitError(msg);
        if (attempt < 3) {
          const delaySec = retryDelaySeconds(attempt);
          console.log(
            `[boundless] market-balance funding prep attempt ${attempt}/3 failed (retrying in ${delaySec}s): ${msg}`,
          );
          await sleep(delaySec * 1000);
        }
      }
    }

    if (marketFundingPrepared) {
      fundingPlans.push({
        mode: "market_balance",
        submitValueWei: 0n,
        marketBalanceBeforeWei: preparedMarketBalanceBeforeWei,
        autoDepositWei: preparedAutoDepositWei,
      });
    } else {
      console.log(
        "[boundless] market-balance funding prep exhausted; using attached-value fallback",
        {
          requestId: requestIdHex,
          maxPriceWei: maxPrice.toString(),
          error: marketFundingError ?? "unknown funding prep error",
        },
      );
    }

    fundingPlans.push({
      mode: "attached_value_fallback",
      submitValueWei: maxPrice,
    });

    // Submit via strategy queue for each funding plan:
    // on-chain first (3 attempts), then off-chain order stream broadcast (3 attempts).
    // Only on-chain submission is treated as authoritative success.
    let lastError: string | undefined;
    let sawRetryableError = false;
    for (const fundingPlan of fundingPlans) {
      const strategies = [
        {
          name: "on-chain",
          maxAttempts: 3,
          fn: () => onchainSubmit(fundingPlan.submitValueWei),
        },
        {
          name: "order-stream",
          maxAttempts: 3,
          fn: async () => {
            await this.submitToOrderStream(proofRequest, signature, domain);
          },
        },
      ] as const;

      for (const strategy of strategies) {
        for (let attempt = 1; attempt <= strategy.maxAttempts; attempt++) {
          try {
            await strategy.fn();
            if (strategy.name === "order-stream") {
              console.log(
                "[boundless] submitted to order stream (advisory only; waiting for on-chain submit)",
                {
                  requestId: requestIdHex,
                  explorerUrl: this.explorerUrl(requestId),
                  stdinBytes: stdinBytes.length,
                  inputType: inputType === 1 ? "url" : "inline",
                  minPriceWei: minPrice.toString(),
                  maxPriceWei: maxPrice.toString(),
                  maxPriceUsd: config.maxPriceUsd,
                  lockCollateralBaseUnits: config.lockCollateralBaseUnits.toString(),
                  fundingMode: fundingPlan.mode,
                  marketBalanceBeforeWei: fundingPlan.marketBalanceBeforeWei?.toString() ?? null,
                  autoDepositWei: fundingPlan.autoDepositWei?.toString() ?? null,
                  submitValueWei: fundingPlan.submitValueWei.toString(),
                  chainId: config.chainId.toString(),
                },
              );
              break;
            }

            console.log("[boundless] submitted proof request on-chain", {
              requestId: requestIdHex,
              explorerUrl: this.explorerUrl(requestId),
              stdinBytes: stdinBytes.length,
              inputType: inputType === 1 ? "url" : "inline",
              minPriceWei: minPrice.toString(),
              maxPriceWei: maxPrice.toString(),
              maxPriceUsd: config.maxPriceUsd,
              lockCollateralBaseUnits: config.lockCollateralBaseUnits.toString(),
              fundingMode: fundingPlan.mode,
              marketBalanceBeforeWei: fundingPlan.marketBalanceBeforeWei?.toString() ?? null,
              autoDepositWei: fundingPlan.autoDepositWei?.toString() ?? null,
              submitValueWei: fundingPlan.submitValueWei.toString(),
              chainId: config.chainId.toString(),
            });

            return {
              type: "success",
              jobId: requestIdHex,
              statusUrl: `boundless:${requestIdHex}`,
              segmentLimitPo2: 0,
              ipfsCid,
              maxPriceUsd: config.maxPriceUsd,
              minPriceWei: minPrice.toString(),
              maxPriceWei: maxPrice.toString(),
              fundingModeUsed: fundingPlan.mode,
              marketBalanceBeforeWei: fundingPlan.marketBalanceBeforeWei?.toString(),
              autoDepositWei: fundingPlan.autoDepositWei?.toString(),
            };
          } catch (error) {
            const msg = safeErrorMessage(error);
            lastError = `${fundingPlan.mode}/${strategy.name}: ${msg}`;
            const retryable = isRetryableSubmitError(msg);
            sawRetryableError = sawRetryableError || retryable;

            if (attempt < strategy.maxAttempts) {
              const delaySec = retryDelaySeconds(attempt);
              console.log(
                `[boundless] ${fundingPlan.mode} ${strategy.name} attempt ${attempt}/${strategy.maxAttempts} failed (retrying in ${delaySec}s): ${msg}`,
              );
              await sleep(delaySec * 1000);
            }
          }
        }
      }
    }
    /* eslint-enable no-await-in-loop */

    if (!marketFundingPrepared && marketFundingError) {
      lastError = `${lastError ?? "submission failed"} (market funding prep exhausted: ${marketFundingError})`;
      sawRetryableError = sawRetryableError || marketFundingErrorRetryable;
    }

    // All funding + transport strategies exhausted
    return {
      type: sawRetryableError ? "retry" : "fatal",
      message: `all submission strategies failed: ${lastError}`,
    };
  }

  /**
   * Single poll check for Boundless fulfillment.
   *
   * @param requestIdHex - 0x-prefixed hex string of the request ID
   * @returns ProverPollResult (running | success | retry | fatal)
   */
  async pollOnce(requestIdHex: string): Promise<ProverPollResult> {
    const config = this.config;
    const requestId = BigInt(requestIdHex);

    const chain = defineChain({
      id: Number(config.chainId),
      name: `chain-${config.chainId}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });

    const publicClient = createPublicClient({
      chain,
      transport: http(config.rpcUrl),
    });

    // 1. Check if fulfilled on-chain
    let fulfilled: boolean;
    try {
      fulfilled = await publicClient.readContract({
        address: config.marketAddress,
        abi: boundlessMarketAbi,
        functionName: "requestIsFulfilled",
        args: [requestId],
      });
    } catch (error) {
      return {
        type: "retry",
        message: `failed checking fulfillment status: ${safeErrorMessage(error)}`,
      };
    }

    if (!fulfilled) {
      // Check if a prover has locked the order
      let locked: boolean | undefined;
      let lockPriceWei: bigint | undefined;
      try {
        locked = await publicClient.readContract({
          address: config.marketAddress,
          abi: boundlessMarketAbi,
          functionName: "requestIsLocked",
          args: [requestId],
        });
      } catch {
        // Non-fatal — lock status is advisory; default to undefined (unknown)
      }

      // Read lock price while it's still available (cleared after payment)
      if (locked) {
        try {
          const [, , , , price] = await publicClient.readContract({
            address: config.marketAddress,
            abi: boundlessMarketAbi,
            functionName: "requestLocks",
            args: [requestId],
          });
          if (price > 0n) lockPriceWei = price;
        } catch {
          /* non-fatal */
        }
      }

      return {
        type: "running",
        status: "running",
        locked,
        lockPriceWei,
      };
    }

    // 2. Fetch the ProofDelivered event logs (contains seal + journal)
    let fulfillmentData: BoundlessFulfillmentData;
    try {
      const currentBlock = await publicClient.getBlockNumber();
      // Base public RPC limits eth_getLogs to 10,000 blocks; use 9,900 (~5.5h on Base)
      const LOG_SEARCH_WINDOW = 9_900n;
      const fromBlock =
        config.deploymentBlock > currentBlock - LOG_SEARCH_WINDOW
          ? config.deploymentBlock
          : currentBlock - LOG_SEARCH_WINDOW;

      fulfillmentData = await this.fetchFulfillmentFromLogs(
        publicClient,
        requestId,
        fromBlock,
        currentBlock,
      );
    } catch (error) {
      if (error instanceof FulfillmentNotFoundError) {
        return {
          type: "retry",
          message: error.message,
        };
      }
      return {
        type: "retry",
        message: `failed fetching fulfillment event: ${safeErrorMessage(error)}`,
      };
    }

    // 3. Fetch settlement cost + cycle counts in parallel — both non-fatal enrichment
    const [costResult, cyclesResult] = await Promise.allSettled([
      (async (): Promise<number | null> => {
        const [, , , , lockPrice] = await publicClient.readContract({
          address: config.marketAddress,
          abi: boundlessMarketAbi,
          functionName: "requestLocks",
          args: [requestId],
        });
        if (lockPrice <= 0n) return null;
        const ethPrice = await fetchEthPriceUsd(config.rpcUrl, Number(config.chainId));
        return weiToUsd(lockPrice, ethPrice);
      })(),
      this.fetchCyclesFromIndexer(requestId),
    ]);

    const actualCostUsd = costResult.status === "fulfilled" ? costResult.value : null;
    const { programCycles, totalCycles } =
      cyclesResult.status === "fulfilled"
        ? cyclesResult.value
        : { programCycles: null, totalCycles: null };

    if (fulfillmentData.seal.length !== 260) {
      return {
        type: "fatal",
        message: `boundless delivered invalid seal length: expected 260 bytes, got ${fulfillmentData.seal.length}`,
      };
    }

    if (fulfillmentData.journal.length !== JOURNAL_LEN) {
      return {
        type: "fatal",
        message: `boundless delivered invalid journal length: expected ${JOURNAL_LEN} bytes, got ${fulfillmentData.journal.length}`,
      };
    }

    let journal;
    try {
      journal = unpackJournalRaw(fulfillmentData.journal);
    } catch (error) {
      return {
        type: "fatal",
        message: `boundless delivered malformed journal: ${safeErrorMessage(error)}`,
      };
    }

    if (journal.frame_count >>> 0 === 0) {
      return {
        type: "fatal",
        message: "boundless delivered invalid journal: frame_count must be > 0",
      };
    }
    if (journal.final_score >>> 0 === 0) {
      return {
        type: "fatal",
        message: "boundless delivered invalid journal: final_score must be > 0",
      };
    }

    const normalizedProgramCycles =
      programCycles == null ? 0 : Math.max(0, Math.floor(programCycles));
    const normalizedTotalCycles =
      totalCycles == null ? normalizedProgramCycles : Math.max(0, Math.floor(totalCycles));

    const summary: ProofResultSummary = {
      elapsedMs: 0,
      requestedReceiptKind: "groth16",
      producedReceiptKind: "groth16",
      journal,
      stats: {
        segments: 0,
        total_cycles: normalizedTotalCycles,
        user_cycles: normalizedProgramCycles,
        paging_cycles: 0,
        reserved_cycles: 0,
      },
    };

    let artifact;
    try {
      artifact = await buildProofArtifactV4(
        "boundless",
        new Date().toISOString(),
        fulfillmentData.seal,
        fulfillmentData.journal,
      );
    } catch (error) {
      return {
        type: "fatal",
        message: `failed building boundless v4 proof artifact: ${safeErrorMessage(error)}`,
      };
    }

    return {
      type: "success",
      summary,
      artifact,
      metadata: {
        actualCostUsd,
        proverAddress: fulfillmentData.proverAddress,
        fulfillmentTxHash: fulfillmentData.fulfillmentTxHash,
        programCycles,
        totalCycles,
      },
    };
  }

  /**
   * Get the Boundless explorer URL for a given request ID.
   *
   * @param requestId - bigint request ID
   */
  explorerUrl(requestId: bigint): string {
    return boundlessExplorerUrl(requestId);
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /**
   * Submit the signed proof request to the off-chain order stream.
   *
   * Provers monitor the order stream to discover new requests faster than
   * polling the chain. This submission is best-effort — the on-chain
   * submission is the authoritative source of truth.
   */
  private async submitToOrderStream(
    request: BoundlessProofRequest,
    signature: Hex,
    domain: {
      name: string;
      version: string;
      chainId: bigint;
      verifyingContract: `0x${string}`;
    },
  ): Promise<void> {
    const config = this.config;

    const requestDigest = hashTypedData({
      domain,
      types: eip712Types,
      primaryType: "ProofRequest",
      message: request,
    });

    // Parse the 65-byte compact signature into r, s, v
    const sigClean = signature.startsWith("0x") ? signature.slice(2) : signature;
    const r = `0x${sigClean.slice(0, 64)}`;
    const s = `0x${sigClean.slice(64, 128)}`;
    const v = Number.parseInt(sigClean.slice(128, 130), 16);
    const yParity = v >= 27 ? v - 27 : v;

    const orderBody = {
      request: {
        id: requestIdToHex(request.id),
        requirements: {
          callback: {
            addr: request.requirements.callback.addr,
            gasLimit: `0x${request.requirements.callback.gasLimit.toString(16)}`,
          },
          predicate: {
            predicateType:
              PREDICATE_TYPE_NAMES[request.requirements.predicate.predicateType] ?? "DigestMatch",
            data: request.requirements.predicate.data,
          },
          selector: request.requirements.selector,
        },
        imageUrl: request.imageUrl,
        input: {
          inputType: INPUT_TYPE_NAMES[request.input.inputType] ?? "Inline",
          data: request.input.data,
        },
        offer: {
          minPrice: `0x${request.offer.minPrice.toString(16)}`,
          maxPrice: `0x${request.offer.maxPrice.toString(16)}`,
          rampUpStart: Number(request.offer.rampUpStart),
          rampUpPeriod: request.offer.rampUpPeriod,
          lockTimeout: request.offer.lockTimeout,
          timeout: request.offer.timeout,
          lockCollateral: `0x${request.offer.lockCollateral.toString(16)}`,
        },
      },
      request_digest: requestDigest,
      signature: {
        r,
        s,
        yParity: `0x${yParity.toString(16)}`,
        v: `0x${yParity.toString(16)}`,
      },
    };

    const resp = await fetch(`${config.orderStreamUrl}/api/v1/submit_order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderBody),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`order stream returned ${resp.status}: ${body}`);
    }
  }

  /**
   * Fetch the ProofDelivered event for a request ID and decode fulfillment data.
   *
   * Uses raw eth_getLogs with topic filtering and manual hex decoding to avoid
   * viem's decodeAbiParameters BigInt→Number truncation bug for uint256 fields.
   */
  private async fetchFulfillmentFromLogs(
    publicClient: ReturnType<typeof createPublicClient>,
    requestId: bigint,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<BoundlessFulfillmentData> {
    // ProofDelivered event topic0 (keccak256 of signature)
    const PROOF_DELIVERED_TOPIC =
      "0xaf1db8f86d3f32029a484ff54c7ac1d7ef8f038ab050fc065af9e82eb9b850ca" as const;

    // Topic1: requestId padded to 32 bytes (uint256, big-endian)
    const requestIdTopic = `0x${requestId.toString(16).padStart(64, "0")}` as `0x${string}`;

    const config = this.config;

    // Use raw eth_getLogs with topic filtering for correctness across RPCs.
    // Some RPCs (e.g. BlastAPI) ignore topic filters and return all contract
    // events — we filter manually by both topic0 and topic1 below.
    const logs = await publicClient.request({
      method: "eth_getLogs",
      params: [
        {
          address: config.marketAddress,
          topics: [PROOF_DELIVERED_TOPIC, requestIdTopic],
          fromBlock: `0x${fromBlock.toString(16)}` as Hex,
          toBlock: `0x${toBlock.toString(16)}` as Hex,
        },
      ],
    });

    const ourLog = (
      logs as Array<{
        topics?: string[];
        data?: string;
        transactionHash?: string;
      }>
    ).find((log) => {
      const topic0 = log.topics?.[0]?.toLowerCase();
      const topic1 = log.topics?.[1]?.toLowerCase();
      return (
        topic0 === PROOF_DELIVERED_TOPIC.toLowerCase() && topic1 === requestIdTopic.toLowerCase()
      );
    });

    if (!ourLog?.data) {
      throw new FulfillmentNotFoundError(
        "request reported as fulfilled but no ProofDelivered event found in block range",
      );
    }

    // Extract prover address from topics[2] (indexed address, left-padded to 32 bytes)
    const proverAddress = ourLog.topics?.[2] ? `0x${ourLog.topics[2].slice(-40)}` : null;
    const fulfillmentTxHash = ourLog.transactionHash ?? null;

    const result = this.parseFulfillmentFromEventData(ourLog.data);
    return { ...result, proverAddress, fulfillmentTxHash };
  }

  /**
   * Parse a ProofDelivered event's data field into seal + journal bytes.
   *
   * Manually decodes the ABI-encoded Fulfillment struct without using
   * decodeAbiParameters, avoiding the uint256→Number truncation bug.
   *
   * ProofDelivered event data layout: abi.encode(Fulfillment)
   *
   * Fulfillment struct:
   *   - id (uint256)          — word 0: skip
   *   - requestDigest (bytes32) — word 1: skip
   *   - claimDigest (bytes32)   — word 2: skip
   *   - fulfillmentDataType (uint8) — word 3
   *   - fulfillmentData (bytes) — word 4: offset (relative to tuple head)
   *   - seal (bytes)           — word 5: offset (relative to tuple head)
   *   Then dynamic data follows.
   *
   * The event non-indexed data is: abi.encode(Fulfillment)
   * which is: offset_to_tuple (0x20), then the tuple.
   */
  private parseFulfillmentFromEventData(data: string): BoundlessFulfillmentData {
    const clean = data.startsWith("0x") ? data.slice(2) : data;
    if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
      throw new Error("invalid ProofDelivered event data encoding");
    }
    const totalChars = clean.length;

    const ensureRange = (start: number, end: number, label: string): void => {
      if (start < 0 || end < start || end > totalChars) {
        throw new Error(`malformed ProofDelivered event data: ${label} out of bounds`);
      }
    };
    const readWordAt = (charOffset: number, label: string): string => {
      ensureRange(charOffset, charOffset + 64, label);
      return clean.slice(charOffset, charOffset + 64);
    };
    const readUintAt = (charOffset: number, label: string): number => {
      const value = Number.parseInt(readWordAt(charOffset, label), 16);
      if (!Number.isFinite(value)) {
        throw new Error(`malformed ProofDelivered event data: failed to parse ${label}`);
      }
      return value;
    };
    const readDynamicBytesAt = (byteOffset: number, label: string): string => {
      const lenWordCharOffset = t + byteOffset * 2;
      const length = readUintAt(lenWordCharOffset, `${label} length`);
      const bytesStart = lenWordCharOffset + 64;
      const bytesEnd = bytesStart + length * 2;
      ensureRange(bytesStart, bytesEnd, label);
      return clean.slice(bytesStart, bytesEnd);
    };

    // Outer: word 0 is the offset to the Fulfillment tuple (always 0x20 = 32 bytes)
    const tupleByteOffset = readUintAt(0, "tuple offset");
    if (tupleByteOffset !== 32) {
      throw new Error(`unexpected ProofDelivered tuple offset: ${tupleByteOffset}`);
    }
    const t = tupleByteOffset * 2; // tuple start in hex chars
    ensureRange(t, t + 6 * 64, "Fulfillment tuple head");

    // Fulfillment head (each field = 32 bytes = 64 hex chars):
    //   word 0 (t + 0*64): id (uint256) — skip
    //   word 1 (t + 1*64): requestDigest (bytes32) — skip
    //   word 2 (t + 2*64): claimDigest (bytes32) — skip
    //   word 3 (t + 3*64): fulfillmentDataType (uint8)
    //   word 4 (t + 4*64): fulfillmentData offset (relative to tuple start)
    //   word 5 (t + 5*64): seal offset (relative to tuple start)
    const fulfillmentDataType = readUintAt(t + 3 * 64, "fulfillmentDataType");
    const fdByteOffset = readUintAt(t + 4 * 64, "fulfillmentData offset");
    const sealByteOffset = readUintAt(t + 5 * 64, "seal offset");

    // Read seal: length-prefixed bytes at (t + sealByteOffset * 2)
    const sealHex = readDynamicBytesAt(sealByteOffset, "seal");
    const seal = hexToUint8Array(sealHex);

    if (fulfillmentDataType !== 1) {
      throw new Error(
        `unexpected fulfillmentDataType: ${fulfillmentDataType} (expected 1 = ImageIdAndJournal)`,
      );
    }

    // Read fulfillmentData: length-prefixed bytes at (t + fdByteOffset * 2)
    const fdHex = readDynamicBytesAt(fdByteOffset, "fulfillmentData");

    // fulfillmentData = abi.encode((bytes32 imageId, bytes journal))
    // Strict v4 decode: require tuple offset word 0x20.
    if (fdHex.length < 128) {
      throw new Error("malformed fulfillmentData payload");
    }
    const firstWordVal = Number.parseInt(fdHex.slice(0, 64), 16);
    if (firstWordVal !== 32) {
      throw new Error(`malformed fulfillmentData tuple offset: ${firstWordVal}`);
    }
    const innerHex = fdHex.slice(64);
    if (innerHex.length < 128) {
      throw new Error("malformed fulfillmentData tuple");
    }

    // innerHex layout:
    //   word 0: imageId (bytes32) — skip
    //   word 1: offset to journal bytes (relative to inner start)
    //   at (journalByteOffset * 2): journal length word
    //   at (journalByteOffset * 2 + 64): journal data
    const journalByteOffset = Number.parseInt(innerHex.slice(64, 128), 16);
    const journalLenCharOffset = journalByteOffset * 2;
    if (journalLenCharOffset < 0 || journalLenCharOffset + 64 > innerHex.length) {
      throw new Error("malformed fulfillmentData journal length offset");
    }
    const journalLen = Number.parseInt(
      innerHex.slice(journalLenCharOffset, journalLenCharOffset + 64),
      16,
    );
    const journalHexStart = journalLenCharOffset + 64;
    const journalHexEnd = journalHexStart + journalLen * 2;
    if (journalHexStart < 0 || journalHexEnd > innerHex.length) {
      throw new Error("malformed fulfillmentData journal bytes range");
    }
    const journalHex = innerHex.slice(journalHexStart, journalHexEnd);
    const journal = hexToUint8Array(journalHex);

    return { seal, journal, proverAddress: null, fulfillmentTxHash: null };
  }

  private async fetchCyclesFromIndexer(
    requestId: bigint,
  ): Promise<{ programCycles: number | null; totalCycles: number | null }> {
    return fetchBoundlessCycles(this.config.chainId.toString(), requestIdToHex(requestId));
  }
}

/**
 * Fetch cycle counts for a fulfilled request from the Boundless Indexer API.
 *
 * The indexer computes program_cycles and total_cycles via Bento re-execution.
 * These may be null if Bento hasn't processed the request yet.
 * Returns null values for chains without a known indexer URL.
 *
 * Exported so the coordinator can call it for lazy backfill on read.
 */
export async function fetchBoundlessCycles(
  chainId: string,
  requestIdHex: string,
): Promise<{ programCycles: number | null; totalCycles: number | null }> {
  const primaryIndexerUrl = BOUNDLESS_INDEXER_URLS[chainId];
  const candidateUrls = [
    ...(primaryIndexerUrl ? [`${primaryIndexerUrl}/v1/market/requests/${requestIdHex}`] : []),
    // Fallback to Explorer's public API; it proxies indexer backends server-side.
    `https://explorer.boundless.network/api/orders/${requestIdHex}`,
  ];

  const cycleResults = await Promise.all(
    candidateUrls.map(async (url) => {
      try {
        const resp = await fetch(url, {
          signal: AbortSignal.timeout(8_000),
        });
        if (!resp.ok) {
          return null;
        }

        const payload = (await resp.json()) as unknown;
        const entry =
          payload && typeof payload === "object" && !Array.isArray(payload)
            ? (payload as {
                program_cycles?: string | number | null;
                total_program_cycles?: string | number | null;
                total_cycles?: string | number | null;
              })
            : null;
        if (!entry) {
          return null;
        }

        const programCycles = parsePositiveNumber(
          entry.program_cycles ?? entry.total_program_cycles,
        );
        const totalCycles = parsePositiveNumber(entry.total_cycles);
        if (totalCycles == null && programCycles == null) {
          return null;
        }

        return { source: url, programCycles, totalCycles };
      } catch {
        return null;
      }
    }),
  );

  const firstWithCycles = cycleResults.find((result) => result != null);
  if (firstWithCycles) {
    if (firstWithCycles.totalCycles != null) {
      console.log("[boundless] indexer cycles", {
        programCycles: firstWithCycles.programCycles,
        totalCycles: firstWithCycles.totalCycles,
        requestId: requestIdHex,
        source: firstWithCycles.source,
      });
    }

    return {
      programCycles: firstWithCycles.programCycles,
      totalCycles: firstWithCycles.totalCycles,
    };
  }

  return { programCycles: null, totalCycles: null };
}

/**
 * Error thrown when a fulfilled request's ProofDelivered event cannot be found.
 * This can happen if the event was emitted outside the search window — the
 * caller should retry with a wider block range or after a delay.
 */
export class FulfillmentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FulfillmentNotFoundError";
  }
}
