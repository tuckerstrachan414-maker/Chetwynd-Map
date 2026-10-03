import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { PoseHistory } from './FixedStep';
import type { Input } from './Input';
import type { Physics } from './Physics';

const RADIUS = 0.3;
const HALF = 0.6;
const EYE = 1.68;

export interface WaterQuery {
  level: number;
  frozen: boolean;
}

const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _pos = new THREE.Vector3();
const _move = { x: 0, y: 0, z: 0 };

/**
 * First-person walker using Rapier's kinematic character controller; wades and swims in water.
 *
 * Split by rate: `look` (mouse and stick) runs every frame for responsiveness, `step` moves the body in
 * fixed physics steps, and `render` places the camera at the position interpolated between the last two
 * steps, so walking is smooth on any display without tying the controller to the frame time. The body
 * and its collider are made once and re-enabled on spawn (never destroyed while switching modes).
 */
export class Player {
  yaw = 0;
  pitch = 0;
  private body: RAPIER.RigidBody | null = null;
  private collider!: RAPIER.Collider;
  private controller!: RAPIER.KinematicCharacterController;
  private icePlate!: RAPIER.Collider;
  private active = false;
  private vy = 0;
  private grounded = false;
  private bob = 0;
  /** Horizontal ground speed of the last step (m/s), for the head bob. */
  private moving = 0;
  /** Movement intent from the last input sample. */
  private fx = 0;
  private fz = 0;
  private run = false;
  /** A jump press waits for the next physics step (a frame may run none at high refresh rates). */
  private jumpQueued = false;
  private readonly history = new PoseHistory();
  readonly position = new THREE.Vector3();
  walkSpeed = 1.6;
  runSpeed = 4.2;
  sensitivity = 0.0022;
  /** Water surface under the player (null on land); set by the app. */
  water?: (x: number, z: number) => WaterQuery | null;
  /** Depth of water at the player's feet (0 on land). */
  waterDepth = 0;
  swimming = false;

  constructor(private readonly physics: Physics) {}

  /** Take the walker out of the physics world (while driving or flying). */
  despawn(): void {
    if (!this.body || !this.active) return;
    this.body.setEnabled(false);
    this.active = false;
  }

  spawn(x: number, groundY: number, z: number): void {
    const w = this.physics.world;
    _move.x = x; _move.y = groundY + HALF + RADIUS + 0.05; _move.z = z;
    if (!this.body) {
      this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(_move.x, _move.y, _move.z));
      this.collider = w.createCollider(RAPIER.ColliderDesc.capsule(HALF, RADIUS), this.body);
    } else {
      this.body.setEnabled(true);
      this.body.setTranslation(_move, true);
      this.body.setNextKinematicTranslation(_move);
    }
    this.active = true;
    if (!this.icePlate) this.icePlate = w.createCollider(RAPIER.ColliderDesc.cuboid(2.5, 0.06, 2.5).setTranslation(x, -10000, z));
    if (!this.controller) {
      this.controller = w.createCharacterController(0.02);
      this.controller.enableAutostep(0.4, 0.2, true);
      this.controller.enableSnapToGround(0.5);
      this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
      this.controller.setMinSlopeSlideAngle((35 * Math.PI) / 180);
      this.controller.setApplyImpulsesToDynamicBodies(true);
    }
    this.vy = 0;
    this.jumpQueued = false;
    this.sync();
    this.history.reset(this.position);
  }

  private sync(): void {
    const t = this.body!.translation();
    this.position.set(t.x, t.y - HALF - RADIUS, t.z);
  }

  /** Every frame: mouse and right-stick look, and the movement intent the next steps will use. */
  look(dt: number, input: Input): void {
    this.yaw -= input.mouseDX * this.sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch - input.mouseDY * this.sensitivity, -1.5, 1.5);
    const gp = input.gamepad;
    let fx = 0, fz = 0;
    if (input.down('KeyW') || input.down('ArrowUp')) fz -= 1;
    if (input.down('KeyS') || input.down('ArrowDown')) fz += 1;
    if (input.down('KeyA') || input.down('ArrowLeft')) fx -= 1;
    if (input.down('KeyD') || input.down('ArrowRight')) fx += 1;
    if (gp) {
      const dz = (v: number) => (Math.abs(v) < 0.12 ? 0 : v);
      fx += dz(gp.axes[0] ?? 0);
      fz += dz(gp.axes[1] ?? 0);
      this.yaw -= dz(gp.axes[2] ?? 0) * 2.5 * dt;
      this.pitch = THREE.MathUtils.clamp(this.pitch - dz(gp.axes[3] ?? 0) * 2.0 * dt, -1.5, 1.5);
    }
    const len = Math.hypot(fx, fz);
    if (len > 1) { fx /= len; fz /= len; }
    this.fx = fx;
    this.fz = fz;
    this.run = input.down('ShiftLeft') || input.down('ShiftRight') || (gp?.buttons[10]?.pressed ?? false);
    if (input.hit('Space') || (gp?.buttons[0]?.pressed ?? false)) this.jumpQueued = true;
  }

  /** One fixed physics step of the walker: water, buoyancy, gravity and the character controller. */
  step(h: number): void {
    if (!this.body || !this.active) return;
    const t0 = this.body.translation();
    const feet = t0.y - HALF - RADIUS;
    const wq = this.water?.(t0.x, t0.z) ?? null;
    const ice = wq?.frozen ?? false;
    this.waterDepth = wq && !ice ? Math.max(0, wq.level - feet) : 0;
    this.swimming = this.waterDepth > 1.35;
    // Wading slows you down; deep water means swimming at the surface.
    const drag = THREE.MathUtils.clamp(1 - this.waterDepth * 0.45, 0.4, 1);
    let speed = (this.run ? this.runSpeed : this.walkSpeed) * drag;
    if (this.swimming) speed = this.run ? 1.7 : 1.0;
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const vx = (this.fx * c + this.fz * s) * speed;
    const vz = (-this.fx * s + this.fz * c) * speed;
    const jump = this.jumpQueued;
    this.jumpQueued = false;
    if (this.swimming && wq) {
      // Buoyancy: float with the eyes just above the surface; Space strokes upwards.
      const target = wq.level - 1.42;
      this.vy += ((target - feet) * 6 - this.vy * 2.5) * h;
      if (jump) this.vy = Math.max(this.vy, 1.6);
    } else {
      if (this.grounded && jump) this.vy = 4.6;
      this.vy -= 9.81 * h;
    }
    // Frozen water is walked on: a small plate collider follows the player at the ice surface.
    _move.x = t0.x; _move.z = t0.z;
    _move.y = ice && wq && feet > wq.level - 0.6 ? wq.level - 0.06 : -10000;
    this.icePlate.setTranslation(_move);
    _move.x = vx * h; _move.y = this.vy * h; _move.z = vz * h;
    this.controller.computeColliderMovement(this.collider, _move);
    const mv = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded();
    if (this.grounded && this.vy < 0) this.vy = -1;
    const t = this.body.translation();
    _move.x = t.x + mv.x; _move.y = t.y + mv.y; _move.z = t.z + mv.z;
    this.body.setNextKinematicTranslation(_move);
    // Safety: never fall through the world.
    if (t.y < -1000) this.vy = 0;
    this.position.set(t.x + mv.x, t.y + mv.y - HALF - RADIUS, t.z + mv.z);
    this.moving = this.grounded && !this.swimming ? Math.hypot(mv.x, mv.z) / Math.max(h, 1e-4) : 0;
    this.history.push(this.position);
  }

  /** Every frame: camera at the interpolated position (with head bob) and the current look. */
  render(camera: THREE.PerspectiveCamera, alpha: number, dt: number): void {
    this.history.sample(alpha, _pos);
    this.bob += this.moving * dt * 1.9;
    const bobY = Math.sin(this.bob * Math.PI) * 0.025 * Math.min(this.moving / 2, 1.5);
    camera.position.set(_pos.x, _pos.y + EYE + bobY, _pos.z);
    camera.quaternion.setFromEuler(_euler.set(this.pitch, this.yaw, 0, 'YXZ'));
  }
}
