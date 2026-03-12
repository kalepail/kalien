/**
 * E2E test: Boundless proof → Stellar claim pipeline.
 *
 * Full mode (submits new proof request with fresh tape):
 *   bun run scripts/test-boundless-submit.ts
 *
 * Claim-only mode (uses existing fulfilled request):
 *   bun run scripts/test-boundless-submit.ts --request-id 0x...
 *
 * Secrets (loaded from scripts/.env → .dev.vars → .env, highest priority first):
 *   BOUNDLESS_PRIVATE_KEY  — EVM wallet private key (only needed in full mode)
 *   PINATA_JWT             — Pinata API JWT for IPFS uploads (only needed in full mode)
 *   RELAYER_API_KEY        — OpenZeppelin Relayer key for Stellar claim
 */

import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  hashTypedData,
  http,
  parseUnits,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { Address, xdr } from "@stellar/stellar-sdk";

import { encodeStdin } from "../worker/boundless/stdin";
import { boundlessMarketAbi, eip712Types } from "../worker/boundless/abi";
import type { ProofRequest } from "../worker/boundless/types";
import { buildProofArtifactV4, parseProofArtifactV4 } from "../worker/proof-artifact";
import { parseAndValidateTape } from "../worker/tape";
import { DEFAULT_BINDINGS_RPC_URL, DEFAULT_MAX_TAPE_BYTES } from "../worker/constants";
import { resolveUsdOfferToWei } from "../worker/boundless/pricing";
import { packJournalRaw, unpackJournalRaw, JOURNAL_LEN } from "../shared/stellar/journal";
import { Client as ScoreContractClient } from "asteroids-score";
import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels/dist/client";
import { AsteroidsGame } from "../src/game/AsteroidsGame";
import { Autopilot } from "../src/game/Autopilot";
import { env } from "./load-env";

// ── Parse CLI args ───────────────────────────────────────────────────────
const requestIdArg = (() => {
  const idx = process.argv.indexOf("--request-id");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
})();
const claimantArg = (() => {
  const idx = process.argv.indexOf("--claimant");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
})();
const claimOnly = requestIdArg !== null;

// ── Validate secrets ──────────────────────────────────────────────────────
if (!claimOnly && (!env.BOUNDLESS_PRIVATE_KEY || !env.PINATA_JWT)) {
  console.error("Missing BOUNDLESS_PRIVATE_KEY or PINATA_JWT in scripts/.env, .dev.vars, or .env");
  process.exit(1);
}
if (!env.RELAYER_API_KEY) {
  console.error("Missing RELAYER_API_KEY in scripts/.env, .dev.vars, or .env");
  process.exit(1);
}

// ── Base Mainnet deployment ──────────────────────────────────────────────
const CHAIN_ID = 8453n;
const MARKET_ADDRESS = "0xfd152dadc5183870710fe54f939eae3ab9f0fe82" as const;
const ORDER_STREAM_URL = "https://base-mainnet.boundless.network";
// BlastAPI is reliable for eth_getLogs (mainnet.base.org returns 503)
const RPC_URL = "https://base-mainnet.public.blastapi.io";

const RELAYER_API_KEY = env.RELAYER_API_KEY;
const IMAGE_URL =
  "https://gateway.pinata.cloud/ipfs/QmQ7m1WcrHH4TABWwYjroZzKPeSmqBXv8NeMHvwGFzFwrk";
const RAW_IMAGE_ID = (
  env.BOUNDLESS_IMAGE_ID ??
  env.PROVER_EXPECTED_IMAGE_ID ??
  "0x37dfd7b9ca6490f5db1e9cd4dfa5ceadae573e44c6fd351e9cdc2cb7138b8111"
).toLowerCase();
const IMAGE_ID = RAW_IMAGE_ID.startsWith("0x") ? RAW_IMAGE_ID : `0x${RAW_IMAGE_ID}`;

// Groth16V3_0 selector — explicitly request Groth16 proofs for Stellar
const GROTH16_SELECTOR = "0x73c457ba" as const;

const MAX_PRICE_USD = 0.1; // $0.10 — resolved to wei at submission via Chainlink
const MIN_PRICE_USD = 0; // zero floor — let the auction float from 0 up to max price
const LOCK_COLLATERAL_ZKC = env.BOUNDLESS_LOCK_COLLATERAL_ZKC?.trim() || "5";
const LOCK_COLLATERAL_BASE_UNITS = (() => {
  if (!LOCK_COLLATERAL_ZKC) return parseUnits("5", 18);
  try {
    return parseUnits(LOCK_COLLATERAL_ZKC, 18);
  } catch {
    return parseUnits("5", 18);
  }
})();
const TOP_UP_BUFFER_BPS = (() => {
  const raw = env.BOUNDLESS_TOP_UP_BUFFER_BPS?.trim();
  if (!raw) return 1500;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 1500;
  return Math.min(10_000, Math.max(0, parsed));
})();
const FLAT_PERIOD_SEC = 60; // 1 min prover discovery window before ramp
const RAMP_PERIOD_SEC = 660; // 11 min for price to ramp from minPrice to maxPrice
const LOCK_TIMEOUT_SEC = 1740; // 29 min from rampUpStart (11m ramp + 18m at max price)
const TIMEOUT_SEC = 3540; // lock (29m) + 30m expiry = 60m total
const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 65 * 60_000; // 65 minutes
const MAX_FRAMES = 36_000;

// Stellar testnet defaults (override with SCORE_CONTRACT_ID / STELLAR_NETWORK_PASSPHRASE env vars)
const SCORE_CONTRACT_ID =
  env.SCORE_CONTRACT_ID ??
  env.VITE_SCORE_CONTRACT_ID ??
  "CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU";
const STELLAR_NETWORK_PASSPHRASE =
  env.STELLAR_NETWORK_PASSPHRASE ??
  env.VITE_NETWORK_PASSPHRASE ??
  "Test SDF Network ; September 2015";
const STELLAR_RPC_URL = DEFAULT_BINDINGS_RPC_URL;
const RELAYER_URL = "https://channels.openzeppelin.com/testnet";
const CLAIMANT_ADDRESS =
  claimantArg ?? env.CLAIMANT_ADDRESS ?? "CDPAHIOTDASW6WULHAJ5UL4H6YH7OJ2T72LKVT75SCFDZ4YZTOVDFEQX";
const scoreClient = new ScoreContractClient({
  contractId: SCORE_CONTRACT_ID,
  rpcUrl: STELLAR_RPC_URL,
  networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
});

// Event fetch retry config
const EVENT_FETCH_RETRIES = 15;
const EVENT_FETCH_BACKOFF_MS = 20_000;

const publicClient = createPublicClient({
  chain: base,
  transport: http(RPC_URL),
});

// ProofDelivered event topic0
const PROOF_DELIVERED_TOPIC =
  "0xaf1db8f86d3f32029a484ff54c7ac1d7ef8f038ab050fc065af9e82eb9b850ca" as const;

// ── Helpers ──────────────────────────────────────────────────────────────
function formatEth(wei: bigint): string {
  const whole = wei / 1000000000000000000n;
  const frac = wei % 1000000000000000000n;
  const fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "") || "0";
  return `${whole}.${fracStr}`;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++)
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hexPairsToBytes(hex: string): Uint8Array {
  const pairs = hex.match(/.{2}/g);
  if (!pairs) {
    return new Uint8Array();
  }

  return new Uint8Array(pairs.map((pair) => Number.parseInt(pair, 16)));
}

/** Generate a fresh tape using the headless autopilot. */
function generateFreshTape(seed: number): Uint8Array {
  console.log(
    `  Generating tape with seed 0x${seed.toString(16).toUpperCase().padStart(8, "0")}...`,
  );
  const game = new AsteroidsGame({ headless: true, seed });
  game.startNewGame(seed);
  (game as unknown as { autopilot: Autopilot }).autopilot.setEnabled(true);

  let frame = 0;
  while (frame < MAX_FRAMES) {
    game.stepSimulation();
    frame++;
    if (game.getMode() === "game-over") break;
  }

  const tapeData = game.getTape();
  if (!tapeData) {
    console.error("  Failed to generate tape");
    process.exit(1);
  }

  console.log(
    `  Tape: ${frame} frames, score ${game.getScore()}, wave ${game.getWave()} (${tapeData.length} bytes)`,
  );
  return new Uint8Array(tapeData);
}

/**
 * Parse a ProofDelivered event's data field manually.
 * Avoids viem's decodeAbiParameters which has a BigInt-to-Number bug with uint256 fields.
 *
 * Event data layout: abi.encode(Fulfillment)
 *   word 0: offset to tuple (0x20 = 32)
 *   Tuple (Fulfillment):
 *     word 0: id (uint256) — skip
 *     word 1: requestDigest (bytes32) — skip
 *     word 2: claimDigest (bytes32) — skip
 *     word 3: fulfillmentDataType (uint8)
 *     word 4: offset to fulfillmentData (relative to tuple start)
 *     word 5: offset to seal (relative to tuple start)
 *   Dynamic data follows.
 *
 * fulfillmentData (when type=1, ImageIdAndJournal) = abi.encode(bytes32, bytes):
 *     word 0: imageId (bytes32)
 *     word 1: offset to journal (0x40 = 64)
 *     word 2: journal length
 *     word 3+: journal data
 */
function parseFulfillmentFromEventData(
  data: string,
): { seal: Uint8Array; journal: Uint8Array } | null {
  const clean = data.startsWith("0x") ? data.slice(2) : data;
  const readWordAt = (charOffset: number) => clean.slice(charOffset, charOffset + 64);
  const readUintAt = (charOffset: number) => Number.parseInt(readWordAt(charOffset), 16);

  // Outer: offset to Fulfillment tuple
  const tupleByteOffset = readUintAt(0);
  const t = tupleByteOffset * 2; // tuple start in hex chars

  // Fulfillment head
  const fulfillmentDataType = readUintAt(t + 3 * 64);
  const fdByteOffset = readUintAt(t + 4 * 64);
  const sealByteOffset = readUintAt(t + 5 * 64);

  // Read seal: length-prefixed bytes at sealByteOffset from tuple start
  const sealLenPos = t + sealByteOffset * 2;
  const sealLen = readUintAt(sealLenPos);
  const seal = hexToBytes(clean.slice(sealLenPos + 64, sealLenPos + 64 + sealLen * 2));

  if (fulfillmentDataType !== 1) {
    console.error(
      `  Unexpected fulfillmentDataType: ${fulfillmentDataType} (expected 1 = ImageIdAndJournal)`,
    );
    return null;
  }

  // Read fulfillmentData: length-prefixed bytes at fdByteOffset from tuple start
  const fdLenPos = t + fdByteOffset * 2;
  const fdLen = readUintAt(fdLenPos);
  const fdHex = clean.slice(fdLenPos + 64, fdLenPos + 64 + fdLen * 2);

  // fulfillmentData = abi.encode((bytes32, bytes)) — tuple-wrapped.
  // Skip the leading tuple offset (0x20) to get to the actual struct data.
  const firstWord = readUintAt(fdLenPos + 64);
  const innerHex = firstWord === 32 ? fdHex.slice(64) : fdHex;

  // innerHex layout: imageId (bytes32) | offset to journal | journal length | journal data
  const journalByteOffset = Number.parseInt(innerHex.slice(64, 128), 16);
  const journalLen = Number.parseInt(
    innerHex.slice(journalByteOffset * 2, journalByteOffset * 2 + 64),
    16,
  );
  const journal = hexToBytes(
    innerHex.slice(journalByteOffset * 2 + 64, journalByteOffset * 2 + 64 + journalLen * 2),
  );

  return { seal, journal };
}

// ── Route: Full mode vs claim-only ───────────────────────────────────────
let requestId: bigint;

if (claimOnly) {
  // ── Claim-only mode ────────────────────────────────────────────────────
  requestId = BigInt(requestIdArg);
  console.log("=== Boundless → Stellar E2E Test (claim-only mode) ===\n");
  console.log("Request ID:", requestIdArg);
  console.log("Claimant:", CLAIMANT_ADDRESS);
  console.log("");

  // Verify the request is actually fulfilled
  console.log("Verifying request is fulfilled...");
  const fulfilled = await publicClient.readContract({
    address: MARKET_ADDRESS,
    abi: boundlessMarketAbi,
    functionName: "requestIsFulfilled",
    args: [requestId],
  });
  if (!fulfilled) {
    console.error("  Request is NOT fulfilled. Use full mode to submit a new request.");
    process.exit(1);
  }
  console.log("  Confirmed: request is fulfilled on-chain\n");
} else {
  // ── Full mode: Generate tape + Submit to Boundless ──────────────────────
  const PRIVATE_KEY = env.BOUNDLESS_PRIVATE_KEY;
  const PINATA_JWT = env.PINATA_JWT;
  const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

  // Resolve USD pricing to wei via Chainlink ETH/USD feed
  const {
    ethPriceUsd,
    minPriceWei: minPrice,
    maxPriceWei: maxPrice,
  } = await resolveUsdOfferToWei({
    rpcUrl: RPC_URL,
    chainId: Number(CHAIN_ID),
    minPriceUsd: MIN_PRICE_USD,
    maxPriceUsd: MAX_PRICE_USD,
  });

  console.log("=== Boundless → Stellar E2E Test ===\n");
  console.log("Wallet:", account.address);
  console.log("Contract:", MARKET_ADDRESS);
  console.log("Selector:", GROTH16_SELECTOR, "(Groth16V3_0)");
  console.log(`ETH price: ${ethPriceUsd === null ? "not needed" : `$${ethPriceUsd.toFixed(2)}`}`);
  console.log(
    `Price: $${MIN_PRICE_USD} → $${MAX_PRICE_USD} (${formatEth(minPrice)} → ${formatEth(maxPrice)} ETH)`,
  );
  console.log(
    `Lock collateral: ${LOCK_COLLATERAL_BASE_UNITS.toString()} base units (${formatUnits(
      LOCK_COLLATERAL_BASE_UNITS,
      18,
    )} ZKC)`,
  );
  console.log(
    `Auction: ${FLAT_PERIOD_SEC / 60}m flat + ${RAMP_PERIOD_SEC / 60}m ramp + ${(LOCK_TIMEOUT_SEC - RAMP_PERIOD_SEC) / 60}m lock + ${(TIMEOUT_SEC - LOCK_TIMEOUT_SEC) / 60}m expiry = ${(FLAT_PERIOD_SEC + TIMEOUT_SEC) / 60}m total`,
  );
  console.log("Claimant:", CLAIMANT_ADDRESS);
  console.log("");

  const currentSeedResult = await scoreClient.current_seed();
  const currentSeed = currentSeedResult.result as {
    seed: number;
    seed_id: number;
  };
  const seedForRequest = currentSeed.seed >>> 0;
  const seedIdForRequest = currentSeed.seed_id >>> 0;
  console.log(
    `Using current on-chain seed: seed_id=${seedIdForRequest}, seed=0x${seedForRequest.toString(16).toUpperCase().padStart(8, "0")}`,
  );

  // Step 0: Generate fresh tape + encode stdin + upload to IPFS
  console.log("Step 0: Generating tape & uploading to IPFS...");
  const tapeBytes = generateFreshTape(seedForRequest);
  const stdinBytes = encodeStdin(tapeBytes, {
    seedId: seedIdForRequest,
    claimantAddress: CLAIMANT_ADDRESS,
  });
  console.log(`  Stdin: ${stdinBytes.length} bytes`);

  const hashBuffer = await crypto.subtle.digest("SHA-256", new Uint8Array(stdinBytes));
  const hashHex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const filename = `${hashHex}.input`;

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([new Uint8Array(stdinBytes)], {
      type: "application/octet-stream",
    }),
    filename,
  );
  formData.append("pinataMetadata", JSON.stringify({ name: filename }));

  const pinataResp = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST",
    headers: { Authorization: `Bearer ${PINATA_JWT}` },
    body: formData,
  });

  if (!pinataResp.ok) {
    const err = await pinataResp.text().catch(() => "");
    console.error(`  Pinata upload failed: ${pinataResp.status} ${err}`);
    process.exit(1);
  }

  const pinataResult = (await pinataResp.json()) as { IpfsHash?: string };
  if (!pinataResult.IpfsHash) {
    console.error("  Pinata response missing IpfsHash");
    process.exit(1);
  }
  const stdinUrl = `https://gateway.pinata.cloud/ipfs/${pinataResult.IpfsHash}`;
  console.log(`  Uploaded: ${stdinUrl}`);

  const stdinUrlHex = `0x${Array.from(new TextEncoder().encode(stdinUrl))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as Hex;

  // Step 1: Build + sign + submit on-chain
  console.log("\nStep 1: Signing & submitting on-chain...");
  const t0 = Date.now();

  const nonce = Date.now();
  requestId = (BigInt(account.address) << 32n) | BigInt(nonce >>> 0);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const rampUpStart = nowSec + BigInt(FLAT_PERIOD_SEC);

  // Compute DigestMatch predicate: bind to this exact tape by precomputing
  // the expected fixed-length AST4 journal and using sha256(journal).
  const tapeMeta = parseAndValidateTape(tapeBytes, DEFAULT_MAX_TAPE_BYTES);
  const expectedJournal = packJournalRaw({
    seed_id: seedIdForRequest >>> 0,
    seed: tapeMeta.seed >>> 0,
    frame_count: tapeMeta.frameCount >>> 0,
    final_score: tapeMeta.finalScore >>> 0,
    claimant: CLAIMANT_ADDRESS,
  });
  const journalDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", expectedJournal as unknown as BufferSource),
  );
  // DigestMatch data = abi.encodePacked(imageId, sha256(journal)) = 64 bytes
  const imageIdBytes = hexToBytes(IMAGE_ID);
  const predicateData = new Uint8Array(64);
  predicateData.set(imageIdBytes, 0);
  predicateData.set(journalDigest, 32);
  const predicateDataHex = `0x${Array.from(predicateData)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as Hex;
  console.log(`  Predicate data: ${predicateDataHex}`);

  const proofRequest: ProofRequest = {
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
      selector: GROTH16_SELECTOR,
    },
    imageUrl: IMAGE_URL,
    input: {
      inputType: 1,
      data: stdinUrlHex,
    },
    offer: {
      minPrice,
      maxPrice,
      rampUpStart,
      rampUpPeriod: RAMP_PERIOD_SEC,
      lockTimeout: LOCK_TIMEOUT_SEC,
      timeout: TIMEOUT_SEC,
      lockCollateral: LOCK_COLLATERAL_BASE_UNITS,
    },
  };

  const domain = {
    name: "IBoundlessMarket" as const,
    version: "1" as const,
    chainId: CHAIN_ID,
    verifyingContract: MARKET_ADDRESS,
  };

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(RPC_URL),
  });

  const signature = await walletClient.signTypedData({
    domain,
    types: eip712Types,
    primaryType: "ProofRequest",
    message: proofRequest,
  });

  let submitValueWei = 0n;
  let fundingModeUsed: "market_balance" | "attached_value_fallback" = "market_balance";
  let marketBalanceBeforeWei: bigint | null = null;
  let autoDepositWei: bigint | null = null;

  try {
    marketBalanceBeforeWei = await publicClient.readContract({
      address: MARKET_ADDRESS,
      abi: boundlessMarketAbi,
      functionName: "balanceOf",
      args: [account.address],
    });

    if (marketBalanceBeforeWei < maxPrice) {
      const deficitWei = maxPrice - marketBalanceBeforeWei;
      const bufferWei =
        TOP_UP_BUFFER_BPS > 0 ? (deficitWei * BigInt(TOP_UP_BUFFER_BPS) + 9_999n) / 10_000n : 0n;
      autoDepositWei = deficitWei + bufferWei;
      if (autoDepositWei > 0n) {
        const depositTxHash = await walletClient.writeContract({
          address: MARKET_ADDRESS,
          abi: boundlessMarketAbi,
          functionName: "deposit",
          args: [],
          value: autoDepositWei,
        });
        console.log(`  Deposited ${formatEth(autoDepositWei)} ETH to market (${depositTxHash})`);
      }
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fundingModeUsed = "attached_value_fallback";
    submitValueWei = maxPrice;
    console.log(`  Market-balance funding prep failed (${reason}); using attached-value fallback.`);
  }

  const txHash = await walletClient.writeContract({
    address: MARKET_ADDRESS,
    abi: boundlessMarketAbi,
    functionName: "submitRequest",
    args: [proofRequest, signature],
    value: submitValueWei,
  });

  const requestIdHex = `0x${requestId.toString(16)}`;
  const submitMs = Date.now() - t0;
  console.log(`  On-chain tx: ${txHash} (${(submitMs / 1000).toFixed(1)}s)`);
  console.log(`  Funding mode: ${fundingModeUsed}`);
  if (marketBalanceBeforeWei != null) {
    console.log(`  Market balance before submit: ${formatEth(marketBalanceBeforeWei)} ETH`);
  }
  if (autoDepositWei != null) {
    console.log(`  Auto-deposit amount: ${formatEth(autoDepositWei)} ETH`);
  }
  console.log(`  submitRequest value: ${formatEth(submitValueWei)} ETH`);
  console.log(`  BaseScan: https://basescan.org/tx/${txHash}`);
  console.log(`  Request ID: ${requestIdHex}`);

  // Step 2: Submit to order stream
  try {
    const requestDigest = hashTypedData({
      domain,
      types: eip712Types,
      primaryType: "ProofRequest",
      message: proofRequest,
    });

    const sigClean = signature.slice(2);
    const r = `0x${sigClean.slice(0, 64)}`;
    const s = `0x${sigClean.slice(64, 128)}`;
    const v = Number.parseInt(sigClean.slice(128, 130), 16);
    const yParity = v >= 27 ? v - 27 : v;

    const orderBody = {
      request: {
        id: requestIdHex,
        requirements: {
          callback: {
            addr: proofRequest.requirements.callback.addr,
            gasLimit: "0x0",
          },
          predicate: {
            predicateType: "DigestMatch",
            data: proofRequest.requirements.predicate.data,
          },
          selector: proofRequest.requirements.selector,
        },
        imageUrl: proofRequest.imageUrl,
        input: { inputType: "Url", data: stdinUrlHex },
        offer: {
          minPrice: `0x${proofRequest.offer.minPrice.toString(16)}`,
          maxPrice: `0x${proofRequest.offer.maxPrice.toString(16)}`,
          rampUpStart: Number(proofRequest.offer.rampUpStart),
          rampUpPeriod: proofRequest.offer.rampUpPeriod,
          lockTimeout: proofRequest.offer.lockTimeout,
          timeout: proofRequest.offer.timeout,
          lockCollateral: `0x${proofRequest.offer.lockCollateral.toString(16)}`,
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

    const resp = await fetch(`${ORDER_STREAM_URL}/api/v1/submit_order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderBody),
    });
    const osBody = await resp.text().catch(() => "");
    console.log(`  Order stream: ${resp.status} - ${osBody}`);
  } catch (e) {
    console.log(
      `  Order stream: failed (non-fatal) - ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  console.log(
    `\n  Submitted. ${FLAT_PERIOD_SEC / 60}m flat + ${RAMP_PERIOD_SEC / 60}m ramp starting.`,
  );
  console.log(
    `  Price: $${MIN_PRICE_USD} → $${MAX_PRICE_USD} (${formatEth(minPrice)} → ${formatEth(maxPrice)} ETH)`,
  );

  // Step 3: Poll for fulfillment
  console.log("\nStep 3: Polling for fulfillment...");
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let attempt = 0;

  /* eslint-disable no-await-in-loop -- polling and retry backoff must remain sequential */
  while (Date.now() < deadline) {
    attempt++;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`  [${elapsed}s] Poll #${attempt}... `);

    try {
      const fulfilled = await publicClient.readContract({
        address: MARKET_ADDRESS,
        abi: boundlessMarketAbi,
        functionName: "requestIsFulfilled",
        args: [requestId],
      });

      if (fulfilled) {
        console.log("FULFILLED!");
        const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`\n  Boundless fulfillment time: ${totalSec}s`);
        break;
      }

      console.log("running");
    } catch (e) {
      console.log(`error: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`);
    }

    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`\nTimed out after ${totalSec}s (${attempt} polls).`);
      console.log("Request ID:", requestIdHex);
      process.exit(1);
    }

    await sleepMs(POLL_INTERVAL_MS);
  }
  /* eslint-enable no-await-in-loop */
}

// ── Step 4: Fetch ProofDelivered event (with retries) ────────────────────
// Uses raw topic-based log fetching + manual hex parsing to avoid viem's
// BigInt-to-Number conversion bug with uint256 fields in the Fulfillment struct.
console.log("Step 4: Fetching ProofDelivered event...");
let seal: Uint8Array | null = null;
let journal: Uint8Array | null = null;

const requestIdTopic = `0x${requestId.toString(16).padStart(64, "0")}` as Hex;

/* eslint-disable no-await-in-loop -- event fetch retries must remain sequential */
for (let eventAttempt = 1; eventAttempt <= EVENT_FETCH_RETRIES; eventAttempt++) {
  try {
    const currentBlock = await publicClient.getBlockNumber();
    // BlastAPI ignores topic filters, returns ALL contract events.
    // We filter manually by topic[0] (event sig) AND topic[1] (requestId).
    const logs = await publicClient.request({
      method: "eth_getLogs",
      params: [
        {
          address: MARKET_ADDRESS,
          topics: [PROOF_DELIVERED_TOPIC, requestIdTopic],
          fromBlock: `0x${(currentBlock - 9900n).toString(16)}` as const,
          toBlock: `0x${currentBlock.toString(16)}` as const,
        },
      ],
    });

    const ourLog = logs.find((log) => {
      const topic0 = log.topics?.[0]?.toLowerCase();
      const topic1 = log.topics?.[1]?.toLowerCase();
      return (
        topic0 === PROOF_DELIVERED_TOPIC.toLowerCase() && topic1 === requestIdTopic.toLowerCase()
      );
    });

    if (ourLog?.data) {
      const parsed = parseFulfillmentFromEventData(ourLog.data as string);
      if (parsed) {
        seal = parsed.seal;
        journal = parsed.journal;
        console.log(
          `  Found on attempt ${eventAttempt}: seal ${seal.length} bytes, journal ${journal.length} bytes`,
        );
        break;
      }
    }

    console.log(
      `  Not found (attempt ${eventAttempt}/${EVENT_FETCH_RETRIES}), retrying in ${EVENT_FETCH_BACKOFF_MS / 1000}s...`,
    );
  } catch (e) {
    console.log(
      `  Event fetch error (attempt ${eventAttempt}/${EVENT_FETCH_RETRIES}): ${(e instanceof Error ? e.message : String(e)).slice(0, 100)}`,
    );
  }

  if (eventAttempt < EVENT_FETCH_RETRIES) {
    await sleepMs(EVENT_FETCH_BACKOFF_MS);
  }
}
/* eslint-enable no-await-in-loop */

if (!seal || !journal) {
  console.error(
    `\n  FAILED: Could not fetch ProofDelivered event after ${EVENT_FETCH_RETRIES} attempts.`,
  );
  console.error("  The proof was fulfilled on-chain but we couldn't retrieve the event data.");
  console.error("  Try again with:");
  console.error(
    `  bun run scripts/test-boundless-submit.ts --request-id 0x${requestId.toString(16)}`,
  );
  process.exit(1);
}

// ── Step 5: Validate seal & journal ──────────────────────────────────────
console.log("\nStep 5: Validating proof data...");

// Seal: 260 bytes = 4-byte selector + 256-byte Groth16 proof
if (seal.length !== 260) {
  console.error(`  FAIL: seal is ${seal.length} bytes (expected 260 for Groth16)`);
  console.error("  This likely means the prover delivered a non-Groth16 proof.");
  console.error("  Ensure the request uses selector 0x73c457ba (Groth16V3_0).");
  process.exit(1);
}
const selectorHex = `0x${Array.from(seal.slice(0, 4))
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("")}`;
console.log(`  Seal: ${seal.length} bytes, selector: ${selectorHex}`);
if (selectorHex !== GROTH16_SELECTOR) {
  console.error(`  FAIL: selector ${selectorHex} !== ${GROTH16_SELECTOR} (Groth16V3_0)`);
  process.exit(1);
}

// Journal: fixed 49-byte format.
if (journal.length !== JOURNAL_LEN) {
  console.error(`  FAIL: journal is ${journal.length} bytes (expected ${JOURNAL_LEN})`);
  process.exit(1);
}
const journalFields = unpackJournalRaw(journal);
console.log(
  `  Journal: seed_id=${journalFields.seed_id}, seed=0x${journalFields.seed.toString(16).toUpperCase().padStart(8, "0")}, claimant=${journalFields.claimant}, frames=${journalFields.frame_count}, score=${journalFields.final_score}`,
);

if (journalFields.final_score === 0) {
  console.error("  FAIL: score is zero");
  process.exit(1);
}
console.log("  PASS: seal and journal valid");

// ── Step 6: v4 artifact pipeline round-trip ──────────────────────────────
console.log("\nStep 6: Testing v4 artifact pipeline...");
const artifact = await buildProofArtifactV4("boundless", new Date().toISOString(), seal, journal);
const parsedArtifact = parseProofArtifactV4(artifact);
const parsedSeal = hexToBytes(parsedArtifact.seal_hex);
if (parsedSeal.length !== 260) {
  console.error(`  FAIL: parsed seal length ${parsedSeal.length} != 260`);
  process.exit(1);
}
for (let i = 0; i < 260; i += 1) {
  if (parsedSeal[i] !== seal[i]) {
    console.error("  FAIL: v4 artifact seal mismatch");
    process.exit(1);
  }
}
console.log("  PASS: v4 artifact seal matches original");

const parsedJournalBytes = hexToBytes(parsedArtifact.journal_raw_hex);
for (let i = 0; i < JOURNAL_LEN; i += 1) {
  if (parsedJournalBytes[i] !== journal[i]) {
    console.error("  FAIL: v4 artifact journal mismatch");
    process.exit(1);
  }
}
console.log("  PASS: v4 artifact journal matches original");

// ── Step 7: Build Soroban payload ────────────────────────────────────────
console.log("\nStep 7: Building Soroban submit_score payload...");

// Encode journal as hex (matching worker/queue/consumer.ts journalRawHex)
const journalBuf = packJournalRaw(journalFields);
const journalRawHex = Array.from(journalBuf)
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

// SHA-256 digest of the journal (for logging)
const journalDigestBytes = new Uint8Array(
  await crypto.subtle.digest("SHA-256", hexPairsToBytes(journalRawHex) as BufferSource),
);
const journalDigestHex = Array.from(journalDigestBytes)
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");
console.log(`  Journal hex: ${journalRawHex} (${journalBuf.length} bytes)`);
console.log(`  Journal SHA-256: ${journalDigestHex}`);

const stellarSeal = parsedSeal;

// Check what imageId the contract currently has stored
try {
  const storedImageId = await scoreClient.image_id();
  const storedHex = Buffer.from(storedImageId.result as unknown as Uint8Array).toString("hex");
  console.log(`  Contract imageId: 0x${storedHex}`);
  console.log(`  Our ELF imageId:  ${IMAGE_ID}`);
  if (`0x${storedHex}` !== IMAGE_ID) {
    console.error("  WARNING: imageId MISMATCH — contract needs set_image_id update");
  }
} catch (e) {
  console.log(
    `  Could not read contract imageId: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`,
  );
}

const invokeArgs = new xdr.InvokeContractArgs({
  contractAddress: Address.fromString(SCORE_CONTRACT_ID).toScAddress(),
  functionName: "submit_score",
  args: [xdr.ScVal.scvBytes(Buffer.from(stellarSeal)), xdr.ScVal.scvBytes(Buffer.from(journalBuf))],
});
const hostFn = xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs);
const payload = {
  func: hostFn.toXDR("base64"),
  auth: [] as string[],
};
console.log(
  `  Payload built: func=${payload.func.length} chars, ${payload.auth.length} auth entries`,
);
console.log("  PASS: Soroban payload built successfully");

// ── Step 8: Submit to Stellar via Channels relayer ───────────────────────
console.log("\nStep 8: Submitting to Stellar testnet via Channels relayer...");

const channelsClient = new ChannelsClient({
  baseUrl: RELAYER_URL,
  apiKey: RELAYER_API_KEY,
  timeout: 60_000,
});

try {
  const result = await channelsClient.submitSorobanTransaction(payload);
  const txHashStellar = result.hash?.trim() ?? "";
  const status = result.status?.trim().toLowerCase() ?? "";

  if (txHashStellar.length > 0) {
    console.log(`  Stellar tx: ${txHashStellar} (status: ${status})`);
    console.log(`  Explorer: https://stellar.expert/explorer/testnet/tx/${txHashStellar}`);
    console.log("\n=== E2E Test PASSED — Full Boundless → Stellar Pipeline ===");
    process.exit(0);
  } else {
    console.error(`  Relayer accepted but no tx hash returned (status: ${status})`);
    process.exit(1);
  }
} catch (error) {
  const errObj = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const details =
    typeof errObj.errorDetails === "string"
      ? errObj.errorDetails.toLowerCase()
      : JSON.stringify(errObj.errorDetails ?? errObj.details ?? "").toLowerCase();
  const combined = `${msg} ${details}`;
  // Expected contract rejections are still a valid E2E test
  if (
    combined.includes("score not improved") ||
    combined.includes("scorenotimproved") ||
    /contract,\s*#5\b/.test(combined)
  ) {
    console.log(`  Contract rejected: ScoreNotImproved (existing score is higher)`);
    console.log("  This is expected if the same tape was submitted before.");
    console.log("\n=== E2E Test PASSED — Pipeline valid, score already claimed ===");
    process.exit(0);
  }
  if (
    combined.includes("already claimed") ||
    combined.includes("journalalreadyclaimed") ||
    /contract,\s*#3\b/.test(combined)
  ) {
    console.log(`  Contract rejected: JournalAlreadyClaimed`);
    console.log("  This is expected if the same proof was submitted before.");
    console.log("\n=== E2E Test PASSED — Pipeline valid, journal already claimed ===");
    process.exit(0);
  }
  console.error(
    `  Relayer submission failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
