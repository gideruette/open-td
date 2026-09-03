import type { GameMap, GridCoord, MapPath, MonsterType, TowerInstance, TowerType, Wave } from 'shared';
import { MONSTER_TYPES, TOWER_TYPES, hexDistance, hexNeighbors, hexToWorld } from 'shared';
import {
  buildableCells,
  cellKey,
  isBorderCell,
  isChateauCell,
  isWithinGrid,
  riverCells,
  towerCells,
} from './fortress';
import {
  PATH_CELL_COST,
  type PathGeometry,
  buildPathGeometry,
  expandPathCells,
  pathCellsCost,
  pointAtDistanceOn,
} from './path';

/** Candidat de ciblage : vue minimale d'un monstre utile au choix de la cible d'une tour. */
export interface TargetCandidate {
  id: string;
  /** Distance parcourue le long du chemin (plus grand = plus avancé). */
  distance: number;
  /** Position en world-space (centres hex, voisin ≈ 1). */
  position: GridCoord;
}

/**
 * Choisit la cible d'une tour parmi les monstres à portée : toujours le plus avancé (le premier
 * rencontré en cas d'égalité). `towerPosition` et les positions candidats sont en world-space.
 *
 * Une seule passe, sans tableau intermédiaire ni racine carrée (comparaison des carrés des
 * distances) : appelée pour chaque tour à chaque tick de simulation, c'est l'une des boucles les
 * plus chaudes du moteur.
 */
export function selectTarget(
  towerPosition: GridCoord,
  towerRange: number,
  candidates: readonly TargetCandidate[],
): string | undefined {
  const rangeSquared = towerRange * towerRange;
  let best: TargetCandidate | undefined;
  for (const candidate of candidates) {
    const dx = candidate.position.x - towerPosition.x;
    const dy = candidate.position.y - towerPosition.y;
    if (dx * dx + dy * dy > rangeSquared) {
      continue;
    }
    if (!best || candidate.distance > best.distance) {
      best = candidate;
    }
  }
  return best?.id;
}

/**
 * Dégâts totaux qu'infligerait la vague au château si aucun monstre n'était arrêté, toutes voies confondues.
 * Le budget/`chateauHp` d'une carte doit rester à ce niveau ou en dessous : une défense
 * absente ou inefficace doit pouvoir détruire le château (voir CONCEPTION.md §4, §6).
 */
export function totalChateauDamage(
  wave: Wave,
  monsterCatalog: readonly MonsterType[] = MONSTER_TYPES,
): number {
  return wave.lanes.reduce(
    (total, lane) =>
      total +
      lane.units.reduce((laneTotal, unit) => {
        const type = monsterCatalog.find((candidate) => candidate.id === unit.type);
        return laneTotal + (type?.chateauDamage ?? 0);
      }, 0),
    0,
  );
}

/**
 * Coût total (budget d'attaque) d'une vague, toutes voies confondues (CONCEPTION.md §5.1) :
 * coût des monstres, plus le coût des cases de chemin occupées par les voies — chaque case
 * n'est facturée qu'une fois même si plusieurs voies s'y superposent (CONCEPTION.md §5.3).
 */
export function waveCost(
  wave: Wave,
  monsterCatalog: readonly MonsterType[] = MONSTER_TYPES,
  pathCellCost: number = PATH_CELL_COST,
): number {
  const monstersCost = wave.lanes.reduce(
    (total, lane) =>
      total +
      lane.units.reduce((laneTotal, unit) => {
        const type = monsterCatalog.find((candidate) => candidate.id === unit.type);
        return laneTotal + (type?.cost ?? 0);
      }, 0),
    0,
  );
  return (
    monstersCost +
    pathCellsCost(
      wave.lanes.map((lane) => lane.path),
      pathCellCost,
    )
  );
}

/**
 * Tir d'une tour survenu pendant le dernier tick.
 * `towerPosition` : case odd-r de la tour ; `targetPosition` : world-space du monstre touché.
 */
export interface ShotEvent {
  towerPosition: GridCoord;
  targetPosition: GridCoord;
  /** Rayon de la zone d'effet à l'impact, pour les tours à dégâts de zone (ex. Canon). */
  splashRadius?: number;
}

/** Instance de monstre vivante pendant une épreuve de défense (état interne de simulation). */
export interface MonsterInstance {
  id: string;
  typeId: string;
  hp: number;
  /** Distance parcourue le long de la voie, en cases de grille. */
  distance: number;
  /** Voie (chemin + file de spawn) empruntée par ce monstre — index dans `Wave.lanes`. */
  laneIndex: number;
  slowMultiplier: number;
  slowUntilTick: number;
}

export type DefenseOutcome = 'pending' | 'success' | 'failure';

/**
 * Camp du joueur pour cette simulation : `defense` (tenir vagueCourante, château qui n'encaisse
 * aucun dégât) ou `attack` (percer avec une vague composée jusqu'à détruire le château) —
 * CONCEPTION.md §5.4. La mécanique de simulation (spawn, déplacement, tir, dégâts) est identique
 * dans les deux cas ; seule l'interprétation de la victoire/défaite change.
 */
export type SimulationMode = 'defense' | 'attack';

interface LaneState {
  path: MapPath;
  /** Tracé précalculé de la voie : situer un monstre dessus ne redéveloppe plus son chemin (voir `PathGeometry`). */
  geometry: PathGeometry;
  pathTotalLength: number;
  spawnQueue: string[];
  /** Progression continue vers le prochain spawn, en unités de `spawnThreshold` (voir `spawn()`). */
  spawnProgress: number;
}

/**
 * Vue précalculée d'une tour pour la simulation : son type résolu et sa position en world-space.
 * Résoudre le type (recherche dans le catalogue) et convertir la position à chaque tick, pour
 * chaque tour, était pur gaspillage — ni l'un ni l'autre ne change de toute la simulation, les
 * tours étant figées pendant l'épreuve. Les tours dont le type est introuvable au catalogue sont
 * absentes de cette liste : elles ne tirent jamais, exactement comme avant.
 */
interface TowerState {
  tower: TowerInstance;
  type: TowerType;
  worldPosition: GridCoord;
}

const DEFAULT_TICKS_BETWEEN_SPAWNS = 5;
const DEFAULT_MAX_TICKS = 20_000;
/** Vitesse à laquelle `ticksBetweenSpawns` s'applique telle quelle (calibrée sur le Gobelin). */
const SPAWN_GAP_REFERENCE_SPEED = 0.25;

/**
 * Simulation déterministe, tick par tick, d'une épreuve (défense ou attaque) : la vague
 * donnée — une ou plusieurs voies actives simultanément, CONCEPTION.md §5.3 — est envoyée
 * sur la forteresse (tours figées). En défense, l'épreuve tourne jusqu'à ce qu'il n'y ait plus
 * aucun monstre sur la carte (toutes les voies traitées) — le château peut encaisser des dégâts
 * en cours de route sans arrêter la simulation, seul le résultat à la fin compte (CONCEPTION.md
 * §12) : tout dégât, même sans faire tomber le château à 0, condamne la défense. En attaque, elle
 * s'arrête dès que le château est détruit (0 PV).
 */
export class DefenseSimulation {
  private tick = 0;
  private chateauHp: number;
  private monsters: MonsterInstance[] = [];
  private readonly lanes: LaneState[];
  private readonly towerCooldowns = new Map<string, number>();
  private outcome: DefenseOutcome = 'pending';
  private monsterSequence = 0;
  private shotsThisTick: ShotEvent[] = [];
  private breachCount = 0;
  private totalDamageDealt = 0;
  /** Tours résolues une fois pour toutes (type + position world-space) — voir `TowerState`. */
  private readonly towerStates: TowerState[];
  /** Catalogue de monstres indexé par id : la simulation y accède plusieurs fois par monstre et par tick. */
  private readonly monsterTypesById: Map<string, MonsterType>;
  /** Catalogue de tours indexé par id, pour les mêmes raisons que `monsterTypesById`. */
  private readonly towerTypesById: Map<string, TowerType>;
  /**
   * Positions world-space des monstres, mémorisées le temps d'un tick (voir `getMonsterPosition`).
   * Vidé par `moveMonsters` — le seul endroit où une distance parcourue change.
   */
  private positionCache = new Map<string, GridCoord>();

  constructor(
    private readonly towers: readonly TowerInstance[],
    wave: Wave,
    private readonly chateauMaxHp: number,
    private readonly monsterCatalog: readonly MonsterType[] = MONSTER_TYPES,
    private readonly towerCatalog: readonly TowerType[] = TOWER_TYPES,
    private readonly ticksBetweenSpawns: number = DEFAULT_TICKS_BETWEEN_SPAWNS,
    private readonly mode: SimulationMode = 'defense',
  ) {
    this.lanes = wave.lanes.map((lane) => {
      const geometry = buildPathGeometry(lane.path);
      return {
        path: lane.path,
        geometry,
        pathTotalLength: geometry.totalLength,
        spawnQueue: lane.units.map((unit) => unit.type),
        spawnProgress: 0,
      };
    });
    this.monsterTypesById = new Map(monsterCatalog.map((type) => [type.id, type]));
    this.towerTypesById = new Map(towerCatalog.map((type) => [type.id, type]));
    this.towerStates = towers.flatMap((tower) => {
      const type = this.towerTypesById.get(tower.typeId);
      return type ? [{ tower, type, worldPosition: hexToWorld(tower.position) }] : [];
    });
    this.chateauHp = chateauMaxHp;
    for (const tower of towers) {
      this.towerCooldowns.set(tower.id, 0);
    }
  }

  getOutcome(): DefenseOutcome {
    return this.outcome;
  }

  getTick(): number {
    return this.tick;
  }

  getChateauHp(): number {
    return this.chateauHp;
  }

  /**
   * Nombre de monstres ayant atteint le château jusqu'ici — statistique d'affichage : une brèche
   * n'entraîne plus à elle seule la victoire en attaque, il faut détruire le château (voir
   * `resolveOutcome`).
   */
  getBreachCount(): number {
    return this.breachCount;
  }

  /**
   * Dégâts totaux infligés aux monstres jusqu'ici, tours confondues (dégâts bruts appliqués dans
   * `applyDamage`, y compris le surplus d'une frappe qui achève un monstre déjà proche de la mort) —
   * utilisé par `phaseScore` pour départager des épreuves à égalité sur leur seul critère principal
   * (vie du château, ou étalement une fois la phase réussie).
   */
  getTotalDamageDealt(): number {
    return this.totalDamageDealt;
  }

  getMonsters(): readonly MonsterInstance[] {
    return this.monsters;
  }

  /**
   * Position world-space d'un monstre le long de sa voie. Mémorisée jusqu'au prochain déplacement
   * (`moveMonsters` vide le cache) : la position d'un monstre est demandée une fois par tour et par
   * tick lors du ciblage, plus une fois par affichage, alors qu'elle ne change qu'entre deux ticks.
   * Renvoie une copie, jamais l'entrée du cache elle-même — l'appelant reste libre de la conserver
   * ou de la modifier, comme avec un calcul à chaque appel.
   */
  getMonsterPosition(monster: MonsterInstance): GridCoord {
    const position = this.cachedPosition(monster);
    return { x: position.x, y: position.y };
  }

  /** Position mémorisée d'un monstre, calculée à la demande — usage interne : ne pas modifier l'objet renvoyé. */
  private cachedPosition(monster: MonsterInstance): GridCoord {
    const cached = this.positionCache.get(monster.id);
    if (cached) {
      return cached;
    }
    const position = pointAtDistanceOn(this.lanes[monster.laneIndex].geometry, monster.distance);
    this.positionCache.set(monster.id, position);
    return position;
  }

  /** Tirs (tour → cible) survenus lors du dernier `step()`, pour l'affichage des projectiles. */
  getShotsThisTick(): readonly ShotEvent[] {
    return this.shotsThisTick;
  }

  /**
   * Copie indépendante de l'état courant, pour prévisualiser un `step()` sans affecter la
   * simulation réelle — permet à l'affichage de faire partir un projectile en anticipation du tick
   * où il touchera réellement sa cible (voir `game-board.ts`), sans dupliquer la logique de tir.
   */
  clone(): DefenseSimulation {
    const copy = Object.create(DefenseSimulation.prototype) as DefenseSimulation;
    Object.assign(copy, {
      tick: this.tick,
      chateauHp: this.chateauHp,
      monsters: this.monsters.map((monster) => ({ ...monster })),
      lanes: this.lanes.map((lane) => ({ ...lane, spawnQueue: [...lane.spawnQueue] })),
      towerCooldowns: new Map(this.towerCooldowns),
      outcome: this.outcome,
      monsterSequence: this.monsterSequence,
      shotsThisTick: [...this.shotsThisTick],
      breachCount: this.breachCount,
      totalDamageDealt: this.totalDamageDealt,
      towers: this.towers,
      chateauMaxHp: this.chateauMaxHp,
      monsterCatalog: this.monsterCatalog,
      towerCatalog: this.towerCatalog,
      ticksBetweenSpawns: this.ticksBetweenSpawns,
      mode: this.mode,
      // Précalculs immuables (tours résolues, catalogues indexés) : partagés avec l'original plutôt
      // que reconstruits. Le cache de positions, lui, suit l'état et doit être dupliqué.
      towerStates: this.towerStates,
      monsterTypesById: this.monsterTypesById,
      towerTypesById: this.towerTypesById,
      positionCache: new Map(this.positionCache),
    });
    return copy;
  }

  /** Avance la simulation d'un tick. Retourne false si l'épreuve est terminée. */
  step(): boolean {
    if (this.outcome !== 'pending') {
      return false;
    }
    this.tick++;
    this.shotsThisTick = [];
    this.spawn();
    this.regenerate();
    this.fireTowers();
    this.moveMonsters();
    this.resolveOutcome();
    return this.outcome === 'pending';
  }

  /** Exécute la simulation jusqu'à son terme (utilitaire pour tests / rejoue instantanée). */
  runToCompletion(maxTicks: number = DEFAULT_MAX_TICKS): DefenseOutcome {
    let guard = 0;
    while (this.step() && guard < maxTicks) {
      guard++;
    }
    if (this.outcome === 'pending') {
      throw new Error('Defense simulation did not converge within maxTicks');
    }
    return this.outcome;
  }

  /** Régénération passive (ex. Nécrophage) : plafonnée aux PV max du type, appliquée avant les tirs du tick. */
  private regenerate(): void {
    for (const monster of this.monsters) {
      const type = this.monsterTypesById.get(monster.typeId);
      if (type?.regenPerTick) {
        monster.hp = Math.min(type.hp, monster.hp + type.regenPerTick);
      }
    }
  }

  /**
   * Fait spawn le prochain monstre de chaque voie une fois sa progression accumulée : chaque tick
   * ajoute la vitesse du monstre en tête de file (aucun arrondi, contrairement à `moveMonsters()`
   * qui accumule déjà `distance` de la même façon sans le quantifier). Une unité deux fois plus
   * rapide que la référence (`SPAWN_GAP_REFERENCE_SPEED`) spawn donc deux fois plus dense (effet de
   * masse), une unité deux fois plus lente spawn deux fois plus espacée — de façon continue, pas
   * bornée aux multiples entiers de tick.
   */
  private spawn(): void {
    const spawnThreshold = this.ticksBetweenSpawns * SPAWN_GAP_REFERENCE_SPEED;
    for (let laneIndex = 0; laneIndex < this.lanes.length; laneIndex++) {
      const lane = this.lanes[laneIndex];
      if (lane.spawnQueue.length === 0) {
        continue;
      }
      const nextType = this.monsterTypesById.get(lane.spawnQueue[0]);
      lane.spawnProgress +=
        nextType && nextType.speed > 0 ? nextType.speed : SPAWN_GAP_REFERENCE_SPEED;
      if (lane.spawnProgress < spawnThreshold) {
        continue;
      }
      lane.spawnProgress -= spawnThreshold;
      const typeId = lane.spawnQueue.shift();
      const type = typeId ? this.monsterTypesById.get(typeId) : undefined;
      if (!type) {
        continue;
      }
      this.monsters.push({
        id: `monster-${this.monsterSequence++}`,
        typeId: type.id,
        hp: type.hp,
        distance: 0,
        laneIndex,
        slowMultiplier: 1,
        slowUntilTick: 0,
      });
    }
  }

  /**
   * Cible d'une tour parmi les monstres présents : le plus avancé à portée, le premier rencontré à
   * égalité — mêmes règles que `selectTarget`, dont c'est le pendant interne. Lit directement
   * `this.monsters` et le cache de positions au lieu de recevoir une liste de candidats : appelée
   * pour chaque tour à chaque tick, elle n'alloue ainsi rien du tout, là où monter un tableau de
   * candidats (et son index par id) coûtait des milliers d'objets par simulation.
   */
  private pickTarget(worldPosition: GridCoord, range: number): MonsterInstance | undefined {
    const rangeSquared = range * range;
    let best: MonsterInstance | undefined;
    for (const monster of this.monsters) {
      const position = this.cachedPosition(monster);
      const dx = position.x - worldPosition.x;
      const dy = position.y - worldPosition.y;
      if (dx * dx + dy * dy > rangeSquared) {
        continue;
      }
      if (!best || monster.distance > best.distance) {
        best = monster;
      }
    }
    return best;
  }

  /**
   * Fait tirer chaque tour prête. Ni les positions ni la composition de `this.monsters` ne bougent
   * pendant cette passe — les déplacements ont lieu dans `moveMonsters`, les morts ne sont résolues
   * qu'à la fin — ce qui permet à `pickTarget` de lire l'état courant directement, sans photo
   * intermédiaire. Un monstre déjà tombé à 0 PV pendant la passe reste ciblable par les tours
   * suivantes du même tick, comme auparavant : le surplus compte dans `totalDamageDealt`.
   */
  private fireTowers(): void {
    for (const { tower, type: towerType, worldPosition } of this.towerStates) {
      const cooldown = this.towerCooldowns.get(tower.id) ?? 0;
      if (cooldown > 0) {
        this.towerCooldowns.set(tower.id, cooldown - 1);
        continue;
      }
      const target = this.pickTarget(worldPosition, towerType.range);
      if (!target) {
        continue;
      }
      const targetPos = this.cachedPosition(target);
      this.shotsThisTick.push({
        towerPosition: tower.position,
        targetPosition: { x: targetPos.x, y: targetPos.y },
        splashRadius: towerType.splashRadius,
      });
      this.applyDamage(target, towerType);
      if (towerType.splashRadius) {
        const splashSquared = towerType.splashRadius * towerType.splashRadius;
        for (const monster of this.monsters) {
          if (monster.id === target.id) {
            continue;
          }
          const pos = this.cachedPosition(monster);
          const dx = pos.x - targetPos.x;
          const dy = pos.y - targetPos.y;
          if (dx * dx + dy * dy <= splashSquared) {
            this.applyDamage(monster, towerType);
          }
        }
      }
      this.towerCooldowns.set(tower.id, towerType.cooldown);
    }
    this.resolveDeaths();
  }

  /** Retire les monstres achevés ce tick ; ceux à scission (ex. Gelée) sont remplacés par leur progéniture. */
  private resolveDeaths(): void {
    const survivors: MonsterInstance[] = [];
    const spawned: MonsterInstance[] = [];
    for (const monster of this.monsters) {
      if (monster.hp > 0) {
        survivors.push(monster);
        continue;
      }
      const type = this.monsterTypesById.get(monster.typeId);
      const childType = type?.splitOnDeath
        ? this.monsterTypesById.get(type.splitOnDeath.typeId)
        : undefined;
      if (type?.splitOnDeath && childType) {
        for (let i = 0; i < type.splitOnDeath.count; i++) {
          spawned.push({
            id: `monster-${this.monsterSequence++}`,
            typeId: childType.id,
            hp: childType.hp,
            distance: monster.distance,
            laneIndex: monster.laneIndex,
            slowMultiplier: 1,
            slowUntilTick: 0,
          });
        }
      }
    }
    this.monsters = [...survivors, ...spawned];
  }

  private applyDamage(monster: MonsterInstance, towerType: TowerType): void {
    const monsterType = this.monsterTypesById.get(monster.typeId);
    const armorMultiplier = towerType.armorBonus && monsterType?.armored ? towerType.armorBonus : 1;
    const damage = towerType.damage * armorMultiplier;
    monster.hp -= damage;
    this.totalDamageDealt += damage;
    if (towerType.slowFactor && towerType.slowDuration) {
      const resistance = monsterType?.slowResistance ?? 0;
      monster.slowMultiplier = Math.min(
        1,
        towerType.slowFactor + (1 - towerType.slowFactor) * resistance,
      );
      monster.slowUntilTick = this.tick + towerType.slowDuration;
    }
  }

  private moveMonsters(): void {
    for (const monster of this.monsters) {
      const type = this.monsterTypesById.get(monster.typeId);
      if (!type) {
        continue;
      }
      const multiplier = this.tick <= monster.slowUntilTick ? monster.slowMultiplier : 1;
      monster.distance += type.speed * multiplier;
    }

    const remaining: MonsterInstance[] = [];
    for (const monster of this.monsters) {
      if (monster.distance < this.lanes[monster.laneIndex].pathTotalLength) {
        remaining.push(monster);
        continue;
      }
      this.breachCount++;
      this.chateauHp -= this.monsterTypesById.get(monster.typeId)?.chateauDamage ?? 0;
    }
    this.monsters = remaining;

    // Seul endroit où une distance parcourue change : les positions mémorisées deviennent caduques.
    this.positionCache.clear();
  }

  private resolveOutcome(): void {
    const allLanesSpawned = this.lanes.every((lane) => lane.spawnQueue.length === 0);

    if (this.mode === 'attack') {
      if (this.chateauHp <= 0) {
        this.outcome = 'success';
        return;
      }
      if (allLanesSpawned && this.monsters.length === 0) {
        this.outcome = 'failure';
      }
      return;
    }

    if (!allLanesSpawned || this.monsters.length > 0) {
      return;
    }
    this.outcome = this.chateauHp >= this.chateauMaxHp ? 'success' : 'failure';
  }
}

/**
 * Décalage utilisé par `phaseScore` pour garantir qu'un score de succès (fonction du mérite propre à
 * chaque camp, voir `attackerRoutingCost` et `routeExposure`) reste toujours mieux classé qu'un
 * score d'échec (vie du château restante, bornée par `chateauMaxHp`) — bien plus grand que n'importe
 * quel mérite atteignable sur une grille et une vie de château réalistes du jeu.
 *
 * A remplacé une mesure d'« étalement » (`spreadScore`), qui départageait les deux camps par le seul
 * nombre de cases occupées près du château. Ce n'était qu'un proxy : côté attaque, il récompensait
 * l'allongement des tracés au détriment du budget des monstres ; côté défense, il récompensait toute
 * tour posée près du château, qu'elle barre réellement un passage ou non, et ne voyait pas du tout la
 * couverture par le feu. Les deux camps notent désormais directement ce qu'ils cherchent.
 */
const SPREAD_SCORE_BASE = 1_000_000;

/**
 * Exposition d'une vague au feu que l'adversaire pourrait installer au palier suivant : celle de sa
 * **voie la moins exposée**. L'exposition d'une voie est la somme, sur ses cases distinctes, du
 * nombre d'emplacements de tour encore disponibles (`buildableCells`) d'où une tour la couvrirait,
 * portée maximale du catalogue faisant foi. Plus c'est bas, meilleure est la vague.
 *
 * C'est ce qui définit une bonne route, une fois la forteresse tombée : une route qui longe un
 * bord, rase une rivière ou se colle à un chemin existant traverse des zones où l'adversaire n'a
 * presque nulle part où bâtir, et ses monstres y passeront sous un feu bien plus faible au palier
 * suivant.
 *
 * Le **minimum** sur les voies, et non leur total : il suffit à l'attaquant d'un seul bon couloir
 * pour faire passer ses monstres. Un total punissait chaque voie supplémentaire et chaque case de
 * tracé, si bien que son optimum absolu était une voie unique au plus court chemin — exactement la
 * vague qui laisse la défense fortifier tranquillement la couronne du château, seul point de
 * passage commun à toutes les routes. Avec le minimum, ouvrir une voie de plus ne peut jamais
 * dégrader la vague ; seul son coût en cases de chemin (`waveCost`) la retient, ce qui est le bon
 * arbitrage.
 *
 * Les cases de la vague — **toutes voies confondues** — sont exclues des emplacements disponibles :
 * une fois la vague passée, ses tracés deviennent des chemins persistants
 * (`GameEngine.resolveAttackSuccess`) et plus aucune tour ne peut s'y poser. C'est le terrain que
 * l'attaquant gagne, et les voies s'en protègent mutuellement : une voie parallèle à une autre
 * retire à sa voisine des emplacements de tour, donc abaisse son exposition.
 *
 * Les tours déjà posées (forteresse persistante) occupent des cases : elles ne sont plus des
 * emplacements *nouveaux*, mais leur feu compte déjà. Passer `existingTowers` pour en tenir compte.
 */
export function routeExposure(
  map: GameMap,
  wave: Wave,
  towerCatalog: readonly TowerType[] = TOWER_TYPES,
  existingTowers: readonly TowerInstance[] = [],
): number {
  const range = towerCatalog.reduce((max, type) => Math.max(max, type.range), 0);
  if (range <= 0 || wave.lanes.length === 0) {
    return 0;
  }
  const buildable = buildableCells(map, existingTowers);
  const typeById = new Map(towerCatalog.map((type) => [type.id, type]));

  const laneCells = wave.lanes.map((lane) => expandPathCells(lane.path));
  const takenByWave = new Set<string>();
  for (const cells of laneCells) {
    for (const cell of cells) {
      takenByWave.add(`${cell.x},${cell.y}`);
    }
  }

  let best = Number.POSITIVE_INFINITY;
  for (const cells of laneCells) {
    const counted = new Set<string>();
    let exposure = 0;
    for (const cell of cells) {
      if (counted.has(`${cell.x},${cell.y}`)) {
        continue;
      }
      counted.add(`${cell.x},${cell.y}`);
      for (const tower of existingTowers) {
        const type = typeById.get(tower.typeId);
        if (type && hexDistance(tower.position, cell) <= type.range) {
          exposure++;
        }
      }
      // Fenêtre bornée à la grille : une portée démesurée ne doit pas faire balayer le vide.
      const minX = Math.max(0, cell.x - range);
      const maxX = Math.min(map.grid.cols - 1, cell.x + range);
      const minY = Math.max(0, cell.y - range);
      const maxY = Math.min(map.grid.rows - 1, cell.y + range);
      for (let x = minX; x <= maxX; x++) {
        for (let y = minY; y <= maxY; y++) {
          const key = `${x},${y}`;
          if (takenByWave.has(key) || !buildable.has(key)) {
            continue;
          }
          if (hexDistance({ x, y }, cell) <= range) {
            exposure++;
          }
        }
      }
    }
    best = Math.min(best, exposure);
  }
  return best === Number.POSITIVE_INFINITY ? 0 : best;
}

/**
 * Surcoût, pour l'attaquant, d'une case de route couverte par une tour de plus : une case sous le
 * feu d'une tour lui coûte comme deux cases de détour, sous le feu de deux tours comme trois. C'est
 * le taux de change entre les deux moitiés de « routes rapides **et** hors de portée » — le monter
 * pousse la défense à couvrir large, le baisser à barrer court.
 *
 * Le décompte est en **nombre de tours** couvrant la case, pas en dégâts par tick : c'est la lecture
 * littérale de « hors de portée », et elle ne dépend pas de l'équilibrage du catalogue. Pondérer par
 * le débit de chaque tour serait plus fin, mais rendrait le ralentissement de la tour Glace — dont
 * tout l'intérêt est d'allonger le temps d'exposition, pas d'infliger des dégâts — structurellement
 * sous-évalué.
 */
const COVERED_CELL_PENALTY = 1;

/**
 * Coût conventionnel renvoyé par `attackerRoutingCost` quand plus aucune case de bord ne relie le
 * château : l'attaquant ne peut alors tracer aucune route et perd la phase d'office. Fini plutôt
 * qu'infini pour que le score reste comparable, et largement en dessous de `SPREAD_SCORE_BASE` pour
 * qu'un succès reste un succès.
 */
const UNREACHABLE_ROUTE_COST = 1_000;

/**
 * Poids, dans le mérite d'une défense réussie, d'un point de coût imposé à la meilleure route de
 * l'attaquant (`attackerRoutingCost`) : forcer un détour d'une case, ou couvrir d'une tour de plus
 * une case qu'il devra traverser, vaut 100 points. Calé sur `RESOLUTION_SPEED_WEIGHT`, si bien que la
 * rapidité de résolution départage deux forteresses qui étranglent l'attaquant aussi bien, sans
 * jamais pouvoir renverser un point de coût gagné sur sa meilleure route.
 */
const CHOKE_WEIGHT = 100;

/**
 * Ce que coûte à l'attaquant, contre cette forteresse, l'acheminement de ses monstres jusqu'au
 * château. Pour chaque case de bord — chacune un spawn possible — le plus court chemin jusqu'au
 * château (Dijkstra depuis celui-ci), où traverser une case coûte son prix de case de chemin
 * (`PATH_CELL_COST`, ce que l'attaquant paie réellement sur son budget) plus `COVERED_CELL_PENALTY`
 * par tour dont la portée la couvre. Rivières et cases occupées par une tour sont infranchissables,
 * exactement comme pour `shortestPath` — et comme lui, une case de bord infranchissable (sous une
 * rivière) reste utilisable comme **départ**, jamais comme case de passage.
 *
 * C'est ce qui définit une bonne forteresse, une fois la vague tenue : celle dont la disposition
 * **empêche de composer une bonne vague au palier suivant**. Une bonne vague veut des routes rapides
 * (courtes) et hors de portée (peu couvertes) — les deux moitiés exactes du coût mesuré ici. Plus il
 * est haut, moins l'attaquant a de bonnes routes à sa disposition : la défense cherche donc à le
 * **maximiser**, là où l'attaque cherche à minimiser `routeExposure`. Les deux camps notent ainsi la
 * même partie depuis leur côté du plateau.
 *
 * Le **minimum** sur les départs possibles, comme `routeExposure` prend le minimum sur les voies : il
 * suffit à l'attaquant d'**une seule** route rapide et hors de portée, c'est donc celle-là que la
 * défense doit rendre chère. Un spawn dont le château est devenu injoignable sort du calcul.
 *
 * La forteresse est prise telle qu'elle est posée (contrairement à `routeExposure`, qui raisonne sur
 * les emplacements *potentiels*) : c'est bien elle que l'attaque affrontera, la phase Attaque se
 * jouant contre la forteresse figée du même palier. Empêcher l'attaquant de tracer une route non
 * exposée, c'est donc exactement ça : qu'aucun couloir ne soit à la fois court et libre de tout feu.
 */
export function attackerRoutingCost(
  map: GameMap,
  towers: readonly TowerInstance[],
  towerCatalog: readonly TowerType[] = TOWER_TYPES,
): number {
  return routingCosts(map, towers, towerCatalog).best;
}

/**
 * Coût d'acheminement de l'attaquant sous ses deux formes : `best`, le minimum sur les départs
 * possibles — la valeur qui compte, voir `attackerRoutingCost` — et `harmonic`, la moyenne harmonique
 * de tous les départs.
 *
 * `harmonic` ne sert qu'à **départager** deux forteresses qui laissent la même meilleure route (voir
 * `phaseScore`), jamais à définir l'objectif. Sans elle la recherche serait aveugle une bonne partie
 * du temps : sur une carte ouverte, quatre directions offrent des routes de coût identique, si bien
 * que couvrir l'une d'elles ne change *rien* au minimum — une tour de plus n'aurait alors aucun effet
 * sur le score jusqu'à ce que, par chance, toutes les approches soient couvertes à la fois. Dominée
 * par les routes les moins chères, elle mesure ce qui reste d'offre de bonnes routes une fois la
 * meilleure égalisée, et fait donc progresser la recherche vers la forteresse qui les assèche toutes.
 */
function routingCosts(
  map: GameMap,
  towers: readonly TowerInstance[],
  towerCatalog: readonly TowerType[] = TOWER_TYPES,
): { best: number; harmonic: number } {
  const { cols, rows } = map.grid;
  const size = cols * rows;
  const rivers = riverCells(map);
  const occupied = towerCells(towers);

  // Coût d'entrée de chaque case, `Infinity` pour les infranchissables. Indexé à plat plutôt que par
  // clé de chaîne : cette fonction est appelée une fois par forteresse candidate, soit des milliers
  // de fois par recherche.
  const enterCost = new Float64Array(size);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const key = cellKey({ x, y });
      enterCost[y * cols + x] =
        rivers.has(key) || occupied.has(key) ? Number.POSITIVE_INFINITY : PATH_CELL_COST;
    }
  }
  // `riverCells` exclut déjà le château, mais une tour n'y est de toute façon jamais posée : la case
  // du château reste franchissable, c'est l'arrivée de toute route.
  enterCost[map.chateau.y * cols + map.chateau.x] = PATH_CELL_COST;

  const typeById = new Map(towerCatalog.map((type) => [type.id, type]));
  for (const tower of towers) {
    const type = typeById.get(tower.typeId);
    if (!type) {
      continue;
    }
    const minX = Math.max(0, tower.position.x - type.range);
    const maxX = Math.min(cols - 1, tower.position.x + type.range);
    const minY = Math.max(0, tower.position.y - type.range);
    const maxY = Math.min(rows - 1, tower.position.y + type.range);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (hexDistance({ x, y }, tower.position) <= type.range) {
          enterCost[y * cols + x] += COVERED_CELL_PENALTY;
        }
      }
    }
  }

  const distance = dijkstraFromChateau(map, enterCost);

  // Minimum sur les départs, et moyenne harmonique de tous (somme des inverses sur les spawns encore
  // reliés, divisée par le nombre total de spawns possibles — un spawn muré ne contribue rien, ce qui
  // fait monter la moyenne).
  let best = Number.POSITIVE_INFINITY;
  let spawnCount = 0;
  let inverseSum = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!isBorderCell(map, { x, y }) || isChateauCell(map, { x, y })) {
        continue;
      }
      spawnCount++;
      const index = y * cols + x;
      let cost = distance[index];
      if (!Number.isFinite(enterCost[index])) {
        // Case de bord infranchissable : utilisable comme spawn, la route démarre chez un voisin.
        cost = Number.POSITIVE_INFINITY;
        for (const neighbor of hexNeighbors({ x, y })) {
          if (!isWithinGrid(map, neighbor)) {
            continue;
          }
          const neighborDistance = distance[neighbor.y * cols + neighbor.x];
          if (Number.isFinite(neighborDistance)) {
            cost = Math.min(cost, neighborDistance + PATH_CELL_COST);
          }
        }
      }
      if (Number.isFinite(cost) && cost > 0) {
        inverseSum += 1 / cost;
        best = Math.min(best, cost);
      }
    }
  }
  return inverseSum > 0
    ? { best, harmonic: spawnCount / inverseSum }
    : { best: UNREACHABLE_ROUTE_COST, harmonic: UNREACHABLE_ROUTE_COST };
}

/**
 * Distances minimales du château à chaque case, `enterCost` faisant foi pour le prix d'entrée d'une
 * case (`Infinity` = infranchissable, jamais développée). Dijkstra à tas binaire plutôt qu'un simple
 * BFS : les coûts d'entrée ne sont pas uniformes, une case couverte par trois tours coûtant quatre
 * fois une case libre.
 */
function dijkstraFromChateau(map: GameMap, enterCost: Float64Array): Float64Array {
  const { cols, rows } = map.grid;
  const distance = new Float64Array(cols * rows).fill(Number.POSITIVE_INFINITY);
  const start = map.chateau.y * cols + map.chateau.x;
  // Le château n'est pas facturé : un monstre qui atteint sa case n'est plus vulnérable. `step()` tire
  // (`fireTowers`) avant de déplacer (`moveMonsters`), et `moveMonsters` retire le monstre dès que sa
  // distance atteint la longueur totale de la voie — le centre de la case du château. Aucune passe de
  // tir ne le voit donc jamais dessus : couvrir cette case ne rapporte rien à la défense, seule
  // l'approche compte, et ce sont les cases précédentes qui la portent.
  distance[start] = 0;

  // Tas binaire (index de case, distance) en tableaux parallèles.
  const heapNode: number[] = [start];
  const heapDistance: number[] = [0];

  const swap = (i: number, j: number): void => {
    [heapNode[i], heapNode[j]] = [heapNode[j], heapNode[i]];
    [heapDistance[i], heapDistance[j]] = [heapDistance[j], heapDistance[i]];
  };

  const push = (node: number, nodeDistance: number): void => {
    heapNode.push(node);
    heapDistance.push(nodeDistance);
    let i = heapNode.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heapDistance[parent] <= heapDistance[i]) {
        break;
      }
      swap(parent, i);
      i = parent;
    }
  };

  const pop = (): number => {
    const top = heapNode[0];
    const lastNode = heapNode.pop()!;
    const lastDistance = heapDistance.pop()!;
    if (heapNode.length > 0) {
      heapNode[0] = lastNode;
      heapDistance[0] = lastDistance;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < heapNode.length && heapDistance[left] < heapDistance[smallest]) {
          smallest = left;
        }
        if (right < heapNode.length && heapDistance[right] < heapDistance[smallest]) {
          smallest = right;
        }
        if (smallest === i) {
          break;
        }
        swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  };

  while (heapNode.length > 0) {
    const currentDistance = heapDistance[0];
    const current = pop();
    // Entrée périmée : cette case a déjà été atteinte moins cher depuis.
    if (currentDistance > distance[current]) {
      continue;
    }
    const x = current % cols;
    const y = (current - x) / cols;
    for (const neighbor of hexNeighbors({ x, y })) {
      if (!isWithinGrid(map, neighbor)) {
        continue;
      }
      const index = neighbor.y * cols + neighbor.x;
      const step = enterCost[index];
      if (!Number.isFinite(step)) {
        continue;
      }
      const candidate = currentDistance + step;
      if (candidate < distance[index]) {
        distance[index] = candidate;
        push(index, candidate);
      }
    }
  }
  return distance;
}

/**
 * Poids maximal du critère de rapidité (`resolutionSpeedScore`) dans le mérite d'une défense
 * réussie : calé sur `CHOKE_WEIGHT`, de sorte que la rapidité départage deux forteresses qui
 * étranglent l'attaquant aussi bien, sans jamais pouvoir renverser un point de coût gagné sur sa
 * meilleure route (`attackerRoutingCost`).
 */
const RESOLUTION_SPEED_WEIGHT = 100;

/**
 * Durée (en ticks) autour de laquelle le critère de rapidité est le plus discriminant : à
 * `RESOLUTION_SPEED_REFERENCE` ticks il vaut la moitié de son maximum. Calé sur l'ordre de grandeur
 * d'une épreuve réelle (quelques centaines de ticks).
 */
const RESOLUTION_SPEED_REFERENCE = 200;

/**
 * Rapidité avec laquelle une phase réussie a été emportée, dans `]0, RESOLUTION_SPEED_WEIGHT]` :
 * décroît doucement avec le nombre de ticks, sans jamais s'annuler ni exiger de borne supérieure
 * sur la durée d'une épreuve.
 *
 * C'est le seul terme du régime succès que la **composition** de la vague pilote vraiment, et c'est
 * là sa raison d'être : à tracés identiques, deux vagues qui détruisent toutes les deux le château
 * n'étaient jusqu'ici départagées que par `damageBonus`, borné à 1 point face à un étalement qui se
 * compte en centaines — autant dire pas départagées du tout. Or la vitesse de résolution dépend
 * directement des monstres choisis face à cette forteresse-là : ceux qui survivent aux tours
 * arrivent au château, ceux qui frappent fort en font tomber les PV plus vite. C'est donc le signal
 * qui permet enfin à la recherche de découvrir les contres du catalogue.
 *
 * Vaut pour les deux camps : l'attaque veut détruire vite, la défense veut nettoyer la vague vite
 * (elle garde ainsi de la marge). Contrairement à `damageBonus`, ce terme est donc *signé* selon le
 * mode — voir `phaseScore`.
 */
function resolutionSpeedScore(ticks: number): number {
  return (
    (RESOLUTION_SPEED_WEIGHT * RESOLUTION_SPEED_REFERENCE) / (RESOLUTION_SPEED_REFERENCE + ticks)
  );
}

/**
 * Vie cumulée des monstres composant `wave` (files de spawn initiales, sans compter les unités
 * générées en cours de route par scission — `splitOnDeath`) : plafond utilisé par `phaseScore`
 * pour normaliser les dégâts infligés aux monstres en une fraction de `[0, 1]`.
 */
function totalMonsterHp(wave: Wave, monsterCatalog: readonly MonsterType[]): number {
  return wave.lanes.reduce(
    (total, lane) =>
      total +
      lane.units.reduce((laneTotal, unit) => {
        const type = monsterCatalog.find((candidate) => candidate.id === unit.type);
        return laneTotal + (type?.hp ?? 0);
      }, 0),
    0,
  );
}

/** Résultat figé d'une simulation, pour pouvoir le renvoyer depuis un cache sans instance vivante. */
export interface SimulationSnapshot {
  outcome: 'success' | 'failure';
  breachCount: number;
  chateauHp: number;
  tick: number;
  totalDamageDealt: number;
}

/**
 * Cache de résultats de simulation, clé par l'état CONCRET (tours, vague, PV château, mode) —
 * jamais par la décision de l'IA qui l'a produit (non-déterministe d'un run à l'autre, cf.
 * `knownScores` dans `ia-attack-player.ts`/`ia-defense-player.ts`, qui ne couvre que les doublons
 * PAR IDENTITÉ D'OBJET au sein d'une même recherche, pas les répétitions de CONTENU entre deux
 * recherches distinctes). Valide : `DefenseSimulation` est une fonction pure de ces 4 valeurs (pas
 * de hasard, pas de lecture de `map` — chaque voie porte son propre tracé) TANT QUE le catalogue
 * tours/monstres et `ticksBetweenSpawns` ne changent pas pendant la vie du cache : à l'appelant de
 * le garantir (ex. un cache par process, jamais réutilisé après un changement de catalogue).
 *
 * L'ordre des tours et des voies n'entre PAS dans la clé (triés avant hachage) : vérifié dans
 * `fireTowers`/`spawn` que ni l'un ni l'autre n'affecte le résultat — `pickTarget` ne regarde que
 * la géométrie figée (distance/portée), jamais les PV (un monstre déjà à 0 PV pendant la passe
 * reste ciblable, le surplus compte dans `totalDamageDealt` — voir la note sur `fireTowers`), et
 * chaque voie a sa propre file de spawn indépendante des autres. Seul l'ordre des UNITÉS AU SEIN
 * D'UNE MÊME VOIE reste dans la clé (relevant si leurs types diffèrent en vitesse) ; compressé par
 * plages de même type (`rat×23` plutôt que `rat,rat,...,rat`) — sans perte, juste plus court à
 * construire.
 */
export type SimulationCache = Map<string, SimulationSnapshot>;

function towersCacheKey(towers: readonly TowerInstance[]): string {
  return towers
    .map((tower) => `${tower.typeId}@${tower.position.x},${tower.position.y}#${tower.level}`)
    .sort()
    .join(';');
}

/** Compresse les unités consécutives de même type (`rat×23`) — préserve l'ordre entre types différents. */
function runLengthEncodeUnits(units: readonly { type: string }[]): string {
  const runs: { type: string; count: number }[] = [];
  for (const unit of units) {
    const last = runs[runs.length - 1];
    if (last && last.type === unit.type) {
      last.count++;
    } else {
      runs.push({ type: unit.type, count: 1 });
    }
  }
  return runs.map((run) => `${run.type}×${run.count}`).join(',');
}

function waveCacheKey(wave: Wave): string {
  return wave.lanes
    .map(
      (lane) => `${lane.path.nodes.map(([x, y]) => `${x},${y}`).join('-')}=${runLengthEncodeUnits(lane.units)}`,
    )
    .sort()
    .join('|');
}

/** Clé de cache pour un état de simulation — voir `SimulationCache`. */
export function simulationCacheKey(
  towers: readonly TowerInstance[],
  wave: Wave,
  chateauMaxHp: number,
  mode: SimulationMode,
): string {
  return `${mode}::${chateauMaxHp}::${towersCacheKey(towers)}::${waveCacheKey(wave)}`;
}

export interface SimulationCacheStats {
  hits: number;
  misses: number;
}

/**
 * Compteurs hits/misses par cache, à côté (jamais dans) `SimulationCache` : ce dernier reste un
 * `Map` ordinaire, tel qu'utilisé directement (`.get`/`.set`/`.clear`/`.size`) par `BoardEngineService`
 * — ajouter des champs dessus aurait changé son type pour tous les appelants existants. `WeakMap` :
 * les compteurs disparaissent avec le cache, jamais de fuite.
 */
const cacheStats = new WeakMap<SimulationCache, SimulationCacheStats>();

function statsFor(cache: SimulationCache): SimulationCacheStats {
  let stats = cacheStats.get(cache);
  if (!stats) {
    stats = { hits: 0, misses: 0 };
    cacheStats.set(cache, stats);
  }
  return stats;
}

/** Copie défensive des compteurs d'un cache — 0/0 si `runCachedSimulation` n'a encore jamais été appelée avec. */
export function getSimulationCacheStats(cache: SimulationCache): SimulationCacheStats {
  return { ...statsFor(cache) };
}

/** Taux de hits dans `[0, 1]`, ou `undefined` si le cache n'a encore servi à aucun lookup. */
export function simulationCacheHitRate(cache: SimulationCache): number | undefined {
  const { hits, misses } = getSimulationCacheStats(cache);
  const total = hits + misses;
  return total > 0 ? hits / total : undefined;
}

/**
 * Sert le cache s'il y a une entrée, sinon construit/joue une simulation fraîche et mémorise son
 * résultat. Ne rattrape PAS la non-convergence de `runToCompletion` (`maxTicks` dépassé) — elle se
 * propage tel quel, comme avant l'introduction du cache : c'est à l'appelant de décider s'il tolère
 * ce cas.
 */
export function runCachedSimulation(
  towers: readonly TowerInstance[],
  wave: Wave,
  chateauMaxHp: number,
  monsterCatalog: readonly MonsterType[] = MONSTER_TYPES,
  towerCatalog: readonly TowerType[] = TOWER_TYPES,
  mode: SimulationMode = 'defense',
  cache?: SimulationCache,
): SimulationSnapshot {
  // Ne construit la clé que si un cache est réellement fourni : en jeu réel (pas de cache), cette
  // fonction est appelée des centaines de fois par décision IA, pas question d'y ajouter le coût
  // d'un hachage jamais consulté.
  const key = cache && simulationCacheKey(towers, wave, chateauMaxHp, mode);
  if (key) {
    const hit = cache!.get(key);
    if (hit) {
      statsFor(cache!).hits++;
      return hit;
    }
    statsFor(cache!).misses++;
  }
  const trial = new DefenseSimulation(towers, wave, chateauMaxHp, monsterCatalog, towerCatalog, undefined, mode);
  trial.runToCompletion();
  const snapshot: SimulationSnapshot = {
    outcome: trial.getOutcome() === 'success' ? 'success' : 'failure',
    breachCount: trial.getBreachCount(),
    chateauHp: trial.getChateauHp(),
    tick: trial.getTick(),
    totalDamageDealt: trial.getTotalDamageDealt(),
  };
  if (key) {
    cache!.set(key, snapshot);
  }
  return snapshot;
}

/**
 * Score d'une épreuve (défense ou attaque), obtenu en rejouant l'épreuve jusqu'à son terme
 * (CONCEPTION.md §12 « Scoring »). Deux régimes distincts :
 * - Échec : vie du château restante à la fin de l'épreuve — en défense, le château a encaissé au
 *   moins un point de dégât sans que la victoire (aucun dégât) soit exigée, jusqu'à être détruit
 *   en cours de route (score alors très négatif, voir `resolveOutcome`) ; en attaque, le château a
 *   survécu sans être détruit (score alors strictement positif). Dans les deux cas, l'ampleur du
 *   score reste une information utile pour départager deux solutions qui échouent toutes les deux.
 * - Succès : deux solutions qui terminent toutes les deux la phase (château intact en défense,
 *   détruit en attaque) ne sont plus départagées par la vie du château restante, mais par un mérite
 *   propre à chaque camp — les deux rôles ne sont pas symétriques et n'ont pas la même définition
 *   du « mieux » :
 *   - **Attaque** : une bonne vague fait tomber la forteresse, et le fait par des routes **très peu
 *     exposées** aux tours que l'adversaire pourra bâtir au palier suivant (`routeExposure`, moins
 *     c'est mieux). Longer un bord, raser une rivière ou se coller à un chemin existant traverse
 *     des zones où la défense n'a presque nulle part où bâtir. Ce critère remplace l'étalement, qui
 *     récompensait toute case occupée, si lointaine et si inutile fût-elle, et poussait donc à
 *     rallonger les tracés au détriment du budget des monstres.
 *   - **Défense** : une bonne forteresse tient la vague, et sa disposition **empêche de composer une
 *     bonne vague au palier suivant** — elle rend cher à l'attaquant tout ce qu'il cherche, des
 *     routes rapides et hors de portée (`attackerRoutingCost`, plus c'est haut mieux c'est). C'est
 *     le miroir exact du critère de l'attaque. Ce critère remplace l'étalement, qui n'en était qu'un
 *     proxy grossier : il récompensait toute case occupée près du château, qu'elle barre réellement
 *     un passage ou non, et ne voyait pas du tout la couverture par le feu des tours. S'y ajoute la
 *     **rapidité de résolution** (`resolutionSpeedScore`) : nettoyer la vague tôt, c'est de la marge
 *     en plus.
 *
 *   `SPREAD_SCORE_BASE` assure dans les deux cas que ce score reste toujours strictement meilleur
 *   qu'un score d'échec.
 *
 * Dans les deux régimes, un bonus supplémentaire (`damageBonus`, dans `[0, 1]`) récompense les
 * dégâts infligés aux monstres pendant l'épreuve — sans jamais renverser un écart de vie de
 * château ou d'étalement, seulement départager les cas à égalité sur ce seul critère, qui sont
 * fréquents (beaucoup de forteresses différentes laissent passer exactement les mêmes monstres,
 * pour la même vie de château restante, sans que l'algorithme génétique n'ait alors la moindre
 * information pour distinguer la meilleure des deux). Il est toujours ajouté tel quel, jamais
 * inversé selon le mode : plus de dégâts infligés est toujours une meilleure défense (score plus
 * haut, favorisé par le tri décroissant de `fittestDefenses`) et toujours une moins bonne attaque
 * (score plus haut, défavorisé par le tri croissant de `fittestWaves`) — l'attaque cherche au
 * contraire les monstres qui traversent la défense sans dégât.
 */
export function phaseScore(
  towers: readonly TowerInstance[],
  wave: Wave,
  chateauMaxHp: number,
  map: GameMap,
  monsterCatalog: readonly MonsterType[] = MONSTER_TYPES,
  towerCatalog: readonly TowerType[] = TOWER_TYPES,
  mode: SimulationMode = 'defense',
  simulationCache?: SimulationCache,
): number {
  // `map` n'entre PAS dans le cache : seule la simulation brute (déterministe, indépendante de
  // `map`) est mémorisée. `routing`/`routeExposure` ci-dessous, qui dépendent de `map` (tracés déjà
  // persistés), sont recalculés à chaque appel comme avant — seul le calcul coûteux est évité.
  const snapshot = runCachedSimulation(
    towers,
    wave,
    chateauMaxHp,
    monsterCatalog,
    towerCatalog,
    mode,
    simulationCache,
  );

  const maxDamage = totalMonsterHp(wave, monsterCatalog);
  const damageBonus = maxDamage > 0 ? Math.min(1, snapshot.totalDamageDealt / maxDamage) : 0;

  if (snapshot.outcome === 'failure') {
    return snapshot.chateauHp + damageBonus;
  }
  if (mode === 'defense') {
    const routing = routingCosts(map, towers, towerCatalog);
    // Les coûts d'entrée étant entiers (`PATH_CELL_COST` + `COVERED_CELL_PENALTY` par tour), `best`
    // l'est aussi : un départage ramené dans `[0, 1[` ne peut jamais renverser un point gagné sur la
    // meilleure route de l'attaquant, seulement trancher entre deux forteresses qui la laissent
    // identique.
    const tieBreak = routing.harmonic / (1 + routing.harmonic);
    const merit = CHOKE_WEIGHT * (routing.best + tieBreak) + resolutionSpeedScore(snapshot.tick);
    return SPREAD_SCORE_BASE + merit + damageBonus;
  }
  // Attaque : le mérite est de s'exposer le moins possible, donc l'opposé de `routeExposure`. Tri
  // croissant côté attaque (`fittestWaves`), d'où la base négative : moins d'exposition, meilleur
  // score.
  return -(SPREAD_SCORE_BASE - routeExposure(map, wave, towerCatalog)) + damageBonus;
}
