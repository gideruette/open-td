import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import type { GamePhase, Wave } from 'shared';
import { BoardBudgetService } from '../board-budget.service';
import { describeWave } from '../board-format';
import { BoardLaunch } from '../board-launch/board-launch';
import { BoardReset } from '../board-reset/board-reset';

/** Pastille de phase en haut du plateau (palier + vague courte + budget + lancement + réinitialisation). */
@Component({
  selector: 'otd-board-status',
  imports: [BoardLaunch, BoardReset],
  templateUrl: './board-status.html',
  styleUrl: './board-status.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardStatus {
  readonly phase = input.required<GamePhase>();
  readonly palier = input.required<number>();
  readonly vagueCourante = input<Wave | undefined>(undefined);
  readonly trialRunning = input(false);

  /** Réinitialise toute la défense (phase Défense) ou tout le plan d'attaque (phase Attaque). */
  readonly reset = output<void>();

  private readonly budgetService = inject(BoardBudgetService);
  protected readonly budget = computed(() =>
    this.phase() === 'defense' ? this.budgetService.defense() : this.budgetService.attack(),
  );
  protected readonly resetLabel = computed(() =>
    this.phase() === 'defense' ? 'Réinitialiser la défense' : "Réinitialiser l'attaque",
  );

  protected readonly describeWave = describeWave;
}
