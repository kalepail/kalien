#!/usr/bin/env bun
/**
 * E2E test: Fresh Asteroids run -> VastAI proof -> Stellar submit_score claim.
 *
 * Usage:
 *   bun run scripts/test-vast-submit.ts
 *   bun run scripts/test-vast-submit.ts --prover https://risc0-kalien.stellar.buzz
 *   bun run scripts/test-vast-submit.ts --claimant CDPA...
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Address, xdr } from "@stellar/stellar-sdk";
import { Client as ScoreContractClient } from "asteroids-score";
import { ChannelsClient } from "@openzeppelin/relayer-plugin-channels/dist/client";

import { AsteroidsGame } from "../src/game/AsteroidsGame";
import { Autopilot } from "../src/game/Autopilot";
import { parseAndValidateTape } from "../worker/tape";
import { DEFAULT_BINDINGS_RPC_URL, DEFAULT_MAX_TAPE_BYTES } from "../worker/constants";
import { packJournalRaw, unpackJournalRaw } from "../shared/stellar/journal";
import { parseClaimantStrKeyFromUserInput } from "../shared/stellar/strkey";
import { env } from "./load-env";

interface ProverCreateResponse {
  success: boolean;
  job_id: string;
  status_url: string;
  error?: string;
}

interface Groth16Receipt {
  inner?: {
    Groth16?: {
      seal: number[];
      verifier_parameters: number[];
    };
  };
}

interface ProverJobResponse {
  success: boolean;
  status: "queued" | "running" | "succeeded" | "failed";
  error?: string;
  result?: {
    elapsed_ms: number;
    proof: {
      requested_receipt_kind: string;
      produced_receipt_kind: string;
      journal: {
        seed_id: number;
        seed: number;
        frame_count: number;
        final_score: number;
        claimant: string;
      };
      receipt: Groth16Receipt;
      stats?: {
        segments?: number;
        total_cycles?: number;
      };
    };
  };
}

function parseArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return null;
}

const CLAIMANT_DEFAULT = "CDPAHIOTDASW6WULHAJ5UL4H6YH7OJ2T72LKVT75SCFDZ4YZTOVDFEQX";
const CLAIMANT_ADDRESS = parseArg("--claimant") ?? env.CLAIMANT_ADDRESS ?? CLAIMANT_DEFAULT;
const PROVER_URL = (
  parseArg("--prover") ??
  env.PROVER_BASE_URL ??
  "https://risc0-kalien.stellar.buzz"
).replace(/\/$/, "");
const SEGMENT_LIMIT_PO2 = Number.parseInt(parseArg("--segment-limit-po2") ?? "21", 10);
const MAX_FRAMES = Number.parseInt(parseArg("--max-frames") ?? "36000", 10);
const POLL_INTERVAL_MS = Number.parseInt(parseArg("--poll-ms") ?? "5000", 10);
const POLL_TIMEOUT_MS = Number.parseInt(parseArg("--poll-timeout-ms") ?? `${20 * 60 * 1000}`, 10);
const RELAYER_URL = "https://channels.openzeppelin.com/testnet";

const SCORE_CONTRACT_ID =
  env.SCORE_CONTRACT_ID ??
  env.VITE_SCORE_CONTRACT_ID ??
  "CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU";
const STELLAR_NETWORK_PASSPHRASE =
  env.STELLAR_NETWORK_PASSPHRASE ??
  env.CLAIM_NETWORK_PASSPHRASE ??
  env.VITE_NETWORK_PASSPHRASE ??
  "Test SDF Network ; September 2015";
const STELLAR_RPC_URL = env.STELLAR_RPC_URL ?? DEFAULT_BINDINGS_RPC_URL;

if (!env.RELAYER_API_KEY) {
  console.error("Missing RELAYER_API_KEY in scripts/.env, .dev.vars, or .env");
  process.exit(1);
}

try {
  parseClaimantStrKeyFromUserInput(CLAIMANT_ADDRESS);
} catch (error) {
  console.error(`Invalid claimant address: ${String(error)}`);
  process.exit(1);
}

if (!Number.isFinite(MAX_FRAMES) || MAX_FRAMES < 1) {
  console.error("--max-frames must be a positive integer");
  process.exit(1);
}

if (!Number.isFinite(SEGMENT_LIMIT_PO2) || SEGMENT_LIMIT_PO2 < 1) {
  console.error("--segment-limit-po2 must be a positive integer");
  process.exit(1);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function extractSeal(receipt: Groth16Receipt): Uint8Array {
  const groth16 = receipt?.inner?.Groth16;
  if (!groth16) {
    throw new Error("proof receipt is missing inner.Groth16");
  }

  if (!Array.isArray(groth16.seal) || groth16.seal.length !== 256) {
    throw new Error(`expected Groth16 seal length 256, got ${groth16.seal?.length ?? "missing"}`);
  }
  if (!Array.isArray(groth16.verifier_parameters) || groth16.verifier_parameters.length !== 8) {
    throw new Error(
      `expected verifier_parameters length 8, got ${groth16.verifier_parameters?.length ?? "missing"}`,
    );
  }

  const vpBytes = new Uint8Array(32);
  const vpView = new DataView(vpBytes.buffer);
  for (let i = 0; i < 8; i += 1) {
    vpView.setUint32(i * 4, groth16.verifier_parameters[i], true);
  }

  const selector = vpBytes.slice(0, 4);
  const seal = new Uint8Array(260);
  seal.set(selector, 0);
  seal.set(groth16.seal, 4);
  return seal;
}

function generateFreshTape(seed: number, maxFrames: number): Uint8Array {
  const game = new AsteroidsGame({ headless: true, seed });
  game.startNewGame(seed);
  (game as unknown as { autopilot: Autopilot }).autopilot.setEnabled(true);

  let frame = 0;
  while (frame < maxFrames) {
    game.stepSimulation();
    frame += 1;
    if (game.getMode() === "game-over") {
      break;
    }
  }

  const tape = game.getTape();
  if (!tape) {
    throw new Error("failed to generate tape bytes from game");
  }
  return new Uint8Array(tape);
}

async function submitTape(
  tapeBytes: Uint8Array,
  seedId: number,
  claimantAddress: string,
): Promise<string> {
  const params = new URLSearchParams({
    receipt_kind: "groth16",
    segment_limit_po2: String(SEGMENT_LIMIT_PO2),
    verify_mode: "policy",
    seed_id: String(seedId >>> 0),
    claimant: claimantAddress,
  });

  const response = await fetch(`${PROVER_URL}/api/jobs/prove-tape/raw?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: asArrayBuffer(tapeBytes),
  });

  const body = (await response.json()) as ProverCreateResponse;
  if (!response.ok || !body.success || !body.job_id) {
    throw new Error(`submit failed (${response.status}): ${body.error ?? JSON.stringify(body)}`);
  }
  return body.job_id;
}

async function pollJob(jobId: string): Promise<NonNullable<ProverJobResponse["result"]>> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  /* eslint-disable no-await-in-loop -- prover polling must remain sequential */
  while (Date.now() < deadline) {
    const response = await fetch(`${PROVER_URL}/api/jobs/${jobId}`);
    const body = (await response.json()) as ProverJobResponse;

    if (body.status === "succeeded") {
      if (!body.result) {
        throw new Error("job succeeded but result is missing");
      }
      return body.result;
    }
    if (body.status === "failed") {
      throw new Error(`job failed: ${body.error ?? "unknown prover error"}`);
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  /* eslint-enable no-await-in-loop */

  throw new Error(`job timed out after ${POLL_TIMEOUT_MS}ms`);
}

async function main(): Promise<void> {
  const scoreClient = new ScoreContractClient({
    contractId: SCORE_CONTRACT_ID,
    rpcUrl: STELLAR_RPC_URL,
    networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
  });

  console.log("=== VastAI -> Stellar E2E Test ===\n");
  console.log(`Prover: ${PROVER_URL}`);
  console.log(`Claimant: ${CLAIMANT_ADDRESS}`);
  console.log(`Contract: ${SCORE_CONTRACT_ID}`);
  console.log(`Max frames: ${MAX_FRAMES}`);
  console.log(`Segment limit po2: ${SEGMENT_LIMIT_PO2}`);

  const healthResp = await fetch(`${PROVER_URL}/health`);
  if (!healthResp.ok) {
    throw new Error(`prover health failed: HTTP ${healthResp.status}`);
  }
  const proverHealth = (await healthResp.json()) as {
    image_id?: string;
    ruleset?: string;
    rules_digest_hex?: string;
    accelerator?: string;
  };
  console.log(
    `Health: accelerator=${proverHealth.accelerator ?? "n/a"} ruleset=${proverHealth.ruleset ?? "n/a"} image_id=${proverHealth.image_id ?? "n/a"}`,
  );

  const currentSeedResult = await scoreClient.current_seed();
  const currentSeed = currentSeedResult.result as {
    seed: number;
    seed_id: number;
  };
  const seed = currentSeed.seed >>> 0;
  const seedId = currentSeed.seed_id >>> 0;
  console.log(
    `Current seed: seed_id=${seedId}, seed=0x${seed.toString(16).toUpperCase().padStart(8, "0")}`,
  );

  console.log("\nStep 1: Generating fresh tape...");
  const tapeBytes = generateFreshTape(seed, MAX_FRAMES);
  const tapeMeta = parseAndValidateTape(tapeBytes, DEFAULT_MAX_TAPE_BYTES);
  console.log(
    `  Tape: ${tapeBytes.length} bytes, frames=${tapeMeta.frameCount}, score=${tapeMeta.finalScore}`,
  );
  if (tapeMeta.finalScore >>> 0 === 0) {
    throw new Error("generated tape has final_score=0; increase --max-frames and retry");
  }

  console.log("\nStep 2: Submitting tape to VastAI prover...");
  const submitAt = Date.now();
  const jobId = await submitTape(tapeBytes, seedId, CLAIMANT_ADDRESS);
  console.log(`  Job ID: ${jobId}`);

  console.log("\nStep 3: Polling proof job...");
  const result = await pollJob(jobId);
  const elapsedSec = ((Date.now() - submitAt) / 1000).toFixed(1);
  const proof = result.proof;
  console.log(
    `  Prover done in ${elapsedSec}s (reported ${result.elapsed_ms}ms), receipt=${proof.requested_receipt_kind}->${proof.produced_receipt_kind}`,
  );

  if (proof.requested_receipt_kind !== "groth16" || proof.produced_receipt_kind !== "groth16") {
    throw new Error(
      `expected groth16 proof, got requested=${proof.requested_receipt_kind} produced=${proof.produced_receipt_kind}`,
    );
  }

  const seal = extractSeal(proof.receipt);
  const journalRaw = packJournalRaw({
    seed_id: proof.journal.seed_id >>> 0,
    seed: proof.journal.seed >>> 0,
    frame_count: proof.journal.frame_count >>> 0,
    final_score: proof.journal.final_score >>> 0,
    claimant: proof.journal.claimant,
  });
  const journal = unpackJournalRaw(journalRaw);
  const journalDigest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", asArrayBuffer(journalRaw)),
  );

  console.log("\nStep 4: Validating seal + journal...");
  if (seal.length !== 260) {
    throw new Error(`expected 260-byte seal, got ${seal.length}`);
  }
  if (journal.final_score === 0) {
    throw new Error("journal final_score is zero");
  }
  if (journal.seed_id !== seedId || journal.seed !== seed) {
    throw new Error(
      `journal seed mismatch: got seed_id=${journal.seed_id}, seed=0x${journal.seed.toString(16)} expected seed_id=${seedId}, seed=0x${seed.toString(16)}`,
    );
  }
  if (journal.claimant !== CLAIMANT_ADDRESS) {
    throw new Error(`journal claimant mismatch: got ${journal.claimant}`);
  }
  console.log(
    `  Journal: seed_id=${journal.seed_id}, seed=0x${journal.seed.toString(16).toUpperCase().padStart(8, "0")}, frames=${journal.frame_count}, score=${journal.final_score}`,
  );
  console.log(`  Seal bytes: ${seal.length}, journal bytes: ${journalRaw.length}`);
  console.log(`  Journal digest: ${bytesToHex(journalDigest)}`);

  const outPrefix = join(tmpdir(), `e2e-vast-proof-${Date.now()}`);
  writeFileSync(`${outPrefix}.seal`, bytesToHex(seal));
  writeFileSync(`${outPrefix}.journal_raw`, bytesToHex(journalRaw));
  writeFileSync(
    `${outPrefix}.image_id`,
    (proverHealth.image_id ?? "").replace(/^0x/, "").toLowerCase(),
  );
  console.log(`  Artifacts: ${outPrefix}.seal/.journal_raw/.image_id`);

  console.log("\nStep 5: Building submit_score payload...");
  const invokeArgs = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(SCORE_CONTRACT_ID).toScAddress(),
    functionName: "submit_score",
    args: [xdr.ScVal.scvBytes(Buffer.from(seal)), xdr.ScVal.scvBytes(Buffer.from(journalRaw))],
  });
  const hostFn = xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs);
  const payload = {
    func: hostFn.toXDR("base64"),
    auth: [] as string[],
  };

  try {
    const imageResult = await scoreClient.image_id();
    const contractImage = bytesToHex(imageResult.result as unknown as Uint8Array);
    const proverImage = (proverHealth.image_id ?? "").replace(/^0x/, "").toLowerCase();
    console.log(`  Contract image_id: ${contractImage}`);
    console.log(`  Prover image_id:   ${proverImage || "n/a"}`);
    if (proverImage && proverImage !== contractImage) {
      console.log("  WARNING: prover/contract image_id mismatch");
    }
  } catch (error) {
    console.log(`  WARNING: unable to read contract image_id (${String(error)})`);
  }

  console.log("\nStep 6: Submitting claim via Channels relayer...");
  const channelsClient = new ChannelsClient({
    baseUrl: RELAYER_URL,
    apiKey: env.RELAYER_API_KEY,
    timeout: 60_000,
  });

  try {
    const relayerResult = await channelsClient.submitSorobanTransaction(payload);
    const txHash = relayerResult.hash?.trim() ?? "";
    const status = relayerResult.status?.trim().toLowerCase() ?? "";
    if (!txHash) {
      throw new Error(`relayer returned no tx hash (status=${status || "unknown"})`);
    }
    console.log(`  Stellar tx: ${txHash} (status: ${status})`);
    console.log(`  Explorer: https://stellar.expert/explorer/testnet/tx/${txHash}`);
    console.log("\n=== E2E Test PASSED — Full VastAI -> Stellar Pipeline ===");
    return;
  } catch (error) {
    const errObj = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
    const details =
      typeof errObj.errorDetails === "string"
        ? errObj.errorDetails.toLowerCase()
        : JSON.stringify(errObj.errorDetails ?? errObj.details ?? "").toLowerCase();
    const combined = `${msg} ${details}`;

    if (
      combined.includes("score not improved") ||
      combined.includes("scorenotimproved") ||
      /contract,\s*#5\b/.test(combined)
    ) {
      console.log("  Contract rejected: ScoreNotImproved (already have a better score)");
      console.log("\n=== E2E Test PASSED — Pipeline valid, score already claimed ===");
      return;
    }
    if (
      combined.includes("already claimed") ||
      combined.includes("journalalreadyclaimed") ||
      /contract,\s*#3\b/.test(combined)
    ) {
      console.log("  Contract rejected: JournalAlreadyClaimed");
      console.log("\n=== E2E Test PASSED — Pipeline valid, journal already claimed ===");
      return;
    }

    throw error;
  }
}

await main().catch((error) => {
  console.error(`\nE2E test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
