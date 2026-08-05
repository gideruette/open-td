import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';

export interface LaunchState {
  canLaunch: boolean;
  trialRunning: boolean;
}

const IDLE_STATE: LaunchState = { canLaunch: false, trialRunning: false };

/** État du bouton de lancement (vague de défense ou vague d'attaque), affiché au-dessus du plateau. */
@Injectable()
export class BoardLaunchService {
  private readonly state = signal<LaunchState>(IDLE_STATE);
  readonly value = this.state.asReadonly();

  private readonly requests = new Subject<void>();
  readonly requested = this.requests.asObservable();

  set(canLaunch: boolean, trialRunning: boolean): void {
    this.state.set({ canLaunch, trialRunning });
  }

  requestLaunch(): void {
    if (this.state().canLaunch) {
      this.requests.next();
    }
  }
}
