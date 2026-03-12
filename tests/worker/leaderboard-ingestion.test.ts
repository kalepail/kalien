import { describe, expect, it } from "bun:test";
import { normalizeGalexieScoreEvents } from "../../worker/leaderboard-ingestion";

describe("normalizeGalexieScoreEvents", () => {
  it("normalizes ScoreSubmitted-style payloads", () => {
    const payload = {
      events: [
        {
          id: "evt-1",
          claimant: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
          seed: "42",
          frame_count: 2048,
          final_score: 1337,
          previous_best: 1000,
          new_best: 1337,
          minted_delta: 337,
          tx_hash: "tx-1",
          event_index: 2,
          ledger: 777,
          closed_at: "2026-02-11T12:00:00.000Z",
        },
      ],
      next_cursor: "cursor-2",
    };

    const normalized = normalizeGalexieScoreEvents(payload, "2026-02-11T12:01:00.000Z");
    expect(normalized.fetchedCount).toBe(1);
    expect(normalized.events).toHaveLength(1);
    expect(normalized.nextCursor).toBe("cursor-2");
    expect(normalized.events[0]?.claimantAddress).toBe(
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
    );
    expect(normalized.events[0]?.frameCount).toBe(2048);
    expect(normalized.events[0]?.finalScore).toBe(1337);
    expect(normalized.events[0]?.newBest).toBe(1337);
    expect(normalized.events[0]?.source).toBe("galexie");
  });

  it("accepts minimal event payloads", () => {
    const payload = {
      events: [
        {
          id: "evt-minimal",
          claimant: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
          seed: 99,
          frame_count: 512,
          final_score: 2048,
          previous_best: 1024,
          new_best: 2048,
          minted_delta: 1024,
          tx_hash: "tx-minimal",
          event_index: 3,
          ledger: 778,
          closed_at: "2026-02-11T12:05:00.000Z",
        },
      ],
    };

    const normalized = normalizeGalexieScoreEvents(payload, "2026-02-11T12:06:00.000Z");
    expect(normalized.fetchedCount).toBe(1);
    expect(normalized.events).toHaveLength(1);
    expect(normalized.events[0]?.newBest).toBe(2048);
    expect(normalized.events[0]?.mintedDelta).toBe(1024);
  });

  it("keeps salvageable events and skips only invalid claimant rows", () => {
    const payload = {
      events: [
        {
          id: "bad-1",
          claimant: "not-a-stellar-address",
          seed: 1,
          new_best: 10,
          closed_at: "2026-02-11T12:00:00.000Z",
        },
        {
          id: "bad-2",
          claimant: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
          seed: 1,
          new_best: 0,
          closed_at: "2026-02-11T12:00:00.000Z",
        },
      ],
    };

    const normalized = normalizeGalexieScoreEvents(payload);
    expect(normalized.fetchedCount).toBe(2);
    expect(normalized.events).toHaveLength(1);
    expect(normalized.events[0]?.eventId).toBe("bad-2");
    expect(normalized.events[0]?.finalScore).toBe(0);
  });

  it("rejects events with contradictory explicit score invariants", () => {
    const payload = {
      events: [
        {
          id: "bad-invariants",
          claimant: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
          seed: 1,
          frame_count: 10,
          final_score: 100,
          previous_best: 0,
          new_best: 99,
          minted_delta: 100,
          closed_at: "2026-02-11T12:00:00.000Z",
        },
      ],
    };

    const normalized = normalizeGalexieScoreEvents(payload);
    expect(normalized.fetchedCount).toBe(1);
    expect(normalized.events).toHaveLength(0);
  });
});
