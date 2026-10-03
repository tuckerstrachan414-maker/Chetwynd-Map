import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { PoseHistory } from './FixedStep';
import { FlightController, type Sticks } from './FlightModel';
import type { Physics } from './Physics';
import type { WaterQuery } from './Player';

const HALF = new THREE.Vector3(0.12, 0.035, 0.12);
const CRASH_FORCE = 260; // N of contact force (about a 4 m/s stop) that breaks props

const _camOff = new THREE.Vector3();
const _xAxis = new THREE.Vector3(1, 0, 0);
const _yAxis = new THREE.Vector3(0, 1, 0);
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _v = { x: 0, y: 0, z: 0 };
const _r = { x: 0, y: 0, z: 0, w: 1 };

/**
 * An FPV quad as a Rapier rigid body: the flight controller sets its body rates and thrust each
 * physics step; hard impacts disarm it (props broken) and it tumbles until respawned. The FPV
 * camera is fixed to the frame with an uptilt, at the pose interpolated between the last two physics
 * substeps. The body is made once and parked (disabled) between flights.
 */
export class Drone {
  readonly fc = new FlightController();
  body!: RAPIER.RigidBody;
  private collider!: RAPIER.Collider;
  private readonly history = new PoseHistory();
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
    const q = _quat.setFromAxisAngle(_yAxis, yaw);
    if (this.body) {
      // Reuse the parked frame: place it, stop it, wake it.
      _v.x = x; _v.y = y + HALF.y + 0.02; _v.z = z;
      _r.x = q.x; _r.y = q.y; _r.z = q.z; _r.w = q.w;
      this.body.setEnabled(true);
      this.body.setTranslation(_v, true);
      this.body.setRotation(_r, true);
      _v.x = 0; _v.y = 0; _v.z = 0;
      this.body.setLinvel(_v, true);
      this.body.setAngvel(_v, true);
      this.body.resetForces(true);
      this.body.resetTorques(true);
    } else {
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
    }
    this.spawnPoint.set(x, y, z);
    this.spawnYaw = yaw;
    this.armed = true;
    this.crashed = false;
    this.crashReason = '';
    this.flightTime = 0;
    this.fc.rate.set(0, 0, 0);
    this.fc.battery.reset();
    this.sync();
    this.history.reset(this.position, this.quaternion);
  }

  respawn(): void {
    this.spawn(this.spawnPoint.x, this.spawnPoint.y, this.spawnPoint.z, this.spawnYaw);
  }

  /** Park the frame (disabled, kept for the next flight). */
  remove(): void {
    this.body?.setEnabled(false);
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
    this.physics.step(h, this.queue);
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
      _v.x = v.x * 0.9; _v.y = Math.max(v.y * 0.8, -0.4); _v.z = v.z * 0.9;
      b.setLinvel(_v, true);
      this.sync();
    }
    this.history.push(this.position, this.quaternion);
  }

  /**
   * Place the FPV camera at the frame pose interpolated `alpha` of the way between the last two physics
   * substeps: frame orientation, uptilt, vibration from the motors.
   */
  applyCamera(camera: THREE.PerspectiveCamera, dt: number, time: number, alpha = 1): void {
    this.history.sample(alpha, _pos, _quat);
    camera.position.copy(_pos).add(_camOff.set(0, 0.03, -0.05).applyQuaternion(_quat));
    this.tilt.setFromAxisAngle(_xAxis, THREE.MathUtils.degToRad(this.uptilt));
    camera.quaternion.copy(_quat).multiply(this.tilt);
    // High-frequency frame vibration that grows with throttle (and a bent-prop buzz after hits).
    this.shake += (this.lastOutput - this.shake) * Math.min(1, dt * 10);
    const amp = 0.0012 * this.shake;
    if (amp > 0) {
      this.tmpQ.setFromEuler(_euler.set(Math.sin(time * 173) * amp, Math.sin(time * 191 + 1) * amp * 0.5, Math.sin(time * 157 + 2) * amp));
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
