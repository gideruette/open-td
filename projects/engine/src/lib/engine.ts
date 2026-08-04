import type {
  BudgetGrowth,
  GameMap,
  GamePhase,
  GridCoord,
  MapPath,
  PlacementResult,
  StartingData,
  TowerInstance,
  Wave,
} from 'shared';
import { findTowerType, TOWER_TYPES } from 'shared';
import { DefenseSimulation, waveCost } from './combat';
import { canOccupyCell, canPlaceTower, removeTower, spentBudget } from './fortress';
import { addMapPath, removeMapPath } from './path';

/**
 * Moteur de jeu pur (sans DOM) : état complet d'une run (forteresse, budgets,
 * palier, vagueCourante) et alternance Défense ↔ Attaque (CONCEPTION.md §3, §6).
 */
export class GameEngine {
  private map: GameMap | undefined;
  private phaseState: GamePhase = 'defense';
  private palier = 1;
  private defenseBudget = 0;
  private attackBudget = 0;
  private budgetGrowth: BudgetGrowth = { defense: 0, attack: 0 };
  private chateauMaxHp = 0;
  private vagueCourante: Wave | undefined;
  private towers: TowerInstance[] = [];
  private towerSequence = 0;
  private savedAttackPlan: Wave = { lanes: [] };
  private savedDefenseTowers: TowerInstance[] = [];

  getStatus(): string {
    return `Open TD engine ready (${this.phaseState})`;
  }

  /** Démarre une nouvelle run sur la carte donnée : palier 1, vague #0, forteresse vide. */
  startRun(map: GameMap, startingData: StartingData): void {
    this.map = map;
    this.phaseState = 'defense';
    this.palier = 1;
    this.defenseBudget = startingData.startingDefenseBudget;
    this.attackBudget = startingData.startingAttackBudget;
    this.budgetGrowth = startingData.budgetGrowth;
    this.chateauMaxHp = startingData.chateauHp;
    this.vagueCourante = startingData.initialWave;
    this.towers = [];
    this.towerSequence = 0;
    // La toute première phase Attaque démarre avec les mêmes voies (chemins + monstres) que
    // `initialWave`, pour ne pas forcer le joueur à réarmer chaque chemin prédéfini à vide.
    this.savedAttackPlan = {
      lanes: startingData.initialWave.lanes.map((lane) => ({
        path: lane.path,
        units: lane.units.map((unit) => ({ ...unit })),
      })),
    };
    this.savedDefenseTowers = [];
  }

  getMap(): GameMap | undefined {
    return this.map;
  }

  /**
   * Retire un chemin prédéfini de la carte : les chemins n'ont rien de permanent, le joueur
   * peut en supprimer (CONCEPTION.md §5.3). Ceux qui restent continuent d'apparaître en
   * phases Défense et Attaque. Retourne `false` si aucun chemin ne correspond.
   */
  removePath(pathId: string): boolean {
    if (!this.map) {
      return false;
    }
    const before = this.map.paths.length;
    this.map = removeMapPath(this.map, pathId);
    return this.map.paths.length < before;
  }

  /**
   * Ajoute un chemin (typiquement un tracé libre validé) à la carte : il devient persistant,
   * au même titre qu'un chemin prédéfini, et survit à la remise à zéro des voies en cours de
   * composition (CONCEPTION.md §5.3).
   */
  addPath(path: MapPath): void {
    if (!this.map) {
      return;
    }
    this.map = addMapPath(this.map, path);
  }

  getPhase(): GamePhase {
    return this.phaseState;
  }

  getPalier(): number {
    return this.palier;
  }

  getTowers(): readonly TowerInstance[] {
    return this.towers;
  }

  /** Budget de défense restant après les tours actuellement posées. */
  getRemainingBudget(): number {
    return this.defenseBudget - spentBudget(this.towers, TOWER_TYPES);
  }

  getDefenseBudget(): number {
    return this.defenseBudget;
  }

  getAttackBudget(): number {
    return this.attackBudget;
  }

  /** Budget d'attaque restant une fois la composition de vague donnée payée. */
  getAttackBudgetRemaining(wave: Wave): number {
    return this.attackBudget - waveCost(wave);
  }

  getChateauMaxHp(): number {
    return this.chateauMaxHp;
  }

  /** vagueCourante : vague #0 pré-construite, puis dernière attaque réussie (CONCEPTION.md §3). */
  getVagueCourante(): Wave | undefined {
    return this.vagueCourante;
  }

  /**
   * Plan d'attaque sauvegardé : point de départ de chaque phase Attaque, établi à la dernière
   * attaque réussie (voies vides au tout premier cycle) — CONCEPTION.md §11 décision 12.
   */
  getAttackPlan(): Wave {
    return this.savedAttackPlan;
  }

  /** Place une tour du type donné sur la case ciblée, si les règles le permettent (Défense uniquement). */
  placeTower(typeId: string, position: GridCoord): PlacementResult {
    if (this.phaseState !== 'defense') {
      return { ok: false, reason: 'wrong-phase' };
    }
    const towerType = findTowerType(typeId);
    const result = canPlaceTower(this.map, this.towers, towerType, position, this.getRemainingBudget());
    if (!result.ok) {
      return result;
    }
    this.towers = [
      ...this.towers,
      {
        id: `tower-${this.towerSequence++}`,
        typeId,
        position,
        level: 1,
        placedAtPalier: this.palier,
      },
    ];
    return { ok: true };
  }

  /**
   * Supprime une tour posée et libère son coût de construction dans le budget (Défense uniquement).
   * Toujours gratuit (CONCEPTION.md §4).
   */
  deleteTower(towerId: string): number | undefined {
    if (this.phaseState !== 'defense') {
      return undefined;
    }
    const tower = this.towers.find((candidate) => candidate.id === towerId);
    if (!tower) {
      return undefined;
    }
    const towerType = findTowerType(tower.typeId);
    const recovered = towerType?.cost ?? 0;
    this.towers = removeTower(this.towers, towerId);
    return recovered;
  }

  /**
   * Déplace une tour déjà posée vers une nouvelle case (Défense uniquement). Toujours gratuit :
   * ne consomme pas de budget (CONCEPTION.md §4).
   */
  moveTower(towerId: string, position: GridCoord): PlacementResult {
    if (this.phaseState !== 'defense') {
      return { ok: false, reason: 'wrong-phase' };
    }
    const tower = this.towers.find((candidate) => candidate.id === towerId);
    if (!tower) {
      return { ok: false, reason: 'tower-not-found' };
    }
    const otherTowers = this.towers.filter((candidate) => candidate.id !== towerId);
    const result = canOccupyCell(this.map, otherTowers, position);
    if (!result.ok) {
      return result;
    }
    this.towers = [...otherTowers, { ...tower, position }];
    return { ok: true };
  }

  /** Lance une épreuve de défense : vagueCourante contre la forteresse actuelle. */
  startDefenseTrial(): DefenseSimulation {
    if (!this.map || !this.vagueCourante) {
      throw new Error('Run not started');
    }
    if (this.phaseState !== 'defense') {
      throw new Error('Not in defense phase');
    }
    return new DefenseSimulation(this.towers, this.vagueCourante, this.chateauMaxHp);
  }

  /** Défense réussie : la forteresse est figée, passage en phase Attaque. */
  resolveDefenseSuccess(): void {
    if (this.phaseState !== 'defense') {
      return;
    }
    this.phaseState = 'attack';
  }

  /**
   * Abandonne les modifications de la phase Défense en cours (poses, suppressions, déplacements) pour
   * revenir à la forteresse telle qu'elle était au début de cette phase.
   */
  resetDefenseSession(): void {
    if (this.phaseState !== 'defense') {
      return;
    }
    this.towers = this.savedDefenseTowers.map((tower) => ({ ...tower }));
  }

  /** Lance une épreuve d'attaque : la vague composée par le joueur contre la forteresse figée. */
  startAttackTrial(wave: Wave): DefenseSimulation {
    if (!this.map) {
      throw new Error('Run not started');
    }
    if (this.phaseState !== 'attack') {
      throw new Error('Not in attack phase');
    }
    return new DefenseSimulation(this.towers, wave, this.chateauMaxHp, undefined, undefined, undefined, 'attack');
  }

  /**
   * Attaque réussie : la vague jouée devient vagueCourante, le palier monte,
   * les deux budgets augmentent, retour en phase Défense (CONCEPTION.md §6).
   */
  resolveAttackSuccess(wave: Wave): void {
    if (this.phaseState !== 'attack') {
      return;
    }
    this.vagueCourante = wave;
    this.savedAttackPlan = wave;
    this.palier += 1;
    this.defenseBudget += this.budgetGrowth.defense;
    this.attackBudget += this.budgetGrowth.attack;
    this.phaseState = 'defense';
    this.savedDefenseTowers = this.towers.map((tower) => ({ ...tower }));
  }
}
