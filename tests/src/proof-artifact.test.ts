import { describe, expect, it } from "bun:test";
import { extractGroth16SealFromArtifact } from "../../src/proof/artifact";
import {
  encodeClaimantForJournal,
  JOURNAL_LEN,
  packJournalRaw,
} from "../../shared/stellar/journal";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

describe("extractGroth16SealFromArtifact", () => {
  it("reads the 260-byte stellar seal from v4 artifact payload", () => {
    const sealBytes = new Uint8Array(260);
    for (let i = 0; i < sealBytes.length; i += 1) {
      sealBytes[i] = i & 0xff;
    }
    const artifact = {
      version: "v4",
      seal_hex: toHex(sealBytes),
    };

    const seal = extractGroth16SealFromArtifact(artifact);
    expect(seal.length).toBe(260);
    expect(Array.from(seal.slice(0, 4))).toEqual([0, 1, 2, 3]);
    expect(Array.from(seal.slice(4, 12))).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
    expect(seal[259]).toBe(3);
  });

  it("throws on unsupported artifact versions", () => {
    const artifact = {
      version: "v3",
      seal_hex: "00".repeat(260),
    };

    expect(() => extractGroth16SealFromArtifact(artifact)).toThrow("unsupported proof artifact");
  });
});

describe("packJournalRaw", () => {
  it("encodes journal fields as fixed-length little-endian payload", () => {
    const claimant = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const raw = packJournalRaw({
      seed_id: 12345,
      seed: 0xdeadbeef,
      frame_count: 3980,
      final_score: 90,
      claimant,
    });

    expect(raw.length).toBe(JOURNAL_LEN);
    expect(toHex(raw.slice(0, 16))).toBe("39300000efbeadde8c0f00005a000000");
    expect(raw.slice(16, 49)).toEqual(encodeClaimantForJournal(claimant));
  });
});
