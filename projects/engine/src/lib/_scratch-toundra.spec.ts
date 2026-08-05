import { describe, expect, it } from 'vitest';
import type { GameMap, Wave } from 'shared';
import { findMapCatalogEntry } from 'shared';
import { GameEngine } from './engine';
import { playDefensePhase } from './ia-defense-player';

const MAP: GameMap = {
  id: 'toundra-05',
  grid: { cols: 48, rows: 16, cell: 'hex', orientation: 'pointy', offset: 'odd-r' },
  chateau: { x: 24, y: 8 },
  spawns: [
    { id: 's1', x: 24, y: 15 },
  ],
  paths: [
    { id: 'ouest', nodes: [[24, 15], [2, 15], [2, 1], [24, 1], [24, 8]] },
    { id: 'est', nodes: [[24, 15], [45, 15], [45, 1], [24, 1], [24, 8]] },
  ],
};

// La vague #0 n'est plus pré-construite (CONCEPTION.md §3) : le palier 1 est désormais une vraie
// phase Attaque. Ce scratch rejoue ici la composition qui servait autrefois de vague par défaut,
// via `resolveAttackSuccess`, pour mesurer le budget de Défense minimal au palier 2 qui en résulte.
const BOOTSTRAP_WAVE: Wave = {
  lanes: [
    { path: MAP.paths[0], units: [{ type: 'goblin' }, { type: 'goblin' }, { type: 'goblin' }, { type: 'orc' }] },
    { path: MAP.paths[1], units: [{ type: 'goblin' }, { type: 'goblin' }, { type: 'goblin' }, { type: 'orc' }] },
  ],
};

describe('Scratch: budget minimal toundra-05 palier 1', () => {
  for (const budget of [140, 160, 180, 200, 220, 250, 280]) {
    it(`budget ${budget}`, () => {
      const startingData = findMapCatalogEntry('toundra-05')!.startingData;
      const engine = new GameEngine();
      engine.startRun(MAP, { ...startingData, startingDefenseBudget: budget });
      engine.resolveAttackSuccess(BOOTSTRAP_WAVE);

      const wave = engine.getVagueCourante() as Wave;
      let bestHp = -1;
      for (let trial = 0; trial < 5; trial++) {
        const towers =
          playDefensePhase({
            map: MAP,
            wave,
            defenseBudget: engine.getDefenseBudget(),
            chateauMaxHp: engine.getChateauMaxHp(),
            maxTime: 800,
          }) ?? [];
        const engine2 = new GameEngine();
        engine2.startRun(MAP, { ...startingData, startingDefenseBudget: budget });
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
