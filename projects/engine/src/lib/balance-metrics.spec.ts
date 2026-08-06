import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BALANCE_OPTIONS,
  formatBalanceReport,
  playBalanceRun,
  type RunMetrics,
} from './balance-harness';

/**
 * Harnais de mesure d'équilibre (campagne courte). Le cœur vit dans `balance-harness.ts` ;
 * les campagnes lourdes passent par le runner parallèle :
 *
 *   npm run balance -- --runs 100 --workers 8
 *
 * Le rapport passe par `console.log`, que le reporter par défaut d'Angular avale. Lancer avec :
 *
 *   npx ng test engine --include "**\/balance-metrics.spec.ts" --reporters verbose
 */

/** Nombre de parties complètes jouées par carte. */
const RUNS = 8;
const MAP_IDS: readonly string[] = ['clairiere-02'];
const OPTIONS = DEFAULT_BALANCE_OPTIONS;

describe('Métriques d\'équilibre IA vs IA', () => {
  for (const mapId of MAP_IDS) {
    it(
      `agrège ${RUNS} parties sur "${mapId}"`,
      async () => {
        const runs: RunMetrics[] = [];
        for (let index = 0; index < RUNS; index++) {
          const run = await playBalanceRun(mapId, OPTIONS);
          runs.push(run);
          console.log(
            `run ${String(index + 1).padStart(2)} : ${run.winner.toUpperCase().padEnd(7)} ` +
              `au palier ${String(run.palierAtEnd).padStart(2)} ` +
              `(${run.attacks.length} phase(s) attaque, ${run.defenses.length} défense)`,
          );
        }

        console.log(
          `\n${formatBalanceReport({ mapId, runs, options: OPTIONS })}`,
        );

        expect(runs).toHaveLength(RUNS);
        expect(runs.flatMap((run) => run.attacks).length).toBeGreaterThan(0);
      },
      30 * 60_000,
    );
  }
});
