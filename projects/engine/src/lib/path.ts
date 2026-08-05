import type { GameMap, GridCoord, MapPath, MapSpawn, TowerInstance } from 'shared';
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
 * Ajoute un spawn à la carte (nouvelle carte, sans mutation) : un nouveau point d'entrée
 * créé par le joueur en bord de grille devient persistant, au même titre qu'un spawn
 * prédéfini (CONCEPTION.md §5.3).
 */
export function addMapSpawn(map: GameMap, spawn: MapSpawn): GameMap {
  return { ...map, spawns: [...map.spawns, spawn] };
}

/**
 * Vrai si au moins une case de `cells` n'appartient à aucun des `paths` donnés : une voie
 * dont toutes les cases chevauchent déjà une autre voie n'apporte rien de nouveau
 * (CONCEPTION.md §5.3).
 */
export function hasUniqueCell(cells: readonly GridCoord[], paths: readonly MapPath[]): boolean {
  const covered = new Set<string>();
  for (const path of paths) {
    for (const cell of expandPathCells(path)) {
      covered.add(`${cell.x},${cell.y}`);
    }
  }
  return cells.some((cell) => !covered.has(`${cell.x},${cell.y}`));
}

/** Vrai si `spawn` est le point de départ d'au moins un chemin de `paths` (route reliée). */
export function isSpawnConnected(spawn: MapSpawn, paths: readonly MapPath[]): boolean {
  return paths.some(
    (path) => path.nodes.length > 0 && path.nodes[0][0] === spawn.x && path.nodes[0][1] === spawn.y,
  );
}

/**
 * Retire les spawns qui ne sont plus reliés à aucun chemin (nouvelle carte, sans mutation) :
 * un point d'entrée abandonné par la dernière route qui en partait n'a plus de raison de
 * rester affiché (CONCEPTION.md §5.3).
 */
export function pruneOrphanSpawns(map: GameMap): GameMap {
  return { ...map, spawns: map.spawns.filter((spawn) => isSpawnConnected(spawn, map.paths)) };
}

/**
 * Retire un chemin prédéfini de la carte (nouvelle carte, sans mutation). Les chemins
 * prédéfinis n'ont rien de permanent : le joueur peut en élaguer certains (CONCEPTION.md §5.3) ;
 * ceux qui restent continuent d'apparaître en phases Défense et Attaque. Un spawn que ce chemin
 * laisse sans aucune route reliée disparaît avec lui : un point d'entrée mort n'a plus de raison
 * de rester affiché.
 */
export function removeMapPath(map: GameMap, pathId: string): GameMap {
  return pruneOrphanSpawns({ ...map, paths: map.paths.filter((path) => path.id !== pathId) });
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
