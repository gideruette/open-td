import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { GamePhase, Wave } from 'shared';
import { describeWave } from '../board-format';

/** Pastille de phase en haut du plateau (palier + vague courte). */
@Component({
  selector: 'otd-board-status',
  templateUrl: './board-status.html',
  styleUrl: './board-status.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardStatus {
  readonly phase = input.required<GamePhase>();
  readonly palier = input.required<number>();
  readonly vagueCourante = input<Wave | undefined>(undefined);

  protected readonly describeWave = describeWave;
}
