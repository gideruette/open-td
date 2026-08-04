import type { GameMap, GridCoord, MapPath, TowerInstance } from 'shared';
import { hexDistance, hexLinedraw, hexToWorld } from 'shared';
import { isWithinGrid } from './fortress';

function segmentLength(a: GridCoord, b: GridCoord): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Développe les waypoints d'un chemin en la liste ordonnée de cases hex traversées
 * (centres successifs, voisins à distance 1). C'est la polyligne suivie à l'écran et
 * par les monstres — pas la corde droite entre deux coins.
 */
export function expandPathCells(path: MapPath): GridCoord[] {
  if (path.nodes.length === 0) {
    return [];
  }
  const cells: GridCoord[] = [{ x: path.nodes[0][0], y: path.nodes[0][1] }];
  for (let i = 1; i < path.nodes.length; i++) {
    const from = cells[cells.length - 1];
    const to = { x: path.nodes[i][0], y: path.nodes[i][1] };
    cells.push(...hexLinedraw(from, to));
  }
  return cells;
}

function cellWorldCenters(path: MapPath): GridCoord[] {
  return expandPathCells(path).map((cell) => hexToWorld(cell));
}

/** Longueur totale d'un chemin (somme des segments entre centres hex voisins). */
export function pathLength(path: MapPath): number {
  const centers = cellWorldCenters(path);
  let total = 0;
  for (let i = 1; i < centers.length; i++) {
    total += segmentLength(centers[i - 1], centers[i]);
  }
  return total;
}

/** Position interpolée le long du chemin à la distance parcourue donnée (clampée aux extrémités), en world-space. */
export function pointAtDistance(path: MapPath, distance: number): GridCoord {
  const centers = cellWorldCenters(path);
  if (centers.length === 0) {
    return { x: 0, y: 0 };
  }
  if (distance <= 0) {
    return centers[0];
  }

  let remaining = distance;
  for (let i = 1; i < centers.length; i++) {
    const from = centers[i - 1];
    const to = centers[i];
    const segLen = segmentLength(from, to);
    if (remaining <= segLen) {
      const t = segLen === 0 ? 0 : remaining / segLen;
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
    }
    remaining -= segLen;
  }

  return centers[centers.length - 1];
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

/** Deux cases sont adjacentes si leur distance hex vaut 1 (6 voisins). */
export function isAdjacentCell(a: GridCoord, b: GridCoord): boolean {
  return hexDistance(a, b) === 1;
}

/**
 * Cases intermédiaires entre `from` (exclue) et `to` (incluse), par pas d'une case hex :
 * permet de cliquer directement une case distante lors d'un tracé libre, les cases
 * traversées étant comblées automatiquement (CONCEPTION.md §5.3).
 */
export function cellsBetween(from: GridCoord, to: GridCoord): GridCoord[] {
  return hexLinedraw(from, to);
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
