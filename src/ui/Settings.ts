import { QUALITY_LEVELS, type QualityLevel } from '../engine/Quality';

/** What the settings panel changes in the app. */
export interface SettingsHost {
  quality: QualityLevel;
  gpu: string;
  setQuality(q: QualityLevel): void;
  fov: number;
  setFov(deg: number): void;
  sensitivity: number;
  setSensitivity(s: number): void;
}

const CSS = `
.settings { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(460px, calc(100vw - 32px));
  max-height: calc(100vh - 32px); overflow: auto; background: rgba(14,17,22,0.92); color: #e8ecf2; border: 1px solid #2c3440;
  border-radius: 12px; padding: 16px 20px; font: 14px/1.5 system-ui, sans-serif; z-index: 25; }
.settings.hidden { display: none; }
.settings h3 { margin: 0 0 10px; font-size: 16px; } .settings h4 { margin: 14px 0 6px; font-size: 13px; letter-spacing: 0.5px; opacity: 0.8; }
.settings .q { display: flex; gap: 6px; flex-wrap: wrap; }
.settings button { background: #212a36; color: inherit; border: 1px solid #333f50; border-radius: 6px; padding: 5px 12px; font: inherit; cursor: pointer; }
.settings button.on { background: #2e5b88; border-color: #4b82b8; }
.settings .r { display: grid; grid-template-columns: 130px 1fr 44px; gap: 8px; align-items: center; margin: 6px 0; }
.settings input[type=range] { width: 100%; }
.settings small, .settings .credits { opacity: 0.75; font-size: 12px; }
.settings .credits p { margin: 4px 0; }
.settings a { color: #8cc4ff; }
`;

/** Settings (O): quality level, field of view, mouse sensitivity, benchmark, credits. */
export class Settings {
  readonly el: HTMLDivElement;

  constructor(parent: HTMLElement, private readonly host: SettingsHost) {
    if (!document.getElementById('settings-style')) {
      const st = document.createElement('style');
      st.id = 'settings-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.el = document.createElement('div');
    this.el.className = 'settings hidden';
    this.el.innerHTML = `<h3>Settings</h3>
      <h4>GRAPHICS QUALITY</h4><div class="q"></div>
      <small class="gpu"></small>
      <h4>VIEW</h4>
      <div class="r"><span>Field of view</span><input class="fov" type="range" min="50" max="100" step="1"><span class="fovv"></span></div>
      <div class="r"><span>Mouse sensitivity</span><input class="sens" type="range" min="0.2" max="3" step="0.05"><span class="sensv"></span></div>
      <h4>PERFORMANCE</h4>
      <p><a class="bench" href="?bench">Run the benchmark</a> <small>(a 70 s flight; reports average and 1% low FPS)</small></p>
      <h4>CREDITS</h4>
      <div class="credits">
        <p>LiDAR: LidarBC, Province of British Columbia (Open Government Licence – BC). Horizon terrain: NRCan MRDEM-30 (Open Government Licence – Canada).</p>
        <p>Map data © OpenStreetMap contributors (ODbL) and Overture Maps Foundation (ODbL / CDLA Permissive 2.0).</p>
        <p>Contains modified Copernicus Sentinel data 2025. Carving locations: District of Chetwynd Chainsaw Carving Tour Map.</p>
        <p>Textures: Poly Haven and ambientCG (CC0); birch bark from ez-tree (MIT). Physics: Rapier. Rendering: three.js.</p>
      </div>
      <p><button class="close">Close (O)</button></p>`;
    parent.appendChild(this.el);
    const q = this.el.querySelector('.q')!;
    for (const level of QUALITY_LEVELS) {
      const b = document.createElement('button');
      b.textContent = level[0].toUpperCase() + level.slice(1);
      b.dataset.level = level;
      b.addEventListener('click', () => {
        this.host.setQuality(level);
        this.sync();
      });
      q.appendChild(b);
    }
    const fov = this.el.querySelector('.fov') as HTMLInputElement;
    const sens = this.el.querySelector('.sens') as HTMLInputElement;
    fov.addEventListener('input', () => {
      this.host.setFov(Number(fov.value));
      this.sync();
    });
    sens.addEventListener('input', () => {
      this.host.setSensitivity(Number(sens.value));
      this.sync();
    });
    this.el.querySelector('.close')!.addEventListener('click', () => this.toggle(false));
    this.sync();
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }

  toggle(on = !this.visible): void {
    this.el.classList.toggle('hidden', !on);
    if (on) {
      document.exitPointerLock?.();
      this.sync();
    }
  }

  private sync(): void {
    const h = this.host;
    this.el.querySelectorAll<HTMLButtonElement>('.q button').forEach((b) => b.classList.toggle('on', b.dataset.level === h.quality));
    (this.el.querySelector('.gpu') as HTMLElement).textContent = `GPU: ${h.gpu}. Anti-aliasing changes apply after reloading the page.`;
    (this.el.querySelector('.fov') as HTMLInputElement).value = String(h.fov);
    (this.el.querySelector('.fovv') as HTMLElement).textContent = `${Math.round(h.fov)}°`;
    (this.el.querySelector('.sens') as HTMLInputElement).value = String(h.sensitivity);
    (this.el.querySelector('.sensv') as HTMLElement).textContent = h.sensitivity.toFixed(2);
  }
}
