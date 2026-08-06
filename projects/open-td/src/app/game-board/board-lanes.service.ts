import { Injectable, computed, inject, signal } from '@angular/core';
import {
  evolveAttackWave,
  cellsBetween,
  hasUniqueCell,
  isBorderCell,
  isChateauCell,
  isSpawnCell,
  pathCellsCost,
  phaseScore,
  playAttackPhase,
  shortestPath,
  simplifyPathCells,
} from 'engine';
import type { ProgressInfo } from 'engine';
import { findMonsterType } from 'shared';
import type { GameMap, GridCoord, MapPath, MapSpawn, Wave } from 'shared';
import { BoardBudgetService } from './board-budget.service';
import { BoardEngineService } from './board-engine.service';
import { BoardMatchService } from './board-match.service';
import { BoardMessageService } from './board-message.service';
import { BoardTrialService } from './board-trial.service';
import type { BoardTool, LaneDraft } from './board-types';

/** Position d'insertion d'un nouveau monstre dans la file (curseur) + type ajouté. */
export interface MonsterAppendEvent {
  typeId: string;
  atIndex: number;
}

/**
 * Phase Attaque : composition des voies (tracé libre, files de monstres) et outil de canvas actif
 * (Main vs Éditer). Segment "composition d'attaque" — injecté directement dans `BoardHud` et
 * `LanesPanel` plutôt que relayé en props par `GameBoard`.
 */
@Injectable()
export class BoardLanesService {
  private readonly gameState = inject(BoardEngineService);
  private readonly budget = inject(BoardBudgetService);
  private readonly matchService = inject(BoardMatchService);
  private readonly messages = inject(BoardMessageService);
  private readonly trial = inject(BoardTrialService);

  private customLaneSequence = 0;
  private customSpawnSequence = 0;

  private readonly lanesState = signal<LaneDraft[]>([]);
  private readonly activeLaneIndexState = signal<number | undefined>(undefined);
  /** Points déjà cliqués du tracé en cours ; `undefined` = pas en train de tracer. */
  private readonly drawingPathState = signal<GridCoord[] | undefined>(undefined);
  /** Main (pan) tant qu'aucun tracé n'est actif. */
  private readonly boardToolState = signal<BoardTool>('pan');

  readonly lanes = this.lanesState.asReadonly();
  readonly activeLaneIndex = this.activeLaneIndexState.asReadonly();
  readonly drawingPath = this.drawingPathState.asReadonly();
  readonly boardTool = this.boardToolState.asReadonly();

  readonly activeLane = computed(() => {
    const index = this.activeLaneIndexState();
    return index === undefined ? undefined : this.lanesState()[index];
  });
  readonly isDrawingPath = computed(() => this.drawingPathState() !== undefined);

  /**
   * Debug : score (vie du château, potentiellement négative) que donnerait la vague en cours de
   * composition contre la forteresse figée, calculé à l'avance via `phaseScore` — sans lancer
   * l'épreuve. `undefined` tant qu'aucun monstre n'est mis en file.
   */
  readonly attackScore = computed(() => {
    const wave = this.toWave(this.lanesState());
    const map = this.gameState.map();
    if (!map || wave.lanes.every((lane) => lane.units.length === 0)) {
      return undefined;
    }
    return phaseScore(
      this.gameState.towers(),
      wave,
      this.gameState.chateauMaxHp(),
      map.chateau,
      undefined,
      undefined,
      'attack',
    );
  });

  /**
   * Démarre le tracé libre d'une nouvelle voie : le prochain clic doit tomber sur un spawn
   * existant, ou sur une case de bord pour en créer un nouveau (jamais présélectionné, même
   * avec un seul spawn sur la carte, pour ne pas confondre ce choix avec la suite du tracé).
   */
  startTracing(): void {
    if (this.gameState.phase() !== 'attack' || this.trial.isRunning()) {
      return;
    }
    this.boardToolState.set('edit');
    this.drawingPathState.set([]);
    this.messages.set('Touchez un spawn, ou une case de bord pour en créer un nouveau.');
  }

  cancelTracing(): void {
    this.drawingPathState.set(undefined);
    this.boardToolState.set('pan');
    this.messages.set(undefined);
    this.gameState.engine.pruneOrphanSpawns();
    this.gameState.refresh();
    this.refreshAttackBudget();
  }

  /** Revient à l'outil Main (utilisé quand une épreuve démarre ou qu'une session se réinitialise). */
  setPanTool(): void {
    this.boardToolState.set('pan');
  }

  /** Retire le dernier point cliqué du tracé en cours ; si ça découvre le spawn de départ
   * (tracé revenu à vide), un spawn nouvellement créé par ce tracé et resté sans route disparaît
   * avec lui. */
  undoLastTracePoint(): void {
    this.drawingPathState.update((path) => (path && path.length > 0 ? path.slice(0, -1) : path));
    if (this.drawingPathState()?.length === 0) {
      this.gameState.engine.pruneOrphanSpawns();
      this.gameState.refresh();
    }
    this.refreshAttackBudget();
  }

  selectLane(index: number): void {
    if (this.trial.isRunning() || this.isDrawingPath()) {
      return;
    }
    this.activeLaneIndexState.set(index);
  }

  /** Supprime une voie : son tracé disparaît aussi de la carte (plus de référence fantôme au dessin). Sélectionne
   * la voie qui prend sa place, s'il y en a une, pour que le détail affiché dans le HUD reste renseigné. */
  removeLane(index: number): void {
    if (this.trial.isRunning()) {
      return;
    }
    const lane = this.lanesState()[index];
    if (!lane) {
      return;
    }
    this.gameState.engine.removePath(lane.path.id);
    this.lanesState.update((lanes) => lanes.filter((_, i) => i !== index));
    if (this.activeLaneIndexState() === index) {
      const remaining = this.lanesState().length;
      this.activeLaneIndexState.set(remaining === 0 ? undefined : Math.min(index, remaining - 1));
    } else if ((this.activeLaneIndexState() ?? -1) > index) {
      this.activeLaneIndexState.update((current) =>
        current === undefined ? undefined : current - 1,
      );
    }
    this.gameState.refresh();
    this.refreshAttackBudget();
  }

  /** Renomme une voie ; nom vide = retour à l'étiquette par défaut. */
  renameLane(index: number, rawName: string): void {
    const name = rawName.trim();
    this.lanesState.update((lanes) =>
      lanes.map((lane, i) =>
        i === index ? { ...lane, path: { ...lane.path, name: name || undefined } } : lane,
      ),
    );
  }

  renameActiveLane(rawName: string): void {
    const index = this.activeLaneIndexState();
    if (index === undefined) {
      return;
    }
    this.renameLane(index, rawName);
  }

  removeActiveLane(): void {
    const index = this.activeLaneIndexState();
    if (index === undefined) {
      return;
    }
    this.removeLane(index);
  }

  appendMonster(event: MonsterAppendEvent): void {
    const laneIndex = this.activeLaneIndexState();
    if (this.gameState.phase() !== 'attack' || this.trial.isRunning() || laneIndex === undefined) {
      return;
    }
    const type = findMonsterType(event.typeId);
    if (!type || type.cost > this.budget.attack().remaining) {
      return;
    }
    this.lanesState.update((lanes) =>
      lanes.map((lane, i) => {
        if (i !== laneIndex) {
          return lane;
        }
        const atIndex = Math.min(Math.max(event.atIndex, 0), lane.units.length);
        const nextUnits = [...lane.units];
        nextUnits.splice(atIndex, 0, { type: event.typeId });
        return { ...lane, units: nextUnits };
      }),
    );
    this.refreshAttackBudget();
  }

  removeQueueUnit(laneIndex: number, unitIndex: number): void {
    if (this.trial.isRunning()) {
      return;
    }
    this.lanesState.update((lanes) =>
      lanes.map((lane, i) =>
        i === laneIndex ? { ...lane, units: lane.units.filter((_, ui) => ui !== unitIndex) } : lane,
      ),
    );
    this.refreshAttackBudget();
  }

  moveQueueUnit(laneIndex: number, unitIndex: number, direction: -1 | 1): void {
    if (this.trial.isRunning()) {
      return;
    }
    this.lanesState.update((lanes) =>
      lanes.map((lane, i) => {
        if (i !== laneIndex) {
          return lane;
        }
        const target = unitIndex + direction;
        if (target < 0 || target >= lane.units.length) {
          return lane;
        }
        const nextUnits = [...lane.units];
        [nextUnits[unitIndex], nextUnits[target]] = [nextUnits[target], nextUnits[unitIndex]];
        return { ...lane, units: nextUnits };
      }),
    );
  }

  moveActiveQueueUnit(unitIndex: number, direction: -1 | 1): void {
    const laneIndex = this.activeLaneIndexState();
    if (laneIndex === undefined) {
      return;
    }
    this.moveQueueUnit(laneIndex, unitIndex, direction);
  }

  removeActiveQueueUnit(unitIndex: number): void {
    const laneIndex = this.activeLaneIndexState();
    if (laneIndex === undefined) {
      return;
    }
    this.removeQueueUnit(laneIndex, unitIndex);
  }

  /** Recharge les voies en cours de composition depuis le plan d'attaque sauvegardé par le moteur. */
  private loadAttackPlan(): LaneDraft[] {
    return this.gameState.engine.getAttackPlan().lanes.map((lane) => ({
      path: lane.path,
      units: lane.units.map((unit) => ({ ...unit })),
    }));
  }

  /**
   * Recharge les voies depuis le plan sauvegardé et sélectionne la voie active choisie par
   * `pickActiveIndex`, appelé avec les voies rechargées (leur nombre dépend du plan sauvegardé).
   */
  applySavedPlan(pickActiveIndex: (lanes: readonly LaneDraft[]) => number | undefined): void {
    const lanes = this.loadAttackPlan();
    this.lanesState.set(lanes);
    this.activeLaneIndexState.set(pickActiveIndex(lanes));
    this.refreshAttackBudget();
  }

  /** Supprime toutes les voies en cours de composition (chemins et monstres) ; annule aussi un tracé en cours. */
  resetAttackPlan(): void {
    if (this.gameState.phase() !== 'attack' || this.trial.isRunning()) {
      return;
    }
    if (this.isDrawingPath()) {
      this.cancelTracing();
    }
    this.clearLanes();
    this.messages.set(undefined);
    this.refreshAttackBudget();
  }

  toWave(lanes: readonly LaneDraft[]): Wave {
    return {
      lanes: lanes.map((lane) => ({
        path: lane.path,
        units: lane.units.map((unit) => ({ type: unit.type })),
      })),
    };
  }

  /** Vrai si `coord` tombe sur une case parcourue par `path` (nœuds inclus, segments interpolés). */
  pathContainsCell(path: MapPath, coord: GridCoord): boolean {
    const nodes = path.nodes;
    if (nodes.length === 0) {
      return false;
    }
    const [x0, y0] = nodes[0];
    if (x0 === coord.x && y0 === coord.y) {
      return true;
    }
    for (let i = 1; i < nodes.length; i++) {
      const [ax, ay] = nodes[i - 1];
      const [bx, by] = nodes[i];
      if (
        cellsBetween({ x: ax, y: ay }, { x: bx, y: by }).some(
          (cell) => cell.x === coord.x && cell.y === coord.y,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  /** Avance le tracé libre en cours d'une case tapée (comble automatiquement les cases traversées). */
  handleTracingClick(coord: GridCoord): void {
    const map = this.gameState.map();
    const path = this.drawingPathState();
    if (!map || !path) {
      return;
    }

    if (path.length === 0) {
      if (isSpawnCell(map, coord)) {
        this.drawingPathState.set([coord]);
        this.messages.set('Cliquez des cases jusqu’au château.');
        this.refreshAttackBudget();
        return;
      }
      if (isBorderCell(map, coord) && !isChateauCell(map, coord)) {
        const spawn: MapSpawn = {
          id: `spawn-${this.customSpawnSequence++}`,
          x: coord.x,
          y: coord.y,
        };
        this.gameState.engine.addSpawn(spawn);
        this.gameState.refresh();
        this.drawingPathState.set([coord]);
        this.messages.set('Nouveau spawn créé. Cliquez des cases jusqu’au château.');
        this.refreshAttackBudget();
        return;
      }
      this.messages.set('Le tracé doit démarrer sur une case de spawn ou une case de bord.');
      return;
    }

    const last = path[path.length - 1];
    if (last.x === coord.x && last.y === coord.y) {
      return;
    }

    // Case non adjacente : on comble automatiquement les cases traversées, en contournant les
    // tours et rivières plutôt qu'en traçant la corde droite (CONCEPTION.md §5.3).
    const steps = shortestPath(map, this.gameState.towers(), last, coord);
    if (!steps) {
      this.messages.set('Case inatteignable : aucun chemin libre de tours et rivières.');
      return;
    }
    const filledCells: GridCoord[] = [];
    let reachedChateau = false;
    for (const step of steps) {
      filledCells.push(step);
      if (isChateauCell(map, step)) {
        reachedChateau = true;
        break;
      }
    }

    const nextPath = simplifyPathCells([...path, ...filledCells]);
    if (reachedChateau) {
      const existingPaths = this.lanesState().map((lane) => lane.path);
      if (!hasUniqueCell(nextPath, existingPaths)) {
        this.messages.set(
          'Cette voie chevauche entièrement une autre : annulez le dernier point et changez d’itinéraire.',
        );
        return;
      }
      const newPath: MapPath = {
        id: `custom-${this.customLaneSequence++}`,
        nodes: nextPath.map((p) => [p.x, p.y]),
      };
      // Les cases de chemin sont payantes, dédupliquées avec les voies déjà composées
      // (CONCEPTION.md §5.3) : seules les cases nouvelles pour cette voie sont comptées.
      const addedCellsCost =
        pathCellsCost([...existingPaths, newPath]) - pathCellsCost(existingPaths);
      if (addedCellsCost > this.budget.attack().remaining) {
        this.messages.set(
          'Chemin trop coûteux : budget d’attaque restant insuffisant pour ces cases.',
        );
        return;
      }
      const newLane: LaneDraft = { path: newPath, units: [] };
      this.gameState.engine.addPath(newLane.path);
      const insertAt = this.lanesState().length;
      this.lanesState.update((lanes) => [...lanes, newLane]);
      this.activeLaneIndexState.set(insertAt);
      this.drawingPathState.set(undefined);
      this.boardToolState.set('pan');
      this.messages.set(undefined);
      this.gameState.refresh();
      this.refreshAttackBudget();
      return;
    }
    this.drawingPathState.set(nextPath);
    this.refreshAttackBudget();
  }

  /**
   * Debug : vide les voies en cours de composition et les remplace par la meilleure vague trouvée
   * par l'IA Attaque via l'algorithme génétique (`evolveAttackWave` dans `engine`) — sert à
   * tester l'IA sans composer à la main.
   */
  async addRandomLane(): Promise<void> {
    if (this.gameState.phase() !== 'attack' || this.trial.isRunning() || this.isDrawingPath()) {
      return;
    }
    this.clearLanes();

    const map = this.gameState.map();
    if (!map) {
      this.refreshAttackBudget();
      return;
    }

    const wave = await evolveAttackWave(
      map,
      this.gameState.towers(),
      this.gameState.engine.getAttackBudget(),
      this.gameState.chateauMaxHp(),
      undefined,
      undefined,
      undefined,
      undefined,
      (best, info) => this.showBestSoFar(map, best, info),
    );
    this.materializeWave(map, wave);
  }

  /**
   * Fait jouer l'ordinateur la phase Attaque à la place du joueur (case IA du système de slots) :
   * vide les voies en cours et les remplace par la vague trouvée par `playAttackPhase` (point
   * d'entrée IA officiel, algorithme génétique), avec `maxTime` ms de recherche. Pendant la
   * recherche, la carte affiche déjà la meilleure vague trouvée jusqu'ici (`onBestFound`) plutôt
   * que d'attendre le résultat final.
   */
  async playAiAttackTurn(maxTime: number): Promise<void> {
    this.clearLanes();

    const map = this.gameState.map();
    if (!map) {
      this.refreshAttackBudget();
      return;
    }

    const wave = (await playAttackPhase({
      map,
      towers: this.gameState.towers(),
      attackBudget: this.gameState.engine.getAttackBudget(),
      chateauMaxHp: this.gameState.chateauMaxHp(),
      maxTime,
      onBestFound: (best, info) => this.showBestSoFar(map, best, info),
    })) ?? { lanes: [] };
    this.materializeWave(map, wave);
  }

  /**
   * Affiche sur la carte la meilleure vague trouvée jusqu'ici en cours de recherche IA (rappelé
   * au fil de la recherche, voir `onBestFound`) : vide les voies affichées et les remplace par
   * `wave`, comme le ferait le résultat final (`materializeWave`), mais purge aussi les spawns
   * orphelins qu'un individu précédent aurait pu créer sans route pour les tenir (chaque nouveau
   * meilleur individu n'emprunte pas forcément le même spawn que le précédent). Publie aussi
   * `info` (nombre d'individus notés, score du meilleur) via `BoardMatchService`, pour le HUD
   * debug.
   */
  private showBestSoFar(map: GameMap, wave: Wave, info: ProgressInfo): void {
    this.matchService.reportAiProgress(info);
    this.clearLanes();
    this.gameState.engine.pruneOrphanSpawns();
    this.materializeWave(map, wave);
  }

  /** Vide les voies en cours de composition (chemins retirés de la carte, budget non recalculé). */
  private clearLanes(): void {
    for (const lane of this.lanesState()) {
      this.gameState.engine.removePath(lane.path.id);
    }
    this.lanesState.set([]);
    this.activeLaneIndexState.set(undefined);
    this.gameState.refresh();
  }

  /** Ajoute les voies de `wave` à la carte (spawns manquants, chemins) et les charge en composition. */
  private materializeWave(map: GameMap, wave: Wave): void {
    for (const lane of wave.lanes) {
      const [spawnX, spawnY] = lane.path.nodes[0];
      if (!isSpawnCell(map, { x: spawnX, y: spawnY })) {
        this.gameState.engine.addSpawn({
          id: `spawn-${this.customSpawnSequence++}`,
          x: spawnX,
          y: spawnY,
        });
      }
      this.gameState.engine.addPath(lane.path);
    }
    this.lanesState.set(
      wave.lanes.map((lane) => ({
        path: lane.path,
        units: lane.units.map((unit) => ({ ...unit })),
      })),
    );
    this.activeLaneIndexState.set(wave.lanes.length > 0 ? 0 : undefined);
    this.messages.set(undefined);
    this.gameState.refresh();
    this.refreshAttackBudget();
  }

  /**
   * Vague affichée pour le budget : les voies déjà composées, plus le tracé en cours (sans
   * monstres) pour que le coût de ses cases apparaisse en temps réel pendant le dessin.
   */
  private previewWave(): Wave {
    const wave = this.toWave(this.lanesState());
    const drawingPath = this.drawingPathState();
    if (!drawingPath || drawingPath.length === 0) {
      return wave;
    }
    const tracePath: MapPath = { id: '__tracing__', nodes: drawingPath.map((p) => [p.x, p.y]) };
    return { lanes: [...wave.lanes, { path: tracePath, units: [] }] };
  }

  /** Recalcule le budget d'attaque restant (dépend des voies en cours et du tracé en cours). */
  refreshAttackBudget(): void {
    this.budget.setAttackBudget(
      this.gameState.engine.getAttackBudgetRemaining(this.previewWave()),
      this.gameState.engine.getAttackBudget(),
    );
  }
}
