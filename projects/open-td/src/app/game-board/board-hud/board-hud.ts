import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TOWER_TYPES } from 'shared';
import type { TowerType } from 'shared';
import { Button } from '../../ui/button/button';
import { BoardBudgetService } from '../board-budget.service';
import { BoardDefenseService } from '../board-defense.service';
import { BoardEngineService } from '../board-engine.service';
import { laneDisplayLabel } from '../board-format';
import { BoardLanesService } from '../board-lanes.service';
import { BoardTrialService } from '../board-trial.service';
import { LanesPanel } from '../lanes-panel/lanes-panel';

/** Barre de commandes bas : outils contextuels, détail de la voie active. */
@Component({
  selector: 'otd-board-hud',
  imports: [Button, LanesPanel],
  templateUrl: './board-hud.html',
  styleUrl: './board-hud.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardHud {
  private readonly gameState = inject(BoardEngineService);
  private readonly trial = inject(BoardTrialService);
  private readonly budget = inject(BoardBudgetService);
  protected readonly defenseService = inject(BoardDefenseService);
  protected readonly lanesService = inject(BoardLanesService);

  protected readonly phase = this.gameState.phase;
  protected readonly trialRunning = this.trial.isRunning;
  protected readonly drawingPath = this.lanesService.isDrawingPath;
  protected readonly activeLaneIndex = this.lanesService.activeLaneIndex;
  /** Voie active, dont le détail (file de monstres) reste toujours affiché dans le HUD. */
  protected readonly activeLane = this.lanesService.activeLane;
  /** Toutes les voies composées, affichées sous forme d'onglets pour basculer entre elles. */
  protected readonly lanes = this.lanesService.lanes;
  /** Vrai tant qu'une case (vide ou occupée) est choisie pour construire/gérer une tour. */
  protected readonly pickingActive = this.defenseService.isPicking;
  /** Vrai si la case choisie porte déjà une tour (propose Supprimer plutôt que Construire). */
  protected readonly pickingHasTower = computed(() => !!this.defenseService.pickingTower());
  /** Type de tour prévisualisé sur la case choisie. */
  protected readonly selectedTypeId = this.defenseService.selectedTypeId;

  protected readonly attackBudgetRemaining = computed(() => this.budget.attack().remaining);

  protected readonly towerTypes = TOWER_TYPES;
  protected readonly laneDisplayLabel = laneDisplayLabel;

  protected readonly selectedType = computed<TowerType | undefined>(() =>
    this.towerTypes.find((type) => type.id === this.selectedTypeId()),
  );

  protected isAffordable(type: TowerType): boolean {
    return type.cost <= this.budget.defense().remaining;
  }

  protected canConfirmPlace(): boolean {
    const type = this.selectedType();
    return !this.trialRunning() && !!type && this.isAffordable(type);
  }
}
