import { describe, expect, it } from 'vitest';
import type { GameMap, TowerInstance } from 'shared';
import { MONSTER_TYPES } from 'shared';
import { phaseScore } from './combat';
import { initRandomWave } from './ia-attack-player';
import { playDefensePhase } from './ia-defense-player';

/**
 * Spec de mesure jetable : combien de générations `evolveAttackWave` a-t-elle réellement le temps
 * de faire tourner dans son budget de temps ? La question décide si les opérateurs de croisement et
 * de mutation servent à quelque chose — ils ne s'appliquent qu'aux vagues filles.
 *
 *   npx ng test engine --include "**\/_scratch-generations.spec.ts" --reporters verbose
 */

const MAP: GameMap = {
  id: 'clairiere-02',
  grid: { cols: 16, rows: 12, cell: 'hex', orientation: 'pointy', offset: 'odd-r' },
  chateau: { x: 8, y: 6 },
  spawns: [],
  paths: [],
  rivers: [{ id: 'riviere', nodes: [[6, 0], [8, 6], [15, 11]] }],
};

/** Paliers représentatifs : budget d'attaque 100 + 40/palier, budget de défense 140 + 60/palier. */
const PALIERS = [1, 5, 10];
const CHATEAU_HP = 5;
const MAX_TIME = 1000;
/** Échantillon noté pour estimer le débit de `phaseScore` (le coût dominant de la recherche). */
const SAMPLE = 40;

describe('scratch — débit de la recherche génétique en attaque', () => {
  it(
    'mesure combien de vagues par seconde la notation absorbe, et donc combien de générations tournent',
    async () => {
      console.log(`\n${'='.repeat(76)}`);
      console.log(`DÉBIT DE evolveAttackWave — carte "clairiere-02" — maxTime ${MAX_TIME} ms`);
      console.log('='.repeat(76));

      for (const palier of PALIERS) {
        const attackBudget = 100 + 40 * (palier - 1);
        const defenseBudget = 140 + 60 * (palier - 1);

        // Une forteresse réaliste pour ce palier : c'est elle qui détermine la durée d'une
        // simulation (plus de tours = plus de tirs à résoudre par tick).
        const seedWave = initRandomWave(MAP, [], attackBudget, MONSTER_TYPES, 5);
        const towers: TowerInstance[] = (
          (await playDefensePhase({
            map: MAP,
            wave: seedWave,
            defenseBudget,
            chateauMaxHp: CHATEAU_HP,
            maxTime: 1000,
          })) ?? []
        ).map((tower, index) => ({ ...tower, id: `t-${index}` }) as TowerInstance);

        // Construction : le temps de tracer les routes compte aussi dans maxTime.
        const buildStart = Date.now();
        const waves = Array.from({ length: SAMPLE }, () =>
          initRandomWave(MAP, towers, attackBudget, MONSTER_TYPES, 5),
        );
        const buildMs = (Date.now() - buildStart) / SAMPLE;

        // Notation : le coût dominant, une simulation de combat complète par vague.
        const scoreStart = Date.now();
        for (const wave of waves) {
          phaseScore(towers, wave, CHATEAU_HP, MAP.chateau, MONSTER_TYPES, undefined, 'attack');
        }
        const scoreMs = (Date.now() - scoreStart) / SAMPLE;

        console.log(
          `\npalier ${palier} — budget attaque ${attackBudget} · ${towers.length} tours posées`,
        );
        console.log(
          `  construction d'une vague : ${buildMs.toFixed(1)} ms · notation : ${scoreMs.toFixed(1)} ms`,
        );

        for (const population of [20, 50]) {
          // La population initiale coûte 2*P constructions + 2*P notations, chaque génération
          // suivante P croisements (~1 construction chacun) + P notations.
          const initialMs = 2 * population * (buildMs + scoreMs);
          const generationMs = population * (buildMs + scoreMs);
          const generations = Math.max(0, (MAX_TIME - initialMs) / generationMs);
          console.log(
            `  population ${String(population).padStart(2)} : ` +
              `population initiale ${initialMs.toFixed(0)} ms ` +
              `(${((100 * initialMs) / MAX_TIME).toFixed(0)}% du budget de temps) → ` +
              `${generations.toFixed(1)} génération(s)`,
          );
        }
      }
      console.log(`\n${'='.repeat(76)}`);
      expect(true).toBe(true);
    },
    5 * 60_000,
  );
});
