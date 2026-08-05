import { Injectable, computed, signal } from '@angular/core';
import type { MatchSlots, PlayerKind } from './board-types';

/** Temps (ms) alloué à l'IA pour trouver une solution avant qu'on la considère en échec. */
export const AI_THINK_TIME_MS = 2000;

/**
 * Issue d'une partie contre l'IA : le rôle dont l'IA n'a pas trouvé de solution à temps
 * (`failedRole`) a perdu, l'autre rôle (forcément humain, l'IA vs IA étant impossible) l'emporte.
 */
export interface MatchOutcome {
  winnerRole: 'attack' | 'defense';
  failedRole: 'attack' | 'defense';
}

/**
 * État de la partie en cours indépendant de la forteresse/vague (`BoardEngineService`) : qui joue
 * Attaque/Défense (`slots`), si l'IA est en train de calculer son coup (`isThinking`), et l'issue
 * de la partie une fois qu'une IA a échoué à trouver une solution à temps (`outcome`).
 */
@Injectable()
export class BoardMatchService {
  private readonly slotsState = signal<MatchSlots>({ attack: 'human', defense: 'human' });
  private readonly outcomeState = signal<MatchOutcome | undefined>(undefined);
  private readonly thinkingState = signal(false);

  readonly slots = this.slotsState.asReadonly();
  readonly outcome = this.outcomeState.asReadonly();
  readonly isThinking = this.thinkingState.asReadonly();

  /** Vrai une fois qu'un vainqueur a été déclaré (IA en échec) : la partie est terminée. */
  readonly isOver = computed(() => this.outcomeState() !== undefined);

  /** (Ré)initialise la partie avec ces slots : à appeler au démarrage d'une run. */
  configure(slots: MatchSlots): void {
    this.slotsState.set(slots);
    this.outcomeState.set(undefined);
    this.thinkingState.set(false);
  }

  /** Qui joue le rôle donné (Attaque ou Défense). */
  currentMoverKind(role: 'attack' | 'defense'): PlayerKind {
    return this.slotsState()[role];
  }

  setThinking(value: boolean): void {
    this.thinkingState.set(value);
  }

  /** Déclare la fin de la partie : l'IA du rôle `failedRole` n'a pas trouvé de solution à temps. */
  declareVictory(failedRole: 'attack' | 'defense'): void {
    this.outcomeState.set({
      failedRole,
      winnerRole: failedRole === 'attack' ? 'defense' : 'attack',
    });
  }
}
