import * as THREE from 'three';
import type { Post } from '../engine/Post';
import { Drone } from '../sim/Drone';
import type { FlyController } from '../sim/FlyController';
import type { Input } from '../sim/Input';
import type { Physics } from '../sim/Physics';
import { StickInput } from '../sim/StickInput';
import { Vehicle } from '../sim/Vehicle';
import { DroneOsd } from '../ui/DroneOsd';
import { Editor } from '../ui/Editor';
import { FpvSetup } from '../ui/FpvSetup';
import type { Hud } from '../ui/Hud';
import { PhotoMode } from '../ui/PhotoMode';
import { WEATHERS, type WeatherKind } from '../world/Weather';
import { SEASONS, type Season, type World } from './World';

export type Mode = 'walk' | 'fly' | 'drive' | 'drone' | 'photo' | 'edit';

/** Landmarks for the spawn menu (N): engine x, z and view yaw (deg, 0 = north, clockwise). */
export const LANDMARKS: { name: string; x: number; z: number; yaw: number }[] = [
  { name: "Carver's Row (chainsaw carvings)", x: -1034, z: -508, yaw: 0 },
  { name: 'Downtown: John Hart Hwy at 50th St', x: -880, z: -790, yaw: 75 },
  { name: 'Visitor Centre and carvings', x: -1385, z: -548, yaw: 200 },
  { name: 'Recreation Complex and library', x: 225, z: -440, yaw: 150 },
  { name: 'Windrem Creek Trail', x: 243, z: -314, yaw: 250 },
  { name: 'Centurion Creek Trail', x: 794, z: -615, yaw: 20 },
  { name: 'Rail yard (BCR / CN)', x: 560, z: -1540, yaw: 115 },
  { name: 'Little Prairie Heritage Museum', x: -2185, z: -130, yaw: 180 },
  { name: 'Pine River bridge, Hwy 29', x: 2990, z: 8500, yaw: 20 },
];

/** What the mode manager needs from the app. */
export interface ModeHost {
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  canvas: HTMLCanvasElement;
  ui: HTMLElement;
  world: World;
  physics: Physics;
  input: Input;
  hud: Hud;
  post: Post;
  fly: FlyController;
  /** Walker spawn at (x, z) with a yaw (rad). */
  spawnWalker(x: number, z: number, yaw: number): void;
  /** Freeze world time (photo mode). */
  setPaused(p: boolean): void;
}

const PHYS_DT = 1 / 120;

/**
 * Drive, FPV drone, photo and editor modes: owns their objects and UI, runs their physics at a
 * fixed 120 Hz substep, and switches the camera between them.
 */
export class Modes {
  readonly vehicle: Vehicle;
  readonly drone: Drone;
  readonly sticks = new StickInput();
  readonly osd: DroneOsd;
  readonly fpvSetup: FpvSetup;
  readonly photo: PhotoMode;
  readonly editor: Editor;
  private acc = 0;
  /** The walking/flying field of view (restored after the drone and photo mode). */
  baseFov: number;
  private readonly menu: HTMLDivElement;
  private prevButtons: boolean[] = [];

  constructor(private readonly h: ModeHost) {
    this.baseFov = h.camera.fov;
    this.vehicle = new Vehicle(h.physics, h.scene);
    this.drone = new Drone(h.physics);
    this.drone.water = (x, z) => h.world.water.sample(x, z);
    this.osd = new DroneOsd(h.ui);
    this.fpvSetup = new FpvSetup(h.ui);
    this.fpvSetup.onClose = (m) => {
      if (m) this.sticks.map = m;
    };
    const w = h.world;
    this.photo = new PhotoMode(h.ui, {
      seasons: SEASONS,
      weathers: WEATHERS,
      getSeason: () => w.season,
      setSeason: (s) => w.setSeason(s as Season),
      getWeather: () => w.weather.kind,
      setWeather: (k) => w.weather.set(k as WeatherKind, true),
      apply: (s) => {
        // Full-frame 36x24 mm: vertical field of view from the focal length.
        h.camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(12 / s.focal));
        h.camera.updateProjectionMatrix();
        h.post.settings.exposureComp = s.ev;
        h.post.settings.vignette = s.vignette;
        h.post.settings.grain = s.grain;
        h.post.dof = s.dof ? { focal: s.focal / 1000, aperture: s.aperture, focus: s.focus } : null;
        w.sky.hour = s.hour;
        this.photoRoll = THREE.MathUtils.degToRad(s.roll);
      },
      focusCentre: () => this.centreDistance(),
      capture: (scale) => this.capture(scale),
    }, { hour: w.sky.hour });
    this.editor = new Editor(h.ui, {
      camera: h.camera,
      dom: h.canvas,
      scene: h.scene,
      overrides: w.overrides,
      ground: (x, z) => w.groundHeight(x, z),
      pickables: (x, z, r) => [...w.props.pickables(x, z, r), ...w.forest.pickables(x, z, r), ...w.fences.pickables(x, z, r)],
    });
    this.menu = this.buildMenu();
  }

  private photoRoll = 0;
  /** FPV lens distortion (B toggles in the drone). */
  barrel = 0.32;
  /** Mode photo mode was entered from (the truck or drone stays in the shot). */
  photoFrom: Mode | null = null;

  private buildMenu(): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'spawnmenu hidden';
    const st = document.createElement('style');
    st.textContent = `.spawnmenu { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); background: rgba(14,17,22,0.9);
      color: #e8ecf2; border: 1px solid #2c3440; border-radius: 10px; padding: 14px 18px; font: 14px/1.5 system-ui, sans-serif; z-index: 18;
      width: min(380px, calc(100vw - 32px)); }
      .spawnmenu.hidden { display: none; } .spawnmenu h3 { margin: 0 0 8px; font-size: 15px; }
      .spawnmenu button { display: block; width: 100%; text-align: left; background: #212a36; color: inherit; border: 1px solid #333f50;
      border-radius: 6px; padding: 6px 10px; margin: 4px 0; font: inherit; cursor: pointer; } .spawnmenu button:hover { background: #2e5b88; }`;
    document.head.appendChild(st);
    el.innerHTML = '<h3>Go to (N to close)</h3>';
    LANDMARKS.forEach((l, i) => {
      const b = document.createElement('button');
      b.textContent = `${i + 1}. ${l.name}`;
      b.addEventListener('click', () => this.goto(i));
      el.appendChild(b);
    });
    this.h.ui.appendChild(el);
    return el;
  }

  get menuOpen(): boolean {
    return !this.menu.classList.contains('hidden');
  }

  toggleMenu(): void {
    const open = !this.menuOpen;
    this.menu.classList.toggle('hidden', !open);
    if (open) document.exitPointerLock?.();
  }

  goto(i: number): void {
    const l = LANDMARKS[i];
    if (!l) return;
    this.menu.classList.add('hidden');
    const yaw = THREE.MathUtils.degToRad(-l.yaw);
    const cam = this.h.camera;
    cam.position.set(l.x, cam.position.y, l.z);
    this.h.fly.yaw = yaw;
    this.h.fly.pitch = 0;
    this.h.spawnWalker(l.x, l.z, yaw);
  }

  /** Distance to the surface under the screen centre (terrain ray march). */
  private centreDistance(): number | null {
    const cam = this.h.camera;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    const p = new THREE.Vector3();
    let t = 0.3;
    for (let i = 0; i < 800 && t < 5000; i++) {
      p.copy(cam.position).addScaledVector(dir, t);
      const g = this.h.world.groundHeight(p.x, p.z);
      if (!Number.isFinite(g)) return null;
      if (p.y <= g) return t;
      t += Math.max(0.1, (p.y - g) * 0.3);
    }
    return null;
  }

  private async capture(scale: number): Promise<Blob | null> {
    const r = this.h.renderer;
    const pr = r.getPixelRatio();
    const size = r.getSize(new THREE.Vector2());
    r.setPixelRatio(pr * scale);
    r.setSize(size.x, size.y, false);
    this.h.post.setSize(Math.floor(size.x * pr * scale), Math.floor(size.y * pr * scale));
    this.h.post.render(this.h.scene, this.h.camera, 0, 0);
    const blob = await new Promise<Blob | null>((res) => this.h.canvas.toBlob(res, 'image/png'));
    r.setPixelRatio(pr);
    r.setSize(size.x, size.y, false);
    this.h.post.setSize(Math.floor(size.x * pr), Math.floor(size.y * pr));
    return blob;
  }

  /** Enter a mode; `from` is the mode being left. Returns the mode actually entered. */
  enter(m: Mode, from: Mode): Mode {
    const h = this.h;
    const cam = h.camera;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    if (m === 'photo') {
      // The world pauses as it is: a truck or drone stays in the frame.
      if (from === 'edit') this.leave('edit');
      if (from === 'drone') {
        this.osd.show(false);
        h.post.settings.barrel = 0;
      }
      this.photoFrom = from;
      h.setPaused(true);
      cam.up.set(0, 1, 0);
      h.fly.yaw = Math.atan2(-fwd.x, -fwd.z);
      h.fly.pitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
      h.fly.dragLook = true;
      this.photo.state.hour = h.world.sky.hour;
      this.photo.show(true);
      return m;
    }
    if (from === 'photo') {
      this.leave('photo');
      const back = this.photoFrom;
      this.photoFrom = null;
      if (m === back && (m === 'drive' || m === 'drone')) {
        if (m === 'drone') {
          this.osd.show(true);
          h.post.settings.barrel = this.barrel;
        }
        return m;
      }
      if (back === 'drive' || back === 'drone') this.leave(back);
    } else {
      this.leave(from);
    }
    cam.up.set(0, 1, 0);
    // Enter the new mode at the camera's ground position, facing the view direction.
    const heading = Math.atan2(-fwd.x, -fwd.z); // rotation about +Y from -Z
    const g = h.world.groundHeight(cam.position.x, cam.position.z);
    if (m === 'drive') {
      if (!Number.isFinite(g)) return from;
      const x = cam.position.x + fwd.x * 6, z = cam.position.z + fwd.z * 6;
      h.physics.updateTerrain(h.world.store, x, z, 250);
      // Chassis +X is forward: yaw it so +X points along the view.
      this.vehicle.spawn(x, h.world.groundHeight(x, z), z, heading + Math.PI / 2);
      this.vehicle.camYaw = 0;
    } else if (m === 'drone') {
      if (!Number.isFinite(g)) return from;
      const x = cam.position.x + fwd.x * 2, z = cam.position.z + fwd.z * 2;
      h.physics.updateTerrain(h.world.store, x, z, 250);
      this.drone.spawn(x, h.world.groundHeight(x, z), z, heading);
      this.sticks.setKeyboardThrottle(0);
      this.osd.show(true);
      h.post.settings.barrel = this.barrel;
    } else if (m === 'edit') {
      h.fly.yaw = Math.atan2(-fwd.x, -fwd.z);
      h.fly.pitch = Math.asin(THREE.MathUtils.clamp(fwd.y, -1, 1));
      h.fly.dragLook = true;
      if (cam.position.y < g + 12) cam.position.y = g + 12;
      this.editor.setActive(true);
    }
    return m;
  }

  /** Clean up a mode being left; the camera is left where the next mode should start. */
  private leave(m: Mode): void {
    const h = this.h;
    const cam = h.camera;
    if (m === 'drive' && this.vehicle.active) {
      // Step out on the driver's side, facing the way the truck points.
      const v = this.vehicle;
      const side = new THREE.Vector3(-0.3, 0, -2.3).applyQuaternion(v.quaternion).add(v.position);
      const f = new THREE.Vector3(1, 0, 0).applyQuaternion(v.quaternion);
      cam.position.set(side.x, cam.position.y, side.z);
      cam.up.set(0, 1, 0);
      cam.lookAt(cam.position.x + f.x, cam.position.y, cam.position.z + f.z);
      v.remove();
      h.world.setHeadlights(null, 0);
    } else if (m === 'drone') {
      // Back to the pilot, standing behind the launch spot.
      const d = this.drone;
      const f = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), d.spawnYaw);
      cam.position.set(d.spawnPoint.x - f.x * 2, cam.position.y, d.spawnPoint.z - f.z * 2);
      cam.fov = this.baseFov;
      cam.updateProjectionMatrix();
      cam.up.set(0, 1, 0);
      cam.lookAt(cam.position.x + f.x, cam.position.y, cam.position.z + f.z);
      d.remove();
      this.osd.show(false);
      h.post.settings.barrel = 0;
    } else if (m === 'photo') {
      this.photo.show(false);
      h.setPaused(false);
      h.post.dof = null;
      h.post.settings.exposureComp = 0;
      h.post.settings.vignette = 0.22;
      h.post.settings.grain = 0.004;
      this.photoRoll = 0;
      h.fly.dragLook = false;
      cam.fov = this.baseFov;
      cam.updateProjectionMatrix();
    } else if (m === 'edit') {
      this.editor.setActive(false);
      h.fly.dragLook = false;
    }
  }

  /** Per-frame work of the active mode (before the world update). */
  update(mode: Mode, dt: number, time: number): void {
    const h = this.h;
    const input = h.input;
    if (mode === 'drive') {
      const v = this.vehicle;
      v.grip = { snow: h.world.season === 'winter', wet: h.world.weather.wetness };
      v.controls(input, dt);
      h.physics.updateTerrain(h.world.store, v.position.x, v.position.z, 250);
      h.physics.updateTrunks(h.world.forest.treesNear(v.position.x, v.position.z, 45), v.position.x, v.position.z);
      this.acc += dt;
      let n = 0;
      while (this.acc >= PHYS_DT && n < 8) {
        v.step(PHYS_DT);
        this.acc -= PHYS_DT;
        n++;
      }
      if (n === 8) this.acc = 0;
      v.render(h.camera, dt, (x, z) => h.world.groundHeight(x, z), h.world.sky.night);
      h.world.setHeadlights(v.model.root, h.world.sky.night);
      if (input.hit('KeyR')) this.enter('drive', 'drive');
      h.world.playerFeet = v.position;
    } else if (mode === 'drone') {
      const d = this.drone;
      if (input.hit('KeyK')) this.fpvSetup.open();
      if (this.fpvSetup.visible) return;
      const s = this.sticks.update(input, dt);
      const gp = input.gamepad;
      const pressed = gp ? gp.buttons.map((b) => b.pressed) : [];
      const edge = (i: number) => i >= 0 && pressed[i] && !this.prevButtons[i];
      const map = this.sticks.map;
      if (input.hit('KeyM') || (gp && edge(map?.mode ?? 2))) d.fc.mode = d.fc.mode === 'acro' ? 'angle' : 'acro';
      if (input.hit('KeyB')) {
        this.barrel = this.barrel > 0 ? 0 : 0.32;
        h.post.settings.barrel = this.barrel;
      }
      if (input.hit('KeyR') || (gp && edge(map?.reset ?? 3))) {
        d.respawn();
        this.sticks.setKeyboardThrottle(0);
      }
      this.prevButtons = pressed;
      d.wind.set(h.world.weather.wind.x, 0, h.world.weather.wind.y).multiplyScalar(0.8);
      h.physics.updateTerrain(h.world.store, d.position.x, d.position.z, 200);
      h.physics.updateTrunks(h.world.forest.treesNear(d.position.x, d.position.z, 45), d.position.x, d.position.z);
      this.acc += dt;
      let n = 0;
      while (this.acc >= PHYS_DT && n < 10) {
        d.step(PHYS_DT, s);
        this.acc -= PHYS_DT;
        n++;
      }
      if (n === 10) this.acc = 0;
      d.applyCamera(h.camera, dt, time);
      const e = new THREE.Euler().setFromQuaternion(d.quaternion, 'YXZ');
      const tel = d.telemetry(h.world.groundHeight(d.position.x, d.position.z));
      this.osd.update({
        ...tel, cells: d.fc.spec.cells, throttle: s.throttle, mode: d.fc.mode.toUpperCase(), roll: e.z, pitch: e.x,
        uptilt: THREE.MathUtils.degToRad(d.uptilt), pxPerRad: h.canvas.clientHeight / THREE.MathUtils.degToRad(h.camera.fov),
        warning: d.crashed ? `${d.crashReason}  -  R TO RESET` : '', source: this.sticks.source,
      }, dt);
      h.world.playerFeet = d.position.y - h.world.groundHeight(d.position.x, d.position.z) < 2 ? d.position : null;
    } else if (mode === 'photo') {
      if (input.hit('KeyH')) this.photo.togglePanel();
      h.fly.update(dt);
      if (this.photoRoll) h.camera.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.photoRoll));
    } else if (mode === 'edit') {
      h.fly.update(dt);
      const g = h.world.groundHeight(h.camera.position.x, h.camera.position.z);
      if (Number.isFinite(g) && h.camera.position.y < g + 0.6) h.camera.position.y = g + 0.6;
      this.editor.update(dt);
    }
  }

  status(mode: Mode): string {
    if (mode === 'drive') {
      const v = this.vehicle;
      return `${Math.abs(Math.round(v.kmh))} km/h · ${v.gear < 0 ? 'R' : `D${v.gear}`} · ${Math.round(v.rpm)} rpm · ${v.camMode} cam (C)`;
    }
    return '';
  }
}
