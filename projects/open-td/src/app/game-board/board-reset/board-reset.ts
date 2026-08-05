import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

/** Bouton de réinitialisation (défense ou attaque selon la phase) : un premier clic arme la confirmation, le second déclenche l'action. */
@Component({
  selector: 'otd-board-reset',
  templateUrl: './board-reset.html',
  styleUrl: './board-reset.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardReset {
  readonly disabled = input(false);
  readonly label = input('Réinitialiser');

  readonly confirm = output<void>();

  protected readonly confirming = signal(false);

  protected onClick(): void {
    if (this.disabled()) {
      return;
    }
    if (this.confirming()) {
      this.confirming.set(false);
      this.confirm.emit();
      return;
    }
    this.confirming.set(true);
  }
}
