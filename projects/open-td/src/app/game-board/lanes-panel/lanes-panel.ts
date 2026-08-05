import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { MONSTER_TYPES } from 'shared';
import type { MonsterType } from 'shared';
import { Button } from '../../ui/button/button';
import { ItemButton } from '../../ui/item-button/item-button';
import { BoardBudgetService } from '../board-budget.service';
import { laneDisplayLabel, monsterDescription, monsterDisplayName } from '../board-format';
import { BoardLanesService } from '../board-lanes.service';
import { BoardTrialService } from '../board-trial.service';

/** Détail de la voie active : file de monstres, ajout à la position du curseur, suppression. */
@Component({
  selector: 'otd-lanes-panel',
  imports: [Button, ItemButton],
  templateUrl: './lanes-panel.html',
  styleUrl: './lanes-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LanesPanel {
  private readonly lanesService = inject(BoardLanesService);
  private readonly budget = inject(BoardBudgetService);
  private readonly trial = inject(BoardTrialService);

  /** Toujours montée uniquement quand une voie est active (voir board-hud) : file toujours renseignée. */
  protected readonly lane = computed(() => this.lanesService.activeLane()!);
  protected readonly laneIndex = computed(() => this.lanesService.activeLaneIndex()!);
  protected readonly trialRunning = this.trial.isRunning;
  protected readonly attackBudgetRemaining = computed(() => this.budget.attack().remaining);

  /** Exclut les monstres internes (ex. progéniture d'une scission), non composables directement dans une voie. */
  protected readonly monsterTypes = MONSTER_TYPES.filter((type) => !type.internal);
  protected readonly laneDisplayLabel = laneDisplayLabel;
  protected readonly monsterDisplayName = monsterDisplayName;
  protected readonly monsterDescription = monsterDescription;

  /** Monstre de la file cliqué : tant qu'il est défini, remplace les boutons d'ajout par déplacer/supprimer. */
  private readonly rawSelectedUnitIndex = signal<number | undefined>(undefined);
  protected readonly selectedUnitIndex = computed<number | undefined>(() => {
    const unitIndex = this.rawSelectedUnitIndex();
    const length = this.lane().units.length;
    return unitIndex !== undefined && unitIndex < length ? unitIndex : undefined;
  });

  /** Position (curseur) où atterrit le prochain monstre ajouté ; par défaut tout au début de la file. */
  private readonly rawCursorIndex = signal(0);
  protected readonly cursorIndex = computed(() => Math.min(this.rawCursorIndex(), this.lane().units.length));

  constructor() {
    // Changer de voie abandonne la sélection/curseur en cours (ils n'ont plus de sens sur une autre file).
    effect(() => {
      this.laneIndex();
      this.rawSelectedUnitIndex.set(undefined);
      this.rawCursorIndex.set(0);
    });
  }

  protected canAfford(type: MonsterType): boolean {
    return type.cost <= this.attackBudgetRemaining();
  }

  protected setCursor(atIndex: number): void {
    this.rawCursorIndex.set(atIndex);
  }

  protected appendAtCursor(typeId: string): void {
    const atIndex = this.cursorIndex();
    this.lanesService.appendMonster({ typeId, atIndex });
    this.rawCursorIndex.set(atIndex + 1);
  }

  protected selectUnit(unitIndex: number): void {
    this.rawSelectedUnitIndex.update((current) => (current === unitIndex ? undefined : unitIndex));
  }

  protected moveSelected(direction: -1 | 1): void {
    const unitIndex = this.selectedUnitIndex();
    if (unitIndex === undefined) {
      return;
    }
    const target = unitIndex + direction;
    if (target < 0 || target >= this.lane().units.length) {
      return;
    }
    this.lanesService.moveActiveQueueUnit(unitIndex, direction);
    this.rawSelectedUnitIndex.set(target);
  }

  protected removeSelected(): void {
    const unitIndex = this.selectedUnitIndex();
    if (unitIndex === undefined) {
      return;
    }
    this.lanesService.removeActiveQueueUnit(unitIndex);
    this.rawSelectedUnitIndex.set(undefined);
  }

  protected renameLane(rawName: string): void {
    this.lanesService.renameActiveLane(rawName);
  }
}
