import { describe, expect, it } from "bun:test";
import { decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
const {
  assertCredentialBelongsToClaimantContract,
  base64UrlToHex,
  encodeRawP256PublicKeyBase64UrlToCose,
  fetchIndexedContractsForCredential,
} = await import("../../worker/leaderboard-profile-auth.ts?suite=real");

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

describe("leaderboard profile auth helpers", () => {
  it("converts base64url credential ids to lowercase hex", () => {
    expect(base64UrlToHex("AQIDBA")).toBe("01020304");
    expect(base64UrlToHex("3q2-7w")).toBe("deadbeef");
  });

  it("encodes raw secp256r1 public keys into COSE format", () => {
    const raw = new Uint8Array(65);
    raw[0] = 0x04;
    for (let index = 1; index < raw.length; index += 1) {
      raw[index] = index;
    }

    const cose = encodeRawP256PublicKeyBase64UrlToCose(bytesToBase64Url(raw));
    const decoded = decodeCredentialPublicKey(cose);

    expect(decoded.get(1)).toBe(2);
    expect(decoded.get(3)).toBe(-7);
    expect(decoded.get(-1)).toBe(1);
    expect(Array.from(decoded.get(-2) as Uint8Array)).toEqual(Array.from(raw.slice(1, 33)));
    expect(Array.from(decoded.get(-3) as Uint8Array)).toEqual(Array.from(raw.slice(33, 65)));
  });

  it("rejects malformed raw public keys", () => {
    expect(() =>
      encodeRawP256PublicKeyBase64UrlToCose(bytesToBase64Url(new Uint8Array([0x04, 0x01, 0x02]))),
    ).toThrow("65-byte");
    expect(() =>
      encodeRawP256PublicKeyBase64UrlToCose(bytesToBase64Url(new Uint8Array(65))),
    ).toThrow("65-byte");
  });

  it("looks up indexed contracts by credential id", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(typeof input === "string" ? input : input.toString());
      return new Response(
        JSON.stringify({
          contracts: [{ contract_id: "CAAA" }, { contract_id: "CBBB" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const contracts = await fetchIndexedContractsForCredential({
      credentialIdBase64Url: "3q2-7w",
      baseUrl: "https://example-indexer.test/",
      fetchImpl,
    });

    expect(urls[0]).toBe("https://example-indexer.test/api/lookup/deadbeef");
    expect(contracts).toEqual(["CAAA", "CBBB"]);
  });

  it("requires claimant contract linkage from indexer", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          contracts: [{ contract_id: "COTHER" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    await expect(
      assertCredentialBelongsToClaimantContract({
        claimantAddress: "CAAAAA",
        credentialIdBase64Url: "AQIDBA",
        fetchImpl,
      }),
    ).rejects.toMatchObject<Partial<LeaderboardCredentialBindingError>>({
      name: "LeaderboardCredentialBindingError",
      statusCode: 403,
      retryable: false,
    });
  });

  it("marks indexer upstream failures as retryable", async () => {
    const fetchImpl = (async () => new Response("upstream down", { status: 503 })) as typeof fetch;

    await expect(
      assertCredentialBelongsToClaimantContract({
        claimantAddress: "CAAAAA",
        credentialIdBase64Url: "AQIDBA",
        fetchImpl,
      }),
    ).rejects.toMatchObject<Partial<LeaderboardCredentialBindingError>>({
      name: "LeaderboardCredentialBindingError",
      statusCode: 503,
      retryable: true,
    });
  });
});
