import type { GridCoord, MapPath, MonsterType, TowerInstance, TowerType, Wave } from 'shared';
import { MONSTER_TYPES, TOWER_TYPES, hexDistance, hexToWorld } from 'shared';
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
   * Fait tirer chaque tour prête. Ni les positions ni la composition de `this.monsters` ne bougent
   * pendant cette passe (les déplacements ont lieu dans `moveMonsters`, les morts ne sont résolues
   * qu'à la fin) : la liste des cibles candidates et son index par id sont donc construits **une
   * seule fois pour toutes les tours**, au lieu d'être reconstruits par chaque tour comme le
   * faisait l'ancien `pickTarget` — un coût qui croissait en tours × monstres à chaque tick, et qui
   * dominait le temps de recherche des deux IA.
   *
   * Un monstre déjà tombé à 0 PV pendant la passe reste ciblable par les tours suivantes du même
   * tick, comme auparavant : le surplus compte dans `totalDamageDealt`.
   */
  private fireTowers(): void {
    const candidates: TargetCandidate[] = this.monsters.map((monster) => ({
      id: monster.id,
      distance: monster.distance,
      position: this.cachedPosition(monster),
    }));
    const monstersById = new Map(this.monsters.map((monster) => [monster.id, monster]));

    for (const { tower, type: towerType, worldPosition } of this.towerStates) {
      const cooldown = this.towerCooldowns.get(tower.id) ?? 0;
      if (cooldown > 0) {
        this.towerCooldowns.set(tower.id, cooldown - 1);
        continue;
      }
      const targetId = selectTarget(worldPosition, towerType.range, candidates);
      const target = targetId ? monstersById.get(targetId) : undefined;
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
 * Mesure d'« étalement » d'une solution — voir `phaseScore`, qui l'utilise pour départager deux
 * solutions réussissant toutes les deux la phase : somme, sur les cases distinctes occupées par
 * des tours ou par une voie de la vague (routes), d'un poids qui décroît avec la distance hex au
 * château (`1 / (1 + distance)`) — une case juste devant le château (`distance` 0 ou 1) compte
 * bien plus qu'une case reléguée en bord de carte, sans jamais tomber à zéro (toute case occupée
 * reste un gain, même lointaine). Une case comptant à la fois une tour et un bout de route (rare,
 * mais possible sur les voies non tenues par la défense candidate) n'est comptée qu'une fois.
 */
export function spreadScore(
  towers: readonly TowerInstance[],
  wave: Wave,
  chateau: GridCoord,
): number {
  const cells = new Map<string, GridCoord>();
  for (const tower of towers) {
    cells.set(`${tower.position.x},${tower.position.y}`, tower.position);
  }
  for (const lane of wave.lanes) {
    for (const cell of expandPathCells(lane.path)) {
      cells.set(`${cell.x},${cell.y}`, cell);
    }
  }
  let score = 0;
  for (const cell of cells.values()) {
    score += 100 / (1 + hexDistance(cell, chateau));
  }
  return score;
}

/**
 * Décalage utilisé par `phaseScore` pour garantir qu'un score de succès (fonction de l'étalement,
 * voir `spreadScore`) reste toujours mieux classé qu'un score d'échec (vie du château restante,
 * bornée par `chateauMaxHp`) — bien plus grand que n'importe quelle grille ou vie de château
 * réaliste du jeu.
 */
const SPREAD_SCORE_BASE = 1_000_000;

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

/**
 * Score d'une épreuve (défense ou attaque), obtenu en rejouant l'épreuve jusqu'à son terme
 * (CONCEPTION.md §12 « Scoring »). Deux régimes distincts :
 * - Échec : vie du château restante à la fin de l'épreuve — en défense, le château a encaissé au
 *   moins un point de dégât sans que la victoire (aucun dégât) soit exigée, jusqu'à être détruit
 *   en cours de route (score alors très négatif, voir `resolveOutcome`) ; en attaque, le château a
 *   survécu sans être détruit (score alors strictement positif). Dans les deux cas, l'ampleur du
 *   score reste une information utile pour départager deux solutions qui échouent toutes les deux.
 * - Succès : deux solutions qui terminent toutes les deux la phase (château intact en défense,
 *   détruit en attaque) ne sont plus départagées par la vie du château restante, mais par leur
 *   étalement (`spreadScore`) — la plus étalée, et surtout la plus proche du château, l'emporte :
 *   plus un joueur occupe de cases proches du château, plus il contraint son adversaire au palier
 *   suivant (moins de cases libres où tracer une route ou poser une tour, précisément là où ça
 *   compte le plus). `SPREAD_SCORE_BASE` assure que ce score reste toujours strictement meilleur
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
  chateau: GridCoord,
  monsterCatalog: readonly MonsterType[] = MONSTER_TYPES,
  towerCatalog: readonly TowerType[] = TOWER_TYPES,
  mode: SimulationMode = 'defense',
): number {
  const simulation = new DefenseSimulation(
    towers,
    wave,
    chateauMaxHp,
    monsterCatalog,
    towerCatalog,
    undefined,
    mode,
  );
  simulation.runToCompletion();

  const maxDamage = totalMonsterHp(wave, monsterCatalog);
  const damageBonus = maxDamage > 0 ? Math.min(1, simulation.getTotalDamageDealt() / maxDamage) : 0;

  if (simulation.getOutcome() === 'failure') {
    return simulation.getChateauHp() + damageBonus;
  }
  const spread = spreadScore(towers, wave, chateau);
  const signedBase = mode === 'defense' ? SPREAD_SCORE_BASE + spread : -(SPREAD_SCORE_BASE + spread);
  return signedBase + damageBonus;
}
