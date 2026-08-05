import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';
import { MONSTER_TYPES } from 'shared';
import type { MonsterType } from 'shared';
import { Button } from '../../ui/button/button';
import { ItemButton } from '../../ui/item-button/item-button';
import { formatMonsterStats, laneDisplayLabel, monsterDisplayName } from '../board-format';
import type { LaneDraft } from '../board-types';

/** Position d'insertion d'un nouveau monstre dans la file (curseur) + type ajouté. */
export interface MonsterAppendEvent {
  typeId: string;
  atIndex: number;
}

/** Détail d'une voie sélectionnée : file de monstres, ajout à la position du curseur, suppression. */
@Component({
  selector: 'otd-lanes-panel',
  imports: [Button, ItemButton],
  templateUrl: './lanes-panel.html',
  styleUrl: './lanes-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LanesPanel {
  /** Toujours montée uniquement quand une voie est active (voir board-hud) : file toujours renseignée. */
  readonly lane = input.required<LaneDraft>();
  readonly laneIndex = input.required<number>();
  readonly trialRunning = input(false);
  readonly attackBudgetRemaining = input(0);

  readonly laneRename = output<string>();
  readonly monsterAppend = output<MonsterAppendEvent>();
  readonly unitMove = output<{ unitIndex: number; delta: -1 | 1 }>();
  readonly unitRemove = output<number>();

  protected readonly monsterTypes = MONSTER_TYPES;
  protected readonly formatMonsterStats = formatMonsterStats;
  protected readonly laneDisplayLabel = laneDisplayLabel;
  protected readonly monsterDisplayName = monsterDisplayName;

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
    this.monsterAppend.emit({ typeId, atIndex });
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
    this.unitMove.emit({ unitIndex, delta: direction });
    this.rawSelectedUnitIndex.set(target);
  }

  protected removeSelected(): void {
    const unitIndex = this.selectedUnitIndex();
    if (unitIndex === undefined) {
      return;
    }
    this.unitRemove.emit(unitIndex);
    this.rawSelectedUnitIndex.set(undefined);
  }
}
