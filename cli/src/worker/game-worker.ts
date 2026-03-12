/// <reference types="bun-types" />
import { AsteroidsGame } from "@/game/AsteroidsGame";
import { Autopilot, type AutopilotConfig } from "@/game/Autopilot";
import type { MainToWorkerMessage, WorkerRole, WorkerToMainMessage } from "./messages";
import { mutateConfig, randomConfig, warmRestartConfig } from "./mutate";
import { fetchSeedFromContract } from "@/chain/seed";
import { MAX_FRAMES, EXPLORER_RESTART_THRESHOLD, SEED_INTERVAL_SECONDS } from "../constants";
import { bumpSeedViaRelayer } from "../relayer";

let workerId = 0;
let role: WorkerRole = "explore";
let rpcUrl = "";
let contractId = "";
let relayerBaseUrl = "";
let relayerApiKey: string | null = null;
let running = false;
let bestScore = 0;
let bestConfig: AutopilotConfig = Autopilot.defaults();
let globalBestConfig: AutopilotConfig = Autopilot.defaults(); // latest global best for warm restarts
let gamesWithoutImprovement = 0;

// Active seed_id cache
let currentSeedId = -1;
let currentSeed: number | null = null;

async function ensureSeed(): Promise<void> {
  const seedId = Math.floor(Date.now() / 1000 / SEED_INTERVAL_SECONDS);
  if (seedId === currentSeedId && currentSeed !== null) return;

  // A new epoch started. Do not keep using stale epoch seed.
  if (seedId !== currentSeedId) {
    currentSeed = null;
  }

  let fetched: number | null = null;
  let resolvedSeedId: number | null = null;
  /* eslint-disable no-await-in-loop -- seed materialization retries must remain sequential */
  for (let attempt = 0; attempt < 6; attempt++) {
    fetched = await fetchSeedFromContract(contractId, rpcUrl);
    if (fetched !== null) {
      resolvedSeedId = seedId;
      break;
    }
    if (attempt < 5) {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  /* eslint-enable no-await-in-loop */

  // Seed not yet materialized — worker 0 bumps it via the relayer (if configured),
  // then waits briefly for the chain to confirm before retrying once.
  if (fetched === null && workerId === 0 && relayerApiKey) {
    const bumped = await bumpSeedViaRelayer(contractId, rpcUrl, relayerBaseUrl, relayerApiKey);
    if (bumped.success) {
      if (bumped.seed !== null) {
        fetched = bumped.seed;
        resolvedSeedId = bumped.seedId ?? seedId;
      } else {
        await new Promise((r) => setTimeout(r, 3000));
        fetched = await fetchSeedFromContract(contractId, rpcUrl);
        if (fetched !== null) {
          resolvedSeedId = seedId;
        }
      }
    }
  }

  if (fetched !== null) {
    currentSeed = fetched;
    currentSeedId = resolvedSeedId ?? seedId;
  }
  // If still null after retries + relayer bump, runOneGame() will skip and
  // retry — we never play games with an unmaterialized or stale seed.
}

function post(msg: WorkerToMainMessage, transfer?: Transferable[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Bun worker postMessage typing mismatch
  postMessage(msg, transfer as any);
}

async function runOneGame(): Promise<void> {
  await ensureSeed();
  const seed = currentSeed;
  if (seed === null) {
    if (running) {
      setTimeout(runOneGame, 1000);
    } else {
      post({ type: "stopped", workerId });
    }
    return;
  }

  const scale = role === "exploit" ? 0.5 : 1.5;
  const config = mutateConfig(bestConfig, scale, role);

  const seedId = currentSeedId;
  const game = new AsteroidsGame({
    headless: true,
    seed,
    seedId,
    autopilotConfig: config,
  });
  game.startNewGame(seed, seedId);
  (game as unknown as { autopilot: Autopilot }).autopilot.setEnabled(true);

  let frame = 0;
  /* eslint-disable no-await-in-loop -- periodic Bun.sleep(0) yields are intentional within the simulation loop */
  while (frame < MAX_FRAMES) {
    game.stepSimulation();
    frame++;
    if (game.getMode() === "game-over") break;
    // Yield every 6000 frames (~100ms of work) so the worker can process
    // incoming messages (stop, reset-best, set-config) and the OS scheduler
    // can give time to other processes instead of pinning the core at 100%.
    if (frame % 6000 === 0) await Bun.sleep(0);
  }
  /* eslint-enable no-await-in-loop */

  const score = game.getScore();

  if (score > bestScore) {
    const tape = game.getTape();
    if (tape) {
      bestScore = score;
      bestConfig = config;
      gamesWithoutImprovement = 0;
      const copy = new Uint8Array(tape);
      post(
        {
          type: "new-best",
          workerId,
          score,
          frames: frame,
          tape: copy,
          config,
          seedId,
        },
        [copy.buffer],
      );
    }
  } else {
    gamesWithoutImprovement++;

    // Explorers: warm restart when stuck — blend global best with random
    // to keep some learned structure while exploring new territory.
    if (role === "explore" && gamesWithoutImprovement >= EXPLORER_RESTART_THRESHOLD) {
      bestConfig = warmRestartConfig(globalBestConfig);
      bestScore = 0;
      gamesWithoutImprovement = 0;
    }
  }

  post({
    type: "game-complete",
    workerId,
    score,
    frames: frame,
    workerBest: bestScore,
  });

  // Yield to event loop so messages (stop, reset-best, set-config) can be processed,
  // then start next game
  if (running) {
    setTimeout(runOneGame, 0);
  } else {
    post({ type: "stopped", workerId });
  }
}

self.addEventListener("message", (event: MessageEvent<MainToWorkerMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "start":
      workerId = msg.workerId;
      role = msg.role;
      rpcUrl = msg.rpcUrl;
      contractId = msg.contractId;
      relayerBaseUrl = msg.relayerBaseUrl;
      relayerApiKey = msg.relayerApiKey;
      running = true;
      bestScore = 0;
      gamesWithoutImprovement = 0;
      bestConfig = role === "exploit" ? Autopilot.defaults() : randomConfig();
      void runOneGame();
      break;
    case "stop":
      running = false;
      break;
    case "reset-best":
      bestScore = 0;
      gamesWithoutImprovement = 0;
      // Reset seed cache so the next game fetches the current seed_id's seed.
      currentSeedId = -1;
      currentSeed = null;
      // On epoch reset, explorers warm-restart from the global best blended
      // with random so they search new territory with some learned structure.
      if (role === "explore") {
        bestConfig = warmRestartConfig(globalBestConfig);
      }
      break;
    case "set-config":
      // Always track the global best config for warm restarts
      globalBestConfig = msg.config;
      if (msg.force) {
        // Forced update (epoch reset for exploiter): always adopt
        bestConfig = msg.config;
        bestScore = msg.globalScore;
      } else if (role === "exploit") {
        // Exploiter: always follow the global best
        if (msg.globalScore > bestScore) {
          bestConfig = msg.config;
          bestScore = msg.globalScore;
        }
      } else {
        // Explorers: only adopt if the global best is significantly better (>10%)
        // — don't disrupt a productive exploration run for marginal gains
        if (msg.globalScore > bestScore * 1.1) {
          bestConfig = msg.config;
          bestScore = msg.globalScore;
          gamesWithoutImprovement = 0;
        }
      }
      break;
  }
});
