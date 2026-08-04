import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { TowerInstance } from 'shared';
import { Button } from '../../ui/button/button';

/** Actions sur la tour sélectionnée (déplacer / supprimer). */
@Component({
  selector: 'otd-tower-actions',
  imports: [Button],
  templateUrl: './tower-actions.html',
  styleUrl: './tower-actions.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TowerActions {
  readonly tower = input<TowerInstance | undefined>(undefined);
  readonly moving = input(false);
  readonly trialRunning = input(false);

  readonly startMove = output<void>();
  readonly cancelMove = output<void>();
  readonly remove = output<void>();
  readonly reset = output<void>();
}
