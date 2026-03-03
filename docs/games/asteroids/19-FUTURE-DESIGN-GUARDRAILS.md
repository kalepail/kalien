# 19 - Future Design Guardrails

## How to Inspect Before Changing Design
1. Read canonical docs first: `01-GAME-SPEC.md`, `15-DOCS-PARITY-CHECKLIST.md`, `16-GAME-CONTENT-INVENTORY.md`.
2. Audit implementation files: `AsteroidsGame.ts`, `constants.ts`, `input.ts`, `tape.ts`.
3. Run `bun run game:inventory -- --strict` before edits.
4. Confirm changed mechanics in tests and evidence references.

## How to Avoid Inventing Nonexistent Systems
- Treat `Absent` and `Unknown` as first-class truths.
- Do not assume bosses/powerups/hyperspace exist because they are common in arcade derivatives.
- If code evidence is missing, mark `Unknown` or `Absent`; do not upgrade status.

## How to Preserve Linear Progression Clarity
- Keep wave progression legible: wave count, asteroid count, saucer pressure, anti-lurk.
- Avoid adding overlapping progression systems without explicit player-facing signaling.
- Preserve clean score-to-survival loop (`destroy -> score -> extra life`).

## Gameplay Ethics
- Fairness: no hidden deterministic penalties.
- Readability: telegraph threats and preserve control responsiveness.
- Avoid cheap difficulty spikes: tune pressure curves with evidence.
- Preserve proofability: all consensus-relevant mechanics must remain replay-deterministic.

## When a Feature Must Update Docs
Update canonical docs when any gameplay-visible mechanic changes:
- controls
- entities/enemies/weapons
- scoring or progression
- session start/end behavior
- replay semantics

## When a Feature Must Update Manifest
Always update `18-GAME-CONTENT-MANIFEST.json` when adding/removing/retuning:
- player actions
- entities
- enemies
- deterministic constants
- omissions/unknowns statuses

## When a Feature Must Update Tests
Add/update tests when changes affect:
- deterministic simulation
- input mapping or edge semantics
- tape format/rules tag/checksum behavior
- score/claim settlement assumptions

## Determinism Danger Zones
- Input encoding (`left/right/thrust/fire` bits).
- Tape format version/rules tag/checksum.
- Update order in simulation loop.
- Seed/seed_id/claimant binding in proof + settlement.
- Constants mirrored between TS and Rust core.

## No Feature Without Inventory Rule
No gameplay feature may be added, removed, or retuned without:
1. Updating manifest (`18-...json`)
2. Updating inventory (`16-...md`)
3. Updating manual (`17-...md`) when player-visible
4. Updating tests when deterministic or balance-relevant
5. Adding changelog entry (`20-...md`)

## Pre-Add Checklists
### New Enemy
- deterministic spawn/AI rules defined
- score value and progression role documented
- cap/collision/update-order implications tested

### New Weapon
- input mapping and fire cadence deterministic
- cap/cooldown/lifetime constants specified
- replay/tape semantics unchanged or explicitly versioned

### New Scoring Rule
- scoring event triggers uniquely defined
- extra-life interaction reviewed
- claim/leaderboard implications documented

### New Powerup
- deterministic spawn/pickup/expiry model required
- explicit non-presence state removed from omissions list
- anti-lurk and pacing interactions tested

### New Boss
- deterministic phase transitions required
- wave/pacing integration documented
- risk of proof-cost growth assessed

### New Lore Layer
- mark as non-consensus cosmetic by default
- keep out of deterministic simulation path
- add evidence refs in inventory/manual

### New UI Mode
- classify mode in manifest and manual
- define transitions and input edges
- verify no hidden side effects on replay/recording
