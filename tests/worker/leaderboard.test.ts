import { describe, expect, it } from "bun:test";
import {
  computeLeaderboard,
  extractLeaderboardRuns,
  MAX_LEADERBOARD_OFFSET,
  parseLeaderboardWindow,
} from "../../worker/leaderboard";
import type { LeaderboardEventRecord } from "../../worker/types";

function makeEvent({
  eventId,
  claimantAddress,
  seed,
  frameCount,
  previousBest,
  newBest,
  closedAt,
}: {
  eventId: string;
  claimantAddress: string;
  seed: number;
  frameCount?: number | null;
  previousBest: number;
  newBest: number;
  closedAt: string;
}): LeaderboardEventRecord {
  return {
    eventId,
    claimantAddress,
    seed,
    frameCount: frameCount ?? null,
    finalScore: newBest >>> 0,
    previousBest,
    newBest,
    mintedDelta: Math.max(0, newBest - previousBest),
    txHash: `tx-${eventId}`,
    eventIndex: 0,
    ledger: 123,
    closedAt,
    source: "galexie",
    ingestedAt: "2026-02-11T10:30:00.000Z",
  };
}

describe("leaderboard helpers", () => {
  it("parses leaderboard windows", () => {
    expect(parseLeaderboardWindow(undefined)).toBe("10m");
    expect(parseLeaderboardWindow("day")).toBe("day");
    expect(parseLeaderboardWindow("all")).toBe("all");
    expect(parseLeaderboardWindow("weekly")).toBeNull();
  });

  it("extracts runs from events and ranks unique claimants by best score", () => {
    const events: LeaderboardEventRecord[] = [
      makeEvent({
        eventId: "evt-a1",
        claimantAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
        seed: 1,
        frameCount: 900,
        previousBest: 0,
        newBest: 1200,
        closedAt: "2026-02-11T10:00:00.000Z",
      }),
      makeEvent({
        eventId: "evt-a2",
        claimantAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
        seed: 1,
        frameCount: 1200,
        previousBest: 1200,
        newBest: 1800,
        closedAt: "2026-02-11T10:05:00.000Z",
      }),
      makeEvent({
        eventId: "evt-b1",
        claimantAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEGWF",
        seed: 8,
        frameCount: 1100,
        previousBest: 0,
        newBest: 1500,
        closedAt: "2026-02-11T10:01:00.000Z",
      }),
    ];

    const runs = extractLeaderboardRuns(events);
    expect(runs).toHaveLength(3);

    const page = computeLeaderboard(runs, {
      window: "all",
      nowMs: Date.UTC(2026, 1, 11, 10, 10, 0),
      limit: 20,
      offset: 0,
    });

    expect(page.totalPlayers).toBe(2);
    expect(page.entries[0]?.claimantAddress).toBe(
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
    );
    expect(page.entries[0]?.score).toBe(1800);
    expect(page.entries[0]?.frameCount).toBe(1200);
    expect(page.entries[0]?.mintedDelta).toBe(600);
    expect(page.entries[1]?.claimantAddress).toBe(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEGWF",
    );
  });

  it("filters rolling 10-minute windows", () => {
    const events: LeaderboardEventRecord[] = [
      makeEvent({
        eventId: "old",
        claimantAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
        seed: 1,
        previousBest: 0,
        newBest: 500,
        closedAt: "2026-02-11T09:59:59.000Z",
      }),
      makeEvent({
        eventId: "fresh",
        claimantAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEGWF",
        seed: 1,
        previousBest: 0,
        newBest: 900,
        closedAt: "2026-02-11T10:09:30.000Z",
      }),
    ];

    const runs = extractLeaderboardRuns(events);
    const page = computeLeaderboard(runs, {
      window: "10m",
      nowMs: Date.UTC(2026, 1, 11, 10, 10, 0),
      limit: 10,
      offset: 0,
    });

    expect(page.totalPlayers).toBe(1);
    expect(page.entries[0]?.jobId).toBe("fresh");
  });

  it("clamps offsets to the configured maximum", () => {
    const events: LeaderboardEventRecord[] = [
      makeEvent({
        eventId: "evt-a",
        claimantAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAITA4",
        seed: 1,
        previousBest: 0,
        newBest: 1000,
        closedAt: "2026-02-11T10:00:00.000Z",
      }),
      makeEvent({
        eventId: "evt-b",
        claimantAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEGWF",
        seed: 2,
        previousBest: 0,
        newBest: 900,
        closedAt: "2026-02-11T10:00:01.000Z",
      }),
    ];
    const runs = extractLeaderboardRuns(events);
    const page = computeLeaderboard(runs, {
      window: "all",
      nowMs: Date.UTC(2026, 1, 11, 10, 10, 0),
      limit: 10,
      offset: MAX_LEADERBOARD_OFFSET + 10_000,
    });

    expect(page.offset).toBe(MAX_LEADERBOARD_OFFSET);
    expect(page.entries).toHaveLength(0);
  });
});
