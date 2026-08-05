import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { BoardMessageService } from '../board-message.service';

/** Message de statut/erreur affiché au-dessus de la carte. */
@Component({
  selector: 'otd-board-message',
  templateUrl: './board-message.html',
  styleUrl: './board-message.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardMessage {
  private readonly messages = inject(BoardMessageService);

  protected readonly message = this.messages.value;

  protected dismiss(): void {
    this.messages.clear();
  }
}
