# 16 - Game Content Inventory (AST4)

## Current Build Snapshot
- Generated from current code/docs baseline on 2026-03-02.
- Ruleset: `AST4` (`rules_tag=4`).
- Core deterministic input contract remains `left/right/thrust/fire` only.
- Status: `Implemented`
- Evidence:
  - `src/game/tape.ts:15` (four-bit nibble mapping)
  - `src/game/constants.ts:68` (`RULES_TAG = 4`)
  - `docs/games/asteroids/01-GAME-SPEC.md:7`

## Core Player Verbs
| ID | Verb | Status | Evidence |
|---|---|---|---|
| `action_left` | Turn Left | Implemented | `src/game/tape.ts:19`, `src/game/AsteroidsGame.ts:970` |
| `action_right` | Turn Right | Implemented | `src/game/tape.ts:20`, `src/game/AsteroidsGame.ts:971` |
| `action_thrust` | Thrust | Implemented | `src/game/tape.ts:21`, `src/game/AsteroidsGame.ts:972` |
| `action_fire` | Fire | Implemented | `src/game/tape.ts:22`, `src/game/AsteroidsGame.ts:1002` |
| `action_keyboard_controls` | Keyboard Controls | Implemented | `src/game/input.ts:1`, `docs/games/asteroids/README.md:38` |
| `action_xbox_controller` | Xbox Controller Mapping | Implemented | `src/game/gamepad.ts:3`, `src/game/input.ts:132`, `docs/games/asteroids/README.md:39` |

## Game Modes
| ID | Mode | Status | Evidence |
|---|---|---|---|
| `mode_menu` | Menu Mode | Implemented | `src/game/types.ts:9`, `src/game/AsteroidsGame.ts:303` |
| `mode_playing` | Playing Mode | Implemented | `src/game/types.ts:9`, `src/game/AsteroidsGame.ts:489` |
| `mode_paused` | Paused Mode | Implemented | `src/game/types.ts:9`, `src/game/AsteroidsGame.ts:515` |
| `mode_game_over` | Game Over Mode | Implemented | `src/game/types.ts:9`, `src/game/AsteroidsGame.ts:700` |
| `mode_replay` | Replay Mode | Implemented | `src/game/types.ts:9`, `src/game/AsteroidsGame.ts:1673` |

## Entities
| ID | Entity | Status | Notes |
|---|---|---|---|
| `entity_ship` | Player Ship | Implemented | Respawn + invulnerability timers |
| `entity_asteroid_sizes` | Asteroid Size Chain | Implemented | Large -> Medium -> Small |
| `weapon_ship_bullets` | Ship Bullets | Implemented | Cap + cooldown + lifetime |
| `weapon_saucer_bullets` | Saucer Bullets | Implemented | Cap + lifetime |

Evidence:
- `src/game/types.ts:11`
- `src/game/AsteroidsGame.ts:876`
- `src/game/AsteroidsGame.ts:1254`
- `src/game/constants.ts:24`

## Enemies
| ID | Enemy Group | Status | Evidence |
|---|---|---|---|
| `entity_asteroid_sizes` | Asteroids (large/medium/small) | Implemented | `src/game/types.ts:11`, `src/game/AsteroidsGame.ts:1479` |
| `enemy_saucers` | Saucers (large/small) | Implemented | `src/game/types.ts:51`, `src/game/AsteroidsGame.ts:1217` |

## Weapons / Attacks
| ID | Weapon | Status | Evidence |
|---|---|---|---|
| `weapon_ship_bullets` | Ship Bullets | Implemented | `src/game/AsteroidsGame.ts:1003`, `src/game/constants.ts:18` |
| `weapon_saucer_bullets` | Saucer Bullets | Implemented | `src/game/AsteroidsGame.ts:1255`, `src/game/constants.ts:21` |

## Scoring Rules
- Status: `Implemented`
- Asteroid score bands: `20 / 50 / 100`
- Saucer score bands: `200 / 990`
- Extra life step: `10,000`
- Evidence:
  - `src/game/constants.ts:37`
  - `src/game/constants.ts:41`
  - `src/game/constants.ts:9`
  - `src/game/AsteroidsGame.ts:1523`

## Progression / Waves / Pressure
- Status: `Implemented`
- `progress_wave_system`: wave spawns scale up to 16 large asteroids.
- `progress_anti_lurk`: `timeSinceLastKill` pressure kicks in after `360` frames.
- Saucer concurrency by wave tier: `1`, then `2`, then `3`.
- Evidence:
  - `src/game/AsteroidsGame.ts:94` (`waveLargeAsteroidCount`)
  - `src/game/AsteroidsGame.ts:102` (`maxSaucersForWave`)
  - `src/game/AsteroidsGame.ts:1133` (`saucerLurkPressurePct`)
  - `src/game/constants.ts:61`

## Session End Conditions
- Status: `Implemented`
- `session_hard_cap`: game-over if frame count exceeds `MAX_GAME_FRAMES`.
- Life exhaustion (`lives <= 0`) also causes game-over.
- Evidence:
  - `src/game/AsteroidsGame.ts:699`
  - `src/game/AsteroidsGame.ts:1510`
  - `src/game/constants.ts:65`

## Determinism-Critical Rules
- Status: `Implemented`
- `deterministic_tape_recording`: AST4 tape format, nibble-packed body, CRC32.
- `system_score_claim_flow`: proof/claim path bound by `(seed_id, claimant)` and `submit_score`.
- `action_*` and progression rules feed deterministic per-frame simulation.
- Evidence:
  - `src/game/tape.ts:1`
  - `worker/api/routes-proofs.ts:301`
  - `kalien-contract/contracts/asteroids_score/src/lib.rs:125`
  - `docs/games/asteroids/15-DOCS-PARITY-CHECKLIST.md:33`

## Non-Consensus Presentation Layer
- `cosmetic_gamepad_rumble`: Implemented
- Scope: browser rumble only; no replay/proof/score effect.
- Evidence:
  - `src/game/gamepad.ts:78`
  - `src/game/AsteroidsGame.ts:1118`
  - `docs/games/asteroids/15-DOCS-PARITY-CHECKLIST.md:69`

## Explicit Omissions / Not Present
| ID | Feature | Status | Evidence |
|---|---|---|---|
| `omission_hyperspace` | Hyperspace | Absent | `docs/games/asteroids/01-GAME-SPEC.md:74` |
| `omission_bosses` | Bosses | Absent | no gameplay symbols in `src/game` audit |
| `omission_powerups` | Powerups and Pickups | Absent | no gameplay symbols in `src/game` audit |
| `omission_shields` | Shield mechanics | Absent | no shield action/state; only spawn invulnerability timer |

## Known Ambiguities
| ID | Topic | Status | Follow-up |
|---|---|---|---|
| `unknown_hidden_menus` | Hidden menus | Unknown | Keep scanning non-gameplay UI routes for hidden dev toggles |
| `unknown_secret_lore` | Secret lore/easter eggs | Unknown | If added, register in manifest + manual as non-consensus flavor |

## Evidence Index
- `src/game/tape.ts`
- `src/game/constants.ts`
- `src/game/input.ts`
- `src/game/gamepad.ts`
- `src/game/input-source.ts`
- `src/game/AsteroidsGame.ts`
- `src/game/types.ts`
- `worker/api/routes-proofs.ts`
- `worker/queue/consumer.ts`
- `kalien-contract/contracts/asteroids_score/src/lib.rs`
- `docs/games/asteroids/01-GAME-SPEC.md`
- `docs/games/asteroids/15-DOCS-PARITY-CHECKLIST.md`
- `docs/archive/games/asteroids/13-ORIGINAL-RULESET-VARIANCE-AUDIT.md`

## Inventory IDs (Machine Cross-Check)
`mode_menu`, `mode_playing`, `mode_paused`, `mode_game_over`, `mode_replay`, `action_left`, `action_right`, `action_thrust`, `action_fire`, `action_keyboard_controls`, `action_xbox_controller`, `entity_ship`, `entity_asteroid_sizes`, `enemy_saucers`, `weapon_ship_bullets`, `weapon_saucer_bullets`, `progress_wave_system`, `progress_anti_lurk`, `progress_extra_lives`, `session_hard_cap`, `system_replay_load_download`, `system_autopilot`, `system_leaderboard_hooks`, `system_score_claim_flow`, `cosmetic_gamepad_rumble`, `omission_hyperspace`, `omission_bosses`, `omission_powerups`, `omission_shields`, `unknown_hidden_menus`, `unknown_secret_lore`, `planned_classic_hyperspace_profile`
