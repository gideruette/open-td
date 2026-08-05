import type { GridCoord, MapPath, MonsterType, TowerInstance, TowerType, Wave } from 'shared';
import { MONSTER_TYPES, TOWER_TYPES, hexToWorld } from 'shared';
import { PATH_CELL_COST, expandPathCells, pathCellsCost, pathLength, pointAtDistance } from './path';

/** Candidat de ciblage : vue minimale d'un monstre utile au choix de la cible d'une tour. */
export interface TargetCandidate {
  id: string;
  /** Distance parcourue le long du chemin (plus grand = plus avancé). */
  distance: number;
  /** Position en world-space (centres hex, voisin ≈ 1). */
  position: GridCoord;
}

/**
 * Choisit la cible d'une tour parmi les monstres à portée : toujours le plus avancé.
 * `towerPosition` et les positions candidats sont en world-space.
 */
export function selectTarget(
  towerPosition: GridCoord,
  towerRange: number,
  candidates: readonly TargetCandidate[],
): string | undefined {
  const distanceToTower = (candidate: TargetCandidate) =>
    Math.hypot(candidate.position.x - towerPosition.x, candidate.position.y - towerPosition.y);

  const inRange = candidates.filter((candidate) => distanceToTower(candidate) <= towerRange);
  if (inRange.length === 0) {
    return undefined;
  }
  return inRange.reduce((a, b) => (b.distance > a.distance ? b : a)).id;
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
  return monstersCost + pathCellsCost(wave.lanes.map((lane) => lane.path), pathCellCost);
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
  pathTotalLength: number;
  spawnQueue: string[];
  /** Progression continue vers le prochain spawn, en unités de `spawnThreshold` (voir `spawn()`). */
  spawnProgress: number;
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

  constructor(
    private readonly towers: readonly TowerInstance[],
    wave: Wave,
    private readonly chateauMaxHp: number,
    private readonly monsterCatalog: readonly MonsterType[] = MONSTER_TYPES,
    private readonly towerCatalog: readonly TowerType[] = TOWER_TYPES,
    private readonly ticksBetweenSpawns: number = DEFAULT_TICKS_BETWEEN_SPAWNS,
    private readonly mode: SimulationMode = 'defense',
  ) {
    this.lanes = wave.lanes.map((lane) => ({
      path: lane.path,
      pathTotalLength: pathLength(lane.path),
      spawnQueue: lane.units.map((unit) => unit.type),
      spawnProgress: 0,
    }));
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

  getMonsters(): readonly MonsterInstance[] {
    return this.monsters;
  }

  getMonsterPosition(monster: MonsterInstance): GridCoord {
    return pointAtDistance(this.lanes[monster.laneIndex].path, monster.distance);
  }

  /** Tirs (tour → cible) survenus lors du dernier `step()`, pour l'affichage des projectiles. */
  getShotsThisTick(): readonly ShotEvent[] {
    return this.shotsThisTick;
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
      const type = this.monsterCatalog.find((candidate) => candidate.id === monster.typeId);
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
      const nextType = this.monsterCatalog.find((candidate) => candidate.id === lane.spawnQueue[0]);
      lane.spawnProgress += nextType && nextType.speed > 0 ? nextType.speed : SPAWN_GAP_REFERENCE_SPEED;
      if (lane.spawnProgress < spawnThreshold) {
        continue;
      }
      lane.spawnProgress -= spawnThreshold;
      const typeId = lane.spawnQueue.shift();
      const type = typeId
        ? this.monsterCatalog.find((candidate) => candidate.id === typeId)
        : undefined;
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

  private fireTowers(): void {
    for (const tower of this.towers) {
      const cooldown = this.towerCooldowns.get(tower.id) ?? 0;
      if (cooldown > 0) {
        this.towerCooldowns.set(tower.id, cooldown - 1);
        continue;
      }
      const towerType = this.towerCatalog.find((candidate) => candidate.id === tower.typeId);
      if (!towerType) {
        continue;
      }
      const target = this.pickTarget(tower, towerType);
      if (!target) {
        continue;
      }
      this.shotsThisTick.push({
        towerPosition: tower.position,
        targetPosition: this.getMonsterPosition(target),
        splashRadius: towerType.splashRadius,
      });
      this.applyDamage(target, towerType);
      if (towerType.splashRadius) {
        const targetPos = this.getMonsterPosition(target);
        for (const monster of this.monsters) {
          if (monster.id === target.id) {
            continue;
          }
          const pos = this.getMonsterPosition(monster);
          if (Math.hypot(pos.x - targetPos.x, pos.y - targetPos.y) <= towerType.splashRadius) {
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
      const type = this.monsterCatalog.find((candidate) => candidate.id === monster.typeId);
      const childType = type?.splitOnDeath
        ? this.monsterCatalog.find((candidate) => candidate.id === type.splitOnDeath!.typeId)
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
    const monsterType = this.monsterCatalog.find((candidate) => candidate.id === monster.typeId);
    const armorMultiplier = towerType.armorBonus && monsterType?.armored ? towerType.armorBonus : 1;
    monster.hp -= towerType.damage * armorMultiplier;
    if (towerType.slowFactor && towerType.slowDuration) {
      const resistance = monsterType?.slowResistance ?? 0;
      monster.slowMultiplier = Math.min(1, towerType.slowFactor + (1 - towerType.slowFactor) * resistance);
      monster.slowUntilTick = this.tick + towerType.slowDuration;
    }
  }

  private pickTarget(tower: TowerInstance, towerType: TowerType): MonsterInstance | undefined {
    const candidates: TargetCandidate[] = this.monsters.map((monster) => ({
      id: monster.id,
      distance: monster.distance,
      position: this.getMonsterPosition(monster),
    }));
    const targetId = selectTarget(hexToWorld(tower.position), towerType.range, candidates);
    return this.monsters.find((monster) => monster.id === targetId);
  }

  private moveMonsters(): void {
    for (const monster of this.monsters) {
      const type = this.monsterCatalog.find((candidate) => candidate.id === monster.typeId);
      if (!type) {
        continue;
      }
      const multiplier = this.tick <= monster.slowUntilTick ? monster.slowMultiplier : 1;
      monster.distance += type.speed * multiplier;
    }

    const arrived = this.monsters.filter(
      (monster) => monster.distance >= this.lanes[monster.laneIndex].pathTotalLength,
    );
    this.breachCount += arrived.length;
    for (const monster of arrived) {
      const type = this.monsterCatalog.find((candidate) => candidate.id === monster.typeId);
      this.chateauHp -= type?.chateauDamage ?? 0;
    }
    this.monsters = this.monsters.filter(
      (monster) => monster.distance < this.lanes[monster.laneIndex].pathTotalLength,
    );
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
 * Nombre de cases distinctes occupées par des tours ou par une voie de la vague (routes) : la
 * mesure d'« étalement » d'une solution — voir `phaseScore`, qui l'utilise pour départager deux
 * solutions réussissant toutes les deux la phase. Une case comptant à la fois une tour et un bout
 * de route (rare, mais possible sur les voies non tenues par la défense candidate) n'est comptée
 * qu'une fois.
 */
export function spreadCellCount(towers: readonly TowerInstance[], wave: Wave): number {
  const cells = new Set<string>();
  for (const tower of towers) {
    cells.add(`${tower.position.x},${tower.position.y}`);
  }
  for (const lane of wave.lanes) {
    for (const cell of expandPathCells(lane.path)) {
      cells.add(`${cell.x},${cell.y}`);
    }
  }
  return cells.size;
}

/**
 * Décalage utilisé par `phaseScore` pour garantir qu'un score de succès (fonction de l'étalement,
 * voir `spreadCellCount`) reste toujours mieux classé qu'un score d'échec (vie du château restante,
 * bornée par `chateauMaxHp`) — bien plus grand que n'importe quelle grille ou vie de château
 * réaliste du jeu.
 */
const SPREAD_SCORE_BASE = 1_000_000;

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
 *   étalement (`spreadCellCount`) — la plus étalée (le plus de cases prises par des routes ou des
 *   tours) l'emporte : plus un joueur occupe de cases, plus il contraint son adversaire au palier
 *   suivant (moins de cases libres où tracer une route ou poser une tour). `SPREAD_SCORE_BASE`
 *   assure que ce score reste toujours strictement meilleur qu'un score d'échec.
 */
export function phaseScore(
  towers: readonly TowerInstance[],
  wave: Wave,
  chateauMaxHp: number,
  monsterCatalog: readonly MonsterType[] = MONSTER_TYPES,
  towerCatalog: readonly TowerType[] = TOWER_TYPES,
  mode: SimulationMode = 'defense',
): number {
  const simulation = new DefenseSimulation(towers, wave, chateauMaxHp, monsterCatalog, towerCatalog, undefined, mode);
  simulation.runToCompletion();
  if (simulation.getOutcome() === 'failure') {
    return simulation.getChateauHp();
  }
  const spread = spreadCellCount(towers, wave);
  return mode === 'defense' ? SPREAD_SCORE_BASE + spread : -(SPREAD_SCORE_BASE + spread);
}
