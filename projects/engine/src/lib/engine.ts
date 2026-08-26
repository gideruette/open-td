import type {
  BudgetGrowth,
  GameMap,
  GamePhase,
  GridCoord,
  MapPath,
  MapSpawn,
  PlacementResult,
  StartingData,
  TowerInstance,
  Wave,
} from 'shared';
import { findTowerType, TOWER_TYPES } from 'shared';
import { DefenseSimulation, waveCost } from './combat';
import { canOccupyCell, canPlaceTower, removeTower, spentBudget } from './fortress';
import { addMapPath, addMapSpawn, isSpawnCell, pruneOrphanSpawns, removeMapPath } from './path';

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
  private spawnSequence = 0;
  /** Ids des voies figées sur la carte par la dernière attaque victorieuse — voir `persistWaveRoutes`. */
  private persistedRouteIds: string[] = [];
  private savedAttackPlan: Wave = { lanes: [] };

  getStatus(): string {
    return `Open TD engine ready (${this.phaseState})`;
  }

  /**
   * Démarre une nouvelle run sur la carte donnée : palier 1, forteresse vide. Aucune vague n'est
   * pré-construite : la run commence en phase Attaque, contre une forteresse sans aucune tour
   * (CONCEPTION.md §3) — la vague qui en résulte devient `vagueCourante` pour le palier 1 en
   * phase Défense, une fois `resolveAttackSuccess` appelé.
   */
  startRun(map: GameMap, startingData: StartingData): void {
    this.map = map;
    this.phaseState = 'attack';
    this.palier = 1;
    this.defenseBudget = startingData.startingDefenseBudget;
    this.attackBudget = startingData.startingAttackBudget;
    this.budgetGrowth = startingData.budgetGrowth;
    this.chateauMaxHp = startingData.chateauHp;
    this.vagueCourante = undefined;
    this.towers = [];
    this.towerSequence = 0;
    this.spawnSequence = 0;
    this.persistedRouteIds = [];
    this.savedAttackPlan = { lanes: [] };
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

  /**
   * Ajoute un nouveau spawn (typiquement créé par le joueur en bord de grille pendant un tracé
   * libre) à la carte : il devient persistant, au même titre qu'un spawn prédéfini.
   */
  addSpawn(spawn: MapSpawn): void {
    if (!this.map) {
      return;
    }
    this.map = addMapSpawn(this.map, spawn);
  }

  /**
   * Retire les spawns qui ne sont plus reliés à aucun chemin : utile après l'abandon d'un
   * tracé libre qui avait créé un nouveau spawn sans jamais le relier au château.
   */
  pruneOrphanSpawns(): void {
    if (!this.map) {
      return;
    }
    this.map = pruneOrphanSpawns(this.map);
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

  /** vagueCourante : indéfinie avant la résolution de la première Attaque, puis dernière attaque réussie (CONCEPTION.md §3). */
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
   * Aligne la forteresse persistante sur `target` : suppression (remboursement) des tours absentes
   * du plan, puis pose des manquantes. Le budget brut du palier reste le plafond ; on ne part plus
   * d'un plateau vide.
   */
  applyFortressLayout(target: readonly TowerInstance[]): { rejected: number } {
    const wanted = new Map<string, string>();
    for (const tower of target) {
      wanted.set(`${tower.position.x},${tower.position.y}`, tower.typeId);
    }

    for (const tower of [...this.towers]) {
      const key = `${tower.position.x},${tower.position.y}`;
      if (wanted.get(key) !== tower.typeId) {
        this.deleteTower(tower.id);
      }
    }

    let rejected = 0;
    const present = new Set(this.towers.map((tower) => `${tower.position.x},${tower.position.y}`));
    for (const tower of target) {
      const key = `${tower.position.x},${tower.position.y}`;
      if (present.has(key)) {
        continue;
      }
      if (!this.placeTower(tower.typeId, tower.position).ok) {
        rejected++;
      } else {
        present.add(key);
      }
    }
    return { rejected };
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

  /**
   * Défense réussie : la forteresse est figée, passage en phase Attaque. Les voies de l'attaque
   * précédente sont défaites de la carte (`releaseWaveRoutes`) : le terrain qu'elles occupaient
   * redevient constructible, l'attaquant devant repayer son tracé sur son budget à ce palier.
   */
  resolveDefenseSuccess(): void {
    if (this.phaseState !== 'defense') {
      return;
    }
    this.releaseWaveRoutes();
    this.phaseState = 'attack';
  }

  /** Supprime toutes les tours posées en phase Défense (retour à une forteresse vide). */
  resetDefenseSession(): void {
    if (this.phaseState !== 'defense') {
      return;
    }
    this.towers = [];
  }

  /**
   * Lance une épreuve d'attaque : la vague composée par le joueur contre la forteresse figée.
   *
   * `waveCost(wave) > this.attackBudget` rejette la vague avant toute simulation — seul garde-fou
   * *dur* de la règle de budget d'attaque, symétrique de celui que `placeTower` fait déjà peser sur
   * chaque tour côté Défense (`canPlaceTower(..., this.getRemainingBudget())`). `enforceBudget`
   * (recherche génétique IA) et la saisie de l'UI garantissent déjà cette limite en amont, mais
   * aucun des deux n'est un mur infranchissable au sens du moteur : c'est lui, pas ses appelants,
   * qui doit rester la source de vérité de la règle.
   */
  startAttackTrial(wave: Wave): DefenseSimulation {
    if (!this.map) {
      throw new Error('Run not started');
    }
    if (this.phaseState !== 'attack') {
      throw new Error('Not in attack phase');
    }
    if (waveCost(wave) > this.attackBudget) {
      throw new Error('Wave exceeds attack budget');
    }
    return new DefenseSimulation(this.towers, wave, this.chateauMaxHp, undefined, undefined, undefined, 'attack');
  }

  /**
   * Fige sur la carte les voies d'une vague victorieuse : leurs tracés deviennent des chemins, et
   * leur case de départ un spawn, au même titre qu'un chemin prédéfini (CONCEPTION.md §5.3). C'est ce
   * qui donne au terrain gagné par l'attaquant sa valeur **pendant la phase Défense qui suit** : une
   * case de chemin n'est plus constructible (`canOccupyCell`), donc chaque route y trace un couloir
   * dont la défense est exclue — et garantit du même coup qu'un passage relie toujours un bord au
   * château, la défense ne pouvant jamais l'enfermer.
   *
   * Ce terrain n'est acquis que pour un palier : les voies sont défaites dès la phase Attaque suivante
   * (`releaseWaveRoutes`), l'attaquant devant repayer ses cases de chemin sur son budget à chaque
   * palier (CONCEPTION.md §5.3). Sans cette libération, les tracés s'accumulaient de palier en palier
   * — mesuré 4 puis 8 puis 12 puis 19 chemins en cinq paliers — et la carte se couvrait de cases
   * définitivement inconstructibles, la défense perdant ses emplacements par simple attrition.
   *
   * Cette règle vivait jusqu'ici uniquement dans la couche d'affichage (`materializeWave`), si bien
   * que le jeu sans interface — l'IA contre l'IA, et le harnais d'équilibre qui en tire ses
   * conclusions — se jouait sans elle et sous-estimait complètement la portée stratégique d'un
   * tracé. Idempotent : une voie déjà posée par l'interface n'est pas ajoutée deux fois.
   */
  private persistWaveRoutes(wave: Wave): void {
    if (!this.map) {
      return;
    }
    for (const lane of wave.lanes) {
      const start = lane.path.nodes[0];
      if (!start) {
        continue;
      }
      const spawn: GridCoord = { x: start[0], y: start[1] };
      if (!isSpawnCell(this.map, spawn)) {
        this.map = addMapSpawn(this.map, { id: `spawn-${this.spawnSequence++}`, ...spawn });
      }
      if (!this.map.paths.some((path) => path.id === lane.path.id)) {
        this.map = addMapPath(this.map, lane.path);
        this.persistedRouteIds.push(lane.path.id);
      }
    }
  }

  /**
   * Défait les voies figées par la dernière attaque victorieuse (`persistWaveRoutes`) : leurs cases
   * redeviennent constructibles et les spawns qu'elles seules tenaient disparaissent
   * (`removeMapPath` élague les spawns orphelins). Appelé à l'entrée de chaque phase Attaque — le
   * tracé d'une route est repayé sur le budget d'attaque à chaque palier, il n'est donc jamais acquis
   * plus longtemps que le palier qui l'a payé.
   *
   * Ne touche qu'aux voies que le moteur a lui-même figées : les chemins prédéfinis de la carte, eux,
   * restent en place.
   */
  private releaseWaveRoutes(): void {
    for (const pathId of this.persistedRouteIds) {
      if (this.map) {
        this.map = removeMapPath(this.map, pathId);
      }
    }
    this.persistedRouteIds = [];
  }

  /**
   * Attaque réussie : la vague jouée devient vagueCourante, ses voies se figent sur la carte
   * (`persistWaveRoutes`), le palier monte, les deux budgets augmentent, retour en phase Défense
   * (CONCEPTION.md §6).
   */
  resolveAttackSuccess(wave: Wave): void {
    if (this.phaseState !== 'attack') {
      return;
    }
    this.persistWaveRoutes(wave);
    this.vagueCourante = wave;
    this.savedAttackPlan = wave;
    this.palier += 1;
    this.defenseBudget += this.budgetGrowth.defense;
    this.attackBudget += this.budgetGrowth.attack;
    this.phaseState = 'defense';
  }
}
