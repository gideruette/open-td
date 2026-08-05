import { type AttackPlayerInput } from './ia-attack-player';
import { type DefensePlayerInput } from './ia-defense-player';

export type IaPlayerInput =
  ({ phase: 'attack' } & AttackPlayerInput) | ({ phase: 'defense' } & DefensePlayerInput);

/**
 * Mélange Fisher-Yates (nouveau tableau, sans mutation de `items`) : commun aux deux joueurs IA
 * pour parcourir dans un ordre aléatoire les candidats de pose (case de bord, tour, position).
 */
export function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
