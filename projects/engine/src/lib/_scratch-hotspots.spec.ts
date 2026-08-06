import { describe, expect, it } from 'vitest';
import type { GameMap, TowerInstance, Wave } from 'shared';
import { MONSTER_TYPES, findMapCatalogEntry } from 'shared';
import { DefenseSimulation, phaseScore, routeExposure, waveCost } from './combat';
import { enforceBudget, initRandomWave } from './ia-attack-player';
import { playDefensePhase } from './ia-defense-player';
import { buildPathGeometry, coveredCells, expandPathCells } from './path';

/**
 * Spec de mesure jetable : décomposition du coût d'une itération de recherche en attaque, pour
 * savoir ce qu'il reste à optimiser après la mise en cache des géométries et de `shortestPath`.
 *
 *   npx ng test engine --include "**\/_scratch-hotspots.spec.ts" --reporters verbose
 */

/** Carte du jeu, prise au catalogue partagé (`shared`) plutôt que recopiée ici. */
const MAP = findMapCatalogEntry('clairiere-02')!.geometry;

const CHATEAU_HP = 5;
const PALIER = 10;
const ATTACK_BUDGET = 100 + 40 * (PALIER - 1);
const DEFENSE_BUDGET = 140 + 60 * (PALIER - 1);
const REPEATS = 400;

/** Temps moyen par appel, en microsecondes. */
function bench(label: string, repeats: number, run: () => void): void {
  run(); // amorçage : laisse le JIT compiler avant de chronométrer
  const start = Date.now();
  for (let i = 0; i < repeats; i++) {
    run();
  }
  const microseconds = ((Date.now() - start) * 1000) / repeats;
  console.log(`  ${label.padEnd(46)} ${microseconds.toFixed(1).padStart(8)} µs`);
}

describe('scratch — points chauds restants de la recherche en attaque', () => {
  it(
    `décompose le coût d'une itération au palier ${PALIER}`,
    async () => {
      const seedWave = initRandomWave(MAP, [], ATTACK_BUDGET, MONSTER_TYPES, 5);
      // Pendant la phase Défense, les voies de l'attaque sont des chemins de la carte (comme le fait
      // `BoardLanesService.materializeWave`) : leurs cases ne sont plus constructibles, ce qui garantit
      // qu'un couloir libre relie toujours un bord au château. Sans ça, la défense pose ses tours sur
      // le tracé et peut enfermer le château, l'attaque ne trace alors plus rien et la mesure n'a plus
      // d'objet — ce que le jeu réel ne permet jamais.
      const defenseMap: GameMap = { ...MAP, paths: seedWave.lanes.map((lane) => lane.path) };
      const towers: TowerInstance[] = (
        (await playDefensePhase({
          map: defenseMap,
          wave: seedWave,
          defenseBudget: DEFENSE_BUDGET,
          chateauMaxHp: CHATEAU_HP,
          maxTime: 1000,
        })) ?? []
      ).map((tower, index) => ({ ...tower, id: `t-${index}` }) as TowerInstance);

      const wave: Wave = initRandomWave(MAP, towers, ATTACK_BUDGET, MONSTER_TYPES, 5);
      const paths = wave.lanes.map((lane) => lane.path);

      console.log(`\n${'='.repeat(70)}`);
      console.log(
        `POINTS CHAUDS — palier ${PALIER} · ${towers.length} tours · ` +
          `${wave.lanes.length} voies · ${wave.lanes.reduce((n, l) => n + l.units.length, 0)} monstres`,
      );
      console.log('='.repeat(70));

      bench('phaseScore (notation complète)', REPEATS, () => {
        phaseScore(towers, wave, CHATEAU_HP, MAP, MONSTER_TYPES, undefined, 'attack');
      });
      bench('  └─ new DefenseSimulation (géométries)', REPEATS, () => {
        new DefenseSimulation(towers, wave, CHATEAU_HP, MONSTER_TYPES, undefined, undefined, 'attack');
      });
      bench('  └─ routeExposure', REPEATS, () => {
        routeExposure(MAP, wave);
      });
      bench('waveCost', REPEATS, () => {
        waveCost(wave, MONSTER_TYPES);
      });
      bench('  └─ coveredCells (dont expandPathCells)', REPEATS, () => {
        coveredCells(paths);
      });
      bench('expandPathCells (une voie)', REPEATS, () => {
        expandPathCells(paths[0]);
      });
      bench('buildPathGeometry (une voie)', REPEATS, () => {
        buildPathGeometry(paths[0]);
      });
      bench('enforceBudget', REPEATS, () => {
        enforceBudget(wave, ATTACK_BUDGET, MONSTER_TYPES);
      });
      bench('initRandomWave (construction)', REPEATS, () => {
        initRandomWave(MAP, towers, ATTACK_BUDGET, MONSTER_TYPES, 5);
      });

      console.log('='.repeat(70));
      expect(true).toBe(true);
    },
    5 * 60_000,
  );
});
