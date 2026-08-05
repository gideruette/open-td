import { Injectable, signal } from '@angular/core';

/** État du message de statut/erreur affiché au-dessus du plateau (voir `BoardMessage`). */
@Injectable()
export class BoardMessageService {
  private readonly state = signal<string | undefined>(undefined);
  readonly value = this.state.asReadonly();

  set(message: string | undefined): void {
    this.state.set(message);
  }

  clear(): void {
    this.state.set(undefined);
  }
}
