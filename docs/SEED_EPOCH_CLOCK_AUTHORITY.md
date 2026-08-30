# Seed Epoch Authority Gap

## Status

Implemented in the chain-authoritative seed flow.

Last reviewed: 2026-08-30

## Problem

The CLI previously derived `seed_id` from local wall-clock time in multiple places while the score contract derives active seed windows from ledger time. That could drift near epoch boundaries or under host clock skew.

## Resolution

The CLI now treats the chain as the authority for seed-window selection:

1. `current_seed()` simulation resolves the ledger-time-derived `seed_id`.
2. The client reads only the exact materialized `SeedById(seed_id)` storage entry for the seed value.
3. Workers receive the configured network passphrase and carry `{ seedId, seed }` together.
4. Relayer confirmation re-resolves the chain seed context instead of probing locally derived candidate ids.
5. Submission gating uses the chain-resolved `seed_id`.
6. Local wall-clock calculation remains only as a display/skew diagnostic and never grants submission authority.
7. If chain authority cannot be resolved, workers fail closed rather than continuing with a cached locally inferred epoch.

## Safety Property

A host clock can be wrong without changing which seed window the CLI farms or submits. The contract/ledger-time-derived `seed_id` remains authoritative end-to-end.

## Implementation References

- Chain seed context: `src/chain/seed.ts`
- Worker seed handling: `cli/src/worker/game-worker.ts`
- Relayer materialization confirmation: `cli/src/relayer.ts`
- Run/submission gating: `cli/src/commands/run.ts`
- Contract seed-window enforcement: `kalien-contract/contracts/asteroids_score/src/lib.rs`

## Acceptance Criteria

- No local wall-clock recomputation determines submit `seed_id`.
- Worker and submit path use chain-resolved `seed_id`.
- Relayer confirms materialization against chain-resolved context.
- Clock skew is diagnostic only.
- Failure to resolve chain authority is fail-closed.
