import { cpus } from "os";
import { Client as ScoreClient } from "asteroids-score";
import { Autopilot, type AutopilotConfig } from "@/game/Autopilot";
import { renderDashboard, type DashboardStats } from "../display/dashboard";
import * as ansi from "../display/ansi";
import { submitTape, type SubmitResult } from "../api/submit";
import { fetchPlayerScore } from "../api/score";
import type { MainToWorkerMessage, WorkerToMainMessage } from "../worker/messages";
import {
  type NetworkName,
  SEED_INTERVAL_SECONDS,
  MAX_SUBMISSIONS_PER_EPOCH,
  SETTLE_DELAY_MS,
} from "../constants";
import { fetchSeedContextFromContract, type SeedContext } from "@/chain/seed";
import { bumpSeedViaRelayer } from "../relayer";
import { runCliPreflight } from "../preflight";

const SEED_REFRESH_INTERVAL_MS = 4000;
const SEED_BUMP_RETRY_INTERVAL_MS = 30_000;
const SEED_AUTHORITY_LEASE_MS = 20_000;

function estimatedEpochEndMs(seedId: number): number {
  return (seedId + 1) * SEED_INTERVAL_SECONDS * 1000;
}

function localSeedIdEstimate(): number {
  return Math.floor(Date.now() / 1000 / SEED_INTERVAL_SECONDS);
}

export interface RunOptions {
  network: NetworkName;
  networkPassphrase: string;
  address: string;
  threads: number;
  apiUrl: string;
  rpcUrl: string;
  contractId: string;
  tokenContractId: string;
  relayerBaseUrl: string;
  relayerApiKey: string | null;
}

async function fetchBestScoreForSeedOnNetwork(
  contractId: string,
  rpcUrl: string,
  networkPassphrase: string,
  claimant: string,
  seedId: number,
): Promise<number> {
  try {
    const client = new ScoreClient({ contractId, rpcUrl, networkPassphrase });
    const tx = await client.best_score({ claimant, seed_id: seedId >>> 0 });
    return tx.result;
  } catch {
    return 0;
  }
}

export async function runCommand(opts: RunOptions): Promise<void> {
  const availableCores = cpus().length;
  const threadCount = opts.threads > 0 ? opts.threads : Math.max(1, Math.floor(availableCores / 2));
  const pct = Math.round((threadCount / availableCores) * 100);

  process.stdout.write(
    ansi.color(ansi.cyan, "  Cores: ") +
      ansi.color(ansi.white, `${threadCount}/${availableCores}`) +
      ansi.color(ansi.dim, ` (${pct}%)\n`),
  );

  process.stdout.write(ansi.color(ansi.cyan, "  Running preflight checks..."));
  const preflight = await runCliPreflight({
    network: opts.network,
    networkPassphrase: opts.networkPassphrase,
    address: opts.address,
    apiUrl: opts.apiUrl,
    rpcUrl: opts.rpcUrl,
    contractId: opts.contractId,
    tokenContractId: opts.tokenContractId,
  });
  process.stdout.write(ansi.color(ansi.green, " ok\n"));
  for (const warning of preflight.warnings) {
    process.stdout.write(ansi.color(ansi.yellow, `  Warning: ${warning}\n`));
  }

  process.stdout.write(ansi.color(ansi.cyan, "  Fetching on-chain score..."));
  const playerInfo = await fetchPlayerScore(opts.address, opts.apiUrl);
  let onChainBestScore = playerInfo.bestScore;
  process.stdout.write(
    onChainBestScore > 0
      ? ansi.color(ansi.green, ` ${onChainBestScore}\n`)
      : ansi.color(ansi.dim, " none\n"),
  );

  process.stdout.write(ansi.color(ansi.cyan, "  Resolving chain seed_id..."));
  const initialSeedContext = await fetchSeedContextFromContract(
    opts.contractId,
    opts.rpcUrl,
    opts.networkPassphrase,
  );
  if (initialSeedContext === null) {
    throw new Error("Unable to resolve the current seed_id from the Stellar network");
  }
  const initialSeedId = initialSeedContext.seedId;
  process.stdout.write(ansi.color(ansi.green, ` ${initialSeedId}\n`));

  const initialClockDelta = localSeedIdEstimate() - initialSeedId;
  if (initialClockDelta !== 0) {
    process.stdout.write(
      ansi.color(
        ansi.yellow,
        `  Warning: local clock seed_id differs from chain by ${initialClockDelta}; chain authority will be used\n`,
      ),
    );
  }

  process.stdout.write(ansi.color(ansi.cyan, "  Fetching seed best score..."));
  const initialSeedBest = await fetchBestScoreForSeedOnNetwork(
    opts.contractId,
    opts.rpcUrl,
    opts.networkPassphrase,
    opts.address,
    initialSeedId,
  );
  process.stdout.write(
    initialSeedBest > 0
      ? ansi.color(ansi.green, ` ${initialSeedBest}\n`)
      : ansi.color(ansi.dim, " none\n"),
  );

  let currentEpoch = initialSeedId;
  let epochGamesPlayed = 0;
  let currentSeed: number | null = initialSeedContext.seed;
  let seedRefreshInFlight = false;
  let lastSeedRefreshAt = 0;
  let lastSeedAuthorityAt = performance.now();
  let seedAuthorityPaused = false;
  let seedBumpInFlight = false;
  let lastSeedBumpAt = Number.NEGATIVE_INFINITY;
  let announceSeedResolution = currentSeed === null;

  function hasFreshSeedAuthority(now = performance.now()): boolean {
    return now - lastSeedAuthorityAt <= SEED_AUTHORITY_LEASE_MS;
  }

  async function fetchCurrentSeedContext(): Promise<SeedContext | null> {
    try {
      return await fetchSeedContextFromContract(
        opts.contractId,
        opts.rpcUrl,
        opts.networkPassphrase,
      );
    } catch {
      return null;
    }
  }

  async function materializeSeed(context: SeedContext): Promise<SeedContext> {
    if (
      context.seed !== null ||
      !opts.relayerApiKey ||
      seedBumpInFlight ||
      performance.now() - lastSeedBumpAt < SEED_BUMP_RETRY_INTERVAL_MS
    ) {
      return context;
    }

    seedBumpInFlight = true;
    lastSeedBumpAt = performance.now();
    try {
      const bumped = await bumpSeedViaRelayer(
        opts.contractId,
        opts.rpcUrl,
        opts.networkPassphrase,
        opts.relayerBaseUrl,
        opts.relayerApiKey,
      );
      if (bumped.success && bumped.seedId !== null && bumped.seed !== null) {
        lastSeedAuthorityAt = performance.now();
        return { seedId: bumped.seedId, seed: bumped.seed };
      }
      return context;
    } finally {
      seedBumpInFlight = false;
    }
  }

  async function refreshCurrentSeed(force = false): Promise<SeedContext | null> {
    if (seedRefreshInFlight) return null;

    const now = performance.now();
    if (!force && now - lastSeedRefreshAt < SEED_REFRESH_INTERVAL_MS) {
      return hasFreshSeedAuthority(now) ? { seedId: currentEpoch, seed: currentSeed } : null;
    }

    seedRefreshInFlight = true;
    lastSeedRefreshAt = now;
    try {
      const context = await fetchCurrentSeedContext();
      if (context === null) {
        return hasFreshSeedAuthority() ? { seedId: currentEpoch, seed: currentSeed } : null;
      }
      lastSeedAuthorityAt = performance.now();
      const resolvedContext = await materializeSeed(context);
      return hasFreshSeedAuthority() ? resolvedContext : null;
    } finally {
      seedRefreshInFlight = false;
    }
  }

  let bestScore = 0;
  let bestTape: Uint8Array | null = null;
  let bestConfig: AutopilotConfig = Autopilot.defaults();
  let lastSubmittedScore = initialSeedBest;
  let bestScoreFoundAt = 0;
  let epochSubmissions = 0;
  let totalGamesPlayed = 0;
  let totalSubmissions = 0;
  let lastSubmitStatus = "";
  const startTime = Date.now();
  let submitting = false;
  const workerBests: number[] = Array.from({ length: threadCount }, () => 0);

  const isCompiled = import.meta.url.includes("$bunfs");
  const workers: Worker[] = [];
  const workerAlive: boolean[] = Array.from({ length: threadCount }, () => false);

  function safePostToWorker(index: number, msg: MainToWorkerMessage): void {
    const worker = workers[index];
    if (!worker || !workerAlive[index]) return;
    try {
      worker.postMessage(msg);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (/Worker has been terminated|InvalidStateError/i.test(detail)) {
        workerAlive[index] = false;
        return;
      }
      throw error;
    }
  }

  function broadcastSeedContext(context: SeedContext): void {
    for (let i = 0; i < workers.length; i++) {
      safePostToWorker(i, {
        type: "seed-context",
        seedId: context.seedId,
        seed: context.seed,
      });
    }
  }

  function pauseForStaleSeedAuthority(): void {
    if (seedAuthorityPaused) return;
    seedAuthorityPaused = true;
    currentSeed = null;
    broadcastSeedContext({ seedId: currentEpoch, seed: null });
    lastSubmitStatus = ansi.color(
      ansi.yellow,
      "chain seed authority stale — workers and submissions paused until refreshed",
    );
  }

  for (let i = 0; i < threadCount; i++) {
    const role = i === 0 ? "exploit" : "explore";
    const worker = isCompiled
      ? new Worker("./worker/game-worker.ts")
      : new Worker(new URL("../worker/game-worker.ts", import.meta.url));
    workerAlive[i] = true;
    worker.addEventListener("message", (event: MessageEvent<WorkerToMainMessage>) => {
      const msg = event.data;
      switch (msg.type) {
        case "game-complete":
          totalGamesPlayed++;
          epochGamesPlayed++;
          break;
        case "new-best":
          if (!hasFreshSeedAuthority() || msg.seedId !== currentEpoch) break;
          if (msg.score > bestScore) {
            bestScore = msg.score;
            bestTape = msg.tape;
            bestConfig = msg.config;
            bestScoreFoundAt = Date.now();
            if (msg.workerId !== 0) {
              safePostToWorker(0, {
                type: "set-config",
                config: msg.config,
                globalScore: msg.score,
              });
            }
            for (let j = 1; j < workers.length; j++) {
              if (j !== msg.workerId) {
                safePostToWorker(j, {
                  type: "set-config",
                  config: msg.config,
                  globalScore: msg.score,
                });
              }
            }
          }
          workerBests[msg.workerId] = msg.score;
          break;
        case "stopped":
          workerAlive[msg.workerId] = false;
          break;
      }
    });
    worker.addEventListener("error", (event) => {
      workerAlive[i] = false;
      const detail =
        event instanceof ErrorEvent && typeof event.message === "string"
          ? event.message
          : "unknown worker error";
      lastSubmitStatus = ansi.color(ansi.red, `worker ${i} crashed: ${detail}`);
    });
    workers.push(worker);
    safePostToWorker(i, {
      type: "start",
      workerId: i,
      role,
      seedId: currentEpoch,
      seed: currentSeed,
    });
  }

  function resetEpoch(onChainSeedBest = 0): void {
    const prevBestScore = bestScore;
    const prevBestConfig = bestConfig;
    bestScore = 0;
    bestTape = null;
    lastSubmittedScore = onChainSeedBest;
    epochGamesPlayed = 0;
    epochSubmissions = 0;
    bestScoreFoundAt = 0;
    workerBests.fill(0);
    const seedConfig = prevBestScore > 0 ? prevBestConfig : Autopilot.defaults();
    bestConfig = seedConfig;

    for (let i = 0; i < workers.length; i++) {
      safePostToWorker(i, { type: "reset-best" });
      if (i === 0) {
        safePostToWorker(i, {
          type: "set-config",
          config: seedConfig,
          globalScore: 0,
          force: true,
        });
      }
    }
  }

  async function doSubmit(force = false): Promise<void> {
    if (submitting || !bestTape || bestScore <= lastSubmittedScore) return;
    if (!hasFreshSeedAuthority()) {
      pauseForStaleSeedAuthority();
      return;
    }
    if (epochSubmissions >= MAX_SUBMISSIONS_PER_EPOCH && !force) {
      lastSubmitStatus = ansi.color(
        ansi.yellow,
        `budget exhausted (${MAX_SUBMISSIONS_PER_EPOCH}/${MAX_SUBMISSIONS_PER_EPOCH})`,
      );
      return;
    }
    if (!force && bestScoreFoundAt > 0 && Date.now() - bestScoreFoundAt < SETTLE_DELAY_MS) return;

    submitting = true;
    const tape = bestTape;
    const score = bestScore;
    lastSubmitStatus = ansi.color(ansi.yellow, `submitting (score: ${score})...`);
    const result: SubmitResult = await submitTape(tape, opts.address, currentEpoch, opts.apiUrl);

    if (result.success) {
      totalSubmissions++;
      epochSubmissions++;
      lastSubmittedScore = score;
      lastSubmitStatus = ansi.color(
        ansi.green,
        `score ${score} submitted (${result.jobId || "ok"})`,
      );
    } else if (result.rateLimited) {
      lastSubmitStatus = ansi.color(ansi.yellow, "rate limited - will retry");
    } else {
      lastSubmitStatus = ansi.color(ansi.red, `failed: ${result.error}`);
    }
    submitting = false;
  }

  const tickInterval = setInterval(async () => {
    const context = await refreshCurrentSeed();
    if (context === null) {
      if (!hasFreshSeedAuthority()) pauseForStaleSeedAuthority();
      return;
    }

    const authorityWasPaused = seedAuthorityPaused;
    seedAuthorityPaused = false;

    if (context.seedId !== currentEpoch) {
      for (let drain = 0; drain < 10; drain++) {
        while (submitting) await new Promise((resolve) => setTimeout(resolve, 100));
        if (bestTape && bestScore > lastSubmittedScore) await doSubmit(true);
        else break;
      }

      const chainSeedId = context.seedId;
      currentEpoch = chainSeedId;
      currentSeed = context.seed;
      resetEpoch();
      broadcastSeedContext(context);
      lastSubmitStatus = ansi.color(ansi.cyan, "new chain seed_id — fetching seed...");
      announceSeedResolution = currentSeed === null;

      const localDelta = localSeedIdEstimate() - chainSeedId;
      if (localDelta !== 0) {
        lastSubmitStatus = ansi.color(
          ansi.yellow,
          `chain seed_id active; local clock differs by ${localDelta}`,
        );
      }

      void fetchPlayerScore(opts.address, opts.apiUrl).then((info) => {
        onChainBestScore = info.bestScore;
      });
      void fetchBestScoreForSeedOnNetwork(
        opts.contractId,
        opts.rpcUrl,
        opts.networkPassphrase,
        opts.address,
        chainSeedId,
      ).then((seedBest) => {
        if (chainSeedId === currentEpoch && seedBest > lastSubmittedScore) {
          lastSubmittedScore = seedBest;
        }
      });
    } else if (authorityWasPaused || context.seed !== currentSeed) {
      currentSeed = context.seed;
      broadcastSeedContext(context);
      if (authorityWasPaused) lastSubmitStatus = ansi.color(ansi.cyan, "chain seed authority refreshed");
      if (context.seed !== null && announceSeedResolution) {
        lastSubmitStatus = ansi.color(
          ansi.cyan,
          `new seed_id materialized (0x${context.seed.toString(16).padStart(8, "0").toUpperCase()})`,
        );
        announceSeedResolution = false;
      }
    }

    await doSubmit();
  }, 2000);

  process.stdout.write(ansi.clearScreen + ansi.cursorHide);
  const dashInterval = setInterval(() => {
    const now = Date.now();
    const epochRemainingSec = Math.max(0, (estimatedEpochEndMs(currentEpoch) - now) / 1000);
    let settleRemainingSec = 0;
    if (bestScoreFoundAt > 0 && bestScore > lastSubmittedScore) {
      const elapsed = now - bestScoreFoundAt;
      if (elapsed < SETTLE_DELAY_MS) {
        settleRemainingSec = Math.ceil((SETTLE_DELAY_MS - elapsed) / 1000);
      }
    }

    const stats: DashboardStats = {
      totalGamesPlayed,
      epochGamesPlayed,
      bestScore,
      lastSubmittedScore,
      totalSubmissions,
      lastSubmitStatus,
      epochRemainingSec,
      currentSeed,
      threads: threadCount,
      availableCores,
      address: opts.address,
      startTime,
      workerBests,
      onChainBestScore,
      epochSubmissions,
      maxSubmissionsPerEpoch: MAX_SUBMISSIONS_PER_EPOCH,
      settleRemainingSec,
    };
    renderDashboard(stats);
  }, 500);

  async function shutdown(): Promise<void> {
    clearInterval(dashInterval);
    clearInterval(tickInterval);
    process.stdout.write(ansi.cursorShow);
    console.log("\n");
    console.log(ansi.color(ansi.brightCyan, "  Shutting down..."));

    for (let i = 0; i < workers.length; i++) safePostToWorker(i, { type: "stop" });
    while (submitting) await new Promise((resolve) => setTimeout(resolve, 100));

    if (!hasFreshSeedAuthority()) {
      console.log(ansi.color(ansi.yellow, "  Final submit skipped: chain seed authority is stale."));
    } else if (bestTape && bestScore > lastSubmittedScore) {
      console.log(ansi.color(ansi.yellow, `  Submitting best tape (score: ${bestScore})...`));
      const result = await submitTape(bestTape, opts.address, currentEpoch, opts.apiUrl);
      if (result.success) {
        totalSubmissions++;
        console.log(ansi.color(ansi.green, `  Submitted! Job: ${result.jobId || "ok"}`));
      } else {
        console.log(ansi.color(ansi.red, `  Submit failed: ${result.error}`));
      }
    } else {
      console.log(ansi.color(ansi.dim, "  No unsubmitted improvements."));
    }

    const elapsed = (Date.now() - startTime) / 1000;
    console.log("");
    console.log(ansi.color(ansi.brightWhite, "  Session Summary"));
    console.log(
      ansi.color(
        ansi.gray,
        `  Games: ${totalGamesPlayed}  |  Best: ${bestScore}  |  Submissions: ${totalSubmissions}`,
      ),
    );
    console.log(
      ansi.color(
        ansi.gray,
        `  On-chain best: ${onChainBestScore}  |  Duration: ${Math.round(elapsed)}s`,
      ),
    );
    console.log("");

    for (const worker of workers) worker.terminate();
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  await new Promise(() => {});
}
