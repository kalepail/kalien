# Asteroids Docs

Canonical documentation for the Asteroids game, deterministic verification, and
ZK/Stellar integration.

## Canonical Sequence
| File | Purpose |
|---|---|
| `00-OVERVIEW.md` | One-page system map and decisions |
| `01-GAME-SPEC.md` | Gameplay rules and progression |
| `02-VERIFICATION-SPEC.md` | Deterministic verification and tape contract |
| `03-ZK-AND-STELLAR-ARCHITECTURE.md` | Proving flow and on-chain settlement model |
| `04-INTEGER-MATH-SPEC.md` | Fixed-point and deterministic arithmetic |
| `05-PROVING-SYSTEM-DECISION.md` | RISC Zero vs Noir decision and criteria |
| `06-IMPLEMENTATION-STATUS.md` | Current implementation state and gaps |
| `07-TESTING-AND-OPERATIONS.md` | Test strategy and operational defaults |
| `08-SOURCES.md` | Curated source list used to derive this spec |
| `09-SCORE-TOKEN-CONTRACT.md` | Soroban score-submission and KALIEN token minting contract spec |
| `10-PROOF-GATEWAY-SPEC.md` | Cloudflare Worker + prover gateway behavior and API contract |
| `12-GUEST-OPTIMIZATION.md` | RISC0 guest and proving optimization notes |
| `15-DOCS-PARITY-CHECKLIST.md` | Latest docs parity checklist (dated; refresh when implementation changes) |

## Legacy Context (Archived)

The following docs are preserved for historical context and are not canonical:

- [11-CLIENT-INTEGRATION-SPEC.md](../../archive/games/asteroids/11-CLIENT-INTEGRATION-SPEC.md)
- [13-ORIGINAL-RULESET-VARIANCE-AUDIT.md](../../archive/games/asteroids/13-ORIGINAL-RULESET-VARIANCE-AUDIT.md)
- [14-VARIANCE-RESOLUTION-PLAN.md](../../archive/games/asteroids/14-VARIANCE-RESOLUTION-PLAN.md)

## Scope

- Files listed in Canonical Sequence are source-of-truth specs.
- If a decision changes, update the corresponding canonical file directly.

## Live Control Summary (AST4)

- Keyboard gameplay input: `ArrowLeft`, `ArrowRight`, `ArrowUp`, `Space`.
- Xbox-style controller gameplay input (Gamepad API): left stick X or d-pad (`left/right`), `LT/LB` (`thrust`), `A/RT` (`fire`).
- Global controller actions: `Start/Menu` (start game, pause/resume), `Back/View` (return to menu).
- Replay controller shortcuts: `X=1x`, `Y=2x`, `B=4x`, `A/Start=pause`.
- Optional controller rumble feedback on ship fire, ship destruction, and extra life.
- Determinism rule: all live device input is normalized into the same per-frame action bits (`left`, `right`, `thrust`, `fire`).

See [docs/README.md](../../README.md) for global docs policy.
