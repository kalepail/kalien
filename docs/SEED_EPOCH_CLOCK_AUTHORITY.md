# Seed Epoch Authority Gap

## Status

Implemented in the chain-authoritative seed flow.

Last reviewed: 2026-08-30

## Problem

The CLI previously let host time help choose `seed_id`. Centralizing chain reads fixes that only if cached authority cannot live forever after RPC disappears.

## Resolution

The CLI now treats fresh chain evidence as the authority for seed-window selection:

1. `current_seed()` simulation resolves the ledger-time-derived `seed_id`.
2. The client reads only the exact materialized `SeedById(seed_id)` storage entry for the seed value.
3. One main-thread poll owns `{ seedId, seed }`; worker-count growth adds no seed RPC traffic.
4. Each successful chain observation renews a short monotonic freshness lease. Host time can expire evidence but cannot select a seed.
5. If that lease expires, workers receive an unavailable seed, new worker bests are ignored, and submits—including shutdown flushes—pause until chain authority returns.
6. Relayer materialization runs only through the main-thread authority path and re-resolves chain state.
7. Local wall-clock seed math remains display/skew diagnostics only.

## Safety Property

A wrong host clock or a prolonged RPC outage cannot silently choose or indefinitely preserve the seed window used for new work. Current farming and submission authority must descend from recent chain evidence.

## Implementation References

- Chain seed context: `src/chain/seed.ts`
- Worker seed handling: `cli/src/worker/game-worker.ts`
- Relayer materialization confirmation: `cli/src/relayer.ts`
- Freshness/submission gating: `cli/src/commands/run.ts`
- Contract seed-window enforcement: `kalien-contract/contracts/asteroids_score/src/lib.rs`

## Acceptance Criteria

- No local wall-clock recomputation determines submit `seed_id`.
- Worker and submit paths share one main-thread chain-resolved `seed_id`.
- Seed refresh RPC traffic stays constant as worker count grows.
- Relayer confirms materialization against chain-resolved context.
- Clock skew is diagnostic only.
- Lost chain authority becomes fail-closed after a bounded lease.
- Recovered chain authority resumes workers from a newly confirmed context.
