import { describe, expect, it } from 'vitest';
import type { GameMap, TowerInstance, TowerType } from 'shared';
import {
  canOccupyCell,
  canPlaceTower,
  cellKey,
  findTowerAt,
  isBorderCell,
  isChateauCell,
  isPathCell,
  isRiverCell,
  isWithinGrid,
  removeTower,
  riverCells,
  spentBudget,
  towerCells,
} from './fortress';
import { addMapPath, expandPathCells } from './path';

const map: GameMap = {
  id: 'test-map',
  grid: { cols: 6, rows: 6, cell: 'hex', orientation: 'pointy', offset: 'odd-r' },
  chateau: { x: 3, y: 3 },
  spawns: [{ id: 's1', x: 0, y: 3 }],
  paths: [{ id: 'p1', nodes: [[0, 3], [3, 3]] }],
};

const archer: TowerType = { id: 'archer', name: 'Archer', description: '', cost: 20, range: 3, damage: 8, cooldown: 5 };
const catalog: TowerType[] = [
  archer,
  { id: 'canon', name: 'Canon', description: '', cost: 35, range: 2, damage: 15, cooldown: 15 },
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

describe('isChateauCell', () => {
  it('is true for the chateau cell', () => {
    expect(isChateauCell(map, { x: 3, y: 3 })).toBe(true);
  });

  it('is false elsewhere', () => {
    expect(isChateauCell(map, { x: 1, y: 1 })).toBe(false);
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

describe('isPathCell', () => {
  it('is true for a cell crossed by a path', () => {
    expect(isPathCell(map, { x: 2, y: 3 })).toBe(true);
  });

  it('is false elsewhere', () => {
    expect(isPathCell(map, { x: 1, y: 1 })).toBe(false);
  });
});

function tower(id: string, x: number, y: number): TowerInstance {
  return { id, typeId: 'archer', position: { x, y }, level: 1, placedAtPalier: 1 };
}

describe('isRiverCell', () => {
  const riverMap: GameMap = { ...map, rivers: [{ id: 'r', nodes: [[0, 0], [0, 5]] }] };

  it('is true on a cell the river runs through', () => {
    expect(isRiverCell(riverMap, { x: 0, y: 0 })).toBe(true);
  });

  it('is false away from the river', () => {
    expect(isRiverCell(riverMap, { x: 5, y: 0 })).toBe(false);
  });

  it('is false on a map without rivers', () => {
    expect(isRiverCell(map, { x: 0, y: 0 })).toBe(false);
  });

  it('is false on the chateau even when the river runs through it', () => {
    // La rivière passe visuellement sous le château : un chemin doit pouvoir s'y terminer.
    const crossing: GameMap = { ...map, rivers: [{ id: 'r', nodes: [[3, 0], [3, 5]] }] };
    expect(expandPathCells(crossing.rivers![0])).toContainEqual(crossing.chateau);
    expect(isRiverCell(crossing, crossing.chateau)).toBe(false);
  });
});

describe('riverCells', () => {
  const rivers = [{ id: 'r', nodes: [[3, 0] as [number, number], [3, 5] as [number, number]] }];
  const riverMap: GameMap = { ...map, rivers };

  it('indexes every river cell except the chateau', () => {
    const cells = riverCells(riverMap);
    const expanded = expandPathCells(rivers[0]);

    expect(cells.has(cellKey(riverMap.chateau))).toBe(false);
    for (const cell of expanded) {
      expect(cells.has(cellKey(cell))).toBe(isChateauCell(riverMap, cell) === false);
    }
  });

  /**
   * L'index est mémoïsé sur le tableau `rivers`, pas sur la carte : tracer un chemin republie une
   * carte entière (`addMapPath`) en conservant le même tableau de rivières. Une clé posée sur la
   * carte serait invalidée à chaque tracé — d'où ce test, qui épingle le choix de clé.
   */
  it('keeps its index across a map republished by a path being traced', () => {
    const before = riverCells(riverMap);
    const afterTracing = addMapPath(riverMap, { id: 'traced', nodes: [[0, 0], [1, 0]] });

    expect(afterTracing).not.toBe(riverMap);
    expect(riverCells(afterTracing)).toBe(before);
  });

  it('gives a map with its own rivers its own index', () => {
    const other: GameMap = { ...map, rivers: [{ id: 'other', nodes: [[0, 0], [0, 5]] }] };
    expect(riverCells(other)).not.toBe(riverCells(riverMap));
  });

  it('is empty for a map without rivers', () => {
    expect(riverCells(map).size).toBe(0);
  });
});

describe('towerCells', () => {
  it('indexes the cell of every tower', () => {
    const towers = [tower('t1', 1, 1), tower('t2', 2, 2)];
    const cells = towerCells(towers);

    expect(cells.has(cellKey({ x: 1, y: 1 }))).toBe(true);
    expect(cells.has(cellKey({ x: 2, y: 2 }))).toBe(true);
    expect(cells.has(cellKey({ x: 3, y: 3 }))).toBe(false);
  });

  it('reuses its index for the same fortress, and rebuilds it for another', () => {
    const towers = [tower('t1', 1, 1)];
    expect(towerCells(towers)).toBe(towerCells(towers));
    expect(towerCells([tower('t1', 1, 1)])).not.toBe(towerCells(towers));
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

  it('rejects the chateau cell', () => {
    expect(canOccupyCell(map, [], { x: 3, y: 3 })).toEqual({
      ok: false,
      reason: 'chateau-cell',
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

  it('rejects a cell crossed by a path', () => {
    expect(canOccupyCell(map, [], { x: 2, y: 3 })).toEqual({
      ok: false,
      reason: 'path-cell',
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

  it('rejects the chateau cell', () => {
    expect(canPlaceTower(map, [], archer, { x: 3, y: 3 }, 100)).toEqual({
      ok: false,
      reason: 'chateau-cell',
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

  it('rejects a placement on a path cell', () => {
    expect(canPlaceTower(map, [], archer, { x: 2, y: 3 }, 100)).toEqual({
      ok: false,
      reason: 'path-cell',
    });
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
