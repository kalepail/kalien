/**
 * End-to-end leaderboard test: generate tapes → submit through worker →
 * prover → on-chain claim → RPC event ingestion → leaderboard verification.
 *
 * Usage: bun scripts/e2e-leaderboard.ts [--runs N] [--max-frames N]
 *
 * Requirements:
 *   - Local dev server running: bun dev
 *   - Vast.ai prover reachable
 *   - Relayer configured in .dev.vars
 */

import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { AsteroidsGame } from "../src/game/AsteroidsGame";
import { TapeInputSource } from "../src/game/input-source";
import { Autopilot } from "../src/game/Autopilot";
import { deserializeTape } from "../src/game/tape";

const BASE_URL = "http://localhost:5173";
const CLAIMANT = "CDPAHIOTDASW6WULHAJ5UL4H6YH7OJ2T72LKVT75SCFDZ4YZTOVDFEQX";

// Parse args
let NUM_RUNS = 10;
let MAX_FRAMES = 6_000; // ~100s of gameplay, keeps proofs fast

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--runs" && args[i + 1]) NUM_RUNS = parseInt(args[++i], 10);
  if (args[i] === "--max-frames" && args[i + 1]) MAX_FRAMES = parseInt(args[++i], 10);
}

// ── Tape generation ─────────────────────────────────────────────────

interface TapeInfo {
  path: string;
  seed: number;
  frames: number;
  score: number;
  bytes: Uint8Array;
}

function generateTape(seed: number, maxFrames: number, outputPath: string): TapeInfo {
  // Generate tape using headless game + built-in autopilot
  const game = new AsteroidsGame({ headless: true, seed });
  game.startNewGame(seed);

  // Enable the internal autopilot
  (game as unknown as { autopilot: Autopilot }).autopilot.setEnabled(true);

  let frame = 0;
  while (frame < maxFrames) {
    game.stepSimulation();
    frame++;
    if (game.getMode() === "game-over") break;
  }

  const tapeData = game.getTape();
  if (!tapeData) {
    throw new Error(
      `Failed to get tape data for seed 0x${seed.toString(16).toUpperCase().padStart(8, "0")}`,
    );
  }
  writeFileSync(outputPath, tapeData);

  // Verify
  const rawTape = new Uint8Array(readFileSync(outputPath));
  const tape = deserializeTape(rawTape, maxFrames);

  const verifyGame = new AsteroidsGame({
    headless: true,
    seed: tape.header.seed,
  });
  verifyGame.startNewGame(tape.header.seed);
  const verifySource = new TapeInputSource(tape.inputs);
  verifyGame.setInputSource(verifySource);

  for (let i = 0; i < tape.header.frameCount; i++) {
    verifyGame.stepSimulation();
  }

  const vScore = verifyGame.getScore();

  if (vScore !== tape.footer.finalScore) {
    throw new Error(
      `Tape verification failed for seed 0x${seed.toString(16).toUpperCase().padStart(8, "0")}`,
    );
  }

  return {
    path: outputPath,
    seed,
    frames: tape.header.frameCount,
    score: tape.footer.finalScore,
    bytes: rawTape,
  };
}

// ── Worker API helpers ──────────────────────────────────────────────

interface JobStatus {
  jobId: string;
  status: string;
  claim?: { status: string; txHash?: string };
  proof?: { journal?: Record<string, number> };
}

async function submitTape(tape: TapeInfo): Promise<string> {
  const seedId = Math.floor(Date.now() / 1000 / 600);
  const params = new URLSearchParams({
    claimant: CLAIMANT,
    seed_id: String(seedId >>> 0),
  });
  const response = await fetch(`${BASE_URL}/api/proofs/jobs?${params.toString()}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(tape.bytes),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Submit failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    success: boolean;
    job: { jobId: string };
  };
  if (!data.success) {
    throw new Error(`Submit rejected: ${JSON.stringify(data)}`);
  }
  return data.job.jobId;
}

async function getJobStatus(jobId: string): Promise<JobStatus> {
  const response = await fetch(`${BASE_URL}/api/proofs/jobs/${jobId}`);
  if (!response.ok) {
    throw new Error(`Job status failed (${response.status})`);
  }
  const data = (await response.json()) as { job: JobStatus };
  return data.job;
}

async function waitForJob(jobId: string, timeoutMs = 600_000): Promise<JobStatus> {
  const deadline = Date.now() + timeoutMs;

  /* eslint-disable no-await-in-loop -- job polling must remain sequential */
  while (Date.now() < deadline) {
    const status = await getJobStatus(jobId);

    // Job is fully done when proof succeeded AND claim has a txHash (or claim failed)
    if (status.status === "succeeded" && status.claim?.txHash) {
      return status;
    }
    if (status.status === "succeeded" && status.claim?.status === "failed") {
      return status;
    }
    if (status.status === "failed") {
      throw new Error(`Job ${jobId} failed: ${JSON.stringify(status)}`);
    }

    await new Promise((r) => setTimeout(r, 5_000));
  }
  /* eslint-enable no-await-in-loop */

  // If we timed out but proof succeeded, return what we have
  const finalStatus = await getJobStatus(jobId);
  if (finalStatus.status === "succeeded") {
    return finalStatus;
  }
  throw new Error(`Job ${jobId} timed out after ${timeoutMs / 1000}s`);
}

// ── Leaderboard helpers ─────────────────────────────────────────────

interface LeaderboardEntry {
  rank: number;
  claimantAddress: string;
  score: number;
  seed: number;
  frameCount: number;
  mintedDelta: number;
}

async function getLeaderboard(
  window = "all",
  limit = 50,
): Promise<{
  entries: LeaderboardEntry[];
  total: number;
  ingestion: { total_events: number; highest_ledger: number };
}> {
  const response = await fetch(
    `${BASE_URL}/api/leaderboard?window=${window}&limit=${limit}&address=${CLAIMANT}`,
  );
  const data = (await response.json()) as Record<string, unknown>;
  return {
    entries: data.entries as LeaderboardEntry[],
    total: (data.pagination as { total: number }).total,
    ingestion: data.ingestion as {
      total_events: number;
      highest_ledger: number;
    },
  };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== E2E Leaderboard Test: ${NUM_RUNS} runs ===\n`);

  // Check dev server is running
  try {
    const health = await fetch(`${BASE_URL}/api/health`);
    if (!health.ok) throw new Error(`Health check failed: ${health.status}`);
    const healthData = (await health.json()) as Record<string, unknown>;
    const prover = healthData.prover as Record<string, unknown>;
    console.log(`Worker: OK (prover ${prover?.status})`);
    if (prover?.status !== "healthy" && prover?.status !== "compatible") {
      console.error(`Prover status: ${prover?.status} — aborting`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`Dev server not reachable at ${BASE_URL}:`, error);
    process.exit(1);
  }

  // Get initial leaderboard state
  const initialLb = await getLeaderboard();
  console.log(
    `Leaderboard before: ${initialLb.total} players, ${initialLb.ingestion.total_events} events\n`,
  );

  // Step 1: Generate tapes
  console.log(`--- Step 1: Generating ${NUM_RUNS} tapes (max ${MAX_FRAMES} frames each) ---`);
  const tapes: TapeInfo[] = [];
  const tmpDir = "/tmp/claude";

  for (let i = 0; i < NUM_RUNS; i++) {
    const seed = (Date.now() + i * 1337) >>> 0;
    const path = join(tmpDir, `e2e-tape-${i}-${seed.toString(16)}.tape`);
    const tape = generateTape(seed, MAX_FRAMES, path);
    tapes.push(tape);
    console.log(
      `  [${i + 1}/${NUM_RUNS}] seed=0x${seed.toString(16).toUpperCase().padStart(8, "0")} ` +
        `score=${tape.score} frames=${tape.frames} size=${tape.bytes.length}B`,
    );
  }

  // Filter out zero-score tapes (prover rejects them)
  const validTapes = tapes.filter((t) => t.score > 0);
  const skippedTapes = tapes.filter((t) => t.score === 0);
  if (skippedTapes.length > 0) {
    console.log(`\n  Skipped ${skippedTapes.length} zero-score tapes`);
  }
  console.log(`  ${validTapes.length} valid tapes to submit\n`);

  if (validTapes.length === 0) {
    console.error("No valid tapes generated (all zero score). Increase --max-frames.");
    process.exit(1);
  }

  // Step 2: Submit each tape and wait for completion (sequential, single-active-job)
  console.log(`--- Step 2: Submitting ${validTapes.length} tapes through pipeline ---`);

  interface RunResult {
    tape: TapeInfo;
    jobId: string;
    status: JobStatus;
    claimTxHash: string | null;
    durationMs: number;
  }

  const results: RunResult[] = [];
  const errors: { tape: TapeInfo; error: string }[] = [];

  /* eslint-disable no-await-in-loop -- pipeline submissions are intentionally serialized */
  for (let i = 0; i < validTapes.length; i++) {
    const tape = validTapes[i];
    const startMs = Date.now();
    const label = `[${i + 1}/${validTapes.length}]`;

    try {
      console.log(
        `  ${label} Submitting seed=0x${tape.seed.toString(16).toUpperCase().padStart(8, "0")} score=${tape.score}...`,
      );

      const jobId = await submitTape(tape);
      console.log(`  ${label} Job ${jobId} queued, waiting for proof + claim...`);

      const finalStatus = await waitForJob(jobId);
      const durationMs = Date.now() - startMs;
      const claimTxHash = finalStatus.claim?.txHash ?? null;

      results.push({
        tape,
        jobId,
        status: finalStatus,
        claimTxHash,
        durationMs,
      });

      console.log(
        `  ${label} DONE in ${(durationMs / 1000).toFixed(1)}s — ` +
          `claim=${finalStatus.claim?.status ?? "n/a"} tx=${claimTxHash?.slice(0, 12) ?? "none"}...`,
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      errors.push({ tape, error: msg });
      console.error(`  ${label} FAILED: ${msg}`);
    }
  }
  /* eslint-enable no-await-in-loop */

  // Step 3: Wait for on-chain events to become available, then sync leaderboard
  console.log(`\n--- Step 3: Waiting for on-chain events & syncing leaderboard ---`);

  const claimedResults = results.filter((r) => r.claimTxHash);
  if (claimedResults.length === 0) {
    console.error("No claims succeeded — cannot verify leaderboard ingestion");
    printSummary(results, errors, initialLb);
    process.exit(1);
  }

  // Wait 20s for ledger close + RPC indexing
  console.log(`  Waiting 20s for ledger finalization...`);
  await new Promise((r) => setTimeout(r, 20_000));

  // Find the ledger range of our claims by checking the RPC
  const claimTxHashes = new Set(
    claimedResults.flatMap((result) => (result.claimTxHash ? [result.claimTxHash] : [])),
  );
  console.log(`  ${claimedResults.length} claims to verify on leaderboard`);

  // Use the dev/seed endpoint to manually ingest the events from RPC
  // (since the cron isn't running in Vite dev)
  // First fetch events from the RPC directly
  const rpcUrl = "https://soroban-testnet.stellar.org/";
  const contractId = "CAKVUHDKKEG6SYUAVMQMDRMUGCNQJS74BP45NNYS7Y2TTYUMYFSLA7EU";

  // Get latest ledger for range
  let latestLedger: number;
  try {
    const healthResp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
    });
    const healthRaw = await healthResp.text();
    const healthData = JSON.parse(healthRaw) as {
      result?: { latestLedger: number; oldestLedger: number };
      error?: unknown;
    };
    if (!healthData.result?.latestLedger) {
      console.error("  RPC health response:", healthRaw.slice(0, 200));
      throw new Error("RPC getHealth did not return latestLedger");
    }
    latestLedger = healthData.result.latestLedger;
    console.log(`  RPC latest ledger: ${latestLedger}`);
  } catch (error) {
    console.error(`  Failed to reach RPC: ${error}`);
    console.warn("  Skipping RPC event verification — manually seed events below");
    printSummary(results, errors, initialLb);
    process.exit(0);
  }

  // Fetch recent events from the score contract
  let rpcEvents: Array<Record<string, unknown>> = [];
  try {
    const eventsResp = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "getEvents",
        params: {
          startLedger: latestLedger - 1000,
          filters: [{ type: "contract", contractIds: [contractId] }],
          pagination: { limit: 200 },
        },
      }),
    });
    const eventsData = (await eventsResp.json()) as {
      result?: { events: Array<Record<string, unknown>> };
    };
    rpcEvents = eventsData.result?.events ?? [];
  } catch (error) {
    console.error(`  Failed to fetch events from RPC: ${error}`);
  }

  // Find our events by matching txHash
  let ourEvents = rpcEvents.filter((e) => claimTxHashes.has(e.txHash as string));
  console.log(
    `  Found ${ourEvents.length}/${claimedResults.length} claim events on RPC (initial scan)`,
  );

  // Retry once if some events are missing (RPC indexing lag)
  if (ourEvents.length < claimedResults.length) {
    console.log(
      `  Waiting 15s and retrying for ${claimedResults.length - ourEvents.length} missing events...`,
    );
    /* eslint-disable no-await-in-loop -- RPC indexing retry must remain sequential */
    await new Promise((r) => setTimeout(r, 15_000));
    try {
      const retryResp = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "getEvents",
          params: {
            startLedger: latestLedger - 1000,
            filters: [{ type: "contract", contractIds: [contractId] }],
            pagination: { limit: 200 },
          },
        }),
      });
      const retryData = (await retryResp.json()) as {
        result?: { events: Array<Record<string, unknown>> };
      };
      const retryEvents = retryData.result?.events ?? [];
      ourEvents = retryEvents.filter((e) => claimTxHashes.has(e.txHash as string));
      console.log(`  Retry found ${ourEvents.length}/${claimedResults.length} claim events`);
    } catch (error) {
      console.error(`  Retry failed: ${error}`);
    }
    /* eslint-enable no-await-in-loop */
  }

  if (ourEvents.length > 0) {
    console.log("  Manual dev seeding has been removed; waiting for scheduled leaderboard sync...");
    await new Promise((r) => setTimeout(r, 15_000));
  }

  // Step 4: Verify leaderboard
  console.log(`\n--- Step 4: Verifying leaderboard ---`);
  const finalLb = await getLeaderboard();
  console.log(
    `  Leaderboard after: ${finalLb.total} players, ${finalLb.ingestion.total_events} events`,
  );

  // Check if our claimant's scores appear
  const playerResp = await fetch(`${BASE_URL}/api/leaderboard/player/${CLAIMANT}`);
  const playerData = (await playerResp.json()) as {
    player: {
      claimantAddress: string;
      stats: Record<string, number>;
      ranks: Record<string, number | null>;
      recent_runs: Array<Record<string, unknown>>;
    };
  };

  const player = playerData.player;
  console.log(`\n  Player: ${CLAIMANT}`);
  console.log(
    `  Stats: best_score=${player.stats.best_score}, total_runs=${player.stats.total_runs}, total_minted=${player.stats.total_minted}`,
  );
  console.log(
    `  Ranks: 10m=${player.ranks.ten_min ?? "n/a"}, 24h=${player.ranks.day ?? "n/a"}, all=${player.ranks.all ?? "n/a"}`,
  );
  console.log(`  Recent runs: ${player.recent_runs.length}`);

  // Match submitted scores against leaderboard runs
  const runSeeds = new Set(player.recent_runs.map((r) => r.seed as number));
  let matchedCount = 0;
  for (const result of claimedResults) {
    if (runSeeds.has(result.tape.seed)) {
      matchedCount++;
    }
  }

  printSummary(results, errors, initialLb, finalLb, matchedCount, claimedResults.length);

  // Cleanup tape files
  for (const tape of tapes) {
    try {
      unlinkSync(tape.path);
    } catch {
      // ignore
    }
  }
}

function printSummary(
  results: Array<{
    tape: TapeInfo;
    jobId: string;
    claimTxHash: string | null;
    durationMs: number;
  }>,
  errors: Array<{ tape: TapeInfo; error: string }>,
  initialLb?: { total: number; ingestion: { total_events: number } },
  finalLb?: { total: number; ingestion: { total_events: number } },
  matchedCount?: number,
  claimedCount?: number,
) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  E2E RESULTS SUMMARY`);
  console.log(`${"=".repeat(60)}`);
  console.log(`  Submitted:  ${results.length + errors.length}`);
  console.log(`  Succeeded:  ${results.length}`);
  console.log(`  Failed:     ${errors.length}`);
  console.log(`  Claimed:    ${results.filter((r) => r.claimTxHash).length}`);

  if (matchedCount !== undefined && claimedCount !== undefined) {
    console.log(`  On leaderboard: ${matchedCount}/${claimedCount}`);
  }

  if (initialLb && finalLb) {
    console.log(
      `  Events:     ${initialLb.ingestion.total_events} → ${finalLb.ingestion.total_events} (+${finalLb.ingestion.total_events - initialLb.ingestion.total_events})`,
    );
  }

  const durations = results.map((r) => r.durationMs / 1000);
  if (durations.length > 0) {
    const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
    const min = Math.min(...durations);
    const max = Math.max(...durations);
    console.log(
      `  Duration:   avg=${avg.toFixed(1)}s, min=${min.toFixed(1)}s, max=${max.toFixed(1)}s`,
    );
  }

  console.log(`\n  Runs:`);
  for (const r of results) {
    const status = r.claimTxHash ? "CLAIMED" : "NO_CLAIM";
    console.log(
      `    seed=0x${r.tape.seed.toString(16).toUpperCase().padStart(8, "0")} score=${String(r.tape.score).padStart(6)} ` +
        `${(r.durationMs / 1000).toFixed(1).padStart(6)}s ${status} ${r.claimTxHash?.slice(0, 16) ?? ""}`,
    );
  }
  for (const e of errors) {
    console.log(
      `    seed=0x${e.tape.seed.toString(16).toUpperCase().padStart(8, "0")} score=${String(e.tape.score).padStart(6)} FAILED: ${e.error.slice(0, 60)}`,
    );
  }

  console.log(`${"=".repeat(60)}\n`);

  if (errors.length > 0) {
    process.exit(1);
  }

  if (matchedCount !== undefined && claimedCount !== undefined && matchedCount < claimedCount) {
    console.error(
      `WARNING: Only ${matchedCount}/${claimedCount} claimed scores found on leaderboard`,
    );
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("E2E test failed:", error);
  process.exit(1);
});
