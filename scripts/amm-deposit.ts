/**
 * Seed a Soroswap AMM pool: KALIEN/KALE at 100,000:1 ratio.
 *
 * Deposit: 40,000,000 KALE + 4,000,000,000,000 KALIEN (4 trillion)
 *
 * Classic Stellar int64 caps trustline balances at ~922B, so we batch
 * into 5 rounds of (8M KALE + 800B KALIEN). Each round:
 *   a. Mint 800B KALIEN to `rich` (skipped if rich already holds enough)
 *   b. add_liquidity on Soroswap Router (Soroban TX signed by `rich`)
 * The first round creates the pair; subsequent rounds add to it.
 *
 * Usage:
 *   bun run scripts/amm-deposit.ts                    # dry run
 *   bun run scripts/amm-deposit.ts --submit            # all 5 batches
 *   bun run scripts/amm-deposit.ts --submit --batch 2  # resume from batch 2
 *
 * Keys loaded via: stellar keys show rich / stellar keys show kalien
 */

import {
  Asset,
  Keypair,
  Operation,
  TransactionBuilder,
  Networks,
  Contract,
  Address,
  nativeToScVal,
  rpc,
  Horizon,
  BASE_FEE,
  scValToNative,
} from "@stellar/stellar-sdk";
import { execSync } from "child_process";

// ── Config ──────────────────────────────────────────────────────────────

const HORIZON_URL = "https://horizon.stellar.org";
const RPC_URL = "https://rpc.lightsail.network";
const NETWORK_PASSPHRASE = Networks.PUBLIC;

const KALIEN_CODE = "KALIEN";
const KALIEN_ISSUER = "GB53F5Y2DC5ZNRVMTVNUECM5DVTGY2SFJMHE3DWO53CGL62OXKKALIEN";
const KALE_SAC = "CB23WRDQWGSP6YPMY4UV5C4OW5CBTXKYN3XEATG7KJEZCXMJBYEHOUOV";
const KALIEN_SAC = "CB4YK5LZG2EGRHJOS4WNX7AAFP3RR3RS5YJUC6D52V2HDT7EQO2QDF6T";
const SOROSWAP_ROUTER = "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH";
const RICH_ADDRESS = "GD2GA2JF6OJURU36COZQWJLPEJ7XC3GB25TBD7U4ALCGKOG27262RICH";

const DECIMALS = 7n;
const RATIO = 100_000n;

// 5 batches of 800B KALIEN + 8M KALE (each fits in int64)
const BATCH_KALE = 8_000_000n;
const BATCH_KALIEN = 800_000_000_000n;
const TOTAL_BATCHES = 5;

const submitMode = process.argv.includes("--submit");
const startBatch = (() => {
  const idx = process.argv.indexOf("--batch");
  if (idx >= 0 && process.argv[idx + 1]) return parseInt(process.argv[idx + 1], 10);
  return 1;
})();

// ── Load keys from stellar CLI ──────────────────────────────────────────

function loadSecret(name: string): string {
  return execSync(`stellar keys show ${name}`, { encoding: "utf-8" }).trim();
}

const richKeypair = Keypair.fromSecret(loadSecret("rich"));
const kalienKeypair = Keypair.fromSecret(loadSecret("kalien"));

console.log("Rich:          ", richKeypair.publicKey());
console.log("Kalien issuer: ", kalienKeypair.publicKey());
console.log("Mode:          ", submitMode ? "SUBMIT" : "DRY RUN");
console.log("Start batch:   ", startBatch);
console.log();

// ── Clients ─────────────────────────────────────────────────────────────

const horizon = new Horizon.Server(HORIZON_URL);
const sorobanRpc = new rpc.Server(RPC_URL);
const kalienAsset = new Asset(KALIEN_CODE, KALIEN_ISSUER);

// ── Helpers ─────────────────────────────────────────────────────────────

/** Fetch rich's current KALIEN balance (human units, e.g. 800000000000) */
async function getKalienBalance(): Promise<bigint> {
  const account = await horizon.loadAccount(RICH_ADDRESS);
  for (const b of account.balances) {
    if (
      b.asset_type !== "native" &&
      "asset_code" in b &&
      b.asset_code === KALIEN_CODE &&
      "asset_issuer" in b &&
      b.asset_issuer === KALIEN_ISSUER
    ) {
      // balance is a string like "800000000000.0000000"
      const parts = b.balance.split(".");
      return BigInt(parts[0]);
    }
  }
  return 0n;
}

/** Fetch rich's current KALE balance (human units) */
async function getKaleBalance(): Promise<bigint> {
  const account = await horizon.loadAccount(RICH_ADDRESS);
  for (const b of account.balances) {
    if (
      b.asset_type !== "native" &&
      "asset_code" in b &&
      b.asset_code === "KALE" &&
      "asset_issuer" in b &&
      b.asset_issuer === "GBDVX4VELCDSQ54KQJYTNHXAHFLBCA77ZY2USQBM4CSHTTV7DME7KALE"
    ) {
      const parts = b.balance.split(".");
      return BigInt(parts[0]);
    }
  }
  return 0n;
}

async function submitClassicTx(
  sourcePublicKey: string,
  signer: Keypair,
  op: ReturnType<typeof Operation.changeTrust>,
  label: string,
): Promise<void> {
  const account = await horizon.loadAccount(sourcePublicKey);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(300)
    .build();

  if (submitMode) {
    tx.sign(signer);
    const result = await horizon.submitTransaction(tx);
    console.log(`  ${label}:`, (result as { hash: string }).hash);
  } else {
    console.log(`  [DRY RUN] ${label} XDR:`);
    console.log(`  ${tx.toXDR()}`);
  }
}

async function submitSorobanTx(
  tx: ReturnType<typeof TransactionBuilder.prototype.build>,
  signer: Keypair,
  label: string,
): Promise<void> {
  console.log(`  Simulating ${label}...`);
  const simResult = await sorobanRpc.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    if (!submitMode) {
      console.log(`  [DRY RUN] Simulation failed (expected — prerequisites not yet on-chain)`);
      console.log(`  [DRY RUN] Pre-simulation TX XDR:`);
      console.log(`  ${tx.toXDR()}`);
      return;
    }
    console.error(`  Simulation FAILED:`, simResult.error);
    process.exit(1);
  }

  if ("minResourceFee" in simResult) {
    console.log(`  Min resource fee: ${simResult.minResourceFee} stroops`);
  }

  const assembled = rpc.assembleTransaction(tx, simResult).build();

  if (submitMode) {
    assembled.sign(signer);
    const sendResult = await sorobanRpc.sendTransaction(assembled);
    console.log(`  Submitted: ${sendResult.hash}`);

    if (sendResult.status === "ERROR") {
      console.error(`  Send rejected:`, sendResult.errorResult);
      process.exit(1);
    }

    let getResult = await sorobanRpc.getTransaction(sendResult.hash);
    /* eslint-disable no-await-in-loop -- transaction polling must remain sequential */
    while (getResult.status === "NOT_FOUND") {
      await new Promise((r) => setTimeout(r, 2000));
      getResult = await sorobanRpc.getTransaction(sendResult.hash);
    }
    /* eslint-enable no-await-in-loop */

    if (getResult.status === "SUCCESS") {
      console.log(`  ${label} succeeded!`);
      if (getResult.returnValue) {
        console.log("  Return:", scValToNative(getResult.returnValue));
      }
    } else {
      console.error(`  ${label} failed:`, getResult.status);
      process.exit(1);
    }
  } else {
    console.log(`  [DRY RUN] ${label} assembled XDR:`);
    console.log(`  ${assembled.toXDR()}`);
  }
}

// ── Step 1: KALIEN trustline on rich ────────────────────────────────────

async function ensureTrustline(): Promise<void> {
  const account = await horizon.loadAccount(RICH_ADDRESS);
  const hasTrustline = account.balances.some(
    (b) =>
      b.asset_type !== "native" &&
      "asset_code" in b &&
      b.asset_code === KALIEN_CODE &&
      "asset_issuer" in b &&
      b.asset_issuer === KALIEN_ISSUER,
  );

  if (hasTrustline) {
    console.log("  Trustline already exists, skipping.");
    return;
  }

  await submitClassicTx(
    RICH_ADDRESS,
    richKeypair,
    Operation.changeTrust({ asset: kalienAsset }),
    "Trustline added",
  );
}

// ── Batch: Mint + Add Liquidity ─────────────────────────────────────────

async function runBatch(index: number): Promise<void> {
  const kaleHuman = BATCH_KALE;
  const kalienHuman = BATCH_KALIEN;
  const kaleRaw = kaleHuman * 10n ** DECIMALS;
  const kalienRaw = kalienHuman * 10n ** DECIMALS;

  console.log(
    `  Batch ${index}/${TOTAL_BATCHES}: ${kaleHuman.toLocaleString()} KALE + ${kalienHuman.toLocaleString()} KALIEN`,
  );

  // ── Pre-flight: check KALE balance ──
  if (submitMode) {
    const kaleBal = await getKaleBalance();
    if (kaleBal < kaleHuman) {
      console.error(
        `  ABORT: Rich only has ${kaleBal.toLocaleString()} KALE, needs ${kaleHuman.toLocaleString()}`,
      );
      process.exit(1);
    }
    console.log(`  KALE balance: ${kaleBal.toLocaleString()} (need ${kaleHuman.toLocaleString()})`);
  }

  // ── a. Mint KALIEN (skip if rich already holds enough) ──
  if (submitMode) {
    const kalienBal = await getKalienBalance();
    if (kalienBal >= kalienHuman) {
      console.log(
        `  KALIEN balance: ${kalienBal.toLocaleString()} (>= ${kalienHuman.toLocaleString()}), skipping mint`,
      );
    } else {
      const mintNeeded = kalienHuman - kalienBal;
      console.log(
        `  KALIEN balance: ${kalienBal.toLocaleString()}, minting ${mintNeeded.toLocaleString()}...`,
      );
      await submitClassicTx(
        kalienKeypair.publicKey(),
        kalienKeypair,
        Operation.payment({
          destination: RICH_ADDRESS,
          asset: kalienAsset,
          amount: mintNeeded.toString(),
        }),
        `Mint ${mintNeeded.toLocaleString()} KALIEN`,
      );
      // Brief wait for state propagation to Soroban RPC
      await new Promise((r) => setTimeout(r, 3000));
    }
  } else {
    console.log(`  [DRY RUN] Would mint ${kalienHuman.toLocaleString()} KALIEN to rich`);
  }

  // ── b. add_liquidity on Soroswap Router ──
  const router = new Contract(SOROSWAP_ROUTER);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const account = await sorobanRpc.getAccount(RICH_ADDRESS);

  const tx = new TransactionBuilder(account, {
    fee: "10000000", // 1 XLM max fee
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      router.call(
        "add_liquidity",
        new Address(KALE_SAC).toScVal(),
        new Address(KALIEN_SAC).toScVal(),
        nativeToScVal(kaleRaw, { type: "i128" }),
        nativeToScVal(kalienRaw, { type: "i128" }),
        nativeToScVal(0n, { type: "i128" }), // amount_a_min
        nativeToScVal(0n, { type: "i128" }), // amount_b_min
        new Address(RICH_ADDRESS).toScVal(),
        nativeToScVal(deadline, { type: "u64" }),
      ),
    )
    .setTimeout(300)
    .build();

  await submitSorobanTx(tx, richKeypair, "add_liquidity");
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const totalKale = BATCH_KALE * BigInt(TOTAL_BATCHES);
  const totalKalien = BATCH_KALIEN * BigInt(TOTAL_BATCHES);

  console.log("=== Soroswap KALIEN/KALE Liquidity Pool ===");
  console.log(`Ratio: ${RATIO.toLocaleString()} KALIEN per 1 KALE`);
  console.log(`Total: ${totalKale.toLocaleString()} KALE + ${totalKalien.toLocaleString()} KALIEN`);
  console.log(
    `Batches: ${TOTAL_BATCHES} x (${BATCH_KALE.toLocaleString()} KALE + ${BATCH_KALIEN.toLocaleString()} KALIEN)`,
  );
  console.log();

  console.log("-- Step 1: Ensure KALIEN trustline on rich --");
  await ensureTrustline();
  console.log();

  console.log("-- Step 2+3: Mint + Add Liquidity (batched) --");
  /* eslint-disable no-await-in-loop -- liquidity batches are intentionally serialized */
  for (let i = startBatch; i <= TOTAL_BATCHES; i++) {
    await runBatch(i);
    if (submitMode && i < TOTAL_BATCHES) {
      console.log("  Waiting 5s before next batch...");
      await new Promise((r) => setTimeout(r, 5000));
    }
    console.log();
  }
  /* eslint-enable no-await-in-loop */

  if (submitMode) {
    console.log("-- Verification --");
    const kaleBal = await getKaleBalance();
    const kalienBal = await getKalienBalance();
    console.log(`  Rich KALE balance:   ${kaleBal.toLocaleString()}`);
    console.log(`  Rich KALIEN balance: ${kalienBal.toLocaleString()}`);
  }

  console.log("Done!");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
