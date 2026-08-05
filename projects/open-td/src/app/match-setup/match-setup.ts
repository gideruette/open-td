import { ChangeDetectionStrategy, Component, computed, output, signal } from '@angular/core';
import type { MatchSlots, PlayerKind } from '../game-board/board-types';
import { Button } from '../ui/button/button';

const ROLE_LABEL: Record<'attack' | 'defense', string> = {
  attack: 'Monstres',
  defense: 'Chevaliers',
};

/**
 * Écran de configuration de la partie : deux slots (Attaque / Défense), chacun sélectionnable
 * indépendamment. Sélectionné = joueur humain, désélectionné = IA. On ne peut pas désélectionner
 * les deux camps à la fois (impossible de jouer IA vs IA) ; les deux sont sélectionnés par défaut
 * (Humain vs Humain).
 */
@Component({
  selector: 'otd-match-setup',
  imports: [Button],
  templateUrl: './match-setup.html',
  styleUrl: './match-setup.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MatchSetup {
  private readonly slotsState = signal<MatchSlots>({ attack: 'ai', defense: 'ai' });

  protected readonly slots = this.slotsState.asReadonly();
  protected readonly roleLabel = ROLE_LABEL;

  protected readonly modeLabel = computed(() => {
    const current = this.slotsState();
    return current.attack === 'ai' && current.defense === 'ai'
      ? 'IA VS IA'
      : current.attack === 'ai' || current.defense === 'ai'
        ? 'Humain vs IA'
        : 'Humain vs Humain';
  });

  readonly slotsChosen = output<MatchSlots>();

  /** Sélectionne/désélectionne ce camp (Humain ↔ IA) ; refuse de désélectionner les deux camps. */
  protected toggleSlot(role: 'attack' | 'defense'): void {
    this.slotsState.update((current) => {
      const other: 'attack' | 'defense' = role === 'attack' ? 'defense' : 'attack';
      const next: PlayerKind = current[role] === 'human' ? 'ai' : 'human';
      if (next === 'ai' && current[other] === 'ai') {
        return current;
      }
      return { ...current, [role]: next };
    });
  }

  protected start(): void {
    this.slotsChosen.emit(this.slotsState());
  }
}
