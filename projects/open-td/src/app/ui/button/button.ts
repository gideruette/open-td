import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export type ButtonVariant = 'default' | 'info' | 'success' | 'danger';
export type ButtonSize = 'md' | 'sm';

/** Bouton d'action générique : seul point de vérité pour la charte graphique des boutons. */
@Component({
  selector: 'otd-button',
  imports: [],
  templateUrl: './button.html',
  styleUrl: './button.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Button {
  readonly variant = input<ButtonVariant>('default');
  readonly size = input<ButtonSize>('md');
  readonly disabled = input(false);
  readonly ariaLabel = input<string | undefined>(undefined);

  readonly clicked = output<MouseEvent>();
}
