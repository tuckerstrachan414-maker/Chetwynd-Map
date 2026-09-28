import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { FlightController, type Sticks } from './FlightModel';
import type { Physics } from './Physics';
import type { WaterQuery } from './Player';

const HALF = new THREE.Vector3(0.12, 0.035, 0.12);
const CRASH_FORCE = 260; // N of contact force (about a 4 m/s stop) that breaks props

/**
 * An FPV quad as a Rapier rigid body: the flight controller sets its body rates and thrust each
 * physics step; hard impacts disarm it (props broken) and it tumbles until respawned. The FPV
 * camera is fixed to the frame with an uptilt.
 */
export class Drone {
  readonly fc = new FlightController();
  body!: RAPIER.RigidBody;
  private collider!: RAPIER.Collider;
  armed = false;
  crashed = false;
  crashReason = '';
  flightTime = 0;
  readonly position = new THREE.Vector3();
  readonly quaternion = new THREE.Quaternion();
  readonly velocity = new THREE.Vector3();
  /** Camera uptilt (deg) and horizontal field of view (deg). */
  uptilt = 25;
  hfov = 120;
  water?: (x: number, z: number) => WaterQuery | null;
  readonly wind = new THREE.Vector3();
  private readonly queue = new RAPIER.EventQueue(true);
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tilt = new THREE.Quaternion();
  private shake = 0;
  lastOutput = 0;
  spawnPoint = new THREE.Vector3();
  spawnYaw = 0;

  constructor(private readonly physics: Physics) {}

  spawn(x: number, y: number, z: number, yaw: number): void {
    const w = this.physics.world;
    if (this.body) w.removeRigidBody(this.body);
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.body = w.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(x, y + HALF.y + 0.02, z)
        .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
        .setCcdEnabled(true)
        .setLinearDamping(0)
        .setAngularDamping(0.2),
    );
    this.collider = w.createCollider(
      RAPIER.ColliderDesc.cuboid(HALF.x, HALF.y, HALF.z)
        .setMass(this.fc.spec.mass)
        .setFriction(0.6)
        .setRestitution(0.25)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(CRASH_FORCE),
      this.body,
    );
    this.spawnPoint.set(x, y, z);
    this.spawnYaw = yaw;
    this.armed = true;
    this.crashed = false;
    this.crashReason = '';
    this.flightTime = 0;
    this.fc.rate.set(0, 0, 0);
    this.fc.battery.reset();
    this.sync();
  }

  respawn(): void {
    this.spawn(this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z, this.spawnYaw);
  }

  remove(): void {
    if (this.body) this.physics.world.removeRigidBody(this.body);
  }

  private sync(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    const v = this.body.linvel();
    this.position.set(t.x, t.y, t.z);
    this.quaternion.set(r.x, r.y, r.z, r.w);
    this.velocity.set(v.x, v.y, v.z);
  }

  private crash(reason: string): void {
    if (this.crashed) return;
    this.crashed = true;
    this.armed = false;
    this.crashReason = reason;
  }

  /** One physics substep: flight controller -> body, world step, crash checks. */
  step(h: number, sticks: Sticks): void {
    this.sync();
    const b = this.body;
    if (this.armed) {
      const o = this.fc.step(h, sticks, this.quaternion, this.velocity, this.wind, true);
      b.setAngvel({ x: o.angvel.x, y: o.angvel.y, z: o.angvel.z }, true);
      b.resetForces(true);
      b.addForce({ x: o.force.x, y: o.force.y, z: o.force.z }, true);
      this.lastOutput = o.output;
      this.flightTime += h;
      if (this.fc.battery.soc <= 0.02) this.crash('BATTERY EMPTY');
    } else {
      b.resetForces(true);
      this.lastOutput = 0;
      // Still let the pack recover while the frame tumbles.
      this.fc.battery.draw(0, h);
    }
    const prev = this.physics.world.timestep;
    this.physics.world.timestep = h;
    this.physics.world.step(this.queue);
    this.physics.world.timestep = prev;
    this.queue.drainContactForceEvents((e) => {
      if (e.collider1() === this.collider.handle || e.collider2() === this.collider.handle) {
        if (e.totalForceMagnitude() > CRASH_FORCE) this.crash('CRASH');
      }
    });
    this.sync();
    const wq = this.water?.(this.position.x, this.position.z);
    if (wq && !wq.frozen && this.position.y < wq.level + 0.02) {
      this.crash('SPLASHDOWN');
      // Water drag and a little buoyancy: the frame sinks slowly and stops.
      const v = b.linvel();
      b.setLinvel({ x: v.x * 0.9, y: Math.max(v.y * 0.8, -0.4), z: v.z * 0.9 }, true);
    }
  }

  /** Place the FPV camera: frame orientation, uptilt, vibration from the motors. */
  applyCamera(camera: THREE.PerspectiveCamera, dt: number, time: number): void {
    camera.position.copy(this.position).add(new THREE.Vector3(0, 0.03, -0.05).applyQuaternion(this.quaternion));
    this.tilt.setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(this.uptilt));
    camera.quaternion.copy(this.quaternion).multiply(this.tilt);
    // High-frequency frame vibration that grows with throttle (and a bent-prop buzz after hits).
    this.shake += (this.lastOutput - this.shake) * Math.min(1, dt * 10);
    const amp = 0.0012 * this.shake;
    if (amp > 0) {
      this.tmpQ.setFromEuler(new THREE.Euler(Math.sin(time * 173) * amp, Math.sin(time * 191 + 1) * amp * 0.5, Math.sin(time * 157 + 2) * amp));
      camera.quaternion.multiply(this.tmpQ);
    }
    const vfov = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(this.hfov / 2)) / camera.aspect));
    if (Math.abs(camera.fov - vfov) > 0.01) {
      camera.fov = vfov;
      camera.updateProjectionMatrix();
    }
  }

  /** Altitude above ground (m) and ground speed (km/h) for the OSD. */
  telemetry(ground: number): { alt: number; speed: number; volt: number; mah: number; amps: number; time: number } {
    const bat = this.fc.battery;
    return {
      alt: this.position.y - ground,
      speed: this.velocity.length() * 3.6,
      volt: bat.voltage,
      mah: bat.used,
      amps: bat.current,
      time: this.flightTime,
    };
  }
}
