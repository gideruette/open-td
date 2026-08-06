import type { GameMap, GridCoord, MapPath, MapSpawn, TowerInstance } from 'shared';
import { hexDistance, hexLinedraw, hexNeighbors, hexToWorld } from 'shared';
import { cellKey, isChateauCell, isRiverCell, isWithinGrid, riverCells, towerCells } from './fortress';

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

/**
 * Tracé d'un chemin sous la forme directement exploitable pour situer un point le long de lui :
 * les centres world-space des cases traversées, et la distance parcourue depuis le spawn jusqu'à
 * chacun d'eux. Se calcule une fois (`buildPathGeometry`, qui développe le chemin en cases puis les
 * convertit en world-space — de loin la partie coûteuse) et se réutilise ensuite à volonté
 * (`pointAtDistanceOn`). C'est ce qui permet à `DefenseSimulation` de situer des dizaines de
 * monstres à chaque tick sans redévelopper leur chemin à chaque fois.
 */
export interface PathGeometry {
  /** Centres world-space des cases traversées, du spawn au château. */
  centers: readonly GridCoord[];
  /** `cumulative[i]` = distance du spawn jusqu'à `centers[i]` ; croissante, `cumulative[0] === 0`. */
  cumulative: readonly number[];
  /** Longueur totale du chemin (dernière valeur de `cumulative`, 0 pour un chemin réduit à un point). */
  totalLength: number;
}

/** Précalcule la géométrie d'un chemin — voir `PathGeometry`. */
export function buildPathGeometry(path: MapPath): PathGeometry {
  const centers = expandPathCells(path).map((cell) => hexToWorld(cell));
  const cumulative: number[] = centers.length > 0 ? [0] : [];
  for (let i = 1; i < centers.length; i++) {
    cumulative.push(cumulative[i - 1] + segmentLength(centers[i - 1], centers[i]));
  }
  return { centers, cumulative, totalLength: cumulative[cumulative.length - 1] ?? 0 };
}

/**
 * Position interpolée le long d'un chemin précalculé à la distance parcourue donnée (clampée aux
 * extrémités), en world-space. Le segment porteur est trouvé par dichotomie sur les distances
 * cumulées plutôt qu'en parcourant le chemin depuis le spawn : le coût ne dépend plus de l'avancée
 * du monstre le long de sa route.
 */
export function pointAtDistanceOn(geometry: PathGeometry, distance: number): GridCoord {
  const { centers, cumulative } = geometry;
  if (centers.length === 0) {
    return { x: 0, y: 0 };
  }
  if (distance <= 0) {
    return centers[0];
  }
  if (distance >= geometry.totalLength) {
    return centers[centers.length - 1];
  }

  // Plus grand `low` tel que `cumulative[low] <= distance` : le segment [low, low + 1] porte le point.
  let low = 0;
  let high = centers.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (cumulative[mid] <= distance) {
      low = mid;
    } else {
      high = mid;
    }
  }

  const from = centers[low];
  const to = centers[low + 1];
  const segLen = cumulative[low + 1] - cumulative[low];
  const t = segLen === 0 ? 0 : (distance - cumulative[low]) / segLen;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

/** Longueur totale d'un chemin (somme des segments entre centres hex voisins). */
export function pathLength(path: MapPath): number {
  return buildPathGeometry(path).totalLength;
}

/**
 * Position interpolée le long du chemin à la distance parcourue donnée (clampée aux extrémités),
 * en world-space. Redéveloppe le chemin à chaque appel : pour situer répétitivement des points sur
 * un même chemin, précalculer sa géométrie (`buildPathGeometry`) et passer par `pointAtDistanceOn`.
 */
export function pointAtDistance(path: MapPath, distance: number): GridCoord {
  return pointAtDistanceOn(buildPathGeometry(path), distance);
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

/** Union des cases traversées par `paths`, chacune comptée une seule fois même si plusieurs chemins s'y superposent. */
export function coveredCells(paths: readonly MapPath[]): Set<string> {
  const covered = new Set<string>();
  for (const path of paths) {
    for (const cell of expandPathCells(path)) {
      covered.add(`${cell.x},${cell.y}`);
    }
  }
  return covered;
}

/**
 * Vrai si au moins une case de `cells` n'appartient à aucun des `paths` donnés : une voie
 * dont toutes les cases chevauchent déjà une autre voie n'apporte rien de nouveau
 * (CONCEPTION.md §5.3).
 */
export function hasUniqueCell(cells: readonly GridCoord[], paths: readonly MapPath[]): boolean {
  const covered = coveredCells(paths);
  return cells.some((cell) => !covered.has(`${cell.x},${cell.y}`));
}

/** Coût en budget d'attaque d'une case de chemin (CONCEPTION.md §5.3). */
export const PATH_CELL_COST = 1;

/**
 * Coût total des cases occupées par `paths` : chaque case n'est facturée qu'une fois, même
 * si plusieurs chemins s'y superposent (CONCEPTION.md §5.3).
 */
export function pathCellsCost(paths: readonly MapPath[], costPerCell: number = PATH_CELL_COST): number {
  return coveredCells(paths).size * costPerCell;
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
 * précédente, et ne traverse ni une case occupée par une tour ni une rivière (CONCEPTION.md §5.3).
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
  if (isRiverCell(map, to)) {
    return false;
  }
  return !towers.some((tower) => tower.position.x === to.x && tower.position.y === to.y);
}

/**
 * Simplifie une liste ordonnée de cases en supprimant les boucles : dès qu'une case déjà
 * traversée réapparaît plus loin, les cases intermédiaires (la boucle) sont retirées et le tracé
 * reprend depuis cette case — un chemin ne doit jamais repasser deux fois par le même point, que
 * ce soit tracé à la main (`handleTracingClick`) ou généré au hasard (IA d'attaque).
 */
export function simplifyPathCells(cells: readonly GridCoord[]): GridCoord[] {
  const result: GridCoord[] = [];
  const indexOfCell = new Map<string, number>();
  for (const cell of cells) {
    const key = cellKey(cell);
    const loopStart = indexOfCell.get(key);
    if (loopStart !== undefined) {
      result.length = loopStart + 1;
      for (const [otherKey, index] of indexOfCell) {
        if (index > loopStart) {
          indexOfCell.delete(otherKey);
        }
      }
      continue;
    }
    indexOfCell.set(key, result.length);
    result.push(cell);
  }
  return result;
}

/**
 * Plus court chemin (BFS, cases hex de coût uniforme) entre deux cases de la grille, en évitant
 * les cases occupées par une tour et les rivières. Cases traversées, `from` exclue et `to` incluse
 * (même convention que `hexLinedraw`) ; `undefined` si `to` est inatteignable (encerclée de tours).
 */
/**
 * Prédécesseur de chaque case de la grille sur un plus court chemin vers le château, obtenu par un
 * unique BFS **depuis** le château. Le graphe étant non orienté et à coût uniforme, remonter les
 * prédécesseurs depuis une case donnée reconstitue un plus court chemin de cette case au château —
 * en O(longueur du chemin) au lieu d'un BFS complet.
 *
 * C'est le cas qui revient sans cesse : le dernier tronçon de **toute** route générée vise le
 * château (`initRandomRoute`, `blendRoutes`, `removeRandomWaypoint` via `routeThroughWaypoints`),
 * et l'IA d'attaque en trace des milliers par recherche.
 *
 * Une case bloquée (tour, rivière) reçoit bien un prédécesseur mais n'est jamais développée : on
 * peut donc *partir* d'une case bloquée — une case de bord traversée par une rivière, par exemple —
 * sans jamais en *traverser* une, exactement comme le BFS général ci-dessous.
 */
const parentsTowardChateauByMap = new WeakMap<
  GameMap,
  WeakMap<object, Map<string, GridCoord>>
>();

function parentsTowardChateau(
  map: GameMap,
  towers: readonly TowerInstance[],
): Map<string, GridCoord> {
  let byFortress = parentsTowardChateauByMap.get(map);
  if (!byFortress) {
    byFortress = new WeakMap<object, Map<string, GridCoord>>();
    parentsTowardChateauByMap.set(map, byFortress);
  }
  const cached = byFortress.get(towers);
  if (cached) {
    return cached;
  }

  const rivers = riverCells(map);
  const occupied = towerCells(towers);
  const parents = new Map<string, GridCoord>();
  const visited = new Set<string>([cellKey(map.chateau)]);
  const queue: GridCoord[] = [map.chateau];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    for (const neighbor of hexNeighbors(current)) {
      if (!isWithinGrid(map, neighbor)) {
        continue;
      }
      const key = cellKey(neighbor);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      parents.set(key, current);
      if (occupied.has(key) || rivers.has(key)) {
        // Atteignable comme point de départ, jamais comme case de passage.
        continue;
      }
      queue.push(neighbor);
    }
  }

  byFortress.set(towers, parents);
  return parents;
}

export function shortestPath(
  map: GameMap,
  towers: readonly TowerInstance[],
  from: GridCoord,
  to: GridCoord,
): GridCoord[] | undefined {
  const fromKey = cellKey(from);
  const toKey = cellKey(to);
  if (fromKey === toKey) {
    return [];
  }

  // Route vers le château : remontée des prédécesseurs mémoïsés plutôt qu'un BFS de plus.
  if (toKey === cellKey(map.chateau)) {
    const parents = parentsTowardChateau(map, towers);
    const path: GridCoord[] = [];
    let step = parents.get(fromKey);
    while (step) {
      path.push(step);
      if (cellKey(step) === toKey) {
        return path;
      }
      step = parents.get(cellKey(step));
    }
    return undefined;
  }

  // Obstacles indexés plutôt que testés un à un : `isRiverCell` redéveloppait les rivières en cases
  // à chaque appel et `findTowerAt` reparcourait toutes les tours. Les deux index sont mémoïsés par
  // carte et par tableau de tours, donc construits une fois pour toute une recherche d'IA.
  const rivers = riverCells(map);
  const occupied = towerCells(towers);

  const visited = new Set<string>([fromKey]);
  const previous = new Map<string, GridCoord>();
  // File FIFO parcourue par curseur : `Array.shift()` est en O(n), ce qui rendait le BFS quadratique.
  const queue: GridCoord[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    for (const neighbor of hexNeighbors(current)) {
      if (!isWithinGrid(map, neighbor)) {
        continue;
      }
      const neighborKey = cellKey(neighbor);
      if (visited.has(neighborKey) || occupied.has(neighborKey) || rivers.has(neighborKey)) {
        continue;
      }
      visited.add(neighborKey);
      previous.set(neighborKey, current);
      if (neighborKey === toKey) {
        const path: GridCoord[] = [neighbor];
        let step = current;
        while (cellKey(step) !== fromKey) {
          path.unshift(step);
          step = previous.get(cellKey(step))!;
        }
        return path;
      }
      queue.push(neighbor);
    }
  }
  return undefined;
}

/**
 * Route reliant `from` à `to` en passant par chacun des `waypoints` donnés, dans l'ordre, chaque
 * tronçon via `shortestPath` (donc en évitant les tours). Un jalon inatteignable depuis le
 * précédent est simplement ignoré, plutôt que de faire échouer toute la route — utile pour
 * composer des détours ou recombiner des chemins à partir de points tirés au hasard (IA
 * d'attaque). `undefined` seulement si `to` reste inatteignable depuis le dernier jalon valide
 * (même sémantique que `shortestPath`). Le château n'étant pas un obstacle pour `shortestPath`, un
 * tronçon vers un jalon (ou `to`) situé au-delà peut le traverser en chemin : la route s'arrête
 * dès cette case, jalons et tronçon final restants abandonnés — même règle que le tracé manuel
 * (`handleTracingClick`).
 */
export function routeThroughWaypoints(
  map: GameMap,
  towers: readonly TowerInstance[],
  from: GridCoord,
  waypoints: readonly GridCoord[],
  to: GridCoord,
): GridCoord[] | undefined {
  const cells: GridCoord[] = [];
  let cursor = from;
  for (const waypoint of waypoints) {
    const segment = shortestPath(map, towers, cursor, waypoint);
    if (!segment) {
      continue;
    }
    for (const step of segment) {
      cells.push(step);
      if (isChateauCell(map, step)) {
        return cells;
      }
    }
    cursor = waypoint;
  }
  const finalSegment = shortestPath(map, towers, cursor, to);
  if (!finalSegment) {
    return undefined;
  }
  for (const step of finalSegment) {
    cells.push(step);
    if (isChateauCell(map, step)) {
      break;
    }
  }
  return cells;
}
