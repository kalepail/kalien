import type { AutopilotConfig } from "../../../src/game/Autopilot";

export type WorkerRole = "explore" | "exploit";

/** Messages from main thread -> worker */
export type MainToWorkerMessage =
  | {
      type: "start";
      workerId: number;
      role: WorkerRole;
      seedId: number;
      seed: number | null;
      authorityGeneration: number;
    }
  | { type: "stop" }
  | {
      type: "seed-context";
      seedId: number;
      seed: number | null;
      authorityGeneration: number;
    }
  | { type: "reset-best" }
  | {
      type: "set-config";
      config: AutopilotConfig;
      globalScore: number;
      force?: boolean;
    };

/** Messages from worker -> main thread */
export type WorkerToMainMessage =
  | {
      type: "game-complete";
      workerId: number;
      score: number;
      frames: number;
      workerBest: number;
    }
  | {
      type: "new-best";
      workerId: number;
      score: number;
      frames: number;
      tape: Uint8Array;
      config: AutopilotConfig;
      seedId: number;
      authorityGeneration: number;
    }
  | { type: "stopped"; workerId: number };

export function isCurrentAuthorityResult(
  result: Pick<
    Extract<WorkerToMainMessage, { type: "new-best" }>,
    "seedId" | "authorityGeneration"
  >,
  currentSeedId: number,
  currentAuthorityGeneration: number,
  authorityIsFresh: boolean,
): boolean {
  return (
    authorityIsFresh &&
    result.seedId === currentSeedId &&
    result.authorityGeneration === currentAuthorityGeneration
  );
}
