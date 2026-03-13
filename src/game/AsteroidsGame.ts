import {
  ASTEROID_CAP,
  ASTEROID_SPEED_Q8_8,
  EXTRA_LIFE_SCORE_STEP,
  FIXED_TIMESTEP,
  LURK_SAUCER_SPAWN_FAST_FRAMES,
  LURK_TIME_THRESHOLD_FRAMES,
  MAX_FRAME_DELTA,
  MAX_GAME_FRAMES,
  MAX_SUBSTEPS,
  SAUCER_BULLET_LIFETIME_FRAMES,
  SAUCER_BULLET_LIMIT,
  SAUCER_BULLET_SPEED_Q8_8,
  SAUCER_SPAWN_MAX_FRAMES,
  SAUCER_SPAWN_MIN_FRAMES,
  SAUCER_SPEED_LARGE_Q8_8,
  SAUCER_SPEED_SMALL_Q8_8,
  SCORE_LARGE_ASTEROID,
  SCORE_LARGE_SAUCER,
  SCORE_MEDIUM_ASTEROID,
  SCORE_SMALL_ASTEROID,
  SCORE_SMALL_SAUCER,
  SHAKE_INTENSITY_LARGE,
  SHAKE_INTENSITY_MEDIUM,
  SHAKE_INTENSITY_SMALL,
  SHIP_BULLET_LIFETIME_FRAMES,
  SHIP_BULLET_COOLDOWN_FRAMES,
  SHIP_BULLET_LIMIT,
  SHIP_BULLET_SPEED_Q8_8,
  SHIP_FACING_UP_BAM,
  SHIP_MAX_SPEED_SQ_Q16_16,
  SHIP_RADIUS,
  SHIP_RESPAWN_FRAMES,
  SHIP_SPAWN_INVULNERABLE_FRAMES,
  SHIP_THRUST_Q8_8,
  SHIP_TURN_SPEED_BAM,
  STARTING_LIVES,
  STORAGE_HIGH_SCORE_KEY,
  WORLD_HEIGHT,
  WORLD_HEIGHT_Q12_4,
  WORLD_WIDTH,
  WORLD_WIDTH_Q12_4,
} from "./constants";
import { AudioSystem } from "./AudioSystem";
import { Autopilot, type AutopilotConfig, type GameStateSnapshot } from "./Autopilot";
import {
  applyDrag,
  atan2BAM,
  BAMToRadians,
  clampSpeedQ8_8,
  cosBAM,
  displaceQ12_4,
  fromQ12_4,
  fromQ8_8,
  sinBAM,
  toQ12_4,
  velocityQ8_8,
} from "./fixed-point";
import { GameRenderer, type GameRenderState } from "./GameRenderer";
import { InputController } from "./input";
import type { InputSource } from "./input-source";
import { LiveInputSource, TapeInputSource } from "./input-source";
import {
  clamp,
  getGameRng,
  getGameRngState,
  randomInt,
  setGameSeed,
  wrapXQ12_4,
  wrapYQ12_4,
} from "./math";
import { deserializeTape, serializeTape, TapeRecorder, type Tape } from "./tape";
import type { Asteroid, AsteroidSize, Bullet, GameMode, Saucer, Ship } from "./types";

const ASTEROID_RADIUS_BY_SIZE: Record<AsteroidSize, number> = {
  large: 48,
  medium: 28,
  small: 16,
};

const SAUCER_RADIUS_LARGE = 22;
const SAUCER_RADIUS_SMALL = 16;
const SHIP_RESPAWN_EDGE_PADDING_Q12_4 = 1536; // 96px
const SHIP_RESPAWN_GRID_STEP_Q12_4 = 1024; // 64px
const SAUCER_START_X_LEFT_Q12_4 = -480;
const SAUCER_START_X_RIGHT_Q12_4 = 15840;
const SAUCER_START_Y_MIN_Q12_4 = 1152;
const SAUCER_START_Y_MAX_Q12_4 = 10368;
const SAUCER_CULL_MIN_X_Q12_4 = -1280;
const SAUCER_CULL_MAX_X_Q12_4 = 16640;
const WAVE_SAFE_DIST_SQ_Q24_8 = 2880 * 2880;

function waveLargeAsteroidCount(wave: number): number {
  if (wave <= 4) {
    return 4 + (wave - 1) * 2;
  }
  return Math.min(16, 10 + (wave - 4));
}

function maxSaucersForWave(wave: number): number {
  if (wave < 4) {
    return 1;
  }
  if (wave < 7) {
    return 2;
  }
  return 3;
}

function shortestDeltaQ12_4(from: number, to: number, size: number): number {
  let delta = to - from;
  const half = size >> 1;
  if (delta > half) delta -= size;
  else if (delta < -half) delta += size;
  return delta;
}

function shortestDeltaWorldXQ12_4(from: number, to: number): number {
  return shortestDeltaQ12_4(from, to, WORLD_WIDTH_Q12_4);
}

function shortestDeltaWorldYQ12_4(from: number, to: number): number {
  return shortestDeltaQ12_4(from, to, WORLD_HEIGHT_Q12_4);
}

function collisionDistSqQ12_4(ax: number, ay: number, bx: number, by: number): number {
  const dx = shortestDeltaWorldXQ12_4(ax, bx);
  const dy = shortestDeltaWorldYQ12_4(ay, by);
  return dx * dx + dy * dy;
}

function collidesQ12_4(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): boolean {
  const hitDistQ12_4 = (ar + br) << 4;
  const negHitDistQ12_4 = -hitDistQ12_4;
  const dx = shortestDeltaWorldXQ12_4(ax, bx);
  if (dx < negHitDistQ12_4 || dx > hitDistQ12_4) {
    return false;
  }
  const dy = shortestDeltaWorldYQ12_4(ay, by);
  if (dy < negHitDistQ12_4 || dy > hitDistQ12_4) {
    return false;
  }
  return dx * dx + dy * dy <= hitDistQ12_4 * hitDistQ12_4;
}

function clearanceSqQ12_4(
  hazardX: number,
  hazardY: number,
  hazardRadius: number,
  spawnX: number,
  spawnY: number,
  spawnRadius: number,
): number {
  const hitDistQ12_4 = (hazardRadius + spawnRadius) << 4;
  const dx = shortestDeltaWorldXQ12_4(hazardX, spawnX);
  const dy = shortestDeltaWorldYQ12_4(hazardY, spawnY);
  return dx * dx + dy * dy - hitDistQ12_4 * hitDistQ12_4;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return true;
  }

  if (target instanceof HTMLSelectElement) {
    return true;
  }

  return target instanceof HTMLElement && target.isContentEditable;
}

export interface GameConfig {
  canvas?: HTMLCanvasElement;
  headless?: boolean;
  seed?: number;
  seedId?: number;
  autopilotConfig?: Partial<AutopilotConfig>;
}

export interface GameRunRecord {
  seed: number;
  seedId: number;
  inputs: Uint8Array;
  finalScore: number;
}

export interface ReplaySessionState {
  active: boolean;
  paused: boolean;
  speed: 1 | 2 | 4;
}

export class AsteroidsGame {
  private readonly canvas: HTMLCanvasElement | null;

  private readonly renderer: GameRenderer | null;

  private readonly input = new InputController();

  private readonly audio = new AudioSystem();

  private readonly autopilot: Autopilot;
  private autopilotOnStart = false;
  private endlessModeEnabled = false;
  private endlessModeDetail: string | null = null;

  private mode: GameMode = "menu";

  private score = 0;

  private highScore = 0;

  private lives = STARTING_LIVES;

  private wave = 0;

  private nextExtraLifeScore = EXTRA_LIFE_SCORE_STEP;

  private ship: Ship;

  private asteroids: Asteroid[] = [];

  private bullets: Bullet[] = [];

  private saucers: Saucer[] = [];

  private saucerBullets: Bullet[] = [];

  private saucerSpawnTimer = randomInt(SAUCER_SPAWN_MIN_FRAMES, SAUCER_SPAWN_MAX_FRAMES);

  private nextId = 1;

  private rafId: number | null = null;

  private lastTimeMs = 0;

  private accumulator = 0;

  private running = true;

  private pauseFromHidden = false;

  // Thrust timing (frame-count based)
  private thrustParticleTimer = 0;

  // Anti-lurking: time since last asteroid destroyed by player
  private timeSinceLastKill = 0;

  // Game time for animations (star twinkle, etc.)
  private gameTime = 0;

  // Game seed for deterministic RNG (ZK-friendly)
  private gameSeed = 0;
  private gameSeedId = 0;

  // Seed supplied externally by the UI (fetched from contract); used when
  // startNewGame() is called without an explicit seed argument.
  private pendingSeed: number | null = null;
  private pendingSeedId: number | null = null;
  private pendingSeedSecondsLeft = 0;
  private waitingForSeed = false;

  // Frame counter for deterministic timing
  private frameCount = 0;

  // Input source abstraction (live keyboard/autopilot or tape replay)
  private inputSource: InputSource | null = null;

  // Tape recording
  private recorder: TapeRecorder | null = null;

  // Replay state
  private replaySpeed = 1;
  private replayPaused = false;
  private replayTapeSource: TapeInputSource | null = null;
  private replayTape: Tape | null = null;
  private replayPending = false;

  // Notifies UI when entering or exiting a replay session
  onReplayStateChange: ((state: ReplaySessionState) => void) | null = null;
  onAutopilotStateChange: ((enabled: boolean) => void) | null = null;

  // Current frame input (read at start of updateSimulation, used by updateShip)
  private currentFrameInput: {
    left: boolean;
    right: boolean;
    thrust: boolean;
    fire: boolean;
  } = {
    left: false,
    right: false,
    thrust: false,
    fire: false,
  };

  private shipFireLatch = false;

  private readonly keyDownHandler = (event: KeyboardEvent): void => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !isEditableTarget(event.target)) {
      this.audio.enable();
    }
    this.input.handleKeyDown(event);
  };

  private readonly keyUpHandler = (event: KeyboardEvent): void => {
    this.input.handleKeyUp(event);
  };

  // Prime audio from any trusted tap/click, even if the gesture lands on UI chrome instead of the canvas.
  private readonly userGesturePointerHandler = (): void => {
    this.audio.enable();
  };

  private readonly visibilityHandler = (): void => {
    if (document.hidden && this.mode === "playing") {
      this.mode = "paused";
      this.pauseFromHidden = true;
      this.audio.pauseMusic();
    } else if (!document.hidden && this.mode === "paused" && this.pauseFromHidden) {
      this.mode = "playing";
      this.pauseFromHidden = false;
      this.lastTimeMs = 0;
      this.accumulator = 0;
      this.audio.resumeMusic();
    }
  };

  private readonly pointerDownHandler = (): void => {
    if ((this.mode === "menu" || this.mode === "game-over") && this.canStartLiveRun()) {
      this.audio.enable();
      this.startNewGame();
    } else if (this.mode === "paused" && !this.pauseFromHidden) {
      this.mode = "playing";
      this.audio.resumeMusic();
    }
  };

  private readonly resizeHandler = (): void => {
    this.resize();
  };

  private readonly frameHandler = (timestampMs: number): void => {
    if (!this.running) {
      return;
    }

    this.updateFrame(timestampMs);
    this.rafId = window.requestAnimationFrame(this.frameHandler);
  };

  constructor(config: GameConfig) {
    this.autopilot = new Autopilot(config.autopilotConfig);
    this.canvas = config.canvas ?? null;
    this.ship = this.createShip();
    if (config.seed !== undefined) {
      this.pendingSeed = config.seed >>> 0;
      this.pendingSeedId = (config.seedId ?? 0) >>> 0;
    }

    if (config.headless === true) {
      // Headless mode: no rendering, no events, no audio
      this.renderer = null;
      if (config.seed !== undefined) {
        this.gameSeed = config.seed >>> 0;
        this.gameSeedId = (config.seedId ?? 0) >>> 0;
        setGameSeed(this.gameSeed);
      }
      return;
    }

    // Interactive mode
    if (!this.canvas) {
      throw new Error("Canvas required for non-headless mode.");
    }

    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("aria-label", "Asteroids game canvas");

    this.renderer = new GameRenderer(this.canvas);

    this.loadHighScore();
    this.renderer.seedStars(120);
    this.attachEvents();
    this.renderer.resize();

    this.rafId = window.requestAnimationFrame(this.frameHandler);
  }

  dispose(): void {
    this.running = false;
    this.audio.stopMusic();

    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.renderer) {
      this.detachEvents();
    }
  }

  private attachEvents(): void {
    window.addEventListener("keydown", this.keyDownHandler, { passive: false });
    window.addEventListener("keyup", this.keyUpHandler, { passive: false });
    window.addEventListener("pointerdown", this.userGesturePointerHandler, { passive: true });
    window.addEventListener("resize", this.resizeHandler);
    document.addEventListener("visibilitychange", this.visibilityHandler);
    this.canvas?.addEventListener("pointerdown", this.pointerDownHandler);
  }

  private detachEvents(): void {
    window.removeEventListener("keydown", this.keyDownHandler);
    window.removeEventListener("keyup", this.keyUpHandler);
    window.removeEventListener("pointerdown", this.userGesturePointerHandler);
    window.removeEventListener("resize", this.resizeHandler);
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    this.canvas?.removeEventListener("pointerdown", this.pointerDownHandler);
  }

  private resize(): void {
    this.renderer?.resize();
  }

  private updateFrame(timestampMs: number): void {
    this.handleGlobalInput();

    if (this.mode === "playing") {
      if (this.lastTimeMs === 0) {
        this.lastTimeMs = timestampMs;
      }

      let deltaSeconds = (timestampMs - this.lastTimeMs) / 1000;
      this.lastTimeMs = timestampMs;
      deltaSeconds = Math.min(MAX_FRAME_DELTA, Math.max(0, deltaSeconds));
      this.accumulator += deltaSeconds;

      let steps = 0;

      while (this.accumulator >= FIXED_TIMESTEP && steps < MAX_SUBSTEPS) {
        // Store previous positions for interpolation before update
        this.storePreviousPositions();
        this.updateSimulation(FIXED_TIMESTEP);
        this.accumulator -= FIXED_TIMESTEP;
        steps += 1;
      }

      if (steps === MAX_SUBSTEPS) {
        this.accumulator = 0;
      }

      // Update game time for animations
      this.gameTime += deltaSeconds;
    } else if (this.mode === "replay") {
      // Replay mode: accumulator-based, same as playing but with speed multiplier
      if (this.lastTimeMs === 0) {
        this.lastTimeMs = timestampMs;
      }

      let deltaSeconds = (timestampMs - this.lastTimeMs) / 1000;
      this.lastTimeMs = timestampMs;
      deltaSeconds = Math.min(MAX_FRAME_DELTA, Math.max(0, deltaSeconds));

      if (!this.replayPaused && this.replayTapeSource && !this.replayTapeSource.isComplete()) {
        this.accumulator += deltaSeconds * this.replaySpeed;
        let steps = 0;
        const maxSteps = MAX_SUBSTEPS * this.replaySpeed;

        while (this.accumulator >= FIXED_TIMESTEP && steps < maxSteps) {
          if (this.replayTapeSource.isComplete()) break;
          this.storePreviousPositions();
          this.updateSimulation(FIXED_TIMESTEP);
          this.accumulator -= FIXED_TIMESTEP;
          steps += 1;
        }

        if (steps >= maxSteps) {
          this.accumulator = 0;
        }
      }

      // When the replay tape finishes, transition to game-over so the UI
      // can show the ScoreCard and allow score submission.
      if (this.replayTapeSource?.isComplete() && this.mode === "replay") {
        this.mode = "game-over";
        if (this.renderer) {
          this.saveHighScore();
        }
      }

      this.gameTime += deltaSeconds;
    } else {
      this.lastTimeMs = 0;
      this.accumulator = 0;
      // Still update game time for menu animations
      this.gameTime += 1 / 60;
      // Keep visual effects (death anim, particles, shockwaves) ticking after game ends
      if (this.mode === "game-over") {
        this.renderer?.updateVisuals(FIXED_TIMESTEP);
      }
    }

    const alpha = this.accumulator / FIXED_TIMESTEP;
    if (this.renderer) {
      this.renderer.render(this.buildRenderState(), alpha);
    }
    this.input.clearPressed();
  }

  private handleGlobalInput(): void {
    if (this.input.consumePress("Enter")) {
      if ((this.mode === "menu" || this.mode === "game-over") && this.canStartLiveRun()) {
        this.audio.enable();
        this.startNewGame();
      } else if (this.mode === "paused") {
        this.mode = "playing";
        this.pauseFromHidden = false;
        this.audio.resumeMusic();
      }
    }

    if (this.input.consumePress("KeyM")) {
      this.audio.toggleMute();
    }

    if (this.mode === "playing" && this.input.consumePress("KeyP")) {
      this.mode = "paused";
      this.pauseFromHidden = false;
      this.audio.pauseMusic();
    } else if (this.mode === "paused" && !this.pauseFromHidden && this.input.consumePress("KeyP")) {
      this.mode = "playing";
      this.audio.resumeMusic();
    }

    if (this.input.consumePress("KeyR") && this.mode !== "menu" && this.canStartLiveRun()) {
      this.startNewGame();
    }

    // Toggle autopilot with 'A' key
    if (this.input.consumePress("KeyA") && this.mode === "playing") {
      this.toggleAutopilot();
    }

    // Download tape with 'D' key in game-over
    if (this.input.consumePress("KeyD") && this.mode === "game-over") {
      this.downloadTape();
    }

    // Load tape with 'L' key in menu
    if (this.input.consumePress("KeyL") && this.mode === "menu") {
      this.triggerFileLoad();
    }

    // Replay speed controls
    if (this.mode === "replay") {
      if (this.input.consumePress("Digit1")) {
        this.setReplaySpeed(1);
      }
      if (this.input.consumePress("Digit2")) {
        this.setReplaySpeed(2);
      }
      if (this.input.consumePress("Digit4")) {
        this.setReplaySpeed(4);
      }
      if (this.input.consumePress("KeyP")) {
        this.toggleReplayPause();
      }
    }

    // Return to menu with Escape (or exit replay session)
    if (this.input.consumePress("Escape") && this.mode !== "menu") {
      this.resetToMenu();
    }
  }

  /** Update current seed + seed-window countdown provided by the UI layer. */
  setCurrentSeed(
    seed: number | null,
    seedId: number | null,
    secondsLeft = this.pendingSeedSecondsLeft,
  ): void {
    this.pendingSeed = seed === null ? null : seed >>> 0;
    this.pendingSeedId = seedId === null ? null : seedId >>> 0;
    this.pendingSeedSecondsLeft = Math.max(0, Math.ceil(secondsLeft));

    // If the player already requested a game start/restart while we were waiting
    // on the epoch seed, auto-start immediately once it appears.
    if (this.pendingSeed !== null && this.waitingForSeed) {
      this.waitingForSeed = false;
      this.startNewGame(this.pendingSeed, this.pendingSeedId ?? undefined);
    }
  }

  startNewGame(seed?: number, seedId?: number): void {
    // Use provided seed, or fall back to the externally-set pending seed.
    const resolvedSeed = seed !== undefined ? seed >>> 0 : this.pendingSeed;
    const resolvedSeedId = seedId !== undefined ? seedId >>> 0 : this.pendingSeedId;
    if (resolvedSeed === null || resolvedSeedId === null) {
      // Avoid starting runs before a chain seed + seed_id are available.
      this.waitingForSeed = true;
      this.mode = "menu";
      return;
    }

    this.waitingForSeed = false;
    this.gameSeed = resolvedSeed;
    this.gameSeedId = resolvedSeedId;
    setGameSeed(this.gameSeed);

    this.mode = "playing";
    this.audio.playMusic();
    this.score = 0;
    this.lives = STARTING_LIVES;
    this.wave = 0;
    this.nextExtraLifeScore = EXTRA_LIFE_SCORE_STEP;
    this.asteroids = [];
    this.bullets = [];
    this.saucers = [];
    this.saucerBullets = [];
    this.timeSinceLastKill = 0;
    this.frameCount = 0;
    this.gameTime = 0;
    this.ship = this.createShip();
    this.shipFireLatch = false;
    this.renderer?.reset();
    this.setAutopilotEnabled(this.autopilotOnStart, { notify: false });

    // Set up recording
    this.recorder = new TapeRecorder();

    // Set up live input source (unless an external source is already set)
    if (!this.inputSource || this.inputSource instanceof TapeInputSource) {
      this.inputSource = new LiveInputSource(this.input, this.autopilot, () =>
        this.autopilot.update(this.getGameStateSnapshot(), FIXED_TIMESTEP, this.gameTime),
      );
    }

    // Reset replay state
    this.replayPending = false;
    this.replayTapeSource = null;
    this.replayTape = null;
    this.replaySpeed = 1;
    this.replayPaused = false;

    this.spawnWave();
    const waveMultPct = Math.max(40, 100 - (this.wave - 1) * 8);
    const spawnMin = ((SAUCER_SPAWN_MIN_FRAMES * waveMultPct) / 100) | 0;
    const spawnMax = ((SAUCER_SPAWN_MAX_FRAMES * waveMultPct) / 100) | 0;
    this.saucerSpawnTimer = randomInt(spawnMin, spawnMax);
  }

  private storePreviousPositions(): void {
    const ship = this.ship;
    ship.prevX = ship.x;
    ship.prevY = ship.y;
    ship.prevAngle = ship.angle;

    for (const asteroid of this.asteroids) {
      asteroid.prevX = asteroid.x;
      asteroid.prevY = asteroid.y;
      asteroid.prevAngle = asteroid.angle;
    }

    for (const bullet of this.bullets) {
      bullet.prevX = bullet.x;
      bullet.prevY = bullet.y;
      bullet.prevAngle = bullet.angle;
    }

    for (const bullet of this.saucerBullets) {
      bullet.prevX = bullet.x;
      bullet.prevY = bullet.y;
      bullet.prevAngle = bullet.angle;
    }

    for (const saucer of this.saucers) {
      saucer.prevX = saucer.x;
      saucer.prevY = saucer.y;
      saucer.prevAngle = saucer.angle;
    }
  }

  private updateSimulation(dt: number): void {
    this.frameCount++;

    // 10-minute hard cap (36000 frames at 60fps)
    if (this.frameCount > MAX_GAME_FRAMES && this.mode !== "replay") {
      this.mode = "game-over";
      this.audio.stopMusic();
      this.ship.canControl = false;
      this.ship.respawnTimer = 99999;
      if (this.renderer) {
        this.saveHighScore();
      }
      return;
    }

    // Read input for this frame (always, even when ship can't be controlled)
    this.currentFrameInput = this.inputSource
      ? this.inputSource.getFrameInput()
      : { left: false, right: false, thrust: false, fire: false };

    // Record input for tape (one byte per frame, always)
    this.recorder?.record(this.currentFrameInput);

    this.updateShip(dt);
    this.updateAsteroids();
    this.updateBullets();
    this.updateSaucers();
    this.updateSaucerBullets();

    this.renderer?.updateVisuals(dt);

    this.handleCollisions();
    this.pruneDestroyedEntities();

    // Anti-lurking timer (frame count)
    this.timeSinceLastKill++;

    // Advance input source cursor
    this.inputSource?.advance();

    if (
      (this.mode === "playing" || (this.mode === "replay" && this.lives > 0)) &&
      this.asteroids.length === 0 &&
      this.saucers.length === 0
    ) {
      this.spawnWave();
    }
  }

  private createShip(): Ship {
    const x = toQ12_4(WORLD_WIDTH * 0.5); // 7680
    const y = toQ12_4(WORLD_HEIGHT * 0.5); // 5760
    const angle = SHIP_FACING_UP_BAM; // 192 (points up)
    return {
      id: this.nextId++,
      x,
      y,
      vx: 0,
      vy: 0,
      angle,
      alive: true,
      radius: SHIP_RADIUS,
      prevX: x,
      prevY: y,
      prevAngle: angle,
      canControl: true,
      fireCooldown: 0,
      respawnTimer: 0,
      invulnerableTimer: SHIP_SPAWN_INVULNERABLE_FRAMES,
    };
  }

  private getShipSpawnPoint(): { x: number; y: number } {
    return {
      x: toQ12_4(WORLD_WIDTH * 0.5),
      y: toQ12_4(WORLD_HEIGHT * 0.5),
    };
  }

  private queueShipRespawn(delayFrames: number): void {
    this.ship.canControl = false;
    this.ship.respawnTimer = delayFrames;
    this.ship.vx = 0;
    this.ship.vy = 0;
    this.ship.fireCooldown = 0;
    this.ship.invulnerableTimer = 0;
    this.shipFireLatch = false;
  }

  private spawnSafetyScore(spawnX: number, spawnY: number, bestKnownSafetyScore: number): number {
    let minClearanceSq = Number.MAX_SAFE_INTEGER;

    for (const asteroid of this.asteroids) {
      minClearanceSq = Math.min(
        minClearanceSq,
        clearanceSqQ12_4(asteroid.x, asteroid.y, asteroid.radius, spawnX, spawnY, this.ship.radius),
      );
      if (minClearanceSq < bestKnownSafetyScore) {
        return minClearanceSq;
      }
    }

    for (const saucer of this.saucers) {
      minClearanceSq = Math.min(
        minClearanceSq,
        clearanceSqQ12_4(saucer.x, saucer.y, saucer.radius, spawnX, spawnY, this.ship.radius),
      );
      if (minClearanceSq < bestKnownSafetyScore) {
        return minClearanceSq;
      }
    }

    for (const bullet of this.bullets) {
      minClearanceSq = Math.min(
        minClearanceSq,
        clearanceSqQ12_4(bullet.x, bullet.y, bullet.radius, spawnX, spawnY, this.ship.radius),
      );
      if (minClearanceSq < bestKnownSafetyScore) {
        return minClearanceSq;
      }
    }

    for (const bullet of this.saucerBullets) {
      minClearanceSq = Math.min(
        minClearanceSq,
        clearanceSqQ12_4(bullet.x, bullet.y, bullet.radius, spawnX, spawnY, this.ship.radius),
      );
      if (minClearanceSq < bestKnownSafetyScore) {
        return minClearanceSq;
      }
    }

    return minClearanceSq;
  }

  private findBestShipSpawnPoint(): { x: number; y: number } {
    const { x: centerX, y: centerY } = this.getShipSpawnPoint();

    const minX = SHIP_RESPAWN_EDGE_PADDING_Q12_4;
    const maxX = WORLD_WIDTH_Q12_4 - SHIP_RESPAWN_EDGE_PADDING_Q12_4;
    const minY = SHIP_RESPAWN_EDGE_PADDING_Q12_4;
    const maxY = WORLD_HEIGHT_Q12_4 - SHIP_RESPAWN_EDGE_PADDING_Q12_4;

    let bestX = centerX;
    let bestY = centerY;
    let bestSafetyScore = Number.NEGATIVE_INFINITY;
    let bestCenterDistance = Number.MAX_SAFE_INTEGER;

    for (let y = minY; y <= maxY; y += SHIP_RESPAWN_GRID_STEP_Q12_4) {
      for (let x = minX; x <= maxX; x += SHIP_RESPAWN_GRID_STEP_Q12_4) {
        const safetyScore = this.spawnSafetyScore(x, y, bestSafetyScore);
        const centerDistance = collisionDistSqQ12_4(x, y, centerX, centerY);
        if (
          safetyScore > bestSafetyScore ||
          (safetyScore === bestSafetyScore && centerDistance < bestCenterDistance)
        ) {
          bestX = x;
          bestY = y;
          bestSafetyScore = safetyScore;
          bestCenterDistance = centerDistance;
        }
      }
    }

    return { x: bestX, y: bestY };
  }

  private spawnShipAtBestOpenPoint(): void {
    const { x: spawnX, y: spawnY } = this.findBestShipSpawnPoint();
    this.ship.x = spawnX;
    this.ship.y = spawnY;
    this.ship.prevX = spawnX;
    this.ship.prevY = spawnY;
    this.ship.vx = 0;
    this.ship.vy = 0;
    this.ship.angle = SHIP_FACING_UP_BAM;
    this.ship.prevAngle = SHIP_FACING_UP_BAM;
    this.ship.canControl = true;
    this.ship.invulnerableTimer = SHIP_SPAWN_INVULNERABLE_FRAMES;
  }

  private spawnWave(): void {
    this.wave += 1;
    this.timeSinceLastKill = 0;

    const largeCount = waveLargeAsteroidCount(this.wave);
    const { x: avoidX, y: avoidY } = this.getShipSpawnPoint();

    for (let i = 0; i < largeCount; i += 1) {
      let x = randomInt(0, WORLD_WIDTH_Q12_4);
      let y = randomInt(0, WORLD_HEIGHT_Q12_4);

      let guard = 0;

      while (guard < 20 && collisionDistSqQ12_4(x, y, avoidX, avoidY) < WAVE_SAFE_DIST_SQ_Q24_8) {
        x = randomInt(0, WORLD_WIDTH_Q12_4);
        y = randomInt(0, WORLD_HEIGHT_Q12_4);
        guard += 1;
      }

      this.asteroids.push(this.createAsteroid("large", x, y));
    }

    // Ship always respawns after delay using deterministic "most-open-area" selection.
    this.queueShipRespawn(0);
    this.spawnShipAtBestOpenPoint();
  }

  private createAsteroid(size: AsteroidSize, x: number, y: number): Asteroid {
    const [minQ8_8, maxQ8_8] = ASTEROID_SPEED_Q8_8[size];
    const moveAngle = randomInt(0, 256); // BAM
    let speed = randomInt(minQ8_8, maxQ8_8);
    // Wave speed multiplier: speed * (1 + min(0.5, (wave-1)*0.06))
    // Integer: speed + speed * min(128, (wave-1)*15) >> 8
    speed = speed + ((speed * Math.min(128, (this.wave - 1) * 15)) >> 8);
    const { vx, vy } = velocityQ8_8(moveAngle, speed);
    const vertices = this.renderer?.createAsteroidVertices() ?? [];
    const startAngle = randomInt(0, 256); // BAM
    // spin: +-3 BAM/frame (was +-0.7 rad/s -> +-0.7/60/(2pi/256) ~ +-0.47 -> +-1-3)
    const spin = randomInt(-3, 4);

    return {
      id: this.nextId++,
      x,
      y,
      vx,
      vy,
      angle: startAngle,
      alive: true,
      radius: ASTEROID_RADIUS_BY_SIZE[size],
      prevX: x,
      prevY: y,
      prevAngle: startAngle,
      size,
      spin,
      vertices,
    };
  }

  private updateShip(_dt: number): void {
    const ship = this.ship;
    const frameInput = this.currentFrameInput;
    const fire = frameInput.fire;

    if (ship.fireCooldown > 0) {
      ship.fireCooldown--;
    }

    if (!fire) {
      this.shipFireLatch = false;
    }

    if (!ship.canControl) {
      if (ship.respawnTimer > 0) {
        ship.respawnTimer--;
      }

      if (ship.respawnTimer <= 0) {
        this.spawnShipAtBestOpenPoint();
      }

      if (fire) {
        this.shipFireLatch = true;
      }

      return;
    }

    if (ship.invulnerableTimer > 0) {
      ship.invulnerableTimer--;
    }

    // Get input from the current frame input (already read+recorded in updateSimulation)
    const turnLeft = frameInput.left;
    const turnRight = frameInput.right;
    const thrust = frameInput.thrust;

    if (turnLeft) {
      ship.angle = (ship.angle - SHIP_TURN_SPEED_BAM) & 0xff;
    }

    if (turnRight) {
      ship.angle = (ship.angle + SHIP_TURN_SPEED_BAM) & 0xff;
    }

    if (thrust) {
      const accelVx = (cosBAM(ship.angle) * SHIP_THRUST_Q8_8) >> 14;
      const accelVy = (sinBAM(ship.angle) * SHIP_THRUST_Q8_8) >> 14;
      ship.vx += accelVx;
      ship.vy += accelVy;

      if (this.renderer) {
        // Thrust particles and sound (every 5 frames)
        this.thrustParticleTimer++;
        if (this.thrustParticleTimer >= 5) {
          this.renderer.onThrustFrame(ship);
          this.audio.playThrust();
          this.thrustParticleTimer = 0;
        }
      }
    }

    ship.vx = applyDrag(ship.vx);
    ship.vy = applyDrag(ship.vy);

    ({ vx: ship.vx, vy: ship.vy } = clampSpeedQ8_8(ship.vx, ship.vy, SHIP_MAX_SPEED_SQ_Q16_16));

    const firePressedThisFrame = fire && !this.shipFireLatch;
    if (firePressedThisFrame && ship.fireCooldown <= 0 && this.bullets.length < SHIP_BULLET_LIMIT) {
      this.spawnShipBullet();
      ship.fireCooldown = SHIP_BULLET_COOLDOWN_FRAMES;
    }

    if (fire) {
      this.shipFireLatch = true;
    }

    // Q8.8 velocity >> 4 -> Q12.4 displacement
    ship.x = wrapXQ12_4(ship.x + (ship.vx >> 4));
    ship.y = wrapYQ12_4(ship.y + (ship.vy >> 4));
  }

  /** Create a snapshot of game state for the autopilot AI (converts to float px/s) */
  private getGameStateSnapshot(): GameStateSnapshot {
    const toFloat = <
      T extends {
        x: number;
        y: number;
        vx: number;
        vy: number;
        angle: number;
        prevX: number;
        prevY: number;
        prevAngle: number;
      },
    >(
      e: T,
    ): T => ({
      ...e,
      x: fromQ12_4(e.x),
      y: fromQ12_4(e.y),
      vx: fromQ8_8(e.vx) * 60, // back to px/s for Autopilot
      vy: fromQ8_8(e.vy) * 60,
      angle: BAMToRadians(e.angle),
      prevX: fromQ12_4(e.prevX),
      prevY: fromQ12_4(e.prevY),
      prevAngle: BAMToRadians(e.prevAngle),
    });
    return {
      ship: toFloat(this.ship) as Ship,
      asteroids: this.asteroids.filter((a) => a.alive).map((a) => toFloat(a) as Asteroid),
      saucers: this.saucers.filter((s) => s.alive).map((s) => toFloat(s) as Saucer),
      bullets: this.bullets.filter((b) => b.alive).map((b) => toFloat(b) as Bullet),
      saucerBullets: this.saucerBullets.filter((b) => b.alive).map((b) => toFloat(b) as Bullet),
      wave: this.wave,
      lives: this.lives,
      timeSinceLastKill: this.timeSinceLastKill,
    };
  }

  private spawnShipBullet(): void {
    const ship = this.ship;
    const { dx, dy } = displaceQ12_4(ship.angle, ship.radius + 6);
    const startX = wrapXQ12_4(ship.x + dx);
    const startY = wrapYQ12_4(ship.y + dy);

    // Bullet speed = base + ship speed boost
    // Approximate ship speed magnitude: (|vx| + |vy|) * 3/4
    const shipSpeedApprox = ((Math.abs(ship.vx) + Math.abs(ship.vy)) * 3) >> 2;
    // 89/256 ~ 0.35
    const bulletSpeedQ8_8 = SHIP_BULLET_SPEED_Q8_8 + ((shipSpeedApprox * 89) >> 8);
    const { vx: bvx, vy: bvy } = velocityQ8_8(ship.angle, bulletSpeedQ8_8);

    const bullet: Bullet = {
      id: this.nextId++,
      x: startX,
      y: startY,
      vx: ship.vx + bvx,
      vy: ship.vy + bvy,
      angle: ship.angle,
      alive: true,
      radius: 2,
      prevX: startX,
      prevY: startY,
      prevAngle: ship.angle,
      life: SHIP_BULLET_LIFETIME_FRAMES,
      fromSaucer: false,
    };

    this.bullets.push(bullet);
    if (this.renderer) {
      this.audio.playShoot();
      const { dx: mfDx, dy: mfDy } = displaceQ12_4(ship.angle, ship.radius + 8);
      this.renderer.onBulletFired(fromQ12_4(ship.x + mfDx), fromQ12_4(ship.y + mfDy));
    }
  }

  private updateAsteroids(): void {
    for (const asteroid of this.asteroids) {
      asteroid.x = wrapXQ12_4(asteroid.x + (asteroid.vx >> 4));
      asteroid.y = wrapYQ12_4(asteroid.y + (asteroid.vy >> 4));
      asteroid.angle = (asteroid.angle + asteroid.spin) & 0xff;
    }
  }

  private updateBullets(): void {
    for (const bullet of this.bullets) {
      bullet.life--;

      if (bullet.life <= 0) {
        bullet.alive = false;
        continue;
      }

      bullet.x = wrapXQ12_4(bullet.x + (bullet.vx >> 4));
      bullet.y = wrapYQ12_4(bullet.y + (bullet.vy >> 4));
    }
  }

  private updateSaucerBullets(): void {
    for (const bullet of this.saucerBullets) {
      bullet.life--;

      if (bullet.life <= 0) {
        bullet.alive = false;
        continue;
      }

      bullet.x = wrapXQ12_4(bullet.x + (bullet.vx >> 4));
      bullet.y = wrapYQ12_4(bullet.y + (bullet.vy >> 4));
    }
  }

  private saucerWavePressurePct(): number {
    return clamp((this.wave - 1) * 8, 0, 100);
  }

  private saucerLurkPressurePct(): number {
    const over = Math.max(0, this.timeSinceLastKill - LURK_TIME_THRESHOLD_FRAMES);
    return clamp(Math.trunc((over * 100) / (LURK_TIME_THRESHOLD_FRAMES * 2)), 0, 100);
  }

  private saucerPressurePct(): number {
    const wavePressure = this.saucerWavePressurePct();
    const lurkPressure = this.saucerLurkPressurePct();
    return Math.min(100, wavePressure + Math.trunc((lurkPressure * 50) / 100));
  }

  private saucerFireCooldownRange(small: boolean): {
    min: number;
    max: number;
  } {
    const pressure = this.saucerPressurePct();
    const [baseMin, baseMax, floorMin, floorMax] = small ? [42, 68, 22, 40] : [66, 96, 36, 56];
    const min = baseMin - Math.trunc(((baseMin - floorMin) * pressure) / 100);
    const max = baseMax - Math.trunc(((baseMax - floorMax) * pressure) / 100);
    return max > min ? { min, max } : { min, max: min };
  }

  private getSmallSaucerAimErrorBAM(): number {
    const pressurePct = this.saucerPressurePct();
    const baseErrorBAM = 22;
    const minErrorBAM = 3;
    const errorRange = baseErrorBAM - minErrorBAM;
    return clamp(
      baseErrorBAM - (((errorRange * pressurePct) / 100) | 0),
      minErrorBAM,
      baseErrorBAM,
    );
  }

  private updateSaucers(): void {
    if (this.saucerSpawnTimer > 0) {
      this.saucerSpawnTimer--;
    }

    const isLurking = this.timeSinceLastKill > LURK_TIME_THRESHOLD_FRAMES;
    const spawnThreshold = isLurking ? LURK_SAUCER_SPAWN_FAST_FRAMES : 0;
    const maxSaucers = maxSaucersForWave(this.wave);
    if (this.saucers.length < maxSaucers && this.saucerSpawnTimer <= spawnThreshold) {
      this.spawnSaucer();
      const waveMultPct = Math.max(40, 100 - (this.wave - 1) * 8);
      const spawnMin = Math.trunc((SAUCER_SPAWN_MIN_FRAMES * waveMultPct) / 100);
      const spawnMax = Math.trunc((SAUCER_SPAWN_MAX_FRAMES * waveMultPct) / 100);
      this.saucerSpawnTimer = isLurking
        ? randomInt(LURK_SAUCER_SPAWN_FAST_FRAMES, LURK_SAUCER_SPAWN_FAST_FRAMES + 120)
        : randomInt(spawnMin, spawnMax);
    }

    for (let index = 0; index < this.saucers.length; index += 1) {
      const saucer = this.saucers[index];
      if (!saucer) continue;

      saucer.x = saucer.x + (saucer.vx >> 4);
      saucer.y = wrapYQ12_4(saucer.y + (saucer.vy >> 4));

      if (saucer.x < SAUCER_CULL_MIN_X_Q12_4 || saucer.x > SAUCER_CULL_MAX_X_Q12_4) {
        saucer.alive = false;
        continue;
      }

      if (saucer.driftTimer > 0) {
        saucer.driftTimer--;
      }
      if (saucer.driftTimer <= 0) {
        saucer.driftTimer = randomInt(48, 120);
        saucer.vy = randomInt(-163, 164);
      }

      if (saucer.fireCooldown > 0) {
        saucer.fireCooldown--;
      }

      if (saucer.fireCooldown <= 0) {
        this.spawnSaucerBullet(saucer);
        const { min, max } = this.saucerFireCooldownRange(saucer.small);
        saucer.fireCooldown = randomInt(min, max + 1);
      }
    }
  }

  private spawnSaucer(): void {
    const enterFromLeft = (getGameRng().next() & 1) === 0;
    const isLurking = this.timeSinceLastKill > LURK_TIME_THRESHOLD_FRAMES;
    const smallPct = isLurking ? 90 : this.score > 4000 ? 70 : 22;
    const small = getGameRng().next() % 100 < smallPct;
    const speedQ8_8 = small ? SAUCER_SPEED_SMALL_Q8_8 : SAUCER_SPEED_LARGE_Q8_8;

    const startX = enterFromLeft ? SAUCER_START_X_LEFT_Q12_4 : SAUCER_START_X_RIGHT_Q12_4;
    const startY = randomInt(SAUCER_START_Y_MIN_Q12_4, SAUCER_START_Y_MAX_Q12_4);
    const vy = randomInt(-94, 95);
    const { min: cooldownMin, max: cooldownMax } = this.saucerFireCooldownRange(small);
    const fireCooldown = randomInt(cooldownMin, cooldownMax + 1);
    const driftTimer = randomInt(48, 120);

    const saucer: Saucer = {
      id: this.nextId++,
      x: startX,
      y: startY,
      vx: enterFromLeft ? speedQ8_8 : -speedQ8_8,
      vy,
      angle: 0,
      alive: true,
      radius: small ? SAUCER_RADIUS_SMALL : SAUCER_RADIUS_LARGE,
      prevX: startX,
      prevY: startY,
      prevAngle: 0,
      small,
      fireCooldown,
      driftTimer,
    };

    this.saucers.push(saucer);
    if (this.renderer) {
      this.audio.playSaucer(small);
    }
  }

  private spawnSaucerBullet(saucer: Saucer): void {
    if (this.saucerBullets.length >= SAUCER_BULLET_LIMIT) {
      return;
    }

    let shotAngle: number;

    if (saucer.small) {
      // Aimed shot using atan2BAM
      const dx = shortestDeltaWorldXQ12_4(saucer.x, this.ship.x);
      const dy = shortestDeltaWorldYQ12_4(saucer.y, this.ship.y);
      const targetAngle = atan2BAM(dy, dx);
      const errorBAM = this.getSmallSaucerAimErrorBAM();
      shotAngle = (targetAngle + randomInt(-errorBAM, errorBAM + 1)) & 0xff;
    } else {
      // Random shot
      shotAngle = randomInt(0, 256);
    }

    const { vx, vy } = velocityQ8_8(shotAngle, SAUCER_BULLET_SPEED_Q8_8);
    const { dx: offDx, dy: offDy } = displaceQ12_4(shotAngle, saucer.radius + 4);
    const startX = wrapXQ12_4(saucer.x + offDx);
    const startY = wrapYQ12_4(saucer.y + offDy);

    const bullet: Bullet = {
      id: this.nextId++,
      x: startX,
      y: startY,
      vx,
      vy,
      angle: shotAngle,
      alive: true,
      radius: 2,
      prevX: startX,
      prevY: startY,
      prevAngle: shotAngle,
      life: SAUCER_BULLET_LIFETIME_FRAMES,
      fromSaucer: true,
    };

    this.saucerBullets.push(bullet);
  }

  private handleCollisions(): void {
    let aliveAsteroids = this.asteroids.length;

    // Bullet-asteroid collisions
    for (const bullet of this.bullets) {
      if (aliveAsteroids === 0) break;
      if (!bullet.alive) continue;

      for (const asteroid of this.asteroids) {
        if (!asteroid.alive) continue;

        if (
          collidesQ12_4(bullet.x, bullet.y, bullet.radius, asteroid.x, asteroid.y, asteroid.radius)
        ) {
          bullet.alive = false;
          aliveAsteroids = this.destroyAsteroid(asteroid, true, aliveAsteroids);
          break;
        }
      }
    }

    // Saucer bullet-asteroid collisions
    for (const bullet of this.saucerBullets) {
      if (aliveAsteroids === 0) break;
      if (!bullet.alive) continue;

      for (const asteroid of this.asteroids) {
        if (!asteroid.alive) continue;
        if (
          collidesQ12_4(bullet.x, bullet.y, bullet.radius, asteroid.x, asteroid.y, asteroid.radius)
        ) {
          bullet.alive = false;
          aliveAsteroids = this.destroyAsteroid(asteroid, false, aliveAsteroids);
          break;
        }
      }
    }

    // Player bullet-saucer collisions
    for (const bullet of this.bullets) {
      if (!bullet.alive) continue;

      for (const saucer of this.saucers) {
        if (!saucer.alive) continue;
        if (collidesQ12_4(bullet.x, bullet.y, bullet.radius, saucer.x, saucer.y, saucer.radius)) {
          bullet.alive = false;
          saucer.alive = false;
          const saucerScore = saucer.small ? SCORE_SMALL_SAUCER : SCORE_LARGE_SAUCER;
          this.addScore(saucerScore);
          if (this.renderer) {
            const sSize = saucer.small ? ("medium" as const) : ("large" as const);
            const sx = fromQ12_4(saucer.x);
            const sy = fromQ12_4(saucer.y);
            this.renderer.onExplosion(sx, sy, sSize);
            this.renderer.addScreenShake(
              saucer.small ? SHAKE_INTENSITY_MEDIUM : SHAKE_INTENSITY_LARGE,
            );
            this.audio.playExplosion(sSize);
            this.renderer.onScorePopup(sx, sy - 20, saucerScore);
          }
          break;
        }
      }
    }

    // Saucer-asteroid collisions (arcade-faithful: saucer is destroyed)
    if (aliveAsteroids > 0) {
      for (const saucer of this.saucers) {
        if (!saucer.alive) continue;

        for (const asteroid of this.asteroids) {
          if (!asteroid.alive) continue;
          if (
            collidesQ12_4(
              saucer.x,
              saucer.y,
              saucer.radius,
              asteroid.x,
              asteroid.y,
              asteroid.radius,
            )
          ) {
            saucer.alive = false;
            if (this.renderer) {
              const sSize = saucer.small ? ("medium" as const) : ("large" as const);
              this.renderer.onExplosion(fromQ12_4(saucer.x), fromQ12_4(saucer.y), sSize);
              this.renderer.addScreenShake(
                saucer.small ? SHAKE_INTENSITY_MEDIUM : SHAKE_INTENSITY_LARGE,
              );
              this.audio.playExplosion(sSize);
            }
            break;
          }
        }
      }
    }

    if (!this.ship.canControl || this.ship.invulnerableTimer > 0) {
      return;
    }

    const ship = this.ship;

    // Ship-asteroid collisions (fudge factor: radius * 0.88 -> (radius * 225) >> 8)
    if (aliveAsteroids > 0) {
      for (const asteroid of this.asteroids) {
        if (!asteroid.alive) continue;

        const adjustedRadius = (asteroid.radius * 225) >> 8;
        if (collidesQ12_4(ship.x, ship.y, ship.radius, asteroid.x, asteroid.y, adjustedRadius)) {
          this.destroyShip(asteroid.x, asteroid.y);
          return;
        }
      }
    }

    // Ship-saucer bullet collisions
    for (const bullet of this.saucerBullets) {
      if (!bullet.alive) continue;
      if (collidesQ12_4(ship.x, ship.y, ship.radius, bullet.x, bullet.y, bullet.radius)) {
        bullet.alive = false;
        this.destroyShip(bullet.x, bullet.y);
        return;
      }
    }

    // Ship-saucer collisions
    for (const saucer of this.saucers) {
      if (!saucer.alive) continue;
      if (collidesQ12_4(ship.x, ship.y, ship.radius, saucer.x, saucer.y, saucer.radius)) {
        saucer.alive = false;
        this.destroyShip(saucer.x, saucer.y);
        return;
      }
    }
  }

  private destroyAsteroid(asteroid: Asteroid, awardScore: boolean, aliveAsteroids: number): number {
    if (!asteroid.alive) {
      return aliveAsteroids;
    }

    asteroid.alive = false;
    aliveAsteroids = Math.max(0, aliveAsteroids - 1);

    if (awardScore) {
      this.timeSinceLastKill = 0;

      if (asteroid.size === "large") {
        this.addScore(SCORE_LARGE_ASTEROID);
      } else if (asteroid.size === "medium") {
        this.addScore(SCORE_MEDIUM_ASTEROID);
      } else {
        this.addScore(SCORE_SMALL_ASTEROID);
      }
    }

    if (this.renderer) {
      const px = fromQ12_4(asteroid.x);
      const py = fromQ12_4(asteroid.y);
      this.renderer.onAsteroidDestroyed(px, py, asteroid.size);
      this.renderer.addScreenShake(
        asteroid.size === "large"
          ? SHAKE_INTENSITY_MEDIUM
          : asteroid.size === "medium"
            ? SHAKE_INTENSITY_SMALL
            : SHAKE_INTENSITY_SMALL * 0.5,
      );
      this.audio.playExplosion(asteroid.size);
      if (awardScore) {
        const pts =
          asteroid.size === "large"
            ? SCORE_LARGE_ASTEROID
            : asteroid.size === "medium"
              ? SCORE_MEDIUM_ASTEROID
              : SCORE_SMALL_ASTEROID;
        this.renderer.onScorePopup(px, py - asteroid.radius, pts);
      }
    }

    if (asteroid.size === "small") {
      return aliveAsteroids;
    }

    const childSize: AsteroidSize = asteroid.size === "large" ? "medium" : "small";
    const freeSlots = Math.max(0, ASTEROID_CAP - aliveAsteroids);
    const splitCount = Math.min(2, freeSlots);

    for (let i = 0; i < splitCount; i += 1) {
      const child = this.createAsteroid(childSize, asteroid.x, asteroid.y);
      // Velocity inheritance: (vx * 46) >> 8 ~ 0.18
      child.vx += (asteroid.vx * 46) >> 8;
      child.vy += (asteroid.vy * 46) >> 8;
      this.asteroids.push(child);
      aliveAsteroids += 1;
    }

    return aliveAsteroids;
  }

  private destroyShip(impactorX?: number, impactorY?: number): void {
    const shipAngle = BAMToRadians(this.ship.angle);
    this.queueShipRespawn(SHIP_RESPAWN_FRAMES);
    this.lives -= 1;

    if (this.renderer) {
      const px = fromQ12_4(this.ship.x);
      const py = fromQ12_4(this.ship.y);
      this.renderer.onShipDestroyed(
        px,
        py,
        impactorX != null ? fromQ12_4(impactorX) : undefined,
        impactorY != null ? fromQ12_4(impactorY) : undefined,
        shipAngle,
      );
      this.renderer.addScreenShake(SHAKE_INTENSITY_LARGE);
      this.audio.playExplosion("large");
    }

    if (this.lives <= 0) {
      if (this.mode !== "replay") {
        this.mode = "game-over";
        this.audio.stopMusic();
      }
      this.ship.canControl = false;
      this.ship.respawnTimer = 99999;
      if (this.renderer) {
        this.saveHighScore();
      }
    }
  }

  private addScore(points: number): void {
    this.score += points;

    // Per rules, a single score event is always < EXTRA_LIFE_SCORE_STEP, so we can cross
    // at most one extra-life threshold per addScore call.
    if (this.score >= this.nextExtraLifeScore) {
      this.lives += 1;
      this.nextExtraLifeScore += EXTRA_LIFE_SCORE_STEP;
      if (this.renderer) {
        this.audio.playExtraLife();
        this.renderer.onExtraLife();
      }
    }

    if (this.score > this.highScore) {
      this.highScore = this.score;
    }
  }

  private pruneDestroyedEntities(): void {
    this.asteroids = this.asteroids.filter((entity) => entity.alive);
    this.bullets = this.bullets.filter((entity) => entity.alive);
    this.saucers = this.saucers.filter((entity) => entity.alive);
    this.saucerBullets = this.saucerBullets.filter((entity) => entity.alive);
    this.renderer?.pruneVisuals();
  }

  /** Build the render state snapshot for the renderer. */
  private buildRenderState(): GameRenderState {
    const autopilotHudEnabled =
      this.autopilot.isEnabled() ||
      (this.autopilotOnStart &&
        !this.replayPending &&
        this.replayTape === null &&
        this.mode !== "replay");

    return {
      ship: this.ship,
      asteroids: this.asteroids,
      bullets: this.bullets,
      saucerBullets: this.saucerBullets,
      saucers: this.saucers,
      mode: this.mode,
      score: this.score,
      highScore: this.highScore,
      wave: this.wave,
      lives: this.lives,
      gameSeed: this.gameSeed,
      waitingForSeed: this.waitingForSeed,
      pendingSeedSecondsLeft: this.pendingSeedSecondsLeft,
      gameTime: this.gameTime,
      thrustActive: this.currentFrameInput.thrust,
      autopilotEnabled: autopilotHudEnabled,
      endlessModeEnabled: this.endlessModeEnabled,
      endlessModeDetail: this.endlessModeDetail,
      replayInfo: this.replayTapeSource
        ? {
            currentFrame: this.replayTapeSource.getCurrentFrame(),
            totalFrames: this.replayTapeSource.getTotalFrames(),
            isComplete: this.replayTapeSource.isComplete(),
            speed: this.replaySpeed,
            paused: this.replayPaused,
          }
        : null,
      isReplaySession: this.replayTape !== null,
    };
  }

  // =========================================================================
  // Public API (for headless verification, replay, scripts)
  // =========================================================================

  /** Run one simulation step (storePreviousPositions + updateSimulation). */
  stepSimulation(): void {
    if (this.renderer) {
      this.storePreviousPositions();
    }
    this.updateSimulation(FIXED_TIMESTEP);
    this.gameTime += FIXED_TIMESTEP;
  }

  /** Replace the current input source. */
  setInputSource(source: InputSource): void {
    this.inputSource = source;
  }

  getScore(): number {
    return this.score;
  }
  getFrameCount(): number {
    return this.frameCount;
  }
  getRngState(): number {
    return getGameRngState();
  }
  getLives(): number {
    return this.lives;
  }
  getWave(): number {
    return this.wave;
  }
  getMode(): GameMode {
    return this.mode;
  }

  /** Toggle autopilot on/off (for mobile UI button). */
  toggleAutopilot(): void {
    if (this.mode === "playing") {
      this.setAutopilotEnabled(!this.autopilot.isEnabled());
    }
  }

  /** Keep autopilot armed for the current run and the next live game start. */
  setAutopilotOnStart(enabled: boolean): void {
    this.autopilotOnStart = enabled;
    if (enabled && (this.mode === "playing" || this.mode === "paused")) {
      this.setAutopilotEnabled(true);
    } else if (!enabled && this.mode !== "playing" && this.mode !== "paused") {
      this.setAutopilotEnabled(false, { notify: false });
    }
  }

  isAutopilotEnabled(): boolean {
    return this.autopilot.isEnabled();
  }
  clearBufferedInput(): void {
    this.input.clearPressed();
  }
  setEndlessHudState(enabled: boolean, detail: string | null): void {
    this.endlessModeEnabled = enabled;
    this.endlessModeDetail = detail;
  }
  setReplayPending(pending: boolean): void {
    this.replayPending = pending;
    if (pending) {
      this.setAutopilotEnabled(false, { notify: false });
    }
  }
  getReplaySessionState(): ReplaySessionState {
    return {
      active: this.replayTape !== null,
      paused: this.replayPaused,
      speed: this.normalizeReplaySpeed(this.replaySpeed),
    };
  }
  setReplaySpeed(speed: 1 | 2 | 4): void {
    if (this.mode !== "replay") {
      return;
    }
    this.replaySpeed = speed;
    this.accumulator = 0;
    this.emitReplayStateChange();
  }
  toggleReplayPause(): void {
    if (this.mode !== "replay") {
      return;
    }
    this.replayPaused = !this.replayPaused;
    // Reset timing to avoid accumulator jump after unpause
    this.lastTimeMs = 0;
    this.accumulator = 0;
    this.emitReplayStateChange();
  }
  exitReplay(): void {
    if (this.replayTape === null && !this.replayPending) {
      return;
    }
    this.resetToMenu();
  }
  getGameSeed(): number {
    return this.gameSeed;
  }

  /** Snapshot the current recorded run (no claimant binding). */
  getRunRecord(): GameRunRecord | null {
    // For replay sessions: keep the tape inputs, but report the score produced by
    // the local engine so replay UI stays aligned with verifier semantics.
    if (!this.recorder && this.replayTape) {
      return {
        seed: this.replayTape.header.seed,
        seedId: this.gameSeedId,
        inputs: this.replayTape.inputs,
        finalScore: this.score,
      };
    }

    if (!this.recorder) {
      return null;
    }

    return {
      seed: this.gameSeed,
      seedId: this.gameSeedId,
      inputs: this.recorder.getInputs(),
      finalScore: this.score,
    };
  }

  /** Build a serialized tape from the current recording. */
  getTape(): Uint8Array | null {
    if (!this.recorder) return null;
    return serializeTape(this.gameSeed, this.recorder.getInputs(), this.score);
  }

  // =========================================================================
  // Visual Replay
  // =========================================================================

  /** Load a tape and enter visual replay mode. */
  loadReplay(tapeData: Uint8Array): void {
    this.startReplayFromTape(deserializeTape(tapeData));
  }

  /** Restart the current replay from the beginning (tape must still be in memory). */
  restartReplay(): boolean {
    if (!this.replayTape) return false;
    this.startReplayFromTape(this.replayTape);
    return true;
  }

  private startReplayFromTape(tape: Tape): void {
    this.audio.enable();
    // Tape v4 does not encode seed_id; replays are visual-only and never claimed.
    this.startNewGame(tape.header.seed, 0);
    this.mode = "replay";
    this.replaySpeed = 1;
    this.replayPaused = false;
    this.lastTimeMs = 0;
    this.accumulator = 0;
    this.replayTape = tape;
    const tapeSource = new TapeInputSource(tape.inputs);
    this.replayTapeSource = tapeSource;
    this.inputSource = tapeSource;
    // Stop recording during replay
    this.recorder = null;
    this.emitReplayStateChange();
  }

  private canStartLiveRun(): boolean {
    return !this.replayPending && this.replayTape === null;
  }

  private normalizeReplaySpeed(speed: number): 1 | 2 | 4 {
    return speed === 2 || speed === 4 ? speed : 1;
  }

  private emitReplayStateChange(): void {
    this.onReplayStateChange?.(this.getReplaySessionState());
  }

  private setAutopilotEnabled(enabled: boolean, options?: { notify?: boolean }): void {
    this.autopilot.setEnabled(enabled);
    if (options?.notify !== false) {
      this.onAutopilotStateChange?.(this.autopilot.isEnabled());
    }
  }

  private resetToMenu(): void {
    const wasReplay = this.replayTape !== null;
    this.mode = "menu";
    this.audio.stopMusic();
    this.waitingForSeed = false;
    this.asteroids = [];
    this.bullets = [];
    this.saucers = [];
    this.saucerBullets = [];
    this.ship = this.createShip();
    this.shipFireLatch = false;
    this.renderer?.reset();
    this.setAutopilotEnabled(false, { notify: false });
    this.replayPending = false;
    this.replayTapeSource = null;
    this.replayTape = null;
    this.replaySpeed = 1;
    this.replayPaused = false;
    this.inputSource = null;
    if (wasReplay) {
      this.emitReplayStateChange();
    }
  }

  private downloadTape(): void {
    const tape = this.getTape();
    if (!tape) return;

    const seedHex = this.gameSeed.toString(16).padStart(8, "0");
    const filename = `asteroids-${seedHex}-${this.score}.tape`;

    const blob = new Blob([tape.buffer as ArrayBuffer], {
      type: "application/octet-stream",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  private triggerFileLoad(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".tape";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      document.body.removeChild(input);
      if (!file) return;
      void file.arrayBuffer().then((buf) => this.loadReplay(new Uint8Array(buf)));
    });
    document.body.appendChild(input);
    input.click();
  }

  private loadHighScore(): void {
    try {
      const value = window.localStorage.getItem(STORAGE_HIGH_SCORE_KEY);

      if (!value) {
        return;
      }

      const parsed = Number.parseInt(value, 10);

      if (Number.isFinite(parsed) && parsed > 0) {
        this.highScore = parsed;
      }
    } catch {
      // Ignore storage access issues.
    }
  }

  private saveHighScore(): void {
    try {
      if (this.score > this.highScore) {
        this.highScore = this.score;
      }

      window.localStorage.setItem(STORAGE_HIGH_SCORE_KEY, String(this.highScore));
    } catch {
      // Ignore storage write failures.
    }
  }
}
