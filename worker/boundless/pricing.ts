import { createPublicClient, defineChain, http } from "viem";

/**
 * Chainlink AggregatorV3 ETH/USD feed addresses by chainId.
 * These return price with 8 decimals (e.g. 190000000000 = $1,900.00).
 */
const CHAINLINK_ETH_USD: Record<number, `0x${string}`> = {
  8453: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", // Base Mainnet
  84532: "0x4aDC67D868764f26767b334cC520Bdd76681A956", // Base Sepolia
  11155111: "0x694AA1769357215DE4FAC081bf1f309aDC325306", // Ethereum Sepolia
};

const aggregatorV3Abi = [
  {
    type: "function",
    name: "latestRoundData",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
  },
] as const;

const PRICE_CACHE_TTL_MS = 5 * 60_000; // 5 minutes

let cachedPrice: { chainId: number; price: number; fetchedAt: number } | null = null;

/** Clear the in-memory price cache. Exported for tests. */
export function resetEthPriceCache(): void {
  cachedPrice = null;
}

/**
 * Fetch the current ETH/USD price from Chainlink on the given chain.
 * Returns the price in USD (e.g. 1900.50).
 * Results are cached in memory for 5 minutes to avoid redundant RPC calls.
 */
export async function fetchEthPriceUsd(rpcUrl: string, chainId: number): Promise<number> {
  const now = Date.now();
  if (
    cachedPrice &&
    cachedPrice.chainId === chainId &&
    now - cachedPrice.fetchedAt < PRICE_CACHE_TTL_MS
  ) {
    return cachedPrice.price;
  }

  const feedAddress = CHAINLINK_ETH_USD[chainId];
  if (!feedAddress) {
    throw new Error(`no Chainlink ETH/USD feed configured for chainId ${chainId}`);
  }

  const chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  const client = createPublicClient({ chain, transport: http(rpcUrl) });

  const [, answer] = await client.readContract({
    address: feedAddress,
    abi: aggregatorV3Abi,
    functionName: "latestRoundData",
  });

  const price = Number(answer) / 1e8;
  if (price <= 0) {
    throw new Error(`Chainlink returned invalid ETH price: ${price}`);
  }

  cachedPrice = { chainId, price, fetchedAt: now };
  return price;
}

/**
 * Convert a USD amount to wei using the current ETH/USD price.
 * Uses scaled integer arithmetic to avoid floating-point precision issues.
 */
export function usdToWei(usd: number, ethPriceUsd: number): bigint {
  // Scale both to micro-units (6 decimal places) before BigInt conversion
  const usdMicro = BigInt(Math.round(usd * 1e6));
  const priceMicro = BigInt(Math.round(ethPriceUsd * 1e6));
  return (usdMicro * 10n ** 18n) / priceMicro;
}

export async function resolveUsdOfferToWei(options: {
  rpcUrl: string;
  chainId: number;
  minPriceUsd: number;
  maxPriceUsd: number;
}): Promise<{
  ethPriceUsd: number | null;
  minPriceWei: bigint;
  maxPriceWei: bigint;
}> {
  const minPriceUsd = options.minPriceUsd > 0 ? options.minPriceUsd : 0;
  const maxPriceUsd = options.maxPriceUsd > 0 ? options.maxPriceUsd : 0;

  if (minPriceUsd === 0 && maxPriceUsd === 0) {
    return {
      ethPriceUsd: null,
      minPriceWei: 0n,
      maxPriceWei: 0n,
    };
  }

  const ethPriceUsd = await fetchEthPriceUsd(options.rpcUrl, options.chainId);
  return {
    ethPriceUsd,
    minPriceWei: minPriceUsd === 0 ? 0n : usdToWei(minPriceUsd, ethPriceUsd),
    maxPriceWei: maxPriceUsd === 0 ? 0n : usdToWei(maxPriceUsd, ethPriceUsd),
  };
}

/**
 * Convert a wei amount to USD using the current ETH/USD price.
 * Inverse of usdToWei. Uses scaled integer arithmetic.
 */
export function weiToUsd(wei: bigint, ethPriceUsd: number): number {
  const priceMicro = BigInt(Math.round(ethPriceUsd * 1e6));
  const usdMicro = (wei * priceMicro) / 10n ** 18n;
  return Number(usdMicro) / 1e6;
}
