const GAME_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Space",
  "KeyP",
  "Enter",
  "KeyR",
  "KeyA", // Autopilot toggle
  "Escape", // Return to menu
  "KeyD", // Download tape
  "KeyL", // Load tape
  "Digit1", // Replay speed 1x
  "Digit2", // Replay speed 2x
  "Digit4", // Replay speed 4x
  "KeyM", // Mute toggle
]);

const GAMEPAD_ACTIONS = [
  "left",
  "right",
  "thrust",
  "fire",
  "start",
  "menu",
  "replaySpeed1",
  "replaySpeed2",
  "replaySpeed4",
] as const;

export type GamepadAction = (typeof GAMEPAD_ACTIONS)[number];
export type GameplayAction = "left" | "right" | "thrust" | "fire";

const GAMEPLAY_ACTION_KEYCODES: Record<GameplayAction, string> = {
  left: "ArrowLeft",
  right: "ArrowRight",
  thrust: "ArrowUp",
  fire: "Space",
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined") {
    return false;
  }

  if (!(target instanceof Element)) {
    return false;
  }

  if (
    (typeof HTMLInputElement !== "undefined" && target instanceof HTMLInputElement) ||
    (typeof HTMLTextAreaElement !== "undefined" && target instanceof HTMLTextAreaElement)
  ) {
    return true;
  }

  if (typeof HTMLSelectElement !== "undefined" && target instanceof HTMLSelectElement) {
    return true;
  }

  if (
    typeof HTMLElement !== "undefined" &&
    target instanceof HTMLElement &&
    target.isContentEditable
  ) {
    return true;
  }

  return false;
}

export class InputController {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly gamepadDown = new Set<GamepadAction>();
  private readonly gamepadPressed = new Set<GamepadAction>();

  handleKeyDown(event: KeyboardEvent): void {
    if (!GAME_KEYS.has(event.code)) {
      return;
    }

    if (isEditableTarget(event.target)) {
      return;
    }

    event.preventDefault();

    if (!this.down.has(event.code)) {
      this.pressed.add(event.code);
    }

    this.down.add(event.code);
  }

  handleKeyUp(event: KeyboardEvent): void {
    if (!GAME_KEYS.has(event.code)) {
      return;
    }

    // Always release the key, even when focus is inside a form control,
    // so the game cannot get stuck in a "held key" state.
    if (isEditableTarget(event.target)) {
      this.down.delete(event.code);
      return;
    }

    event.preventDefault();
    this.down.delete(event.code);
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  isActionDown(action: GameplayAction): boolean {
    return this.down.has(GAMEPLAY_ACTION_KEYCODES[action]) || this.gamepadDown.has(action);
  }

  consumePress(code: string): boolean {
    const wasPressed = this.pressed.has(code);
    this.pressed.delete(code);
    return wasPressed;
  }

  consumeGamepadPress(action: GamepadAction): boolean {
    const wasPressed = this.gamepadPressed.has(action);
    this.gamepadPressed.delete(action);
    return wasPressed;
  }

  syncGamepadState(state: Partial<Record<GamepadAction, boolean>>): void {
    for (const action of GAMEPAD_ACTIONS) {
      const isDown = state[action] === true;
      const wasDown = this.gamepadDown.has(action);

      if (isDown && !wasDown) {
        this.gamepadPressed.add(action);
      }

      if (isDown) {
        this.gamepadDown.add(action);
      } else {
        this.gamepadDown.delete(action);
      }
    }
  }

  clearPressed(): void {
    this.pressed.clear();
    this.gamepadPressed.clear();
  }

  reset(): void {
    this.down.clear();
    this.pressed.clear();
    this.gamepadDown.clear();
    this.gamepadPressed.clear();
  }
}
