import { describe, expect, it } from "bun:test";
import { Asset, Networks } from "@stellar/stellar-sdk";
import { parseSacAssetFromName } from "../../src/chain/token";

const KALIEN_SAC_NAME = "KALIEN:GCHPTWXMT3HYF4RLZHWBNRF4MPXLTJ76ISHMSYIWCCDXWUYOQG5MR2AB";
const KALIEN_TOKEN_CONTRACT_ID = "CDC6PHLNYLH6Q3SICJDNMGQLBMGLDFYEHSJHZ46DYB2TCEZZUGN723RU";

describe("parseSacAssetFromName", () => {
  it("parses native SAC names", () => {
    const asset = parseSacAssetFromName("native");
    expect(asset.toString()).toBe("native");
  });

  it("parses code:issuer SAC names and derives the known SAC contract id", () => {
    const asset = parseSacAssetFromName(KALIEN_SAC_NAME);
    expect(asset.toString()).toBe(KALIEN_SAC_NAME);
    expect(asset.contractId(Networks.TESTNET)).toBe(KALIEN_TOKEN_CONTRACT_ID);
  });

  it("rejects contract-id strings as asset names", () => {
    expect(() => parseSacAssetFromName(KALIEN_TOKEN_CONTRACT_ID)).toThrow(
      `invalid stellar asset name "${KALIEN_TOKEN_CONTRACT_ID}"`,
    );
  });
});

describe("Asset constructor contract-id handling", () => {
  it("does not accept a C-address as issuer", () => {
    expect(() => new Asset("KALIEN", KALIEN_TOKEN_CONTRACT_ID)).toThrow("Issuer is invalid");
  });

  it("does not accept a C-address as code", () => {
    expect(() => new Asset(KALIEN_TOKEN_CONTRACT_ID)).toThrow("Asset code is invalid");
  });
});
