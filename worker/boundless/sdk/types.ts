/**
 * Boundless SDK — type definitions.
 *
 * These types mirror the Rust SDK's ProofRequest, Fulfillment, and related
 * structures, adapted for TypeScript/viem.
 */

// ── On-chain request types ────────────────────────────────────────────────

export interface BoundlessProofRequest {
  id: bigint;
  requirements: BoundlessRequirements;
  imageUrl: string;
  input: BoundlessInput;
  offer: BoundlessOffer;
}

export interface BoundlessRequirements {
  callback: BoundlessCallback;
  predicate: BoundlessPredicate;
  selector: `0x${string}`;
}

export interface BoundlessPredicate {
  /** 0=DigestMatch, 1=PrefixMatch, 2=ClaimDigestMatch */
  predicateType: number;
  data: `0x${string}`;
}

export interface BoundlessCallback {
  addr: `0x${string}`;
  /** uint96 */
  gasLimit: bigint;
}

export interface BoundlessInput {
  /** 0=Inline, 1=Url */
  inputType: number;
  data: `0x${string}`;
}

export interface BoundlessOffer {
  minPrice: bigint;
  maxPrice: bigint;
  /** uint64 — unix timestamp when the auction ramp begins */
  rampUpStart: bigint;
  /** uint32 — seconds for price to ramp from minPrice to maxPrice */
  rampUpPeriod: number;
  /** uint32 — seconds from rampUpStart; prover must deliver by this deadline */
  lockTimeout: number;
  /** uint32 — seconds from rampUpStart; request expires (lockTimeout + expiry window) */
  timeout: number;
  lockCollateral: bigint;
}

// ── Fulfillment types ─────────────────────────────────────────────────────

export interface BoundlessFulfillmentData {
  seal: Uint8Array;
  journal: Uint8Array;
  proverAddress: string | null; // topics[2] from ProofDelivered event
  fulfillmentTxHash: string | null; // transactionHash from log
}

// ── Config types (re-exported from parent config for SDK consumers) ────────

export interface BoundlessClientConfig {
  rpcUrl: string;
  privateKey: `0x${string}`;
  imageUrl: string;
  /** 0x-prefixed 32-byte image ID */
  imageId: `0x${string}`;
  /** Maximum price in USD (resolved to wei at submission via Chainlink) */
  maxPriceUsd: number;
  /** Minimum price in USD (resolved to wei at submission via Chainlink) */
  minPriceUsd: number;
  /** Prover lock collateral in raw 18-decimal ZKC base units. */
  lockCollateralBaseUnits: bigint;
  /** JIT top-up buffer in basis points applied when topping up market balance. */
  topUpBufferBps: number;
  pollTimeoutMs: number;
  /** Seconds before price ramp begins (prover discovery window) */
  flatPeriodSec: number;
  /** Seconds for price to ramp linearly from minPrice to maxPrice */
  rampPeriodSec: number;
  /** Seconds from rampUpStart for prover to deliver proof */
  lockTimeoutSec: number;
  /** Total request expiry from rampUpStart */
  timeoutSec: number;
  chainId: bigint;
  marketAddress: `0x${string}`;
  orderStreamUrl: string;
  deploymentBlock: bigint;
  /** Pinata JWT for IPFS uploads (required if stdin > MAX_INLINE_STDIN_BYTES) */
  pinataJwt: string | null;
}
