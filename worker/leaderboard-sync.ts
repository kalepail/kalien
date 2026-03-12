import type { WorkerEnv } from "./env";
import {
  fetchLeaderboardEventsFromGalexie,
  type GalexieFetchResult,
} from "./leaderboard-ingestion";
import {
  countLeaderboardEvents,
  deleteProofClaimIndexEntry,
  countProofTapeMappings,
  countUnmappedLeaderboardTxHashes,
  deleteProofTapeMapping,
  getLeaderboardIngestionState,
  getMappedProofTapeMappings,
  getProofClaimIndexEntries,
  getProofClaimIndexEntriesByTxHashes,
  getUnmappedLeaderboardTxHashes,
  purgeExpiredLeaderboardProfileAuthChallenges,
  setLeaderboardIngestionState,
  upsertLeaderboardEvents,
  writeProofTapeMapping,
} from "./leaderboard-store";
import type {
  MappedProofTapeMapping,
  ProofClaimIndexEntry,
  UnmappedLeaderboardEvent,
} from "./leaderboard-store";
import type { LeaderboardEventRecord, LeaderboardIngestionState, ProofJobRecord } from "./types";
import { parseInteger, safeErrorMessage } from "./utils";
import type { LeaderboardResolvedSourceMode } from "./leaderboard-ingestion";
import { tapeKey } from "./keys";
import {
  findBestMatchingProofJob,
  findExactMatchingProofJob,
  normalizeReplayTxHash,
  proofJobHasReplayTape,
} from "./replay-recovery";
import {
  DEFAULT_LEADERBOARD_FORWARD_REPLAY_WINDOW_LEDGERS,
  DEFAULT_LEADERBOARD_SYNC_MAX_PAGES,
  DEFAULT_LEADERBOARD_TAPE_BACKFILL_BATCH_SIZE,
  DEFAULT_LEADERBOARD_TAPE_BACKFILL_JOBS_PAGE_SIZE,
  DEFAULT_LEADERBOARD_TAPE_BACKFILL_MAX_BATCHES,
  DEFAULT_LEADERBOARD_TAPE_BACKFILL_MAX_JOBS_PER_CLAIMANT,
  DEFAULT_LEADERBOARD_TAPE_BACKFILL_MAX_PASSES,
  DEFAULT_LEADERBOARD_TAPE_BACKFILL_OLDEST_FIRST,
  DEFAULT_LEADERBOARD_TAPE_STALE_PRUNE_BATCH_SIZE,
  DEFAULT_LEADERBOARD_TAPE_STALE_PRUNE_MAX_BATCHES,
  DEFAULT_LEADERBOARD_TAPE_STALE_PRUNE_OLDEST_FIRST,
} from "./constants";
import { coordinatorStub } from "./durable/coordinator";

export interface LeaderboardSyncDeps {
  fetchLeaderboardEventsFromGalexie: typeof fetchLeaderboardEventsFromGalexie;
  countLeaderboardEvents: typeof countLeaderboardEvents;
  countUnmappedLeaderboardTxHashes?: typeof countUnmappedLeaderboardTxHashes;
  getLeaderboardIngestionState: typeof getLeaderboardIngestionState;
  purgeExpiredLeaderboardProfileAuthChallenges: typeof purgeExpiredLeaderboardProfileAuthChallenges;
  setLeaderboardIngestionState: typeof setLeaderboardIngestionState;
  upsertLeaderboardEvents: typeof upsertLeaderboardEvents;
  backfillProofTapeMappings?: typeof backfillProofTapeMappings;
  pruneStaleProofTapeMappings?: typeof pruneStaleProofTapeMappings;
}

const DEFAULT_SYNC_DEPS: LeaderboardSyncDeps = {
  fetchLeaderboardEventsFromGalexie,
  countLeaderboardEvents,
  countUnmappedLeaderboardTxHashes,
  getLeaderboardIngestionState,
  purgeExpiredLeaderboardProfileAuthChallenges,
  setLeaderboardIngestionState,
  upsertLeaderboardEvents,
};

export interface LeaderboardSyncRequest {
  mode: "forward" | "backfill";
  cursor?: string | null;
  fromLedger?: number | null;
  toLedger?: number | null;
  limit?: number;
  source?: LeaderboardResolvedSourceMode | "default" | null;
}

export interface LeaderboardSyncResult {
  mode: "forward" | "backfill";
  requested: {
    cursor: string | null;
    from_ledger: number | null;
    to_ledger: number | null;
    limit: number | null;
    source: LeaderboardResolvedSourceMode | "default";
  };
  fetched_count: number;
  accepted_count: number;
  inserted_count: number;
  updated_count: number;
  next_cursor: string | null;
  provider: "galexie" | "rpc";
  source_mode: LeaderboardResolvedSourceMode;
  state: LeaderboardIngestionState;
}

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (!raw) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return defaultValue;
}

function shouldRunCatchup(
  state: LeaderboardIngestionState,
  nowMs: number,
  intervalMinutes: number,
): boolean {
  if (intervalMinutes <= 0) {
    return false;
  }

  if (!state.lastBackfillAt) {
    return true;
  }

  return hasIntervalElapsed(state.lastBackfillAt, nowMs, intervalMinutes);
}

function hasIntervalElapsed(
  lastRunAt: string | null | undefined,
  nowMs: number,
  intervalMinutes: number,
): boolean {
  if (!lastRunAt) {
    return true;
  }

  const lastRunMs = new Date(lastRunAt).getTime();
  if (!Number.isFinite(lastRunMs)) {
    return true;
  }

  return nowMs - lastRunMs >= intervalMinutes * 60_000;
}

function parseLedgerCursor(cursor: string | null | undefined): number | null {
  if (!cursor || cursor.trim().length === 0) {
    return null;
  }

  const trimmed = cursor.trim();
  const normalized = trimmed.startsWith("ledger:")
    ? trimmed.slice("ledger:".length).trim()
    : trimmed;
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function extractLedgerFromOpaqueCursor(cursor: string | null | undefined): number | null {
  if (!cursor || cursor.trim().length === 0) {
    return null;
  }
  const trimmed = cursor.trim();
  if (trimmed.startsWith("ledger:")) {
    return null;
  }
  // RPC cursors may be "toid-subIndex" (e.g., "0004537142736896001-0000000000")
  // or plain toid. Extract the first numeric part and decode the ledger.
  const toidPart = trimmed.split("-")[0];
  if (!toidPart || !/^\d+$/.test(toidPart)) {
    return null;
  }
  try {
    const ledger = Number(BigInt(toidPart) >> 32n);
    return Number.isFinite(ledger) && ledger >= 0 ? ledger : null;
  } catch {
    return null;
  }
}

function parseForwardReplayWindowLedgers(env: WorkerEnv): number {
  void env;
  return DEFAULT_LEADERBOARD_FORWARD_REPLAY_WINDOW_LEDGERS;
}

function parseScheduledTapeBackfillConfig(env: WorkerEnv): {
  enabled: boolean;
  intervalMinutes: number;
  maxPasses: number;
  options: BackfillProofTapeMappingsOptions;
} {
  const enabled = parseBoolean(env.LEADERBOARD_TAPE_BACKFILL_ENABLED, true);
  const intervalMinutes = parseInteger(env.LEADERBOARD_TAPE_BACKFILL_INTERVAL_MINUTES, 10, 1);
  const maxPasses = DEFAULT_LEADERBOARD_TAPE_BACKFILL_MAX_PASSES;
  return {
    enabled,
    intervalMinutes,
    maxPasses,
    options: {
      unmappedBatchSize: DEFAULT_LEADERBOARD_TAPE_BACKFILL_BATCH_SIZE,
      maxUnmappedBatches: DEFAULT_LEADERBOARD_TAPE_BACKFILL_MAX_BATCHES,
      jobsPageSize: DEFAULT_LEADERBOARD_TAPE_BACKFILL_JOBS_PAGE_SIZE,
      maxJobsPerClaimant: DEFAULT_LEADERBOARD_TAPE_BACKFILL_MAX_JOBS_PER_CLAIMANT,
      oldestFirst: DEFAULT_LEADERBOARD_TAPE_BACKFILL_OLDEST_FIRST,
    },
  };
}

function parseScheduledStaleTapePruneConfig(env: WorkerEnv): {
  enabled: boolean;
  intervalMinutes: number;
  options: PruneStaleProofTapeMappingsOptions;
} {
  const enabled = parseBoolean(env.LEADERBOARD_TAPE_STALE_PRUNE_ENABLED, true);
  const intervalMinutes = parseInteger(env.LEADERBOARD_TAPE_STALE_PRUNE_INTERVAL_MINUTES, 30, 1);
  return {
    enabled,
    intervalMinutes,
    options: {
      mappedBatchSize: DEFAULT_LEADERBOARD_TAPE_STALE_PRUNE_BATCH_SIZE,
      maxMappedBatches: DEFAULT_LEADERBOARD_TAPE_STALE_PRUNE_MAX_BATCHES,
      oldestFirst: DEFAULT_LEADERBOARD_TAPE_STALE_PRUNE_OLDEST_FIRST,
    },
  };
}

// Keep sync writes below D1/SQLite variable ceilings, then split further if needed.
const SYNC_UPSERT_BATCH_SIZE = 64;

async function upsertLeaderboardEventsChunkWithFallback(
  env: WorkerEnv,
  deps: LeaderboardSyncDeps,
  events: LeaderboardEventRecord[],
): Promise<{ inserted: number; updated: number }> {
  if (events.length === 0) {
    return { inserted: 0, updated: 0 };
  }

  try {
    return await deps.upsertLeaderboardEvents(env, events);
  } catch (error) {
    if (events.length === 1) {
      throw new Error(
        `[leaderboard-sync] failed writing leaderboard event ${events[0].eventId}: ${safeErrorMessage(error)}`,
        { cause: error },
      );
    }

    const splitIndex = Math.floor(events.length / 2);
    const left = events.slice(0, splitIndex);
    const right = events.slice(splitIndex);
    console.warn(
      `[leaderboard-sync] upsert batch failed (size=${events.length}); retrying in halves (${left.length}+${right.length}): ${safeErrorMessage(error)}`,
    );

    const leftResult = await upsertLeaderboardEventsChunkWithFallback(env, deps, left);
    const rightResult = await upsertLeaderboardEventsChunkWithFallback(env, deps, right);
    return {
      inserted: leftResult.inserted + rightResult.inserted,
      updated: leftResult.updated + rightResult.updated,
    };
  }
}

async function upsertLeaderboardEventsSafely(
  env: WorkerEnv,
  deps: LeaderboardSyncDeps,
  events: LeaderboardEventRecord[],
): Promise<{ inserted: number; updated: number }> {
  if (events.length === 0) {
    return { inserted: 0, updated: 0 };
  }

  let inserted = 0;
  let updated = 0;
  for (let offset = 0; offset < events.length; offset += SYNC_UPSERT_BATCH_SIZE) {
    const batch = events.slice(offset, offset + SYNC_UPSERT_BATCH_SIZE);
    // eslint-disable-next-line no-await-in-loop
    const result = await upsertLeaderboardEventsChunkWithFallback(env, deps, batch);
    inserted += result.inserted;
    updated += result.updated;
  }

  return { inserted, updated };
}

export async function runLeaderboardSync(
  env: WorkerEnv,
  request: LeaderboardSyncRequest,
  deps: LeaderboardSyncDeps = DEFAULT_SYNC_DEPS,
): Promise<LeaderboardSyncResult> {
  const existingState = await deps.getLeaderboardIngestionState(env);
  const maxPages = DEFAULT_LEADERBOARD_SYNC_MAX_PAGES;

  const replayWindowLedgers = parseForwardReplayWindowLedgers(env);
  const persistedCursor =
    request.mode === "forward" ? (request.cursor ?? existingState.cursor) : null;
  const persistedCursorLedger = parseLedgerCursor(persistedCursor);

  let effectiveCursor = request.mode === "forward" ? persistedCursor : request.cursor;
  let effectiveFromLedger = request.fromLedger ?? null;
  let effectiveToLedger = request.toLedger ?? null;

  // Detect and discard stale opaque RPC cursors.
  // RPC cursors encode ledger via toid: BigInt(cursorPart) >> 32n.
  // If the cursor's implied ledger <= highestLedger, it's behind known territory.
  if (
    request.mode === "forward" &&
    effectiveCursor &&
    persistedCursorLedger === null &&
    existingState.highestLedger !== null
  ) {
    const cursorLedger = extractLedgerFromOpaqueCursor(effectiveCursor);
    if (cursorLedger !== null && cursorLedger <= existingState.highestLedger) {
      console.log(
        `[leaderboard-sync] discarding stale cursor` +
          ` (cursorLedger=${cursorLedger}, highestLedger=${existingState.highestLedger})` +
          ` — resuming from ledger ${existingState.highestLedger + 1}`,
      );
      effectiveCursor = null;
      effectiveFromLedger = existingState.highestLedger + 1;
    }
  }

  // When no opaque cursor is active, compute startLedger from anchor
  const hasActiveOpaqueCursor = Boolean(
    effectiveCursor && parseLedgerCursor(effectiveCursor) === null,
  );
  if (request.mode === "forward" && effectiveFromLedger === null && !hasActiveOpaqueCursor) {
    const anchorLedger = existingState.highestLedger ?? persistedCursorLedger;
    if (anchorLedger !== null) {
      effectiveFromLedger = Math.max(2, anchorLedger - replayWindowLedgers + 1);
      effectiveCursor = null;
      if (effectiveToLedger !== null && effectiveToLedger < effectiveFromLedger) {
        effectiveToLedger = effectiveFromLedger;
      }
    }
  }

  // Multi-page fetch loop.
  // Continues on full pages (drain remaining events) AND on empty/partial pages
  // when the scan hasn't reached the chain tip yet (bridge ledger gaps).
  // The RPC has a hard 10K ledger scan limit per request, so bridging a large gap
  // (e.g. 100K+ ledgers) requires multiple pages.
  const effectiveLimit = Math.min(Math.max(request.limit ?? 200, 1), 1000);
  const allEvents: LeaderboardEventRecord[] = [];
  let totalFetchedCount = 0;
  let paginationWarning: string | null = null;

  // eslint-disable-next-line no-await-in-loop
  let lastFetched: GalexieFetchResult = await deps.fetchLeaderboardEventsFromGalexie(env, {
    cursor: effectiveCursor,
    fromLedger: effectiveFromLedger,
    toLedger: effectiveToLedger,
    limit: effectiveLimit,
    source: request.source ?? null,
  });
  allEvents.push(...lastFetched.events);
  totalFetchedCount += lastFetched.fetchedCount;
  let pageCount = 1;

  while (pageCount < maxPages && lastFetched.nextCursor) {
    const isFullPage = lastFetched.fetchedCount >= effectiveLimit;
    if (!isFullPage) {
      // Empty or partial page — only continue if we're bridging a gap to the chain tip.
      // The RPC response cursor for an empty page encodes (endLedger - 1) via toid.
      // If that's still far from latestLedger, keep scanning forward.
      if (lastFetched.latestLedger === null) break;
      const scanEndLedger = extractLedgerFromOpaqueCursor(lastFetched.nextCursor);
      if (scanEndLedger === null || scanEndLedger >= lastFetched.latestLedger) break;
      console.log(
        `[leaderboard-sync] bridging ledger gap` +
          ` (scanEnd=${scanEndLedger}, latest=${lastFetched.latestLedger}, page=${pageCount + 1})`,
      );
    }

    let nextPage: GalexieFetchResult;
    try {
      // eslint-disable-next-line no-await-in-loop
      nextPage = await deps.fetchLeaderboardEventsFromGalexie(env, {
        cursor: lastFetched.nextCursor,
        // Preserve explicit sync bounds (especially backfill toLedger) across pages.
        // Opaque RPC cursors still suppress start/end internally.
        toLedger: effectiveToLedger,
        limit: effectiveLimit,
        source: request.source ?? null,
      });
    } catch (error) {
      paginationWarning = `pagination halted after page ${pageCount}: ${safeErrorMessage(error)}`;
      console.warn(`[leaderboard-sync] ${paginationWarning}`);
      break;
    }
    lastFetched = nextPage;
    allEvents.push(...lastFetched.events);
    totalFetchedCount += lastFetched.fetchedCount;
    pageCount += 1;
  }

  const upsert = await upsertLeaderboardEventsSafely(env, deps, allEvents);
  const hasBaselineState =
    existingState.totalEvents > 0 ||
    existingState.cursor !== null ||
    existingState.lastSyncedAt !== null;
  const totalEvents = hasBaselineState
    ? Math.max(existingState.totalEvents, 0) + upsert.inserted
    : await deps.countLeaderboardEvents(env);
  const ledgers = allEvents
    .map((event) => event.ledger)
    .filter((value): value is number => typeof value === "number");
  const highestLedgerFromBatch = ledgers.length > 0 ? Math.max(...ledgers) : null;

  // Advance highestLedger from event ledgers only — NOT from latestLedger.
  // Advancing to latestLedger would skip unscanned territory due to the RPC's
  // 10K ledger scan limit, causing the stale cursor detection to jump past
  // events that exist in the gap.
  const newHighestLedger =
    highestLedgerFromBatch !== null
      ? Math.max(existingState.highestLedger ?? 0, highestLedgerFromBatch)
      : existingState.highestLedger;

  const nowIso = new Date().toISOString();

  const nextState: LeaderboardIngestionState = {
    ...existingState,
    provider: lastFetched.provider,
    sourceMode: lastFetched.sourceMode,
    cursor: request.mode === "forward" ? (lastFetched.nextCursor ?? null) : existingState.cursor,
    highestLedger: newHighestLedger,
    lastSyncedAt: nowIso,
    lastBackfillAt: request.mode === "backfill" ? nowIso : existingState.lastBackfillAt,
    totalEvents,
    lastError: paginationWarning,
  };

  await deps.setLeaderboardIngestionState(env, nextState);

  return {
    mode: request.mode,
    requested: {
      cursor: effectiveCursor ?? null,
      from_ledger: effectiveFromLedger,
      to_ledger: effectiveToLedger,
      limit: request.limit ?? null,
      source: request.source ?? "default",
    },
    fetched_count: totalFetchedCount,
    accepted_count: allEvents.length,
    inserted_count: upsert.inserted,
    updated_count: upsert.updated,
    next_cursor: lastFetched.nextCursor,
    provider: lastFetched.provider,
    source_mode: lastFetched.sourceMode,
    state: nextState,
  };
}

export async function runScheduledLeaderboardSync(
  env: WorkerEnv,
  scheduledTimeMs = Date.now(),
  deps: LeaderboardSyncDeps = DEFAULT_SYNC_DEPS,
): Promise<{
  enabled: boolean;
  forward: LeaderboardSyncResult | null;
  catchup: LeaderboardSyncResult | null;
  warning: string | null;
  backfill_tape_mappings: BackfillTapeMappingsResult | null;
  remaining_unmapped_tape_mappings: number | null;
  prune_stale_tape_mappings: PruneStaleProofTapeMappingsResult | null;
  remaining_proof_tape_mappings: number | null;
}> {
  const enabled = parseBoolean(env.LEADERBOARD_SYNC_CRON_ENABLED, true);
  if (!enabled) {
    return {
      enabled: false,
      forward: null,
      catchup: null,
      warning: null,
      backfill_tape_mappings: null,
      remaining_unmapped_tape_mappings: null,
      prune_stale_tape_mappings: null,
      remaining_proof_tape_mappings: null,
    };
  }

  const limit = parseInteger(env.LEADERBOARD_SYNC_CRON_LIMIT, 200, 1);
  const catchupIntervalMinutes = parseInteger(env.LEADERBOARD_CATCHUP_INTERVAL_MINUTES, 30, 0);
  const catchupWindowLedgers = parseInteger(env.LEADERBOARD_CATCHUP_WINDOW_LEDGERS, 0, 0);

  const forward = await runLeaderboardSync(
    env,
    {
      mode: "forward",
      limit,
    },
    deps,
  );

  let catchup: LeaderboardSyncResult | null = null;
  let warning: string | null = null;

  if (
    catchupWindowLedgers > 0 &&
    shouldRunCatchup(forward.state, scheduledTimeMs, catchupIntervalMinutes)
  ) {
    const highestLedger = forward.state.highestLedger;
    if (highestLedger === null) {
      warning = "skipped catchup backfill because highest ledger is unknown";
    } else {
      const fromLedger = Math.max(2, highestLedger - catchupWindowLedgers);
      catchup = await runLeaderboardSync(
        env,
        {
          mode: "backfill",
          fromLedger,
          toLedger: highestLedger,
          limit,
          source: "datalake",
        },
        deps,
      );
    }
  }

  // Purge expired/used auth challenges so they don't accumulate between user requests.
  await deps.purgeExpiredLeaderboardProfileAuthChallenges(env);

  let maintenanceState = catchup?.state ?? forward.state;
  const maintenanceTimestamp = new Date(scheduledTimeMs).toISOString();

  let backfillResult: BackfillTapeMappingsResult | null = null;
  let remainingUnmapped: number | null = null;
  const backfillConfig = parseScheduledTapeBackfillConfig(env);
  if (
    backfillConfig.enabled &&
    hasIntervalElapsed(
      maintenanceState.lastTapeBackfillAt,
      scheduledTimeMs,
      backfillConfig.intervalMinutes,
    )
  ) {
    try {
      const runner = deps.backfillProofTapeMappings ?? backfillProofTapeMappings;
      const aggregate: BackfillTapeMappingsResult = {
        unmapped: 0,
        matched: 0,
        written: 0,
        errors: 0,
      };
      let initialized = false;

      for (let pass = 0; pass < backfillConfig.maxPasses; pass += 1) {
        // eslint-disable-next-line no-await-in-loop
        const passResult = await runner(env, undefined, backfillConfig.options);
        if (!initialized) {
          aggregate.unmapped = passResult.unmapped;
          initialized = true;
        }
        aggregate.matched += passResult.matched;
        aggregate.written += passResult.written;
        aggregate.errors += passResult.errors;

        if (passResult.unmapped === 0) {
          break;
        }
        if (passResult.written === 0) {
          // No progress in this pass — further passes will likely repeat.
          break;
        }
      }

      backfillResult = aggregate;
      try {
        const countUnmapped =
          deps.countUnmappedLeaderboardTxHashes ?? countUnmappedLeaderboardTxHashes;
        remainingUnmapped = await countUnmapped(env);
      } catch (error) {
        console.warn(
          `[leaderboard-sync] failed counting unmapped tape mappings: ${safeErrorMessage(error)}`,
        );
      }
      maintenanceState = {
        ...maintenanceState,
        lastTapeBackfillAt: maintenanceTimestamp,
      };
      await deps.setLeaderboardIngestionState(env, maintenanceState);
    } catch (error) {
      console.warn(`[leaderboard-sync] backfill: unexpected error: ${safeErrorMessage(error)}`);
    }
  }

  let pruneStaleResult: PruneStaleProofTapeMappingsResult | null = null;
  let remainingMapped: number | null = null;
  const stalePruneConfig = parseScheduledStaleTapePruneConfig(env);
  if (
    stalePruneConfig.enabled &&
    hasIntervalElapsed(
      maintenanceState.lastTapePruneAt,
      scheduledTimeMs,
      stalePruneConfig.intervalMinutes,
    )
  ) {
    try {
      const runner = deps.pruneStaleProofTapeMappings ?? pruneStaleProofTapeMappings;
      pruneStaleResult = await runner(env, undefined, stalePruneConfig.options);
      remainingMapped = pruneStaleResult.remainingMappings;
      maintenanceState = {
        ...maintenanceState,
        lastTapePruneAt: maintenanceTimestamp,
      };
      await deps.setLeaderboardIngestionState(env, maintenanceState);
    } catch (error) {
      console.warn(`[leaderboard-sync] stale-prune: unexpected error: ${safeErrorMessage(error)}`);
    }
  }

  return {
    enabled: true,
    forward,
    catchup,
    warning,
    backfill_tape_mappings: backfillResult,
    remaining_unmapped_tape_mappings: remainingUnmapped,
    prune_stale_tape_mappings: pruneStaleResult,
    remaining_proof_tape_mappings: remainingMapped,
  };
}

export async function recordLeaderboardSyncFailure(
  env: WorkerEnv,
  error: unknown,
  deps: LeaderboardSyncDeps = DEFAULT_SYNC_DEPS,
): Promise<void> {
  const existingState = await deps.getLeaderboardIngestionState(env);
  await deps.setLeaderboardIngestionState(env, {
    ...existingState,
    lastError: safeErrorMessage(error),
  });
}

export interface PruneStaleProofTapeMappingsResult {
  scanned: number;
  stale: number;
  deleted: number;
  errors: number;
  remainingMappings: number | null;
}

export interface PruneStaleProofTapeMappingsOptions {
  mappedBatchSize?: number;
  maxMappedBatches?: number;
  oldestFirst?: boolean;
}

interface PruneStaleProofTapeMappingsDeps {
  getMappedProofTapeMappings: typeof getMappedProofTapeMappings;
  getProofClaimIndexEntries: typeof getProofClaimIndexEntries;
  deleteProofTapeMapping: typeof deleteProofTapeMapping;
  deleteProofClaimIndexEntry: typeof deleteProofClaimIndexEntry;
  countProofTapeMappings: typeof countProofTapeMappings;
}

const PRUNE_MAPPED_BATCH_SIZE = 100;
const PRUNE_MAX_MAPPED_BATCHES = 20;
const DEFAULT_PRUNE_DEPS: PruneStaleProofTapeMappingsDeps = {
  getMappedProofTapeMappings,
  getProofClaimIndexEntries,
  deleteProofTapeMapping,
  deleteProofClaimIndexEntry,
  countProofTapeMappings,
};

interface StaleReplayCandidate {
  proofJobId: string;
  txHash: string;
}

export async function pruneStaleProofTapeMappings(
  env: WorkerEnv,
  deps: PruneStaleProofTapeMappingsDeps = DEFAULT_PRUNE_DEPS,
  options: PruneStaleProofTapeMappingsOptions = {},
): Promise<PruneStaleProofTapeMappingsResult> {
  const result: PruneStaleProofTapeMappingsResult = {
    scanned: 0,
    stale: 0,
    deleted: 0,
    errors: 0,
    remainingMappings: null,
  };

  const mappedBatchSize = Math.min(
    Math.max(Math.trunc(options.mappedBatchSize ?? PRUNE_MAPPED_BATCH_SIZE), 1),
    2_000,
  );
  const maxMappedBatches = Math.min(
    Math.max(Math.trunc(options.maxMappedBatches ?? PRUNE_MAX_MAPPED_BATCHES), 1),
    10_000,
  );
  const oldestFirst = options.oldestFirst !== false;

  const tapeCandidates: MappedProofTapeMapping[] = [];
  /* eslint-disable no-await-in-loop */
  for (let batch = 0; batch < maxMappedBatches; batch += 1) {
    const offset = batch * mappedBatchSize;
    const page = await deps.getMappedProofTapeMappings(env, {
      limit: mappedBatchSize,
      offset,
      oldestFirst,
    });
    if (page.length === 0) {
      break;
    }
    tapeCandidates.push(...page);
    if (page.length < mappedBatchSize) {
      break;
    }
  }
  const claimIndexCandidates: ProofClaimIndexEntry[] = [];
  for (let batch = 0; batch < maxMappedBatches; batch += 1) {
    const offset = batch * mappedBatchSize;
    const page = await deps.getProofClaimIndexEntries(env, {
      limit: mappedBatchSize,
      offset,
      oldestFirst,
    });
    if (page.length === 0) {
      break;
    }
    claimIndexCandidates.push(...page);
    if (page.length < mappedBatchSize) {
      break;
    }
  }
  /* eslint-enable no-await-in-loop */

  if (tapeCandidates.length === 0 && claimIndexCandidates.length === 0) {
    try {
      result.remainingMappings = await deps.countProofTapeMappings(env);
    } catch {
      result.remainingMappings = null;
    }
    return result;
  }

  const uniqueCandidates = new Map<string, StaleReplayCandidate>();
  for (const row of tapeCandidates) {
    const key = `${row.proofJobId}:${row.txHash}`;
    if (!uniqueCandidates.has(key)) {
      uniqueCandidates.set(key, { proofJobId: row.proofJobId, txHash: row.txHash });
    }
  }
  for (const row of claimIndexCandidates) {
    const key = `${row.proofJobId}:${row.txHash}`;
    if (!uniqueCandidates.has(key)) {
      uniqueCandidates.set(key, { proofJobId: row.proofJobId, txHash: row.txHash });
    }
  }
  const candidates = Array.from(uniqueCandidates.values());
  result.scanned = candidates.length;

  const staleChecks = await Promise.all(
    candidates.map(async (mapping) => {
      try {
        const tapeExists = Boolean(await env.PROOF_ARTIFACTS.head(tapeKey(mapping.proofJobId)));
        return tapeExists ? null : mapping;
      } catch {
        return null;
      }
    }),
  );

  const staleMappings = staleChecks.filter(
    (mapping): mapping is StaleReplayCandidate => mapping !== null,
  );
  result.stale = staleMappings.length;

  /* eslint-disable no-await-in-loop */
  for (const mapping of staleMappings) {
    try {
      const deletedTapeMapping = await deps.deleteProofTapeMapping(env, mapping.txHash);
      const deletedClaimIndex = await deps.deleteProofClaimIndexEntry(
        env,
        mapping.proofJobId,
        mapping.txHash,
      );
      if (deletedTapeMapping || deletedClaimIndex) {
        result.deleted += 1;
      }
    } catch (error) {
      console.warn(
        `[leaderboard-sync] stale-prune: failed deleting stale replay state for tx ${mapping.txHash}: ${safeErrorMessage(error)}`,
      );
      result.errors += 1;
    }
  }
  /* eslint-enable no-await-in-loop */

  try {
    result.remainingMappings = await deps.countProofTapeMappings(env);
  } catch {
    result.remainingMappings = null;
  }

  if (result.deleted > 0) {
    console.log(
      `[leaderboard-sync] stale-prune: deleted ${result.deleted} stale replay mappings (scanned=${result.scanned}, stale=${result.stale}, errors=${result.errors})`,
    );
  }

  return result;
}

export interface BackfillTapeMappingsResult {
  unmapped: number;
  matched: number;
  written: number;
  errors: number;
}

export interface BackfillProofTapeMappingsOptions {
  claimantAddress?: string | null;
  unmappedBatchSize?: number;
  maxUnmappedBatches?: number;
  jobsPageSize?: number;
  maxJobsPerClaimant?: number;
  oldestFirst?: boolean;
}

interface BackfillProofTapeMappingsDeps {
  getUnmappedLeaderboardTxHashes: typeof getUnmappedLeaderboardTxHashes;
  writeProofTapeMapping: typeof writeProofTapeMapping;
  listJobsForClaimant: (
    env: WorkerEnv,
    claimantAddress: string,
    limit: number,
    offset: number,
  ) => Promise<{ jobs: ProofJobRecord[]; total: number }>;
}

const BACKFILL_UNMAPPED_BATCH_SIZE = 50;
const BACKFILL_UNMAPPED_MAX_BATCHES = 3;
const BACKFILL_JOBS_PAGE_SIZE = 200;
const BACKFILL_MAX_JOBS_PER_CLAIMANT = 1_000;
const DEFAULT_BACKFILL_DEPS: BackfillProofTapeMappingsDeps = {
  getUnmappedLeaderboardTxHashes,
  writeProofTapeMapping,
  async listJobsForClaimant(env, claimantAddress, limit, offset) {
    return coordinatorStub(env).listJobsForClaimant(claimantAddress, limit, offset);
  },
};

type BackfillProofJobMatcher = (
  jobs: ProofJobRecord[],
  event: UnmappedLeaderboardEvent,
) => ProofJobRecord | null;

async function applyBackfillClaimIndexMatches(
  env: WorkerEnv,
  deps: BackfillProofTapeMappingsDeps,
  events: UnmappedLeaderboardEvent[],
  result: BackfillTapeMappingsResult,
): Promise<UnmappedLeaderboardEvent[]> {
  const indexedEntries = await getProofClaimIndexEntriesByTxHashes(
    env,
    events.map((event) => event.txHash),
  );
  if (indexedEntries.length === 0) {
    return events;
  }

  const entriesByTxHash = new Map(
    indexedEntries.map((entry) => [normalizeReplayTxHash(entry.txHash) ?? entry.txHash, entry]),
  );
  const replayTapeByJobId = new Map<string, boolean>();
  const unresolved: UnmappedLeaderboardEvent[] = [];

  /* eslint-disable no-await-in-loop */
  for (const event of events) {
    const normalizedTxHash = normalizeReplayTxHash(event.txHash);
    const entry = normalizedTxHash ? entriesByTxHash.get(normalizedTxHash) : null;
    if (
      !entry ||
      entry.claimantAddress !== event.claimantAddress ||
      entry.seed !== event.seed >>> 0 ||
      entry.finalScore !== event.finalScore >>> 0
    ) {
      unresolved.push(event);
      continue;
    }

    let hasReplayTape = replayTapeByJobId.get(entry.proofJobId);
    if (hasReplayTape == null) {
      hasReplayTape = await proofJobHasReplayTape(env, { jobId: entry.proofJobId });
      replayTapeByJobId.set(entry.proofJobId, hasReplayTape);
    }
    if (!hasReplayTape) {
      unresolved.push(event);
      continue;
    }

    result.matched += 1;
    try {
      await deps.writeProofTapeMapping(env, event.txHash, entry.proofJobId);
      result.written += 1;
    } catch (error) {
      console.warn(
        `[leaderboard-sync] backfill: failed writing claim-index match for tx ${event.txHash}: ${safeErrorMessage(error)}`,
      );
      result.errors += 1;
    }
  }
  /* eslint-enable no-await-in-loop */

  return unresolved;
}

async function applyBackfillMatches(
  env: WorkerEnv,
  deps: BackfillProofTapeMappingsDeps,
  jobs: ProofJobRecord[],
  events: UnmappedLeaderboardEvent[],
  result: BackfillTapeMappingsResult,
  matchJob: BackfillProofJobMatcher,
): Promise<UnmappedLeaderboardEvent[]> {
  const unresolved: UnmappedLeaderboardEvent[] = [];
  const replayTapeByJobId = new Map<string, boolean>();
  /* eslint-disable no-await-in-loop */
  for (const event of events) {
    const match = matchJob(jobs, event);
    if (!match) {
      unresolved.push(event);
      continue;
    }
    let hasReplayTape = replayTapeByJobId.get(match.jobId);
    if (hasReplayTape == null) {
      hasReplayTape = await proofJobHasReplayTape(env, match);
      replayTapeByJobId.set(match.jobId, hasReplayTape);
    }
    if (!hasReplayTape) {
      unresolved.push(event);
      continue;
    }

    result.matched += 1;
    try {
      await deps.writeProofTapeMapping(env, event.txHash, match.jobId);
      result.written += 1;
    } catch (error) {
      console.warn(
        `[leaderboard-sync] backfill: failed to write mapping for tx ${event.txHash}: ${safeErrorMessage(error)}`,
      );
      result.errors += 1;
    }
  }
  /* eslint-enable no-await-in-loop */
  return unresolved;
}

export async function backfillProofTapeMappings(
  env: WorkerEnv,
  deps: BackfillProofTapeMappingsDeps = DEFAULT_BACKFILL_DEPS,
  options: BackfillProofTapeMappingsOptions = {},
): Promise<BackfillTapeMappingsResult> {
  const result: BackfillTapeMappingsResult = { unmapped: 0, matched: 0, written: 0, errors: 0 };
  const unmappedBatchSize = Math.min(
    Math.max(Math.trunc(options.unmappedBatchSize ?? BACKFILL_UNMAPPED_BATCH_SIZE), 1),
    500,
  );
  const maxUnmappedBatches = Math.min(
    Math.max(Math.trunc(options.maxUnmappedBatches ?? BACKFILL_UNMAPPED_MAX_BATCHES), 1),
    10_000,
  );
  const jobsPageSize = Math.min(
    Math.max(Math.trunc(options.jobsPageSize ?? BACKFILL_JOBS_PAGE_SIZE), 1),
    1_000,
  );
  const maxJobsPerClaimant = Math.min(
    Math.max(Math.trunc(options.maxJobsPerClaimant ?? BACKFILL_MAX_JOBS_PER_CLAIMANT), 1),
    100_000,
  );
  const filterClaimantAddress =
    typeof options.claimantAddress === "string" && options.claimantAddress.trim().length > 0
      ? options.claimantAddress.trim()
      : null;

  const unmapped: UnmappedLeaderboardEvent[] = [];
  /* eslint-disable no-await-in-loop */
  for (let batch = 0; batch < maxUnmappedBatches; batch += 1) {
    const offset = batch * unmappedBatchSize;
    const page = await deps.getUnmappedLeaderboardTxHashes(env, {
      limit: unmappedBatchSize,
      offset,
      claimantAddress: filterClaimantAddress,
      oldestFirst: options.oldestFirst === true,
    });
    if (page.length === 0) {
      break;
    }
    unmapped.push(...page);
    if (page.length < unmappedBatchSize) {
      break;
    }
  }

  result.unmapped = unmapped.length;

  if (unmapped.length === 0) {
    return result;
  }

  let pendingUnmapped = unmapped;
  try {
    pendingUnmapped = await applyBackfillClaimIndexMatches(env, deps, unmapped, result);
  } catch (error) {
    console.warn(
      `[leaderboard-sync] backfill: failed loading proof claim index: ${safeErrorMessage(error)}`,
    );
  }
  if (pendingUnmapped.length === 0) {
    return result;
  }

  // Group by claimant to minimise DO calls
  const byClaimant = new Map<string, UnmappedLeaderboardEvent[]>();
  for (const event of pendingUnmapped) {
    const group = byClaimant.get(event.claimantAddress);
    if (group) {
      group.push(event);
    } else {
      byClaimant.set(event.claimantAddress, [event]);
    }
  }

  for (const [claimantAddress, events] of byClaimant) {
    let pending = [...events];
    let jobs: ProofJobRecord[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    let fullyScannedClaimantJobs = false;

    while (pending.length > 0 && !fullyScannedClaimantJobs && jobs.length < maxJobsPerClaimant) {
      let response: { jobs: ProofJobRecord[]; total: number };
      try {
        response = await deps.listJobsForClaimant(env, claimantAddress, jobsPageSize, offset);
      } catch (error) {
        console.warn(
          `[leaderboard-sync] backfill: failed to list jobs for ${claimantAddress}: ${safeErrorMessage(error)}`,
        );
        result.errors += pending.length;
        pending = [];
        break;
      }

      if (response.jobs.length === 0) {
        fullyScannedClaimantJobs = true;
        break;
      }

      jobs = jobs.concat(response.jobs);
      total = response.total;
      offset += response.jobs.length;

      pending = await applyBackfillMatches(
        env,
        deps,
        jobs,
        pending,
        result,
        (candidateJobs, event) =>
          findExactMatchingProofJob(candidateJobs, {
            claimTxHash: event.txHash,
            seed: event.seed,
            finalScore: event.finalScore,
          }),
      );

      if (offset >= total || response.jobs.length < jobsPageSize) {
        fullyScannedClaimantJobs = true;
      }
    }

    if (pending.length > 0 && fullyScannedClaimantJobs && jobs.length > 0) {
      pending = await applyBackfillMatches(
        env,
        deps,
        jobs,
        pending,
        result,
        (candidateJobs, event) =>
          findBestMatchingProofJob(
            candidateJobs,
            {
              claimTxHash: event.txHash,
              seed: event.seed,
              finalScore: event.finalScore,
            },
            true,
          ),
      );
    }

    if (pending.length > 0 && jobs.length >= maxJobsPerClaimant) {
      console.warn(
        `[leaderboard-sync] backfill: scanned ${maxJobsPerClaimant} jobs for ${claimantAddress} and left ${pending.length} events unresolved`,
      );
    }
  }
  /* eslint-enable no-await-in-loop */

  if (result.written > 0) {
    console.log(
      `[leaderboard-sync] backfill: wrote ${result.written} tape mappings (${result.unmapped} unmapped, ${result.matched} matched, ${result.errors} errors)`,
    );
  }

  return result;
}
