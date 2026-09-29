// Stick-figure pose data.
import { clamp, lerp } from './core.js';

// Pose angles: lean, thigh1, knee1, thigh2, knee2, upperArm1, elbow1, upperArm2, elbow2
// (radians; 0 = straight down, positive swings forward). Limb lengths are fractions of runner size.
export const LIMB = { thigh: 0.25, shin: 0.25, torso: 0.3, upper: 0.17, fore: 0.16, head: 0.1 };
export const AIR_HIP = (LIMB.thigh + LIMB.shin) * 0.85;
export function runPose(p) {
  return [0.3, Math.sin(p) * 0.85, 0.3 + 0.9 * Math.max(0, Math.sin(p - 1.3)),
          Math.sin(p + Math.PI) * 0.85, 0.3 + 0.9 * Math.max(0, Math.sin(p + Math.PI - 1.3)),
          -Math.sin(p) * 0.9, 1.4, Math.sin(p) * 0.9, 1.4];
}
export function airPose(fall) {
  return [0.12, lerp(1.5, 0.5, fall), lerp(2.1, 0.5, fall), lerp(0.9, -0.2, fall), lerp(1.9, 0.4, fall),
          lerp(2.6, 2.3, fall), 0.5, lerp(2.2, 2.8, fall), 0.4];
}
// Poses are in the body's own frame; vaults also pitch the whole body (runner.rot), which swings
// limbs the other way: a limb at angle u points at u - rot on screen.
export const POSE = {
  stand:    [0.15, 0.25, 0.35, -0.1, 0.3, 0.3, 0.6, -0.2, 0.6],
  crouch:   [0.75, 1.55, 2.6, 1.2, 2.5, 1.2, 0.5, 0.7, 0.8],
  tuck:     [0.9, 2.4, 2.7, 2.2, 2.6, 0.4, 1.9, 0.2, 2.0],
  hop:      [0.3, 1.2, 1.6, 0.2, 0.9, -0.5, 1.2, 0.9, 1.1],
  kong:     [0.1, 0.1, 0.6, -0.2, 0.4, 2.3, 0.1, 2.1, 0.15],  // diving at the obstacle, arms reaching
  kongTuck: [0.3, 1.9, 2.3, 1.7, 2.2, 1.3, 0.2, 1.3, 0.2],    // hands planted, knees through
  push:     [0.25, 1.5, 1.3, 1.2, 1.1, -1.3, 0.7, -1.5, 0.6],  // shoved off: knees through, arms swept back
  speed:    [0.0, 1.1, 0.3, 1.2, 0.5, -0.1, 0.3, 2.2, 0.4],   // leaning back, legs swinging over, one hand down
  vaultExit:[0.15, 0.6, 0.5, 0.25, 0.45, -0.6, 0.5, 1.3, 0.8], // legs reaching down to land
  dive:     [0.1, 0.05, 0.2, -0.15, 0.3, 2.4, 0.1, 2.3, 0.1],
  reach:    [0.1, 1.0, 1.4, -0.3, 0.8, 2.9, 0.2, 2.7, 0.3],
  hang:     [0.05, 0.9, 0.6, 0.6, 0.8, 3.0, 0.2, 3.0, 0.2],   // feet on the wall, hands on the ledge
  mantle:   [0.8, 2.0, 2.3, 0.3, 0.6, 0.5, 0.3, 0.5, 0.3],
  leap:     [0.25, 1.3, 0.5, -0.8, 0.6, 2.4, 0.4, -0.7, 0.5],
};
// Landing compression c: 0 = running tall, 1 = deep squat (brace leans further to reach the ground)
export function landPose(c, brace) {
  const P = POSE.stand.map((v, i) => lerp(v, POSE.crouch[i], clamp(c, 0, 1.1)));
  P[0] += brace * 0.3;
  return P;
}
export const DEFAULT_PIVOT = [0, -0.12];
