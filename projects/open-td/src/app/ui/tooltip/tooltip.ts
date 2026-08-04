import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/** Une ligne de caractéristique affichée dans une infobulle (ex. { label: 'Portée', value: '3' }). */
export interface TooltipStat {
  label: string;
  value: string;
}

/** Infobulle générique (titre + description + caractéristiques) partagée par tours et monstres. */
@Component({
  selector: 'otd-tooltip',
  imports: [],
  templateUrl: './tooltip.html',
  styleUrl: './tooltip.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Tooltip {
  readonly heading = input.required<string>();
  readonly description = input<string>();
  readonly stats = input<readonly TooltipStat[]>([]);
}
