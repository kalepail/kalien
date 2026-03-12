import { DEFAULT_BOUNDLESS_POLL_TIMEOUT_MS } from "../constants";
import type { WorkerEnv } from "../env";

// Known Boundless deployments by chain
export const KNOWN_DEPLOYMENTS = {
  // Base Mainnet — production deployment
  "8453": {
    chainId: 8453n,
    marketAddress: "0xfd152dadc5183870710fe54f939eae3ab9f0fe82" as const,
    orderStreamUrl: "https://base-mainnet.boundless.network",
    deploymentBlock: 35_060_420n,
  },
  // Ethereum Sepolia — active testnet
  "11155111": {
    chainId: 11155111n,
    marketAddress: "0xc211b581cb62e3a6d396a592bab34979e1bbba7d" as const,
    orderStreamUrl: "https://eth-sepolia.boundless.network",
    deploymentBlock: 7_800_000n,
  },
  // Base Sepolia — mostly inactive, kept for reference
  "84532": {
    chainId: 84532n,
    marketAddress: "0x56da3786061c82214d18e634d2817e86ad42d7ce" as const,
    orderStreamUrl: "https://base-sepolia.boundless.network",
    deploymentBlock: 22_032_823n,
  },
} as const;

// Default to Base Mainnet for production
const DEFAULT_DEPLOYMENT = KNOWN_DEPLOYMENTS["8453"];

export const IPFS_GATEWAY_PREFIX = "https://gateway.pinata.cloud/ipfs/";

// Boundless Indexer API base URLs by chain ID.
// Returns program_cycles and total_cycles for fulfilled proof requests.
export const BOUNDLESS_INDEXER_URLS: Partial<Record<string, string>> = {
  "8453": "https://d2mdvlnmyov1e1.cloudfront.net", // Base Mainnet
  "84532": "https://d3kkukmpiqlzm1.cloudfront.net", // Base Sepolia
};

// Inline stdin data larger than this (bytes) is uploaded to IPFS instead.
// The Boundless order stream server rejects inline data > ~3.4 KB.
export const MAX_INLINE_STDIN_BYTES = 3000;

export interface BoundlessConfig {
  rpcUrl: string;
  privateKey: `0x${string}`;
  imageUrl: string;
  imageId: `0x${string}`;
  // USD-denominated pricing — resolved to wei at submission time via Chainlink ETH/USD feed
  maxPriceUsd: number;
  minPriceUsd: number;
  // ZKC collateral in raw 18-decimal base units for the on-chain lockCollateral field.
  lockCollateralBaseUnits: bigint;
  topUpBufferBps: number;
  pollTimeoutMs: number;
  // Auction shape (reverse Dutch auction) — all in seconds (contract uses block.timestamp)
  flatPeriodSec: number; // Seconds before ramp begins (prover discovery window)
  rampPeriodSec: number; // Seconds for price to ramp linearly from minPrice to maxPrice
  lockTimeoutSec: number; // Seconds from rampUpStart for prover to deliver proof
  timeoutSec: number; // Total request expiry from rampUpStart (expiry period after lock = timeout - lockTimeout)
  // Chain-specific
  chainId: bigint;
  marketAddress: `0x${string}`;
  orderStreamUrl: string;
  deploymentBlock: bigint;
  // IPFS upload (required for inputs > MAX_INLINE_STDIN_BYTES)
  pinataJwt: string | null;
}

const ZKC_DECIMALS = 18;
const DEFAULT_BOUNDLESS_LOCK_COLLATERAL_BASE_UNITS = 5n * 10n ** 18n;

function parseNonNegativeFloat(value: string | undefined, fallback: number): number {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseLockCollateralBaseUnits(value: string | undefined): bigint {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_BOUNDLESS_LOCK_COLLATERAL_BASE_UNITS;
  if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return DEFAULT_BOUNDLESS_LOCK_COLLATERAL_BASE_UNITS;
  }

  const [wholePart, fractionPart = ""] = trimmed.split(".");
  if (fractionPart.length > ZKC_DECIMALS) {
    return DEFAULT_BOUNDLESS_LOCK_COLLATERAL_BASE_UNITS;
  }

  const whole = BigInt(wholePart);
  const fraction = BigInt((fractionPart + "0".repeat(ZKC_DECIMALS)).slice(0, ZKC_DECIMALS));
  return whole * 10n ** BigInt(ZKC_DECIMALS) + fraction;
}

export function resolveBoundlessConfig(env: WorkerEnv): BoundlessConfig | null {
  const rpcUrl = env.BOUNDLESS_RPC_URL?.trim();
  const privateKey = env.BOUNDLESS_PRIVATE_KEY?.trim();
  const imageUrl = env.BOUNDLESS_IMAGE_URL?.trim();
  const imageId = env.BOUNDLESS_IMAGE_ID?.trim();

  if (!rpcUrl || !privateKey || !imageUrl || !imageId) {
    return null;
  }

  const normalizedKey = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
  const normalizedImageId = imageId.startsWith("0x") ? imageId : `0x${imageId}`;

  // Resolve chain deployment — explicit env vars override known defaults
  const chainIdRaw = env.BOUNDLESS_CHAIN_ID?.trim();
  const chainId = chainIdRaw ? BigInt(chainIdRaw) : DEFAULT_DEPLOYMENT.chainId;
  const knownDeployment = KNOWN_DEPLOYMENTS[chainId.toString() as keyof typeof KNOWN_DEPLOYMENTS];

  const marketAddress = (env.BOUNDLESS_MARKET_ADDRESS?.trim() ||
    knownDeployment?.marketAddress ||
    DEFAULT_DEPLOYMENT.marketAddress) as `0x${string}`;
  const orderStreamUrl =
    env.BOUNDLESS_ORDER_STREAM_URL?.trim() ||
    knownDeployment?.orderStreamUrl ||
    DEFAULT_DEPLOYMENT.orderStreamUrl;
  const deploymentBlockRaw = env.BOUNDLESS_DEPLOYMENT_BLOCK?.trim();
  const deploymentBlock = deploymentBlockRaw
    ? BigInt(deploymentBlockRaw)
    : (knownDeployment?.deploymentBlock ?? DEFAULT_DEPLOYMENT.deploymentBlock);

  const maxPriceUsd = parseNonNegativeFloat(env.BOUNDLESS_MAX_PRICE_USD, 0.1);
  const minPriceUsd = parseNonNegativeFloat(env.BOUNDLESS_MIN_PRICE_USD, 0);
  const lockCollateralBaseUnits = parseLockCollateralBaseUnits(env.BOUNDLESS_LOCK_COLLATERAL_ZKC);
  const topUpBufferBpsRaw = env.BOUNDLESS_TOP_UP_BUFFER_BPS?.trim();
  const parsedTopUpBufferBps = topUpBufferBpsRaw ? Number.parseInt(topUpBufferBpsRaw, 10) : NaN;
  const topUpBufferBps = Number.isFinite(parsedTopUpBufferBps)
    ? Math.min(10_000, Math.max(0, parsedTopUpBufferBps))
    : 1_500; // 15%

  // Auction shape — reverse Dutch auction from minPrice to maxPrice.
  // All timing values are in SECONDS (the contract uses block.timestamp).
  // Defaults: 1m flat + 11m ramp + 18m at maxPrice = 29m lock from rampUpStart,
  // then 30m expiry window for secondary provers = 59m from rampUpStart = 60m total
  const flatPeriodSec = env.BOUNDLESS_FLAT_PERIOD_SEC
    ? Math.max(0, Number.parseInt(env.BOUNDLESS_FLAT_PERIOD_SEC, 10))
    : 60; // 1 minute
  const rampPeriodSec = env.BOUNDLESS_RAMP_PERIOD_SEC
    ? Math.max(1, Number.parseInt(env.BOUNDLESS_RAMP_PERIOD_SEC, 10))
    : 660; // 11 minutes
  const lockTimeoutSec = env.BOUNDLESS_LOCK_TIMEOUT_SEC
    ? Math.max(60, Number.parseInt(env.BOUNDLESS_LOCK_TIMEOUT_SEC, 10))
    : 1740; // 29 min from rampUpStart (11m ramp + 18m at max price)
  const timeoutSec = env.BOUNDLESS_TIMEOUT_SEC
    ? Math.max(lockTimeoutSec, Number.parseInt(env.BOUNDLESS_TIMEOUT_SEC, 10))
    : 3540; // lock (29m) + 30m expiry period for secondary provers

  const pollTimeoutMs = env.BOUNDLESS_POLL_TIMEOUT_MS
    ? Math.max(5000, Number.parseInt(env.BOUNDLESS_POLL_TIMEOUT_MS, 10))
    : DEFAULT_BOUNDLESS_POLL_TIMEOUT_MS;

  const pinataJwt = env.PINATA_JWT?.trim() || null;

  return {
    rpcUrl,
    privateKey: normalizedKey as `0x${string}`,
    imageUrl,
    imageId: normalizedImageId as `0x${string}`,
    maxPriceUsd,
    minPriceUsd,
    lockCollateralBaseUnits,
    topUpBufferBps,
    pollTimeoutMs,
    flatPeriodSec,
    rampPeriodSec,
    lockTimeoutSec,
    timeoutSec,
    chainId,
    marketAddress,
    orderStreamUrl,
    deploymentBlock,
    pinataJwt,
  };
}
