# Asteroids Docs Parity Checklist (AST4)

Date: 2026-03-02

## Purpose
Code-backed checklist confirming that Asteroids docs match the current TS/Rust/Worker/Contract implementation.

This is a point-in-time snapshot. Keep canonical docs updated directly; refresh this checklist after major architecture changes.

## Verified Against Code
- Tape format and constants:
  - `src/game/tape.ts`
  - `kalien-verifier/asteroids-core/src/tape.rs`
  - `kalien-verifier/asteroids-core/src/constants.rs`
- Gameplay rules/math:
  - `src/game/AsteroidsGame.ts`
  - `src/game/input.ts`
  - `src/game/input-source.ts`
  - `src/game/gamepad.ts`
  - `src/game/constants.ts`
  - `kalien-verifier/asteroids-core/src/sim/mod.rs`
  - `kalien-verifier/asteroids-core/src/sim/game.rs`
- Proof gateway + prover contract:
  - `worker/api/routes.ts`
  - `worker/prover/client.ts`
  - `kalien-verifier/api-server/src/config.rs`
  - `kalien-verifier/api-server/src/types.rs`
- On-chain score settlement:
  - `kalien-contract/contracts/asteroids_score/src/lib.rs`

## Parity Checks
1. Tape contract
- `magic = 0x5A4B5450`, `version = 4`, `rules_tag = 4 (AST4)`.
- Header reserved bytes `[6..7]` must be zero.
- Body is nibble-packed: `ceil(frameCount / 2)` bytes. CRC-32 covers header + body.

2. Deterministic gameplay constants
- `SHIP_RESPAWN_FRAMES = 75`, `SHIP_SPAWN_INVULNERABLE_FRAMES = 120`.
- `SHIP_BULLET_LIMIT = 4`, `SAUCER_BULLET_LIMIT = 2`.
- `SHIP_BULLET_LIFETIME_FRAMES = 72`, `SAUCER_BULLET_LIFETIME_FRAMES = 72`.
- `SCORE_SMALL_SAUCER = 990`.

3. Difficulty/ramp behavior
- Wave asteroids: `4,6,8,10`, then ramps to cap `16`.
- Max concurrent saucers by wave tier: `1` (`<4`), `2` (`4..6`), `3` (`>=7`).
- Saucer fire cadence is pressure-based cooldown ranges (deterministic math + RNG), not fixed reload.

4. Fire gate semantics
- Ship fire is edge-triggered latch + cooldown (`shipFireLatch`/`ship_fire_latch`), not shift-register.

5. Verifier journal/output
- Success journal is 49 bytes / 5 fields:
  - `seed_id`, `seed`, `frame_count`, `final_score`, `claimant`.
- Claimant is encoded as fixed bytes (`kind + 32-byte id`) and decoded as `G...`/`C...`.
- Rules digest is `0x4153_5434` (`AST4`).

6. Gateway/prover/claim path
- Worker requires `seed_id` + `claimant` query params on `POST /api/proofs/jobs`.
- Worker submits prover jobs with `receipt_kind=groth16`, `verify_mode=policy`, `segment_limit_po2`, `seed_id`, `claimant`.
- Prover `proof_mode` is forced from `RISC0_DEV_MODE` (not request-driven).
- Score contract call is `submit_score(seal, journal_raw)`.

7. Live input normalization
- Live gameplay input still enters simulation only as `left/right/thrust/fire` booleans.
- Keyboard and gamepad input are merged before simulation, and tape encoding semantics are unchanged.
- Controller-only global actions (`Start`, `Back/View`) affect menu/pause flow only and are not serialized into tape bits.

## Docs Updated In This Pass
- `docs/games/asteroids/README.md`
- `docs/games/asteroids/01-GAME-SPEC.md`
- `docs/games/asteroids/02-VERIFICATION-SPEC.md`
- `docs/games/asteroids/04-INTEGER-MATH-SPEC.md`
- `docs/games/asteroids/06-IMPLEMENTATION-STATUS.md`
- `docs/games/asteroids/15-DOCS-PARITY-CHECKLIST.md`
- `docs/archive/games/asteroids/13-ORIGINAL-RULESET-VARIANCE-AUDIT.md`
- `docs/archive/games/asteroids/14-VARIANCE-RESOLUTION-PLAN.md`

## Notes
- `13-ORIGINAL-RULESET-VARIANCE-AUDIT.md` and `14-VARIANCE-RESOLUTION-PLAN.md` are archived historical planning context under `docs/archive/games/asteroids/`.
- When values conflict, treat `01-GAME-SPEC.md` plus implementation code as canonical.
