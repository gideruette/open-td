import type { GameMap, GridCoord, MapPath, TowerInstance } from 'shared';
import { isWithinGrid } from './fortress';

function segmentLength(a: readonly [number, number], b: readonly [number, number]): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Longueur totale d'un chemin (somme des segments), en cases de grille. */
export function pathLength(path: MapPath): number {
  let total = 0;
  for (let i = 1; i < path.nodes.length; i++) {
    total += segmentLength(path.nodes[i - 1], path.nodes[i]);
  }
  return total;
}

/** Position interpolée le long du chemin à la distance parcourue donnée (clampée aux extrémités). */
export function pointAtDistance(path: MapPath, distance: number): GridCoord {
  if (path.nodes.length === 0) {
    return { x: 0, y: 0 };
  }
  if (distance <= 0) {
    const [x, y] = path.nodes[0];
    return { x, y };
  }

  let remaining = distance;
  for (let i = 1; i < path.nodes.length; i++) {
    const [ax, ay] = path.nodes[i - 1];
    const [bx, by] = path.nodes[i];
    const segLen = segmentLength(path.nodes[i - 1], path.nodes[i]);
    if (remaining <= segLen) {
      const t = segLen === 0 ? 0 : remaining / segLen;
      return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
    }
    remaining -= segLen;
  }

  const [x, y] = path.nodes[path.nodes.length - 1];
  return { x, y };
}

export function isSpawnCell(map: GameMap, coord: GridCoord): boolean {
  return map.spawns.some((spawn) => spawn.x === coord.x && spawn.y === coord.y);
}

/**
 * Retire un chemin prédéfini de la carte (nouvelle carte, sans mutation). Les chemins
 * prédéfinis n'ont rien de permanent : le joueur peut en élaguer certains (CONCEPTION.md §5.3) ;
 * ceux qui restent continuent d'apparaître en phases Défense et Attaque.
 */
export function removeMapPath(map: GameMap, pathId: string): GameMap {
  return { ...map, paths: map.paths.filter((path) => path.id !== pathId) };
}

/**
 * Ajoute un chemin à la carte (nouvelle carte, sans mutation). Un tracé libre validé devient
 * ainsi un chemin persistant au même titre qu'un chemin prédéfini : il survit à la remise à
 * zéro des voies en cours de composition et continue d'apparaître en Défense et en Attaque
 * (CONCEPTION.md §5.3).
 */
export function addMapPath(map: GameMap, path: MapPath): GameMap {
  return { ...map, paths: [...map.paths, path] };
}

/** Deux cases sont adjacentes (diagonales incluses) si leur distance de Chebyshev vaut 1. */
export function isAdjacentCell(a: GridCoord, b: GridCoord): boolean {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) === 1;
}

/**
 * Cases intermédiaires entre `from` (exclue) et `to` (incluse), par pas d'une case
 * (diagonales incluses) : permet de cliquer directement une case distante lors d'un tracé
 * libre, les cases traversées étant comblées automatiquement (CONCEPTION.md §5.3).
 */
export function cellsBetween(from: GridCoord, to: GridCoord): GridCoord[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  const cells: GridCoord[] = [];
  for (let i = 1; i <= steps; i++) {
    cells.push({
      x: from.x + Math.round((dx * i) / steps),
      y: from.y + Math.round((dy * i) / steps),
    });
  }
  return cells;
}

/**
 * Un pas de tracé libre est valide s'il reste dans la grille, est adjacent à la case
 * précédente, et ne traverse pas une case occupée par une tour (CONCEPTION.md §5.3).
 */
export function isValidPathStep(
  map: GameMap,
  towers: readonly TowerInstance[],
  from: GridCoord,
  to: GridCoord,
): boolean {
  if (!isWithinGrid(map, to) || !isAdjacentCell(from, to)) {
    return false;
  }
  return !towers.some((tower) => tower.position.x === to.x && tower.position.y === to.y);
}
