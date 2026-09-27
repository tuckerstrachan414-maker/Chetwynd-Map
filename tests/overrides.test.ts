import { beforeEach, describe, expect, it } from 'vitest';
import { Overrides, refOf } from '../src/world/Overrides';

describe('editor overrides', () => {
  let ov: Overrides;
  beforeEach(() => {
    ov = new Overrides();
  });

  it('adds, moves and deletes originals', () => {
    const ref = refOf('bench', 10.04, -3.96);
    expect(ref).toBe('bench@100_-40');
    ov.add({ op: 'move', kind: 'bench', ref, id: 'm1', x: 12, y: 600, z: -4, rot: 1 });
    let k = ov.forKind('bench');
    expect(k.removed.has(ref)).toBe(true);
    expect(k.added).toHaveLength(1);
    // Moving it again edits the same entry (addressed by its id).
    ov.add({ op: 'move', kind: 'bench', ref: '#m1', x: 14, y: 600, z: -4, rot: 1 });
    k = ov.forKind('bench');
    expect(k.added).toHaveLength(1);
    expect(k.added[0].x).toBe(14);
    expect(k.added[0].ref).toBe(ref);
    // Deleting the moved object turns the move into a delete of the original.
    ov.add({ op: 'del', kind: 'bench', ref: '#m1' });
    k = ov.forKind('bench');
    expect(k.removed.has(ref)).toBe(true);
    expect(k.added).toHaveLength(0);
  });

  it('drops user additions on delete and supports undo', () => {
    ov.add({ op: 'add', kind: 'tree', id: 't1', x: 1, y: 2, z: 3, h: 15, r: 3, sp: 0 });
    expect(ov.forKind('tree').added).toHaveLength(1);
    ov.add({ op: 'del', kind: 'tree', ref: '#t1' });
    expect(ov.forKind('tree').added).toHaveLength(0);
    expect(ov.local).toHaveLength(0);
    ov.add({ op: 'add', kind: 'tree', id: 't2', x: 1, y: 2, z: 3 });
    ov.undo();
    expect(ov.local).toHaveLength(0);
  });

  it('merges committed and local edits on export, local winning', () => {
    const ref = refOf('lamp', 5, 5);
    ov.base = [{ op: 'del', kind: 'lamp', ref }, { op: 'add', kind: 'hydrant', id: 'h1', x: 0, y: 0, z: 0 }];
    ov.add({ op: 'move', kind: 'lamp', ref, id: 'm2', x: 6, y: 0, z: 5 });
    const doc = ov.exportDoc();
    expect(doc.items.filter((i) => i.ref === ref)).toHaveLength(1);
    expect(doc.items.find((i) => i.ref === ref)?.op).toBe('move');
    expect(doc.items.some((i) => i.kind === 'hydrant')).toBe(true);
  });
});
