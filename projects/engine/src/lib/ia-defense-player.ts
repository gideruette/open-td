import type { GameMap, GridCoord, MonsterType, TowerInstance, TowerType, Wave } from 'shared';
import { MONSTER_TYPES, TOWER_TYPES, hexDistance } from 'shared';
import { phaseScore } from './combat';
import { canPlaceTower } from './fortress';
import { shuffled } from './ia-player';
import { expandPathCells } from './path';

/**
 * Entrées nécessaires pour faire jouer l'ordinateur la phase Défense : la carte, le budget de
 * défense disponible et la vague à tenir.
 */
export interface DefensePlayerInput {
  map: GameMap;
  wave: Wave;
  defenseBudget: number;
  chateauMaxHp: number;
  monsterCatalog?: readonly MonsterType[];
  towerCatalog?: readonly TowerType[];
  /** Budget de temps (ms) alloué à la recherche génétique — voir `evolveDefense`. */
  maxTime?: number;
}

/** Toutes les cases traversées par au moins une voie de la vague à tenir. */
function routeCells(wave: Wave): GridCoord[] {
  return wave.lanes.flatMap((lane) => expandPathCells(lane.path));
}

/** Cases de la carte à portée (`range`) d'au moins une case de `routes` : une tour hors de cette zone ne tirerait sur aucun monstre de la vague. */
function cellsInRange(map: GameMap, routes: readonly GridCoord[], range: number): GridCoord[] {
  const cells: GridCoord[] = [];
  for (let x = 0; x < map.grid.cols; x++) {
    for (let y = 0; y < map.grid.rows; y++) {
      const coord = { x, y };
      if (routes.some((cell) => hexDistance(cell, coord) <= range)) {
        cells.push(coord);
      }
    }
  }
  return cells;
}

/**
 * Initialise une tour candidate aléatoire : un type de tour achetable tiré au hasard, posé sur
 * une case tirée au hasard parmi celles à portée d'une voie de la vague à tenir (une tour hors de
 * portée de toute voie ne servirait à rien). Essaie tous les types puis toutes les cases (ordre
 * aléatoire) jusqu'à trouver un placement valide (`canPlaceTower` : grille, occupation, budget).
 * Brique de base (population initiale, mutations) de l'algorithme génétique — voir aussi
 * `initRandomRoute` côté Attaque. `undefined` si aucun placement n'est possible.
 */
export function initRandomTower(
  map: GameMap,
  towers: readonly TowerInstance[],
  wave: Wave,
  remainingBudget: number,
  towerCatalog: readonly TowerType[] = TOWER_TYPES,
): TowerInstance | undefined {
  const routes = routeCells(wave);
  const buyable = towerCatalog.filter((type) => type.cost <= remainingBudget);
  for (const type of shuffled(buyable)) {
    for (const coord of shuffled(cellsInRange(map, routes, type.range))) {
      if (canPlaceTower(map, towers, type, coord, remainingBudget).ok) {
        return {
          id: `ia-tower-${Math.floor(Math.random() * 1e9)}`,
          typeId: type.id,
          position: coord,
          level: 1,
          placedAtPalier: 0,
        };
      }
    }
  }
  return undefined;
}

/**
 * Initialise une forteresse candidate aléatoire : tant qu'il reste du budget de défense, pose une
 * tour aléatoire à portée d'une voie de la vague à tenir (`initRandomTower`). S'arrête dès qu'aucun
 * placement n'est plus possible (budget épuisé ou plus aucune case libre à portée). Brique de base
 * (population initiale, mutations) de l'algorithme génétique.
 */
export function initRandomDefense(
  map: GameMap,
  wave: Wave,
  defenseBudget: number,
  towerCatalog: readonly TowerType[] = TOWER_TYPES,
): TowerInstance[] {
  const towers: TowerInstance[] = [];
  let remainingBudget = defenseBudget;
  for (;;) {
    const tower = initRandomTower(map, towers, wave, remainingBudget, towerCatalog);
    if (!tower) {
      break;
    }
    towers.push(tower);
    const type = towerCatalog.find((candidate) => candidate.id === tower.typeId)!;
    remainingBudget -= type.cost;
  }
  return towers;
}

/**
 * Coût total (budget de défense) d'une liste de tours, tous types confondus.
 */
function defenseCost(towers: readonly TowerInstance[], towerCatalog: readonly TowerType[]): number {
  return towers.reduce((total, tower) => {
    const type = towerCatalog.find((candidate) => candidate.id === tower.typeId);
    return total + (type?.cost ?? 0);
  }, 0);
}

/**
 * Croise deux forteresses parentes pour en produire une conforme : pour chaque tour (indexée de 0
 * à la plus grande longueur des deux parents), la tour (position + type, indissociables — au
 * contraire d'une voie d'attaque, une tour n'a pas de « file » à recombiner séparément) est
 * piochée chez l'un des deux parents tiré au hasard (l'autre sert de repli s'il n'a pas de tour à
 * cet index). Une tour dont la position ferait doublon avec une tour déjà retenue est ignorée : le
 * croisement ne doit pas produire deux tours sur la même case. Brique de reproduction de
 * l'algorithme génétique — voir `evolveDefense`.
 */
export function crossDefenses(
  parentA: readonly TowerInstance[],
  parentB: readonly TowerInstance[],
): TowerInstance[] {
  const towerCount = Math.max(parentA.length, parentB.length);
  const towers: TowerInstance[] = [];
  const usedPositions = new Set<string>();

  for (let i = 0; i < towerCount; i++) {
    const [firstParent, secondParent] = shuffled([parentA, parentB]);
    const tower = firstParent[i] ?? secondParent[i];
    if (!tower) {
      continue;
    }
    const key = `${tower.position.x},${tower.position.y}`;
    if (usedPositions.has(key)) {
      continue;
    }
    usedPositions.add(key);
    towers.push({ ...tower });
  }

  return towers;
}

/** Probabilité qu'une forteresse fille issue du croisement soit mutée avant d'être notée. */
const MUTATION_RATE = 0.15;

/**
 * Mute une forteresse fille pour réintroduire de la diversité que le seul croisement ne peut pas
 * produire (il ne fait que recombiner des tours déjà présentes dans la population) : avec
 * probabilité `MUTATION_RATE`, remplace une tour tirée au hasard par une nouvelle tour aléatoire
 * (position et type, `initRandomTower`) — calculée avec le budget encore disponible une fois les
 * autres tours payées, pour ne jamais dépasser `defenseBudget` par la seule mutation. Si aucun
 * remplacement n'est possible (plus de case libre à portée), la tour mutée est simplement retirée.
 * Inchangée si la forteresse n'a aucune tour.
 */
function mutateDefense(
  towers: readonly TowerInstance[],
  map: GameMap,
  wave: Wave,
  defenseBudget: number,
  towerCatalog: readonly TowerType[],
): TowerInstance[] {
  if (towers.length === 0 || Math.random() > MUTATION_RATE) {
    return [...towers];
  }

  const index = Math.floor(Math.random() * towers.length);
  const others = towers.filter((_, i) => i !== index);
  const remainingBudget = Math.max(0, defenseBudget - defenseCost(others, towerCatalog));
  const mutatedTower = initRandomTower(map, others, wave, remainingBudget, towerCatalog);
  return mutatedTower ? [...others, mutatedTower] : others;
}

/**
 * Ramène une forteresse dans son budget de défense : `crossDefenses` recombine des tours chacune
 * valide chez son parent d'origine, mais leur coût total peut dépasser `defenseBudget` une fois
 * réunies dans la forteresse fille. Tant que le coût total dépasse le budget, retire une tour
 * tirée au hasard.
 */
export function enforceDefenseBudget(
  towers: readonly TowerInstance[],
  defenseBudget: number,
  towerCatalog: readonly TowerType[],
): TowerInstance[] {
  let remaining = [...towers];
  while (remaining.length > 0 && defenseCost(remaining, towerCatalog) > defenseBudget) {
    const index = Math.floor(Math.random() * remaining.length);
    remaining = remaining.filter((_, i) => i !== index);
  }
  return remaining;
}

/**
 * Note une forteresse avec `phaseScore` en mode 'defense' : entre deux défenses qui échouent (le
 * château a encaissé au moins un point de dégât), la vie du château la plus haute — la plus
 * proche de rester intacte — est la meilleure ; entre deux défenses qui tiennent la vague sans
 * aucun dégât, la plus étalée l'emporte (`spreadScore`), et surtout celle dont les tours sont
 * postées le plus près du château — plus la défense y contraint les routes possibles de
 * l'attaque au palier suivant.
 */
function scoreDefense(
  towers: readonly TowerInstance[],
  wave: Wave,
  chateauMaxHp: number,
  chateau: GridCoord,
  monsterCatalog: readonly MonsterType[],
  towerCatalog: readonly TowerType[],
): number {
  return phaseScore(towers, wave, chateauMaxHp, chateau, monsterCatalog, towerCatalog, 'defense');
}

/** Trie `candidates` par score décroissant (mode 'defense') et n'en garde que les `count` meilleures. */
function fittestDefenses(
  candidates: readonly (readonly TowerInstance[])[],
  count: number,
  wave: Wave,
  chateauMaxHp: number,
  chateau: GridCoord,
  monsterCatalog: readonly MonsterType[],
  towerCatalog: readonly TowerType[],
): TowerInstance[][] {
  return candidates
    .map((towers) => ({
      towers: [...towers],
      score: scoreDefense(towers, wave, chateauMaxHp, chateau, monsterCatalog, towerCatalog),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((entry) => entry.towers);
}

const DEFAULT_POPULATION_SIZE = 20;

/**
 * Compose une forteresse via un algorithme génétique : la population initiale est tirée au hasard
 * en double (`2 * populationSize` forteresses, `initRandomDefense`), dont on ne garde que les
 * `populationSize` meilleures (`phaseScore` en mode 'defense'). À chaque génération, on croise des
 * paires de parents tirées au hasard dans la population (`crossDefenses`), on mute de temps en
 * temps les forteresses filles obtenues (`mutateDefense`) pour préserver la diversité génétique,
 * on les ramène dans le budget de défense (`enforceDefenseBudget`), puis on ne garde que les
 * `populationSize` meilleures parmi population + filles réunies. Boucle jusqu'à épuisement de
 * `maxTime` ms, puis retourne la meilleure forteresse trouvée.
 */
export function evolveDefense(
  map: GameMap,
  wave: Wave,
  defenseBudget: number,
  chateauMaxHp: number,
  monsterCatalog: readonly MonsterType[] = MONSTER_TYPES,
  towerCatalog: readonly TowerType[] = TOWER_TYPES,
  populationSize: number = DEFAULT_POPULATION_SIZE,
  maxTime: number = 100,
): TowerInstance[] {
  const start = Date.now();

  // Bornée par maxTime comme la boucle principale ci-dessous : un populationSize trop ambitieux
  // pour le temps imparti dégrade la qualité plutôt que de dépasser le budget de temps.
  const initialCandidates: TowerInstance[][] = [];
  while (initialCandidates.length < 2 * populationSize && Date.now() - start < maxTime) {
    initialCandidates.push(initRandomDefense(map, wave, defenseBudget, towerCatalog));
  }
  let population = fittestDefenses(
    initialCandidates,
    populationSize,
    wave,
    chateauMaxHp,
    map.chateau,
    monsterCatalog,
    towerCatalog,
  );

  while (population.length > 0 && Date.now() - start < maxTime) {
    const children = Array.from({ length: population.length }, () => {
      const [parentA, parentB] = shuffled(population);
      const child = crossDefenses(parentA, parentB ?? parentA);
      const mutated = mutateDefense(child, map, wave, defenseBudget, towerCatalog);
      return enforceDefenseBudget(mutated, defenseBudget, towerCatalog);
    });
    population = fittestDefenses(
      [...population, ...children],
      populationSize,
      wave,
      chateauMaxHp,
      map.chateau,
      monsterCatalog,
      towerCatalog,
    );
  }

  return population[0] ?? [];
}

/**
 * Fait jouer l'ordinateur la phase Défense : pose des tours pour tenir la vague donnée, via
 * l'algorithme génétique `evolveDefense` (population de forteresses candidates, notées avec
 * `phaseScore` en mode 'defense', puis sélection/croisement/mutation au fil des générations).
 */
export function playDefensePhase(input: DefensePlayerInput): readonly TowerInstance[] | undefined {
  return evolveDefense(
    input.map,
    input.wave,
    input.defenseBudget,
    input.chateauMaxHp,
    input.monsterCatalog,
    input.towerCatalog,
    500,
    input.maxTime,
  );
}
