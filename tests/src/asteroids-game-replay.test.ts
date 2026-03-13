import { describe, expect, it } from "bun:test";
import { AsteroidsGame } from "../../src/game/AsteroidsGame";
import { serializeTape } from "../../src/game/tape";

type ReplayTestInternal = {
  mode: "menu" | "playing" | "paused" | "game-over" | "replay";
  lives: number;
  wave: number;
  asteroids: unknown[];
  saucers: unknown[];
  ship: { canControl: boolean; respawnTimer: number };
  inputSource: { getFrameInput(): unknown; advance(): void };
};

function prepareReplayWaveScenario(lives: number): AsteroidsGame {
  const game = new AsteroidsGame({ headless: true, seed: 0x12345678 });
  game.startNewGame(0x12345678);

  const internal = game as unknown as ReplayTestInternal;
  internal.mode = "replay";
  internal.lives = lives;
  internal.wave = 1;
  internal.asteroids = [];
  internal.saucers = [];
  internal.ship.canControl = false;
  internal.ship.respawnTimer = 99_999;
  internal.inputSource = {
    getFrameInput: () => ({ left: false, right: false, thrust: false, fire: false }),
    advance: () => {},
  };

  return game;
}

describe("AsteroidsGame replay parity", () => {
  it("spawns the next wave during replay while the run is still alive", () => {
    const game = prepareReplayWaveScenario(2);

    game.stepSimulation();

    expect(game.getWave()).toBe(2);
  });

  it("does not spawn a new wave after terminal death during replay", () => {
    const game = prepareReplayWaveScenario(0);

    game.stepSimulation();

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
