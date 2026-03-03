import { describe, expect, it } from "bun:test";
import { readGamepadActions } from "../../src/game/gamepad";
import { InputController } from "../../src/game/input";

function makeGamepad(options?: {
  axes?: number[];
  pressedButtons?: number[];
  connected?: boolean;
}): Gamepad {
  const axes = options?.axes ?? [0];
  const pressedButtons = new Set(options?.pressedButtons ?? []);
  const connected = options?.connected ?? true;
  const buttonCount = 17;
  const buttons = Array.from({ length: buttonCount }, (_, index) => {
    const pressed = pressedButtons.has(index);
    return {
      pressed,
      touched: pressed,
      value: pressed ? 1 : 0,
    };
  });

  return {
    connected,
    axes,
    buttons,
  } as unknown as Gamepad;
}

function makeKeyboardEvent(code: string): KeyboardEvent {
  return {
    code,
    target: null,
    preventDefault() {
      return undefined;
    },
  } as unknown as KeyboardEvent;
}

describe("readGamepadActions", () => {
  it("ignores stick input within deadzone", () => {
    const actions = readGamepadActions([makeGamepad({ axes: [0.2] })], 0.25);
    expect(actions.left).toBe(false);
    expect(actions.right).toBe(false);
  });

  it("maps stick and d-pad left/right", () => {
    const leftActions = readGamepadActions([makeGamepad({ axes: [-0.8] })], 0.25);
    expect(leftActions.left).toBe(true);
    expect(leftActions.right).toBe(false);

    const rightActions = readGamepadActions([makeGamepad({ axes: [0.8] })], 0.25);
    expect(rightActions.left).toBe(false);
    expect(rightActions.right).toBe(true);

    const dpadActions = readGamepadActions([makeGamepad({ pressedButtons: [14, 15] })], 0.25);
    expect(dpadActions.left).toBe(true);
    expect(dpadActions.right).toBe(true);
  });

  it("maps fire/thrust/start/menu actions", () => {
    const actions = readGamepadActions([makeGamepad({ pressedButtons: [0, 6, 9, 8] })], 0.25);
    expect(actions.fire).toBe(true);
    expect(actions.thrust).toBe(true);
    expect(actions.start).toBe(true);
    expect(actions.menu).toBe(true);
  });

  it("maps replay shortcut buttons", () => {
    const actions = readGamepadActions([makeGamepad({ pressedButtons: [2, 3, 1] })], 0.25);
    expect(actions.replaySpeed1).toBe(true);
    expect(actions.replaySpeed2).toBe(true);
    expect(actions.replaySpeed4).toBe(true);
  });
});

describe("InputController gamepad integration", () => {
  it("keeps keyboard press semantics unchanged", () => {
    const input = new InputController();
    input.handleKeyDown(makeKeyboardEvent("KeyP"));
    expect(input.consumePress("KeyP")).toBe(true);
    expect(input.consumePress("KeyP")).toBe(false);
    input.handleKeyUp(makeKeyboardEvent("KeyP"));
    expect(input.isDown("KeyP")).toBe(false);
  });

  it("combines keyboard and gamepad held states for gameplay actions", () => {
    const input = new InputController();
    input.handleKeyDown(makeKeyboardEvent("ArrowLeft"));
    expect(input.isActionDown("left")).toBe(true);
    input.handleKeyUp(makeKeyboardEvent("ArrowLeft"));
    expect(input.isActionDown("left")).toBe(false);

    input.syncGamepadState({ left: true });
    expect(input.isActionDown("left")).toBe(true);
    input.syncGamepadState({ left: false });
    expect(input.isActionDown("left")).toBe(false);
  });

  it("tracks gamepad presses as edges", () => {
    const input = new InputController();
    input.syncGamepadState({ start: true });
    expect(input.consumeGamepadPress("start")).toBe(true);
    expect(input.consumeGamepadPress("start")).toBe(false);

    input.syncGamepadState({ start: true });
    expect(input.consumeGamepadPress("start")).toBe(false);

    input.syncGamepadState({ start: false });
    input.syncGamepadState({ start: true });
    expect(input.consumeGamepadPress("start")).toBe(true);
  });

  it("tracks replay shortcut button edges", () => {
    const input = new InputController();
    input.syncGamepadState({ replaySpeed2: true });
    expect(input.consumeGamepadPress("replaySpeed2")).toBe(true);
    expect(input.consumeGamepadPress("replaySpeed2")).toBe(false);
  });
});
