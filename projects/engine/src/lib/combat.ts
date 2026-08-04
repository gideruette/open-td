import type { GridCoord, MapPath, MonsterType, TowerInstance, TowerType, Wave } from 'shared';
import { MONSTER_TYPES, TOWER_TYPES } from 'shared';
import { pathLength, pointAtDistance } from './path';

/** Candidat de ciblage : vue minimale d'un monstre utile au choix de la cible d'une tour. */
export interface TargetCandidate {
  id: string;
  /** Distance parcourue le long du chemin (plus grand = plus avancé). */
  distance: number;
  position: GridCoord;
}

/** Choisit la cible d'une tour parmi les monstres à portée : toujours le plus avancé. Pure. */
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
export function totalChateauDamage(wave: Wave, monsterCatalog: readonly MonsterType[] = MONSTER_TYPES): number {
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

/** Coût total (budget d'attaque) d'une vague, toutes voies confondues (CONCEPTION.md §5.1). */
export function waveCost(wave: Wave, monsterCatalog: readonly MonsterType[] = MONSTER_TYPES): number {
  return wave.lanes.reduce(
    (total, lane) =>
      total +
      lane.units.reduce((laneTotal, unit) => {
        const type = monsterCatalog.find((candidate) => candidate.id === unit.type);
        return laneTotal + (type?.cost ?? 0);
      }, 0),
    0,
  );
}

/** Tir d'une tour survenu pendant le dernier tick (position de la tour → position touchée). */
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
 * Camp du joueur pour cette simulation : `defense` (tenir vagueCourante, château qui survit)
 * ou `attack` (percer avec une vague composée, ≥1 monstre au château) — CONCEPTION.md §5.4.
 * La mécanique de simulation (spawn, déplacement, tir, dégâts) est identique dans les deux
 * cas ; seule l'interprétation de la victoire/défaite change.
 */
export type SimulationMode = 'defense' | 'attack';

interface LaneState {
  path: MapPath;
  pathTotalLength: number;
  spawnQueue: string[];
  ticksSinceLastSpawn: number;
}

const DEFAULT_TICKS_BETWEEN_SPAWNS = 5;
const DEFAULT_MAX_TICKS = 20_000;

/**
 * Simulation déterministe, tick par tick, d'une épreuve (défense ou attaque) : la vague
 * donnée — une ou plusieurs voies actives simultanément, CONCEPTION.md §5.3 — est envoyée
 * sur la forteresse (tours figées) jusqu'à ce que le château tombe, que toutes les voies soient
 * entièrement traitées, ou qu'une brèche survienne.
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
    chateauMaxHp: number,
    private readonly monsterCatalog: readonly MonsterType[] = MONSTER_TYPES,
    private readonly towerCatalog: readonly TowerType[] = TOWER_TYPES,
    private readonly ticksBetweenSpawns: number = DEFAULT_TICKS_BETWEEN_SPAWNS,
    private readonly mode: SimulationMode = 'defense',
  ) {
    this.lanes = wave.lanes.map((lane) => ({
      path: lane.path,
      pathTotalLength: pathLength(lane.path),
      spawnQueue: lane.units.map((unit) => unit.type),
      ticksSinceLastSpawn: 0,
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

  /** Nombre de monstres ayant atteint le château jusqu'ici (condition de succès en attaque). */
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

  private spawn(): void {
    for (let laneIndex = 0; laneIndex < this.lanes.length; laneIndex++) {
      const lane = this.lanes[laneIndex];
      lane.ticksSinceLastSpawn++;
      if (lane.spawnQueue.length === 0 || lane.ticksSinceLastSpawn < this.ticksBetweenSpawns) {
        continue;
      }
      lane.ticksSinceLastSpawn = 0;
      const typeId = lane.spawnQueue.shift();
      const type = typeId ? this.monsterCatalog.find((candidate) => candidate.id === typeId) : undefined;
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
    this.monsters = this.monsters.filter((monster) => monster.hp > 0);
  }

  private applyDamage(monster: MonsterInstance, towerType: TowerType): void {
    const monsterType = this.monsterCatalog.find((candidate) => candidate.id === monster.typeId);
    const armorMultiplier = towerType.armorBonus && monsterType?.armored ? towerType.armorBonus : 1;
    monster.hp -= towerType.damage * armorMultiplier;
    if (towerType.slowFactor && towerType.slowDuration) {
      monster.slowMultiplier = towerType.slowFactor;
      monster.slowUntilTick = this.tick + towerType.slowDuration;
    }
  }

  private pickTarget(tower: TowerInstance, towerType: TowerType): MonsterInstance | undefined {
    const candidates: TargetCandidate[] = this.monsters.map((monster) => ({
      id: monster.id,
      distance: monster.distance,
      position: this.getMonsterPosition(monster),
    }));
    const targetId = selectTarget(tower.position, towerType.range, candidates);
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
      if (this.breachCount > 0) {
        this.outcome = 'success';
        return;
      }
      if (allLanesSpawned && this.monsters.length === 0) {
        this.outcome = 'failure';
      }
      return;
    }

    if (this.chateauHp <= 0) {
      this.outcome = 'failure';
      return;
    }
    if (allLanesSpawned && this.monsters.length === 0) {
      this.outcome = 'success';
    }
  }
}
