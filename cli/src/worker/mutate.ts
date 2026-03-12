import type { AutopilotConfig } from "@/game/Autopilot";

interface ParamBounds {
  min: number;
  max: number;
}

const BOUNDS: Record<string, ParamBounds> = {
  collisionLookahead: { min: 0.5, max: 3.0 },
  dangerRadius: { min: 60, max: 250 },
  cautionRadius: { min: 150, max: 400 },
  aimTolerance: { min: 0.05, max: 0.25 },
  safeDistance: { min: 80, max: 300 },
  leadFactor: { min: 0.5, max: 1.5 },
  maxShotAngle: { min: 0.26, max: 1.05 },
  aggression: { min: 0.3, max: 1.0 },
  shotPatience: { min: 0.02, max: 0.15 },
  lowLivesDangerMult: { min: 1.0, max: 2.0 },
  waveAggressionBonus: { min: 0.01, max: 0.1 },
  lurkKillFrames: { min: 120, max: 600 },
};

const NUMERIC_KEYS = Object.keys(BOUNDS);

export type MutationRole = "exploit" | "explore";

/**
 * Mutate a config by perturbing parameters.
 *
 * Exploit (scale ~0.5): tweaks exactly 1 parameter with small perturbation
 * for clean hill-climbing signal.
 *
 * Explore (scale ~1.5): tweaks 2-6 parameters with large perturbation
 * for broad jumps through config space.
 */
export function mutateConfig(
  base: AutopilotConfig,
  scale = 1.0,
  role: MutationRole = "explore",
): AutopilotConfig {
  const result = { ...base };

  // Exploit: exactly 1 param for clean signal.
  // Explore: 2-6 params for bigger leaps.
  const tweakCount = role === "exploit" ? 1 : 2 + Math.floor(Math.random() * 5); // 2-6

  const shuffled = [...NUMERIC_KEYS];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const toTweak = shuffled.slice(0, Math.min(tweakCount, NUMERIC_KEYS.length));

  for (const key of toTweak) {
    const bounds = BOUNDS[key];
    const range = bounds.max - bounds.min;
    const current = (result as Record<string, number>)[key] as number;

    // Perturbation: ±10-30% of the parameter's valid range, scaled by role
    const perturbScale = (0.1 + Math.random() * 0.2) * scale;
    const delta = (Math.random() * 2 - 1) * perturbScale * range;
    let newVal = current + delta;

    // Clamp to bounds
    newVal = Math.max(bounds.min, Math.min(bounds.max, newVal));
    (result as Record<string, number>)[key] = newVal;
  }

  // Randomly flip preferSmallAsteroids (~10% chance)
  if (Math.random() < 0.1) {
    result.preferSmallAsteroids = !result.preferSmallAsteroids;
  }

  // Enforce constraint: cautionRadius > dangerRadius + 30
  if (result.cautionRadius <= result.dangerRadius + 30) {
    result.cautionRadius = result.dangerRadius + 30;
  }

  return result;
}

/** Generate a fully random config within bounds. */
export function randomConfig(): AutopilotConfig {
  const config: Record<string, number | boolean> = {};
  for (const key of NUMERIC_KEYS) {
    const { min, max } = BOUNDS[key];
    config[key] = min + Math.random() * (max - min);
  }
  config.preferSmallAsteroids = Math.random() < 0.5;

  // Enforce constraint
  if (config.cautionRadius <= config.dangerRadius + 30) {
    config.cautionRadius = config.dangerRadius + 30;
  }

  return config as AutopilotConfig;
}

/**
 * Warm restart: blend 50% of a reference config with 50% random.
 * Preserves some learned structure while exploring new territory.
 */
export function warmRestartConfig(reference: AutopilotConfig): AutopilotConfig {
  const random = randomConfig();
  const blended: Record<string, number | boolean> = {};

  for (const key of NUMERIC_KEYS) {
    const refVal = (reference as Record<string, number>)[key];
    const randVal = (random as Record<string, number>)[key];
    blended[key] = refVal * 0.5 + randVal * 0.5;
  }

  // Boolean: 50% chance to inherit from reference, 50% random
  blended.preferSmallAsteroids =
    Math.random() < 0.5 ? reference.preferSmallAsteroids : random.preferSmallAsteroids;

  // Enforce constraint
  if (blended.cautionRadius <= blended.dangerRadius + 30) {
    blended.cautionRadius = blended.dangerRadius + 30;
  }

  return blended as AutopilotConfig;
}
