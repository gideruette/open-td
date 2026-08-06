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
import { type ProgressInfo, type ProgressReporter, createProgressReporter, shuffled } from './ia-player';
import {
  PATH_CELL_COST,
  expandPathCells,
  hasUniqueCell,
  pathCellsCost,
  routeThroughWaypoints,
  simplifyPathCells,
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
  /** Rappelé au fil de la recherche avec la meilleure vague trouvée jusqu'ici — voir `evolveAttackWave`. */
  onBestFound?: (best: Wave, info: ProgressInfo) => void;
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

/** Types de monstres réellement achetables par l'attaquant : le catalogue moins les types internes (progéniture d'une scission, jamais composée à la main). */
function buyableMonsters(monsterCatalog: readonly MonsterType[]): readonly MonsterType[] {
  return monsterCatalog.filter((type) => !type.internal);
}

/** Un élément tiré au hasard, ou `undefined` si la liste est vide — dispense les appelants du garde-fou sur la liste vide. */
function pickRandom<T>(items: readonly T[]): T | undefined {
  return items.length === 0 ? undefined : items[Math.floor(Math.random() * items.length)];
}

/** Coût d'une unité composée (0 si son type ne figure pas au catalogue). */
function unitCost(typeId: string, monsterCatalog: readonly MonsterType[]): number {
  return monsterCatalog.find((candidate) => candidate.id === typeId)?.cost ?? 0;
}

/** Copie profonde des voies d'une vague (chemins partagés, files dupliquées) : base de tout opérateur qui modifie une file sans toucher à la vague d'origine. */
function cloneLanes(wave: Wave): WaveLane[] {
  return wave.lanes.map((lane) => ({ ...lane, units: [...lane.units] }));
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
  const buyable = buyableMonsters(monsterCatalog);
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
    const routeCells = simplifyPathCells([spawn, ...cells]);
    const path: MapPath = {
      id: `ia-route-${Math.floor(Math.random() * 1e9)}`,
      nodes: routeCells.map((cell): [number, number] => [cell.x, cell.y]),
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
  const buyable = buyableMonsters(monsterCatalog);
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
  const routeCells = simplifyPathCells([spawn, ...cells]);
  return {
    id: `ia-blend-${Math.floor(Math.random() * 1e9)}`,
    nodes: routeCells.map((cell): [number, number] => [cell.x, cell.y]),
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

/** Meilleure vague trouvée jusqu'ici (au sens de `scoreAttackWave`, score croissant) et son score. */
interface BestWave {
  wave: Wave;
  score: number;
}

/**
 * Trie `waves` par score croissant (mode 'attack') et n'en garde que les `count` meilleures.
 * L'essentiel du temps de calcul d'`evolveAttackWave` se passe ici (jusqu'à `2 * populationSize`
 * vagues à noter pour la seule population initiale, chacune une simulation de combat complète via
 * `phaseScore`) plutôt qu'entre deux générations : `reporter` est donc rappelé à la volée, vague
 * par vague, plutôt qu'une seule fois en fin de tri — sans quoi l'IU resterait informée en fait
 * uniquement à la fin d'une notation qui peut consommer tout le budget de temps à elle seule
 * (`maxTime`, non appliqué ici — voir `evolveAttackWave`). `seed`, la meilleure vague déjà connue
 * avant cet appel (typiquement celle publiée par l'appel précédent), sert de point de départ à la
 * comparaison : sans lui, le meilleur affiché retomberait au niveau du premier élément parcouru de
 * `waves` en tout début de tri, avant de remonter au fil du parcours — une régression visible sur
 * la carte pour rien, puisque le meilleur individu de la génération précédente réapparaît toujours
 * dans `waves` (repris tel quel dans la population), juste pas nécessairement en tête de liste.
 */
async function fittestWaves(
  waves: readonly Wave[],
  count: number,
  towers: readonly TowerInstance[],
  chateauMaxHp: number,
  chateau: GridCoord,
  monsterCatalog: readonly MonsterType[],
  iterations: { count: number },
  reporter: ProgressReporter<Wave>,
  seed: BestWave | undefined,
): Promise<{ population: Wave[]; best: BestWave | undefined }> {
  const scored: BestWave[] = [];
  let best = seed;
  for (const wave of waves) {
    const score = scoreAttackWave(wave, towers, chateauMaxHp, chateau, monsterCatalog);
    scored.push({ wave, score });
    iterations.count++;
    if (!best || score < best.score) {
      best = { wave, score };
    }
    await reporter.report(best.wave, { iterations: iterations.count, score: best.score });
  }
  const population = scored
    .sort((a, b) => a.score - b.score)
    .slice(0, count)
    .map((entry) => entry.wave);
  return { population, best };
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
  const routeCells = simplifyPathCells([cells[0], ...rerouted]);
  return {
    ...path,
    nodes: routeCells.map((cell): [number, number] => [cell.x, cell.y]),
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
 * Contexte passé à chaque opérateur de mutation (voir `WAVE_MUTATIONS`) : la vague à muter et tout
 * ce dont un opérateur peut avoir besoin pour tracer une route ou tarifer un monstre.
 */
interface MutationContext {
  wave: Wave;
  map: GameMap;
  towers: readonly TowerInstance[];
  attackBudget: number;
  monsterCatalog: readonly MonsterType[];
}

/** Un opérateur de mutation : la vague altérée, ou `undefined` s'il ne s'applique pas à cette vague (voie sans monstre, route résultante invalide…) — l'appelant garde alors la vague inchangée. */
type MutationOperator = (context: MutationContext) => Wave | undefined;

/** Indices des voies garnies d'au moins un monstre : seules cibles possibles des opérateurs de composition. */
function lanesWithUnits(wave: Wave): number[] {
  return wave.lanes.flatMap((lane, index) => (lane.units.length > 0 ? [index] : []));
}

// --- Opérateurs de tracé ----------------------------------------------------

/** Re-trace entièrement une voie tirée au hasard (nouvelle route aléatoire avec détours, `initRandomRoute`, en évitant les chemins des autres voies). */
const retraceRandomLane: MutationOperator = ({ wave, map, towers }) => {
  const laneIndex = Math.floor(Math.random() * wave.lanes.length);
  const otherPaths = wave.lanes.filter((_, i) => i !== laneIndex).map((lane) => lane.path);
  const route = initRandomRoute(map, towers, otherPaths);
  if (!route) {
    return undefined;
  }
  const lanes = cloneLanes(wave);
  lanes[laneIndex] = { ...lanes[laneIndex], path: route };
  return { lanes };
};

/** Retire un point du chemin d'une voie tirée au hasard (`removeRandomWaypoint`) — variation de tracé plus locale que le re-tracé complet. */
const dropRandomWaypoint: MutationOperator = ({ wave, map, towers }) => {
  const laneIndex = Math.floor(Math.random() * wave.lanes.length);
  const route = removeRandomWaypoint(map, towers, wave.lanes[laneIndex].path);
  if (!route) {
    return undefined;
  }
  const lanes = cloneLanes(wave);
  lanes[laneIndex] = { ...lanes[laneIndex], path: route };
  return { lanes };
};

/** Ajoute une voie entièrement nouvelle (`addRandomLane`). */
const appendRandomLane: MutationOperator = ({ wave, map, towers, attackBudget, monsterCatalog }) =>
  addRandomLane(wave, map, towers, attackBudget, monsterCatalog);

/** Retire une voie tirée au hasard (`removeRandomLane`). */
const dropRandomLane: MutationOperator = ({ wave }) => removeRandomLane(wave);

// --- Opérateurs de composition ----------------------------------------------

/**
 * Remplace le type d'un monstre tiré au hasard par un autre type achetable, tout le reste de la
 * vague inchangé : l'opérateur qui donne enfin à la recherche un moyen de découvrir les contres du
 * catalogue (blindage face à des tours sans bonus anti-armure, résistance au ralentissement face à
 * la tour Glace, régénération face à une défense sans burst, scission qui double la file à la
 * mort). Un échange à la fois — la sélection tranche ensuite si l'échange valait le coup, ce qu'une
 * régénération complète de la file (`rerollRandomLaneQueue`) ne permet jamais d'attribuer à un
 * monstre en particulier.
 *
 * Le type de remplacement est tiré parmi ceux que le budget permet réellement de payer *à la place*
 * de l'unité échangée (son coût, plus le mou de la vague). Sans ce plafond, échanger un Rat contre
 * un Chevalier noir ferait sortir la vague du budget et `enforceBudget` retirerait des monstres au
 * hasard juste après — potentiellement celui qu'on vient de poser : la mutation se réduirait à du
 * bruit au lieu d'un pas de recherche.
 */
const swapRandomUnitType: MutationOperator = ({ wave, attackBudget, monsterCatalog }) => {
  const laneIndex = pickRandom(lanesWithUnits(wave));
  if (laneIndex === undefined) {
    return undefined;
  }
  const lanes = cloneLanes(wave);
  const unitIndex = Math.floor(Math.random() * lanes[laneIndex].units.length);
  const replaced = lanes[laneIndex].units[unitIndex].type;
  const ceiling =
    unitCost(replaced, monsterCatalog) + attackBudget - waveCost(wave, monsterCatalog);
  const replacement = pickRandom(
    buyableMonsters(monsterCatalog).filter(
      (type) => type.id !== replaced && type.cost <= ceiling,
    ),
  );
  if (!replacement) {
    return undefined;
  }
  lanes[laneIndex].units[unitIndex] = { type: replacement.id };
  return { lanes };
};

/**
 * Retire un monstre tiré au hasard. Contrairement au retrait de `enforceBudget`, qui ne s'active
 * qu'en dépassement de budget, celui-ci libère volontairement du budget : le réinvestissement de
 * `enforceBudget`, appelé juste après, le redépense ailleurs. C'est le mécanisme par lequel une
 * vague peut se déplacer vers des monstres plus chers — un simple échange (`swapRandomUnitType`)
 * reste plafonné par le mou disponible et ne le pourrait pas seul sur une vague au budget serré.
 */
const removeRandomUnit: MutationOperator = ({ wave }) => {
  const laneIndex = pickRandom(lanesWithUnits(wave));
  if (laneIndex === undefined) {
    return undefined;
  }
  const lanes = cloneLanes(wave);
  lanes[laneIndex].units.splice(Math.floor(Math.random() * lanes[laneIndex].units.length), 1);
  return { lanes };
};

/**
 * Déplace un monstre tiré au hasard d'une voie vers une autre, à une place tirée au hasard.
 * Neutre pour le budget (un monstre coûte le même prix quelle que soit sa voie, les tracés ne
 * bougent pas) : c'est purement de la répartition de la pression entre les voies, que ni le
 * croisement — qui recopie les files voie par voie — ni les autres opérateurs ne produisent.
 * `undefined` s'il n'y a pas au moins deux voies.
 */
const moveRandomUnit: MutationOperator = ({ wave }) => {
  const fromIndex = pickRandom(lanesWithUnits(wave));
  if (fromIndex === undefined) {
    return undefined;
  }
  const toIndex = pickRandom(wave.lanes.map((_, i) => i).filter((i) => i !== fromIndex));
  if (toIndex === undefined) {
    return undefined;
  }
  const lanes = cloneLanes(wave);
  const [unit] = lanes[fromIndex].units.splice(
    Math.floor(Math.random() * lanes[fromIndex].units.length),
    1,
  );
  lanes[toIndex].units.splice(
    Math.floor(Math.random() * (lanes[toIndex].units.length + 1)),
    0,
    unit,
  );
  return { lanes };
};

/**
 * Déplace un monstre tiré au hasard à une autre place de sa propre file. Ni le coût, ni les
 * tracés, ni la répartition entre voies ne changent — seul l'ordre de spawn, qui n'est pas
 * cosmétique : `DefenseSimulation.spawn()` fait avancer la progression de spawn d'une voie à la
 * vitesse du monstre **en tête de file**, si bien qu'une file qui groupe ses unités rapides les
 * fait sortir plus densément (effet de masse) qu'une file qui les disperse entre des unités lentes.
 * Aucun autre opérateur ne fait varier l'ordre à composition constante. `undefined` si aucune voie
 * n'a au moins deux monstres (rien à réordonner).
 */
const shiftRandomUnit: MutationOperator = ({ wave }) => {
  const laneIndex = pickRandom(
    lanesWithUnits(wave).filter((index) => wave.lanes[index].units.length >= 2),
  );
  if (laneIndex === undefined) {
    return undefined;
  }
  const lanes = cloneLanes(wave);
  const units = lanes[laneIndex].units;
  const [unit] = units.splice(Math.floor(Math.random() * units.length), 1);
  units.splice(Math.floor(Math.random() * (units.length + 1)), 0, unit);
  return { lanes };
};

/**
 * Régénère entièrement la file d'une voie tirée au hasard pour le budget qu'elle consommait
 * (`initRandomQueues`) — le seul opérateur de composition d'origine, conservé à faible poids comme
 * échappatoire : les opérateurs fins ci-dessus progressent par petits pas et peuvent s'enliser dans
 * un optimum local, un tirage complet en ressort d'un coup.
 */
const rerollRandomLaneQueue: MutationOperator = ({ wave, monsterCatalog }) => {
  const laneIndex = pickRandom(lanesWithUnits(wave));
  if (laneIndex === undefined) {
    return undefined;
  }
  const lanes = cloneLanes(wave);
  const laneBudget = lanes[laneIndex].units.reduce(
    (total, unit) => total + unitCost(unit.type, monsterCatalog),
    0,
  );
  const [rerolled] = initRandomQueues([lanes[laneIndex].path], laneBudget, monsterCatalog);
  lanes[laneIndex] = rerolled;
  return { lanes };
};

/**
 * Les opérateurs de mutation et leur poids relatif. Deux familles se partagent la masse : le
 * **tracé** (4/10) et la **composition** (6/10).
 *
 * Cette répartition est le correctif d'un déséquilibre de fond : quatre des cinq mutations
 * d'origine portaient sur les routes, la cinquième régénérait une file de monstres au hasard — et
 * le croisement, lui, mélange bel et bien les tracés (`blendRoutes`) mais recopie les files telles
 * quelles depuis un parent. La composition n'avait donc aucun opérateur *local* : elle ne pouvait
 * pas s'améliorer par petits pas cumulés, seulement être tirée au sort puis conservée ou détruite.
 * La recherche ne pouvait pas découvrir les contres du catalogue, et discriminait les vagues bien
 * plus par leur tracé que par leurs monstres. Les six opérateurs de composition ci-dessus lui
 * rendent cette montée de gradient ; `swapRandomUnitType` pèse double parce que c'est celui qui
 * porte directement la question « quel monstre contre cette forteresse ».
 *
 * Le poids ne dit rien de la probabilité de muter, seulement du choix de l'opérateur une fois la
 * mutation décidée (`MUTATION_RATE`) : une seule mutation est appliquée à la fois, jamais plusieurs.
 */
const WAVE_MUTATIONS: readonly { weight: number; apply: MutationOperator }[] = [
  { weight: 1, apply: retraceRandomLane },
  { weight: 1, apply: dropRandomWaypoint },
  { weight: 1, apply: appendRandomLane },
  { weight: 1, apply: dropRandomLane },
  { weight: 2, apply: swapRandomUnitType },
  { weight: 1, apply: removeRandomUnit },
  { weight: 1, apply: moveRandomUnit },
  { weight: 1, apply: shiftRandomUnit },
  { weight: 1, apply: rerollRandomLaneQueue },
];

/** Tire un opérateur de `WAVE_MUTATIONS` proportionnellement à son poids. */
function pickMutation(): MutationOperator {
  const total = WAVE_MUTATIONS.reduce((sum, mutation) => sum + mutation.weight, 0);
  let roll = Math.random() * total;
  for (const mutation of WAVE_MUTATIONS) {
    roll -= mutation.weight;
    if (roll < 0) {
      return mutation.apply;
    }
  }
  return WAVE_MUTATIONS[WAVE_MUTATIONS.length - 1].apply;
}

/**
 * Mute une vague fille pour réintroduire de la diversité que le seul croisement ne peut pas
 * produire (il ne fait que recombiner les chemins/files déjà présents dans la population) : avec
 * probabilité `MUTATION_RATE`, applique un seul opérateur tiré dans `WAVE_MUTATIONS` — jamais
 * plusieurs à la fois. Les opérateurs d'ajout/retrait de voie sont les seuls à faire varier le
 * nombre de voies au-delà du plafond `maxLanes` de la population initiale (CONCEPTION.md §5.3 :
 * composer/décomposer une vague en voies reste gratuit, seules les cases de chemin et les monstres
 * sont facturés). La vague ressort inchangée si l'opérateur tiré ne s'applique pas (voie sans
 * monstre, route résultante invalide, une seule voie pour un déplacement inter-voies…) — plutôt que
 * d'en tirer un autre, pour que le poids de chaque opérateur reste celui déclaré. Une vague sans
 * aucune voie n'a rien à muter : seul l'ajout de voie a du sens, il est appliqué directement.
 *
 * La vague obtenue peut sortir du budget d'attaque (ou le sous-consommer) : c'est `enforceBudget`,
 * appelé juste après dans `evolveAttackWave`, qui la recale dans les deux sens.
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
  const context: MutationContext = { wave, map, towers, attackBudget, monsterCatalog };
  return pickMutation()(context) ?? wave;
}

/**
 * Cale une vague sur son budget d'attaque, dans les deux sens — c'est là tout l'intérêt de la
 * fonction, appelée sur chaque vague fille en sortie de `mutateWave` :
 *
 * - **En dépassement**, retire un monstre tiré au hasard dans une file tirée au hasard (parmi
 *   celles non vides) tant que le coût total (`waveCost`) excède `attackBudget` : `crossWaves`
 *   recombine des files chacune valide chez son parent d'origine, mais leur total peut dépasser le
 *   budget une fois réunies dans la vague fille.
 * - **En sous-consommation**, dépense le budget resté libre en monstres supplémentaires, insérés à
 *   une place tirée au hasard dans une voie tirée au hasard, jusqu'à ce que plus rien ne soit
 *   abordable. Sans ce second volet, rien dans l'évolution ne réinvestissait jamais le mou : le
 *   croisement recombine des files qui peuvent totaliser bien moins que le budget, la mutation
 *   « régénère la file » ne re-dépense que le coût de la voie qu'elle remplace, et le retrait
 *   ci-dessus ne fait que soustraire. Le budget monstres ne pouvait donc que décroître de
 *   génération en génération, pendant que les routes s'allongeaient (`spreadScore` récompense
 *   chaque case occupée) et lui prenaient sa part — la vague finissait bien plus définie par son
 *   tracé que par sa composition.
 *
 * Les voies vidées de tous leurs monstres sont retirées en fin de course, comme le fait
 * `initRandomWave` — mais après le réinvestissement, qui peut regarnir une voie arrivée vide du
 * croisement plutôt que de jeter son tracé (déjà payé, et qui rapporte de l'étalement).
 */
export function enforceBudget(
  wave: Wave,
  attackBudget: number,
  monsterCatalog: readonly MonsterType[],
): Wave {
  const lanes = cloneLanes(wave);
  while (waveCost({ lanes }, monsterCatalog) > attackBudget) {
    const lane = pickRandom(lanes.filter((candidate) => candidate.units.length > 0));
    if (!lane) {
      break;
    }
    lane.units.splice(Math.floor(Math.random() * lane.units.length), 1);
  }

  // Un monstre gratuit rendrait la boucle ci-dessous infinie (budget restant jamais entamé) : on
  // ne réinvestit que dans des types réellement facturés.
  const buyable = buyableMonsters(monsterCatalog).filter((type) => type.cost > 0);
  // Le coût des cases de chemin ne bouge pas d'une insertion à l'autre : `waveCost` une seule fois
  // suffit, le reste se décompte au fil des achats.
  let remaining = attackBudget - waveCost({ lanes }, monsterCatalog);
  let affordable = buyable.filter((type) => type.cost <= remaining);
  while (lanes.length > 0 && affordable.length > 0) {
    const type = pickRandom(affordable)!;
    const lane = pickRandom(lanes)!;
    lane.units.splice(Math.floor(Math.random() * (lane.units.length + 1)), 0, { type: type.id });
    remaining -= type.cost;
    affordable = buyable.filter((candidate) => candidate.cost <= remaining);
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
 * meilleure vague trouvée. `onBestFound`, s'il est fourni, est rappelé au fil de la notation de
 * chaque lot d'individus (`fittestWaves`, throttlé à ~60 fps par `createProgressReporter`) avec la
 * meilleure vague trouvée jusqu'ici et le nombre d'individus notés — permet à l'UI d'afficher la
 * progression de la recherche pendant que l'IA « réfléchit » plutôt que d'attendre le résultat
 * final. La notation de la population initiale (jusqu'à `2 * populationSize` vagues) domine
 * généralement le temps de calcul total, largement avant la première génération — c'est pourquoi
 * `onBestFound` y est déjà rappelé, pas seulement entre deux générations.
 */
export async function evolveAttackWave(
  map: GameMap,
  towers: readonly TowerInstance[],
  attackBudget: number,
  chateauMaxHp: number,
  monsterCatalog: readonly MonsterType[] = MONSTER_TYPES,
  maxLanes: number = 3,
  populationSize: number = DEFAULT_POPULATION_SIZE,
  maxTime: number = 100,
  onBestFound?: (best: Wave, info: ProgressInfo) => void,
): Promise<Wave> {
  const start = Date.now();
  const iterations = { count: 0 };
  const reporter: ProgressReporter<Wave> = createProgressReporter(onBestFound);
  let best: BestWave | undefined;

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
  const initialResult = await fittestWaves(
    initialCandidates,
    populationSize,
    towers,
    chateauMaxHp,
    map.chateau,
    monsterCatalog,
    iterations,
    reporter,
    best,
  );
  let population = initialResult.population;
  best = initialResult.best;

  while (population.length > 0 && Date.now() - start < maxTime) {
    const children = Array.from({ length: population.length }, () => {
      const [parentA, parentB] = shuffled(population);
      const child = crossWaves(map, towers, parentA, parentB ?? parentA);
      const mutated = mutateWave(child, map, towers, attackBudget, monsterCatalog);
      return enforceBudget(mutated, attackBudget, monsterCatalog);
    });
    const result = await fittestWaves(
      [...population, ...children],
      populationSize,
      towers,
      chateauMaxHp,
      map.chateau,
      monsterCatalog,
      iterations,
      reporter,
      best,
    );
    population = result.population;
    best = result.best;
  }

  return population[0] ?? { lanes: [] };
}

/** Nombre d'individus conservés par génération pour `playAttackPhase` — voir sa note. */
const OFFICIAL_POPULATION_SIZE = 50;

/**
 * Fait jouer l'ordinateur la phase Attaque : compose une vague qui détruit la forteresse figée,
 * via l'algorithme génétique `evolveAttackWave` (population de vagues candidates, notées avec
 * `phaseScore` en mode 'attack', puis sélection/croisement au fil des générations).
 *
 * `OFFICIAL_POPULATION_SIZE` (jusqu'à `2 * populationSize` vagues à noter pour la seule population
 * initiale, chacune une simulation de combat complète) est volontairement modeste : une population
 * de 500 laissait la notation de la population initiale consommer `maxTime` à elle seule (mesuré
 * jusqu'à 7 s pour un budget de 2 s), sans qu'aucune génération n'ait le temps de tourner — la
 * recherche dégénérait en un simple tirage aléatoire élargi, sans le brassage (croisement/mutation)
 * qui fait la valeur ajoutée de l'algorithme génétique.
 */
export async function playAttackPhase(input: AttackPlayerInput): Promise<Wave | undefined> {
  return evolveAttackWave(
    input.map,
    input.towers,
    input.attackBudget,
    input.chateauMaxHp,
    input.monsterCatalog,
    5,
    OFFICIAL_POPULATION_SIZE,
    input.maxTime,
    input.onBestFound,
  );
}
