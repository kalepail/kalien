# Asteroids Game Spec

## Deterministic Gameplay Contract
Game state transitions must be deterministic given:
- initial seed
- per-frame input bytes
- canonical update order

## Input Model
- 4 action bits per frame: `left`, `right`, `thrust`, `fire`.
- High nibble reserved and must be zero.
- Live controls (keyboard/gamepad) must normalize into these same 4 bits before simulation.
- Xbox-style controller mapping for live play:
  - left stick X or d-pad left/right -> `left` / `right`
  - `LT` or `LB` -> `thrust`
  - `A` or `RT` -> `fire`
  - `Start` -> menu start/resume/pause action (UI/global only, not tape bit)
  - `Back/View` -> return-to-menu action (UI/global only, not tape bit)
  - replay-only shortcuts: `X=1x`, `Y=2x`, `B=4x`, `A/Start=pause`
- Optional controller haptics may be emitted in interactive mode; they are cosmetic and not part of deterministic replay state.

## Core Mechanics
### Ship
- Rotation uses 8-bit BAM.
- Thrust and drag operate in fixed-point integer space.
- Speed is clamped to configured max.
- On death, the ship respawns after a fixed delay (`SHIP_RESPAWN_FRAMES = 75`) with spawn invulnerability.
- On wave start, ship spawn is immediate (`queueShipRespawn(0)`).

### Player bullets
- Bullet cap is enforced.
- Fire gating uses an anti-autofire shift register (edge-triggered hold behavior).
- Bullet lifetime is frame-based.
- Ship bullet lifetime is `72` frames.

### Asteroids
- Wave-based spawning with cap.
- Size transitions: large -> medium -> small -> removed.
- Split behavior respects live-entity caps.

### Saucers
- Spawn cadence and count scale with progression (max concurrent saucers by wave: `1` for waves `<4`, `2` for waves `4..6`, `3` for waves `>=7`).
- Anti-lurk behavior increases pressure when player stalls.
- Small saucers aim with bounded error; large saucers are less accurate.
- Saucers only enter from left/right edges and are culled as soon as they leave X bounds.
- Saucer spawn/fire is paused while the ship is not visible.
- Saucer fire cadence uses deterministic pressure-based cooldown ranges (sampled from game RNG), not a fixed reload constant.
- Saucer bullet hard cap is `2`, with lifetime `72` frames.

### Scoring and progression
- Score increments only from valid destruction events.
- Extra life threshold uses fixed score step.
- Wave progression triggers only when required entities are cleared.

## Difficulty and Session-Length Policy
This build targets roughly 2-5 minute high-skill runs to keep proving costs
reasonable while preserving arcade pressure.

### Difficulty controls
- Asteroid wave count scales up to a cap of 16.
- Saucer concurrency scales by wave (`1`, then `2`, then `3` in late waves).
- Saucer spawn cadence accelerates with wave and anti-lurk pressure.
- Saucer firing cadence tightens with pressure via deterministic cooldown ranges.
- Small-saucer aim tightens with wave progression.
- Asteroid speed increases by wave with an upper cap.
- Anti-lurk threshold is fixed at 6 seconds (`360` frames at 60 FPS).

### Baseline progression constants
- Starting lives: `3`
- Extra life step: `10,000`
- Asteroid score bands: `20 / 50 / 100`
- Saucer score bands: `200 / 990`

## Deliberate Scope Decisions
- Hyperspace is omitted in this version to keep controls, verification surface,
  and deterministic state space tighter.

## Scope Exclusions (Non-Consensus)
- Visual effects
- Audio behavior
- Rendering interpolation and cosmetic randomness
