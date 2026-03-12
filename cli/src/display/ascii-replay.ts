import { WORLD_WIDTH, WORLD_HEIGHT } from "../../../src/game/constants";
import type { GameStateSnapshot } from "../../../src/game/Autopilot";
import type { AsteroidSize } from "../../../src/game/types";
import * as ansi from "./ansi";

// ============================================================================
// Types
// ============================================================================

export interface ReplayHUD {
  score: number;
  wave: number;
  lives: number;
  frame: number;
  totalFrames: number;
  speed: number; // 1, 2, or 4
  paused: boolean;
}

interface TermExplosion {
  col: number;
  row: number;
  ttl: number; // display frames remaining
  maxTtl: number;
}

/** Persisted state across frames for effects that span multiple display frames */
export interface ReplayState {
  prevAsteroidPos: Map<number, { col: number; row: number; size: AsteroidSize }>;
  prevSaucerPos: Map<number, { col: number; row: number; small: boolean }>;
  explosions: TermExplosion[];
  stars: { col: number; row: number; ch: string }[];
  gridCols: number;
  gridRows: number;
}

export function createReplayState(): ReplayState {
  return {
    prevAsteroidPos: new Map(),
    prevSaucerPos: new Map(),
    explosions: [],
    stars: [],
    gridCols: 0,
    gridRows: 0,
  };
}

// ============================================================================
// Coordinate helpers
// ============================================================================

function worldToTerm(
  wx: number,
  wy: number,
  cols: number,
  rows: number,
): { col: number; row: number } {
  return {
    col: Math.max(0, Math.min(cols - 1, Math.round((wx / WORLD_WIDTH) * (cols - 1)))),
    row: Math.max(0, Math.min(rows - 1, Math.round((wy / WORLD_HEIGHT) * (rows - 1)))),
  };
}

/** Simple deterministic PRNG for starfield generation */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// Ship direction (8-way)
// ============================================================================

function shipChar(angle: number): string {
  const a = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const s = Math.PI / 8;
  if (a < s || a >= 15 * s) return "\u25b6"; // ▶ right
  if (a < 3 * s) return "\u25e2"; // ◢ down-right
  if (a < 5 * s) return "\u25bc"; // ▼ down
  if (a < 7 * s) return "\u25e3"; // ◣ down-left
  if (a < 9 * s) return "\u25c0"; // ◀ left
  if (a < 11 * s) return "\u25e4"; // ◤ up-left
  if (a < 13 * s) return "\u25b2"; // ▲ up
  return "\u25e5"; // ◥ up-right
}

// ============================================================================
// Grid painting helpers
// ============================================================================

function paintCell(
  grid: string[][],
  colorGrid: string[][],
  row: number,
  col: number,
  ch: string,
  fg: string,
  cols: number,
  rows: number,
): void {
  if (row >= 0 && row < rows && col >= 0 && col < cols) {
    grid[row][col] = ch;
    colorGrid[row][col] = fg;
  }
}

/** Paint a filled ellipse of block characters */
function paintAsteroid(
  grid: string[][],
  colorGrid: string[][],
  centerCol: number,
  centerRow: number,
  size: AsteroidSize,
  cols: number,
  rows: number,
): void {
  const pxPerCol = WORLD_WIDTH / cols;
  const pxPerRow = WORLD_HEIGHT / rows;
  const worldRadius = size === "large" ? 48 : size === "medium" ? 28 : 16;

  const rCol = Math.max(1, Math.round(worldRadius / pxPerCol));
  const rRow = Math.max(1, Math.round(worldRadius / pxPerRow));

  if (rCol <= 1 && rRow <= 1) {
    paintCell(grid, colorGrid, centerRow, centerCol, "\u25c6", ansi.white, cols, rows); // ◆
    return;
  }

  const fg = size === "large" ? ansi.brightWhite : size === "medium" ? ansi.white : ansi.gray;

  for (let dr = -rRow; dr <= rRow; dr++) {
    for (let dc = -rCol; dc <= rCol; dc++) {
      const nx = dc / (rCol + 0.3);
      const ny = dr / (rRow + 0.3);
      const d2 = nx * nx + ny * ny;
      if (d2 <= 1.0) {
        const dist = Math.sqrt(d2);
        const ch = dist < 0.35 ? "\u2588" : dist < 0.65 ? "\u2593" : "\u2591"; // █ ▓ ░
        paintCell(grid, colorGrid, centerRow + dr, centerCol + dc, ch, fg, cols, rows);
      }
    }
  }
}

/** Paint an explosion effect (expanding ring that fades) */
function paintExplosion(
  grid: string[][],
  colorGrid: string[][],
  col: number,
  row: number,
  ttl: number,
  maxTtl: number,
  cols: number,
  rows: number,
): void {
  const progress = 1 - ttl / maxTtl; // 0→1 as explosion ages

  if (progress < 0.3) {
    // Phase 1: bright center burst
    paintCell(grid, colorGrid, row, col, "#", ansi.brightYellow, cols, rows);
    for (const [dr, dc] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ]) {
      paintCell(grid, colorGrid, row + dr, col + dc, "*", ansi.yellow, cols, rows);
    }
  } else if (progress < 0.6) {
    // Phase 2: expanding ring
    const r = 2;
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        const manhattan = Math.abs(dr) + Math.abs(dc);
        if (manhattan >= r - 1 && manhattan <= r) {
          paintCell(grid, colorGrid, row + dr, col + dc, "+", ansi.yellow, cols, rows);
        }
      }
    }
    paintCell(grid, colorGrid, row, col, "*", ansi.brightYellow, cols, rows);
  } else {
    // Phase 3: fading embers
    const r = 3;
    for (let dr = -r; dr <= r; dr++) {
      for (let dc = -r; dc <= r; dc++) {
        const manhattan = Math.abs(dr) + Math.abs(dc);
        if (manhattan === r || manhattan === r - 1) {
          const er = row + dr;
          const ec = col + dc;
          if (er >= 0 && er < rows && ec >= 0 && ec < cols) {
            // Only paint on empty cells
            if (grid[er][ec] === " " || grid[er][ec] === "\u00b7") {
              grid[er][ec] = "\u00b7"; // ·
              colorGrid[er][ec] = ansi.red;
            }
          }
        }
      }
    }
  }
}

// ============================================================================
// Starfield
// ============================================================================

function generateStars(cols: number, rows: number): { col: number; row: number; ch: string }[] {
  const stars: { col: number; row: number; ch: string }[] = [];
  const count = Math.floor(cols * rows * 0.012); // ~1.2% fill
  const rng = mulberry32(42);

  for (let i = 0; i < count; i++) {
    const col = Math.floor(rng() * cols);
    const row = Math.floor(rng() * rows);
    const brightness = rng();
    const ch = brightness > 0.85 ? "+" : brightness > 0.5 ? "\u00b7" : "."; // + · .
    stars.push({ col, row, ch });
  }
  return stars;
}

// ============================================================================
// Main render function
// ============================================================================

export function renderAsciiFrame(
  snapshot: GameStateSnapshot,
  hud: ReplayHUD,
  state: ReplayState,
): string {
  const cols = Math.min(process.stdout.columns || 80, 160);
  const rows = Math.min((process.stdout.rows || 24) - 5, 50); // reserve for HUD + borders + footer

  // Regenerate stars if grid size changed
  if (cols !== state.gridCols || rows !== state.gridRows) {
    state.stars = generateStars(cols, rows);
    state.gridCols = cols;
    state.gridRows = rows;
  }

  // --- Detect explosions from entity disappearances (skip when paused) ---
  if (!hud.paused) {
    const currentAsteroidIds = new Set<number>();
    const currentSaucerIds = new Set<number>();

    for (const ast of snapshot.asteroids) {
      currentAsteroidIds.add(ast.id);
    }
    for (const s of snapshot.saucers) {
      currentSaucerIds.add(s.id);
    }

    // Check which previous asteroids disappeared
    for (const [id, pos] of state.prevAsteroidPos) {
      if (!currentAsteroidIds.has(id)) {
        const ttl = pos.size === "large" ? 8 : pos.size === "medium" ? 6 : 4;
        state.explosions.push({ col: pos.col, row: pos.row, ttl, maxTtl: ttl });
      }
    }
    // Check which previous saucers disappeared
    for (const [id, pos] of state.prevSaucerPos) {
      if (!currentSaucerIds.has(id)) {
        state.explosions.push({
          col: pos.col,
          row: pos.row,
          ttl: 7,
          maxTtl: 7,
        });
      }
    }

    // Age and prune explosions
    state.explosions = state.explosions.filter((e) => {
      e.ttl--;
      return e.ttl > 0;
    });
  }

  // --- Build grid ---
  const grid: string[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => " "),
  );
  const colorGrid: string[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ""),
  );

  // Layer 0: Starfield
  for (const star of state.stars) {
    if (star.row < rows && star.col < cols) {
      grid[star.row][star.col] = star.ch;
      // dim is applied via color
    }
  }

  // Layer 1: Asteroids (multi-cell)
  for (const ast of snapshot.asteroids) {
    const { col, row } = worldToTerm(ast.x, ast.y, cols, rows);
    paintAsteroid(grid, colorGrid, col, row, ast.size, cols, rows);
  }

  // Layer 2: Explosions
  for (const exp of state.explosions) {
    paintExplosion(grid, colorGrid, exp.col, exp.row, exp.ttl, exp.maxTtl, cols, rows);
  }

  // Layer 3: Saucer bullets
  for (const b of snapshot.saucerBullets) {
    const { col, row } = worldToTerm(b.x, b.y, cols, rows);
    paintCell(grid, colorGrid, row, col, "\u2022", ansi.red, cols, rows); // •
  }

  // Layer 4: Player bullets
  for (const b of snapshot.bullets) {
    const { col, row } = worldToTerm(b.x, b.y, cols, rows);
    paintCell(grid, colorGrid, row, col, "\u2022", ansi.brightYellow, cols, rows); // •
  }

  // Layer 5: Saucers (3-char wide)
  for (const s of snapshot.saucers) {
    const { col, row } = worldToTerm(s.x, s.y, cols, rows);
    if (s.small) {
      paintCell(grid, colorGrid, row, col - 1, "(", ansi.red, cols, rows);
      paintCell(grid, colorGrid, row, col, "=", ansi.red, cols, rows);
      paintCell(grid, colorGrid, row, col + 1, ")", ansi.red, cols, rows);
    } else {
      paintCell(grid, colorGrid, row, col - 2, "<", ansi.magenta, cols, rows);
      paintCell(grid, colorGrid, row, col - 1, "=", ansi.magenta, cols, rows);
      paintCell(grid, colorGrid, row, col, "O", ansi.magenta, cols, rows);
      paintCell(grid, colorGrid, row, col + 1, "=", ansi.magenta, cols, rows);
      paintCell(grid, colorGrid, row, col + 2, ">", ansi.magenta, cols, rows);
    }
  }

  // Layer 6: Ship
  if (snapshot.ship.alive && snapshot.ship.canControl) {
    const { col, row } = worldToTerm(snapshot.ship.x, snapshot.ship.y, cols, rows);
    paintCell(
      grid,
      colorGrid,
      row,
      col,
      shipChar(snapshot.ship.angle),
      ansi.brightCyan,
      cols,
      rows,
    );
  }

  // --- Save entity positions for next frame's explosion detection (skip when paused) ---
  if (!hud.paused) {
    state.prevAsteroidPos.clear();
    for (const ast of snapshot.asteroids) {
      const { col, row } = worldToTerm(ast.x, ast.y, cols, rows);
      state.prevAsteroidPos.set(ast.id, { col, row, size: ast.size });
    }
    state.prevSaucerPos.clear();
    for (const s of snapshot.saucers) {
      const { col, row } = worldToTerm(s.x, s.y, cols, rows);
      state.prevSaucerPos.set(s.id, { col, row, small: s.small });
    }
  }

  // --- Build output string ---
  const lines: string[] = [];

  // HUD line
  const progressPct = hud.totalFrames > 0 ? Math.round((hud.frame / hud.totalFrames) * 100) : 0;
  const livesStr =
    hud.lives > 0
      ? ansi.color(ansi.green, "\u2665".repeat(Math.min(hud.lives, 10))) +
        (hud.lives > 10 ? ansi.color(ansi.dim, `+${hud.lives - 10}`) : "")
      : ansi.color(ansi.red, "\u2717"); // ✗

  lines.push(
    ` ${ansi.color(ansi.dim, "SCORE")} ${ansi.color(ansi.brightGreen, String(hud.score).padStart(6))}` +
      `  ${ansi.color(ansi.dim, "WAVE")} ${ansi.color(ansi.white, String(Math.max(1, hud.wave)))}` +
      `  ${ansi.color(ansi.dim, "LIVES")} ${livesStr}` +
      `  ${ansi.color(ansi.dim, `${progressPct}%`)}` +
      `  ${ansi.color(hud.speed > 1 ? ansi.brightYellow : ansi.dim, `${hud.speed}x`)}` +
      (hud.paused ? `  ${ansi.color(ansi.brightYellow, "\u23f8 PAUSED")}` : ""),
  );

  // Progress bar
  const barWidth = Math.max(10, cols - 2);
  const filled = Math.round(barWidth * (hud.frame / Math.max(1, hud.totalFrames)));
  const barFilled = "\u2588".repeat(filled); // █
  const barEmpty = "\u2591".repeat(barWidth - filled); // ░
  lines.push(` ${ansi.color(ansi.magenta, barFilled)}${ansi.color(ansi.dim, barEmpty)}`);

  // Border top
  lines.push(ansi.color(ansi.dim, " \u250c" + "\u2500".repeat(cols) + "\u2510"));

  // Grid rows
  for (let r = 0; r < rows; r++) {
    let line = ansi.color(ansi.dim, " \u2502");
    for (let c = 0; c < cols; c++) {
      const ch = grid[r][c];
      const clr = colorGrid[r][c];
      if (clr) {
        line += `${clr}${ch}${ansi.reset}`;
      } else if (ch !== " ") {
        // Stars and other uncolored chars get dim treatment
        line += `${ansi.dim}${ch}${ansi.reset}`;
      } else {
        line += ch;
      }
    }
    line += ansi.color(ansi.dim, "\u2502");
    lines.push(line);
  }

  // Border bottom
  lines.push(ansi.color(ansi.dim, " \u2514" + "\u2500".repeat(cols) + "\u2518"));

  // Footer legend
  lines.push(
    ` ${ansi.color(ansi.dim, "[Space]")} ${ansi.color(ansi.gray, "Pause")}` +
      `  ${ansi.color(ansi.dim, "[R]")} ${ansi.color(ansi.gray, "Restart")}` +
      `  ${ansi.color(ansi.dim, "[1]")} ${ansi.color(ansi.gray, "1x")}` +
      `  ${ansi.color(ansi.dim, "[2]")} ${ansi.color(ansi.gray, "2x")}` +
      `  ${ansi.color(ansi.dim, "[4]")} ${ansi.color(ansi.gray, "4x")}` +
      `  ${ansi.color(ansi.dim, "[Esc/Q]")} ${ansi.color(ansi.gray, "Quit")}`,
  );

  return ansi.cursorTo(0, 0) + lines.map((l) => l + ansi.clearToEol).join("\n");
}
