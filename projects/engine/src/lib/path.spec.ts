import { describe, expect, it } from 'vitest';
import type { GameMap, MapPath, TowerInstance } from 'shared';
import { hexToWorld } from 'shared';
import {
  addMapPath,
  addMapSpawn,
  cellsBetween,
  expandPathCells,
  hasUniqueCell,
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
  it('sums neighbor-to-neighbor world lengths along the expanded hex path', () => {
    // Horizontal odd-r run of 4 steps: each step distance 1.
    expect(pathLength(straightPath)).toBeCloseTo(4, 10);
    // [0,0]→[3,0] = 3 hex steps ; [3,0]→[3,4] = hexDistance steps of length 1.
    const verticalSteps = expandPathCells({
      id: 'vert',
      nodes: [
        [3, 0],
        [3, 4],
      ],
    }).length - 1;
    expect(pathLength(bentPath)).toBeCloseTo(3 + verticalSteps, 10);
  });

  it('is zero for a single-node path', () => {
    expect(pathLength({ id: 'dot', nodes: [[1, 1]] })).toBe(0);
  });
});

describe('pointAtDistance', () => {
  it('returns the start node world center for distance 0 or less', () => {
    expect(pointAtDistance(straightPath, 0)).toEqual(hexToWorld({ x: 0, y: 0 }));
    expect(pointAtDistance(straightPath, -5)).toEqual(hexToWorld({ x: 0, y: 0 }));
  });

  it('interpolates within a segment in world space', () => {
    const mid = hexToWorld({ x: 2, y: 0 });
    const point = pointAtDistance(straightPath, 2);
    expect(point.x).toBeCloseTo(mid.x, 10);
    expect(point.y).toBeCloseTo(mid.y, 10);
  });

  it('follows hex cell centers when turning a corner', () => {
    // After the 3 horizontal steps, the next cell on [3,0]→[3,4] is the first hexLinedraw step.
    const vertical = expandPathCells({
      id: 'vert',
      nodes: [
        [3, 0],
        [3, 4],
      ],
    });
    const firstAfterCorner = vertical[1];
    const expected = hexToWorld(firstAfterCorner);
    const point = pointAtDistance(bentPath, 3 + 1);
    expect(point.x).toBeCloseTo(expected.x, 10);
    expect(point.y).toBeCloseTo(expected.y, 10);
  });

  it('clamps to the last node beyond the path length', () => {
    expect(pointAtDistance(bentPath, 999)).toEqual(hexToWorld({ x: 3, y: 4 }));
  });
});

describe('expandPathCells', () => {
  it('includes every hex along the route between waypoints', () => {
    const cells = expandPathCells(straightPath);
    expect(cells[0]).toEqual({ x: 0, y: 0 });
    expect(cells.at(-1)).toEqual({ x: 4, y: 0 });
    for (let i = 1; i < cells.length; i++) {
      expect(isAdjacentCell(cells[i - 1], cells[i])).toBe(true);
    }
  });
});

const HEX_GRID = { cols: 5, rows: 5, cell: 'hex' as const, orientation: 'pointy' as const, offset: 'odd-r' as const };

const tracingMap: GameMap = {
  id: 'tracing-map',
  grid: HEX_GRID,
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
  });

  it('fills every intermediate cell along a straight horizontal line', () => {
    expect(cellsBetween({ x: 0, y: 0 }, { x: 3, y: 0 })).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
  });

  it('each generated step stays at hex distance 1 from the previous one', () => {
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

describe('addMapSpawn', () => {
  it('appends the spawn and keeps the existing ones', () => {
    const updated = addMapSpawn(tracingMap, { id: 's2', x: 4, y: 0 });
    expect(updated.spawns).toEqual([{ id: 's1', x: 0, y: 0 }, { id: 's2', x: 4, y: 0 }]);
  });

  it('does not mutate the original map', () => {
    addMapSpawn(tracingMap, { id: 's2', x: 4, y: 0 });
    expect(tracingMap.spawns).toEqual([{ id: 's1', x: 0, y: 0 }]);
  });
});

describe('hasUniqueCell', () => {
  it('is true when no other path exists yet', () => {
    expect(hasUniqueCell(expandPathCells(straightPath), [])).toBe(true);
  });

  it('is true when at least one cell of the candidate path is uncovered', () => {
    const covering: MapPath = { id: 'covering', nodes: [[0, 0], [2, 0]] };
    expect(hasUniqueCell(expandPathCells(straightPath), [covering])).toBe(true);
  });

  it('is false when every cell of the candidate path is already covered', () => {
    expect(hasUniqueCell(expandPathCells(straightPath), [straightPath])).toBe(false);
  });

  it('is false when the candidate path is covered by the union of several paths', () => {
    const left: MapPath = { id: 'left', nodes: [[0, 0], [2, 0]] };
    const right: MapPath = { id: 'right', nodes: [[2, 0], [4, 0]] };
    expect(hasUniqueCell(expandPathCells(straightPath), [left, right])).toBe(false);
  });
});

describe('isAdjacentCell', () => {
  it('accepts hex neighbors', () => {
    expect(isAdjacentCell({ x: 1, y: 1 }, { x: 2, y: 1 })).toBe(true);
    expect(isAdjacentCell({ x: 1, y: 1 }, { x: 1, y: 2 })).toBe(true);
    expect(isAdjacentCell({ x: 1, y: 1 }, { x: 2, y: 2 })).toBe(true);
  });

  it('rejects cells at hex distance greater than 1', () => {
    expect(isAdjacentCell({ x: 1, y: 1 }, { x: 0, y: 0 })).toBe(false);
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
    expect(isValidPathStep(tracingMap, [], { x: 0, y: 0 }, { x: 1, y: 0 })).toBe(true);
  });

  it('rejects a step outside the grid', () => {
    expect(isValidPathStep(tracingMap, [], { x: 0, y: 0 }, { x: -1, y: 0 })).toBe(false);
  });

  it('rejects a step that is not adjacent to the previous cell', () => {
    expect(isValidPathStep(tracingMap, [], { x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false);
  });

  it('rejects a step onto a cell occupied by a tower', () => {
    const towers = [tower(1, 0)];
    expect(isValidPathStep(tracingMap, towers, { x: 0, y: 0 }, { x: 1, y: 0 })).toBe(false);
  });
});
