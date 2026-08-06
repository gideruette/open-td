import { describe, expect, it } from 'vitest';
import type { GameMap, MapPath, TowerInstance } from 'shared';
import { hexDistance, hexNeighbors, hexToWorld } from 'shared';
import {
  addMapPath,
  addMapSpawn,
  buildPathGeometry,
  cellsBetween,
  coveredCells,
  expandPathCells,
  hasUniqueCell,
  isAdjacentCell,
  isSpawnCell,
  isSpawnConnected,
  isValidPathStep,
  pathCellsCost,
  pathLength,
  pointAtDistance,
  pointAtDistanceOn,
  pruneOrphanSpawns,
  removeMapPath,
  routeThroughWaypoints,
  shortestPath,
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

  it('drops a spawn left with no route once its only path is removed', () => {
    const secondSpawnPath: MapPath = { id: 'from-s2', nodes: [[3, 0], [4, 4]] };
    const orphanSpawn = { id: 's2', x: 3, y: 0 };
    const mapWithOrphanCandidate: GameMap = {
      ...tracingMap,
      spawns: [{ id: 's1', x: 0, y: 0 }, orphanSpawn],
      paths: [straightPath, secondSpawnPath],
    };
    const updated = removeMapPath(mapWithOrphanCandidate, 'from-s2');
    expect(updated.spawns).toEqual([{ id: 's1', x: 0, y: 0 }]);
  });

  it('keeps a spawn still reachable by another remaining path', () => {
    const updated = removeMapPath(mapWithPaths, 'straight');
    expect(updated.spawns).toEqual(mapWithPaths.spawns);
  });
});

describe('isSpawnConnected', () => {
  it('is true when a path starts on the spawn cell', () => {
    expect(isSpawnConnected({ id: 's1', x: 0, y: 0 }, [straightPath])).toBe(true);
  });

  it('is false when no path starts on the spawn cell', () => {
    expect(isSpawnConnected({ id: 's2', x: 9, y: 9 }, [straightPath, bentPath])).toBe(false);
  });
});

describe('pruneOrphanSpawns', () => {
  it('removes spawns with no path starting on them, without mutating the original map', () => {
    const orphanSpawn = { id: 's2', x: 9, y: 9 };
    const mapWithOrphan: GameMap = {
      ...tracingMap,
      spawns: [{ id: 's1', x: 0, y: 0 }, orphanSpawn],
      paths: [straightPath],
    };
    const updated = pruneOrphanSpawns(mapWithOrphan);
    expect(updated.spawns).toEqual([{ id: 's1', x: 0, y: 0 }]);
    expect(mapWithOrphan.spawns).toHaveLength(2);
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

describe('coveredCells', () => {
  it('unions the cells of every path, deduplicating overlaps', () => {
    const covered = coveredCells([straightPath, straightPath]);
    expect(covered.size).toBe(expandPathCells(straightPath).length);
  });

  it('counts distinct cells across non-overlapping paths', () => {
    const other: MapPath = { id: 'other', nodes: [[0, 5], [4, 5]] };
    const covered = coveredCells([straightPath, other]);
    expect(covered.size).toBe(
      expandPathCells(straightPath).length + expandPathCells(other).length,
    );
  });
});

describe('pathCellsCost', () => {
  it('charges every distinct cell once at the given rate', () => {
    expect(pathCellsCost([straightPath], 3)).toBe(expandPathCells(straightPath).length * 3);
  });

  it('charges a cell only once even when two paths share it (CONCEPTION.md §5.3)', () => {
    const overlapping: MapPath = { id: 'overlapping', nodes: [[0, 0], [4, 0]] };
    expect(pathCellsCost([straightPath, overlapping], 3)).toBe(
      pathCellsCost([straightPath], 3),
    );
  });

  it('is zero for no paths', () => {
    expect(pathCellsCost([])).toBe(0);
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

describe('buildPathGeometry', () => {
  it('exposes one world center per traversed cell, with cumulative distances from the spawn', () => {
    const geometry = buildPathGeometry(straightPath);
    const cells = expandPathCells(straightPath);

    expect(geometry.centers).toHaveLength(cells.length);
    expect(geometry.centers[0]).toEqual(hexToWorld(cells[0]));
    expect(geometry.cumulative[0]).toBe(0);
    expect(geometry.cumulative).toHaveLength(cells.length);
    // Strictement croissante : chaque case suivante est plus loin du spawn que la précédente.
    for (let i = 1; i < geometry.cumulative.length; i++) {
      expect(geometry.cumulative[i]).toBeGreaterThan(geometry.cumulative[i - 1]);
    }
  });

  it('agrees with pathLength on the total, including for a single-node path', () => {
    expect(buildPathGeometry(bentPath).totalLength).toBeCloseTo(pathLength(bentPath), 10);
    expect(buildPathGeometry({ id: 'dot', nodes: [[1, 1]] }).totalLength).toBe(0);
  });
});

describe('pointAtDistanceOn', () => {
  // La recherche des IA situe les monstres via la géométrie précalculée plutôt qu'en redéveloppant
  // le chemin (`pointAtDistance`) : les deux doivent rendre exactement le même point, sans quoi
  // l'optimisation changerait le déroulé des combats.
  it('matches pointAtDistance all along the path, ends and out-of-range included', () => {
    const geometry = buildPathGeometry(bentPath);
    const total = geometry.totalLength;
    const distances = [-1, 0, 0.25, 1, 1.5, total / 2, total - 0.1, total, total + 5];

    for (const distance of distances) {
      const viaGeometry = pointAtDistanceOn(geometry, distance);
      const viaPath = pointAtDistance(bentPath, distance);
      expect(viaGeometry.x).toBeCloseTo(viaPath.x, 10);
      expect(viaGeometry.y).toBeCloseTo(viaPath.y, 10);
    }
  });

  it('lands exactly on a cell center when the distance is that of a cell', () => {
    const geometry = buildPathGeometry(bentPath);
    const third = geometry.cumulative[3];
    expect(pointAtDistanceOn(geometry, third)).toEqual(geometry.centers[3]);
  });

  it('returns the origin for an empty path', () => {
    expect(pointAtDistanceOn(buildPathGeometry({ id: 'empty', nodes: [] }), 3)).toEqual({
      x: 0,
      y: 0,
    });
  });
});

describe('shortestPath', () => {
  /** Cases contiguës deux à deux : un chemin qui « saute » une case serait injouable. */
  function isContiguous(cells: readonly { x: number; y: number }[]): boolean {
    return cells.every((cell, i) => i === 0 || isAdjacentCell(cells[i - 1], cell));
  }

  it('is empty when the destination is the origin', () => {
    expect(shortestPath(tracingMap, [], { x: 2, y: 2 }, { x: 2, y: 2 })).toEqual([]);
  });

  it('excludes the origin and includes the destination, in contiguous steps', () => {
    const steps = shortestPath(tracingMap, [], { x: 0, y: 0 }, { x: 3, y: 0 })!;

    expect(steps).toBeDefined();
    expect(steps).not.toContainEqual({ x: 0, y: 0 });
    expect(steps[steps.length - 1]).toEqual({ x: 3, y: 0 });
    expect(isContiguous([{ x: 0, y: 0 }, ...steps])).toBe(true);
  });

  it('takes the shortest route: as many steps as the hex distance when nothing blocks', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 3, y: 3 };
    const steps = shortestPath(tracingMap, [], from, to)!;
    expect(steps).toHaveLength(hexDistance(from, to));
  });

  it('routes around a tower instead of through it', () => {
    const towers = [tower(1, 0), tower(1, 1)];
    const steps = shortestPath(tracingMap, towers, { x: 0, y: 0 }, { x: 2, y: 0 })!;

    expect(steps).toBeDefined();
    expect(steps).not.toContainEqual({ x: 1, y: 0 });
    expect(steps).not.toContainEqual({ x: 1, y: 1 });
    expect(isContiguous([{ x: 0, y: 0 }, ...steps])).toBe(true);
  });

  it('never crosses a river', () => {
    const river: MapPath = { id: 'r', nodes: [[2, 0], [2, 4]] };
    const riverMap: GameMap = { ...tracingMap, chateau: { x: 0, y: 4 }, rivers: [river] };
    const riverKeys = new Set(expandPathCells(river).map((cell) => `${cell.x},${cell.y}`));

    // La rivière coupe la grille en deux : aucune traversée possible d'un bord à l'autre.
    expect(shortestPath(riverMap, [], { x: 0, y: 0 }, { x: 4, y: 0 })).toBeUndefined();

    const alongside = shortestPath(riverMap, [], { x: 0, y: 0 }, { x: 0, y: 4 })!;
    expect(alongside).toBeDefined();
    expect(alongside.some((cell) => riverKeys.has(`${cell.x},${cell.y}`))).toBe(false);
  });

  it('treats the chateau as traversable even when a river runs through it', () => {
    // La rivière passe visuellement sous le château : un chemin doit pouvoir s'y terminer.
    const riverMap: GameMap = {
      ...tracingMap,
      chateau: { x: 2, y: 2 },
      rivers: [{ id: 'r', nodes: [[2, 0], [2, 4]] }],
    };
    const steps = shortestPath(riverMap, [], { x: 1, y: 2 }, { x: 2, y: 2 })!;
    expect(steps).toEqual([{ x: 2, y: 2 }]);
  });

  it('is undefined when the destination is walled in by towers', () => {
    const walled = { x: 2, y: 2 };
    const towers = hexNeighbors(walled).map((cell) => tower(cell.x, cell.y));
    expect(shortestPath(tracingMap, towers, { x: 0, y: 0 }, walled)).toBeUndefined();
  });

  it('is undefined when the destination lies outside the grid', () => {
    expect(shortestPath(tracingMap, [], { x: 0, y: 0 }, { x: 9, y: 9 })).toBeUndefined();
  });

  // Les routes vers le château passent par un BFS mémoïsé depuis le château plutôt que par le BFS
  // général : ces deux tests épinglent ce qui doit rester identique entre les deux chemins de code.
  describe('routes toward the chateau', () => {
    it('is as short as the same route computed toward any other cell', () => {
      const from = { x: 0, y: 0 };
      const toChateau = shortestPath(tracingMap, [], from, tracingMap.chateau)!;

      expect(toChateau).toBeDefined();
      expect(toChateau).toHaveLength(hexDistance(from, tracingMap.chateau));
      expect(toChateau[toChateau.length - 1]).toEqual(tracingMap.chateau);
      expect(isContiguous([from, ...toChateau])).toBe(true);
    });

    it('can start on a blocked cell without ever crossing one', () => {
      // Une case de bord traversée par une rivière est un départ légitime (`initRandomRoute` tire
      // n'importe quelle case de bord), même si aucune route ne peut la traverser.
      const river: MapPath = { id: 'r', nodes: [[0, 0], [0, 2]] };
      const riverMap: GameMap = { ...tracingMap, rivers: [river] };
      const riverKeys = new Set(expandPathCells(river).map((cell) => `${cell.x},${cell.y}`));
      const start = { x: 0, y: 0 };

      expect(riverKeys.has(`${start.x},${start.y}`)).toBe(true);

      const steps = shortestPath(riverMap, [], start, riverMap.chateau)!;
      expect(steps).toBeDefined();
      expect(steps[steps.length - 1]).toEqual(riverMap.chateau);
      expect(steps.some((cell) => riverKeys.has(`${cell.x},${cell.y}`))).toBe(false);
      expect(isContiguous([start, ...steps])).toBe(true);
    });

    it('reflects a fortress that has changed since the last route', () => {
      // L'index est mémoïsé par tableau de tours : une forteresse republiée doit rendre un tracé à
      // jour, pas celui d'avant la pose.
      const from = { x: 4, y: 0 };
      const before = shortestPath(tracingMap, [], from, tracingMap.chateau)!;
      expect(before).toContainEqual({ x: 4, y: 1 });

      const after = shortestPath(tracingMap, [tower(4, 1)], from, tracingMap.chateau)!;
      expect(after).toBeDefined();
      expect(after).not.toContainEqual({ x: 4, y: 1 });
      expect(after[after.length - 1]).toEqual(tracingMap.chateau);
    });
  });
});

describe('routeThroughWaypoints', () => {
  it('passes through each waypoint, in order, on its way to the destination', () => {
    const waypoint = { x: 0, y: 4 };
    const cells = routeThroughWaypoints(tracingMap, [], { x: 0, y: 0 }, [waypoint], { x: 4, y: 4 })!;

    expect(cells).toBeDefined();
    expect(cells).toContainEqual(waypoint);
    expect(cells.indexOf(cells.find((c) => c.x === 0 && c.y === 4)!)).toBeLessThan(cells.length - 1);
    expect(cells[cells.length - 1]).toEqual({ x: 4, y: 4 });
  });

  it('ignores an unreachable waypoint rather than failing the whole route', () => {
    const walled = { x: 2, y: 2 };
    const towers = hexNeighbors(walled).map((cell) => tower(cell.x, cell.y));
    const cells = routeThroughWaypoints(tracingMap, towers, { x: 0, y: 0 }, [walled], { x: 4, y: 4 });

    expect(cells).toBeDefined();
    expect(cells).not.toContainEqual(walled);
    expect(cells![cells!.length - 1]).toEqual({ x: 4, y: 4 });
  });

  it('stops at the chateau when a leg crosses it before the last waypoint', () => {
    // Le château est en (4, 4) ; viser un jalon au-delà fait passer la route dessus, elle s'arrête là.
    const cells = routeThroughWaypoints(tracingMap, [], { x: 4, y: 0 }, [{ x: 4, y: 4 }], {
      x: 0,
      y: 4,
    })!;
    expect(cells[cells.length - 1]).toEqual({ x: 4, y: 4 });
  });

  it('is undefined when the destination is unreachable from the last valid waypoint', () => {
    const walled = { x: 4, y: 4 };
    const towers = hexNeighbors(walled).map((cell) => tower(cell.x, cell.y));
    expect(routeThroughWaypoints(tracingMap, towers, { x: 0, y: 0 }, [], walled)).toBeUndefined();
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
