import { Injectable, computed, signal } from '@angular/core';
import type { DefenseOutcome } from 'engine';
import type { MonsterView } from './board-types';

/**
 * État d'une épreuve en cours (Défense ou Attaque) : vie du château, brèches, monstres affichés
 * et issue. Le déroulement du tick (minuterie, physique des tirs) reste dans `GameBoard`, couplé
 * au rendu canvas ; ce service n'en est que le store, consommé par le plateau et par le HUD.
 */
@Injectable()
export class BoardTrialService {
  private readonly chateauHpState = signal<number | undefined>(undefined);
  private readonly breachCountState = signal<number | undefined>(undefined);
  private readonly monstersState = signal<readonly MonsterView[]>([]);
  private readonly outcomeState = signal<DefenseOutcome | undefined>(undefined);

  readonly chateauHp = this.chateauHpState.asReadonly();
  readonly breachCount = this.breachCountState.asReadonly();
  readonly monsters = this.monstersState.asReadonly();
  readonly outcome = this.outcomeState.asReadonly();

  readonly isRunning = computed(() => this.outcome() === 'pending');

  setChateauHp(hp: number | undefined): void {
    this.chateauHpState.set(hp);
  }

  setBreachCount(count: number | undefined): void {
    this.breachCountState.set(count);
  }

  setMonsters(monsters: readonly MonsterView[]): void {
    this.monstersState.set(monsters);
  }

  setOutcome(outcome: DefenseOutcome | undefined): void {
    this.outcomeState.set(outcome);
  }

  /** Efface l'affichage de l'épreuve (conclusion traitée, retour à l'état neutre). */
  reset(): void {
    this.outcomeState.set(undefined);
    this.monstersState.set([]);
    this.chateauHpState.set(undefined);
    this.breachCountState.set(undefined);
  }
}
