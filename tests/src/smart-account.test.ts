import { describe, expect, it, mock } from "bun:test";
import {
  Account,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

function MockIndexedDBStorage() {}

function MockSmartAccountKit() {}

mock.module("smart-account-kit", () => ({
  IndexedDBStorage: MockIndexedDBStorage,
  SmartAccountKit: MockSmartAccountKit,
  validateAddress: () => undefined,
}));

mock.module("../../shared/stellar/strkey", () => ({
  parseClaimantStrKeyFromUserInput: (
    value: string,
  ): {
    normalized: string;
    type: "account" | "contract";
  } => ({
    normalized: value.trim(),
    type: value.trim().startsWith("C") ? "contract" : "account",
  }),
}));

const { signBuiltDeploymentTransaction } =
  await import("../../src/wallet/smartAccount.ts?test=smart-account");

describe("signBuiltDeploymentTransaction", () => {
  it("preserves the assembled Soroban fee instead of doubling the resource fee", () => {
    const deployerKeypair = Keypair.random();
    const sourceAccount = new Account(deployerKeypair.publicKey(), "1");
    const resourceFee = 169_698n;
    const classicFee = 100n;
    const sorobanData = new SorobanDataBuilder().setResourceFee(resourceFee).build();

    const builtTransaction = new TransactionBuilder(sourceAccount, {
      fee: classicFee.toString(),
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.restoreFootprint({}))
      .setSorobanData(sorobanData)
      .setTimeout(30)
      .build();

    expect(BigInt(builtTransaction.fee)).toBe(classicFee + resourceFee);

    const sdkClone = TransactionBuilder.cloneFrom(builtTransaction, {
      fee: builtTransaction.fee,
      timebounds: undefined,
      sorobanData,
    })
      .setTimeout(30)
      .build();

    expect(BigInt(sdkClone.fee)).toBe(classicFee + resourceFee * 2n);

    const deployTx = { built: builtTransaction };
    signBuiltDeploymentTransaction(deployTx, deployerKeypair);

    expect(deployTx.signed).toBe(builtTransaction);
    if (!deployTx.signed) {
      throw new Error("expected deployment transaction to be signed");
    }
    expect(BigInt(deployTx.signed.fee)).toBe(classicFee + resourceFee);
    expect(deployTx.signed.signatures).toHaveLength(1);
  });

  it("fails fast when the deploy transaction was not built", () => {
    expect(() => signBuiltDeploymentTransaction({}, Keypair.random())).toThrow(
      "deployment transaction has not been built",
    );
  });
});
