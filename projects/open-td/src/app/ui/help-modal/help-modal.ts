import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** Fenêtre modale présentant les règles du jeu, ouverte depuis le bouton d'aide. */
@Component({
  selector: 'otd-help-modal',
  imports: [],
  templateUrl: './help-modal.html',
  styleUrl: './help-modal.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HelpModal {
  readonly open = input(false);

  readonly closed = output<void>();

  protected close(): void {
    this.closed.emit();
  }
}
