import { describe, expect, it } from 'vitest';
import type { GameMap, MapPath, MonsterType, Wave, WaveLane } from 'shared';
import { crossWaves, enforceBudget, evolveAttackWave, initRandomWave } from './ia-attack-player';
import { phaseScore, waveCost } from './combat';
import { expandPathCells } from './path';

const map: GameMap = {
  id: 'test-map',
  grid: { cols: 9, rows: 5, cell: 'hex', orientation: 'pointy', offset: 'odd-r' },
  chateau: { x: 8, y: 2 },
  spawns: [{ id: 'spawn-1', x: 0, y: 2 }],
  paths: [],
};

const routeA: MapPath = { id: 'route-a', nodes: [[0, 2], [8, 2]] };
const routeB: MapPath = { id: 'route-b', nodes: [[0, 1], [8, 2]] };

function laneOf(units: WaveLane['units'], path: MapPath): WaveLane {
  return { path, units };
}

function waveOf(...lanes: WaveLane[]): Wave {
  return { lanes };
}

const gobelin: MonsterType = {
  id: 'gobelin',
  name: 'Gobelin',
  description: '',
  cost: 5,
  hp: 20,
  speed: 1,
  armored: false,
  chateauDamage: 5,
};

describe('crossWaves', () => {
  it('ne produit jamais deux voies avec le même chemin', () => {
    const parentA = waveOf(
      laneOf([{ type: 'gobelin' }], routeA),
      laneOf([{ type: 'gobelin' }], routeB),
    );
    const parentB = waveOf(laneOf([{ type: 'gobelin' }, { type: 'gobelin' }], routeA));

    const child = crossWaves(map, [], parentA, parentB);
    const pathIds = child.lanes.map((lane) => lane.path.id);
    expect(new Set(pathIds).size).toBe(pathIds.length);
  });

  it("garde le chemin d'origine pour une voie absente chez l'un des deux parents", () => {
    const parentA = waveOf(
      laneOf([{ type: 'gobelin' }], routeA),
      laneOf([{ type: 'gobelin' }], routeB),
    );
    const parentB = waveOf(laneOf([{ type: 'gobelin' }, { type: 'gobelin' }], routeA));

    const child = crossWaves(map, [], parentA, parentB);
    // Seul parentA a une voie à l'index 1 (routeB) : rien à mélanger, elle est reprise telle quelle.
    expect(child.lanes.some((lane) => lane.path.id === routeB.id)).toBe(true);
  });

  it('mélange les deux chemins parents en une nouvelle route quand une voie existe chez les deux', () => {
    const parentA = waveOf(laneOf([{ type: 'gobelin' }], routeA));
    const parentB = waveOf(laneOf([{ type: 'gobelin' }], routeB));

    const child = crossWaves(map, [], parentA, parentB);

    expect(child.lanes).toHaveLength(1);
    const [blended] = child.lanes;
    // Un chemin frais, distinct des deux routes parentes (pas de tour sur cette carte de test :
    // le mélange réussit toujours).
    expect([routeA.id, routeB.id]).not.toContain(blended.path.id);
    const cells = expandPathCells(blended.path);
    expect(cells[cells.length - 1]).toEqual(map.chateau);
  });
});

describe('enforceBudget', () => {
  it('retire des monstres au hasard tant que le coût dépasse le budget', () => {
    const overBudget = waveOf(
      laneOf([{ type: 'gobelin' }, { type: 'gobelin' }, { type: 'gobelin' }], routeA),
      laneOf([{ type: 'gobelin' }, { type: 'gobelin' }, { type: 'gobelin' }], routeB),
    );
    expect(waveCost(overBudget, [gobelin])).toBeGreaterThan(20);

    const trimmed = enforceBudget(overBudget, 20, [gobelin]);
    expect(waveCost(trimmed, [gobelin])).toBeLessThanOrEqual(20);
  });

  it("ne change rien si la vague respecte déjà le budget", () => {
    const withinBudget = waveOf(laneOf([{ type: 'gobelin' }, { type: 'gobelin' }], routeA));
    const trimmed = enforceBudget(withinBudget, 50, [gobelin]);
    expect(trimmed.lanes[0].units.length).toBe(2);
  });

  it('retire les voies vidées de tous leurs monstres', () => {
    const overBudget = waveOf(laneOf([{ type: 'gobelin' }], routeA));
    const trimmed = enforceBudget(overBudget, 0, [gobelin]);
    expect(trimmed.lanes).toEqual([]);
  });
});

describe('evolveAttackWave', () => {
  it('trouve une vague au moins aussi bonne qu\'un tirage aléatoire (détruit le château, puis s\'étale davantage à destruction égale)', async () => {
    const baseline = initRandomWave(map, [], 200, [gobelin]);
    const baselineScore = phaseScore([], baseline, 50, map.chateau, [gobelin], undefined, 'attack');

    const evolved = await evolveAttackWave(map, [], 200, 50, [gobelin], 3, 10, 300);
    const evolvedScore = phaseScore([], evolved, 50, map.chateau, [gobelin], undefined, 'attack');

    expect(evolvedScore).toBeLessThanOrEqual(baselineScore);
  });

  it('reste une vague vide sans budget', async () => {
    const evolved = await evolveAttackWave(map, [], 0, 50, [gobelin], 3, 10, 50);
    expect(evolved.lanes).toEqual([]);
  });

  it('ne dépasse jamais le budget d\'attaque, même après croisement de plusieurs voies', async () => {
    const attackBudget = 200;
    const evolved = await evolveAttackWave(map, [], attackBudget, 50, [gobelin], 3, 15, 300);
    expect(waveCost(evolved, [gobelin])).toBeLessThanOrEqual(attackBudget);
  });

  it(
    'reste borné par maxTime même avec un maxLanes/populationSize disproportionnés (la construction de la ' +
      "population initiale ne doit jamais échapper au budget de temps, sous peine de bloquer l'IU)",
    async () => {
      const maxTime = 200;
      const start = Date.now();
      await evolveAttackWave(map, [], 200, 50, [gobelin], 100, 1000, maxTime);
      // Large marge sur maxTime : une seule vague en cours de construction peut légèrement le dépasser,
      // mais rien de comparable au temps qu'exigerait la construction complète de 2 000 candidats.
      expect(Date.now() - start).toBeLessThan(maxTime * 5);
    },
    5000,
  );

  it('rappelle onBestFound à la fin de chaque génération avec la meilleure vague trouvée jusqu\'ici', async () => {
    const seenScores: number[] = [];
    const evolved = await evolveAttackWave(map, [], 200, 50, [gobelin], 3, 10, 300, (best) => {
      seenScores.push(phaseScore([], best, 50, map.chateau, [gobelin], undefined, 'attack'));
    });
    expect(seenScores.length).toBeGreaterThan(0);
    const evolvedScore = phaseScore([], evolved, 50, map.chateau, [gobelin], undefined, 'attack');
    // La sélection ne fait jamais reculer le meilleur score au fil des générations (`fittestWaves`
    // conserve toujours les meilleurs individus, parents compris) : le dernier score publié ne peut
    // pas être meilleur que le résultat final.
    expect(seenScores[seenScores.length - 1]).toBeGreaterThanOrEqual(evolvedScore);
  });
});
