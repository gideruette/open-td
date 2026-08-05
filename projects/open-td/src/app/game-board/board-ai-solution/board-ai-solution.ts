import { ChangeDetectionStrategy, Component, computed, inject, isDevMode } from '@angular/core';
import { BoardDefenseService } from '../board-defense.service';
import { BoardEngineService } from '../board-engine.service';
import { BoardLanesService } from '../board-lanes.service';
import { BoardMatchService } from '../board-match.service';
import { BoardTrialService } from '../board-trial.service';

/**
 * Bouton debug (visible en dev uniquement, `isDevMode()` — désactivé par la CLI en `ng build`
 * production) affiché à côté du triangle de lancement : remplace la voie/défense en cours par la
 * meilleure solution trouvée par l'IA génétique (`evolveAttackWave`/`evolveDefense`), sans jouer à
 * la place du joueur.
 */
@Component({
  selector: 'otd-board-ai-solution',
  templateUrl: './board-ai-solution.html',
  styleUrl: './board-ai-solution.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardAiSolution {
  private readonly gameState = inject(BoardEngineService);
  private readonly matchService = inject(BoardMatchService);
  private readonly trial = inject(BoardTrialService);
  private readonly defenseService = inject(BoardDefenseService);
  private readonly lanesService = inject(BoardLanesService);

  protected readonly phase = this.gameState.phase;

  protected readonly visible = computed(() => {
    if (!isDevMode() || this.matchService.isOver() || this.trial.isRunning()) {
      return false;
    }
    return this.phase() !== 'attack' || !this.lanesService.isDrawingPath();
  });

  protected readonly disabled = computed(() => this.matchService.isThinking());

  protected readonly title = computed(() =>
    this.phase() === 'defense'
      ? 'Debug : générer une défense IA (remplace les tours posées)'
      : 'Debug : générer une vague IA (remplace les voies actuelles)',
  );

  protected onClick(): void {
    if (this.phase() === 'defense') {
      this.defenseService.addRandomDefense();
      return;
    }
    this.lanesService.addRandomLane();
  }
}
