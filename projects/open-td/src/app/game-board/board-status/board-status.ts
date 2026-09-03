import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  afterNextRender,
  computed,
  inject,
  viewChild,
} from '@angular/core';
import { BoardAiSolution } from '../board-ai-solution/board-ai-solution';
import { BoardBudgetService } from '../board-budget.service';
import { BoardDefenseService } from '../board-defense.service';
import { BoardEngineService } from '../board-engine.service';
import { BoardLanesService } from '../board-lanes.service';
import { BoardLaunch } from '../board-launch/board-launch';
import { BoardLayoutService } from '../board-layout.service';
import { BoardMatchService } from '../board-match.service';
import { BoardReset } from '../board-reset/board-reset';
import { BoardTrialService } from '../board-trial.service';

/**
 * Pastille de phase compacte (haut-gauche : palier + budget) et cluster d'actions flottant
 * (bas-droite : réinitialisation, IA, lancement) — deux overlays distincts plutôt qu'un seul
 * panneau centré, pour ne jamais recouvrir le centre de la carte sur petit écran.
 */
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
  private readonly matchService = inject(BoardMatchService);
  private readonly layout = inject(BoardLayoutService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly chipRef = viewChild<ElementRef<HTMLElement>>('chip');

  protected readonly phase = this.gameState.phase;
  protected readonly palier = this.gameState.palier;
  protected readonly vagueCourante = this.gameState.vagueCourante;

  protected readonly phaseLabel = computed(() =>
    this.phase() === 'defense' ? 'Chevaliers' : 'Monstres',
  );

  protected readonly budget = computed(() =>
    this.phase() === 'defense' ? this.budgetService.defense() : this.budgetService.attack(),
  );
  protected readonly resetLabel = computed(() =>
    this.phase() === 'defense' ? 'Réinitialiser les Chevaliers' : 'Réinitialiser les Monstres',
  );
  /** Masqué pendant qu'une épreuve tourne ou que l'IA joue la phase courante : aucune des deux ne se réinitialise. */
  protected readonly resetVisible = computed(() => {
    if (this.trial.isRunning()) {
      return false;
    }
    const phase = this.phase();
    return phase === 'resolution' || this.matchService.currentMoverKind(phase) !== 'ai';
  });

  /** Décalage (px) du cluster d'actions pour ne jamais chevaucher le HUD (feuille basse ou rail latéral). */
  protected readonly actionsOffset = computed(() => {
    const insets = this.layout.insets();
    return { right: insets.right + 12, bottom: insets.bottom + 12 };
  });

  constructor() {
    afterNextRender(() => {
      const chip = this.chipRef()?.nativeElement;
      if (!chip) {
        return;
      }
      const observer = new ResizeObserver(() => {
        // La pastille flotte depuis le haut (top: safe-area + gap) : son empiètement inclut ce décalage.
        this.layout.setInset('status', { top: chip.offsetTop + chip.offsetHeight + 8 });
      });
      observer.observe(chip);
      this.destroyRef.onDestroy(() => {
        observer.disconnect();
        this.layout.clearInset('status');
      });
    });
  }

  /** Réinitialise toute la défense (phase Défense) ou tout le plan d'attaque (phase Attaque). */
  protected onReset(): void {
    if (this.phase() === 'defense') {
      this.defenseService.resetSession();
      return;
    }
    this.lanesService.resetAttackPlan();
  }
}
