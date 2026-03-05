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

  if (target instanceof HTMLElement && target.isContentEditable) {
    return true;
  }

  return false;
}

// Xbox controller button index → key code mapping (Standard Gamepad API layout)
const GAMEPAD_BUTTON_MAP: Array<[number, string]> = [
  [1, "Escape"],     // B → Return to menu
  [6, "ArrowUp"],    // LT → Ignition (thrust)
  [7, "Space"],      // RT → Fire
  [9, "Enter"],      // Start → Start / resume / pause
  [12, "ArrowUp"],   // D-Pad Up → Thrust
  [14, "ArrowLeft"], // D-Pad Left → Turn left
  [15, "ArrowRight"],// D-Pad Right → Turn right
];

// Thumbstick deadzone threshold
const GAMEPAD_AXIS_THRESHOLD = 0.5;

export class InputController {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();
  // Tracks which codes are currently held via gamepad (kept separate from
  // keyboard state so releasing one input source never clears the other).
  private readonly gamepadDown = new Set<string>();

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

  /**
   * Poll all connected gamepads and synthesize key presses/releases.
   * Must be called once at the start of each animation frame.
   */
  pollGamepad(): void {
    if (typeof navigator === "undefined" || !navigator.getGamepads) return;

    const gamepads = navigator.getGamepads();
    const newDown = new Set<string>();

    for (const pad of gamepads) {
      if (!pad?.connected) continue;

      for (const [idx, code] of GAMEPAD_BUTTON_MAP) {
        if (pad.buttons[idx]?.pressed) newDown.add(code);
      }

      // Left thumbstick axes (index 0 = X, index 1 = Y)
      const lx = pad.axes[0] ?? 0;
      const ly = pad.axes[1] ?? 0;
      if (lx < -GAMEPAD_AXIS_THRESHOLD) newDown.add("ArrowLeft");
      if (lx > GAMEPAD_AXIS_THRESHOLD) newDown.add("ArrowRight");
      if (ly < -GAMEPAD_AXIS_THRESHOLD) newDown.add("ArrowUp");
    }

    // Newly pressed this frame → register in shared pressed set
    for (const code of newDown) {
      if (!this.gamepadDown.has(code)) {
        this.pressed.add(code);
      }
    }

    // Update gamepadDown to reflect current hardware state
    this.gamepadDown.clear();
    for (const code of newDown) this.gamepadDown.add(code);
  }

  isDown(code: string): boolean {
    return this.down.has(code) || this.gamepadDown.has(code);
  }

  consumePress(code: string): boolean {
    const wasPressed = this.pressed.has(code);
    this.pressed.delete(code);
    return wasPressed;
  }

  clearPressed(): void {
    this.pressed.clear();
  }

  reset(): void {
    this.down.clear();
    this.pressed.clear();
    this.gamepadDown.clear();
  }
}
