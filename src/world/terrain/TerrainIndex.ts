/** Terrain pyramid manifest (public/world/terrain/index.json). */
export interface TerrainIndexJson {
  nodeRes: number;
  nodeBase: number;
  rootLevel: number;
  half: number;
  levels: Record<string, [number, number, number, number][]>;
}

export interface NodeInfo {
  level: number;
  i: number;
  j: number;
  hmin: number;
  hmax: number;
}

export const nodeKey = (level: number, i: number, j: number): string => `${level}/${i}/${j}`;

export class TerrainIndex {
  readonly nodeRes: number;
  readonly nodeBase: number;
  readonly rootLevel: number;
  readonly half: number;
  private readonly nodes = new Map<string, NodeInfo>();

  constructor(json: TerrainIndexJson) {
    this.nodeRes = json.nodeRes;
    this.nodeBase = json.nodeBase;
    this.rootLevel = json.rootLevel;
    this.half = json.half;
    for (const [lvl, entries] of Object.entries(json.levels)) {
      const level = Number(lvl);
      for (const [i, j, hmin, hmax] of entries) this.nodes.set(nodeKey(level, i, j), { level, i, j, hmin, hmax });
    }
  }

  get(level: number, i: number, j: number): NodeInfo | undefined {
    return this.nodes.get(nodeKey(level, i, j));
  }

  has(level: number, i: number, j: number): boolean {
    return this.nodes.has(nodeKey(level, i, j));
  }

  /** Size in metres of a node at `level` (level may be negative for virtual render nodes). */
  size(level: number): number {
    return this.nodeBase * Math.pow(2, level);
  }

  /** World-space min corner (x, z) of node (level, i, j). */
  origin(level: number, i: number, j: number): [number, number] {
    const s = this.size(level);
    return [-this.half + i * s, -this.half + j * s];
  }

  /** Finest existing data node containing (x, z), searching from `maxLevel` down to 0. */
  finestAt(x: number, z: number): NodeInfo | undefined {
    let best: NodeInfo | undefined;
    for (let level = this.rootLevel; level >= 0; level--) {
      const s = this.size(level);
      const i = Math.floor((x + this.half) / s);
      const j = Math.floor((z + this.half) / s);
      const n = this.get(level, i, j);
      if (!n) break;
      best = n;
    }
    return best;
  }
}
