/**
 * E2E test: Wallet page with WebAuthn virtual authenticator.
 *
 * Tests: create account → navigate to /wallet → verify swap UI → enter amount → get quote.
 *
 * Usage:
 *   bun run scripts/test-wallet-swap.ts
 */

import { chromium, type CDPSession } from "playwright-core";

const BASE_URL = "http://localhost:5173";

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("=== Wallet + Swap E2E Test ===\n");

  // Find Chromium from Playwright's known locations
  const chromiumPath =
    process.env.CHROMIUM_PATH ||
    (() => {
      const { execSync } = require("child_process");
      // Try agent-browser's bundled browser
      try {
        const result = execSync(
          'find /Users/kalepail/Library/Caches/ms-playwright -name "headless_shell" -o -name "chrome" -o -name "Chromium" | grep -v ".app/Contents/Frameworks" | head -1',
          { encoding: "utf-8" },
        ).trim();
        if (result) return result;
      } catch {}
      // Fallback: system Chrome
      return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    })();

  console.log(`Chromium: ${chromiumPath}`);

  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ["--enable-features=VirtualAuthenticators"],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // Listen for console messages
  const consoleLogs: string[] = [];
  page.on("console", (msg) => {
    const text = `[${msg.type()}] ${msg.text()}`;
    consoleLogs.push(text);
    if (msg.type() === "error") {
      console.log(`  CONSOLE ERROR: ${msg.text()}`);
    }
  });

  // Set up virtual WebAuthn authenticator via CDP
  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  console.log(`Virtual authenticator: ${authenticatorId}\n`);

  // ── Step 1: Navigate to home page ──
  console.log("-- Step 1: Open app --");
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  console.log(`  Page title: ${await page.title()}`);
  console.log(`  URL: ${page.url()}`);

  // ── Step 2: Create account ──
  console.log("\n-- Step 2: Create account --");

  // Click "Sign In" in header
  const signInBtn = page.locator('button:has-text("Sign In")').first();
  await signInBtn.click();
  await sleep(500);

  // Type username
  const usernameInput = page.locator('input[aria-label="Username"]');
  await usernameInput.fill("test-swap-bot");

  // Click Create Account
  const createBtn = page.locator('button:has-text("Create Account")');
  await createBtn.click();

  console.log("  Waiting for account creation (virtual authenticator)...");

  // Wait for the wallet to connect (the Sign In button should change to show balance/address)
  try {
    await page.waitForFunction(
      () => {
        // Look for an element showing a balance (e.g. "— KALIEN" or "0 KALIEN")
        const buttons = Array.from(document.querySelectorAll("button"));
        for (const btn of buttons) {
          if (btn.textContent?.includes("KALIEN")) return true;
        }
        return false;
      },
      { timeout: 30_000 },
    );
    console.log("  ✓ Account created and connected!");
  } catch {
    // Take screenshot on failure
    await page.screenshot({ path: "scripts/test-wallet-fail-create.png" });
    console.log("  ✗ Account creation timed out");
    console.log("  Screenshot saved to scripts/test-wallet-fail-create.png");

    // Check for error messages in the dropdown
    const errorEl = page.locator('[class*="error"], [class*="Error"]').first();
    if (await errorEl.isVisible().catch(() => false)) {
      console.log(`  Error text: ${await errorEl.textContent()}`);
    }

    // Show recent console errors
    const errors = consoleLogs.filter((l) => l.startsWith("[error]"));
    if (errors.length > 0) {
      console.log("\n  Recent console errors:");
      for (const e of errors.slice(-5)) console.log(`    ${e}`);
    }

    await browser.close();
    process.exit(1);
  }

  // ── Step 3: Navigate to /wallet ──
  console.log("\n-- Step 3: Navigate to /wallet --");
  await page.goto(`${BASE_URL}/wallet`, { waitUntil: "networkidle" });
  await sleep(2000); // Allow balance to load
  console.log(`  URL: ${page.url()}`);

  // Check page content
  const pageText = await page.textContent("body");
  const hasWalletTitle = pageText?.includes("Wallet") ?? false;
  const hasSwapSection = pageText?.includes("Swap KALIEN") ?? false;
  const hasTransferSection = pageText?.includes("Transfer KALIEN") ?? false;
  const hasAccountSection = pageText?.includes("Account") ?? false;
  const hasBalance = pageText?.includes("KALIEN") ?? false;

  console.log(`  Wallet title:    ${hasWalletTitle ? "✓" : "✗"}`);
  console.log(`  Account section: ${hasAccountSection ? "✓" : "✗"}`);
  console.log(`  Balance display: ${hasBalance ? "✓" : "✗"}`);
  console.log(`  Swap section:    ${hasSwapSection ? "✓" : "✗"}`);
  console.log(`  Transfer section: ${hasTransferSection ? "✓" : "✗"}`);

  await page.screenshot({ path: "scripts/test-wallet-connected.png" });
  console.log("  Screenshot saved to scripts/test-wallet-connected.png");

  if (!hasSwapSection) {
    console.log("\n  ⚠ Swap section not visible — swapCfg may be null.");
    console.log("  Checking if VITE_KALE_SAC is loaded...");

    // Check env vars via page eval
    const envCheck = await page.evaluate(() => ({
      kaleSac:
        (
          import.meta as ImportMeta & {
            env?: Record<string, string | undefined>;
          }
        ).env?.VITE_KALE_SAC ?? "not set",
      networkPassphrase:
        (
          import.meta as ImportMeta & {
            env?: Record<string, string | undefined>;
          }
        ).env?.VITE_NETWORK_PASSPHRASE ?? "not set",
      tokenContractId:
        (
          import.meta as ImportMeta & {
            env?: Record<string, string | undefined>;
          }
        ).env?.VITE_TOKEN_CONTRACT_ID ?? "not set",
    }));
    console.log(`  VITE_KALE_SAC: ${envCheck.kaleSac}`);
    console.log(`  VITE_NETWORK_PASSPHRASE: ${envCheck.networkPassphrase}`);
    console.log(`  VITE_TOKEN_CONTRACT_ID: ${envCheck.tokenContractId}`);
  }

  // ── Step 4: Test swap quote ──
  if (hasSwapSection) {
    console.log("\n-- Step 4: Test swap quote --");

    const swapInput = page.locator("#swap-amount");
    await swapInput.fill("100");
    console.log("  Entered 100 KALIEN");

    // Wait for quote: debounce 600ms + RPC to testnet (can be slow)
    console.log("  Waiting for debounce + RPC (up to 60s)...");
    const quoteStart = Date.now();

    // Wait for loading spinner to appear first (debounce fires)
    await sleep(1500);

    // Now poll until the loading indicator disappears and a result appears
    let quoteResult = "timeout";
    /* eslint-disable no-await-in-loop -- quote polling must remain sequential */
    for (let i = 0; i < 60; i++) {
      const state = await page.evaluate(() => {
        const body = document.body.textContent || "";
        return {
          hasLoading: body.includes("Getting quote"),
          hasQuote: body.includes("You receive"),
          hasError: body.includes("Failed to get quote") || body.includes("simulation failed"),
          swap: body
            .substring(
              body.indexOf("SWAP KALIEN") || 0,
              body.indexOf("TRANSFER KALIEN") || body.length,
            )
            .trim(),
        };
      });

      if (state.hasQuote) {
        quoteResult = "success";
        break;
      }
      if (state.hasError) {
        quoteResult = "error";
        break;
      }
      if (!state.hasLoading && i > 2) {
        // Loading finished but no result — check swap section text
        console.log(`  Swap section text: "${state.swap.substring(0, 200)}"`);
        quoteResult = "no-result";
        break;
      }

      if (i % 5 === 0 && i > 0) {
        console.log(`  Still loading... (${i}s)`);
      }
      await sleep(1000);
    }
    /* eslint-enable no-await-in-loop */

    const elapsed = ((Date.now() - quoteStart) / 1000).toFixed(1);

    if (quoteResult === "success") {
      const quoteText = (await page.textContent("body")) ?? "";
      const match = quoteText.match(/~([\d,.]+)\s*KALE/);
      console.log(`  ✓ Quote received in ${elapsed}s: ~${match?.[1] ?? "?"} KALE`);
      const minMatch = quoteText.match(/Minimum.*?([\d,.]+)\s*KALE/);
      if (minMatch) console.log(`  Minimum (3% slippage): ${minMatch[1]} KALE`);
    } else if (quoteResult === "error") {
      const errText = await page.evaluate(() => {
        const els = document.querySelectorAll('[class*="error"], [class*="Error"], [role="alert"]');
        return Array.from(els)
          .map((e) => e.textContent)
          .join(" | ");
      });
      console.log(`  ✗ Quote failed in ${elapsed}s: ${errText || "unknown"}`);
    } else {
      console.log(`  ✗ Quote ${quoteResult} after ${elapsed}s`);
      const bodySnippet = await page.evaluate(() => {
        const body = document.body.textContent || "";
        const idx = body.indexOf("SWAP");
        return idx >= 0 ? body.substring(idx, idx + 300) : body.substring(0, 300);
      });
      console.log(`  Body near swap: "${bodySnippet}"`);
    }

    await page.screenshot({ path: "scripts/test-wallet-quote.png" });
    console.log("  Screenshot saved to scripts/test-wallet-quote.png");
  }

  // ── Step 5: Test transfer form ──
  if (hasTransferSection) {
    console.log("\n-- Step 5: Test transfer form --");

    const recipientInput = page.locator("#recipient");
    const amountInput = page.locator("#transfer-amount");

    await recipientInput.fill("CA4IDVY45GSU4B3KTHF6MMFGCRD43NHB7AL46OC7D7U3RAVS5FQKUTIO");
    await amountInput.fill("10");
    console.log("  ✓ Filled transfer form (10 KALIEN to CA4I...)");

    await page.screenshot({ path: "scripts/test-wallet-transfer.png" });
    console.log("  Screenshot saved to scripts/test-wallet-transfer.png");
  }

  // ── Summary ──
  console.log("\n=== Console Log Summary ===");
  const errors = consoleLogs.filter((l) => l.startsWith("[error]"));
  const warnings = consoleLogs.filter((l) => l.startsWith("[warning]"));
  console.log(`  Total logs: ${consoleLogs.length}`);
  console.log(`  Errors: ${errors.length}`);
  console.log(`  Warnings: ${warnings.length}`);
  if (errors.length > 0) {
    console.log("\n  Error details:");
    for (const e of errors) console.log(`    ${e}`);
  }

  await browser.close();
  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
