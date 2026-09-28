/**
 * User corrections to the generated world (in-game editor, E): add, move, re-orient or delete
 * trees, shrubs and street furniture. Loaded from public/world/overrides.json (committed) and
 * then from this browser's local edits; the editor exports the merged document so it can be
 * committed as the new overrides.json.
 */

export type EditKind = 'tree' | 'shrub' | 'lamp' | 'pole' | 'hydrant' | 'stop' | 'bench' | 'bin' | 'playground' | 'streetname' | 'signal' | 'tower' | 'fence';

export interface EditItem {
  /** Stable identity of the original object ("kind@x_z" in decimetres) for moves and deletes. */
  ref?: string;
  kind: EditKind;
  op: 'add' | 'del' | 'move';
  x?: number;
  y?: number;
  z?: number;
  rot?: number;
  /** Trees and shrubs: height (m), crown radius (m), species code. */
  h?: number;
  r?: number;
  sp?: number;
  /** Props: model variant (lamps: 1 = arterial). */
  variant?: number;
  /** Fences: polyline [x, ground y, z] and type. */
  pts?: [number, number, number][];
  ft?: 'privacy' | 'chainlink' | 'rail';
  /** Unique id of an added object (so it can itself be moved or deleted). */
  id?: string;
}

export interface OverridesDoc {
  version: 1;
  items: EditItem[];
}

const LS_KEY = 'cw.overrides.v1';

export function refOf(kind: string, x: number, z: number): string {
  return `${kind}@${Math.round(x * 10)}_${Math.round(z * 10)}`;
}

/** Holds the merged overrides and notifies consumers when they change. */
export class Overrides {
  base: EditItem[] = [];
  local: EditItem[] = [];
  private listeners: (() => void)[] = [];
  private seq = 0;

  async load(url: string): Promise<void> {
    try {
      const res = await fetch(url);
      if (res.ok) this.base = ((await res.json()) as OverridesDoc).items ?? [];
    } catch {
      /* no committed overrides yet */
    }
    try {
      const s = localStorage.getItem(LS_KEY);
      if (s) this.local = (JSON.parse(s) as OverridesDoc).items ?? [];
    } catch {
      /* storage unavailable */
    }
    this.seq = this.all().length;
  }

  all(): EditItem[] {
    return [...this.base, ...this.local];
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private commit(): void {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ version: 1, items: this.local } satisfies OverridesDoc));
    } catch {
      /* edits last for this session */
    }
    for (const fn of this.listeners) fn();
  }

  newId(): string {
    return `u${Date.now().toString(36)}${(this.seq++).toString(36)}`;
  }

  add(item: EditItem): void {
    // Editing an object the user already added or moved edits that entry: a delete drops an add,
    // and turns a move of an original into a delete of that original.
    if (item.ref?.startsWith('#')) {
      const id = item.ref.slice(1);
      const k = this.local.findIndex((i) => i.id === id && (i.op === 'add' || i.op === 'move'));
      if (k >= 0) {
        const cur = this.local[k];
        if (item.op === 'del') {
          if (cur.op === 'add') this.local.splice(k, 1);
          else this.local[k] = { op: 'del', kind: cur.kind, ref: cur.ref };
        } else {
          this.local[k] = { ...cur, ...item, op: cur.op, id, ref: cur.ref };
        }
        this.commit();
        return;
      }
    }
    // A later edit of the same original replaces the earlier one.
    if (item.ref) this.local = this.local.filter((i) => i.ref !== item.ref);
    this.local.push(item);
    this.commit();
  }

  undo(): void {
    this.local.pop();
    this.commit();
  }

  clearLocal(): void {
    this.local = [];
    this.commit();
  }

  exportDoc(): OverridesDoc {
    // Merge: local edits supersede base edits of the same original.
    const refs = new Set(this.local.map((i) => i.ref).filter(Boolean));
    return { version: 1, items: [...this.base.filter((i) => !i.ref || !refs.has(i.ref)), ...this.local] };
  }

  importDoc(doc: OverridesDoc): void {
    this.local = doc.items ?? [];
    this.commit();
  }

  /** Refs removed (deleted or moved away) and the objects to add, for one kind. */
  forKind(kind: EditKind): { removed: Set<string>; added: EditItem[] } {
    const removed = new Set<string>();
    const added: EditItem[] = [];
    const items = this.exportDoc().items.filter((i) => i.kind === kind);
    for (const i of items) {
      if (i.ref && !i.ref.startsWith('#')) removed.add(i.ref);
      if (i.op === 'add' || i.op === 'move') added.push(i);
    }
    return { removed, added };
  }
}
