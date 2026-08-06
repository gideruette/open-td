import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, output, signal } from '@angular/core';
import { Button } from '../../ui/button/button';

/** Bouton de réinitialisation (défense ou attaque selon la phase) : ouvre un panneau de confirmation avant d'agir. */
@Component({
  selector: 'otd-board-reset',
  imports: [Button],
  templateUrl: './board-reset.html',
  styleUrl: './board-reset.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardReset {
  readonly disabled = input(false);
  readonly label = input('Réinitialiser');

  readonly confirm = output<void>();

  protected readonly open = signal(false);

  constructor() {
    // Changer de libellé (phase défense/attaque) ou désactiver le bouton referme un panneau ouvert :
    // sans ça il restait affiché pour la mauvaise action après un changement de contexte.
    effect(() => {
      this.label();
      this.disabled();
      this.open.set(false);
    });
    inject(DestroyRef).onDestroy(() => this.open.set(false));
  }

  protected onClick(): void {
    if (this.disabled()) {
      return;
    }
    this.open.set(true);
  }

  protected onCancel(): void {
    this.open.set(false);
  }

  protected onConfirm(): void {
    this.open.set(false);
    this.confirm.emit();
  }
}
