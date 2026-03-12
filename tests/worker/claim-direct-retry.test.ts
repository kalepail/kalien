import { describe, expect, it } from "bun:test";
import { isRetryableDirectClaimMessage } from "../../worker/claim/direct";

describe("isRetryableDirectClaimMessage", () => {
  it("retries transient network failures", () => {
    expect(isRetryableDirectClaimMessage("Network connection lost.")).toBe(true);
    expect(
      isRetryableDirectClaimMessage("rpc simulateTransaction request failed with HTTP 503"),
    ).toBe(true);
    expect(isRetryableDirectClaimMessage("Fetch failed: connection reset by peer")).toBe(true);
    expect(
      isRetryableDirectClaimMessage("internal error; reference = q56n24hg30ocu0h4acq2v75h"),
    ).toBe(true);
  });

  it("retries transient auth, nonce, and fee-market relayer failures", () => {
    expect(
      isRetryableDirectClaimMessage(
        "Plugin error: Auth entry signatureExpirationLedger too close to current ledger",
      ),
    ).toBe(true);
    expect(
      isRetryableDirectClaimMessage(
        "Plugin error (auth_expiry_too_short): auth entry expires too soon",
      ),
    ).toBe(true);
    expect(
      isRetryableDirectClaimMessage("Signed auth entry validation failed: nonce already exists"),
    ).toBe(true);
    expect(
      isRetryableDirectClaimMessage("Signed auth entry validation failed: signature has expired"),
    ).toBe(true);
    expect(isRetryableDirectClaimMessage("onchain failed: txInsufficientFee")).toBe(true);
    expect(isRetryableDirectClaimMessage("onchain failed: txFeeBumpInnerFailed")).toBe(true);
  });

  it("does not retry opaque simulation failures (handled at higher level)", () => {
    // Bare "Simulation failed" with no transient indicator is not retryable
    // by this function — the SIMULATION_FAILED code path is handled by
    // isRetryableChannelsExecution which checks for fatal indicators first.
    expect(isRetryableDirectClaimMessage("Simulation failed (SIMULATION_FAILED)")).toBe(false);
  });

  it("does not retry deterministic contract/input failures", () => {
    expect(
      isRetryableDirectClaimMessage("HostError: Error(Contract, #3) Event log (newest first): ..."),
    ).toBe(false);
    expect(isRetryableDirectClaimMessage("trustline entry is missing for account")).toBe(false);
    expect(isRetryableDirectClaimMessage("account not found: GABC...")).toBe(false);
  });
});
