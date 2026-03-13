import { describe, expect, it } from "bun:test";
import { AsteroidsGame } from "../../src/game/AsteroidsGame";
import { serializeTape } from "../../src/game/tape";

describe("AsteroidsGame replay parity", () => {
  it("spawns the next wave during replay while the run is still alive", () => {
    const game = new AsteroidsGame({ headless: true, seed: 0x12345678 });
    game.startNewGame(0x12345678);

    const internal = game as unknown as {
      mode: "menu" | "playing" | "paused" | "game-over" | "replay";
      lives: number;
      wave: number;
      asteroids: unknown[];
      saucers: unknown[];
      inputSource: { getFrameInput(): unknown; advance(): void };
      updateSimulation(dt: number): void;
    };

    internal.mode = "replay";
    internal.lives = 2;
    internal.wave = 1;
    internal.asteroids = [];
    internal.saucers = [];
    internal.inputSource = {
      getFrameInput: () => ({ left: false, right: false, thrust: false, fire: false }),
      advance: () => {},
    };

    internal.updateSimulation(1 / 60);

    expect(game.getWave()).toBe(2);
  });

  it("does not spawn a new wave after terminal death during replay", () => {
    const game = new AsteroidsGame({ headless: true, seed: 0x12345678 });
    game.startNewGame(0x12345678);

    const internal = game as unknown as {
      mode: "menu" | "playing" | "paused" | "game-over" | "replay";
      lives: number;
      wave: number;
      asteroids: unknown[];
      saucers: unknown[];
      inputSource: { getFrameInput(): unknown; advance(): void };
      updateSimulation(dt: number): void;
    };

    internal.mode = "replay";
    internal.lives = 0;
    internal.wave = 1;
    internal.asteroids = [];
    internal.saucers = [];
    internal.inputSource = {
      getFrameInput: () => ({ left: false, right: false, thrust: false, fire: false }),
      advance: () => {},
    };

    internal.updateSimulation(1 / 60);

    expect(game.getWave()).toBe(1);
  });

  it("reports the computed replay score instead of the tape footer score", () => {
    const tapeBytes = serializeTape(0xabcdef01, new Uint8Array([0, 0, 0, 0]), 999_999);
    const game = new AsteroidsGame({ headless: true, seed: 0 });

    game.loadReplay(tapeBytes);

    const internal = game as unknown as { score: number };
    internal.score = 1234;

    expect(game.getRunRecord()).toEqual({
      seed: 0xabcdef01,
      seedId: 0,
      inputs: new Uint8Array([0, 0, 0, 0]),
      finalScore: 1234,
    });
  });
});
