import type {
  GameMap,
  GridCoord,
  MapPath,
  MonsterType,
  TowerInstance,
  TowerType,
  Wave,
  WaveLane,
} from 'shared';
import { MONSTER_TYPES, hexDistance } from 'shared';
import { findTowerAt, isBorderCell, isChateauCell } from './fortress';
import { shuffled } from './ia-player';
import {
  PATH_CELL_COST,
  expandPathCells,
  hasUniqueCell,
  pathCellsCost,
  routeThroughWaypoints,
} from './path';
import { phaseScore, waveCost } from './combat';

/**
 * Entrées nécessaires pour faire jouer l'ordinateur la phase Attaque : la carte (spawns +
 * château, pour générer des routes candidates — voir `initRandomRoute`), la forteresse figée à
 * percer et le budget d'attaque disponible.
 */
export interface AttackPlayerInput {
  map: GameMap;
  towers: readonly TowerInstance[];
  attackBudget: number;
  chateauMaxHp: number;
  monsterCatalog?: readonly MonsterType[];
  towerCatalog?: readonly TowerType[];
  /** Budget de temps (ms) alloué à la recherche génétique — voir `evolveAttackWave`. */
  maxTime?: number;
}

/** Toutes les cases de bord de la carte, hors château : positions valides pour un nouveau spawn. */
function borderCells(map: GameMap): GridCoord[] {
  const cells: GridCoord[] = [];
  for (let x = 0; x < map.grid.cols; x++) {
    for (let y = 0; y < map.grid.rows; y++) {
      const cell = { x, y };
      if (isBorderCell(map, cell) && !isChateauCell(map, cell)) {
        cells.push(cell);
      }
    }
  }
  return cells;
}

/**
 * Borne le nombre de voies qu'il vaut la peine de générer : au-delà, une voie de plus n'aurait
 * même pas de quoi payer le moins cher des monstres une fois son propre coût de chemin déduit
 * (CONCEPTION.md §5.3) — inutile de la construire (coûteux, plusieurs `shortestPath`) pour la
 * voir filtrée en fin de course par `initRandomWave`. Approxime le coût minimal d'une voie par la
 * distance hex la plus courte entre le château et la case de bord la plus proche (sans tenir
 * compte des tours, qui ne peuvent qu'allonger cette distance — ce plafond est donc large plutôt
 * qu'exact, ce qui suffit pour économiser le calcul).
 */
function affordableLaneCap(
  map: GameMap,
  attackBudget: number,
  monsterCatalog: readonly MonsterType[],
): number {
  const buyable = monsterCatalog.filter((type) => !type.internal);
  const borders = borderCells(map);
  if (buyable.length === 0 || borders.length === 0) {
    return 1;
  }
  const cheapestMonster = Math.min(...buyable.map((type) => type.cost));
  const minRouteCells = 1 + Math.min(...borders.map((cell) => hexDistance(cell, map.chateau)));
  const cheapestLane = cheapestMonster + minRouteCells * PATH_CELL_COST;
  return Math.max(1, Math.floor(attackBudget / cheapestLane));
}

/** Cases libres (aucune tour) tirées au hasard sur la grille ; peut en renvoyer moins que `count` si la grille est saturée de tours. */
function randomFreeCells(
  map: GameMap,
  towers: readonly TowerInstance[],
  count: number,
): GridCoord[] {
  const cells: GridCoord[] = [];
  let attempts = 0;
  while (cells.length < count && attempts < count * 20) {
    attempts++;
    const candidate: GridCoord = {
      x: Math.floor(Math.random() * map.grid.cols),
      y: Math.floor(Math.random() * map.grid.rows),
    };
    if (!findTowerAt(towers, candidate)) {
      cells.push(candidate);
    }
  }
  return cells;
}

/**
 * Initialise une route candidate aléatoire : une case de bord tirée au hasard (spawn existant ou
 * nouveau, peu importe — aucune route n'est tracée à la main) reliée au château, pas forcément par
 * le plus court chemin — 0 à `maxDetours` jalons pris au hasard sur la grille dévient la route
 * avant qu'elle ne rejoigne le château (`routeThroughWaypoints`), toujours en évitant les tours
 * posées. Brique de base des voies générées par l'algorithme génétique (population initiale,
 * mutations).
 *
 * Essaie toutes les cases de bord (ordre aléatoire) jusqu'à en trouver une dont la route résultante
 * n'est pas entièrement redondante avec `existingPaths` (au moins une case propre) — le générateur
 * garantit l'unicité plutôt que de la laisser à la charge de l'appelant. `undefined` si aucune case
 * de bord ne mène au château, ou si toutes les routes possibles chevauchent entièrement `existingPaths`.
 */
export function initRandomRoute(
  map: GameMap,
  towers: readonly TowerInstance[] = [],
  existingPaths: readonly MapPath[] = [],
  maxDetours: number = 2,
): MapPath | undefined {
  for (const spawn of shuffled(borderCells(map))) {
    const detours = randomFreeCells(map, towers, Math.floor(Math.random() * (maxDetours + 1)));
    const cells = routeThroughWaypoints(map, towers, spawn, detours, map.chateau);
    if (!cells) {
      continue;
    }
    const path: MapPath = {
      id: `ia-route-${Math.floor(Math.random() * 1e9)}`,
      nodes: [[spawn.x, spawn.y], ...cells.map((cell): [number, number] => [cell.x, cell.y])],
    };
    if (existingPaths.length === 0 || hasUniqueCell(expandPathCells(path), existingPaths)) {
      return path;
    }
  }
  return undefined;
}

/**
 * Initialise des files de monstres aléatoires pour les routes données : tant qu'il reste du
 * budget d'attaque, tire au hasard un monstre parmi ceux encore achetables et le positionne en
 * tête d'une route choisie au hasard. Sert de brique de base (population initiale, mutations) à
 * l'algorithme génétique — voir aussi `initRandomRoute`.
 */
export function initRandomQueues(
  routes: readonly MapPath[],
  attackBudget: number,
  monsterCatalog: readonly MonsterType[] = MONSTER_TYPES,
): WaveLane[] {
  const buyable = monsterCatalog.filter((type) => !type.internal);
  const lanes: WaveLane[] = routes.map((path) => ({ path, units: [] }));
  if (lanes.length === 0) {
    return lanes;
  }

  let remainingBudget = attackBudget;
  let affordable = buyable.filter((type) => type.cost <= remainingBudget);
  while (affordable.length > 0) {
    const type = affordable[Math.floor(Math.random() * affordable.length)];
    const lane = lanes[Math.floor(Math.random() * lanes.length)];
    lane.units.unshift({ type: type.id });
    remainingBudget -= type.cost;
    affordable = buyable.filter((candidate) => candidate.cost <= remainingBudget);
  }

  return lanes;
}

/**
 * Initialise une vague candidate aléatoire : un nombre de voies tiré au hasard (entre 1 et
 * `maxLanes`), chacune une route aléatoire (`initRandomRoute`) garnies de files de monstres
 * partageant le budget d'attaque (`initRandomQueues`). Brique de base (population initiale,
 * mutations) de l'algorithme génétique.
 */
export function initRandomWave(
  map: GameMap,
  towers: readonly TowerInstance[],
  attackBudget: number,
  monsterCatalog: readonly MonsterType[] = MONSTER_TYPES,
  maxLanes: number = 3,
): Wave {
  const laneCount = 1 + Math.floor(Math.random() * maxLanes);
  const routes: MapPath[] = [];
  for (let i = 0; i < laneCount; i++) {
    const route = initRandomRoute(map, towers, routes);
    if (route) {
      routes.push(route);
    }
  }
  // Les cases de chemin sont elles aussi payantes (CONCEPTION.md §5.3) : on réserve leur coût
  // avant de répartir le reste du budget entre les files de monstres.
  const monsterBudget = Math.max(0, attackBudget - pathCellsCost(routes));
  const lanes = initRandomQueues(routes, monsterBudget, monsterCatalog).filter(
    (lane) => lane.units.length > 0,
  );
  return { lanes };
}

/** Cases intérieures d'un chemin (hors spawn/château), chacune avec sa progression le long de la route (0 = spawn, 1 = château). */
function interiorWaypoints(path: MapPath): Array<{ cell: GridCoord; progress: number }> {
  const cells = expandPathCells(path);
  if (cells.length <= 2) {
    return [];
  }
  const last = cells.length - 1;
  return cells.slice(1, -1).map((cell, index) => ({ cell, progress: (index + 1) / last }));
}

/**
 * Mélange deux chemins parents en un nouveau chemin qui passe par des points tirés au hasard dans
 * chacun d'eux : quelques jalons intérieurs de `pathA` et de `pathB`, triés par leur progression
 * d'origine (spawn → château) pour garder un tracé cohérent, servent de points de passage à une
 * route reconstruite du spawn (choisi au hasard entre les deux parents) au château, plus court
 * chemin en évitant les tours entre chaque jalon (`routeThroughWaypoints`). `undefined` si le
 * château reste inatteignable depuis le dernier jalon valide.
 */
function blendRoutes(
  map: GameMap,
  towers: readonly TowerInstance[],
  pathA: MapPath,
  pathB: MapPath,
  samplesPerPath: number = 2,
): MapPath | undefined {
  const waypoints = [
    ...shuffled(interiorWaypoints(pathA)).slice(0, samplesPerPath),
    ...shuffled(interiorWaypoints(pathB)).slice(0, samplesPerPath),
  ]
    .sort((a, b) => a.progress - b.progress)
    .map((entry) => entry.cell);

  const [spawnPath] = shuffled([pathA, pathB]);
  const spawn: GridCoord = { x: spawnPath.nodes[0][0], y: spawnPath.nodes[0][1] };

  const cells = routeThroughWaypoints(map, towers, spawn, waypoints, map.chateau);
  if (!cells) {
    return undefined;
  }
  return {
    id: `ia-blend-${Math.floor(Math.random() * 1e9)}`,
    nodes: [[spawn.x, spawn.y], ...cells.map((cell): [number, number] => [cell.x, cell.y])],
  };
}

/**
 * Croise deux vagues parentes pour en produire une conforme : pour chaque voie (indexée de 0 à
 * la plus grande longueur des deux parents) présente chez les deux parents, le chemin est un
 * mélange des deux routes parentes (`blendRoutes`) plutôt qu'une reprise à l'identique — repli sur
 * l'une des deux routes parentes, tirée au hasard, si le mélange échoue (château inatteignable
 * depuis les jalons choisis). Une voie absente chez l'un des deux parents reprend telle quelle
 * celle de l'autre. La file de monstres est piochée indépendamment, elle aussi au hasard entre les
 * deux parents — un chemin peut donc se retrouver garni de la file de l'autre parent. Une voie
 * dont le chemin ferait doublon avec une voie déjà retenue (même id) est ignorée : le croisement ne
 * doit pas produire de vague redondante. Brique de reproduction de l'algorithme génétique — voir
 * `evolveAttackWave`.
 */
export function crossWaves(
  map: GameMap,
  towers: readonly TowerInstance[],
  parentA: Wave,
  parentB: Wave,
): Wave {
  const laneCount = Math.max(parentA.lanes.length, parentB.lanes.length);
  const lanes: WaveLane[] = [];
  const usedPathIds = new Set<string>();

  for (let i = 0; i < laneCount; i++) {
    const laneA = parentA.lanes[i];
    const laneB = parentB.lanes[i];
    const path =
      laneA && laneB
        ? (blendRoutes(map, towers, laneA.path, laneB.path) ??
          shuffled([laneA.path, laneB.path])[0])
        : (laneA ?? laneB)?.path;
    if (!path || usedPathIds.has(path.id)) {
      continue;
    }
    usedPathIds.add(path.id);

    const [firstQueueParent, secondQueueParent] = shuffled([parentA, parentB]);
    const units = firstQueueParent.lanes[i]?.units ?? secondQueueParent.lanes[i]?.units ?? [];
    lanes.push({ path, units: [...units] });
  }

  return { lanes };
}

/**
 * Note une vague avec `phaseScore` en mode 'attack' : entre deux vagues qui échouent à détruire le
 * château, la vie du château restante la plus basse est la plus efficace ; entre deux vagues qui
 * le détruisent, la plus étalée l'emporte (`spreadScore`), et surtout celle dont les routes
 * passent le plus près du château — plus l'attaque y contraint les emplacements de tours
 * possibles pour la défense au palier suivant.
 */
function scoreAttackWave(
  wave: Wave,
  towers: readonly TowerInstance[],
  chateauMaxHp: number,
  chateau: GridCoord,
  monsterCatalog: readonly MonsterType[],
): number {
  return phaseScore(towers, wave, chateauMaxHp, chateau, monsterCatalog, undefined, 'attack');
}

/** Trie `waves` par score croissant (mode 'attack') et n'en garde que les `count` meilleures. */
function fittestWaves(
  waves: readonly Wave[],
  count: number,
  towers: readonly TowerInstance[],
  chateauMaxHp: number,
  chateau: GridCoord,
  monsterCatalog: readonly MonsterType[],
): Wave[] {
  return waves
    .map((wave) => ({
      wave,
      score: scoreAttackWave(wave, towers, chateauMaxHp, chateau, monsterCatalog),
    }))
    .sort((a, b) => a.score - b.score)
    .slice(0, count)
    .map((entry) => entry.wave);
}

const DEFAULT_POPULATION_SIZE = 20;
/** Probabilité qu'une vague fille issue du croisement soit mutée avant d'être notée. */
const MUTATION_RATE = 0.15;

/**
 * Retire un point au hasard du tracé d'un chemin (hors spawn/château) et reconnecte les jalons
 * restants entre eux (`routeThroughWaypoints`, plus court chemin en évitant les tours) : une
 * variation plus fine que le re-tracé complet (`initRandomRoute`), qui garde l'essentiel de la
 * route tout en la raccourcissant légèrement au niveau du point retiré. `undefined` si le chemin
 * n'a aucun point intérieur (rien à retirer) ou si le château devient inatteignable sans lui.
 */
function removeRandomWaypoint(
  map: GameMap,
  towers: readonly TowerInstance[],
  path: MapPath,
): MapPath | undefined {
  const cells = expandPathCells(path);
  if (cells.length <= 2) {
    return undefined;
  }
  const dropIndex = 1 + Math.floor(Math.random() * (cells.length - 2));
  const waypoints = cells.filter((_, index) => index !== 0 && index !== dropIndex);
  const rerouted = routeThroughWaypoints(
    map,
    towers,
    cells[0],
    waypoints.slice(0, -1),
    cells[cells.length - 1],
  );
  if (!rerouted) {
    return undefined;
  }
  return {
    ...path,
    nodes: [
      [cells[0].x, cells[0].y],
      ...rerouted.map((cell): [number, number] => [cell.x, cell.y]),
    ],
  };
}

/**
 * Ajoute une nouvelle voie à la vague : une route aléatoire (`initRandomRoute`, en évitant les
 * chemins des voies existantes) garnie d'une file de monstres tirée sur tout le budget d'attaque
 * — comme le ferait `initRandomWave` pour une voie initiale, laissant à `enforceBudget` (appelé
 * juste après en sortie de `mutateWave`) le soin de ramener la vague dans son budget. Permet à la
 * population de dépasser en cours d'évolution le plafond de voies imposé à la génération initiale
 * (`maxLanes`/`affordableLaneCap`) — le brassage des routes n'est pas tenu par ce plafond. Inchangée
 * si aucune route candidate n'est disponible (carte saturée, ou toutes les routes restantes font
 * doublon avec les voies existantes).
 */
function addRandomLane(
  wave: Wave,
  map: GameMap,
  towers: readonly TowerInstance[],
  attackBudget: number,
  monsterCatalog: readonly MonsterType[],
): Wave {
  const existingPaths = wave.lanes.map((lane) => lane.path);
  const newRoute = initRandomRoute(map, towers, existingPaths);
  if (!newRoute) {
    return wave;
  }
  const [newLane] = initRandomQueues([newRoute], attackBudget, monsterCatalog);
  return { lanes: [...wave.lanes, newLane] };
}

/**
 * Retire une voie tirée au hasard de la vague, avec son chemin et sa file de monstres — pendant du
 * retrait d'un simple point de tracé (`removeRandomWaypoint`), à l'échelle de la voie entière plutôt
 * que d'un seul jalon. Permet au brassage des routes de redescendre sous le plafond de voies de la
 * génération initiale, voire jusqu'à une vague sans aucune voie (état déjà atteignable via
 * `initRandomWave`/`enforceBudget` quand plus aucune voie ne peut financer le moindre monstre).
 */
function removeRandomLane(wave: Wave): Wave {
  const laneIndex = Math.floor(Math.random() * wave.lanes.length);
  return { lanes: wave.lanes.filter((_, i) => i !== laneIndex) };
}

/**
 * Mute une vague fille pour réintroduire de la diversité que le seul croisement ne peut pas
 * produire (il ne fait que recombiner les chemins/files déjà présents dans la population) : avec
 * probabilité `MUTATION_RATE`, altère au hasard la vague d'une seule de ces cinq façons — jamais
 * plusieurs à la fois : re-tracé complet d'une voie tirée au hasard (nouvelle route aléatoire avec
 * détours, `initRandomRoute`, en évitant les chemins des autres voies), retrait d'un point du
 * chemin d'une voie tirée au hasard (`removeRandomWaypoint`, variation plus locale), régénération
 * de la file de monstres d'une voie tirée au hasard pour le même budget qu'elle consommait
 * (`initRandomQueues`), ajout d'une voie entièrement nouvelle (`addRandomLane`) ou retrait d'une
 * voie existante tirée au hasard (`removeRandomLane`) — ces deux dernières sont les seules à faire
 * varier le nombre de voies au-delà du plafond `maxLanes` de la population initiale (CONCEPTION.md
 * §5.3 : composer/décomposer une vague en voies reste gratuit, seules les cases de chemin et les
 * monstres sont facturés). Inchangée si la vague n'a aucune voie (rien à muter, y compris pour
 * l'ajout — géré séparément), ou si la mutation de chemin choisie échoue (route résultante
 * invalide).
 */
function mutateWave(
  wave: Wave,
  map: GameMap,
  towers: readonly TowerInstance[],
  attackBudget: number,
  monsterCatalog: readonly MonsterType[],
): Wave {
  if (Math.random() > MUTATION_RATE) {
    return wave;
  }
  if (wave.lanes.length === 0) {
    return addRandomLane(wave, map, towers, attackBudget, monsterCatalog);
  }

  const laneIndex = Math.floor(Math.random() * wave.lanes.length);
  const lanes = [...wave.lanes];
  const roll = Math.random();

  if (roll < 1 / 5) {
    const otherPaths = lanes.filter((_, i) => i !== laneIndex).map((lane) => lane.path);
    const mutatedRoute = initRandomRoute(map, towers, otherPaths);
    if (mutatedRoute) {
      lanes[laneIndex] = { ...lanes[laneIndex], path: mutatedRoute };
    }
  } else if (roll < 2 / 5) {
    const mutatedRoute = removeRandomWaypoint(map, towers, lanes[laneIndex].path);
    if (mutatedRoute) {
      lanes[laneIndex] = { ...lanes[laneIndex], path: mutatedRoute };
    }
  } else if (roll < 3 / 5) {
    const laneBudget = lanes[laneIndex].units.reduce((total, unit) => {
      const type = monsterCatalog.find((candidate) => candidate.id === unit.type);
      return total + (type?.cost ?? 0);
    }, 0);
    const [mutatedLane] = initRandomQueues([lanes[laneIndex].path], laneBudget, monsterCatalog);
    lanes[laneIndex] = mutatedLane;
  } else if (roll < 4 / 5) {
    return addRandomLane({ lanes }, map, towers, attackBudget, monsterCatalog);
  } else {
    return removeRandomLane({ lanes });
  }

  return { lanes };
}

/**
 * Ramène une vague dans son budget d'attaque : `crossWaves` recombine des files chacune valide
 * chez son parent d'origine, mais leur total peut dépasser `attackBudget` une fois réunies dans
 * la vague fille. Tant que le coût total (`waveCost`) dépasse le budget, retire un monstre tiré
 * au hasard dans une file tirée au hasard (parmi celles non vides) ; les voies vidées de tous
 * leurs monstres sont retirées, comme le fait `initRandomWave`.
 */
export function enforceBudget(
  wave: Wave,
  attackBudget: number,
  monsterCatalog: readonly MonsterType[],
): Wave {
  const lanes = wave.lanes.map((lane) => ({ ...lane, units: [...lane.units] }));
  while (waveCost({ lanes }, monsterCatalog) > attackBudget) {
    const nonEmptyLanes = lanes.filter((lane) => lane.units.length > 0);
    if (nonEmptyLanes.length === 0) {
      break;
    }
    const lane = nonEmptyLanes[Math.floor(Math.random() * nonEmptyLanes.length)];
    lane.units.splice(Math.floor(Math.random() * lane.units.length), 1);
  }
  return { lanes: lanes.filter((lane) => lane.units.length > 0) };
}

/**
 * Compose une vague via un algorithme génétique : la population initiale est tirée au hasard en
 * double (`2 * populationSize` vagues, `initRandomWave`), dont on ne garde que les
 * `populationSize` meilleures (`phaseScore` en mode 'attack') — cette construction initiale est
 * elle-même bornée par `maxTime` (un `populationSize`/`maxLanes` trop ambitieux pour le temps
 * imparti dégrade la qualité plutôt que de dépasser le budget de temps). `maxLanes` est en outre
 * plafonné à `affordableLaneCap` : demander plus de voies que ce que `attackBudget` peut
 * réellement financer ne fait que gaspiller du temps de calcul sur des voies qui seront filtrées
 * en fin de course, faute de budget pour le moindre monstre. Ce plafond ne borne que la population
 * initiale : le brassage des générations suivantes (`mutateWave`, ajout/retrait de voie) peut aussi
 * bien redescendre en dessous que remonter au-dessus, la sélection naturelle (`fittestWaves`) et
 * `enforceBudget` se chargeant d'éliminer les dérives qui ne paient pas leur coût de chemin. À
 * chaque génération, on croise des paires de parents tirées au hasard dans la population
 * (`crossWaves`), on mute de temps en temps les vagues filles obtenues (`mutateWave`) pour
 * préserver la diversité génétique, puis on ne garde que les `populationSize` meilleures parmi
 * population + filles réunies. Boucle jusqu'à épuisement de `maxTime` ms, puis retourne la
 * meilleure vague trouvée.
 */
export function evolveAttackWave(
  map: GameMap,
  towers: readonly TowerInstance[],
  attackBudget: number,
  chateauMaxHp: number,
  monsterCatalog: readonly MonsterType[] = MONSTER_TYPES,
  maxLanes: number = 3,
  populationSize: number = DEFAULT_POPULATION_SIZE,
  maxTime: number = 100,
): Wave {
  const start = Date.now();

  const effectiveMaxLanes = Math.min(
    maxLanes,
    affordableLaneCap(map, attackBudget, monsterCatalog),
  );
  const initialCandidates: Wave[] = [];
  while (initialCandidates.length < 2 * populationSize && Date.now() - start < maxTime) {
    initialCandidates.push(
      initRandomWave(map, towers, attackBudget, monsterCatalog, effectiveMaxLanes),
    );
  }
  let population = fittestWaves(
    initialCandidates,
    populationSize,
    towers,
    chateauMaxHp,
    map.chateau,
    monsterCatalog,
  );

  while (population.length > 0 && Date.now() - start < maxTime) {
    const children = Array.from({ length: population.length }, () => {
      const [parentA, parentB] = shuffled(population);
      const child = crossWaves(map, towers, parentA, parentB ?? parentA);
      const mutated = mutateWave(child, map, towers, attackBudget, monsterCatalog);
      return enforceBudget(mutated, attackBudget, monsterCatalog);
    });
    population = fittestWaves(
      [...population, ...children],
      populationSize,
      towers,
      chateauMaxHp,
      map.chateau,
      monsterCatalog,
    );
  }

  return population[0] ?? { lanes: [] };
}

/**
 * Fait jouer l'ordinateur la phase Attaque : compose une vague qui détruit la forteresse figée,
 * via l'algorithme génétique `evolveAttackWave` (population de vagues candidates, notées avec
 * `phaseScore` en mode 'attack', puis sélection/croisement au fil des générations).
 */
export function playAttackPhase(input: AttackPlayerInput): Wave | undefined {
  return evolveAttackWave(
    input.map,
    input.towers,
    input.attackBudget,
    input.chateauMaxHp,
    input.monsterCatalog,
    5,
    500,
    input.maxTime,
  );
}
