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

/** Nombre d'individus notés et score du meilleur d'entre eux trouvé jusqu'ici — voir `ProgressReporter`. */
export interface ProgressInfo {
  iterations: number;
  score: number;
  /** Taux de hits `[0, 1]` du `simulationCache` de la recherche — `undefined` si aucun cache fourni. */
  cacheHitRate?: number;
}

/**
 * Publie la meilleure solution trouvée jusqu'ici et relâche la boucle événementielle (un
 * macro-tick, `setTimeout`) pour laisser l'UI la peindre — commun aux boucles d'évolution
 * `evolveAttackWave`/`evolveDefense`. Créé une seule fois par recherche (`createProgressReporter`)
 * : l'essentiel du calcul s'y déroule en réalité pendant la notation de la population initiale
 * (jusqu'à `2 * populationSize` individus, potentiellement des centaines) plutôt qu'entre deux
 * générations — c'est pourquoi `report` doit pouvoir être appelé à la volée pendant qu'un lot
 * d'individus se fait noter (voir `fittestWaves`/`fittestDefenses`), pas seulement à la fin de
 * chaque génération.
 */
export interface ProgressReporter<T> {
  report(best: T, info: ProgressInfo): Promise<void>;
}

/**
 * Intervalle minimal (ms) entre deux publications de la meilleure solution courante (~60 fps) :
 * au-delà, publier plus souvent ne serait pas perceptible à l'écran et ne ferait que voler du
 * temps de calcul à l'algorithme génétique.
 */
const UI_REPORT_INTERVAL_MS = 16;

/**
 * Fabrique un `ProgressReporter` pour une recherche `evolveAttackWave`/`evolveDefense`. Sans
 * callback (`onBestFound` non fourni), `report` ne fait jamais rien — la recherche reste alors
 * aussi rapide qu'avant l'introduction de ce mécanisme.
 */
export function createProgressReporter<T>(
  onBestFound: ((best: T, info: ProgressInfo) => void) | undefined,
): ProgressReporter<T> {
  let lastReport = 0;
  return {
    async report(best, info) {
      if (!onBestFound || Date.now() - lastReport < UI_REPORT_INTERVAL_MS) {
        return;
      }
      onBestFound(best, info);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      lastReport = Date.now();
    },
  };
}
