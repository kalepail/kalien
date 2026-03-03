import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type FeatureStatus = "Implemented" | "Documented" | "Planned" | "Absent" | "Unknown";

type Feature = {
  id: string;
  name: string;
  category: string;
  status: FeatureStatus;
  player_visible: boolean;
  determinism_critical: boolean;
  current_behavior_summary: string;
  balancing_notes: string;
  progression_role: string;
  related_constants: string[];
  related_tests: string[];
  evidence_refs: string[];
  change_risk: string;
  future_design_constraints: string;
};

type Query = { file: string; regex: RegExp; note: string };

type Spec = Omit<Feature, "status" | "evidence_refs"> & {
  code?: Query[];
  docs?: Query[];
  archive?: Query[];
  defaultStatus?: FeatureStatus;
  forceStatus?: FeatureStatus;
};

type Manifest = {
  generated_at: string;
  repo_commit: string;
  rules_tag: number;
  game_identity: { name: string; genre: string; core_claim: string };
  modes: Feature[];
  player_actions: Feature[];
  entities: Feature[];
  enemies: Feature[];
  weapons: Feature[];
  progression: {
    summary: string;
    wave_model: string;
    anti_lurk: string;
    saucer_pressure: string;
    evidence_refs: string[];
  };
  scoring: {
    summary: string;
    score_bands: Record<string, number>;
    extra_life_step: number;
    evidence_refs: string[];
  };
  session_constraints: {
    max_game_frames: number;
    fixed_timestep_hz: number;
    requires_seed_and_seed_id_for_claim: boolean;
    deterministic_constants: Record<string, number>;
    evidence_refs: string[];
  };
  determinism_critical: Feature[];
  non_consensus_cosmetics: Feature[];
  explicit_omissions: Feature[];
  unknowns: Feature[];
  archived_or_planned: Feature[];
  evidence: Array<{ id: string; file: string; line: number; note: string }>;
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = "docs/games/asteroids/18-GAME-CONTENT-MANIFEST.json";
const INVENTORY_DOC_PATH = "docs/games/asteroids/16-GAME-CONTENT-INVENTORY.md";
const MANUAL_DOC_PATH = "docs/games/asteroids/17-GAME-MANUAL.md";
const CHANGELOG_DOC_PATH = "docs/games/asteroids/20-GAME-CONTENT-CHANGELOG.md";

const SCAN_PATHS = [
  "src/game/AsteroidsGame.ts",
  "src/game/constants.ts",
  "src/game/types.ts",
  "src/game/input.ts",
  "src/game/gamepad.ts",
  "src/game/tape.ts",
  "src/game/input-source.ts",
  "src/game/Autopilot.ts",
  "worker/api/routes-proofs.ts",
  "worker/queue/consumer.ts",
  "kalien-contract/contracts/asteroids_score/src/lib.rs",
  "tests/src/gamepad-input.test.ts",
  "docs/games/asteroids/01-GAME-SPEC.md",
  "docs/archive/games/asteroids/13-ORIGINAL-RULESET-VARIANCE-AUDIT.md",
];

const args = new Set(process.argv.slice(2));
const strict = args.has("--strict");
const write = args.has("--write");

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function maybe(path: string): string {
  const full = resolve(ROOT, path);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

function firstRef(path: string, regex: RegExp): string | null {
  const text = maybe(path);
  if (!text) return null;
  const match = regex.exec(text);
  if (!match || match.index === undefined) return null;
  const line = text.slice(0, match.index).split(/\r?\n/).length;
  return `${path}:${line}`;
}

function hit(query: Query): string | null {
  const ref = firstRef(query.file, query.regex);
  return ref ? `${ref} (${query.note})` : null;
}

function hits(queries?: Query[]): string[] {
  if (!queries) return [];
  return queries.map((q) => hit(q)).filter((v): v is string => Boolean(v));
}

function build(spec: Spec): Feature {
  const code = hits(spec.code);
  const docs = hits(spec.docs);
  const archive = hits(spec.archive);
  let status: FeatureStatus = spec.defaultStatus ?? "Absent";
  if (spec.forceStatus) status = spec.forceStatus;
  else if (code.length > 0) status = "Implemented";
  else if (docs.length > 0) status = "Documented";
  else if (archive.length > 0) status = "Planned";
  return {
    id: spec.id,
    name: spec.name,
    category: spec.category,
    status,
    player_visible: spec.player_visible,
    determinism_critical: spec.determinism_critical,
    current_behavior_summary: spec.current_behavior_summary,
    balancing_notes: spec.balancing_notes,
    progression_role: spec.progression_role,
    related_constants: spec.related_constants,
    related_tests: spec.related_tests,
    evidence_refs: Array.from(new Set([...code, ...docs, ...archive])),
    change_risk: spec.change_risk,
    future_design_constraints: spec.future_design_constraints,
  };
}

function parseConstants(source: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /export const\s+([A-Z0-9_]+)\s*=\s*([0-9_]+)/g;
  let match = re.exec(source);
  while (match) {
    out[match[1]] = Number.parseInt(match[2]?.replaceAll("_", "") ?? "0", 10);
    match = re.exec(source);
  }
  return out;
}

function commitShort(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .replace(/\r?\n/g, "");
  } catch {
    return "unknown";
  }
}

function allFeatures(m: Manifest): Feature[] {
  return [
    ...m.modes,
    ...m.player_actions,
    ...m.entities,
    ...m.enemies,
    ...m.weapons,
    ...m.determinism_critical,
    ...m.non_consensus_cosmetics,
    ...m.explicit_omissions,
    ...m.unknowns,
    ...m.archived_or_planned,
  ];
}

function byId(features: Feature[]): Map<string, Feature> {
  const map = new Map<string, Feature>();
  for (const f of features) map.set(f.id, f);
  return map;
}

function normalizedForCompare(m: Manifest): Omit<Manifest, "generated_at"> {
  const { generated_at: _generatedAt, ...rest } = m;
  return rest;
}

function uniqueIds(features: Feature[]): string[] {
  return Array.from(new Set(features.map((f) => f.id)));
}

const constants = parseConstants(read("src/game/constants.ts"));
const typesText = read("src/game/types.ts");
const rulesTag = constants.RULES_TAG ?? 4;
const repoCommit = commitShort();
const specs: Spec[] = [
  {
    id: "mode_menu",
    name: "Menu Mode",
    category: "I. UI / Modes / Replay",
    player_visible: true,
    determinism_critical: false,
    current_behavior_summary: "Main menu state for start/load flow and seed waiting.",
    balancing_notes: "UI-only state.",
    progression_role: "Run/replay entry point.",
    related_constants: [],
    related_tests: [],
    change_risk: "Medium",
    future_design_constraints: "Keep start transitions deterministic once gameplay begins.",
    code: [{ file: "src/game/types.ts", regex: /\"menu\"/, note: "mode enum includes menu" }],
  },
  {
    id: "mode_playing",
    name: "Playing Mode",
    category: "I. UI / Modes / Replay",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Active simulation and recording mode.",
    balancing_notes: "Main gameplay tuning state.",
    progression_role: "Primary run mode.",
    related_constants: ["FIXED_TIMESTEP", "MAX_GAME_FRAMES"],
    related_tests: [],
    change_risk: "High",
    future_design_constraints: "Preserve frame-step order and tape recording.",
    code: [
      { file: "src/game/types.ts", regex: /\"playing\"/, note: "mode enum includes playing" },
      { file: "src/game/AsteroidsGame.ts", regex: /this\.mode = \"playing\"/, note: "runtime transitions" },
    ],
  },
  {
    id: "mode_paused",
    name: "Paused Mode",
    category: "I. UI / Modes / Replay",
    player_visible: true,
    determinism_critical: false,
    current_behavior_summary: "Pause state for runtime and visibility changes.",
    balancing_notes: "No tape semantic impact.",
    progression_role: "Session control.",
    related_constants: [],
    related_tests: [],
    change_risk: "Low",
    future_design_constraints: "Keep edge-triggered pause behavior.",
    code: [{ file: "src/game/AsteroidsGame.ts", regex: /mode === \"paused\"/, note: "paused branch handling" }],
  },
  {
    id: "mode_game_over",
    name: "Game Over Mode",
    category: "I. UI / Modes / Replay",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Terminal state after life exhaustion or run cap.",
    balancing_notes: "Defines final score boundary.",
    progression_role: "Run termination.",
    related_constants: ["MAX_GAME_FRAMES", "STARTING_LIVES"],
    related_tests: [],
    change_risk: "High",
    future_design_constraints: "Keep terminal conditions aligned with replay/proof flow.",
    code: [{ file: "src/game/AsteroidsGame.ts", regex: /this\.mode = \"game-over\"/, note: "terminal transition" }],
  },
  {
    id: "mode_replay",
    name: "Replay Mode",
    category: "I. UI / Modes / Replay",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Visual replay from tape bytes with speed/pause controls.",
    balancing_notes: "Replay controls are non-scoring.",
    progression_role: "Post-run inspection mode.",
    related_constants: ["RULES_TAG"],
    related_tests: [],
    change_risk: "High",
    future_design_constraints: "Keep replay visual-only for claim path.",
    code: [{ file: "src/game/AsteroidsGame.ts", regex: /this\.mode = \"replay\"/, note: "loadReplay sets replay mode" }],
  },
  {
    id: "action_left",
    name: "Turn Left",
    category: "A. Core Mechanics",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Left input bit rotates ship left.",
    balancing_notes: "Core handling control.",
    progression_role: "Primary movement verb.",
    related_constants: ["SHIP_TURN_SPEED_BAM"],
    related_tests: ["tests/src/gamepad-input.test.ts"],
    change_risk: "High",
    future_design_constraints: "Must stay encoded in the four-bit input model.",
    code: [
      { file: "src/game/tape.ts", regex: /bit 0 \(0x1\): left/, note: "tape bit mapping" },
      { file: "src/game/AsteroidsGame.ts", regex: /frameInput\.left/, note: "simulation read" },
    ],
  },
  {
    id: "action_right",
    name: "Turn Right",
    category: "A. Core Mechanics",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Right input bit rotates ship right.",
    balancing_notes: "Core handling control.",
    progression_role: "Primary movement verb.",
    related_constants: ["SHIP_TURN_SPEED_BAM"],
    related_tests: ["tests/src/gamepad-input.test.ts"],
    change_risk: "High",
    future_design_constraints: "Must stay encoded in the four-bit input model.",
    code: [
      { file: "src/game/tape.ts", regex: /bit 1 \(0x2\): right/, note: "tape bit mapping" },
      { file: "src/game/AsteroidsGame.ts", regex: /frameInput\.right/, note: "simulation read" },
    ],
  },
  {
    id: "action_thrust",
    name: "Thrust",
    category: "A. Core Mechanics",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Thrust input bit accelerates ship velocity.",
    balancing_notes: "Bounded by drag and max speed.",
    progression_role: "Primary movement verb.",
    related_constants: ["SHIP_THRUST_Q8_8", "SHIP_MAX_SPEED_Q8_8"],
    related_tests: ["tests/src/gamepad-input.test.ts"],
    change_risk: "High",
    future_design_constraints: "Must stay encoded in the four-bit input model.",
    code: [
      { file: "src/game/tape.ts", regex: /bit 2 \(0x4\): thrust/, note: "tape bit mapping" },
      { file: "src/game/AsteroidsGame.ts", regex: /frameInput\.thrust/, note: "simulation read" },
    ],
  },
  {
    id: "action_fire",
    name: "Fire",
    category: "A. Core Mechanics",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Fire input bit edge-triggers shot creation with cooldown/cap checks.",
    balancing_notes: "Fire latch + cooldown curb autofire.",
    progression_role: "Primary offensive verb.",
    related_constants: ["SHIP_BULLET_LIMIT", "SHIP_BULLET_COOLDOWN_FRAMES"],
    related_tests: ["tests/src/gamepad-input.test.ts"],
    change_risk: "High",
    future_design_constraints: "Preserve latch and cooldown semantics.",
    code: [
      { file: "src/game/tape.ts", regex: /bit 3 \(0x8\): fire/, note: "tape bit mapping" },
      { file: "src/game/AsteroidsGame.ts", regex: /shipFireLatch/, note: "fire edge logic" },
    ],
  },
  {
    id: "action_keyboard_controls",
    name: "Keyboard Controls",
    category: "A. Core Mechanics",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "ArrowLeft/ArrowRight/ArrowUp/Space map to core gameplay actions.",
    balancing_notes: "Reference control path.",
    progression_role: "Default live input path.",
    related_constants: [],
    related_tests: ["tests/src/gamepad-input.test.ts"],
    change_risk: "Medium",
    future_design_constraints: "Keep key mapping in sync with docs and UI.",
    code: [{ file: "src/game/input.ts", regex: /"ArrowLeft"[\s\S]*"Space"/, note: "keyboard mapping list" }],
  },
  {
    id: "action_xbox_controller",
    name: "Xbox Controller Mapping",
    category: "A. Core Mechanics",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Gamepad polling maps stick/dpad/buttons into existing action booleans.",
    balancing_notes: "0.25 deadzone avoids twitch turns.",
    progression_role: "Alternative live input device.",
    related_constants: [],
    related_tests: ["tests/src/gamepad-input.test.ts"],
    change_risk: "Medium",
    future_design_constraints: "Controller-only global actions must not alter tape bits.",
    code: [
      { file: "src/game/gamepad.ts", regex: /DEFAULT_STICK_DEADZONE = 0\.25/, note: "deadzone" },
      { file: "src/game/input.ts", regex: /syncGamepadState/, note: "merged state" },
    ],
    docs: [{ file: "docs/games/asteroids/README.md", regex: /Xbox-style controller gameplay input/, note: "canonical docs" }],
  },
];
specs.push(
  {
    id: "entity_ship",
    name: "Player Ship",
    category: "B. Entities",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Single controllable ship with deterministic respawn + invulnerability timers.",
    balancing_notes: "Lives and respawn safety shape survival.",
    progression_role: "Player avatar.",
    related_constants: ["SHIP_RESPAWN_FRAMES", "SHIP_SPAWN_INVULNERABLE_FRAMES", "STARTING_LIVES"],
    related_tests: [],
    change_risk: "High",
    future_design_constraints: "Preserve deterministic spawn logic.",
    code: [
      { file: "src/game/types.ts", regex: /interface Ship/, note: "ship type" },
      { file: "src/game/AsteroidsGame.ts", regex: /createShip\(\): Ship/, note: "ship creation" },
    ],
  },
  {
    id: "entity_asteroid_sizes",
    name: "Asteroid Size Chain",
    category: "B. Entities",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Asteroids split large -> medium -> small and then are removed.",
    balancing_notes: "Split density drives pressure.",
    progression_role: "Wave core hazard ladder.",
    related_constants: ["SCORE_LARGE_ASTEROID", "SCORE_MEDIUM_ASTEROID", "SCORE_SMALL_ASTEROID"],
    related_tests: [],
    change_risk: "High",
    future_design_constraints: "Keep split ordering and cap checks deterministic.",
    code: [
      { file: "src/game/types.ts", regex: /AsteroidSize = \"large\" \| \"medium\" \| \"small\"/, note: "size enum" },
      { file: "src/game/AsteroidsGame.ts", regex: /\? \"medium\" : \"small\"/, note: "split chain" },
    ],
  },
  {
    id: "enemy_saucers",
    name: "Saucer Variants",
    category: "C. Enemies",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Large and small saucers spawn with pressure-scaled cadence and aim.",
    balancing_notes: "Small saucers are high-risk/high-reward.",
    progression_role: "Secondary enemy pressure channel.",
    related_constants: ["SCORE_LARGE_SAUCER", "SCORE_SMALL_SAUCER", "SAUCER_BULLET_LIMIT"],
    related_tests: [],
    change_risk: "High",
    future_design_constraints: "Keep pressure function deterministic and mirrored in verifier core.",
    code: [
      { file: "src/game/AsteroidsGame.ts", regex: /maxSaucersForWave/, note: "wave concurrency" },
      { file: "src/game/AsteroidsGame.ts", regex: /getSmallSaucerAimErrorBAM/, note: "small saucer aim" },
    ],
  },
  {
    id: "weapon_ship_bullets",
    name: "Ship Bullets",
    category: "D. Weapons / Attacks",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Player bullets are cap-limited and lifetime-limited.",
    balancing_notes: "Cap and cooldown prevent sustained spam.",
    progression_role: "Primary kill/scoring tool.",
    related_constants: ["SHIP_BULLET_LIMIT", "SHIP_BULLET_LIFETIME_FRAMES", "SHIP_BULLET_COOLDOWN_FRAMES"],
    related_tests: [],
    change_risk: "High",
    future_design_constraints: "Do not bypass cap/cooldown/latch checks.",
    code: [
      { file: "src/game/AsteroidsGame.ts", regex: /SHIP_BULLET_LIMIT/, note: "ship bullet cap" },
      { file: "src/game/AsteroidsGame.ts", regex: /life: SHIP_BULLET_LIFETIME_FRAMES/, note: "ship bullet life" },
    ],
  },
  {
    id: "weapon_saucer_bullets",
    name: "Saucer Bullets",
    category: "D. Weapons / Attacks",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Saucer bullets are cap-limited and lifetime-limited.",
    balancing_notes: "Crossfire ceiling prevents runaway density.",
    progression_role: "Enemy offensive channel.",
    related_constants: ["SAUCER_BULLET_LIMIT", "SAUCER_BULLET_LIFETIME_FRAMES"],
    related_tests: [],
    change_risk: "High",
    future_design_constraints: "Keep cap and cooldown deterministic.",
    code: [
      { file: "src/game/AsteroidsGame.ts", regex: /SAUCER_BULLET_LIMIT/, note: "saucer bullet cap" },
      { file: "src/game/AsteroidsGame.ts", regex: /life: SAUCER_BULLET_LIFETIME_FRAMES/, note: "saucer bullet life" },
    ],
  },
  {
    id: "progress_wave_system",
    name: "Wave Progression",
    category: "F. Progression / Pressure / Pacing",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Wave count increments and large asteroid count ramps to cap 16.",
    balancing_notes: "Primary difficulty curve.",
    progression_role: "Pacing backbone.",
    related_constants: ["ASTEROID_CAP"],
    related_tests: [],
    change_risk: "High",
    future_design_constraints: "Maintain deterministic wave spawn curve.",
    code: [{ file: "src/game/AsteroidsGame.ts", regex: /waveLargeAsteroidCount/, note: "wave function" }],
  },
  {
    id: "progress_anti_lurk",
    name: "Anti-Lurk Pressure",
    category: "F. Progression / Pressure / Pacing",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "timeSinceLastKill raises saucer pressure after 360 frames.",
    balancing_notes: "Punishes passive play.",
    progression_role: "Secondary pacing accelerator.",
    related_constants: ["LURK_TIME_THRESHOLD_FRAMES", "LURK_SAUCER_SPAWN_FAST_FRAMES"],
    related_tests: [],
    change_risk: "High",
    future_design_constraints: "Keep thresholds deterministic.",
    code: [{ file: "src/game/AsteroidsGame.ts", regex: /timeSinceLastKill/, note: "anti-lurk timer" }],
  },
  {
    id: "progress_extra_lives",
    name: "Extra Lives",
    category: "E. Scoring / Rewards",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Starting lives are 3; each 10,000 points grants one extra life.",
    balancing_notes: "Survival reward loop.",
    progression_role: "Run extension reward.",
    related_constants: ["STARTING_LIVES", "EXTRA_LIFE_SCORE_STEP"],
    related_tests: [],
    change_risk: "High",
    future_design_constraints: "Keep threshold logic deterministic.",
    code: [
      { file: "src/game/constants.ts", regex: /STARTING_LIVES = 3/, note: "start lives" },
      { file: "src/game/AsteroidsGame.ts", regex: /nextExtraLifeScore/, note: "extra life threshold" },
    ],
  },
  {
    id: "session_hard_cap",
    name: "Hard Run Cap",
    category: "G. Session Conditions",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Run ends at MAX_GAME_FRAMES (36,000 frames, ~10 minutes at 60 FPS).",
    balancing_notes: "Controls proving cost/time ceiling.",
    progression_role: "Hard session boundary.",
    related_constants: ["MAX_GAME_FRAMES"],
    related_tests: [],
    change_risk: "High",
    future_design_constraints: "Changing cap requires changelog + docs + cost review.",
    code: [
      { file: "src/game/constants.ts", regex: /MAX_GAME_FRAMES = 36_000/, note: "cap constant" },
      { file: "src/game/AsteroidsGame.ts", regex: /frameCount > MAX_GAME_FRAMES/, note: "cap enforcement" },
    ],
  },
  {
    id: "system_replay_load_download",
    name: "Replay Load and Download",
    category: "I. UI / Modes / Replay",
    player_visible: true,
    determinism_critical: false,
    current_behavior_summary: "Menu can load .tape files and game-over can download tape bytes.",
    balancing_notes: "Quality-of-life verification tooling.",
    progression_role: "Post-run operations.",
    related_constants: [],
    related_tests: [],
    change_risk: "Medium",
    future_design_constraints: "Replay remains visual-only for settlement.",
    code: [{ file: "src/game/AsteroidsGame.ts", regex: /downloadTape\(|loadReplay\(/, note: "load/download methods" }],
  },
  {
    id: "system_autopilot",
    name: "Autopilot",
    category: "I. UI / Modes / Replay",
    player_visible: true,
    determinism_critical: false,
    current_behavior_summary: "Autopilot can be toggled during live play and emits same action booleans.",
    balancing_notes: "Testing/lab capability.",
    progression_role: "Tape generation and benchmarking support.",
    related_constants: [],
    related_tests: [],
    change_risk: "Medium",
    future_design_constraints: "Autopilot must remain inside existing input model.",
    code: [{ file: "src/game/AsteroidsGame.ts", regex: /autopilot\.toggle\(\)/, note: "toggle path" }],
  },
  {
    id: "system_leaderboard_hooks",
    name: "Leaderboard Hooks",
    category: "I. UI / Modes / Replay",
    player_visible: true,
    determinism_critical: false,
    current_behavior_summary: "Worker exposes leaderboard APIs and proof-job listing by claimant.",
    balancing_notes: "Presentation layer, not sim logic.",
    progression_role: "Player-facing progression visibility.",
    related_constants: [],
    related_tests: ["tests/worker/api-routes.test.ts"],
    change_risk: "Medium",
    future_design_constraints: "Keep leaderboard sourced from succeeded claims.",
    code: [{ file: "worker/README.md", regex: /leaderboard/i, note: "worker leaderboard scope" }],
  },
  {
    id: "system_score_claim_flow",
    name: "Score Claim Flow",
    category: "H. Determinism / Verification",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Proof jobs require seed_id+claimant and relay submit_score(seal,journal_raw).",
    balancing_notes: "Only improved claimant/seed scores mint rewards.",
    progression_role: "On-chain settlement.",
    related_constants: ["RULES_DIGEST"],
    related_tests: ["tests/worker/queue-consumer.test.ts"],
    change_risk: "Critical",
    future_design_constraints: "No bypass of claimant/seed and journal digest checks.",
    code: [
      { file: "worker/api/routes-proofs.ts", regex: /seed_id/, note: "proof query requirement" },
      { file: "kalien-contract/contracts/asteroids_score/src/lib.rs", regex: /pub fn submit_score\(/, note: "contract submit" },
    ],
  },
  {
    id: "omission_hyperspace",
    name: "Hyperspace",
    category: "L. Archived / Planned / Removed",
    player_visible: true,
    determinism_critical: false,
    current_behavior_summary: "Hyperspace is explicitly omitted in AST4.",
    balancing_notes: "Keeps control and proof surface small.",
    progression_role: "Explicit omission.",
    related_constants: [],
    related_tests: [],
    change_risk: "High",
    future_design_constraints: "Would require deterministic rules and docs updates if added.",
    forceStatus: "Absent",
    docs: [{ file: "docs/games/asteroids/01-GAME-SPEC.md", regex: /Hyperspace is omitted/, note: "explicit omission" }],
    archive: [{ file: "docs/archive/games/asteroids/13-ORIGINAL-RULESET-VARIANCE-AUDIT.md", regex: /No hyperspace\./, note: "archive note" }],
  },
  {
    id: "omission_bosses",
    name: "Bosses",
    category: "L. Archived / Planned / Removed",
    player_visible: true,
    determinism_critical: false,
    current_behavior_summary: "No boss system exists in current AST4 gameplay.",
    balancing_notes: "Current pacing uses waves+saucers, not boss gates.",
    progression_role: "Explicit omission.",
    related_constants: [],
    related_tests: [],
    change_risk: "Medium",
    future_design_constraints: "Adding bosses requires full inventory/docs/test pass.",
    defaultStatus: "Absent",
  },
  {
    id: "omission_powerups",
    name: "Powerups and Pickups",
    category: "L. Archived / Planned / Removed",
    player_visible: true,
    determinism_critical: false,
    current_behavior_summary: "No powerup or pickup entities are implemented.",
    balancing_notes: "Current score model is destruction-only.",
    progression_role: "Explicit omission.",
    related_constants: [],
    related_tests: [],
    change_risk: "Medium",
    future_design_constraints: "If added, define deterministic spawn/pickup rules first.",
    defaultStatus: "Absent",
  },
  {
    id: "omission_shields",
    name: "Shield Mechanics",
    category: "L. Archived / Planned / Removed",
    player_visible: true,
    determinism_critical: false,
    current_behavior_summary: "No shield resource/action; only fixed spawn invulnerability timer exists.",
    balancing_notes: "Avoid conflating invulnerability timer with shield feature.",
    progression_role: "Explicit omission.",
    related_constants: ["SHIP_SPAWN_INVULNERABLE_FRAMES"],
    related_tests: [],
    change_risk: "Medium",
    future_design_constraints: "Document separately if shield systems are introduced.",
    defaultStatus: "Absent",
  },
  {
    id: "unknown_hidden_menus",
    name: "Hidden Menus",
    category: "M. Unknown / Needs Verification",
    player_visible: true,
    determinism_critical: false,
    current_behavior_summary: "No hidden menu flow is evident in audited gameplay paths.",
    balancing_notes: "N/A.",
    progression_role: "N/A.",
    related_constants: [],
    related_tests: [],
    change_risk: "Low",
    future_design_constraints: "If hidden flows are added, classify and document them.",
    defaultStatus: "Unknown",
  },
  {
    id: "unknown_secret_lore",
    name: "Secret Lore or Easter Eggs",
    category: "M. Unknown / Needs Verification",
    player_visible: true,
    determinism_critical: false,
    current_behavior_summary: "No dedicated lore registry is visible in core gameplay files.",
    balancing_notes: "N/A.",
    progression_role: "N/A.",
    related_constants: [],
    related_tests: [],
    change_risk: "Low",
    future_design_constraints: "Keep lore optional and non-consensus.",
    defaultStatus: "Unknown",
  },
  {
    id: "planned_classic_hyperspace_profile",
    name: "Classic Profile with Hyperspace",
    category: "L. Archived / Planned / Removed",
    player_visible: true,
    determinism_critical: true,
    current_behavior_summary: "Archived variance notes suggest a classic profile including hyperspace.",
    balancing_notes: "Would widen rules and proof surface significantly.",
    progression_role: "Deferred design branch.",
    related_constants: [],
    related_tests: [],
    change_risk: "High",
    future_design_constraints: "Remain planned-only until code exists.",
    defaultStatus: "Planned",
    archive: [{ file: "docs/archive/games/asteroids/13-ORIGINAL-RULESET-VARIANCE-AUDIT.md", regex: /classic.*hyperspace/i, note: "archived recommendation" }],
  },
);

const features = specs.map(build);
const featureMap = byId(features);
const get = (id: string): Feature => {
  const found = featureMap.get(id);
  if (!found) throw new Error(`missing feature ${id}`);
  return found;
};

const modes = ["menu", "playing", "paused", "game-over", "replay"]
  .filter((mode) => typesText.includes(`\"${mode}\"`))
  .map((mode) => get(`mode_${mode.replace("-", "_")}`));

const playerActions = [
  get("action_left"),
  get("action_right"),
  get("action_thrust"),
  get("action_fire"),
  get("action_keyboard_controls"),
  get("action_xbox_controller"),
];

const entities = [get("entity_ship"), get("entity_asteroid_sizes"), get("weapon_ship_bullets"), get("weapon_saucer_bullets")];
const enemies = [get("entity_asteroid_sizes"), get("enemy_saucers")];
const weapons = [get("weapon_ship_bullets"), get("weapon_saucer_bullets")];

const deterministicCritical = [
  get("action_left"),
  get("action_right"),
  get("action_thrust"),
  get("action_fire"),
  get("progress_wave_system"),
  get("progress_anti_lurk"),
  get("progress_extra_lives"),
  get("session_hard_cap"),
  get("system_score_claim_flow"),
];
const cosmetics: Feature[] = [
  {
    id: "cosmetic_gamepad_rumble",
    name: "Gamepad Rumble",
    category: "J. Presentation / Cosmetic",
    status: "Implemented",
    player_visible: true,
    determinism_critical: false,
    current_behavior_summary: "Optional Gamepad API rumble effects on fire/ship-loss/extra-life.",
    balancing_notes: "No gameplay-state effect.",
    progression_role: "Feedback-only presentation.",
    related_constants: [],
    related_tests: [],
    evidence_refs: [
      firstRef("src/game/gamepad.ts", /pulseConnectedGamepads/) ?? "src/game/gamepad.ts",
      firstRef("src/game/AsteroidsGame.ts", /pulseConnectedGamepads\(18, 0\.3, 0\.08\)/) ?? "src/game/AsteroidsGame.ts",
    ],
    change_risk: "Low",
    future_design_constraints: "Keep non-consensus.",
  },
];

const explicitOmissions = [get("omission_hyperspace"), get("omission_bosses"), get("omission_powerups"), get("omission_shields")];
const unknowns = [get("unknown_hidden_menus"), get("unknown_secret_lore")];
const archivedOrPlanned = [get("planned_classic_hyperspace_profile")];

const deterministicConstants: Record<string, number> = {
  RULES_TAG: constants.RULES_TAG ?? 4,
  MAX_GAME_FRAMES: constants.MAX_GAME_FRAMES ?? 36000,
  STARTING_LIVES: constants.STARTING_LIVES ?? 3,
  EXTRA_LIFE_SCORE_STEP: constants.EXTRA_LIFE_SCORE_STEP ?? 10000,
  SHIP_BULLET_LIMIT: constants.SHIP_BULLET_LIMIT ?? 4,
  SAUCER_BULLET_LIMIT: constants.SAUCER_BULLET_LIMIT ?? 2,
  SHIP_RESPAWN_FRAMES: constants.SHIP_RESPAWN_FRAMES ?? 75,
  SHIP_SPAWN_INVULNERABLE_FRAMES: constants.SHIP_SPAWN_INVULNERABLE_FRAMES ?? 120,
  LURK_TIME_THRESHOLD_FRAMES: constants.LURK_TIME_THRESHOLD_FRAMES ?? 360,
  LURK_SAUCER_SPAWN_FAST_FRAMES: constants.LURK_SAUCER_SPAWN_FAST_FRAMES ?? 180,
};

const manifest: Manifest = {
  generated_at: new Date().toISOString(),
  repo_commit: repoCommit,
  rules_tag: rulesTag,
  game_identity: {
    name: "Kalien",
    genre: "Deterministic Asteroids",
    core_claim: "Seeded frame-input tapes are replayed for proof and settled as claimant-bound scores on Stellar.",
  },
  modes,
  player_actions: playerActions,
  entities,
  enemies,
  weapons,
  progression: {
    summary: "Wave-driven asteroid pacing with pressure-scaled saucer threat.",
    wave_model: "Waves increment and large asteroid count ramps 4,6,8,10 then +1 to cap 16.",
    anti_lurk: "After 360 frames without asteroid kills, anti-lurk pressure accelerates saucer behavior.",
    saucer_pressure: "Wave+lurk pressure compresses saucer cooldown windows and small-saucer aim error.",
    evidence_refs: [
      firstRef("src/game/AsteroidsGame.ts", /waveLargeAsteroidCount/) ?? "src/game/AsteroidsGame.ts",
      firstRef("src/game/AsteroidsGame.ts", /timeSinceLastKill/) ?? "src/game/AsteroidsGame.ts",
    ],
  },
  scoring: {
    summary: "Scoring comes from asteroid/saucer destruction and grants extra lives every 10,000 points.",
    score_bands: {
      asteroid_large: constants.SCORE_LARGE_ASTEROID ?? 20,
      asteroid_medium: constants.SCORE_MEDIUM_ASTEROID ?? 50,
      asteroid_small: constants.SCORE_SMALL_ASTEROID ?? 100,
      saucer_large: constants.SCORE_LARGE_SAUCER ?? 200,
      saucer_small: constants.SCORE_SMALL_SAUCER ?? 990,
    },
    extra_life_step: constants.EXTRA_LIFE_SCORE_STEP ?? 10000,
    evidence_refs: [
      firstRef("src/game/constants.ts", /SCORE_LARGE_ASTEROID/) ?? "src/game/constants.ts",
      firstRef("src/game/AsteroidsGame.ts", /nextExtraLifeScore/) ?? "src/game/AsteroidsGame.ts",
    ],
  },
  session_constraints: {
    max_game_frames: constants.MAX_GAME_FRAMES ?? 36000,
    fixed_timestep_hz: 60,
    requires_seed_and_seed_id_for_claim: true,
    deterministic_constants: deterministicConstants,
    evidence_refs: [
      firstRef("src/game/constants.ts", /MAX_GAME_FRAMES/) ?? "src/game/constants.ts",
      firstRef("worker/api/routes-proofs.ts", /seed_id/) ?? "worker/api/routes-proofs.ts",
      firstRef("kalien-contract/contracts/asteroids_score/src/lib.rs", /submit_score/) ?? "kalien-contract/contracts/asteroids_score/src/lib.rs",
    ],
  },
  determinism_critical: deterministicCritical,
  non_consensus_cosmetics: cosmetics,
  explicit_omissions: explicitOmissions,
  unknowns,
  archived_or_planned: archivedOrPlanned,
  evidence: [
    {
      id: "ev_4bit_input",
      file: "src/game/tape.ts",
      line: Number.parseInt((firstRef("src/game/tape.ts", /bit 0 \(0x1\): left/) ?? "src/game/tape.ts:1").split(":").at(-1) ?? "1", 10),
      note: "Four-bit action contract",
    },
    {
      id: "ev_run_cap",
      file: "src/game/constants.ts",
      line: Number.parseInt((firstRef("src/game/constants.ts", /MAX_GAME_FRAMES = 36_000/) ?? "src/game/constants.ts:1").split(":").at(-1) ?? "1", 10),
      note: "10-minute cap",
    },
    {
      id: "ev_claim_path",
      file: "kalien-contract/contracts/asteroids_score/src/lib.rs",
      line: Number.parseInt((firstRef("kalien-contract/contracts/asteroids_score/src/lib.rs", /pub fn submit_score\(/) ?? "kalien-contract/contracts/asteroids_score/src/lib.rs:1").split(":").at(-1) ?? "1", 10),
      note: "On-chain claim entrypoint",
    },
  ],
};

const prevText = maybe(MANIFEST_PATH);
const prev = prevText ? (JSON.parse(prevText) as Manifest) : null;
const nextText = `${JSON.stringify(manifest, null, 2)}\n`;
const drift = prev
  ? JSON.stringify(normalizedForCompare(prev)) !== JSON.stringify(normalizedForCompare(manifest))
  : true;

const currFeatures = allFeatures(manifest);
const prevFeatures = prev ? allFeatures(prev) : [];
const currMap = byId(currFeatures);
const prevMap = byId(prevFeatures);

const added = uniqueIds(currFeatures).filter((id) => !prevMap.has(id));
const removed = uniqueIds(prevFeatures).filter((id) => !currMap.has(id));
const changed = uniqueIds(currFeatures).filter((id) => {
  const a = currMap.get(id);
  const b = prevMap.get(id);
  return Boolean(a && b && JSON.stringify(a) !== JSON.stringify(b));
});

const prevConsts = prev?.session_constraints?.deterministic_constants ?? {};
const changedConsts = Object.keys({ ...prevConsts, ...deterministicConstants }).filter(
  (k) => prevConsts[k] !== deterministicConstants[k],
);

const inventory = maybe(INVENTORY_DOC_PATH).toLowerCase();
const manual = maybe(MANUAL_DOC_PATH).toLowerCase();
const changelog = maybe(CHANGELOG_DOC_PATH);

const undocumentedAdditions = added.filter((id) => {
  const f = currMap.get(id);
  if (!f || f.status !== "Implemented") return false;
  return !(inventory.includes(id.toLowerCase()) && manual.includes(f.name.toLowerCase()));
});

const documentedNoCode = currFeatures.filter((f) => f.status === "Documented").map((f) => f.id);
const manualMissing = currFeatures
  .filter((f) => f.status === "Implemented" && f.player_visible)
  .filter((f) => !manual.includes(f.name.toLowerCase()))
  .map((f) => f.id);

const typesEntities = Array.from(typesText.matchAll(/interface\s+(Ship|Asteroid|Bullet|Saucer)/g)).map((m) => m[1]);
const manifestEntitiesMissing = typesEntities.filter(
  (name) => !manifest.entities.some((e) => e.name.toLowerCase().includes(name.toLowerCase())),
);

const constantsMissingChangelog = changedConsts.filter((key) => !changelog.includes(key));

const statusCounts = currFeatures.reduce<Record<FeatureStatus, number>>(
  (acc, f) => {
    acc[f.status] += 1;
    return acc;
  },
  { Implemented: 0, Documented: 0, Planned: 0, Absent: 0, Unknown: 0 },
);

console.log("[game:inventory] scanned paths:", SCAN_PATHS.length);
console.log("[game:inventory] repo commit:", manifest.repo_commit);
console.log("[game:inventory] rules_tag:", manifest.rules_tag);
console.log("[game:inventory] status counts:", statusCounts);
console.log("[game:inventory] diff:", {
  added: added.length,
  removed: removed.length,
  changed: changed.length,
  deterministic_constant_changes: changedConsts.length,
});
if (added.length > 0) console.log("[game:inventory] added ids:", added.join(", "));
if (removed.length > 0) console.log("[game:inventory] removed ids:", removed.join(", "));
if (changed.length > 0) console.log("[game:inventory] changed ids:", changed.join(", "));
if (changedConsts.length > 0) console.log("[game:inventory] changed constants:", changedConsts.join(", "));

if (write) {
  writeFileSync(resolve(ROOT, MANIFEST_PATH), nextText, "utf8");
  console.log(`[game:inventory] wrote ${MANIFEST_PATH}`);
} else {
  console.log("[game:inventory] dry-run (manifest not written)");
}

if (!strict) process.exit(0);

const strictIssues: string[] = [];
if (!prev) strictIssues.push("strict mode requires existing manifest (run --write first)");
if (drift) strictIssues.push("manifest drift detected");
if (undocumentedAdditions.length > 0) strictIssues.push(`new implemented features missing docs coverage: ${undocumentedAdditions.join(", ")}`);
if (documentedNoCode.length > 0) strictIssues.push(`documented features without code evidence: ${documentedNoCode.join(", ")}`);
if (constantsMissingChangelog.length > 0) strictIssues.push(`deterministic constants changed without changelog entry: ${constantsMissingChangelog.join(", ")}`);
if (manifestEntitiesMissing.length > 0) strictIssues.push(`code entities missing from manifest entities[]: ${manifestEntitiesMissing.join(", ")}`);
if (manualMissing.length > 0) strictIssues.push(`player-visible implemented features missing from manual: ${manualMissing.join(", ")}`);

if (strictIssues.length > 0) {
  console.error("[game:inventory] strict-mode failures:");
  for (const issue of strictIssues) console.error(` - ${issue}`);
  process.exit(1);
}

console.log("[game:inventory] strict-mode checks passed");
