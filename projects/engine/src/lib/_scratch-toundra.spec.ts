import { describe, expect, it } from 'vitest';
import type { GridCoord, MapPath, Wave } from 'shared';
import { findMapCatalogEntry } from 'shared';
import { GameEngine } from './engine';
import { playDefensePhase } from './ia-defense-player';
import { shortestPath } from './path';

const { geometry: MAP, startingData: STARTING_DATA } = findMapCatalogEntry('toundra-05')!;

/**
 * Trace une route d'assaut comme le ferait l'IA d'attaque : d'une case de bord jusqu'au château, en
 * contournant la rivière (`shortestPath` ne traverse jamais ses cases). La carte du catalogue ne
 * fournit aucun chemin prédéfini, et les deux routes que ce scratch gardait en dur enjambaient la
 * rivière qui descend la colonne du château — soit un assaut que le jeu n'autorise pas.
 */
function routeFrom(id: string, start: GridCoord): MapPath {
  const steps = shortestPath(MAP, [], start, MAP.chateau) ?? [];
  return { id, nodes: [start, ...steps].map((cell): [number, number] => [cell.x, cell.y]) };
}

// La vague #0 n'est plus pré-construite (CONCEPTION.md §3) : le palier 1 est désormais une vraie
// phase Attaque. Ce scratch rejoue ici la composition qui servait autrefois de vague par défaut,
// via `resolveAttackSuccess`, pour mesurer le budget de Défense minimal au palier 2 qui en résulte.
const BOOTSTRAP_UNITS: Wave['lanes'][number]['units'] = [
  { type: 'goblin' },
  { type: 'goblin' },
  { type: 'goblin' },
  { type: 'orc' },
];
const BOOTSTRAP_WAVE: Wave = {
  lanes: [
    { path: routeFrom('ouest', { x: 2, y: 15 }), units: BOOTSTRAP_UNITS },
    { path: routeFrom('est', { x: 45, y: 15 }), units: BOOTSTRAP_UNITS },
  ],
};

describe('Scratch: budget minimal toundra-05 palier 1', () => {
  for (const budget of [140, 160, 180, 200, 220, 250, 280]) {
    it(`budget ${budget}`, async () => {
      const engine = new GameEngine();
      engine.startRun(MAP, { ...STARTING_DATA, startingDefenseBudget: budget });
      engine.resolveAttackSuccess(BOOTSTRAP_WAVE);

      const wave = engine.getVagueCourante() as Wave;
      let bestHp = -1;
      for (let trial = 0; trial < 5; trial++) {
        const towers =
          (await playDefensePhase({
            // La carte du moteur, pas la géométrie de départ : `resolveAttackSuccess` vient d'y
            // figer les deux routes, dont les cases ne sont plus constructibles.
            map: engine.getMap()!,
            wave,
            defenseBudget: engine.getDefenseBudget(),
            chateauMaxHp: engine.getChateauMaxHp(),
            maxTime: 800,
          })) ?? [];
        const engine2 = new GameEngine();
        engine2.startRun(MAP, { ...STARTING_DATA, startingDefenseBudget: budget });
        engine2.resolveAttackSuccess(BOOTSTRAP_WAVE);
        for (const tower of towers) {
          engine2.placeTower(tower.typeId, tower.position);
        }
        const trial2 = engine2.startDefenseTrial();
        const outcome = trial2.runToCompletion();
        const hp = trial2.getChateauHp();
        console.log(
          `budget=${budget} essai=${trial} tours=${towers.length} hp=${hp}/${engine.getChateauMaxHp()} -> ${outcome}`,
        );
        bestHp = Math.max(bestHp, hp);
      }
      console.log(`budget=${budget} MEILLEUR hp=${bestHp}/${engine.getChateauMaxHp()}`);
      expect(true).toBe(true);
    }, 60_000);
  }
});
