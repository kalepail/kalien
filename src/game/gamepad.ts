import type { GamepadAction } from "./input";

const DEFAULT_STICK_DEADZONE = 0.25;

export type GamepadActionState = Record<GamepadAction, boolean>;

const EMPTY_GAMEPAD_ACTION_STATE: GamepadActionState = {
  left: false,
  right: false,
  thrust: false,
  fire: false,
  start: false,
  menu: false,
};

function isButtonPressed(gamepad: Gamepad, index: number): boolean {
  const button = gamepad.buttons[index];
  return button?.pressed === true || (button?.value ?? 0) > 0.5;
}

export function readGamepadActions(
  gamepads: readonly (Gamepad | null)[],
  deadzone = DEFAULT_STICK_DEADZONE,
): GamepadActionState {
  const actions: GamepadActionState = { ...EMPTY_GAMEPAD_ACTION_STATE };

  for (const gamepad of gamepads) {
    if (!gamepad || gamepad.connected !== true) {
      continue;
    }

    const stickX = gamepad.axes[0] ?? 0;

    actions.left = actions.left || stickX < -deadzone || isButtonPressed(gamepad, 14);
    actions.right = actions.right || stickX > deadzone || isButtonPressed(gamepad, 15);
    actions.thrust = actions.thrust || isButtonPressed(gamepad, 6) || isButtonPressed(gamepad, 4);
    actions.fire = actions.fire || isButtonPressed(gamepad, 0) || isButtonPressed(gamepad, 7);
    actions.start = actions.start || isButtonPressed(gamepad, 9);
    actions.menu = actions.menu || isButtonPressed(gamepad, 8);
  }

  return actions;
}

export function pollGamepadActions(deadzone = DEFAULT_STICK_DEADZONE): GamepadActionState {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") {
    return { ...EMPTY_GAMEPAD_ACTION_STATE };
  }

  const gamepads = navigator.getGamepads();
  return readGamepadActions(Array.from(gamepads), deadzone);
}
