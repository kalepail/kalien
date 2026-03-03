# 17 - Game Manual (AST4)

## Cover Page
- Title: `KALIEN`
- Subtitle: `A Deterministic Asteroids Field Manual`
- Layout note: high-contrast retro header, center ship silhouette, wave/score strip footer.

## Welcome to Kalien
Welcome, pilot. This build is a deterministic Asteroids run machine: your run is played, recorded, and provable.

## Story / Premise
Kalien is a score-integrity arcade stack. You fly a ship through asteroid waves, record frame inputs as a compact tape, and route verified scores to Stellar settlement.

## Controls
### Keyboard Controls
- `ArrowLeft`: Turn Left
- `ArrowRight`: Turn Right
- `ArrowUp`: Thrust
- `Space`: Fire
- `Enter`: start/resume
- `P`: pause toggle
- `R`: restart
- `L`: load replay tape
- `D`: download replay tape (game-over)

### Xbox Controller Mapping
- Left stick X or d-pad: Turn Left / Turn Right
- `LT` or `LB`: Thrust
- `A` or `RT`: Fire
- `Start`: menu start and pause/resume
- `Back/View`: return to menu
- Replay shortcuts: `X=1x`, `Y=2x`, `B=4x`, `A/Start=pause`

## Objective
Survive and score by destroying asteroids and saucers while keeping your run deterministic and claimable.

## Core Gameplay Loop
1. Enter Playing Mode from Menu Mode.
2. Clear wave hazards using Player Ship movement and Ship Bullets.
3. Advance Wave Progression and manage Anti-Lurk Pressure.
4. End in Game Over Mode (lives exhausted or Hard Run Cap reached).
5. Use Replay Mode or Replay Load and Download workflows.

## Enemies and Hazards
### Asteroid Size Chain
- Large asteroids split into medium.
- Medium asteroids split into small.
- Small asteroids are terminal.

### Saucer Variants
- Large saucers are lower precision.
- Small saucers tighten aim under pressure and score higher.
- Saucer Bullets add crossfire pressure.

## Survival Guide
- Keep velocity disciplined: over-thrusting under pressure leads to wrap collisions.
- Use Turn Left and Turn Right continuously; avoid static firing lanes.
- Break lurking behavior early; anti-lurk ramps saucer pressure.

## Scoring and Extra Lives
- Asteroids: `20 / 50 / 100`
- Saucers: `200 / 990`
- Extra Lives every `10,000` points

## Waves and Difficulty Curve
- Wave count ramps large asteroid count to a cap.
- Saucer spawn and fire cadence scale with wave and pressure.
- Hard Run Cap enforces bounded run length (`36,000` frames).

## Replay / Tape / Proof / Fairness
- Each frame stores four deterministic actions.
- Tape is AST4 nibble-packed with checksum.
- Proof jobs bind `seed_id` and claimant.
- Score Claim Flow settles verified runs on-chain.

## How Stellar Integration Fits In
- Worker accepts proof jobs and validates tape format/rules.
- Contract `submit_score` enforces claimant-seed best-score policy.
- Leaderboard Hooks surface succeeded claimed runs.

## Modes / Menus / Replays
- Menu Mode: start/load entrypoint.
- Playing Mode: live simulation.
- Paused Mode: session interrupt.
- Replay Mode: visual playback controls.
- Game Over Mode: terminal state and tape download point.

## Glossary
- `AST4`: current deterministic rules tag.
- `Tape`: serialized run input stream with footer score/checksum.
- `seed_id`: epoch-bound seed window id for settlement.
- `claimant`: Stellar account/contract receiving score outcome.

## What This Build Does Not Include
- Hyperspace
- Bosses
- Powerups and Pickups
- Shield mechanics

## Strategy Tips
- Prioritize lane control over frantic spinning.
- Farm safely: keep saucer pressure manageable before greed plays.
- Use replay speed controls to study positioning mistakes.

## Appendix: Deterministic Rules at a Glance
- Input contract: `left/right/thrust/fire` only.
- Fixed timestep: `60 Hz`.
- Run cap: `MAX_GAME_FRAMES = 36,000`.
- Rules tag: `4 (AST4)`.

## Implementation Index
The following player-visible implemented systems are present in this build:
- Menu Mode
- Playing Mode
- Paused Mode
- Game Over Mode
- Replay Mode
- Turn Left
- Turn Right
- Thrust
- Fire
- Keyboard Controls
- Xbox Controller Mapping
- Player Ship
- Asteroid Size Chain
- Saucer Variants
- Ship Bullets
- Saucer Bullets
- Wave Progression
- Anti-Lurk Pressure
- Extra Lives
- Hard Run Cap
- Replay Load and Download
- Autopilot
- Leaderboard Hooks
- Score Claim Flow
- Gamepad Rumble
