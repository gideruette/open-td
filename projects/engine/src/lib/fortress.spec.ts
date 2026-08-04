import { describe, expect, it } from 'vitest';
import type { GameMap, TowerInstance, TowerType } from 'shared';
import {
  canOccupyCell,
  canPlaceTower,
  findTowerAt,
  isBorderCell,
  isHeartCell,
  isWithinGrid,
  removeTower,
  spentBudget,
} from './fortress';

const map: GameMap = {
  id: 'test-map',
  grid: { cols: 6, rows: 6, cell: 'square' },
  heart: { x: 3, y: 3 },
  spawns: [{ id: 's1', x: 0, y: 3 }],
  paths: [{ id: 'p1', nodes: [[0, 3], [3, 3]] }],
};

const archer: TowerType = { id: 'archer', name: 'Archer', cost: 20, range: 3, damage: 8, cooldown: 5 };
const catalog: TowerType[] = [
  archer,
  { id: 'canon', name: 'Canon', cost: 35, range: 2, damage: 15, cooldown: 15 },
];

describe('isWithinGrid', () => {
  it('accepts coordinates inside the grid', () => {
    expect(isWithinGrid(map, { x: 0, y: 0 })).toBe(true);
    expect(isWithinGrid(map, { x: 5, y: 5 })).toBe(true);
  });

  it('rejects coordinates outside the grid', () => {
    expect(isWithinGrid(map, { x: -1, y: 0 })).toBe(false);
    expect(isWithinGrid(map, { x: 6, y: 0 })).toBe(false);
  });
});

describe('isHeartCell', () => {
  it('is true for the heart cell', () => {
    expect(isHeartCell(map, { x: 3, y: 3 })).toBe(true);
  });

  it('is false elsewhere', () => {
    expect(isHeartCell(map, { x: 1, y: 1 })).toBe(false);
  });
});

describe('isBorderCell', () => {
  it('is true on the first/last row or column', () => {
    expect(isBorderCell(map, { x: 0, y: 2 })).toBe(true);
    expect(isBorderCell(map, { x: 5, y: 2 })).toBe(true);
    expect(isBorderCell(map, { x: 2, y: 0 })).toBe(true);
    expect(isBorderCell(map, { x: 2, y: 5 })).toBe(true);
  });

  it('is false for interior cells', () => {
    expect(isBorderCell(map, { x: 1, y: 1 })).toBe(false);
    expect(isBorderCell(map, { x: 4, y: 4 })).toBe(false);
  });
});

describe('findTowerAt', () => {
  const towers: TowerInstance[] = [
    { id: 't1', typeId: 'archer', position: { x: 1, y: 1 }, level: 1, placedAtPalier: 1 },
  ];

  it('finds the tower occupying a cell', () => {
    expect(findTowerAt(towers, { x: 1, y: 1 })?.id).toBe('t1');
  });

  it('returns undefined for an empty cell', () => {
    expect(findTowerAt(towers, { x: 2, y: 2 })).toBeUndefined();
  });
});

describe('canOccupyCell', () => {
  it('rejects when no map is loaded', () => {
    expect(canOccupyCell(undefined, [], { x: 1, y: 1 })).toEqual({
      ok: false,
      reason: 'map-not-loaded',
    });
  });

  it('rejects a cell outside the grid', () => {
    expect(canOccupyCell(map, [], { x: -1, y: 0 })).toEqual({
      ok: false,
      reason: 'out-of-bounds',
    });
  });

  it('rejects the heart cell', () => {
    expect(canOccupyCell(map, [], { x: 3, y: 3 })).toEqual({
      ok: false,
      reason: 'heart-cell',
    });
  });

  it('rejects a border cell', () => {
    expect(canOccupyCell(map, [], { x: 0, y: 2 })).toEqual({
      ok: false,
      reason: 'border-cell',
    });
  });

  it('rejects a cell already occupied by another tower', () => {
    const towers: TowerInstance[] = [
      { id: 't1', typeId: 'archer', position: { x: 1, y: 1 }, level: 1, placedAtPalier: 1 },
    ];
    expect(canOccupyCell(map, towers, { x: 1, y: 1 })).toEqual({
      ok: false,
      reason: 'occupied',
    });
  });

  it('accepts a free, in-bounds, interior cell — no budget involved', () => {
    expect(canOccupyCell(map, [], { x: 1, y: 1 })).toEqual({ ok: true });
  });
});

describe('canPlaceTower', () => {
  it('rejects when no map is loaded', () => {
    expect(canPlaceTower(undefined, [], archer, { x: 1, y: 1 }, 100)).toEqual({
      ok: false,
      reason: 'map-not-loaded',
    });
  });

  it('rejects an unknown tower type', () => {
    expect(canPlaceTower(map, [], undefined, { x: 1, y: 1 }, 100)).toEqual({
      ok: false,
      reason: 'unknown-tower-type',
    });
  });

  it('rejects a cell outside the grid', () => {
    expect(canPlaceTower(map, [], archer, { x: -1, y: 0 }, 100)).toEqual({
      ok: false,
      reason: 'out-of-bounds',
    });
  });

  it('rejects the heart cell', () => {
    expect(canPlaceTower(map, [], archer, { x: 3, y: 3 }, 100)).toEqual({
      ok: false,
      reason: 'heart-cell',
    });
  });

  it('rejects a border cell', () => {
    expect(canPlaceTower(map, [], archer, { x: 0, y: 2 }, 100)).toEqual({
      ok: false,
      reason: 'border-cell',
    });
  });

  it('rejects a cell already occupied by another tower', () => {
    const towers: TowerInstance[] = [
      { id: 't1', typeId: 'archer', position: { x: 1, y: 1 }, level: 1, placedAtPalier: 1 },
    ];
    expect(canPlaceTower(map, towers, archer, { x: 1, y: 1 }, 100)).toEqual({
      ok: false,
      reason: 'occupied',
    });
  });

  it('rejects when the remaining budget is below the tower cost', () => {
    expect(canPlaceTower(map, [], archer, { x: 1, y: 1 }, 10)).toEqual({
      ok: false,
      reason: 'insufficient-budget',
    });
  });

  it('accepts a valid, affordable placement', () => {
    expect(canPlaceTower(map, [], archer, { x: 1, y: 1 }, 100)).toEqual({ ok: true });
  });

  it('accepts a placement on a path cell (paths no longer block building)', () => {
    expect(canPlaceTower(map, [], archer, { x: 2, y: 3 }, 100)).toEqual({ ok: true });
  });
});

describe('spentBudget', () => {
  it('sums the cost of placed towers using the catalog', () => {
    const towers: TowerInstance[] = [
      { id: 't1', typeId: 'archer', position: { x: 1, y: 1 }, level: 1, placedAtPalier: 1 },
      { id: 't2', typeId: 'canon', position: { x: 2, y: 2 }, level: 1, placedAtPalier: 1 },
    ];
    expect(spentBudget(towers, catalog)).toBe(55);
  });

  it('ignores an unknown tower type instead of throwing', () => {
    const towers: TowerInstance[] = [
      { id: 't1', typeId: 'ghost', position: { x: 1, y: 1 }, level: 1, placedAtPalier: 1 },
    ];
    expect(spentBudget(towers, catalog)).toBe(0);
  });
});

describe('removeTower', () => {
  it('removes the matching tower and keeps the rest', () => {
    const towers: TowerInstance[] = [
      { id: 't1', typeId: 'archer', position: { x: 1, y: 1 }, level: 1, placedAtPalier: 1 },
      { id: 't2', typeId: 'canon', position: { x: 2, y: 2 }, level: 1, placedAtPalier: 1 },
    ];
    const updated = removeTower(towers, 't1');
    expect(updated).toHaveLength(1);
    expect(updated[0].id).toBe('t2');
  });

  it('does not mutate the original array', () => {
    const towers: TowerInstance[] = [
      { id: 't1', typeId: 'archer', position: { x: 1, y: 1 }, level: 1, placedAtPalier: 1 },
    ];
    removeTower(towers, 't1');
    expect(towers).toHaveLength(1);
  });

  it('is a no-op for an unknown tower id', () => {
    const towers: TowerInstance[] = [
      { id: 't1', typeId: 'archer', position: { x: 1, y: 1 }, level: 1, placedAtPalier: 1 },
    ];
    expect(removeTower(towers, 'missing')).toEqual(towers);
  });
});
