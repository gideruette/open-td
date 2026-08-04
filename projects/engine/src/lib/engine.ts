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
import { findMonsterType, findTowerType, sellRefund, TOWER_TYPES, unitRemovalRefund } from 'shared';
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
  private attackSunkCost = 0;
  private attackAttempt = 1;
  private defenseSunkCost = 0;
  private savedAttackPlan: Wave = { lanes: [] };
  private savedDefenseTowers: TowerInstance[] = [];
  private savedDefenseSunkCost = 0;

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
    this.attackSunkCost = 0;
    this.attackAttempt = 1;
    this.defenseSunkCost = 0;
    // La toute première phase Attaque démarre avec les mêmes voies (chemins + monstres) que
    // `initialWave`, pour ne pas forcer le joueur à réarmer chaque chemin prédéfini à vide.
    this.savedAttackPlan = {
      lanes: startingData.initialWave.lanes.map((lane) => ({
        path: lane.path,
        units: lane.units.map((unit) => ({ ...unit })),
      })),
    };
    this.savedDefenseTowers = [];
    this.savedDefenseSunkCost = 0;
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

  /**
   * Budget de défense restant, en tenant compte des montants définitivement perdus en
   * déplaçant des tours héritées d'un palier précédent (CONCEPTION.md §4).
   */
  getRemainingBudget(): number {
    return this.defenseBudget - spentBudget(this.towers, TOWER_TYPES) - this.defenseSunkCost;
  }

  getDefenseBudget(): number {
    return this.defenseBudget;
  }

  getAttackBudget(): number {
    return this.attackBudget;
  }

  /**
   * Budget d'attaque restant une fois la composition de vague donnée payée. Tient compte des
   * montants définitivement perdus en retirant des monstres déjà mis en file (CONCEPTION.md §5.2).
   */
  getAttackBudgetRemaining(wave: Wave): number {
    return this.attackBudget - waveCost(wave) - this.attackSunkCost;
  }

  /**
   * Tentative d'attaque en cours (incrémentée à chaque échec) : une affectation de monstre
   * faite pendant la tentative courante peut être défaite gratuitement ; une fois la
   * tentative passée (échec), elle devient établie et coûte à retirer (CONCEPTION.md §5.2).
   */
  getAttackAttempt(): number {
    return this.attackAttempt;
  }

  /**
   * Enregistre le retrait d'un monstre déjà mis en file d'une voie. Gratuit si le monstre a
   * été affecté pendant la tentative d'attaque courante ; sinon une partie de son coût reste
   * définitivement perdue plutôt que remboursée en intégralité, pour que défaire une
   * composition déjà établie ne soit pas gratuit (CONCEPTION.md §5.2).
   */
  recordAttackUnitRemoval(monsterTypeId: string, addedAtAttempt: number): void {
    if (this.phaseState !== 'attack' || addedAtAttempt === this.attackAttempt) {
      return;
    }
    const type = findMonsterType(monsterTypeId);
    if (!type) {
      return;
    }
    this.attackSunkCost += type.cost - unitRemovalRefund(type.cost);
  }

  /**
   * Une tentative d'attaque vient d'échouer : tout ce qui était déjà en place devient
   * "établi" (retrait payant) ; une nouvelle tentative commence (CONCEPTION.md §5.2).
   */
  recordFailedAttackAttempt(): void {
    if (this.phaseState !== 'attack') {
      return;
    }
    this.attackAttempt += 1;
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

  /**
   * Abandonne les modifications de la phase Attaque en cours pour revenir au plan sauvegardé :
   * remet à zéro le bookkeeping de tentative, comme au tout début de la phase.
   */
  resetAttackSession(): void {
    if (this.phaseState !== 'attack') {
      return;
    }
    this.attackSunkCost = 0;
    this.attackAttempt = 1;
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
   * Vend une tour posée : la retire et rembourse son coût (Défense uniquement). Une tour
   * héritée d'un palier précédent rapporte moins qu'une tour posée ce palier-ci
   * (forteresse persistante entre cycles, CONCEPTION.md §4).
   */
  sellTower(towerId: string): number | undefined {
    if (this.phaseState !== 'defense') {
      return undefined;
    }
    const tower = this.towers.find((candidate) => candidate.id === towerId);
    if (!tower) {
      return undefined;
    }
    const towerType = findTowerType(tower.typeId);
    const refund = towerType ? sellRefund(towerType.cost, tower.placedAtPalier === this.palier) : 0;
    this.towers = removeTower(this.towers, towerId);
    return refund;
  }

  /**
   * Déplace une tour déjà posée vers une nouvelle case (Défense uniquement). Gratuit si la
   * tour a été posée ce palier-ci ; sinon, une partie de sa valeur est définitivement perdue,
   * comme pour une revente (CONCEPTION.md §4). Ne paie pas le coût plein d'une nouvelle tour.
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
    let sunkCostDelta = 0;
    if (tower.placedAtPalier !== this.palier) {
      const towerType = findTowerType(tower.typeId);
      if (towerType) {
        sunkCostDelta = towerType.cost - sellRefund(towerType.cost, false);
      }
    }
    if (sunkCostDelta > this.getRemainingBudget()) {
      return { ok: false, reason: 'insufficient-budget' };
    }
    this.defenseSunkCost += sunkCostDelta;
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
    this.resetAttackSession();
  }

  /**
   * Abandonne les modifications de la phase Défense en cours (poses, ventes, déplacements) pour
   * revenir à la forteresse telle qu'elle était au début de cette phase.
   */
  resetDefenseSession(): void {
    if (this.phaseState !== 'defense') {
      return;
    }
    this.towers = this.savedDefenseTowers.map((tower) => ({ ...tower }));
    this.defenseSunkCost = this.savedDefenseSunkCost;
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
    this.savedDefenseSunkCost = this.defenseSunkCost;
  }
}
