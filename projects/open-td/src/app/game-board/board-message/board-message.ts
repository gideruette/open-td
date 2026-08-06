import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
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

  /** Repli affiché tant qu'aucun message explicite n'est en cours (ex. indication d'action attendue). */
  readonly fallback = input<string | undefined>(undefined);

  protected readonly message = this.messages.value;
  protected readonly displayed = computed(() => this.message() ?? this.fallback());

  protected dismiss(): void {
    this.messages.clear();
  }
}
