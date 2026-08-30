import type { AutopilotConfig } from "../../../src/game/Autopilot";

export type WorkerRole = "explore" | "exploit";

/** Messages from main thread -> worker */
export type MainToWorkerMessage =
  | {
      type: "start";
      workerId: number;
      role: WorkerRole;
      rpcUrl: string;
      contractId: string;
      networkPassphrase: string;
      relayerBaseUrl: string;
      relayerApiKey: string | null;
    }
  | { type: "stop" }
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
    }
  | { type: "stopped"; workerId: number };
