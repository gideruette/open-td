import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { Button } from '../../ui/button/button';
import type { MatchOutcome } from '../board-match.service';

const ROLE_LABEL: Record<'attack' | 'defense', string> = {
  attack: 'Attaque',
  defense: 'Défense',
};

/** Écran de fin de partie : l'IA d'un rôle n'a pas trouvé de solution à temps, l'autre l'emporte. */
@Component({
  selector: 'otd-board-match-result',
  imports: [Button],
  templateUrl: './board-match-result.html',
  styleUrl: './board-match-result.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardMatchResult {
  readonly outcome = input.required<MatchOutcome>();
  readonly restart = output<void>();
  readonly inspect = output<void>();

  protected readonly winnerLabel = computed(() => ROLE_LABEL[this.outcome().winnerRole]);
  protected readonly failedLabel = computed(() => ROLE_LABEL[this.outcome().failedRole]);
}
