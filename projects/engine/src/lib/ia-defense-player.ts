import type { GameMap, GridCoord, MapPath, MonsterType, TowerInstance, TowerType, Wave } from 'shared';
import { MONSTER_TYPES, TOWER_TYPES, hexDistance, hexNeighbors } from 'shared';
import { type SimulationCache, phaseScore, simulationCacheHitRate } from './combat';
import { canOccupyCell, canPlaceTower, cellKey } from './fortress';
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
  /** Cache optionnel des résultats de simulation, partagé entre plusieurs appels — voir `evolveDefense`. */
  simulationCache?: SimulationCache;
  /** Forteresse déjà posée : graine du GA (déplacement gratuit, suppression remboursée). */
  existingTowers?: readonly TowerInstance[];
}

/**
 * Cases d'une voie, développées une seule fois puis mémoïsées sur son chemin. Au-delà d'économiser
 * un `hexLinedraw` par tronçon, c'est ce qui donne à `laneCells`/`routeCells` une **identité de
 * tableau stable** — sans laquelle `cellsInRange` ci-dessous n'aurait rien sur quoi mémoïser.
 */
const laneCellsByPath = new WeakMap<MapPath, GridCoord[]>();

function laneCells(path: MapPath): GridCoord[] {
  const cached = laneCellsByPath.get(path);
  if (cached) {
    return cached;
  }
  const cells = expandPathCells(path);
  laneCellsByPath.set(path, cells);
  return cells;
}

/** Toutes les cases traversées par au moins une voie de la vague à tenir, mémoïsées sur la vague. */
const routeCellsByWave = new WeakMap<Wave, GridCoord[]>();

function routeCells(wave: Wave): GridCoord[] {
  const cached = routeCellsByWave.get(wave);
  if (cached) {
    return cached;
  }
  const cells = wave.lanes.flatMap((lane) => laneCells(lane.path));
  routeCellsByWave.set(wave, cells);
  return cells;
}

/**
 * Cases de la carte à portée (`range`) d'au moins une case de `routes` : une tour hors de cette zone
 * ne tirerait sur aucun monstre de la vague.
 *
 * Mémoïsé par carte, par ensemble de cases (identité du tableau — d'où `laneCells`/`routeCells`
 * ci-dessus) et par portée. La vague à tenir et la carte étant figées le temps d'une recherche, les
 * quelques ensembles en jeu (toutes les voies confondues, puis chacune séparément) et les 4 portées
 * du catalogue se calculent une fois pour toute la recherche, au lieu d'une fois par type de tour et
 * par tour candidate. C'était, avec `isPathCell`, le point chaud de la construction d'une forteresse
 * : un balayage de toute la grille contre toutes les cases de voie, soit ~7 500 `hexDistance` par
 * type et par tour posée, répété pour chacune des ~20 tours de chacune des centaines de forteresses
 * candidates.
 */
const cellsInRangeByMap = new WeakMap<GameMap, WeakMap<object, Map<number, GridCoord[]>>>();

function cellsInRange(map: GameMap, routes: readonly GridCoord[], range: number): GridCoord[] {
  let byRoutes = cellsInRangeByMap.get(map);
  if (!byRoutes) {
    byRoutes = new WeakMap<object, Map<number, GridCoord[]>>();
    cellsInRangeByMap.set(map, byRoutes);
  }
  let byRange = byRoutes.get(routes);
  if (!byRange) {
    byRange = new Map<number, GridCoord[]>();
    byRoutes.set(routes, byRange);
  }
  const cached = byRange.get(range);
  if (cached) {
    return cached;
  }

  const cells: GridCoord[] = [];
  for (let x = 0; x < map.grid.cols; x++) {
    for (let y = 0; y < map.grid.rows; y++) {
      const coord = { x, y };
      if (routes.some((cell) => hexDistance(cell, coord) <= range)) {
        cells.push(coord);
      }
    }
  }
  byRange.set(range, cells);
  return cells;
}

/** Vrai si une tour de portée `range` posée sur `coord` couvrirait au moins une case de voie. */
function coversAnyRoute(routes: readonly GridCoord[], coord: GridCoord, range: number): boolean {
  return routes.some((cell) => hexDistance(cell, coord) <= range);
}

/**
 * Coûts du catalogue indexés par id de type, mémoïsés sur le catalogue : `defenseCost` est appelé
 * en boucle par `enforceDefenseBudget` et par les mutations, chaque fois sur toutes les tours de la
 * forteresse — un `find` linéaire par tour y était du gaspillage pur, comme l'étaient les mêmes
 * recherches dans `DefenseSimulation` avant leur indexation (`towerTypesById`).
 */
const costsByCatalog = new WeakMap<object, Map<string, number>>();

function towerCosts(towerCatalog: readonly TowerType[]): Map<string, number> {
  const cached = costsByCatalog.get(towerCatalog);
  if (cached) {
    return cached;
  }
  const costs = new Map(towerCatalog.map((type) => [type.id, type.cost]));
  costsByCatalog.set(towerCatalog, costs);
  return costs;
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

  const costs = towerCosts(towerCatalog);

  for (const lane of shuffled(wave.lanes)) {
    const tower = initRandomTower(
      map,
      towers,
      wave,
      remainingBudget,
      towerCatalog,
      laneCells(lane.path),
    );
    if (!tower) {
      continue;
    }
    towers.push(tower);
    remainingBudget -= costs.get(tower.typeId) ?? 0;
  }

  for (;;) {
    const tower = initRandomTower(map, towers, wave, remainingBudget, towerCatalog);
    if (!tower) {
      break;
    }
    towers.push(tower);
    remainingBudget -= costs.get(tower.typeId) ?? 0;
  }
  return towers;
}

function cloneFortress(towers: readonly TowerInstance[]): TowerInstance[] {
  return towers.map((tower) => ({
    ...tower,
    id: `ia-tower-${Math.floor(Math.random() * 1e9)}`,
    position: { x: tower.position.x, y: tower.position.y },
  }));
}

/**
 * Amplitude du bruit multiplicatif appliqué au mérite de chaque case par `initGreedyDefense` : sans
 * lui, le glouton étant déterministe, toutes les forteresses ensemencées seraient identiques et
 * n'apporteraient aucune diversité génétique — une seule suffirait. À ±40 %, deux ensemencements
 * partagent la structure générale (les mêmes goulots) sans jamais poser exactement les mêmes tours.
 */
const GREEDY_JITTER = 0.4;

/**
 * Débit d'une tour, en dégâts par tick : ce qu'elle vaut réellement pour un même coût. Le bonus
 * anti-armure ne compte qu'à moitié (tous les monstres ne sont pas blindés), le ralentissement pas du
 * tout — sa valeur est d'allonger l'exposition, ce que ce simple ratio ne sait pas voir. C'est une
 * heuristique d'ensemencement, pas une notation : la sélection tranchera.
 */
function towerThroughput(type: TowerType): number {
  return (type.damage / (type.cooldown + 1)) * (type.armorBonus ? 1.5 : 1);
}

/**
 * Initialise une forteresse candidate par placement **glouton sur les goulots d'étranglement** :
 * tant qu'il reste du budget, pose la tour dont le rapport mérite/coût est le meilleur, le mérite
 * d'une case étant la somme, sur les cases de voie qu'elle couvrirait, d'un poids qui décroît avec
 * leur distance au château et avec le nombre de tours déjà postées les couvrant (rendements
 * décroissants — inutile d'empiler une cinquième tour sur la case la mieux tenue de la carte).
 *
 * C'est la seule brique de la recherche à exploiter ce que la défense **sait déjà** : la vague à
 * tenir est connue exactement, donc ses goulots aussi. `initRandomDefense` tire au contraire ses
 * cases *uniformément* parmi celles à portée d'une voie, sans distinguer une case qui couvre une
 * seule case de voie en bord de carte d'une case qui en couvre huit juste devant le château. Côté
 * Attaque, l'équivalent existe depuis toujours (`initRandomRoute` évite les tours, `affordableLaneCap`
 * borne les voies infinançables) ; la défense partait, elle, du pur hasard.
 *
 * Ne remplace pas la recherche : n'en ensemence qu'une partie de la population initiale (voir
 * `evolveDefense`), le reste restant tiré au hasard pour ne pas enfermer l'algorithme génétique dans
 * l'optimum local du glouton.
 */
export function initGreedyDefense(
  map: GameMap,
  wave: Wave,
  defenseBudget: number,
  towerCatalog: readonly TowerType[] = TOWER_TYPES,
  jitter: number = GREEDY_JITTER,
): TowerInstance[] {
  const routes = routeCells(wave);
  if (routes.length === 0) {
    return [];
  }
  // Poids d'une case de voie : ce que la tenir rapporte, décroissant avec sa distance au château —
  // un monstre arrêté au dernier moment l'est de justesse, un monstre arrêté loin laisse de la marge.
  const weights = routes.map((cell) => 100 / (1 + hexDistance(cell, map.chateau)));
  const coveredBy = new Float64Array(routes.length);

  const towers: TowerInstance[] = [];
  let remainingBudget = defenseBudget;

  for (;;) {
    let best: { coord: GridCoord; type: TowerType; merit: number } | undefined;
    for (const type of towerCatalog) {
      if (type.cost > remainingBudget) {
        continue;
      }
      const throughput = towerThroughput(type);
      for (const coord of cellsInRange(map, routes, type.range)) {
        if (!canPlaceTower(map, towers, type, coord, remainingBudget).ok) {
          continue;
        }
        let merit = 0;
        for (let i = 0; i < routes.length; i++) {
          if (hexDistance(routes[i], coord) <= type.range) {
            merit += weights[i] / (1 + coveredBy[i]);
          }
        }
        merit = ((merit * throughput) / type.cost) * (1 + jitter * (2 * Math.random() - 1));
        if (!best || merit > best.merit) {
          best = { coord, type, merit };
        }
      }
    }
    if (!best) {
      return towers;
    }
    towers.push({
      id: `ia-greedy-${Math.floor(Math.random() * 1e9)}`,
      typeId: best.type.id,
      position: best.coord,
      level: 1,
      placedAtPalier: 0,
    });
    for (let i = 0; i < routes.length; i++) {
      if (hexDistance(routes[i], best.coord) <= best.type.range) {
        coveredBy[i]++;
      }
    }
    remainingBudget -= best.type.cost;
  }
}

/**
 * Coût total (budget de défense) d'une liste de tours, tous types confondus.
 */
function defenseCost(towers: readonly TowerInstance[], towerCatalog: readonly TowerType[]): number {
  const costs = towerCosts(towerCatalog);
  return towers.reduce((total, tower) => total + (costs.get(tower.typeId) ?? 0), 0);
}

/**
 * Croise deux forteresses parentes en **un point**, sur des gènes préalablement ordonnés du plus
 * proche au plus loin du château (`chateau`) : la fille reprend les `k` tours les plus intérieures de
 * `parentA` et toutes celles de `parentB` à partir du rang `k`, `k` étant tiré au hasard. Une tour
 * dont la position ferait doublon avec une tour déjà retenue est ignorée : le croisement ne doit pas
 * produire deux tours sur la même case. Brique de reproduction de l'algorithme génétique — voir
 * `evolveDefense`.
 *
 * L'ordre est ce qui fait tout l'intérêt du croisement. Une liste de tours n'a pas d'ordre naturel —
 * au contraire des voies d'une vague, où `crossWaves` peut recombiner la i-ème voie de l'un avec la
 * i-ème de l'autre parce que l'index a un sens. Croiser par index brut, comme ici auparavant,
 * revenait donc à jouer chaque *rang de tableau* à pile ou face entre deux tours sans le moindre
 * rapport spatial : du bruit, pas une recombinaison. Trié par distance au château, le rang porte au
 * contraire une structure — « le bouchon devant le château de A, plus le rideau extérieur de B » — et
 * la coupe en un point recombine ces deux moitiés-là. Accessoirement, la fille garde le même nombre
 * de tours que ses parents (aux doublons près) au lieu d'en perdre à chaque tirage.
 *
 * Sans `chateau`, l'ordre retombe sur les coordonnées de la case : moins parlant, mais toujours
 * stable — ce qui suffit à ne pas croiser au hasard.
 */
export function crossDefenses(
  parentA: readonly TowerInstance[],
  parentB: readonly TowerInstance[],
  chateau?: GridCoord,
): TowerInstance[] {
  const rank = (tower: TowerInstance): number =>
    chateau
      ? hexDistance(tower.position, chateau)
      : tower.position.x * 1000 + tower.position.y;
  const byRank = (a: TowerInstance, b: TowerInstance): number => rank(a) - rank(b);
  const innerFirst = [...parentA].sort(byRank);
  const outerFrom = [...parentB].sort(byRank);
  const cut = Math.floor(Math.random() * (1 + Math.max(innerFirst.length, outerFrom.length)));

  const towers: TowerInstance[] = [];
  const usedPositions = new Set<string>();
  for (const tower of [...innerFirst.slice(0, cut), ...outerFrom.slice(cut)]) {
    const key = cellKey(tower.position);
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
 * Contexte passé à chaque opérateur de mutation (voir `DEFENSE_MUTATIONS`) : la forteresse à muter et
 * tout ce dont un opérateur peut avoir besoin pour poser une tour ou en tarifer une. Pendant de
 * `MutationContext` côté Attaque.
 */
interface DefenseMutationContext {
  towers: readonly TowerInstance[];
  map: GameMap;
  wave: Wave;
  defenseBudget: number;
  towerCatalog: readonly TowerType[];
}

/** Un opérateur de mutation : la forteresse altérée, ou `undefined` s'il ne s'applique pas (aucune case libre, aucun type finançable…) — l'appelant garde alors la forteresse inchangée. */
type DefenseMutationOperator = (context: DefenseMutationContext) => TowerInstance[] | undefined;

/** Une tour tirée au hasard, et les autres à part — base de tout opérateur qui altère une seule tour. */
function pickTower(
  towers: readonly TowerInstance[],
): { tower: TowerInstance; others: TowerInstance[] } | undefined {
  if (towers.length === 0) {
    return undefined;
  }
  const index = Math.floor(Math.random() * towers.length);
  return { tower: towers[index], others: towers.filter((_, i) => i !== index) };
}

/** Budget encore disponible une fois toutes les tours de `towers` payées. */
function remainingBudgetFor(
  towers: readonly TowerInstance[],
  defenseBudget: number,
  towerCatalog: readonly TowerType[],
): number {
  return Math.max(0, defenseBudget - defenseCost(towers, towerCatalog));
}

// --- Opérateurs de placement -------------------------------------------------

/**
 * Déplace une tour tirée au hasard vers une case **adjacente** libre (`hexNeighbors`) qui couvre
 * toujours au moins une case de voie. Gratuit : `canOccupyCell` ne vérifie que la géométrie, pas le
 * budget — une tour déjà payée le reste en changeant de case (CONCEPTION.md §4).
 *
 * Le contrôle de portée est ce qui manquait : le déplacement pouvait pousser une tour hors de portée
 * de toute voie, où elle ne tirait plus jamais tout en restant payée — alors que le changement de
 * type, lui, l'a toujours vérifié. C'est le pas fin du placement, celui qui va chercher la case juste
 * à côté qui étrangle un peu plus l'attaquant.
 */
const nudgeRandomTower: DefenseMutationOperator = ({ towers, map, wave, towerCatalog }) => {
  const picked = pickTower(towers);
  if (!picked) {
    return undefined;
  }
  const routes = routeCells(wave);
  const range = towerCatalog.find((type) => type.id === picked.tower.typeId)?.range ?? 0;
  for (const neighbor of shuffled(hexNeighbors(picked.tower.position))) {
    if (
      coversAnyRoute(routes, neighbor, range) &&
      canOccupyCell(map, picked.others, neighbor).ok
    ) {
      return [...picked.others, { ...picked.tower, position: neighbor }];
    }
  }
  return undefined;
};

/**
 * Téléporte une tour tirée au hasard n'importe où à portée d'une voie — pendant de
 * `retraceRandomLane` côté Attaque, à l'échelle d'une tour. Le déplacement vers une case adjacente
 * (`nudgeRandomTower`) ne franchit qu'une case à la fois : à `MUTATION_RATE` près, une tour mal
 * placée mettait des dizaines de générations à traverser la carte, en devant qui plus est améliorer
 * le score à *chaque* pas intermédiaire pour survivre à la sélection. Sans saut, un mauvais
 * placement initial était pratiquement définitif.
 */
const teleportRandomTower: DefenseMutationOperator = ({ towers, map, wave, towerCatalog }) => {
  const picked = pickTower(towers);
  if (!picked) {
    return undefined;
  }
  const range = towerCatalog.find((type) => type.id === picked.tower.typeId)?.range ?? 0;
  for (const coord of shuffled(cellsInRange(map, routeCells(wave), range))) {
    if (canOccupyCell(map, picked.others, coord).ok) {
      return [...picked.others, { ...picked.tower, position: coord }];
    }
  }
  return undefined;
};

/**
 * Retire une tour tirée au hasard. Libère volontairement du budget que le réinvestissement
 * d'`enforceDefenseBudget`, appelé juste après, redépense ailleurs : c'est le mécanisme par lequel
 * une forteresse peut se déplacer vers des tours plus chères, qu'un simple changement de type ne
 * permet pas seul à budget serré.
 */
const dropRandomTower: DefenseMutationOperator = ({ towers }) => pickTower(towers)?.others;

/**
 * Ajoute une tour là où le budget encore libre le permet (`initRandomTower`). L'opérateur qui
 * manquait : sans lui, `crossDefenses` (qui déduplique) et `dropRandomTower` ne faisaient que
 * retirer des tours, et `enforceDefenseBudget` ne savait pas en reposer. Le nombre de tours ne
 * pouvait donc que **décroître** de génération en génération — après la génération 0, la recherche
 * n'explorait plus que des sous-ensembles du tirage initial, et une bonne tour que le hasard n'avait
 * pas trouvée d'entrée n'apparaissait jamais. C'est le même défaut que celui corrigé côté Attaque
 * par le volet réinvestissement d'`enforceBudget`, jamais reporté ici jusqu'à présent.
 */
const appendRandomTower: DefenseMutationOperator = ({
  towers,
  map,
  wave,
  defenseBudget,
  towerCatalog,
}) => {
  const tower = initRandomTower(
    map,
    towers,
    wave,
    remainingBudgetFor(towers, defenseBudget, towerCatalog),
    towerCatalog,
  );
  return tower ? [...towers, tower] : undefined;
};

// --- Opérateur d'armement ----------------------------------------------------

/**
 * Change le type d'une tour tirée au hasard, sur la même case, tout le reste inchangé : l'opérateur
 * qui porte directement la question « **quelle tour contre cette vague** » — blindés face à une
 * défense sans catapulte, monstres rapides face à une défense sans Glace, groupes serrés face à une
 * défense sans Canon. Pendant exact de `swapRandomUnitType` côté Attaque, et pondéré double pour la
 * même raison.
 *
 * Plafonné au budget encore disponible une fois les autres tours payées, pour ne jamais sortir du
 * budget par la seule mutation ; le nouveau type doit en outre couvrir au moins une case de voie,
 * sans quoi la tour mutée ne tirerait plus sur aucun monstre (une portée plus courte peut faire
 * perdre la voie qu'elle tenait).
 */
const swapRandomTowerType: DefenseMutationOperator = ({
  towers,
  map,
  wave,
  defenseBudget,
  towerCatalog,
}) => {
  const picked = pickTower(towers);
  if (!picked) {
    return undefined;
  }
  const routes = routeCells(wave);
  const remainingBudget = remainingBudgetFor(picked.others, defenseBudget, towerCatalog);
  for (const type of shuffled(towerCatalog)) {
    if (type.id === picked.tower.typeId) {
      continue;
    }
    if (
      coversAnyRoute(routes, picked.tower.position, type.range) &&
      canPlaceTower(map, picked.others, type, picked.tower.position, remainingBudget).ok
    ) {
      return [...picked.others, { ...picked.tower, typeId: type.id }];
    }
  }
  return undefined;
};

/**
 * Les opérateurs de mutation et leur poids relatif. Le **placement** se partage 6/8 (déplacement fin
 * 2, saut 1, retrait 1, ajout 2) et l'**armement** 2/8.
 *
 * Cette répartition corrige un déséquilibre en miroir de celui corrigé côté Attaque : la défense
 * n'avait que trois opérateurs, tirés uniformément à 1/3, et aucun ne savait *ajouter* une tour. Le
 * placement est ici plus lourdement pondéré que l'armement — l'inverse du choix fait côté Attaque —
 * parce que le catalogue de tours est court (4 types, donc un espace d'armement vite exploré) alors
 * que la carte offre des centaines de cases, et que c'est bien la disposition qui décide du critère de
 * succès d'une défense (`attackerRoutingCost` : étrangler les routes de l'attaquant).
 *
 * Le poids ne dit rien de la probabilité de muter, seulement du choix de l'opérateur une fois la
 * mutation décidée (`MUTATION_RATE`) : une seule mutation est appliquée à la fois, jamais plusieurs.
 */
const DEFENSE_MUTATIONS: readonly { weight: number; apply: DefenseMutationOperator }[] = [
  { weight: 2, apply: nudgeRandomTower },
  { weight: 1, apply: teleportRandomTower },
  { weight: 1, apply: dropRandomTower },
  { weight: 2, apply: appendRandomTower },
  { weight: 2, apply: swapRandomTowerType },
];

/** Tire un opérateur de `DEFENSE_MUTATIONS` proportionnellement à son poids. */
function pickDefenseMutation(): DefenseMutationOperator {
  const total = DEFENSE_MUTATIONS.reduce((sum, mutation) => sum + mutation.weight, 0);
  let roll = Math.random() * total;
  for (const mutation of DEFENSE_MUTATIONS) {
    roll -= mutation.weight;
    if (roll < 0) {
      return mutation.apply;
    }
  }
  return DEFENSE_MUTATIONS[DEFENSE_MUTATIONS.length - 1].apply;
}

/**
 * Mute une forteresse fille pour réintroduire de la diversité que le seul croisement ne peut pas
 * produire (il ne fait que recombiner des tours déjà présentes dans la population) : avec
 * probabilité `MUTATION_RATE`, applique un seul opérateur tiré dans `DEFENSE_MUTATIONS` — jamais
 * plusieurs à la fois. La forteresse ressort inchangée si l'opérateur tiré ne s'applique pas (aucune
 * case adjacente libre et à portée, aucun type finançable, budget saturé…) plutôt que d'en tirer un
 * autre, pour que le poids de chaque opérateur reste celui déclaré. Une forteresse vide n'a rien à
 * muter sinon recevoir sa première tour : l'ajout y est appliqué directement.
 *
 * La forteresse obtenue peut sous-consommer le budget de défense (ou le dépasser, l'ajout et le
 * changement de type mis à part) : c'est `enforceDefenseBudget`, appelé juste après dans
 * `evolveDefense`, qui la recale dans les deux sens.
 */
function mutateDefense(
  towers: readonly TowerInstance[],
  map: GameMap,
  wave: Wave,
  defenseBudget: number,
  towerCatalog: readonly TowerType[],
): TowerInstance[] {
  if (Math.random() > MUTATION_RATE) {
    return [...towers];
  }
  const context: DefenseMutationContext = { towers, map, wave, defenseBudget, towerCatalog };
  if (towers.length === 0) {
    return appendRandomTower(context) ?? [...towers];
  }
  return pickDefenseMutation()(context) ?? [...towers];
}

/**
 * Cale une forteresse sur son budget de défense, **dans les deux sens** — c'est là tout l'intérêt de
 * la fonction, appelée sur chaque forteresse fille en sortie de `mutateDefense` (pendant exact
 * d'`enforceBudget` côté Attaque) :
 *
 * - **En dépassement**, retire une tour tirée au hasard tant que le coût total excède
 *   `defenseBudget` : `crossDefenses` recombine des tours chacune valide chez son parent d'origine,
 *   mais leur total peut dépasser le budget une fois réunies dans la fille.
 * - **En sous-consommation**, dépense le budget resté libre en tours supplémentaires
 *   (`initRandomTower`, donc toujours à portée d'une voie) jusqu'à ce que plus aucune ne soit
 *   plaçable. Sans ce second volet, rien dans l'évolution ne réinvestissait jamais le mou : le
 *   croisement déduplique les positions et rend donc des filles plus petites que leurs parents, le
 *   retrait ne fait que soustraire, et le changement de type est plafonné à une seule tour. Le
 *   budget de défense ne pouvait donc que **décroître de génération en génération** — mesuré à 99 %
 *   dépensé au tirage initial contre 85 % dans la forteresse finalement livrée au palier 9, soit
 *   quatre tours jamais construites. Pire, le nombre de tours ne pouvant jamais remonter, la
 *   recherche n'explorait après la génération 0 que des sous-ensembles du tirage initial.
 *
 * `map` et `wave` sont ce dont le réinvestissement a besoin pour savoir où poser : sans eux, seul le
 * volet dépassement s'applique (utile pour recadrer une forteresse hors de tout contexte de
 * recherche).
 */
export function enforceDefenseBudget(
  towers: readonly TowerInstance[],
  defenseBudget: number,
  towerCatalog: readonly TowerType[],
  map?: GameMap,
  wave?: Wave,
): TowerInstance[] {
  const costs = towerCosts(towerCatalog);
  let remaining = [...towers];
  let spent = defenseCost(remaining, towerCatalog);

  while (remaining.length > 0 && spent > defenseBudget) {
    const index = Math.floor(Math.random() * remaining.length);
    spent -= costs.get(remaining[index].typeId) ?? 0;
    remaining = remaining.filter((_, i) => i !== index);
  }

  if (!map || !wave) {
    return remaining;
  }
  for (;;) {
    const tower = initRandomTower(map, remaining, wave, defenseBudget - spent, towerCatalog);
    if (!tower) {
      return remaining;
    }
    // Nouveau tableau à chaque pose plutôt qu'un `push` : plusieurs index du moteur sont mémoïsés sur
    // l'identité du tableau de tours (`towerCells`, `parentsTowardChateau`), qu'une modification en
    // place rendrait silencieusement caducs.
    remaining = [...remaining, tower];
    spent += costs.get(tower.typeId) ?? 0;
  }
}

/**
 * Note une forteresse avec `phaseScore` en mode 'defense' : entre deux défenses qui échouent (le
 * château a encaissé au moins un point de dégât), la vie du château la plus haute — la plus proche de
 * rester intacte — est la meilleure ; entre deux défenses qui tiennent la vague sans aucun dégât,
 * celle qui rend la vie la plus dure à l'attaquant du palier suivant l'emporte
 * (`attackerRoutingCost` : la meilleure route qui lui reste est la plus longue et la plus couverte
 * possible), la rapidité de résolution les départageant à égalité.
 */
function scoreDefense(
  towers: readonly TowerInstance[],
  wave: Wave,
  chateauMaxHp: number,
  map: GameMap,
  monsterCatalog: readonly MonsterType[],
  towerCatalog: readonly TowerType[],
  simulationCache: SimulationCache | undefined,
): number {
  return phaseScore(towers, wave, chateauMaxHp, map, monsterCatalog, towerCatalog, 'defense', simulationCache);
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
  map: GameMap,
  monsterCatalog: readonly MonsterType[],
  towerCatalog: readonly TowerType[],
  iterations: { count: number },
  reporter: ProgressReporter<readonly TowerInstance[]>,
  seed: BestDefense | undefined,
  knownScores: WeakMap<object, number>,
  simulationCache: SimulationCache | undefined,
): Promise<{ population: TowerInstance[][]; best: BestDefense | undefined }> {
  const scored: BestDefense[] = [];
  let best = seed;
  for (const candidate of candidates) {
    const known = knownScores.get(candidate);
    const towers = [...candidate];
    const score =
      known ?? scoreDefense(towers, wave, chateauMaxHp, map, monsterCatalog, towerCatalog, simulationCache);
    // La copie est ce que `population` transportera jusqu'à la génération suivante : c'est donc
    // elle, et pas `candidate`, qui doit porter le score dans le cache.
    knownScores.set(towers, score);
    scored.push({ towers, score });
    if (!best || score > best.score) {
      best = { towers, score };
    }
    if (known !== undefined) {
      // Score déjà connu : ni travail effectué à compter, ni raison de rendre la main à l'IU.
      continue;
    }
    iterations.count++;
    await reporter.report(best.towers, {
      iterations: iterations.count,
      score: best.score,
      cacheHitRate: simulationCache && simulationCacheHitRate(simulationCache),
    });
  }
  const population = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((entry) => entry.towers);
  return { population, best };
}

const DEFAULT_POPULATION_SIZE = 20;

/**
 * Une forteresse sur `GREEDY_SEED_PERIOD` de la population initiale est ensemencée par placement
 * glouton sur les goulots (`initGreedyDefense`), les autres restant tirées au hasard
 * (`initRandomDefense`). Un quart : de quoi donner à la recherche un point de départ nettement
 * meilleur que le hasard, sans l'enfermer dans l'optimum local du glouton — les trois quarts
 * aléatoires gardent la diversité dont le croisement a besoin pour trouver ce que le glouton ne voit
 * pas (il ne raisonne que sur la couverture des voies, pas sur l'étranglement des routes futures,
 * qui est le vrai critère de succès — voir `attackerRoutingCost`).
 */
const GREEDY_SEED_PERIOD = 4;

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
  /** Cache optionnel des résultats de simulation — voir `evolveAttackWave`, pendant côté Attaque. */
  simulationCache?: SimulationCache,
  existingTowers: readonly TowerInstance[] = [],
): Promise<TowerInstance[]> {
  const start = Date.now();
  const iterations = { count: 0 };
  const reporter: ProgressReporter<readonly TowerInstance[]> = createProgressReporter(onBestFound);
  let best: BestDefense | undefined;
  /**
   * Scores déjà calculés — même raison que côté Attaque (voir `evolveAttackWave`) : `fittestDefenses`
   * reçoit `[...population, ...children]`, dont la moitié a déjà été notée à la génération
   * précédente et n'a pas changé depuis. Propre à cette recherche, la vague à tenir et les
   * catalogues y étant figés.
   */
  const knownScores = new WeakMap<object, number>();

  // Bornée par maxTime comme la boucle principale ci-dessous : un populationSize trop ambitieux
  // pour le temps imparti dégrade la qualité plutôt que de dépasser le budget de temps.
  const initialCandidates: TowerInstance[][] = [];
  if (existingTowers.length > 0) {
    initialCandidates.push(
      enforceDefenseBudget(cloneFortress(existingTowers), defenseBudget, towerCatalog, map, wave),
    );
  }
  while (initialCandidates.length < 2 * populationSize && Date.now() - start < maxTime) {
    // Une forteresse sur `GREEDY_SEED_PERIOD` est ensemencée sur les goulots plutôt que tirée au
    // hasard. Intercalées, et non posées en tête : le tirage étant borné par `maxTime` et une
    // forteresse gloutonne coûtant plus cher à construire, un budget de temps serré doit tout de
    // même produire un mélange des deux, pas seulement des gloutonnes.
    const rebuild =
      initialCandidates.length % GREEDY_SEED_PERIOD === 0
        ? initGreedyDefense(map, wave, defenseBudget, towerCatalog)
        : initRandomDefense(map, wave, defenseBudget, towerCatalog);
    initialCandidates.push(rebuild);
  }
  const initialResult = await fittestDefenses(
    initialCandidates,
    populationSize,
    wave,
    chateauMaxHp,
    map,
    monsterCatalog,
    towerCatalog,
    iterations,
    reporter,
    best,
    knownScores,
    simulationCache,
  );
  let population = initialResult.population;
  best = initialResult.best;

  while (population.length > 0 && Date.now() - start < maxTime) {
    const children = Array.from({ length: population.length }, () => {
      const [parentA, parentB] = shuffled(population);
      const child = crossDefenses(parentA, parentB ?? parentA, map.chateau);
      const mutated = mutateDefense(child, map, wave, defenseBudget, towerCatalog);
      return enforceDefenseBudget(mutated, defenseBudget, towerCatalog, map, wave);
    });
    const result = await fittestDefenses(
      [...population, ...children],
      populationSize,
      wave,
      chateauMaxHp,
      map,
      monsterCatalog,
      towerCatalog,
      iterations,
      reporter,
      best,
      knownScores,
      simulationCache,
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
    input.simulationCache,
    input.existingTowers ?? [],
  );
}
