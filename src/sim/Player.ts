import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Input } from './Input';
import type { Physics } from './Physics';

const RADIUS = 0.3;
const HALF = 0.6;
const EYE = 1.68;

/** First-person walker using Rapier's kinematic character controller. */
export class Player {
  yaw = 0;
  pitch = 0;
  private body!: RAPIER.RigidBody;
  private collider!: RAPIER.Collider;
  private controller!: RAPIER.KinematicCharacterController;
  private vy = 0;
  private grounded = false;
  private bob = 0;
  readonly position = new THREE.Vector3();
  walkSpeed = 1.6;
  runSpeed = 4.2;
  sensitivity = 0.0022;

  constructor(private readonly physics: Physics) {}

  spawn(x: number, groundY: number, z: number): void {
    const w = this.physics.world;
    if (this.body) w.removeRigidBody(this.body);
    this.body = w.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, groundY + HALF + RADIUS + 0.05, z));
    this.collider = w.createCollider(RAPIER.ColliderDesc.capsule(HALF, RADIUS), this.body);
    if (!this.controller) {
      this.controller = w.createCharacterController(0.02);
      this.controller.enableAutostep(0.4, 0.2, true);
      this.controller.enableSnapToGround(0.5);
      this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
      this.controller.setMinSlopeSlideAngle((35 * Math.PI) / 180);
      this.controller.setApplyImpulsesToDynamicBodies(true);
    }
    this.vy = 0;
    this.sync();
  }

  private sync(): void {
    const t = this.body.translation();
    this.position.set(t.x, t.y - HALF - RADIUS, t.z);
  }

  update(dt: number, input: Input, camera: THREE.PerspectiveCamera): void {
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
    const run = input.down('ShiftLeft') || input.down('ShiftRight') || (gp?.buttons[10]?.pressed ?? false);
    const speed = run ? this.runSpeed : this.walkSpeed;
    const len = Math.hypot(fx, fz);
    if (len > 1) { fx /= len; fz /= len; }
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const vx = (fx * c + fz * s) * speed;
    const vz = (-fx * s + fz * c) * speed;
    if (this.grounded && (input.hit('Space') || (gp?.buttons[0]?.pressed ?? false))) this.vy = 4.6;
    this.vy -= 9.81 * dt;
    const desired = { x: vx * dt, y: this.vy * dt, z: vz * dt };
    this.controller.computeColliderMovement(this.collider, desired);
    const mv = this.controller.computedMovement();
    this.grounded = this.controller.computedGrounded();
    if (this.grounded && this.vy < 0) this.vy = -1;
    const t = this.body.translation();
    this.body.setNextKinematicTranslation({ x: t.x + mv.x, y: t.y + mv.y, z: t.z + mv.z });
    // Safety: never fall through the world.
    if (t.y < -1000) this.vy = 0;
    this.position.set(t.x + mv.x, t.y + mv.y - HALF - RADIUS, t.z + mv.z);
    const moving = this.grounded ? Math.hypot(mv.x, mv.z) / Math.max(dt, 1e-4) : 0;
    this.bob += moving * dt * 1.9;
    const bobY = Math.sin(this.bob * Math.PI) * 0.025 * Math.min(moving / 2, 1.5);
    camera.position.set(this.position.x, this.position.y + EYE + bobY, this.position.z);
    camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }
}
