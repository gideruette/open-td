import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MONSTER_TYPES } from 'shared';
import type { MonsterType } from 'shared';
import { Button } from '../../ui/button/button';
import { ItemButton } from '../../ui/item-button/item-button';
import { formatMonsterStats, laneDisplayLabel, monsterDisplayName } from '../board-format';
import type { LaneDraft } from '../board-types';

/** Détail d'une voie sélectionnée : monstres, retracé, suppression. */
@Component({
  selector: 'otd-lanes-panel',
  imports: [Button, ItemButton],
  templateUrl: './lanes-panel.html',
  styleUrl: './lanes-panel.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LanesPanel {
  readonly lane = input<LaneDraft | undefined>(undefined);
  readonly laneIndex = input<number | undefined>(undefined);
  readonly trialRunning = input(false);
  readonly attackBudgetRemaining = input(0);

  readonly laneRename = output<string>();
  readonly laneRemove = output<void>();
  readonly laneRetrace = output<void>();
  readonly monsterAppend = output<string>();
  readonly unitMove = output<{ unitIndex: number; delta: -1 | 1 }>();
  readonly unitRemove = output<number>();

  protected readonly monsterTypes = MONSTER_TYPES;
  protected readonly formatMonsterStats = formatMonsterStats;
  protected readonly laneDisplayLabel = laneDisplayLabel;
  protected readonly monsterDisplayName = monsterDisplayName;

  protected canAfford(type: MonsterType): boolean {
    return type.cost <= this.attackBudgetRemaining();
  }
}
