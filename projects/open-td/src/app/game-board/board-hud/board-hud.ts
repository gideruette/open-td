import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { TOWER_TYPES } from 'shared';
import type { GamePhase, TowerType } from 'shared';
import { Button } from '../../ui/button/button';
import { BoardBudgetService } from '../board-budget.service';
import { laneDisplayLabel } from '../board-format';
import type { LaneDraft } from '../board-types';
import { LanesPanel, type MonsterAppendEvent } from '../lanes-panel/lanes-panel';

/** Barre de commandes bas : outils contextuels, détail de la voie active. */
@Component({
  selector: 'otd-board-hud',
  imports: [Button, LanesPanel],
  templateUrl: './board-hud.html',
  styleUrl: './board-hud.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardHud {
  readonly phase = input.required<GamePhase>();
  readonly trialRunning = input(false);
  readonly drawingPath = input(false);
  readonly breachCount = input(0);
  readonly activeLaneIndex = input<number | undefined>(undefined);
  /** Voie active, dont le détail (file de monstres) reste toujours affiché dans le HUD. */
  readonly activeLane = input<LaneDraft | undefined>(undefined);
  /** Toutes les voies composées, affichées sous forme d'onglets pour basculer entre elles. */
  readonly lanes = input<readonly LaneDraft[]>([]);
  /** Vrai tant qu'une case (vide ou occupée) est choisie pour construire/gérer une tour. */
  readonly pickingActive = input(false);
  /** Vrai si la case choisie porte déjà une tour (propose Supprimer plutôt que Construire). */
  readonly pickingHasTower = input(false);
  /** Type de tour prévisualisé sur la case choisie. */
  readonly selectedTypeId = input<string | undefined>(undefined);

  readonly startTracing = output<void>();
  readonly undoTracePoint = output<void>();
  readonly cancelTracing = output<void>();
  readonly typeSelect = output<string>();
  readonly confirmPlace = output<void>();
  readonly deleteTower = output<void>();
  readonly laneSelect = output<number>();
  readonly laneRename = output<string>();
  readonly laneRemove = output<void>();
  readonly monsterAppend = output<MonsterAppendEvent>();
  readonly unitMove = output<{ unitIndex: number; delta: -1 | 1 }>();
  readonly unitRemove = output<number>();

  private readonly budget = inject(BoardBudgetService);
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
