import { describe, expect, it } from 'vitest';
import type { GameMap, MapPath, TowerInstance } from 'shared';
import {
  addMapPath,
  cellsBetween,
  isAdjacentCell,
  isSpawnCell,
  isValidPathStep,
  pathLength,
  pointAtDistance,
  removeMapPath,
} from './path';

const straightPath: MapPath = {
  id: 'straight',
  nodes: [
    [0, 0],
    [4, 0],
  ],
};

const bentPath: MapPath = {
  id: 'bent',
  nodes: [
    [0, 0],
    [3, 0],
    [3, 4],
  ],
};

describe('pathLength', () => {
  it('sums the euclidean length of each segment', () => {
    expect(pathLength(straightPath)).toBe(4);
    expect(pathLength(bentPath)).toBe(7);
  });

  it('is zero for a single-node path', () => {
    expect(pathLength({ id: 'dot', nodes: [[1, 1]] })).toBe(0);
  });
});

describe('pointAtDistance', () => {
  it('returns the start node for distance 0 or less', () => {
    expect(pointAtDistance(straightPath, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAtDistance(straightPath, -5)).toEqual({ x: 0, y: 0 });
  });

  it('interpolates within a segment', () => {
    expect(pointAtDistance(straightPath, 2)).toEqual({ x: 2, y: 0 });
  });

  it('crosses into the next segment', () => {
    expect(pointAtDistance(bentPath, 5)).toEqual({ x: 3, y: 2 });
  });

  it('clamps to the last node beyond the path length', () => {
    expect(pointAtDistance(bentPath, 999)).toEqual({ x: 3, y: 4 });
  });
});

const tracingMap: GameMap = {
  id: 'tracing-map',
  grid: { cols: 5, rows: 5, cell: 'square' },
  chateau: { x: 4, y: 4 },
  spawns: [{ id: 's1', x: 0, y: 0 }],
  paths: [],
};

function tower(x: number, y: number): TowerInstance {
  return { id: `t-${x}-${y}`, typeId: 'archer', position: { x, y }, level: 1, placedAtPalier: 1 };
}

describe('removeMapPath', () => {
  const mapWithPaths: GameMap = {
    ...tracingMap,
    paths: [straightPath, bentPath],
  };

  it('removes the matching path and keeps the rest', () => {
    const updated = removeMapPath(mapWithPaths, 'straight');
    expect(updated.paths).toEqual([bentPath]);
  });

  it('does not mutate the original map', () => {
    removeMapPath(mapWithPaths, 'straight');
    expect(mapWithPaths.paths).toHaveLength(2);
  });

  it('is a no-op for an unknown path id', () => {
    const updated = removeMapPath(mapWithPaths, 'missing');
    expect(updated.paths).toEqual(mapWithPaths.paths);
  });
});

describe('addMapPath', () => {
  it('appends the path and keeps the existing ones', () => {
    const mapWithOnePath: GameMap = { ...tracingMap, paths: [straightPath] };
    const updated = addMapPath(mapWithOnePath, bentPath);
    expect(updated.paths).toEqual([straightPath, bentPath]);
  });

  it('does not mutate the original map', () => {
    const mapWithOnePath: GameMap = { ...tracingMap, paths: [straightPath] };
    addMapPath(mapWithOnePath, bentPath);
    expect(mapWithOnePath.paths).toEqual([straightPath]);
  });
});

describe('cellsBetween', () => {
  it('returns nothing for two identical cells', () => {
    expect(cellsBetween({ x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([]);
  });

  it('returns the single next cell when already adjacent', () => {
    expect(cellsBetween({ x: 1, y: 1 }, { x: 2, y: 1 })).toEqual([{ x: 2, y: 1 }]);
    expect(cellsBetween({ x: 1, y: 1 }, { x: 2, y: 2 })).toEqual([{ x: 2, y: 2 }]);
  });

  it('fills every intermediate cell along a straight horizontal line', () => {
    expect(cellsBetween({ x: 0, y: 0 }, { x: 3, y: 0 })).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
  });

  it('fills every intermediate cell along a diagonal line', () => {
    expect(cellsBetween({ x: 0, y: 0 }, { x: 3, y: 3 })).toEqual([
      { x: 1, y: 1 },
      { x: 2, y: 2 },
      { x: 3, y: 3 },
    ]);
  });

  it('each generated step stays adjacent (Chebyshev distance 1) to the previous one', () => {
    const steps = cellsBetween({ x: 0, y: 0 }, { x: 5, y: 2 });
    let previous = { x: 0, y: 0 };
    for (const step of steps) {
      expect(isAdjacentCell(previous, step)).toBe(true);
      previous = step;
    }
    expect(previous).toEqual({ x: 5, y: 2 });
  });
});

describe('isSpawnCell', () => {
  it('is true for a cell matching a spawn', () => {
    expect(isSpawnCell(tracingMap, { x: 0, y: 0 })).toBe(true);
  });

  it('is false elsewhere', () => {
    expect(isSpawnCell(tracingMap, { x: 1, y: 0 })).toBe(false);
  });
});

describe('isAdjacentCell', () => {
  it('accepts orthogonal neighbors', () => {
    expect(isAdjacentCell({ x: 1, y: 1 }, { x: 1, y: 2 })).toBe(true);
    expect(isAdjacentCell({ x: 1, y: 1 }, { x: 2, y: 1 })).toBe(true);
  });

  it('accepts diagonal neighbors', () => {
    expect(isAdjacentCell({ x: 1, y: 1 }, { x: 2, y: 2 })).toBe(true);
  });

  it('rejects the same cell', () => {
    expect(isAdjacentCell({ x: 1, y: 1 }, { x: 1, y: 1 })).toBe(false);
  });

  it('rejects non-adjacent cells', () => {
    expect(isAdjacentCell({ x: 1, y: 1 }, { x: 3, y: 1 })).toBe(false);
  });
});

describe('isValidPathStep', () => {
  it('accepts a step to an adjacent, in-bounds, tower-free cell', () => {
    expect(isValidPathStep(tracingMap, [], { x: 0, y: 0 }, { x: 1, y: 1 })).toBe(true);
  });

  it('rejects a step outside the grid', () => {
    expect(isValidPathStep(tracingMap, [], { x: 0, y: 0 }, { x: -1, y: 0 })).toBe(false);
  });

  it('rejects a step that is not adjacent to the previous cell', () => {
    expect(isValidPathStep(tracingMap, [], { x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false);
  });

  it('rejects a step onto a cell occupied by a tower', () => {
    const towers = [tower(1, 1)];
    expect(isValidPathStep(tracingMap, towers, { x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
  });
});
