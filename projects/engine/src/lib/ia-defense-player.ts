import type { GameMap, GridCoord, MonsterType, TowerInstance, TowerType, Wave } from 'shared';
import { MONSTER_TYPES, TOWER_TYPES, hexDistance, hexNeighbors } from 'shared';
import { phaseScore } from './combat';
import { canOccupyCell, canPlaceTower } from './fortress';
import { type ProgressInfo, type ProgressReporter, createProgressReporter, shuffled } from './ia-player';
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
  /** Rappelé au fil de la recherche avec la meilleure défense trouvée jusqu'ici — voir `evolveDefense`. */
  onBestFound?: (best: readonly TowerInstance[], info: ProgressInfo) => void;
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
 *
 * `routes` restreint les cases candidates à la portée d'un sous-ensemble de voies (par défaut,
 * toutes celles de `wave`) — `initRandomDefense` s'en sert pour garantir qu'une voie précise
 * reçoive bien une tour, plutôt que de laisser le tirage au hasard la délaisser entièrement au
 * profit des autres.
 */
export function initRandomTower(
  map: GameMap,
  towers: readonly TowerInstance[],
  wave: Wave,
  remainingBudget: number,
  towerCatalog: readonly TowerType[] = TOWER_TYPES,
  routes: readonly GridCoord[] = routeCells(wave),
): TowerInstance | undefined {
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
 * Initialise une forteresse candidate aléatoire : commence par poser, pour chaque voie de la
 * vague (ordre tiré au hasard), une tour à sa portée (`initRandomTower` restreint à cette seule
 * voie) — sans quoi le tirage au hasard sur l'ensemble des voies confondues tend à en délaisser
 * complètement certaines, surtout à budget serré, laissant l'algorithme génétique évoluer une
 * population où aucune forteresse ne tient jamais les voies négligées. Poursuit ensuite tant qu'il
 * reste du budget de défense en posant des tours à portée de n'importe quelle voie. S'arrête dès
 * qu'aucun placement n'est plus possible (budget épuisé ou plus aucune case libre à portée).
 * Brique de base (population initiale, mutations) de l'algorithme génétique.
 */
export function initRandomDefense(
  map: GameMap,
  wave: Wave,
  defenseBudget: number,
  towerCatalog: readonly TowerType[] = TOWER_TYPES,
): TowerInstance[] {
  const towers: TowerInstance[] = [];
  let remainingBudget = defenseBudget;

  for (const lane of shuffled(wave.lanes)) {
    const tower = initRandomTower(
      map,
      towers,
      wave,
      remainingBudget,
      towerCatalog,
      expandPathCells(lane.path),
    );
    if (!tower) {
      continue;
    }
    towers.push(tower);
    const type = towerCatalog.find((candidate) => candidate.id === tower.typeId)!;
    remainingBudget -= type.cost;
  }

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
 * probabilité `MUTATION_RATE`, altère au hasard une tour tirée au hasard d'une de ces trois façons
 * — jamais plusieurs à la fois : déplacement vers une case adjacente libre (`hexNeighbors`,
 * gratuit — `canOccupyCell` ne vérifie que la géométrie, pas le budget, une tour déjà payée le
 * reste en changeant de case), suppression pure et simple, ou changement de type sur la même case
 * (`canPlaceTower`, avec le budget encore disponible une fois les autres tours payées, pour ne
 * jamais dépasser `defenseBudget` par la seule mutation ; le nouveau type doit en outre rester à
 * portée d'au moins une voie de la vague à tenir, sans quoi la tour mutée ne tirerait plus sur
 * aucun monstre). Si la mutation choisie n'a aucune cible valide (aucune case adjacente libre,
 * aucun type finançable et à portée), la forteresse est inchangée plutôt que de retomber sur une
 * autre mutation. Inchangée si la forteresse n'a aucune tour.
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
  const tower = towers[index];
  const others = towers.filter((_, i) => i !== index);
  const roll = Math.random();

  if (roll < 1 / 3) {
    for (const neighbor of shuffled(hexNeighbors(tower.position))) {
      if (canOccupyCell(map, others, neighbor).ok) {
        return [...others, { ...tower, position: neighbor }];
      }
    }
    return [...towers];
  }

  if (roll < 2 / 3) {
    return others;
  }

  const routes = routeCells(wave);
  const remainingBudget = Math.max(0, defenseBudget - defenseCost(others, towerCatalog));
  for (const type of shuffled(towerCatalog)) {
    const inRange = routes.some((cell) => hexDistance(cell, tower.position) <= type.range);
    if (inRange && canPlaceTower(map, others, type, tower.position, remainingBudget).ok) {
      return [...others, { ...tower, typeId: type.id }];
    }
  }
  return [...towers];
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

/** Meilleure défense trouvée jusqu'ici (au sens de `scoreDefense`, score décroissant) et son score. */
interface BestDefense {
  towers: TowerInstance[];
  score: number;
}

/**
 * Trie `candidates` par score décroissant (mode 'defense') et n'en garde que les `count`
 * meilleures. L'essentiel du temps de calcul d'`evolveDefense` se passe ici (jusqu'à
 * `2 * populationSize` forteresses à noter pour la seule population initiale, chacune une
 * simulation de combat complète via `phaseScore`) plutôt qu'entre deux générations : `reporter`
 * est donc rappelé à la volée, forteresse par forteresse, plutôt qu'une seule fois en fin de tri
 * — voir `fittestWaves`, pendant équivalent côté Attaque, pour le détail du raisonnement
 * (notamment sur `seed`, qui évite qu'un meilleur score déjà connu ne semble reculer pendant le
 * parcours d'un nouveau lot).
 */
async function fittestDefenses(
  candidates: readonly (readonly TowerInstance[])[],
  count: number,
  wave: Wave,
  chateauMaxHp: number,
  chateau: GridCoord,
  monsterCatalog: readonly MonsterType[],
  towerCatalog: readonly TowerType[],
  iterations: { count: number },
  reporter: ProgressReporter<readonly TowerInstance[]>,
  seed: BestDefense | undefined,
): Promise<{ population: TowerInstance[][]; best: BestDefense | undefined }> {
  const scored: BestDefense[] = [];
  let best = seed;
  for (const candidate of candidates) {
    const towers = [...candidate];
    const score = scoreDefense(towers, wave, chateauMaxHp, chateau, monsterCatalog, towerCatalog);
    scored.push({ towers, score });
    iterations.count++;
    if (!best || score > best.score) {
      best = { towers, score };
    }
    await reporter.report(best.towers, { iterations: iterations.count, score: best.score });
  }
  const population = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((entry) => entry.towers);
  return { population, best };
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
 * `maxTime` ms, puis retourne la meilleure forteresse trouvée. `onBestFound`, s'il est fourni, est
 * rappelé au fil de la notation de chaque lot d'individus (`fittestDefenses`, throttlé à ~60 fps
 * par `createProgressReporter`) avec la meilleure forteresse trouvée jusqu'ici et le nombre
 * d'individus notés — permet à l'UI d'afficher la progression de la recherche pendant que l'IA
 * « réfléchit » plutôt que d'attendre le résultat final. La notation de la population initiale
 * (jusqu'à `2 * populationSize` forteresses) domine généralement le temps de calcul total,
 * largement avant la première génération — c'est pourquoi `onBestFound` y est déjà rappelé, pas
 * seulement entre deux générations.
 */
export async function evolveDefense(
  map: GameMap,
  wave: Wave,
  defenseBudget: number,
  chateauMaxHp: number,
  monsterCatalog: readonly MonsterType[] = MONSTER_TYPES,
  towerCatalog: readonly TowerType[] = TOWER_TYPES,
  populationSize: number = DEFAULT_POPULATION_SIZE,
  maxTime: number = 100,
  onBestFound?: (best: readonly TowerInstance[], info: ProgressInfo) => void,
): Promise<TowerInstance[]> {
  const start = Date.now();
  const iterations = { count: 0 };
  const reporter: ProgressReporter<readonly TowerInstance[]> = createProgressReporter(onBestFound);
  let best: BestDefense | undefined;

  // Bornée par maxTime comme la boucle principale ci-dessous : un populationSize trop ambitieux
  // pour le temps imparti dégrade la qualité plutôt que de dépasser le budget de temps.
  const initialCandidates: TowerInstance[][] = [];
  while (initialCandidates.length < 2 * populationSize && Date.now() - start < maxTime) {
    initialCandidates.push(initRandomDefense(map, wave, defenseBudget, towerCatalog));
  }
  const initialResult = await fittestDefenses(
    initialCandidates,
    populationSize,
    wave,
    chateauMaxHp,
    map.chateau,
    monsterCatalog,
    towerCatalog,
    iterations,
    reporter,
    best,
  );
  let population = initialResult.population;
  best = initialResult.best;

  while (population.length > 0 && Date.now() - start < maxTime) {
    const children = Array.from({ length: population.length }, () => {
      const [parentA, parentB] = shuffled(population);
      const child = crossDefenses(parentA, parentB ?? parentA);
      const mutated = mutateDefense(child, map, wave, defenseBudget, towerCatalog);
      return enforceDefenseBudget(mutated, defenseBudget, towerCatalog);
    });
    const result = await fittestDefenses(
      [...population, ...children],
      populationSize,
      wave,
      chateauMaxHp,
      map.chateau,
      monsterCatalog,
      towerCatalog,
      iterations,
      reporter,
      best,
    );
    population = result.population;
    best = result.best;
  }

  return population[0] ?? [];
}

/** Nombre d'individus conservés par génération pour `playDefensePhase` — voir sa note. */
const OFFICIAL_POPULATION_SIZE = 50;

/**
 * Fait jouer l'ordinateur la phase Défense : pose des tours pour tenir la vague donnée, via
 * l'algorithme génétique `evolveDefense` (population de forteresses candidates, notées avec
 * `phaseScore` en mode 'defense', puis sélection/croisement/mutation au fil des générations).
 *
 * `OFFICIAL_POPULATION_SIZE` (jusqu'à `2 * populationSize` forteresses à noter pour la seule
 * population initiale, chacune une simulation de combat complète) est volontairement modeste : une
 * population de 500 laissait la notation de la population initiale consommer `maxTime` à elle
 * seule (mesuré jusqu'à 7 s pour un budget de 2 s), sans qu'aucune génération n'ait le temps de
 * tourner — la recherche dégénérait en un simple tirage aléatoire élargi, sans le brassage
 * (croisement/mutation) qui fait la valeur ajoutée de l'algorithme génétique.
 */
export async function playDefensePhase(
  input: DefensePlayerInput,
): Promise<readonly TowerInstance[] | undefined> {
  return evolveDefense(
    input.map,
    input.wave,
    input.defenseBudget,
    input.chateauMaxHp,
    input.monsterCatalog,
    input.towerCatalog,
    OFFICIAL_POPULATION_SIZE,
    input.maxTime,
    input.onBestFound,
  );
}
