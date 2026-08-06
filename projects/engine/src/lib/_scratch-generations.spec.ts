import { describe, expect, it } from 'vitest';
import type { TowerInstance } from 'shared';
import { MONSTER_TYPES, findMapCatalogEntry } from 'shared';
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

/** Carte du jeu, prise au catalogue partagé (`shared`) plutôt que recopiée ici. */
const MAP = findMapCatalogEntry('clairiere-02')!.geometry;

/** Paliers représentatifs : budget d'attaque 100 + 40/palier, budget de défense 140 + 60/palier. */
const PALIERS = [1, 5, 10];
const CHATEAU_HP = 5;
const MAX_TIME = 1000;
/**
 * Échantillon mesuré pour estimer le débit. Volontairement large, et précédé d'un amorçage : à
 * quelques dizaines d'itérations sans préchauffage, la mesure est dominée par la compilation JIT
 * et varie du simple au triple d'un run à l'autre — au point de faire conclure à des régressions
 * qui n'existent pas.
 */
const SAMPLE = 300;
/** Itérations jetées avant de chronométrer, le temps que le JIT compile. */
const WARMUP = 50;

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

        // Amorçage : laisse le JIT compiler avant de chronométrer quoi que ce soit.
        for (let i = 0; i < WARMUP; i++) {
          const warm = initRandomWave(MAP, towers, attackBudget, MONSTER_TYPES, 5);
          phaseScore(towers, warm, CHATEAU_HP, MAP, MONSTER_TYPES, undefined, 'attack');
        }

        // Construction : le temps de tracer les routes compte aussi dans maxTime.
        const buildStart = Date.now();
        const waves = Array.from({ length: SAMPLE }, () =>
          initRandomWave(MAP, towers, attackBudget, MONSTER_TYPES, 5),
        );
        const buildMs = (Date.now() - buildStart) / SAMPLE;

        // Notation : le coût dominant, une simulation de combat complète par vague.
        const scoreStart = Date.now();
        for (const wave of waves) {
          phaseScore(towers, wave, CHATEAU_HP, MAP, MONSTER_TYPES, undefined, 'attack');
        }
        const scoreMs = (Date.now() - scoreStart) / SAMPLE;

        console.log(
          `\npalier ${palier} — budget attaque ${attackBudget} · ${towers.length} tours posées`,
        );
        console.log(
          `  construction d'une vague : ${buildMs.toFixed(1)} ms · notation : ${scoreMs.toFixed(1)} ms`,
        );

        for (const population of [20, 50]) {
          // La population initiale coûte 2*P constructions + 2*P notations. Chaque génération
          // suivante coûte P croisements (~1 construction chacun) + les notations : P seulement
          // depuis la mise en cache des scores, contre 2P avant — `fittestWaves` recevait
          // `[...population, ...children]` et re-notait les parents inchangés.
          const initialMs = 2 * population * (buildMs + scoreMs);
          const generationMs = population * (buildMs + scoreMs);
          const beforeCacheMs = population * (buildMs + 2 * scoreMs);
          const generations = Math.max(0, (MAX_TIME - initialMs) / generationMs);
          const beforeCache = Math.max(0, (MAX_TIME - initialMs) / beforeCacheMs);
          console.log(
            `  population ${String(population).padStart(2)} : ` +
              `population initiale ${initialMs.toFixed(0)} ms ` +
              `(${((100 * initialMs) / MAX_TIME).toFixed(0)}% du budget de temps) → ` +
              `${generations.toFixed(1)} génération(s) ` +
              `(${beforeCache.toFixed(1)} sans cache de scores)`,
          );
        }
      }
      console.log(`\n${'='.repeat(76)}`);
      expect(true).toBe(true);
    },
    5 * 60_000,
  );
});
