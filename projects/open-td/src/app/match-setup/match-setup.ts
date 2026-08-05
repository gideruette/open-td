import { ChangeDetectionStrategy, Component, computed, output, signal } from '@angular/core';
import type { MatchSlots, PlayerKind } from '../game-board/board-types';
import { Button } from '../ui/button/button';

const ROLE_LABEL: Record<'attack' | 'defense', string> = {
  attack: 'Attaque',
  defense: 'Défense',
};

/**
 * Écran de configuration de la partie : deux slots (Attaque / Défense), chacun réglable sur
 * Humain ou IA. Le mode (Humain vs Humain / Humain vs IA) est dérivé des slots plutôt que choisi
 * séparément ; au plus un slot peut être IA (impossible de jouer IA vs IA — CONCEPTION.md §pas
 * encore documenté, voir la demande utilisateur).
 */
@Component({
  selector: 'otd-match-setup',
  imports: [Button],
  templateUrl: './match-setup.html',
  styleUrl: './match-setup.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MatchSetup {
  private readonly slotsState = signal<MatchSlots>({ attack: 'human', defense: 'human' });

  protected readonly slots = this.slotsState.asReadonly();
  protected readonly roleLabel = ROLE_LABEL;

  protected readonly modeLabel = computed(() => {
    const current = this.slotsState();
    return current.attack === 'ai' || current.defense === 'ai' ? 'Humain vs IA' : 'Humain vs Humain';
  });

  readonly slotsChosen = output<MatchSlots>();

  /** Bascule Humain ↔ IA sur ce slot ; passer un slot à IA repasse l'autre à Humain (jamais IA vs IA). */
  protected toggleSlot(role: 'attack' | 'defense'): void {
    this.slotsState.update((current) => {
      const next: PlayerKind = current[role] === 'human' ? 'ai' : 'human';
      if (next === 'ai') {
        return role === 'attack' ? { attack: 'ai', defense: 'human' } : { attack: 'human', defense: 'ai' };
      }
      return { ...current, [role]: 'human' };
    });
  }

  protected start(): void {
    this.slotsChosen.emit(this.slotsState());
  }
}
