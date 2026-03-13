import { describe, expect, it } from "bun:test";
import {
  Account,
  Contract,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { buildSwapRelayPayload, requireSwapSubmissionHash } from "../../src/chain/swap";

describe("buildSwapRelayPayload", () => {
  it("extracts func/auth payload for the relayer soroban path", () => {
    const sourceAccount = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "1");
    const router = new Contract("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4");

    const assembled = new TransactionBuilder(sourceAccount, {
      fee: "1000000",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(router.call("swap_exact_tokens_for_tokens"))
      .setTimeout(300)
      .build();

    const relayPayload = buildSwapRelayPayload(assembled.toXDR(), []);
    expect(relayPayload.auth).toEqual([]);

    const func = xdr.HostFunction.fromXDR(relayPayload.func, "base64");
    expect(func.switch().name).toBe("hostFunctionTypeInvokeContract");
  });

  it("fails clearly when the transaction does not contain the expected swap op", () => {
    const sourceAccount = new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "1");

    const assembled = new TransactionBuilder(sourceAccount, {
      fee: "1000000",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(300)
      .build();

    expect(() => buildSwapRelayPayload(assembled.toXDR(), [])).toThrow(
      "swap submission requires an invokeHostFunction operation",
    );
  });

  it("rejects relay responses that omit the transaction hash", () => {
    expect(() => requireSwapSubmissionHash({ success: true, data: {} })).toThrow(
      "swap submission missing tx hash",
    );
  });
});
