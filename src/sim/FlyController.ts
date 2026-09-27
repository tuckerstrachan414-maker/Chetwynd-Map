import * as THREE from 'three';

/** Free-flying debug camera: mouse look (pointer lock), WASD + Q/E, Shift to speed up. */
export class FlyController {
  yaw = 0;
  pitch = 0;
  speed = 12;
  private readonly keys = new Set<string>();
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  enabled = true;
  /** Look by dragging with the right mouse button instead of pointer lock (editor, photo mode). */
  dragLook = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
  ) {
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    dom.addEventListener('click', () => {
      if (this.enabled && !this.dragLook && document.pointerLockElement !== dom) dom.requestPointerLock?.();
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (this.dragLook ? (e.buttons & 2) === 0 : document.pointerLockElement !== dom) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.55, 1.55);
    });
    dom.addEventListener('wheel', (e) => {
      this.speed = THREE.MathUtils.clamp(this.speed * (e.deltaY > 0 ? 0.85 : 1.18), 1, 3000);
    });
  }

  update(dt: number): void {
    this.euler.set(this.pitch, this.yaw, 0);
    this.camera.quaternion.setFromEuler(this.euler);
    if (!this.enabled) return;
    const v = new THREE.Vector3();
    if (this.keys.has('KeyW')) v.z -= 1;
    if (this.keys.has('KeyS')) v.z += 1;
    if (this.keys.has('KeyA')) v.x -= 1;
    if (this.keys.has('KeyD')) v.x += 1;
    if ((!this.dragLook && this.keys.has('KeyE')) || this.keys.has('Space')) v.y += 1;
    if ((!this.dragLook && this.keys.has('KeyQ')) || this.keys.has('ControlLeft')) v.y -= 1;
    if (v.lengthSq() === 0) return;
    const boost = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 5 : 1;
    v.normalize().multiplyScalar(this.speed * boost * dt);
    v.applyQuaternion(this.camera.quaternion);
    this.camera.position.add(v);
  }
}
