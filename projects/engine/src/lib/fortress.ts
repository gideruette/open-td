import type {
  GameMap,
  GridCoord,
  PlacementResult,
  TowerInstance,
  TowerType,
} from 'shared';
import { expandPathCells } from './path';

function sameCoord(a: GridCoord, b: GridCoord): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Clé d'indexation d'une case, commune aux ensembles de cases mémoïsés ci-dessous. */
export function cellKey(coord: GridCoord): string {
  return `${coord.x},${coord.y}`;
}

/**
 * Cases traversées par une rivière — voir `isRiverCell` pour la sémantique (château exclu).
 * Développer les rivières en cases (`expandPathCells`, un `hexLinedraw` par tronçon) est bien trop
 * coûteux pour être refait à chaque case testée, alors que le tracé des rivières d'une carte ne
 * change jamais de toute la partie.
 *
 * L'index est mémoïsé sur le **tableau `rivers`**, pas sur l'objet carte : tracer un chemin ou
 * ajouter un spawn republie une nouvelle carte (`{ ...map, paths: [...] }`, voir `addMapPath`) tout
 * en conservant le même tableau de rivières. Une clé posée sur la carte serait invalidée à chaque
 * tracé ; posée sur les rivières, l'index survit à toute la partie.
 */
const riverCellsByRivers = new WeakMap<object, Set<string>>();

/**
 * Cases infranchissables par une rivière sur cette carte (château exclu), développées une seule
 * fois puis mémoïsées. À appeler dès le chargement de la carte pour que le coût soit payé là
 * plutôt qu'au premier tracé ou au premier tour d'IA.
 */
export function riverCells(map: GameMap): ReadonlySet<string> {
  const rivers = map.rivers;
  if (!rivers || rivers.length === 0) {
    return EMPTY_CELLS;
  }
  const cached = riverCellsByRivers.get(rivers);
  if (cached) {
    return cached;
  }
  const cells = new Set<string>();
  for (const river of rivers) {
    for (const cell of expandPathCells(river)) {
      if (!isChateauCell(map, cell)) {
        cells.add(cellKey(cell));
      }
    }
  }
  riverCellsByRivers.set(rivers, cells);
  return cells;
}

/** Ensemble vide partagé, renvoyé pour une carte sans rivière ni chemin (rien à mémoïser). */
const EMPTY_CELLS: ReadonlySet<string> = new Set<string>();

/**
 * Cases traversées par un chemin prédéfini ou tracé — voir `isPathCell`. Mémoïsé sur le **tableau
 * `paths`** exactement comme `riverCellsByRivers` l'est sur `rivers`, et pour la même raison : le
 * développement en cases (`expandPathCells`, un `hexLinedraw` par tronçon) est bien trop coûteux
 * pour être refait à chaque case testée, alors que `canOccupyCell` teste des centaines de cases par
 * tour candidate. Une carte à deux chemins prédéfinis de 40 cases redéveloppait 80 cases à *chaque*
 * appel — de loin le premier point chaud de la construction d'une forteresse candidate.
 */
const pathCellsByPaths = new WeakMap<object, Set<string>>();

/** Cases occupées par un chemin de la carte, développées une seule fois puis mémoïsées. */
export function pathCells(map: GameMap): ReadonlySet<string> {
  const paths = map.paths;
  if (paths.length === 0) {
    return EMPTY_CELLS;
  }
  const cached = pathCellsByPaths.get(paths);
  if (cached) {
    return cached;
  }
  const cells = new Set<string>();
  for (const path of paths) {
    for (const cell of expandPathCells(path)) {
      cells.add(cellKey(cell));
    }
  }
  pathCellsByPaths.set(paths, cells);
  return cells;
}

/**
 * Cases occupées par une tour, indexées par tableau de tours. Le moteur ne modifie jamais un
 * tableau de tours en place — il en publie un nouveau à chaque pose, retrait ou déplacement
 * (`GameEngine`) — donc l'identité du tableau suffit à identifier la forteresse. C'est ce qui rend
 * l'index réutilisable pendant toute une recherche d'IA, où la forteresse est figée et où
 * `shortestPath` est appelé des milliers de fois sur elle.
 */
const towerCellsByTowers = new WeakMap<object, Set<string>>();

/** Cases occupées par une tour, indexées pour un test en O(1). */
export function towerCells(towers: readonly TowerInstance[]): ReadonlySet<string> {
  const cached = towerCellsByTowers.get(towers);
  if (cached) {
    return cached;
  }
  const cells = new Set(towers.map((tower) => cellKey(tower.position)));
  towerCellsByTowers.set(towers, cells);
  return cells;
}

export function isWithinGrid(map: GameMap, coord: GridCoord): boolean {
  return coord.x >= 0 && coord.y >= 0 && coord.x < map.grid.cols && coord.y < map.grid.rows;
}

export function isChateauCell(map: GameMap, coord: GridCoord): boolean {
  return map.chateau.x === coord.x && map.chateau.y === coord.y;
}

/** Une case de bord (première/dernière ligne ou colonne) : jamais constructible. */
export function isBorderCell(map: GameMap, coord: GridCoord): boolean {
  return (
    coord.x === 0 ||
    coord.y === 0 ||
    coord.x === map.grid.cols - 1 ||
    coord.y === map.grid.rows - 1
  );
}

/** Une case traversée par un chemin (prédéfini ou tracé) : jamais constructible. */
export function isPathCell(map: GameMap, coord: GridCoord): boolean {
  return pathCells(map).has(cellKey(coord));
}

/**
 * Une case traversée par une rivière : jamais constructible, jamais franchissable par un chemin.
 * La case du château fait exception : visuellement la rivière la traverse (elle passe dessous),
 * mais un chemin doit pouvoir s'y terminer et une tour n'y a de toute façon jamais sa place
 * (déjà exclue par `isChateauCell`).
 */
export function isRiverCell(map: GameMap, coord: GridCoord): boolean {
  return riverCells(map).has(cellKey(coord));
}

export function findTowerAt(
  towers: readonly TowerInstance[],
  coord: GridCoord,
): TowerInstance | undefined {
  return towers.find((tower) => sameCoord(tower.position, coord));
}

/** Coût déjà engagé par les tours posées, selon le catalogue fourni. */
export function spentBudget(
  towers: readonly TowerInstance[],
  catalog: readonly TowerType[],
): number {
  return towers.reduce((total, tower) => {
    const type = catalog.find((candidate) => candidate.id === tower.typeId);
    return total + (type?.cost ?? 0);
  }, 0);
}

/**
 * Règles géométriques d'occupation d'une case (grille, château, bord, occupation par une autre
 * tour), sans le budget : réutilisable pour un déplacement, toujours gratuit (CONCEPTION.md §4).
 * Ne mute rien.
 */
export function canOccupyCell(
  map: GameMap | undefined,
  towers: readonly TowerInstance[],
  coord: GridCoord,
): PlacementResult {
  if (!map) {
    return { ok: false, reason: 'map-not-loaded' };
  }
  if (!isWithinGrid(map, coord)) {
    return { ok: false, reason: 'out-of-bounds' };
  }
  if (isChateauCell(map, coord)) {
    return { ok: false, reason: 'chateau-cell' };
  }
  if (isBorderCell(map, coord)) {
    return { ok: false, reason: 'border-cell' };
  }
  if (isPathCell(map, coord)) {
    return { ok: false, reason: 'path-cell' };
  }
  if (isRiverCell(map, coord)) {
    return { ok: false, reason: 'river-cell' };
  }
  if (findTowerAt(towers, coord)) {
    return { ok: false, reason: 'occupied' };
  }
  return { ok: true };
}

/**
 * Cases constructibles d'après la géométrie (hors château, bords, rivières, chemins). Mémoïsé sans
 * les tours : la forteresse persistante occupe des cases en plus, filtrées via `occupiedTowers`.
 */
const buildableCellsByMap = new WeakMap<GameMap, Set<string>>();

export function buildableCells(
  map: GameMap,
  occupiedTowers: readonly TowerInstance[] = [],
): ReadonlySet<string> {
  const cached = buildableCellsByMap.get(map);
  let cells = cached;
  if (!cells) {
    cells = new Set<string>();
    for (let x = 0; x < map.grid.cols; x++) {
      for (let y = 0; y < map.grid.rows; y++) {
        if (canOccupyCell(map, [], { x, y }).ok) {
          cells.add(cellKey({ x, y }));
        }
      }
    }
    buildableCellsByMap.set(map, cells);
  }
  if (occupiedTowers.length === 0) {
    return cells;
  }
  const occupied = new Set(occupiedTowers.map((tower) => cellKey(tower.position)));
  return new Set([...cells].filter((key) => !occupied.has(key)));
}

/** Règles de placement d'une tour (grille, occupation, budget). Ne mute rien. */
export function canPlaceTower(
  map: GameMap | undefined,
  towers: readonly TowerInstance[],
  towerType: TowerType | undefined,
  coord: GridCoord,
  remainingBudget: number,
): PlacementResult {
  if (!towerType) {
    return { ok: false, reason: 'unknown-tower-type' };
  }
  const occupancy = canOccupyCell(map, towers, coord);
  if (!occupancy.ok) {
    return occupancy;
  }
  if (remainingBudget < towerType.cost) {
    return { ok: false, reason: 'insufficient-budget' };
  }
  return { ok: true };
}

/** Retire une tour de la liste (nouvelle liste, sans mutation). */
export function removeTower(towers: readonly TowerInstance[], towerId: string): TowerInstance[] {
  return towers.filter((tower) => tower.id !== towerId);
}
