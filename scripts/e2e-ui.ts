/**
 * End-to-end UI test using Playwright + CDP WebAuthn virtual authenticators.
 *
 * Tests the full player flow:
 *   1. Generate a fresh unique tape (or use --tape override)
 *   2. Load tape via game 'L' key (file chooser intercept)
 *   3. Watch replay at 4x speed -> game-over -> ScoreCard
 *   4. Create wallet (passkey via CDP virtual authenticator)
 *   5. Prove score -> redirects to /proofs
 *   6. Wait for proof + on-chain claim to complete
 *   7. Sync leaderboard and verify entry
 *
 * Requirements:
 *   - Local dev server running: bun dev
 *   - .dev.vars configured with BOUNDLESS_PRIVATE_KEY
 *   - Playwright Chromium installed: bunx playwright-core install chromium
 *
 * Usage: bun scripts/e2e-ui.ts [--headed] [--tape <path>] [--timeout-ms <ms>]
 */

import { chromium } from "playwright-core";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AsteroidsGame } from "../src/game/AsteroidsGame";
import { Autopilot } from "../src/game/Autopilot";

const BASE_URL = "http://localhost:5173";
const SCREENSHOT_DIR = "/private/tmp/claude-501";
const MAX_TAPE_FRAMES = 500;

// Parse CLI args
let headed = false;
let tapePath = "";
let proofTimeoutMs = 420_000; // 7 min (Boundless poll timeout + Vast proving + claim)

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--headed") headed = true;
  if (args[i] === "--tape" && args[i + 1]) tapePath = resolve(args[++i]);
  if (args[i] === "--timeout-ms" && args[i + 1]) proofTimeoutMs = parseInt(args[++i], 10);
}

function log(msg: string) {
  console.log(`[e2e-ui] ${new Date().toISOString().slice(11, 23)} ${msg}`);
}

function step(n: number, msg: string) {
  console.log(`\n[e2e-ui] ── Step ${n}: ${msg} ──`);
}

async function launchChromiumBrowser(headless: boolean) {
  try {
    return await chromium.launch({
      headless,
      args: ["--no-sandbox"],
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to launch Playwright Chromium; install it with "bunx playwright-core install chromium" and retry (${detail})`,
      { cause: error },
    );
  }
}

/** Generate a fresh tape with a unique seed so we never hit "already claimed". */
function generateFreshTape(): {
  path: string;
  seed: number;
  score: number;
  frames: number;
} {
  const seed = Date.now();
  log(
    `Generating tape (seed=0x${seed.toString(16).toUpperCase().padStart(8, "0")}, max_frames=${MAX_TAPE_FRAMES})...`,
  );
  const game = new AsteroidsGame({ headless: true, seed });
  game.startNewGame(seed);
  (game as unknown as { autopilot: Autopilot }).autopilot.setEnabled(true);

  let frame = 0;
  while (frame < MAX_TAPE_FRAMES) {
    game.stepSimulation();
    frame++;
    if (game.getMode() === "game-over") break;
  }

  const tapeData = game.getTape();
  if (!tapeData) throw new Error("Failed to generate tape");

  const path = join(SCREENSHOT_DIR, `e2e-tape-${seed.toString(16)}.tape`);
  writeFileSync(path, tapeData);
  return { path, seed, score: game.getScore(), frames: frame };
}

async function waitForProofJob(
  jobId: string,
  timeoutMs: number,
): Promise<{ status: string; claimTxHash: string }> {
  const deadline = Date.now() + timeoutMs;
  log(`Waiting for job ${jobId} (timeout ${timeoutMs / 1000}s)...`);

  /* eslint-disable no-await-in-loop -- proof polling must remain sequential */
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/api/proofs/jobs/${jobId}`);
    if (!res.ok) throw new Error(`Job status check failed: ${res.status}`);
    const data = (await res.json()) as {
      job: {
        status: string;
        claim?: { status: string; txHash?: string };
        error?: string;
      };
    };
    const job = data.job;

    log(`  status=${job.status} claim=${job.claim?.status ?? "none"}`);

    // Proof failed — bail immediately
    if (job.status === "failed") {
      throw new Error(`Proof job ${jobId} failed: ${job.error ?? "unknown"}`);
    }

    // Proof succeeded — wait for claim to resolve
    if (job.status === "succeeded") {
      if (job.claim?.txHash) {
        return { status: "succeeded", claimTxHash: job.claim.txHash };
      }
      if (job.claim?.status === "failed") {
        throw new Error(
          `Claim failed for job ${jobId} (proof succeeded but on-chain claim rejected)`,
        );
      }
      // Claim still in progress (queued/submitting/retrying) — keep polling
    }

    await new Promise((r) => setTimeout(r, 10_000));
  }
  /* eslint-enable no-await-in-loop */

  throw new Error(`Job ${jobId} timed out after ${timeoutMs / 1000}s`);
}

async function main() {
  // Generate or validate tape
  if (!tapePath) {
    const tape = generateFreshTape();
    tapePath = tape.path;
    log(
      `Fresh tape: seed=0x${tape.seed.toString(16).toUpperCase().padStart(8, "0")} score=${tape.score} frames=${tape.frames} (${readFileSync(tapePath).length} bytes)`,
    );
  } else {
    if (!existsSync(tapePath)) {
      console.error(`Tape file not found: ${tapePath}`);
      process.exit(1);
    }
    log(`Using tape: ${tapePath} (${readFileSync(tapePath).length} bytes)`);
  }

  // Pre-flight: check dev server
  step(0, "Pre-flight checks");
  try {
    const res = await fetch(`${BASE_URL}/api/health`);
    if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
    const data = (await res.json()) as {
      prover?: { status?: string; backend?: string };
    };
    const proverStatus = data.prover?.status ?? "unknown";
    log(`Worker healthy. Prover: ${proverStatus} (${data.prover?.backend ?? "unknown"})`);
    if (proverStatus !== "healthy" && proverStatus !== "compatible") {
      log(`WARNING: Prover status is "${proverStatus}" — proof submission may fail`);
    }
  } catch (err) {
    console.error(`Dev server not reachable at ${BASE_URL}:`, err);
    console.error("Start the dev server with: bun dev");
    process.exit(1);
  }

  // Step 1: Launch browser
  step(1, "Launch browser");
  const browser = await launchChromiumBrowser(!headed);

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  log(`Browser launched (headed=${headed})`);

  const screenshotPaths: string[] = [];
  async function screenshot(name: string) {
    const path = `${SCREENSHOT_DIR}/e2e-${name}.png`;
    try {
      await page.screenshot({ path });
      screenshotPaths.push(path);
      log(`Screenshot: ${path}`);
    } catch {
      log(`(screenshot ${name} failed)`);
    }
  }

  try {
    // Step 2: Set up CDP WebAuthn virtual authenticator (BEFORE navigation)
    step(2, "Configure CDP WebAuthn virtual authenticator");

    // Get CDP session for the page
    const cdp = await context.newCDPSession(page);

    // Enable the WebAuthn domain (suppressUI prevents native OS dialogs)
    await cdp.send("WebAuthn.enable", { enableUI: false });

    // Add a virtual authenticator that auto-approves all passkey operations
    const authResult = (await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "usb",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true, // Auto-approve — no Touch ID dialog
        automaticPresenceSimulation: true,
      },
    })) as { authenticatorId: string };
    log(`Virtual authenticator created: ${authResult.authenticatorId}`);

    // Step 3: Navigate to game page
    step(3, "Navigate to game");
    await page.goto(BASE_URL, { waitUntil: "networkidle" });
    await page.waitForSelector("canvas", { timeout: 15_000 });
    log("Game canvas loaded");
    await screenshot("01-loaded");

    // Step 4: Load tape via game's 'L' key (triggers file chooser)
    step(4, "Load tape via file chooser (press L in game menu)");

    // Set up the file chooser handler BEFORE pressing L
    const fileChooserPromise = page.waitForEvent("filechooser", {
      timeout: 5_000,
    });

    // Press L to load tape. The keydown handler is on window, so canvas focus
    // is not needed. We must NOT click the canvas — that would invoke the
    // pointerDownHandler which starts a new game, moving out of menu mode.
    // Use page.evaluate to focus document.body without triggering game events.
    const canvas = page.locator("canvas");
    await page.evaluate(() => document.body.focus());
    await page.keyboard.press("l");

    // Handle the file chooser by injecting our tape
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(tapePath);
    log(`Tape injected — replay starting`);

    // Wait for game to enter replay mode
    await page.waitForTimeout(600);

    // Step 5: Speed up replay to 4x
    step(5, "Speed up replay to 4x");
    await canvas.click(); // ensure canvas has focus
    await page.keyboard.press("4");
    log("Replay speed set to 4x");
    await screenshot("02-replay");

    // Step 6: Wait for game-over (ScoreCard to appear)
    step(6, "Wait for game-over → ScoreCard");
    await page.waitForSelector('[data-slot="score-card"]', { timeout: 30_000 });
    log("ScoreCard appeared — game-over triggered!");
    await screenshot("03-score-card");

    const ariaLabel = await page.locator('[data-slot="score-card"]').getAttribute("aria-label");
    log(`Score: ${ariaLabel}`);

    // Step 7: Create wallet with passkey
    step(7, "Create wallet (passkey via virtual authenticator)");

    const usernameInput = page.locator('[aria-label="Username"]');
    await usernameInput.waitFor({ timeout: 5_000 });
    await usernameInput.fill("e2e-test-runner");
    log('Username: "e2e-test-runner"');

    // Click Create Account → triggers navigator.credentials.create() passkey flow
    // The CDP virtual authenticator auto-approves without any OS dialog
    await page.locator('[aria-label="Create account"]').click();
    log("Clicked Create Account — deploying Stellar smart wallet...");

    // Wait for wallet to be connected (30-60s for testnet smart contract deployment)
    await page.waitForSelector('[aria-label="Account connected"]', {
      timeout: 120_000,
    });
    log("Wallet connected!");
    await screenshot("04-wallet-connected");

    const abbrevAddress = await page
      .locator('[aria-label="Account connected"] .text-muted-foreground')
      .textContent();
    log(`Connected as: ${abbrevAddress?.trim()}`);

    // Step 8: Submit for proof
    step(8, "Submit score for proof");

    const proveBtn = page.locator('[aria-label="Submit score for proof"]');
    await proveBtn.waitFor({ state: "visible", timeout: 5_000 });

    if (await proveBtn.isDisabled()) {
      await screenshot("08-prove-disabled");
      throw new Error("Prove My Score is disabled — check wallet connection and score");
    }

    // Intercept the submit response to capture job ID and claimant address
    let capturedJobId: string | null = null;
    let capturedClaimantAddress: string | null = null;

    const submitResponsePromise = page.waitForResponse(
      (res: { url(): string; request(): { method(): string } }) =>
        res.url().includes("/api/proofs/jobs") &&
        res.request().method() === "POST" &&
        !res.url().includes("/api/proofs/jobs/"),
      { timeout: 30_000 },
    );

    await proveBtn.click();
    log("Clicked Prove My Score...");

    try {
      const submitRes = await submitResponsePromise;
      const requestUrl = new URL(submitRes.request().url());
      capturedClaimantAddress = requestUrl.searchParams.get("claimant");
      if (submitRes.ok()) {
        const submitData = (await submitRes.json()) as {
          job?: { jobId: string };
        };
        capturedJobId = submitData.job?.jobId ?? null;
      }
      log(
        `Submitted: jobId=${capturedJobId ?? "unknown"} claimant=${capturedClaimantAddress ?? "unknown"}`,
      );
    } catch {
      log("Could not intercept submit response");
    }

    // Step 9: Verify /proofs page
    step(9, "Verify /proofs page");
    await page.waitForURL("**/proofs", { timeout: 15_000 });
    log("Navigated to /proofs");
    await page.waitForTimeout(3_000);
    await screenshot("05-proofs-page");

    // If we didn't capture job ID from network, try to find it in the page HTML
    let jobId = capturedJobId;
    if (!jobId) {
      const content = await page.content();
      const match = content.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/);
      if (match) {
        jobId = match[0];
        log(`Found job ID in page: ${jobId}`);
      }
    }

    // Last resort: query the jobs API for the most recent job
    if (!jobId) {
      try {
        const listUrl = capturedClaimantAddress
          ? `${BASE_URL}/api/proofs/jobs?address=${capturedClaimantAddress}&limit=1`
          : `${BASE_URL}/api/proofs/jobs?limit=1`;
        const listRes = await fetch(listUrl);
        if (listRes.ok) {
          const listData = (await listRes.json()) as {
            jobs?: Array<{ jobId: string }>;
          };
          const firstJob = listData.jobs?.[0];
          if (firstJob?.jobId) {
            jobId = firstJob.jobId;
            log(`Found job ID from API: ${jobId}`);
          }
        }
      } catch (err) {
        log(`API job lookup failed: ${err}`);
      }
    }

    if (!jobId) {
      throw new Error("Could not determine proof job ID");
    }
    log(`Monitoring job: ${jobId}`);

    // Step 10: Wait for proof + claim (both must succeed)
    step(10, `Wait for proof + claim (up to ${proofTimeoutMs / 1000}s)`);
    const proofResult = await waitForProofJob(jobId, proofTimeoutMs);
    log(`Proof + claim done! claimTx=${proofResult.claimTxHash}`);

    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2_000);
    await screenshot("06-proof-complete");

    // Step 11: Leaderboard verification (scheduled sync only)
    step(11, "Wait for scheduled leaderboard sync and verify entry");

    // Wait briefly for the claim tx to be confirmed on Stellar
    log("Waiting 10s for Stellar tx confirmation...");
    await new Promise((r) => setTimeout(r, 10_000));

    // Retry leaderboard checks while scheduled sync catches up.
    let leaderboardOk = false;
    const maxLeaderboardChecks = 8;
    /* eslint-disable no-await-in-loop -- leaderboard visibility checks are intentionally serialized with backoff */
    for (let attempt = 1; attempt <= maxLeaderboardChecks; attempt++) {
      log(`Leaderboard visibility check ${attempt}/${maxLeaderboardChecks}...`);

      // Check leaderboard API for our claimant
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 2_000));
      } else {
        await new Promise((r) => setTimeout(r, 10_000));
      }
      const lbParams = new URLSearchParams({ window: "all", limit: "10" });
      if (capturedClaimantAddress) lbParams.set("address", capturedClaimantAddress);
      const lbRes = await fetch(`${BASE_URL}/api/leaderboard?${lbParams}`);
      if (!lbRes.ok) {
        log(`  Leaderboard API returned ${lbRes.status}`);
        continue;
      }

      const lbData = (await lbRes.json()) as {
        pagination: { total: number };
        ingestion: { total_events: number; highest_ledger: number };
        entries: Array<{
          rank: number;
          score: number;
          claimantAddress: string;
        }>;
        me?: { rank: number; score: number } | null;
      };
      log(
        `  Leaderboard: ${lbData.pagination.total} players, ${lbData.ingestion.total_events} events`,
      );
      if (lbData.entries.length > 0) {
        log(`  Top: rank=${lbData.entries[0].rank} score=${lbData.entries[0].score}`);
      }

      if (lbData.me) {
        log(`  Your rank: #${lbData.me.rank} (${lbData.me.score} pts)`);
        leaderboardOk = true;
        break;
      }

      if (capturedClaimantAddress) {
        log("  Not yet on leaderboard, retrying...");
        await new Promise((r) => setTimeout(r, 10_000));
      } else {
        // No address to check — just verify leaderboard loads
        leaderboardOk = true;
        break;
      }
    }
    /* eslint-enable no-await-in-loop */

    // Navigate to leaderboard page and screenshot
    await page.goto(`${BASE_URL}/leaderboard`, { waitUntil: "networkidle" });
    await page.waitForTimeout(3_000);
    await screenshot("07-leaderboard");

    if (!leaderboardOk && capturedClaimantAddress) {
      throw new Error(
        `Claimant ${capturedClaimantAddress} not found on leaderboard after ${maxLeaderboardChecks} visibility checks`,
      );
    }

    // Summary
    console.log(`\n${"=".repeat(60)}`);
    console.log("  E2E UI TEST PASSED");
    console.log(`${"=".repeat(60)}`);
    console.log(`  Tape:        ${tapePath}`);
    console.log(`  Job ID:      ${jobId}`);
    console.log(`  Claim Tx:    ${proofResult.claimTxHash}`);
    console.log(`  Claimant:    ${capturedClaimantAddress ?? "unknown"}`);
    console.log(`  Leaderboard: ${leaderboardOk ? "verified" : "skipped (no address)"}`);
    console.log(`  Screenshots: ${SCREENSHOT_DIR}/e2e-*.png`);
    console.log(`${"=".repeat(60)}\n`);
  } catch (err) {
    try {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/e2e-error.png` });
      log(`Error screenshot: ${SCREENSHOT_DIR}/e2e-error.png`);
    } catch {
      // ignore
    }
    console.error("\n[e2e-ui] TEST FAILED:", err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
