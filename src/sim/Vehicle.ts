import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { buildPickup, PICKUP, type PickupParts } from '../world/vehicle/PickupModel';
import type { Input } from './Input';
import type { Physics } from './Physics';

/** Driving surface grip (tyre friction slip) by season/weather. */
export interface GripState {
  snow: boolean;
  wet: number;
}

export type DriveCam = 'chase' | 'hood' | 'bumper';

/**
 * Drivable pickup: Rapier ray-cast vehicle with 4x4 drive, a torque curve through an automatic
 * gearbox, speed-sensitive steering, brakes and a handbrake, plus chase / hood / bumper cameras.
 */
export class Vehicle {
  readonly model: PickupParts;
  body!: RAPIER.RigidBody;
  private ctrl!: RAPIER.DynamicRayCastVehicleController;
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  speed = 0; // m/s along the chassis forward axis
  rpm = 800;
  gear = 1;
  steer = 0;
  throttle = 0;
  brake = 0;
  camMode: DriveCam = 'chase';
  private spin = [0, 0, 0, 0];
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private camInit = false;
  camYaw = 0;
  camPitch = 0.12;
  grip: GripState = { snow: false, wet: 0 };

  constructor(private readonly physics: Physics, scene: THREE.Object3D) {
    this.model = buildPickup();
    this.model.root.visible = false;
    scene.add(this.model.root);
  }

  get active(): boolean {
    return !!this.body;
  }

  spawn(x: number, groundY: number, z: number, yaw: number): void {
    this.remove();
    const w = this.physics.world;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body = w.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, groundY + PICKUP.rideY + 0.25, z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setCcdEnabled(true)
        .setAngularDamping(0.4)
        .setLinearDamping(0.02),
    );
    // Chassis: lower body box plus the cab. Mass sits low (engine, frame, axles).
    const lower = RAPIER.ColliderDesc.cuboid(2.95, 0.4, PICKUP.width / 2 - 0.02)
      .setTranslation(0, -0.1, 0)
      .setMassProperties(PICKUP.mass, { x: 0.15, y: -0.25, z: 0 }, { x: 1300, y: 5200, z: 5000 }, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.5);
    const cab = RAPIER.ColliderDesc.cuboid(0.95, 0.32, PICKUP.width / 2 - 0.12).setTranslation(0, 0.66, 0).setDensity(0).setFriction(0.5);
    w.createCollider(lower, this.body);
    w.createCollider(cab, this.body);
    this.ctrl = w.createVehicleController(this.body);
    const rest = 0.34;
    for (const [x, zs] of [[PICKUP.frontX, 1], [PICKUP.frontX, -1], [PICKUP.rearX, 1], [PICKUP.rearX, -1]] as const) {
      this.ctrl.addWheel({ x, y: -0.25, z: (zs * PICKUP.track) / 2 }, { x: 0, y: -1, z: 0 }, { x: 0, y: 0, z: 1 }, rest, PICKUP.wheelR);
    }
    for (let i = 0; i < 4; i++) {
      this.ctrl.setWheelSuspensionStiffness(i, 26);
      this.ctrl.setWheelSuspensionCompression(i, 4.2);
      this.ctrl.setWheelSuspensionRelaxation(i, 5.2);
      this.ctrl.setWheelMaxSuspensionTravel(i, 0.22);
      this.ctrl.setWheelMaxSuspensionForce(i, 90000);
      this.ctrl.setWheelSideFrictionStiffness(i, 1.0);
    }
    this.model.root.visible = true;
    this.camInit = false;
    this.gear = 1;
    this.sync();
  }

  remove(): void {
    if (!this.body) return;
    const w = this.physics.world;
    w.removeVehicleController(this.ctrl);
    w.removeRigidBody(this.body);
    this.body = undefined as unknown as RAPIER.RigidBody;
    this.model.root.visible = false;
  }

  private sync(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
  }

  /** Engine torque (N m) at rpm: a V8 with a broad plateau. */
  private torque(rpm: number): number {
    const r = THREE.MathUtils.clamp(rpm, 700, 6000);
    return 380 + 180 * Math.sin(Math.PI * THREE.MathUtils.clamp((r - 700) / 4600, 0, 1)) - (r > 5600 ? (r - 5600) * 0.8 : 0);
  }

  controls(input: Input, dt: number): void {
    const gp = input.gamepad;
    let thr = input.down('KeyW') || input.down('ArrowUp') ? 1 : 0;
    let brk = input.down('KeyS') || input.down('ArrowDown') ? 1 : 0;
    let st = (input.down('KeyA') || input.down('ArrowLeft') ? 1 : 0) - (input.down('KeyD') || input.down('ArrowRight') ? 1 : 0);
    let hand = input.down('Space');
    if (gp) {
      const rt = gp.buttons[7]?.value ?? 0;
      const lt = gp.buttons[6]?.value ?? 0;
      thr = Math.max(thr, rt);
      brk = Math.max(brk, lt);
      const ax = gp.axes[0] ?? 0;
      if (Math.abs(ax) > 0.08) st = -ax;
      hand = hand || (gp.buttons[0]?.pressed ?? false);
      // Right stick orbits the chase camera.
      const rx = gp.axes[2] ?? 0, ry = gp.axes[3] ?? 0;
      if (Math.abs(rx) > 0.15) this.camYaw -= rx * dt * 2.2;
      if (Math.abs(ry) > 0.15) this.camPitch = THREE.MathUtils.clamp(this.camPitch + ry * dt * 1.5, -0.2, 1.2);
    }
    this.camYaw -= input.mouseDX * 0.003;
    this.camPitch = THREE.MathUtils.clamp(this.camPitch + input.mouseDY * 0.002, -0.2, 1.2);
    if (!input.mouseDX && !gp) this.camYaw *= Math.exp(-dt * 1.2); // drift back behind the truck
    // Steering rate-limited and reduced with speed (about 35 deg lock at a stop, 6 deg at 100 km/h).
    const maxSteer = THREE.MathUtils.lerp(0.62, 0.1, THREE.MathUtils.clamp(Math.abs(this.speed) / 28, 0, 1));
    const target = st * maxSteer;
    this.steer += THREE.MathUtils.clamp(target - this.steer, -dt * 1.8, dt * 1.8);
    // S brakes while rolling forward, then engages reverse.
    if (this.gear > 0 && brk > 0 && this.speed < 0.6 && thr === 0) this.gear = -1;
    else if (this.gear < 0 && thr > 0 && this.speed > -0.6) this.gear = 1;
    if (this.gear < 0) [thr, brk] = [brk, thr];
    this.throttle = thr;
    this.brake = brk;
    this.handbrake = hand;
    if (input.hit('KeyC')) this.camMode = this.camMode === 'chase' ? 'hood' : this.camMode === 'hood' ? 'bumper' : 'chase';
  }

  handbrake = false;

  /** One physics substep. */
  step(h: number): void {
    const c = this.ctrl;
    this.sync();
    this.speed = c.currentVehicleSpeed();
    // Automatic 10-speed: pick the gear that keeps the engine near its plateau.
    const ratios = [4.7, 2.99, 2.15, 1.77, 1.52, 1.28, 1.0, 0.85, 0.69, 0.64];
    const final = 3.55;
    const wheelRps = Math.abs(this.speed) / (2 * Math.PI * PICKUP.wheelR);
    let force: number;
    if (this.gear > 0) {
      let g = this.gear;
      const rpmAt = (k: number) => wheelRps * ratios[k - 1] * final * 60;
      while (g < ratios.length && rpmAt(g) > 2600 + 2400 * this.throttle) g++;
      while (g > 1 && rpmAt(g - 1) < 1500 + 1500 * this.throttle) g--;
      this.gear = g;
      this.rpm = Math.max(750 + 900 * this.throttle, rpmAt(g));
      force = (this.torque(this.rpm) * ratios[g - 1] * final * 0.88 * this.throttle) / PICKUP.wheelR;
    } else {
      this.rpm = Math.max(750 + 900 * this.throttle, wheelRps * 4.87 * final * 60);
      force = -(this.torque(this.rpm) * 4.87 * final * 0.88 * this.throttle) / PICKUP.wheelR;
      if (this.speed < -8) force = 0;
    }
    // Rev limiter and top speed (~180 km/h).
    if (this.rpm > 6000 || this.speed > 50) force = 0;
    const slip = this.grip.snow ? 0.55 : THREE.MathUtils.lerp(2.3, 1.45, this.grip.wet);
    for (let i = 0; i < 4; i++) {
      c.setWheelEngineForce(i, force / 4);
      const b = this.brake * 3800 + (this.throttle === 0 ? 60 : 0);
      c.setWheelBrake(i, i >= 2 && this.handbrake ? 5200 : b);
      c.setWheelSteering(i, i < 2 ? this.steer : 0);
      // Handbrake locks the rear axle: rear grip drops so the tail can slide.
      c.setWheelFrictionSlip(i, i >= 2 && this.handbrake ? slip * 0.45 : slip);
    }
    c.updateVehicle(h);
    const prev = this.physics.world.timestep;
    this.physics.world.timestep = h;
    this.physics.world.step();
    this.physics.world.timestep = prev;
    this.sync();
    for (let i = 0; i < 4; i++) this.spin[i] -= (this.speed * h) / PICKUP.wheelR;
  }

  /** Pose the model (wheels on the suspension) and place the camera. */
  render(camera: THREE.PerspectiveCamera, dt: number, groundAt: (x: number, z: number) => number, night: number): void {
    const m = this.model;
    m.root.position.copy(this.position);
    m.root.quaternion.copy(this.quaternion);
    const c = this.ctrl;
    for (let i = 0; i < 4; i++) {
      const w = m.wheels[i];
      const len = c.wheelSuspensionLength(i) ?? 0.24;
      const conn = c.wheelChassisConnectionPointCs(i);
      if (conn) w.position.set(conn.x, conn.y - len, conn.z);
      w.rotation.set(0, c.wheelSteering(i) ?? 0, 0);
      (w.children[0] as THREE.Object3D).rotation.z = this.spin[i];
    }
    // Head lamps at dusk; brake lamps bright when braking.
    m.headMat.emissiveIntensity = THREE.MathUtils.smoothstep(night, 0.2, 0.6) * 30 + 0.3;
    m.tailMat.emissiveIntensity = (this.brake > 0.05 ? 18 : 0) + THREE.MathUtils.smoothstep(night, 0.2, 0.6) * 6;

    const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(this.quaternion);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion);
    if (this.camMode === 'chase') {
      const yaw = Math.atan2(-fwd.z, fwd.x) + this.camYaw + Math.PI;
      const dist = 8.5;
      const want = new THREE.Vector3(
        this.position.x + Math.cos(yaw) * Math.cos(this.camPitch) * dist,
        this.position.y + 1.2 + Math.sin(this.camPitch) * dist,
        this.position.z - Math.sin(yaw) * Math.cos(this.camPitch) * dist,
      );
      const g = groundAt(want.x, want.z);
      if (Number.isFinite(g)) want.y = Math.max(want.y, g + 0.5);
      const look = this.position.clone().add(new THREE.Vector3(0, 1.1, 0));
      const k = this.camInit ? 1 - Math.exp(-dt * 8) : 1;
      this.camPos.lerp(want, k);
      this.camLook.lerp(look, this.camInit ? 1 - Math.exp(-dt * 14) : 1);
      this.camInit = true;
      camera.position.copy(this.camPos);
      camera.up.set(0, 1, 0);
      camera.lookAt(this.camLook);
    } else {
      const off = this.camMode === 'hood' ? new THREE.Vector3(0.55, 0.62, -0.38) : new THREE.Vector3(3.05, -0.38, 0);
      camera.position.copy(off.applyQuaternion(this.quaternion).add(this.position));
      camera.up.copy(up);
      camera.lookAt(camera.position.clone().add(fwd));
      this.camInit = false;
    }
  }

  get kmh(): number {
    return this.speed * 3.6;
  }
}
