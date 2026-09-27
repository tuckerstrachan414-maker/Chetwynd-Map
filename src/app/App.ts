import * as THREE from 'three';

/** Top-level application: owns renderer, scene, camera and the frame loop. */
export class App {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 60000);
  private readonly clock = new THREE.Clock();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ui: HTMLElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x8fb3d9);
    window.addEventListener('resize', () => this.resize());
  }

  async start(): Promise<void> {
    this.resize();
    this.ui.dataset.state = 'ready';
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    this.clock.getDelta();
    this.renderer.render(this.scene, this.camera);
  }
}
