# Controller Support Rollup

Date: 2026-03-02
Branch: `feat/xbox-controller-support`

## Summary
Added Xbox-style gamepad support to live Asteroids play by polling the browser Gamepad API each frame and normalizing state into the existing deterministic action model (`left`, `right`, `thrust`, `fire`).
This pass also adds replay-mode controller shortcuts and optional controller rumble feedback.

Keyboard controls remain unchanged and continue to work in parallel (`keyboard OR controller`).

## Files Touched
- `src/game/input.ts`
- `src/game/input-source.ts`
- `src/game/AsteroidsGame.ts`
- `src/game/gamepad.ts` (new)
- `tests/src/gamepad-input.test.ts` (new)
- `docs/games/asteroids/README.md`
- `docs/games/asteroids/01-GAME-SPEC.md`
- `docs/games/asteroids/15-DOCS-PARITY-CHECKLIST.md`
- `docs/CONTROLLER-SUPPORT-PLAN.md`

## Controller Mapping
- Left stick X < `-0.25` or d-pad left -> `left`
- Left stick X > `0.25` or d-pad right -> `right`
- `LT` or `LB` -> `thrust`
- `A` or `RT` -> `fire`
- `Start/Menu` -> start game / pause / resume (mode-dependent global action)
- `Back/View` -> return to menu
- Replay controls: `X=1x`, `Y=2x`, `B=4x`, `A/Start=pause`

## Gamepad API Constraints
- Uses polling (`navigator.getGamepads()`) once per animation frame.
- Uses edge detection for one-shot controller actions (`start`, `menu`) to avoid repeated triggers while held.
- Replay/tape format is unchanged. Controller input is only a live-input source mapped to existing booleans.
- Optional gamepad rumble uses browser Gamepad vibration APIs when available; unsupported implementations are ignored safely.

## Test Evidence
- `bun test tests/src/gamepad-input.test.ts`
  - 8 passing tests:
    - deadzone behavior
    - left/right mapping (stick + d-pad)
    - fire/thrust/start/menu mapping
    - replay shortcut button mapping
    - keyboard press semantics unchanged
    - keyboard+controller held-state merge
    - gamepad press edge semantics
    - replay shortcut edge semantics
- `bun run typecheck` fails at pre-existing `typegen:check` (`worker-configuration.d.ts` out of date)
  - with regenerated worker types, app/node/worker/script typechecks pass
- `bun run lint` passed
- `bun run format:check` currently fails repository-wide due pre-existing formatting drift across many files unrelated to this change.

## Manual Smoke Test
Not executed in this shell session (no browser/controller hardware attached).

## Follow-up Ideas (Deferred)
- In-game rebinding UI for controller mappings.
