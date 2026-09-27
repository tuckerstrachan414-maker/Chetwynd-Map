import * as THREE from 'three';
import { type EditItem, type EditKind, type Overrides, type OverridesDoc } from '../world/Overrides';

/** Something the editor can select: an original or user-added object near the camera. */
export interface Pickable {
  kind: EditKind;
  ref: string; // "kind@x_z" of an original, "#id" of a user-added object
  x: number;
  y: number;
  z: number;
  rot: number;
  h: number; // height used for picking (trees: real height)
  r: number; // picking radius
  src: 'mapped' | 'inferred' | 'user';
  sp?: number;
  variant?: number;
}

export interface EditorHost {
  camera: THREE.PerspectiveCamera;
  dom: HTMLElement;
  scene: THREE.Scene;
  overrides: Overrides;
  ground(x: number, z: number): number;
  pickables(x: number, z: number, radius: number): Pickable[];
}

interface Tool {
  id: string;
  label: string;
  kind?: EditKind;
  sp?: number;
  h?: number;
  variant?: number;
}

// Species codes (src/world/vegetation/species.ts).
const TOOLS: Tool[] = [
  { id: 'select', label: 'Select / move' },
  { id: 'aspen', label: 'Trembling aspen', kind: 'tree', sp: 0, h: 17 },
  { id: 'poplar', label: 'Balsam poplar', kind: 'tree', sp: 1, h: 22 },
  { id: 'birch', label: 'Paper birch', kind: 'tree', sp: 2, h: 15 },
  { id: 'wspruce', label: 'White spruce', kind: 'tree', sp: 3, h: 20 },
  { id: 'bspruce', label: 'Black spruce', kind: 'tree', sp: 4, h: 11 },
  { id: 'pine', label: 'Lodgepole pine', kind: 'tree', sp: 5, h: 18 },
  { id: 'bluespruce', label: 'Colorado blue spruce', kind: 'tree', sp: 8, h: 12 },
  { id: 'mayday', label: 'Mayday / crabapple', kind: 'tree', sp: 9, h: 7 },
  { id: 'willow', label: 'Willow', kind: 'tree', sp: 6, h: 8 },
  { id: 'rose', label: 'Wild rose (shrub)', kind: 'shrub', sp: 20, h: 1.3 },
  { id: 'dogwood', label: 'Red-osier dogwood (shrub)', kind: 'shrub', sp: 21, h: 2 },
  { id: 'hedge', label: 'Caragana / lilac hedge', kind: 'shrub', sp: 22, h: 2.2 },
  { id: 'bench', label: 'Bench', kind: 'bench' },
  { id: 'bin', label: 'Waste bin', kind: 'bin' },
  { id: 'lamp', label: 'Street light', kind: 'lamp', variant: 0 },
  { id: 'lampA', label: 'Street light (arterial)', kind: 'lamp', variant: 1 },
  { id: 'hydrant', label: 'Fire hydrant', kind: 'hydrant' },
  { id: 'stop', label: 'Stop sign', kind: 'stop' },
  { id: 'pole', label: 'Power pole', kind: 'pole' },
];

const CSS = `
.editor { position: absolute; left: 16px; top: 16px; width: min(270px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto;
  background: rgba(14,17,22,0.86); color: #e8ecf2; border: 1px solid #2c3440; border-radius: 10px; padding: 10px 12px;
  font: 13px/1.35 system-ui, sans-serif; z-index: 15; }
.editor.hidden { display: none; }
.editor h3 { margin: 0 0 6px; font-size: 14px; }
.editor .tools { display: grid; grid-template-columns: 1fr; gap: 3px; }
.editor button { background: #212a36; color: #e8ecf2; border: 1px solid #333f50; border-radius: 6px; padding: 4px 8px; text-align: left; font: inherit; cursor: pointer; }
.editor button.on { background: #2e5b88; border-color: #4b82b8; }
.editor .row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.editor .row button { text-align: center; }
.editor .sel { margin-top: 8px; padding: 6px; background: #1a2029; border-radius: 6px; min-height: 36px; white-space: pre-line; }
.editor .legend span { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin: 0 4px 0 8px; }
.editor .hint { opacity: 0.7; font-size: 12px; margin-top: 8px; }
`;

const SRC_COLOR = { mapped: new THREE.Color(0.25, 0.9, 0.35), inferred: new THREE.Color(1.0, 0.6, 0.15), user: new THREE.Color(0.3, 0.6, 1.0) };

export class Editor {
  readonly el: HTMLDivElement;
  private tool: Tool = TOOLS[0];
  private selected: Pickable | null = null;
  private dragging = false;
  private readonly ring: THREE.Mesh;
  private readonly overlay: THREE.Points;
  private overlayOn = true;
  private overlayTimer = 0;
  private readonly selInfo: HTMLDivElement;
  private readonly toolButtons = new Map<string, HTMLButtonElement>();
  private readonly ray = new THREE.Raycaster();
  active = false;
  private heightScale = 1;

  constructor(parent: HTMLElement, private readonly host: EditorHost) {
    if (!document.getElementById('editor-style')) {
      const st = document.createElement('style');
      st.id = 'editor-style';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    this.el = document.createElement('div');
    this.el.className = 'editor hidden';
    this.el.innerHTML = `<h3>WORLD EDITOR</h3><div class="legend">Sources:<span style="background:#40e659"></span>mapped<span style="background:#ff9926"></span>inferred<span style="background:#4d99ff"></span>your edits</div>`;
    const tools = document.createElement('div');
    tools.className = 'tools';
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.textContent = t.label;
      b.addEventListener('click', () => this.setTool(t));
      tools.appendChild(b);
      this.toolButtons.set(t.id, b);
    }
    this.el.appendChild(tools);
    this.selInfo = document.createElement('div');
    this.selInfo.className = 'sel';
    this.el.appendChild(this.selInfo);
    const row = document.createElement('div');
    row.className = 'row';
    const btn = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', fn);
      row.appendChild(b);
      return b;
    };
    btn('Undo', () => this.host.overrides.undo());
    btn('Overlay', () => (this.overlayOn = !this.overlayOn));
    btn('Export', () => this.exportJson());
    btn('Import', () => this.importJson());
    btn('Clear edits', () => {
      if (confirm('Discard all edits made in this browser?')) this.host.overrides.clearLocal();
    });
    this.el.appendChild(row);
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Left click: place / select. Drag a selection to move it (snaps to the ground). R / Shift+R rotate, [ ] resize trees, Del delete, Ctrl+Z undo. Right-drag to look, WASD to move, Space/Ctrl up/down. E leaves the editor. Export saves overrides.json: commit it to public/world/ to make edits permanent.';
    this.el.appendChild(hint);
    parent.appendChild(this.el);
    this.setTool(TOOLS[0]);

    this.ring = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1.05, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x4dd2ff, transparent: true, opacity: 0.9, depthTest: false }),
    );
    this.ring.renderOrder = 20;
    this.ring.visible = false;
    host.scene.add(this.ring);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(3 * 20000), 3));
    pg.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(3 * 20000), 3));
    pg.setDrawRange(0, 0);
    this.overlay = new THREE.Points(pg, new THREE.PointsMaterial({ size: 7, sizeAttenuation: false, vertexColors: true, depthTest: false, transparent: true }));
    this.overlay.frustumCulled = false;
    this.overlay.renderOrder = 19;
    this.overlay.visible = false;
    host.scene.add(this.overlay);

    const dom = host.dom;
    dom.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', () => this.onUp());
    dom.addEventListener('contextmenu', (e) => {
      if (this.active) e.preventDefault();
    });
    window.addEventListener('keydown', (e) => this.onKey(e));
    host.overrides.onChange(() => {
      this.overlayTimer = 0;
      if (this.selected) this.refreshSelection();
    });
  }

  setActive(on: boolean): void {
    this.active = on;
    this.el.classList.toggle('hidden', !on);
    this.ring.visible = on && !!this.selected;
    this.overlay.visible = on && this.overlayOn;
    if (on) document.exitPointerLock?.();
  }

  private setTool(t: Tool): void {
    this.tool = t;
    for (const [id, b] of this.toolButtons) b.classList.toggle('on', id === t.id);
  }

  private rayFrom(e: PointerEvent): THREE.Ray {
    const r = this.host.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.host.camera);
    return this.ray.ray;
  }

  /** Ray march against the terrain height field; returns the hit point or null. */
  private groundHit(ray: THREE.Ray): THREE.Vector3 | null {
    const p = new THREE.Vector3();
    let t = 0.5, prevT = 0;
    for (let i = 0; i < 600 && t < 3000; i++) {
      ray.at(t, p);
      const g = this.host.ground(p.x, p.z);
      if (!Number.isFinite(g)) return null;
      if (p.y <= g) {
        let a = prevT, b = t;
        for (let k = 0; k < 20; k++) {
          const m = (a + b) / 2;
          ray.at(m, p);
          if (p.y <= this.host.ground(p.x, p.z)) b = m;
          else a = m;
        }
        ray.at(b, p);
        p.y = this.host.ground(p.x, p.z);
        return p;
      }
      prevT = t;
      t += Math.max(0.25, (p.y - g) * 0.4);
    }
    return null;
  }

  private pick(ray: THREE.Ray): Pickable | null {
    const c = this.host.camera.position;
    const cands = this.host.pickables(c.x, c.z, 400);
    let best: Pickable | null = null;
    let bestT = Infinity;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), onRay = new THREE.Vector3(), onSeg = new THREE.Vector3();
    for (const p of cands) {
      a.set(p.x, p.y, p.z);
      b.set(p.x, p.y + p.h, p.z);
      const d2 = ray.distanceSqToSegment(a, b, onRay, onSeg);
      if (d2 > p.r * p.r) continue;
      const t = onRay.distanceTo(ray.origin);
      if (t < bestT) {
        bestT = t;
        best = p;
      }
    }
    return best;
  }

  private onDown(e: PointerEvent): void {
    if (!this.active || e.button !== 0) return;
    const ray = this.rayFrom(e);
    if (this.tool.id === 'select') {
      const p = this.pick(ray);
      this.select(p);
      this.dragging = !!p;
      return;
    }
    const hit = this.groundHit(ray);
    if (!hit || !this.tool.kind) return;
    const t = this.tool;
    const toCam = Math.atan2(this.host.camera.position.x - hit.x, this.host.camera.position.z - hit.z);
    const item: EditItem = {
      op: 'add', kind: t.kind!, id: this.host.overrides.newId(), x: round2(hit.x), y: round2(hit.y), z: round2(hit.z),
      rot: t.kind === 'tree' || t.kind === 'shrub' ? Math.random() * Math.PI * 2 : round3(toCam),
    };
    if (t.kind === 'tree' || t.kind === 'shrub') {
      const h = (t.h ?? 10) * (0.85 + Math.random() * 0.3) * this.heightScale;
      item.h = round2(h);
      item.r = round2(t.kind === 'shrub' ? h * 0.7 : [3, 4, 5, 8].includes(t.sp!) ? h * 0.2 : h * 0.3);
      item.sp = t.sp;
    }
    if (t.variant !== undefined) item.variant = t.variant;
    this.host.overrides.add(item);
  }

  private onMove(e: PointerEvent): void {
    if (!this.active || !this.dragging || !this.selected) return;
    const hit = this.groundHit(this.rayFrom(e));
    if (!hit) return;
    this.selected.x = hit.x;
    this.selected.y = hit.y;
    this.selected.z = hit.z;
    this.ring.position.copy(hit).add(new THREE.Vector3(0, 0.05, 0));
    this.dragMoved = true;
  }

  private dragMoved = false;

  private onUp(): void {
    if (this.dragging && this.selected && this.dragMoved) this.commitSelected();
    this.dragging = false;
    this.dragMoved = false;
  }

  private commitSelected(): void {
    const s = this.selected!;
    const item: EditItem = {
      op: 'move', kind: s.kind, ref: s.ref, x: round2(s.x), y: round2(s.y), z: round2(s.z), rot: round3(s.rot),
    };
    if (s.kind === 'tree' || s.kind === 'shrub') {
      item.h = round2(s.h);
      item.r = round2(s.r / 0.6);
      item.sp = s.sp;
    }
    if (s.variant !== undefined) item.variant = s.variant;
    // A moved original lives on as its override entry; later edits address it by that id.
    if (!s.ref.startsWith('#')) item.id = this.host.overrides.newId();
    this.host.overrides.add(item);
    if (item.id) s.ref = `#${item.id}`;
    s.src = 'user';
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active) return;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
      this.host.overrides.undo();
      e.preventDefault();
      return;
    }
    const s = this.selected;
    if (!s) return;
    if (e.code === 'Delete' || e.code === 'Backspace') {
      this.host.overrides.add({ op: 'del', kind: s.kind, ref: s.ref });
      this.select(null);
    } else if (e.code === 'KeyR') {
      s.rot += ((e.shiftKey ? -15 : 15) * Math.PI) / 180;
      this.commitSelected();
    } else if ((e.code === 'BracketLeft' || e.code === 'BracketRight') && (s.kind === 'tree' || s.kind === 'shrub')) {
      const k = e.code === 'BracketRight' ? 1.1 : 1 / 1.1;
      s.h *= k;
      s.r *= k;
      this.commitSelected();
    }
  }

  private select(p: Pickable | null): void {
    this.selected = p;
    this.refreshSelection();
  }

  private refreshSelection(): void {
    const s = this.selected;
    this.ring.visible = this.active && !!s;
    if (!s) {
      this.selInfo.textContent = 'Nothing selected.';
      return;
    }
    const rr = s.kind === 'tree' || s.kind === 'shrub' ? Math.max(0.8, s.r) : 1;
    this.ring.scale.setScalar(rr);
    this.ring.position.set(s.x, s.y + 0.05, s.z);
    const src = s.src === 'mapped' ? (s.kind === 'tree' ? 'mapped (LiDAR crown)' : 'mapped (OpenStreetMap)') : s.src === 'inferred' ? 'inferred (rules / LiDAR density)' : 'your edit';
    this.selInfo.textContent = `${s.kind}${s.h && (s.kind === 'tree' || s.kind === 'shrub') ? ` · ${s.h.toFixed(1)} m` : ''}\n${src}\n${s.x.toFixed(1)}, ${s.z.toFixed(1)}`;
  }

  update(dt: number): void {
    if (!this.active) return;
    this.overlay.visible = this.overlayOn;
    this.overlayTimer -= dt;
    if (!this.overlayOn || this.overlayTimer > 0) return;
    this.overlayTimer = 0.5;
    const c = this.host.camera.position;
    const list = this.host.pickables(c.x, c.z, 250);
    const pos = this.overlay.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = this.overlay.geometry.getAttribute('color') as THREE.BufferAttribute;
    const n = Math.min(list.length, pos.count);
    for (let i = 0; i < n; i++) {
      const p = list[i];
      pos.setXYZ(i, p.x, p.y + Math.min(p.h, 6) + 0.4, p.z);
      const k = SRC_COLOR[p.src];
      col.setXYZ(i, k.r, k.g, k.b);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
    this.overlay.geometry.setDrawRange(0, n);
  }

  private exportJson(): void {
    const doc = this.host.overrides.exportDoc();
    const blob = new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'overrides.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  private importJson(): void {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'application/json,.json';
    inp.addEventListener('change', async () => {
      const f = inp.files?.[0];
      if (!f) return;
      try {
        const doc = JSON.parse(await f.text()) as OverridesDoc;
        if (!Array.isArray(doc.items)) throw new Error('no items');
        this.host.overrides.importDoc(doc);
      } catch (err) {
        alert(`Could not read ${f.name}: ${(err as Error).message}`);
      }
    });
    inp.click();
  }
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
