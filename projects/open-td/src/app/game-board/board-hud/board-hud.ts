import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  isDevMode,
  viewChild,
} from '@angular/core';
import { TOWER_TYPES } from 'shared';
import type { TowerType } from 'shared';
import { Button } from '../../ui/button/button';
import { BoardBudgetService } from '../board-budget.service';
import { BoardDefenseService } from '../board-defense.service';
import { BoardEngineService } from '../board-engine.service';
import { laneDisplayLabel } from '../board-format';
import { BoardLanesService } from '../board-lanes.service';
import { BoardLayoutService } from '../board-layout.service';
import { BoardMatchService } from '../board-match.service';
import { BoardTrialService } from '../board-trial.service';
import { LanesPanel } from '../lanes-panel/lanes-panel';

/**
 * Panneau de commandes flottant : docké en feuille basse en portrait, en rail latéral droit en
 * paysage compact (`BoardLayoutService.isRailLayout`) pour ne pas dévorer la hauteur, rare dans
 * cette orientation. Son empiètement (hauteur ou largeur selon le dock) est transmis au service
 * de layout pour que la carte se recadre dans l'espace restant plutôt que dessous.
 */
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
  private readonly matchService = inject(BoardMatchService);
  protected readonly defenseService = inject(BoardDefenseService);
  protected readonly lanesService = inject(BoardLanesService);
  protected readonly layout = inject(BoardLayoutService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);

  private readonly panelRef = viewChild<ElementRef<HTMLElement>>('panel');

  protected readonly phase = this.gameState.phase;
  protected readonly trialRunning = this.trial.isRunning;
  /** Qui joue la phase courante (Humain/IA) : affiché à côté des onglets de voies / du bouton debug. */
  protected readonly currentMoverLabel = computed(() =>
    this.matchService.currentMoverKind(this.phase() as 'attack' | 'defense') === 'ai' ? 'IA' : 'Humain',
  );
  /** Vrai si l'IA joue la phase Attaque en cours : le HUD des voies reste replié, l'IA n'en a pas besoin. */
  protected readonly isAiAttack = computed(
    () => this.phase() === 'attack' && this.matchService.currentMoverKind('attack') === 'ai',
  );
  /** Verrouille les actions du HUD pendant une épreuve, le tour de l'IA, ou une fois la partie terminée. */
  protected readonly locked = computed(
    () => this.trialRunning() || this.matchService.isThinking() || this.matchService.isOver(),
  );
  protected readonly drawingPath = this.lanesService.isDrawingPath;
  protected readonly activeLaneIndex = this.lanesService.activeLaneIndex;
  /** Voie active, dont le détail (file de monstres) reste toujours affiché dans le HUD. */
  protected readonly activeLane = this.lanesService.activeLane;
  /** Toutes les voies composées, affichées sous forme d'onglets pour basculer entre elles. */
  protected readonly lanes = this.lanesService.lanes;
  /** Vrai si au moins une voie composée n'a aucun monstre : bloque le lancement (CONCEPTION.md §5.3). */
  protected readonly hasEmptyLane = computed(() => this.lanes().some((lane) => lane.units.length === 0));
  /** Debug (visible en dev uniquement) : score de la vague en cours de composition, calculé à l'avance sans lancer l'épreuve. */
  protected readonly attackScore = computed(() => (isDevMode() ? this.lanesService.attackScore() : undefined));
  /** Debug (visible en dev uniquement) : score de la défense posée contre vagueCourante, calculé à l'avance sans lancer l'épreuve. */
  protected readonly defenseScore = computed(() => (isDevMode() ? this.defenseService.defenseScore() : undefined));
  /** Vie max du château : sert à distinguer un score de succès (très supérieur) d'un score d'échec sans dégât fatal. */
  protected readonly chateauMaxHp = this.gameState.chateauMaxHp;
  /** Vrai tant qu'une case (vide ou occupée) est choisie pour construire/gérer une tour. */
  protected readonly pickingActive = this.defenseService.isPicking;
  /** Vrai si la case choisie porte déjà une tour (propose Supprimer plutôt que Construire). */
  protected readonly pickingHasTower = computed(() => !!this.defenseService.pickingTower());
  /** Type de tour prévisualisé sur la case choisie. */
  protected readonly selectedTypeId = this.defenseService.selectedTypeId;

  protected readonly attackBudgetRemaining = computed(() => this.budget.attack().remaining);

  /**
   * Vrai si au moins un bloc du template a du contenu. Sans ce garde, le panneau se réduit à une
   * barre vide (bordure + fond + padding) pendant les phases sans commande — épreuve rejouée,
   * résolution, tour de l'IA en attaque — et son empiètement continue de rogner la carte.
   */
  protected readonly hasContent = computed(() => {
    if (this.pickingActive()) {
      return true;
    }
    switch (this.phase()) {
      case 'defense':
        return !this.trialRunning();
      case 'attack':
        return this.drawingPath() || (!this.trialRunning() && !this.isAiAttack());
      default:
        return false;
    }
  });

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
    return !this.locked() && !!type && this.isAffordable(type);
  }

  constructor() {
    afterNextRender(() => {
      const panel = this.panelRef()?.nativeElement;
      if (!panel) {
        return;
      }
      // Rail (paysage compact) : le panneau mord sur le bord droit → largeur. Feuille (portrait) :
      // il mord sur le bord bas → hauteur. Un seul bord à la fois, l'autre repasse à 0.
      const measure = () => {
        const rail = this.layout.isRailLayout();
        const size = rail ? panel.offsetWidth : panel.offsetHeight;
        // Taille nulle = panneau masqué (`hasContent` faux) : plus aucun empiètement, la carte
        // reprend toute la place au lieu de se recadrer autour d'une boîte invisible.
        if (size === 0) {
          this.layout.clearInset('hud');
          return;
        }
        this.layout.setInset('hud', rail ? { right: size + 8 } : { bottom: size + 8 });
      };
      const observer = new ResizeObserver(measure);
      observer.observe(panel);
      const layoutEffect = effect(
        () => {
          // Le dock (rail/feuille) et l'affichage du panneau changent sa boîte : re-mesurer.
          // La valeur lue en amont du rendu peut être périmée, l'observateur corrige juste après.
          this.hasContent();
          measure();
        },
        { injector: this.injector },
      );
      this.destroyRef.onDestroy(() => {
        observer.disconnect();
        layoutEffect.destroy();
        this.layout.clearInset('hud');
      });
    });
  }
}
