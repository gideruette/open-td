import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { TOWER_TYPES } from 'shared';
import type { GamePhase, TowerType } from 'shared';
import { Button } from '../../ui/button/button';
import { laneDisplayLabel } from '../board-format';
import type { LaneDraft } from '../board-types';

/** Barre de commandes bas : outils contextuels, stats, menus, lancement. */
@Component({
  selector: 'otd-board-hud',
  imports: [Button],
  templateUrl: './board-hud.html',
  styleUrl: './board-hud.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardHud {
  readonly phase = input.required<GamePhase>();
  readonly trialRunning = input(false);
  readonly drawingPath = input(false);
  readonly remainingBudget = input(0);
  readonly defenseBudgetTotal = input(0);
  readonly attackBudgetRemaining = input(0);
  readonly attackBudgetTotal = input(0);
  readonly chateauHp = input(0);
  readonly chateauMaxHp = input(0);
  readonly breachCount = input(0);
  readonly selectedTypeId = input<string | undefined>(undefined);
  readonly lanes = input<readonly LaneDraft[]>([]);
  readonly activeLaneIndex = input<number | undefined>(undefined);
  readonly targetingOpen = input(false);
  readonly canLaunch = input(false);
  readonly message = input<string | undefined>(undefined);

  readonly towerTypeSelect = output<string>();
  readonly laneSelect = output<number>();
  readonly startTracing = output<void>();
  readonly undoTracePoint = output<void>();
  readonly cancelTracing = output<void>();
  readonly targetingToggle = output<void>();
  readonly launch = output<void>();

  protected readonly towerTypes = TOWER_TYPES;
  protected readonly laneDisplayLabel = laneDisplayLabel;

  protected isAffordable(type: TowerType): boolean {
    return type.cost <= this.remainingBudget();
  }
}
