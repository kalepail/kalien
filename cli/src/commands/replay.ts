import { readFileSync } from "fs";
import { AsteroidsGame } from "@/game/AsteroidsGame";
import type { GameStateSnapshot } from "@/game/Autopilot";
import { TapeInputSource } from "@/game/input-source";
import { deserializeTape } from "@/game/tape";
import { renderAsciiFrame, createReplayState, type ReplayHUD } from "../display/ascii-replay";
import * as ansi from "../display/ansi";

export async function replayCommand(tapePath: string): Promise<void> {
  // Load tape
  let tapeData: Uint8Array;
  try {
    tapeData = new Uint8Array(readFileSync(tapePath));
  } catch (err) {
    console.error(`Failed to read tape: ${tapePath}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const tape = deserializeTape(tapeData);

  console.log(`${ansi.color(ansi.brightCyan, "KALIEN Replay")}`);
  console.log(`  Seed:   0x${tape.header.seed.toString(16).toUpperCase().padStart(8, "0")}`);
  console.log(`  Frames: ${tape.header.frameCount}`);
  console.log(`  Score:  ${tape.footer.finalScore}`);
  console.log("");
  console.log(`  Starting in 2s... (Ctrl+C to quit)`);

  await sleep(2000);

  const totalFrames = tape.header.frameCount;
  const baseFrameTime = 1000 / 30; // ~30fps at 1x
  let stopped = false;
  let paused = false;
  let speed = 1; // 1x, 2x, or 4x
  let restart = false;

  // Enable raw mode for keypress detection
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (data: Buffer) => {
      const key = data[0];
      const str = data.toString();

      if (key === 0x1b) {
        // Esc key (but not an escape sequence like arrow keys)
        if (data.length === 1) stopped = true;
      } else if (str === "q" || str === "Q") {
        stopped = true;
      } else if (str === " " || str === "p" || str === "P") {
        paused = !paused;
      } else if (str === "r" || str === "R") {
        restart = true;
      } else if (str === "1") {
        speed = 1;
      } else if (str === "2") {
        speed = 2;
      } else if (str === "4") {
        speed = 4;
      } else if (key === 0x03) {
        // Ctrl+C
        stopped = true;
      }
    });
  }

  process.on("SIGINT", () => {
    stopped = true;
  });

  process.stdout.write(ansi.clearScreen + ansi.cursorHide);

  // Clear screen on terminal resize to avoid artifacts
  process.stdout.on("resize", () => {
    process.stdout.write(ansi.clearScreen);
  });

  // Outer loop: supports restart
  /* eslint-disable no-await-in-loop, no-unmodified-loop-condition -- replay control flags are updated by signal and keyboard handlers */
  while (!stopped) {
    const game = new AsteroidsGame({ headless: true, seed: tape.header.seed });
    game.startNewGame(tape.header.seed);
    const inputSource = new TapeInputSource(tape.inputs);
    game.setInputSource(inputSource);

    const replayState = createReplayState();
    let frame = 0;
    restart = false;

    while (frame < totalFrames && !stopped && !restart) {
      if (paused) {
        // Re-render current frame without advancing state
        const snapshot = (
          game as unknown as { getGameStateSnapshot(): GameStateSnapshot }
        ).getGameStateSnapshot();
        const hud: ReplayHUD = {
          score: game.getScore(),
          wave: game.getWave(),
          lives: game.getLives(),
          frame,
          totalFrames,
          speed,
          paused: true,
        };
        process.stdout.write(renderAsciiFrame(snapshot, hud, replayState));
        await sleep(100);
        continue;
      }

      // Step simulation: 2 game frames per display frame at 1x,
      // scaled by speed multiplier
      const stepsPerTick = 2 * speed;
      for (let i = 0; i < stepsPerTick && frame < totalFrames; i++) {
        game.stepSimulation();
        frame++;
      }

      // Get snapshot for rendering
      const snapshot = (
        game as unknown as { getGameStateSnapshot(): GameStateSnapshot }
      ).getGameStateSnapshot();
      const hud: ReplayHUD = {
        score: game.getScore(),
        wave: game.getWave(),
        lives: game.getLives(),
        frame,
        totalFrames,
        speed,
        paused: false,
      };

      process.stdout.write(renderAsciiFrame(snapshot, hud, replayState));

      // Wait for next display frame (constant rate regardless of speed)
      await sleep(baseFrameTime);
    }

    // If we reached the end naturally (not restart/quit), break
    if (!restart) break;
  }
  /* eslint-enable no-await-in-loop, no-unmodified-loop-condition */

  // Restore terminal state
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  // Show final stats
  process.stdout.write(ansi.cursorShow + "\n\n");
  console.log(`${ansi.color(ansi.brightCyan, "  Replay complete")}`);
  console.log(`  Final Score: ${ansi.color(ansi.brightGreen, String(tape.footer.finalScore))}`);
  console.log(`  Frames: ${totalFrames}`);
  console.log("");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
