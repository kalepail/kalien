/**
 * Bootstrap a Soroswap AMM pool on **testnet**: KALIEN/KALE at 100,000:1.
 *
 * End-to-end: friendbot → issue assets → deploy SACs → add_liquidity.
 * Much smaller amounts than mainnet (just enough for a working pool).
 *
 * Deposit: 1,000 KALE + 100,000,000 KALIEN (100M) in a single batch.
 *
 * Keys (loaded from `stellar keys show`):
 *   rich    — liquidity provider
 *   kalien  — KALIEN issuer (same vanity key as mainnet)
 *   testnet — KALE issuer on testnet
 *
 * Usage:
 *   bun run scripts/amm-deposit-testnet.ts             # dry run
 *   bun run scripts/amm-deposit-testnet.ts --submit     # execute on testnet
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

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;

// Current Soroswap testnet addresses (from soroswap/core testnet.contracts.json)
const SOROSWAP_ROUTER = "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD";

const KALIEN_CODE = "KALIEN";
const KALE_CODE = "KALE";

const DECIMALS = 7n;
const RATIO = 100_000n;

// Testnet amounts — smaller than mainnet, single batch
const DEPOSIT_KALE = 1_000n; // 1,000 KALE
const DEPOSIT_KALIEN = DEPOSIT_KALE * RATIO; // 100,000,000 KALIEN

const submitMode = process.argv.includes("--submit");

// ── Load keys from stellar CLI ──────────────────────────────────────────

function loadSecret(name: string): string {
  return execSync(`stellar keys show ${name}`, { encoding: "utf-8" }).trim();
}

const richKeypair = Keypair.fromSecret(loadSecret("rich"));
const kalienKeypair = Keypair.fromSecret(loadSecret("kalien"));
const kaleKeypair = Keypair.fromSecret(loadSecret("testnet"));

const RICH_ADDRESS = richKeypair.publicKey();
const KALIEN_ISSUER = kalienKeypair.publicKey();
const KALE_ISSUER = kaleKeypair.publicKey();

const kalienAsset = new Asset(KALIEN_CODE, KALIEN_ISSUER);
const kaleAsset = new Asset(KALE_CODE, KALE_ISSUER);

console.log("Rich:           ", RICH_ADDRESS);
console.log("KALIEN issuer:  ", KALIEN_ISSUER);
console.log("KALE issuer:    ", KALE_ISSUER);
console.log("Mode:           ", submitMode ? "SUBMIT" : "DRY RUN");
console.log();

// ── Clients ─────────────────────────────────────────────────────────────

const horizon = new Horizon.Server(HORIZON_URL);
const sorobanRpc = new rpc.Server(RPC_URL);

// ── Helpers ─────────────────────────────────────────────────────────────

async function friendbot(address: string, label: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(address)}`);
  if (res.ok) {
    console.log(`  ✓ Friendbot funded ${label} (${address.slice(0, 8)}...)`);
  } else {
    const text = await res.text();
    if (text.includes("createAccountAlreadyExist")) {
      console.log(`  ✓ ${label} already funded on testnet`);
    } else {
      throw new Error(`Friendbot failed for ${label}: ${text}`);
    }
  }
}

async function submitClassicTx(
  sourcePublicKey: string,
  signers: Keypair[],
  ops: ReturnType<typeof Operation.changeTrust>[],
  label: string,
): Promise<void> {
  const account = await horizon.loadAccount(sourcePublicKey);
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  for (const op of ops) {
    builder.addOperation(op);
  }

  const tx = builder.setTimeout(300).build();

  if (submitMode) {
    for (const signer of signers) {
      tx.sign(signer);
    }
    const result = await horizon.submitTransaction(tx);
    console.log(`  ✓ ${label}: ${(result as { hash: string }).hash}`);
  } else {
    console.log(`  [DRY RUN] ${label}`);
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
      console.log(`  ✓ ${label} succeeded!`);
      if (getResult.returnValue) {
        console.log("  Return:", scValToNative(getResult.returnValue));
      }
    } else {
      console.error(`  ${label} failed:`, getResult.status);
      process.exit(1);
    }
  } else {
    console.log(`  [DRY RUN] ${label} assembled OK`);
  }
}

function deploySac(asset: Asset, label: string): string {
  // Get the deterministic SAC address
  const assetStr = `${asset.getCode()}:${asset.getIssuer()}`;
  const sacAddress = execSync(`stellar contract id asset --asset "${assetStr}" --network testnet`, {
    encoding: "utf-8",
  }).trim();

  if (submitMode) {
    try {
      const result = execSync(
        `stellar contract asset deploy --asset "${assetStr}" --source-account rich --network testnet 2>&1`,
        { encoding: "utf-8" },
      ).trim();
      console.log(`  ✓ ${label} SAC deployed: ${result}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ExistingValue") || msg.includes("already exists")) {
        console.log(`  ✓ ${label} SAC already deployed: ${sacAddress}`);
      } else {
        throw err;
      }
    }
  } else {
    console.log(`  [DRY RUN] ${label} SAC would be: ${sacAddress}`);
  }

  return sacAddress;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const kaleRaw = DEPOSIT_KALE * 10n ** DECIMALS;
  const kalienRaw = DEPOSIT_KALIEN * 10n ** DECIMALS;

  console.log("=== Testnet Soroswap KALIEN/KALE Liquidity Pool ===");
  console.log(`Ratio: ${RATIO.toLocaleString()} KALIEN per 1 KALE`);
  console.log(
    `Deposit: ${DEPOSIT_KALE.toLocaleString()} KALE + ${DEPOSIT_KALIEN.toLocaleString()} KALIEN`,
  );
  console.log(`Soroswap Router: ${SOROSWAP_ROUTER}`);
  console.log();

  // ── Step 1: Fund accounts via friendbot ──
  console.log("-- Step 1: Fund accounts via Friendbot --");
  if (submitMode) {
    await friendbot(RICH_ADDRESS, "rich");
    await friendbot(KALIEN_ISSUER, "kalien issuer");
    await friendbot(KALE_ISSUER, "kale issuer");
  } else {
    console.log("  [DRY RUN] Would fund: rich, kalien, kale-issuer");
  }
  console.log();

  // ── Step 2: Add trustlines on rich ──
  console.log("-- Step 2: Add trustlines on rich --");
  if (submitMode) {
    // Check if trustlines already exist
    const richAccount = await horizon.loadAccount(RICH_ADDRESS);
    const hasKalien = richAccount.balances.some(
      (b) =>
        b.asset_type !== "native" &&
        "asset_code" in b &&
        b.asset_code === KALIEN_CODE &&
        "asset_issuer" in b &&
        b.asset_issuer === KALIEN_ISSUER,
    );
    const hasKale = richAccount.balances.some(
      (b) =>
        b.asset_type !== "native" &&
        "asset_code" in b &&
        b.asset_code === KALE_CODE &&
        "asset_issuer" in b &&
        b.asset_issuer === KALE_ISSUER,
    );

    const ops: ReturnType<typeof Operation.changeTrust>[] = [];
    if (!hasKalien) ops.push(Operation.changeTrust({ asset: kalienAsset }));
    if (!hasKale) ops.push(Operation.changeTrust({ asset: kaleAsset }));

    if (ops.length > 0) {
      await submitClassicTx(RICH_ADDRESS, [richKeypair], ops, "Trustlines");
    } else {
      console.log("  ✓ All trustlines already exist");
    }
  } else {
    console.log("  [DRY RUN] Would add KALIEN + KALE trustlines on rich");
  }
  console.log();

  // ── Step 3: Mint tokens to rich ──
  console.log("-- Step 3: Mint tokens to rich --");
  if (submitMode) {
    // Mint KALIEN from kalien issuer
    await submitClassicTx(
      KALIEN_ISSUER,
      [kalienKeypair],
      [
        Operation.payment({
          destination: RICH_ADDRESS,
          asset: kalienAsset,
          amount: DEPOSIT_KALIEN.toString(),
        }),
      ],
      `Mint ${DEPOSIT_KALIEN.toLocaleString()} KALIEN`,
    );

    // Mint KALE from kale issuer
    await submitClassicTx(
      KALE_ISSUER,
      [kaleKeypair],
      [
        Operation.payment({
          destination: RICH_ADDRESS,
          asset: kaleAsset,
          amount: DEPOSIT_KALE.toString(),
        }),
      ],
      `Mint ${DEPOSIT_KALE.toLocaleString()} KALE`,
    );
  } else {
    console.log(`  [DRY RUN] Would mint ${DEPOSIT_KALIEN.toLocaleString()} KALIEN to rich`);
    console.log(`  [DRY RUN] Would mint ${DEPOSIT_KALE.toLocaleString()} KALE to rich`);
  }
  console.log();

  // ── Step 4: Deploy SACs ──
  console.log("-- Step 4: Deploy Stellar Asset Contracts --");
  const kalienSac = deploySac(kalienAsset, "KALIEN");
  const kaleSac = deploySac(kaleAsset, "KALE");
  console.log();

  // Brief wait for SAC state to propagate
  if (submitMode) {
    console.log("  Waiting 5s for SAC state propagation...");
    await new Promise((r) => setTimeout(r, 5000));
  }

  // ── Step 5: Add liquidity ──
  console.log("-- Step 5: Add liquidity to Soroswap --");
  const router = new Contract(SOROSWAP_ROUTER);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const account = submitMode
    ? await sorobanRpc.getAccount(RICH_ADDRESS)
    : await sorobanRpc.getAccount(RICH_ADDRESS).catch(() => {
        // In dry run, create a dummy if account not found
        console.log("  [DRY RUN] Cannot load account from Soroban RPC, skipping tx build");
        return null;
      });

  if (account) {
    const tx = new TransactionBuilder(account, {
      fee: "10000000",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        router.call(
          "add_liquidity",
          new Address(kaleSac).toScVal(),
          new Address(kalienSac).toScVal(),
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
  console.log();

  // ── Summary ──
  console.log("=== Summary ===");
  console.log(`KALIEN SAC (testnet): ${kalienSac}`);
  console.log(`KALE SAC (testnet):   ${kaleSac}`);
  console.log(`KALE Issuer:          ${KALE_ISSUER}`);
  console.log();
  console.log("Add to your .env for the swap UI to work on testnet:");
  console.log(`  VITE_KALE_SAC=${kaleSac}`);
  console.log();

  if (kalienSac !== "CBUCDXT6BY3WWP764AMW66QJA6ZRWL2TRV6VTYCWPZF4FUZRAXK2S253") {
    console.log("⚠  KALIEN SAC differs from VITE_TOKEN_CONTRACT_ID in .env.");
    console.log(`   You may need to update VITE_TOKEN_CONTRACT_ID=${kalienSac}`);
    console.log();
  }

  console.log("Done!");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
