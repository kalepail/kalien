import type { Autopilot } from "./Autopilot";
import type { InputController } from "./input";
import { decodeInputByte, type FrameInput } from "./tape";

/**
 * Abstraction over input for a single simulation frame.
 * Implementations: LiveInputSource (keyboard/autopilot) and TapeInputSource (replay).
 */
export interface InputSource {
  getFrameInput(): FrameInput;
  advance(): void;
}

/**
 * Live input from keyboard or autopilot.
 * The game passes an autopilot-input callback so this class doesn't need
 * to know about game-state snapshot creation.
 */
export class LiveInputSource implements InputSource {
  private lastInput: FrameInput = {
    left: false,
    right: false,
    thrust: false,
    fire: false,
  };

  constructor(
    private readonly input: InputController,
    private readonly autopilot: Autopilot,
    private readonly getAutopilotInput: () => {
      left: boolean;
      right: boolean;
      thrust: boolean;
      fire: boolean;
    } | null,
  ) {}

  getFrameInput(): FrameInput {
    const ai = this.autopilot.isEnabled() ? this.getAutopilotInput() : null;

    this.lastInput = {
      left: ai ? ai.left : this.input.isActionDown("left"),
      right: ai ? ai.right : this.input.isActionDown("right"),
      thrust: ai ? ai.thrust : this.input.isActionDown("thrust"),
      fire: ai ? ai.fire : this.input.isActionDown("fire"),
    };

    return this.lastInput;
  }

  advance(): void {
    // Nothing to advance for live input
  }
}

/**
 * Replays pre-recorded input from a tape's input byte array.
 */
export class TapeInputSource implements InputSource {
  private cursor = 0;
  private completed = false;

  constructor(
    private readonly inputs: Uint8Array,
    private readonly onComplete?: () => void,
  ) {}

  getFrameInput(): FrameInput {
    if (this.cursor >= this.inputs.length) {
      return { left: false, right: false, thrust: false, fire: false };
    }
    return decodeInputByte(this.inputs[this.cursor]);
  }

  advance(): void {
    if (this.cursor < this.inputs.length) {
      this.cursor++;
      if (this.cursor >= this.inputs.length && !this.completed) {
        this.completed = true;
        this.onComplete?.();
      }
    }
  }

  isComplete(): boolean {
    return this.cursor >= this.inputs.length;
  }

  getCurrentFrame(): number {
    return this.cursor;
  }

  getTotalFrames(): number {
    return this.inputs.length;
  }
}
