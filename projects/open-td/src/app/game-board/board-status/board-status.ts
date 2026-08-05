import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { BoardAiSolution } from '../board-ai-solution/board-ai-solution';
import { BoardBudgetService } from '../board-budget.service';
import { BoardDefenseService } from '../board-defense.service';
import { BoardEngineService } from '../board-engine.service';
import { BoardLanesService } from '../board-lanes.service';
import { BoardLaunch } from '../board-launch/board-launch';
import { BoardReset } from '../board-reset/board-reset';
import { BoardTrialService } from '../board-trial.service';

/** Pastille de phase en haut du plateau (palier + vague courte + budget + lancement + réinitialisation). */
@Component({
  selector: 'otd-board-status',
  imports: [BoardAiSolution, BoardLaunch, BoardReset],
  templateUrl: './board-status.html',
  styleUrl: './board-status.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardStatus {
  private readonly gameState = inject(BoardEngineService);
  private readonly defenseService = inject(BoardDefenseService);
  private readonly lanesService = inject(BoardLanesService);
  private readonly budgetService = inject(BoardBudgetService);
  private readonly trial = inject(BoardTrialService);

  protected readonly phase = this.gameState.phase;
  protected readonly palier = this.gameState.palier;
  protected readonly vagueCourante = this.gameState.vagueCourante;
  protected readonly trialRunning = this.trial.isRunning;

  protected readonly budget = computed(() =>
    this.phase() === 'defense' ? this.budgetService.defense() : this.budgetService.attack(),
  );
  protected readonly resetLabel = computed(() =>
    this.phase() === 'defense' ? 'Réinitialiser la défense' : "Réinitialiser l'attaque",
  );

  /** Réinitialise toute la défense (phase Défense) ou tout le plan d'attaque (phase Attaque). */
  protected onReset(): void {
    if (this.phase() === 'defense') {
      this.defenseService.resetSession();
      return;
    }
    this.lanesService.resetAttackPlan();
  }
}
