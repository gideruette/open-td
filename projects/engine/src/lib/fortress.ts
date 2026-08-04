import type {
  GameMap,
  GridCoord,
  PlacementResult,
  TowerInstance,
  TowerType,
} from 'shared';

function sameCoord(a: GridCoord, b: GridCoord): boolean {
  return a.x === b.x && a.y === b.y;
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
 * tour), sans le budget : réutilisable pour un déplacement, qui ne paie pas le coût plein
 * (CONCEPTION.md §4). Ne mute rien.
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
  if (findTowerAt(towers, coord)) {
    return { ok: false, reason: 'occupied' };
  }
  return { ok: true };
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
