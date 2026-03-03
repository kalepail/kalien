# Controller Support Plan

Date: 2026-03-02
Branch: `feat/xbox-controller-support`

## Current Input Architecture
- Keyboard events are handled by `InputController` in `src/game/input.ts`.
- Held state (`down`) and edge state (`pressed`) are tracked per key code.
- `LiveInputSource` in `src/game/input-source.ts` turns keyboard (or autopilot) into per-frame booleans: `left`, `right`, `thrust`, `fire`.
- `AsteroidsGame` reads one frame input in `updateSimulation()`, records it to tape, and updates simulation.
- Menu/pause/restart/replay controls are edge-triggered in `AsteroidsGame.handleGlobalInput()` via `consumePress(...)`.
- Frame loop is `requestAnimationFrame -> updateFrame()`, which is suitable for per-frame gamepad polling.

## Files To Touch
- `src/game/input.ts`
- `src/game/input-source.ts`
- `src/game/AsteroidsGame.ts`
- New small adapter: `src/game/gamepad.ts`
- Focused tests under `src/game/*.test.ts`
- Canonical docs under `docs/games/asteroids/`

## Determinism Risks
- Risk: introducing a parallel simulation path for controller input.
  - Mitigation: controller state is normalized into existing action booleans only.
- Risk: edge-triggered menu actions repeatedly firing while a button is held.
  - Mitigation: track controller pressed-vs-held edges and consume once per frame.
- Risk: stick drift causing unintended turn input.
  - Mitigation: deadzone threshold (~0.25).
- Risk: replay mode drift.
  - Mitigation: tape/replay input source remains unchanged; only live input path is extended.

## Implementation Plan
1. Add controller action/edge state support to `InputController` with keyboard behavior unchanged.
2. Add gamepad polling adapter using `navigator.getGamepads()` and Xbox-style mapping.
3. Poll controller once per frame in `AsteroidsGame.updateFrame()`.
4. Route gameplay booleans through unified action state (`keyboard OR controller`) in `LiveInputSource`.
5. Route one-shot global actions through keyboard-or-controller consume methods.
6. Add targeted tests for mapping/deadzone/edge behavior.
7. Update docs and state notes.

## Acceptance Tests
- Left stick and D-pad map to left/right with deadzone respected.
- A/RT maps to fire; thrust mapping is consistent and documented.
- Start/Menu maps to start/resume/pause behavior.
- Back/View maps to return-to-menu behavior.
- Keyboard controls continue to behave exactly as before.
- Per-frame deterministic booleans remain the only simulation input path.
