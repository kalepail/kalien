import { MAX_DEBRIS, MAX_PARTICLES, SHAKE_DECAY, WORLD_HEIGHT, WORLD_WIDTH } from "./constants";
import { BAMToRadians, displaceQ12_4, fromQ12_4 } from "./fixed-point";
import { clamp, visualRandomInt, visualRandomRange, wrapX, wrapY } from "./math";
import type {
  Asteroid,
  AsteroidSize,
  Bullet,
  Debris,
  GameMode,
  Particle,
  Saucer,
  ScorePopup,
  Ship,
  Shockwave,
  Star,
} from "./types";

// ============================================================================
// Interpolation helpers
// ============================================================================

function lerpWrap(prev: number, curr: number, alpha: number, size: number): number {
  let delta = curr - prev;
  if (delta > size / 2) delta -= size;
  if (delta < -size / 2) delta += size;
  let result = prev + delta * alpha;
  if (result < 0) result += size;
  if (result >= size) result -= size;
  return result;
}

function lerpNoWrap(prev: number, curr: number, alpha: number): number {
  return prev + (curr - prev) * alpha;
}

function lerpAngle(prev: number, curr: number, alpha: number): number {
  let delta = curr - prev;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return prev + delta * alpha;
}

// ============================================================================
// Render state passed from game each frame
// ============================================================================

export interface GameRenderState {
  ship: Ship;
  asteroids: Asteroid[];
  bullets: Bullet[];
  saucerBullets: Bullet[];
  saucers: Saucer[];
  mode: GameMode;
  score: number;
  highScore: number;
  wave: number;
  lives: number;
  gameSeed: number;
  waitingForSeed: boolean;
  pendingSeedSecondsLeft: number;
  gameTime: number;
  thrustActive: boolean;
  autopilotEnabled: boolean;
  replayInfo: ReplayInfo | null;
}

export interface ReplayInfo {
  currentFrame: number;
  totalFrames: number;
  isComplete: boolean;
  speed: number;
  paused: boolean;
}

// ============================================================================
// GameRenderer — owns all visual-only state and draw methods
// ============================================================================

export class GameRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  private cssWidth = WORLD_WIDTH;
  private cssHeight = WORLD_HEIGHT;
  private dpr = 1;
  private viewScale = 1;
  private viewOffsetX = 0;
  private viewOffsetY = 0;

  // Visual-only arrays
  private stars: Star[] = [];
  private particles: Particle[] = [];
  private debris: Debris[] = [];
  private shockwaves: Shockwave[] = [];
  private scorePopups: ScorePopup[] = [];

  // Screen shake
  private shakeX = 0;
  private shakeY = 0;
  private shakeIntensity = 0;
  private shakeRotation = 0;

  // Unique ID counter (only for visual entities)
  private nextVisualId = 1_000_000;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      throw new Error("Unable to create 2D context.");
    }
    this.ctx = ctx;
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  resize(): void {
    const canvas = this.canvas;
    const ctx = this.ctx;

    const rect = canvas.getBoundingClientRect();
    const width = Math.max(320, rect.width || WORLD_WIDTH);
    const height = Math.max(320, rect.height || WORLD_HEIGHT);
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.cssWidth = width;
    this.cssHeight = height;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;

    this.viewScale = Math.min(width / WORLD_WIDTH, height / WORLD_HEIGHT);
    this.viewOffsetX = (width - WORLD_WIDTH * this.viewScale) * 0.5;
    this.viewOffsetY = (height - WORLD_HEIGHT * this.viewScale) * 0.5;
  }

  reset(): void {
    this.particles = [];
    this.debris = [];
    this.shockwaves = [];
    this.scorePopups = [];
    this.shakeIntensity = 0;
    this.shakeX = 0;
    this.shakeY = 0;
    this.shakeRotation = 0;
  }

  seedStars(count: number): void {
    this.stars.length = 0;
    for (let i = 0; i < count; i += 1) {
      const baseAlpha = visualRandomRange(0.2, 0.95);
      this.stars.push({
        x: visualRandomRange(0, WORLD_WIDTH),
        y: visualRandomRange(0, WORLD_HEIGHT),
        alpha: baseAlpha,
        baseAlpha,
        twinkleSpeed: visualRandomRange(0.8, 2.5),
        twinklePhase: visualRandomRange(0, Math.PI * 2),
      });
    }
  }

  createAsteroidVertices(): number[] {
    const vertexCount = visualRandomInt(9, 14);
    const vertices: number[] = [];
    for (let i = 0; i < vertexCount; i += 1) {
      vertices.push(visualRandomRange(0.72, 1.2));
    }
    return vertices;
  }

  // ============================================================================
  // Per-frame visual updates (called from game's updateSimulation)
  // ============================================================================

  updateVisuals(dt: number): void {
    this.updateParticles(dt);
    this.updateDebris(dt);
    this.updateShockwaves(dt);
    this.updateScorePopups(dt);
    this.updateScreenShake();
  }

  pruneVisuals(): void {
    this.particles = this.particles.filter((p) => p.life > 0).slice(-MAX_PARTICLES);
    this.debris = this.debris.filter((d) => d.life > 0).slice(-MAX_DEBRIS);
    this.shockwaves = this.shockwaves.filter((s) => s.life > 0);
    this.scorePopups = this.scorePopups.filter((p) => p.life > 0);
  }

  private updateParticles(dt: number): void {
    for (const particle of this.particles) {
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.vx *= 0.98;
      particle.vy *= 0.98;
      particle.life -= dt * particle.decay;
      particle.alpha = particle.life / particle.maxLife;
    }
  }

  private updateDebris(dt: number): void {
    for (const d of this.debris) {
      d.x = wrapX(d.x + d.vx * dt);
      d.y = wrapY(d.y + d.vy * dt);
      d.angle += d.spin * dt;
      d.life -= dt;
    }
  }

  private updateShockwaves(dt: number): void {
    for (const s of this.shockwaves) {
      s.life -= dt;
      const progress = 1 - s.life / s.maxLife;
      s.radius = s.maxRadius * progress;
    }
  }

  private updateScorePopups(dt: number): void {
    for (const p of this.scorePopups) {
      p.y += p.vy * dt;
      p.life -= dt;
    }
  }

  private updateScreenShake(): void {
    if (this.shakeIntensity > 0.1) {
      this.shakeX = (Math.random() - 0.5) * this.shakeIntensity * 2;
      this.shakeY = (Math.random() - 0.5) * this.shakeIntensity * 2;
      this.shakeRotation = (Math.random() - 0.5) * this.shakeIntensity * 0.02;
      this.shakeIntensity *= SHAKE_DECAY;
    } else {
      this.shakeX = 0;
      this.shakeY = 0;
      this.shakeRotation = 0;
      this.shakeIntensity = 0;
    }
  }

  // ============================================================================
  // Visual effect hooks (called by game on events)
  // ============================================================================

  addScreenShake(intensity: number): void {
    this.shakeIntensity = Math.max(this.shakeIntensity, intensity);
  }

  onExplosion(x: number, y: number, size: "small" | "medium" | "large"): void {
    const particleCount = size === "large" ? 25 : size === "medium" ? 15 : 8;
    const colors = ["#ff6b35", "#f7931e", "#ffd700", "#ffffff"];
    for (let i = 0; i < particleCount; i++) {
      this.spawnParticle(x, y, "spark", colors[visualRandomInt(0, colors.length)]);
    }
    this.spawnParticle(x, y, "smoke", "#555555", 5);

    // Shockwave ring
    const maxRadius = size === "large" ? 80 : size === "medium" ? 50 : 30;
    const life = size === "large" ? 0.5 : size === "medium" ? 0.35 : 0.25;
    const color = size === "large" ? "#ffd700" : size === "medium" ? "#f7931e" : "#ff6b35";
    this.shockwaves.push({
      x,
      y,
      radius: 0,
      maxRadius,
      life,
      maxLife: life,
      color,
      lineWidth: size === "large" ? 3 : 2,
    });
  }

  onScorePopup(x: number, y: number, points: number): void {
    this.scorePopups.push({
      text: `+${points}`,
      x,
      y,
      life: 1.0,
      maxLife: 1.0,
      vy: -50,
      color: points >= 200 ? "#ff6b6b" : points >= 100 ? "#ffd700" : "#b8ffe3",
    });
  }

  onShipDestroyed(x: number, y: number): void {
    this.onExplosion(x, y, "large");
    this.spawnDebris(x, y, "large");
  }

  onBulletFired(x: number, y: number): void {
    this.spawnParticle(x, y, "glow", "#a8ff60", 3);
  }

  onThrustFrame(ship: Ship): void {
    const { dx, dy } = displaceQ12_4((ship.angle + 128) & 0xff, ship.radius);
    const x = fromQ12_4(ship.x + dx);
    const y = fromQ12_4(ship.y + dy);
    this.spawnParticle(x, y, "spark", "#ffaa44", 2);
    this.spawnParticle(x, y, "smoke", "#666666", 1);
  }

  onExtraLife(): void {
    for (let i = 0; i < 20; i++) {
      this.spawnParticle(
        WORLD_WIDTH * 0.5 + visualRandomRange(-100, 100),
        WORLD_HEIGHT * 0.5 + visualRandomRange(-50, 50),
        "spark",
        "#ffd700",
      );
    }
  }

  onAsteroidDestroyed(x: number, y: number, size: AsteroidSize): void {
    this.onExplosion(x, y, size);
    this.spawnDebris(x, y, size);
  }

  // ============================================================================
  // Particle / debris spawning
  // ============================================================================

  private spawnParticle(
    x: number,
    y: number,
    type: Particle["type"],
    color: string,
    count = 1,
  ): void {
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= MAX_PARTICLES) break;

      const angle = visualRandomRange(0, Math.PI * 2);
      const speed = visualRandomRange(20, 120);
      const life = visualRandomRange(0.3, 0.8);

      this.particles.push({
        id: this.nextVisualId++,
        x: x + visualRandomRange(-5, 5),
        y: y + visualRandomRange(-5, 5),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life,
        maxLife: life,
        size: visualRandomRange(1, 3),
        color,
        alpha: 1,
        decay: visualRandomRange(0.8, 1.2),
        type,
      });
    }
  }

  private spawnDebris(x: number, y: number, size: AsteroidSize | "large"): void {
    const debrisCount = size === "large" ? 8 : size === "medium" ? 5 : 3;

    for (let i = 0; i < debrisCount; i++) {
      if (this.debris.length >= MAX_DEBRIS) break;

      const angle = visualRandomRange(0, Math.PI * 2);
      const speed = visualRandomRange(30, 90);
      const life = visualRandomRange(0.5, 1.2);
      const vertices: number[] = [];
      const vertexCount = visualRandomInt(4, 7);

      for (let j = 0; j < vertexCount; j++) {
        vertices.push(visualRandomRange(0.5, 1));
      }

      this.debris.push({
        id: this.nextVisualId++,
        x: x + visualRandomRange(-10, 10),
        y: y + visualRandomRange(-10, 10),
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        angle: visualRandomRange(0, Math.PI * 2),
        spin: visualRandomRange(-2, 2),
        life,
        maxLife: life,
        size: visualRandomRange(3, 8),
        vertices,
      });
    }
  }

  // ============================================================================
  // Main render entry point
  // ============================================================================

  render(state: GameRenderState, alpha: number): void {
    const ctx = this.ctx;

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);

    // Deep space background
    const gradient = ctx.createRadialGradient(
      this.cssWidth / 2,
      this.cssHeight / 2,
      0,
      this.cssWidth / 2,
      this.cssHeight / 2,
      Math.max(this.cssWidth, this.cssHeight),
    );
    gradient.addColorStop(0, "#0a0f1a");
    gradient.addColorStop(1, "#020408");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

    ctx.translate(this.viewOffsetX, this.viewOffsetY);
    ctx.scale(this.viewScale, this.viewScale);

    // Apply screen shake
    ctx.translate(this.shakeX, this.shakeY);
    ctx.rotate(this.shakeRotation);

    this.drawStars(ctx, state.gameTime);

    // Set up glow effect
    ctx.shadowBlur = 8;
    ctx.shadowColor = "#4ade80";
    ctx.strokeStyle = "#b8ffe3";
    ctx.fillStyle = "#b8ffe3";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    this.drawDebris(ctx);
    this.drawAsteroids(ctx, state.asteroids, alpha);
    this.drawShip(ctx, state, alpha);
    this.drawBullets(ctx, state.bullets, alpha);
    this.drawSaucers(ctx, state.saucers, alpha);
    this.drawBullets(ctx, state.saucerBullets, alpha);
    this.drawShockwaves(ctx);
    this.drawParticles(ctx);
    this.drawScorePopups(ctx);
    this.drawHud(ctx, state);

    // Reset shadow for overlay
    ctx.shadowBlur = 0;

    this.drawOverlay(ctx, state);
    ctx.restore();
  }

  // ============================================================================
  // Draw methods
  // ============================================================================

  private drawStars(ctx: CanvasRenderingContext2D, gameTime: number): void {
    for (const star of this.stars) {
      const twinkle = Math.sin(gameTime * star.twinkleSpeed + star.twinklePhase);
      const alpha = star.baseAlpha * (0.6 + twinkle * 0.4);
      ctx.globalAlpha = clamp(alpha, 0.1, 1);
      ctx.fillStyle = "#9fd4ff";
      ctx.fillRect(star.x, star.y, 1.4, 1.4);
    }
    ctx.globalAlpha = 1;
  }

  private drawShip(ctx: CanvasRenderingContext2D, state: GameRenderState, alpha: number): void {
    const ship = state.ship;

    if (!ship.canControl && (state.mode === "game-over" || state.lives <= 0)) {
      return;
    }

    if (ship.invulnerableTimer > 0 && Math.floor(ship.invulnerableTimer / 3) % 2 === 0) {
      return;
    }

    const renderX = lerpWrap(fromQ12_4(ship.prevX), fromQ12_4(ship.x), alpha, WORLD_WIDTH);
    const renderY = lerpWrap(fromQ12_4(ship.prevY), fromQ12_4(ship.y), alpha, WORLD_HEIGHT);
    const renderAngle = lerpAngle(BAMToRadians(ship.prevAngle), BAMToRadians(ship.angle), alpha);

    ctx.save();
    ctx.translate(renderX, renderY);
    ctx.rotate(renderAngle + Math.PI * 0.5);

    ctx.shadowBlur = 15;
    ctx.shadowColor = "#4ade80";

    ctx.beginPath();
    ctx.moveTo(0, -ship.radius);
    ctx.lineTo(ship.radius * 0.72, ship.radius);
    ctx.lineTo(0, ship.radius * 0.45);
    ctx.lineTo(-ship.radius * 0.72, ship.radius);
    ctx.closePath();
    ctx.stroke();

    if (ship.canControl && state.thrustActive && state.mode !== "menu") {
      ctx.shadowBlur = 20;
      ctx.shadowColor = "#ff6b35";
      ctx.strokeStyle = "#ffaa44";
      ctx.beginPath();
      const flame = 8 + Math.sin(Date.now() * 0.03) * 4;
      ctx.moveTo(-4, ship.radius * 0.9);
      ctx.lineTo(0, ship.radius + flame);
      ctx.lineTo(4, ship.radius * 0.9);
      ctx.stroke();
      ctx.strokeStyle = "#b8ffe3";
      ctx.shadowColor = "#4ade80";
    }

    ctx.restore();
  }

  private drawAsteroids(ctx: CanvasRenderingContext2D, asteroids: Asteroid[], alpha: number): void {
    ctx.shadowBlur = 10;
    ctx.shadowColor = "#6b7280";

    for (const asteroid of asteroids) {
      if (!asteroid.alive) continue;

      const vertices = asteroid.vertices;
      const vertexCount = vertices.length;

      const renderX = lerpWrap(
        fromQ12_4(asteroid.prevX),
        fromQ12_4(asteroid.x),
        alpha,
        WORLD_WIDTH,
      );
      const renderY = lerpWrap(
        fromQ12_4(asteroid.prevY),
        fromQ12_4(asteroid.y),
        alpha,
        WORLD_HEIGHT,
      );
      const renderAngle = lerpAngle(
        BAMToRadians(asteroid.prevAngle),
        BAMToRadians(asteroid.angle),
        alpha,
      );

      ctx.save();
      ctx.translate(renderX, renderY);
      ctx.rotate(renderAngle);
      ctx.beginPath();

      for (let i = 0; i < vertexCount; i += 1) {
        const angle = (i / vertexCount) * Math.PI * 2;
        const radius = asteroid.radius * vertices[i];
        const x = Math.cos(angle) * radius;
        const y = Math.sin(angle) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.closePath();

      // Dark fill for visual mass
      ctx.fillStyle = "rgba(15, 25, 35, 0.7)";
      ctx.fill();
      ctx.stroke();

      // Internal crack lines (seeded from vertex data for determinism)
      ctx.strokeStyle = "rgba(184, 255, 227, 0.15)";
      ctx.lineWidth = 1;
      const crackCount = vertexCount >= 12 ? 3 : 2;
      for (let c = 0; c < crackCount; c++) {
        const fromIdx = Math.floor(vertices[c] * vertexCount) % vertexCount;
        const fromAngle = (fromIdx / vertexCount) * Math.PI * 2;
        const fromR = asteroid.radius * vertices[fromIdx] * 0.9;
        const toAngle = fromAngle + Math.PI * (0.6 + vertices[(c + 1) % vertexCount] * 0.8);
        const toR =
          asteroid.radius * vertices[(fromIdx + Math.floor(vertexCount / 2)) % vertexCount] * 0.7;
        ctx.beginPath();
        ctx.moveTo(Math.cos(fromAngle) * fromR, Math.sin(fromAngle) * fromR);
        ctx.lineTo(Math.cos(toAngle) * toR, Math.sin(toAngle) * toR);
        ctx.stroke();
      }

      // Reset stroke for next asteroid
      ctx.strokeStyle = "#b8ffe3";
      ctx.lineWidth = 2;

      ctx.restore();
    }

    ctx.shadowColor = "#4ade80";
    ctx.shadowBlur = 8;
  }

  private drawBullets(ctx: CanvasRenderingContext2D, bullets: Bullet[], alpha: number): void {
    ctx.shadowBlur = 12;
    ctx.shadowColor = "#fbbf24";

    for (const bullet of bullets) {
      if (!bullet.alive) continue;

      const renderX = lerpWrap(fromQ12_4(bullet.prevX), fromQ12_4(bullet.x), alpha, WORLD_WIDTH);
      const renderY = lerpWrap(fromQ12_4(bullet.prevY), fromQ12_4(bullet.y), alpha, WORLD_HEIGHT);

      // Trail: 3 fading afterimages behind the bullet
      const dx = fromQ12_4(bullet.x) - fromQ12_4(bullet.prevX);
      const dy = fromQ12_4(bullet.y) - fromQ12_4(bullet.prevY);
      // Only draw trail if not wrapping (avoid long streaks across screen)
      const wrapThreshold = WORLD_WIDTH * 0.3;
      if (Math.abs(dx) < wrapThreshold && Math.abs(dy) < wrapThreshold) {
        for (let t = 1; t <= 3; t++) {
          const trailAlpha = 0.3 - t * 0.08;
          ctx.globalAlpha = trailAlpha;
          ctx.fillStyle = "#fbbf24";
          const tx = renderX - dx * t * 0.35;
          const ty = renderY - dy * t * 0.35;
          const sz = 2.4 - t * 0.4;
          ctx.fillRect(tx - sz * 0.5, ty - sz * 0.5, sz, sz);
        }
        ctx.globalAlpha = 1;
      }

      // Main bullet
      ctx.fillStyle = "#fef3c7";
      ctx.fillRect(renderX - 1.2, renderY - 1.2, 2.4, 2.4);
    }

    ctx.shadowColor = "#4ade80";
    ctx.shadowBlur = 8;
  }

  private drawSaucers(ctx: CanvasRenderingContext2D, saucers: Saucer[], alpha: number): void {
    for (const saucer of saucers) {
      if (!saucer.alive) continue;

      const w = saucer.small ? 22 : 30;
      const h = saucer.small ? 9 : 12;
      const glowColor = saucer.small ? "#ff1f1f" : "#f59e0b";
      const strokeColor = saucer.small ? "#ff6b6b" : "#ffd39b";

      const renderX = lerpNoWrap(fromQ12_4(saucer.prevX), fromQ12_4(saucer.x), alpha);
      const renderY = lerpWrap(fromQ12_4(saucer.prevY), fromQ12_4(saucer.y), alpha, WORLD_HEIGHT);

      ctx.save();
      ctx.translate(renderX, renderY);
      ctx.strokeStyle = strokeColor;
      ctx.shadowBlur = saucer.small ? 18 : 14;
      ctx.shadowColor = glowColor;

      ctx.beginPath();
      ctx.ellipse(0, 0, w * 0.6, h * 0.45, 0, 0, Math.PI * 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(-w * 0.5, 0);
      ctx.lineTo(-w * 0.28, -h * 0.55);
      ctx.lineTo(w * 0.28, -h * 0.55);
      ctx.lineTo(w * 0.5, 0);
      ctx.stroke();
      ctx.restore();
    }

    ctx.shadowColor = "#4ade80";
    ctx.shadowBlur = 8;
  }

  private drawParticles(ctx: CanvasRenderingContext2D): void {
    for (const particle of this.particles) {
      if (particle.life <= 0) continue;

      ctx.globalAlpha = particle.alpha;
      ctx.fillStyle = particle.color;

      if (particle.type === "glow") {
        ctx.shadowBlur = particle.size * 3;
        ctx.shadowColor = particle.color;
      } else {
        ctx.shadowBlur = 0;
      }

      ctx.fillRect(
        particle.x - particle.size * 0.5,
        particle.y - particle.size * 0.5,
        particle.size,
        particle.size,
      );
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 8;
    ctx.shadowColor = "#4ade80";
  }

  private drawDebris(ctx: CanvasRenderingContext2D): void {
    ctx.shadowBlur = 5;
    ctx.shadowColor = "#6b7280";

    for (const d of this.debris) {
      if (d.life <= 0) continue;

      ctx.globalAlpha = d.life / d.maxLife;
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.angle);

      ctx.beginPath();
      const vertexCount = d.vertices.length;
      for (let i = 0; i < vertexCount; i++) {
        const angle = (i / vertexCount) * Math.PI * 2;
        const r = d.size * d.vertices[i];
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 8;
    ctx.shadowColor = "#4ade80";
  }

  private drawShockwaves(ctx: CanvasRenderingContext2D): void {
    for (const s of this.shockwaves) {
      if (s.life <= 0) continue;
      const alpha = s.life / s.maxLife;
      ctx.globalAlpha = alpha * 0.6;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.lineWidth * alpha;
      ctx.shadowBlur = 15;
      ctx.shadowColor = s.color;
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.radius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = "#b8ffe3";
    ctx.lineWidth = 2;
    ctx.shadowBlur = 8;
    ctx.shadowColor = "#4ade80";
  }

  private drawScorePopups(ctx: CanvasRenderingContext2D): void {
    ctx.shadowBlur = 0;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 16px 'Monaspace Neon', 'Monaspace Krypton', monospace";

    for (const p of this.scorePopups) {
      if (p.life <= 0) continue;
      ctx.globalAlpha = p.life / p.maxLife;
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, p.x, p.y);
    }

    ctx.globalAlpha = 1;
    ctx.textAlign = "start";
    ctx.shadowBlur = 8;
    ctx.shadowColor = "#4ade80";
  }

  // ============================================================================
  // HUD & overlays
  // ============================================================================

  private drawHud(ctx: CanvasRenderingContext2D, state: GameRenderState): void {
    ctx.save();
    ctx.shadowBlur = 10;
    ctx.shadowColor = "#4ade80";
    ctx.fillStyle = "#d6fff0";
    ctx.font = "600 20px 'Monaspace Neon', 'Monaspace Krypton', monospace";
    ctx.textBaseline = "top";

    const scoreLabel = `SCORE ${state.score.toString().padStart(5, "0")}`;
    const highLabel = `HIGH ${state.highScore.toString().padStart(5, "0")}`;
    const waveLabel = `WAVE ${Math.max(1, state.wave)}`;

    ctx.fillText(scoreLabel, 20, 18);
    ctx.fillText(highLabel, WORLD_WIDTH - 230, 18);
    ctx.fillText(waveLabel, WORLD_WIDTH - 145, WORLD_HEIGHT - 40);

    ctx.font = "500 12px 'Monaspace Krypton', monospace";
    ctx.fillStyle = "#6b7280";
    ctx.fillText(`SEED 0x${state.gameSeed.toString(16).toUpperCase().padStart(8, "0")}`, 20, 44);

    this.drawShipLives(ctx, 20, WORLD_HEIGHT - 45, state.lives);

    if (state.autopilotEnabled) {
      ctx.save();
      ctx.font = "600 16px 'Monaspace Neon', 'Monaspace Krypton', monospace";
      ctx.shadowBlur = 15;
      ctx.shadowColor = "#22d3ee";
      ctx.fillStyle = "#22d3ee";
      const pulse = 0.7 + Math.sin(state.gameTime * 4) * 0.3;
      ctx.globalAlpha = pulse;
      ctx.fillText("AUTOPILOT", WORLD_WIDTH / 2 - 50, 18);
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    ctx.restore();
  }

  private drawShipLives(
    ctx: CanvasRenderingContext2D,
    startX: number,
    startY: number,
    count: number,
  ): void {
    const shipSize = 10;
    const spacing = 22;
    const maxDisplay = Math.min(count, 10);

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#d6fff0";

    for (let i = 0; i < maxDisplay; i++) {
      const x = startX + i * spacing + shipSize;
      const y = startY;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(0);

      ctx.beginPath();
      ctx.moveTo(0, -shipSize);
      ctx.lineTo(shipSize * 0.72, shipSize);
      ctx.lineTo(0, shipSize * 0.45);
      ctx.lineTo(-shipSize * 0.72, shipSize);
      ctx.closePath();
      ctx.stroke();

      ctx.restore();
    }

    if (count > 10) {
      ctx.font = "500 14px 'Monaspace Krypton', monospace";
      ctx.fillStyle = "#d6fff0";
      ctx.fillText(`+${count - 10}`, startX + maxDisplay * spacing + 5, startY - 5);
    }

    ctx.restore();
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, state: GameRenderState): void {
    if (state.mode === "playing") {
      return;
    }

    if (state.mode === "replay") {
      this.drawReplayOverlay(ctx, state);
      return;
    }

    ctx.save();

    // Vignette effect
    const gradient = ctx.createRadialGradient(
      WORLD_WIDTH / 2,
      WORLD_HEIGHT / 2,
      WORLD_HEIGHT * 0.3,
      WORLD_WIDTH / 2,
      WORLD_HEIGHT / 2,
      WORLD_HEIGHT * 0.8,
    );
    gradient.addColorStop(0, "rgba(0, 8, 14, 0.6)");
    gradient.addColorStop(1, "rgba(0, 8, 14, 0.9)");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

    ctx.shadowBlur = 20;
    ctx.shadowColor = "#4ade80";
    ctx.fillStyle = "#d6fff0";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "700 56px 'Monaspace Neon', 'Monaspace Krypton', monospace";

    if (state.mode === "menu") {
      const pulse = 1 + Math.sin(Date.now() * 0.003) * 0.05;
      ctx.save();
      ctx.translate(WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.34);
      ctx.scale(pulse, pulse);
      ctx.fillText("ASTEROIDS", 0, 0);
      ctx.restore();

      if (state.waitingForSeed) {
        const boxX = WORLD_WIDTH * 0.5;
        const boxY = WORLD_HEIGHT * 0.56;
        const boxW = 430;
        const boxH = 120;
        const dots = ".".repeat((Math.floor(state.gameTime * 2) % 3) + 1);
        const minutes = Math.floor(state.pendingSeedSecondsLeft / 60);
        const seconds = String(state.pendingSeedSecondsLeft % 60).padStart(2, "0");

        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(5, 17, 25, 0.9)";
        ctx.fillRect(boxX - boxW / 2, boxY - boxH / 2, boxW, boxH);
        ctx.strokeStyle = "rgba(82, 255, 191, 0.45)";
        ctx.lineWidth = 2;
        ctx.strokeRect(boxX - boxW / 2, boxY - boxH / 2, boxW, boxH);

        ctx.shadowBlur = 10;
        ctx.shadowColor = "#4ade80";
        ctx.fillStyle = "#d6fff0";
        ctx.font = "700 24px 'Monaspace Krypton', 'SFMono-Regular', monospace";
        ctx.fillText(`LOADING${dots}`, boxX, boxY - 20);

        ctx.shadowBlur = 0;
        ctx.fillStyle = "rgba(157, 224, 255, 0.85)";
        ctx.font = "600 18px 'Monaspace Krypton', 'SFMono-Regular', monospace";
        ctx.fillText("Generating current epoch seed", boxX, boxY + 10);

        ctx.fillStyle = "rgba(157, 224, 255, 0.65)";
        ctx.font = "500 16px 'Monaspace Krypton', 'SFMono-Regular', monospace";
        ctx.fillText(`next window in ${minutes}:${seconds}`, boxX, boxY + 36);
      } else {
        ctx.font = "600 24px 'Monaspace Krypton', 'SFMono-Regular', monospace";
        ctx.fillText("Arrow Keys: Turn + Thrust", WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.44);
        ctx.fillText("Space: Fire", WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.5);
        ctx.fillText(
          "Controller: Stick/D-Pad Turn  LT/LB Thrust  A/RT Fire",
          WORLD_WIDTH * 0.5,
          WORLD_HEIGHT * 0.56,
        );
        ctx.fillText("P: Pause  R: Restart", WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.62);

        ctx.shadowColor = "#22d3ee";
        ctx.fillStyle = "#22d3ee";
        ctx.fillText("A: Toggle Autopilot", WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.68);

        ctx.shadowColor = "#a855f7";
        ctx.fillStyle = "#a855f7";
        ctx.fillText("L: Load Replay Tape", WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.74);

        ctx.shadowBlur = 10;
        ctx.shadowColor = "#4ade80";
        ctx.fillStyle = "#4ade80";
        ctx.fillText(
          "Press Enter / Start or Tap to Launch",
          WORLD_WIDTH * 0.5,
          WORLD_HEIGHT * 0.82,
        );
      }
    }

    if (state.mode === "paused") {
      ctx.fillText("PAUSED", WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.45);
      ctx.font = "600 24px 'Monaspace Krypton', 'SFMono-Regular', monospace";
      ctx.fillText(
        "Press P / Enter / Start or Tap to Resume",
        WORLD_WIDTH * 0.5,
        WORLD_HEIGHT * 0.66,
      );
    }

    if (state.mode === "game-over") {
      ctx.shadowColor = "#ef4444";
      ctx.fillStyle = "#ff6b6b";
      ctx.fillText("GAME OVER", WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.42);
      ctx.font = "600 28px 'Monaspace Krypton', 'SFMono-Regular', monospace";
      ctx.fillStyle = "#d6fff0";
      ctx.fillText(
        `Final Score: ${state.score.toString().padStart(5, "0")}`,
        WORLD_WIDTH * 0.5,
        WORLD_HEIGHT * 0.56,
      );
      ctx.fillText(
        "Press Enter, R, Start, or Tap to Restart",
        WORLD_WIDTH * 0.5,
        WORLD_HEIGHT * 0.64,
      );

      ctx.shadowColor = "#a855f7";
      ctx.fillStyle = "#a855f7";
      ctx.font = "600 24px 'Monaspace Krypton', 'SFMono-Regular', monospace";
      ctx.fillText("D: Save Replay Tape", WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.72);
    }

    ctx.restore();
  }

  private drawReplayOverlay(ctx: CanvasRenderingContext2D, state: GameRenderState): void {
    const info = state.replayInfo;
    if (!info) return;

    if (info.isComplete) {
      ctx.save();

      const gradient = ctx.createRadialGradient(
        WORLD_WIDTH / 2,
        WORLD_HEIGHT / 2,
        WORLD_HEIGHT * 0.3,
        WORLD_WIDTH / 2,
        WORLD_HEIGHT / 2,
        WORLD_HEIGHT * 0.8,
      );
      gradient.addColorStop(0, "rgba(0, 8, 14, 0.6)");
      gradient.addColorStop(1, "rgba(0, 8, 14, 0.9)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT);

      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      ctx.font = "700 40px 'Monaspace Neon', 'Monaspace Krypton', monospace";
      ctx.shadowBlur = 20;
      ctx.shadowColor = "#a855f7";
      ctx.fillStyle = "#a855f7";
      ctx.fillText("REPLAY COMPLETE", WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.38);

      ctx.font = "600 28px 'Monaspace Krypton', 'SFMono-Regular', monospace";
      ctx.shadowBlur = 0;
      ctx.fillStyle = "#d6fff0";
      ctx.fillText(
        `Final Score: ${state.score.toString().padStart(5, "0")}`,
        WORLD_WIDTH * 0.5,
        WORLD_HEIGHT * 0.5,
      );
      ctx.fillText(`Wave: ${state.wave}`, WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.57);

      ctx.font = "500 14px 'Monaspace Krypton', monospace";
      ctx.fillStyle = "#6b7280";
      ctx.fillText(
        `Seed: 0x${state.gameSeed.toString(16).toUpperCase().padStart(8, "0")}`,
        WORLD_WIDTH * 0.5,
        WORLD_HEIGHT * 0.64,
      );

      ctx.font = "600 22px 'Monaspace Krypton', 'SFMono-Regular', monospace";
      ctx.fillStyle = "#4ade80";
      ctx.shadowBlur = 10;
      ctx.shadowColor = "#4ade80";
      ctx.fillText("Press Esc / View to Exit", WORLD_WIDTH * 0.5, WORLD_HEIGHT * 0.76);

      ctx.restore();
      return;
    }

    ctx.save();

    ctx.font = "600 18px 'Monaspace Neon', 'Monaspace Krypton', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.shadowBlur = 15;
    ctx.shadowColor = "#a855f7";
    ctx.fillStyle = "#a855f7";
    const pulse = 0.7 + Math.sin(state.gameTime * 4) * 0.3;
    ctx.globalAlpha = pulse;
    ctx.fillText("REPLAY", WORLD_WIDTH / 2, 18);
    ctx.globalAlpha = 1;

    ctx.font = "500 14px 'Monaspace Krypton', monospace";
    ctx.fillStyle = "#d6fff0";
    ctx.shadowBlur = 0;
    ctx.fillText(`Frame ${info.currentFrame} / ${info.totalFrames}`, WORLD_WIDTH / 2, 42);

    const speedLabel = info.paused ? "PAUSED" : `${info.speed}x`;
    ctx.fillText(speedLabel, WORLD_WIDTH / 2, 60);

    // Progress bar
    const barY = WORLD_HEIGHT - 10;
    const barH = 4;
    const progress = info.totalFrames > 0 ? info.currentFrame / info.totalFrames : 0;

    ctx.fillStyle = "#333";
    ctx.fillRect(20, barY, WORLD_WIDTH - 40, barH);

    ctx.fillStyle = "#a855f7";
    ctx.fillRect(20, barY, (WORLD_WIDTH - 40) * progress, barH);

    ctx.font = "500 12px 'Monaspace Krypton', monospace";
    ctx.fillStyle = "#6b7280";
    ctx.textAlign = "center";
    ctx.fillText(
      "Controller: X=1x  Y=2x  B=4x  A/Start=Pause  View=Exit",
      WORLD_WIDTH / 2,
      WORLD_HEIGHT - 34,
    );
    ctx.fillText("1/2/4: Speed    Space: Pause    Esc: Exit", WORLD_WIDTH / 2, WORLD_HEIGHT - 20);

    ctx.restore();
  }
}
