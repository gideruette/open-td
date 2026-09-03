import { Injectable, inject, signal } from '@angular/core';
import { GameEngine, type SimulationCache } from 'engine';
import type { GameMap, GamePhase, StartingData, TowerInstance, Wave } from 'shared';
import { BoardBudgetService } from './board-budget.service';

/**
 * Enveloppe réactive du moteur de jeu pur (`GameEngine`) : état de la run courante (carte, tours
 * posées, phase, palier, vagueCourante, budget de défense) tenu à jour via `refresh()` après
 * chaque action moteur. Segment "état de run" — source de vérité partagée par le plateau et ses
 * sous-composants. (Le budget d'attaque dépend en plus des voies en cours : voir `BoardLanesService`.)
 */
@Injectable()
export class BoardEngineService {
  /** Instance moteur pure (sans DOM) : les autres services l'utilisent pour leurs actions. */
  readonly engine = new GameEngine();

  /**
   * Cache des résultats de simulation (voir `SimulationCache` dans `combat.ts`), partagé entre
   * `BoardLanesService` (IA Attaque) et `BoardDefenseService` (IA Défense) sur toute la durée
   * d'une run : deux tours IA qui retombent sur la même forteresse/vague concrète (même budget,
   * même disposition) évitent de rejouer la simulation. Vidé à chaque `startRun` — une nouvelle
   * run peut changer de carte/catalogue, sur quoi ce cache n'a aucune garantie de validité.
   */
  readonly simulationCache: SimulationCache = new Map();

  private readonly budget = inject(BoardBudgetService);

  private readonly mapState = signal<GameMap | undefined>(undefined);
  private readonly towersState = signal<readonly TowerInstance[]>([]);
  private readonly phaseState = signal<GamePhase>('defense');
  private readonly palierState = signal(1);
  private readonly vagueCouranteState = signal<Wave | undefined>(undefined);
  private readonly chateauMaxHpState = signal(0);

  readonly map = this.mapState.asReadonly();
  readonly towers = this.towersState.asReadonly();
  readonly phase = this.phaseState.asReadonly();
  readonly palier = this.palierState.asReadonly();
  readonly vagueCourante = this.vagueCouranteState.asReadonly();
  readonly chateauMaxHp = this.chateauMaxHpState.asReadonly();

  /** Démarre une nouvelle run sur la carte donnée et synchronise l'état réactif. */
  startRun(map: GameMap, startingData: StartingData): void {
    this.simulationCache.clear();
    this.engine.startRun(map, startingData);
    this.refresh();
  }

  /** Recharge l'état réactif depuis le moteur, à appeler après toute action qui le modifie. */
  refresh(): void {
    this.mapState.set(this.engine.getMap());
    this.towersState.set(this.engine.getTowers());
    this.chateauMaxHpState.set(this.engine.getChateauMaxHp());
    this.phaseState.set(this.engine.getPhase());
    this.palierState.set(this.engine.getPalier());
    this.vagueCouranteState.set(this.engine.getVagueCourante());
    this.budget.setDefenseBudget(this.engine.getRemainingBudget(), this.engine.getDefenseBudget());
  }
}
