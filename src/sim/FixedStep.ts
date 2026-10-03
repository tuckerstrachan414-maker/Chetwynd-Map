import * as THREE from 'three';

/**
 * Fixed-rate simulation clock, independent of the display's frame rate.
 *
 * Variable frame time accumulates and the simulation advances in whole steps of `h`, so physics
 * behaves the same at 30, 60 or 144 Hz (Rapier is stable at its tuned step, not at whatever the
 * frame happened to take). `alpha` is how far the rendered moment lies between the last two steps:
 * renderers interpolate poses with it (see PoseHistory), so motion stays smooth on displays faster
 * than the simulation and never stutters when a frame runs zero or two steps.
 */
export class FixedStep {
  private acc = 0;
  /** Fraction (0..1) of a step the render time is ahead of the last completed step. */
  alpha = 0;
  /** Steps run in the last advance(). */
  steps = 0;

  /** `h`: step length (s); `maxSteps`: catch-up limit per frame (beyond it, time slows instead of spiralling). */
  constructor(readonly h: number, readonly maxSteps = 8) {}

  /** Advance by `dt` seconds of frame time, calling `step(h)` for each whole step due. */
  advance(dt: number, step: (h: number) => void): number {
    this.acc += dt;
    let n = 0;
    while (this.acc >= this.h && n < this.maxSteps) {
      step(this.h);
      this.acc -= this.h;
      n++;
    }
    if (n === this.maxSteps && this.acc >= this.h) this.acc = 0;
    this.steps = n;
    this.alpha = this.acc / this.h;
    return n;
  }

  /** Forget accumulated time (after a teleport or a mode switch). */
  reset(): void {
    this.acc = 0;
    this.alpha = 0;
    this.steps = 0;
  }
}

/**
 * The last two simulated poses of a body; `sample(alpha)` gives the pose at render time between them
 * (position lerp, rotation slerp). Allocation-free: the vectors are reused.
 */
export class PoseHistory {
  readonly prevPos = new THREE.Vector3();
  readonly currPos = new THREE.Vector3();
  readonly prevQuat = new THREE.Quaternion();
  readonly currQuat = new THREE.Quaternion();
  private primed = false;

  /** Record the pose at the end of a simulation step. */
  push(pos: THREE.Vector3Like, quat?: THREE.QuaternionLike): void {
    if (!this.primed) {
      this.reset(pos, quat);
      return;
    }
    this.prevPos.copy(this.currPos);
    this.prevQuat.copy(this.currQuat);
    this.currPos.copy(pos);
    if (quat) this.currQuat.set(quat.x, quat.y, quat.z, quat.w);
  }

  /** Jump to a pose with no interpolation (spawn, respawn, teleport). */
  reset(pos: THREE.Vector3Like, quat?: THREE.QuaternionLike): void {
    this.currPos.copy(pos);
    this.prevPos.copy(pos);
    if (quat) {
      this.currQuat.set(quat.x, quat.y, quat.z, quat.w);
      this.prevQuat.copy(this.currQuat);
    }
    this.primed = true;
  }

  sample(alpha: number, outPos: THREE.Vector3, outQuat?: THREE.Quaternion): void {
    outPos.lerpVectors(this.prevPos, this.currPos, alpha);
    if (outQuat) outQuat.slerpQuaternions(this.prevQuat, this.currQuat, alpha);
  }
}
