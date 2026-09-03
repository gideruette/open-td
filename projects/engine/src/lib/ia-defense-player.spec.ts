import { describe, expect, it } from 'vitest';
import type { GameMap, MapPath, MonsterType, TowerInstance, TowerType, Wave, WaveLane } from 'shared';
import {
  crossDefenses,
  enforceDefenseBudget,
  evolveDefense,
  initRandomDefense,
  initRandomTower,
} from './ia-defense-player';
import { canPlaceTower } from './fortress';
import { DefenseSimulation, phaseScore } from './combat';

const map: GameMap = {
  id: 'test-map',
  grid: { cols: 9, rows: 5, cell: 'hex', orientation: 'pointy', offset: 'odd-r' },
  chateau: { x: 8, y: 2 },
  spawns: [{ id: 'spawn-1', x: 0, y: 2 }],
  paths: [],
};

const route: MapPath = { id: 'p1', nodes: [[0, 2], [8, 2]] };

function laneOf(units: WaveLane['units'], path: MapPath = route): WaveLane {
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

const archer: TowerType = {
  id: 'archer',
  name: 'Archer',
  description: '',
  cost: 20,
  range: 3,
  damage: 8,
  cooldown: 5,
};

describe('initRandomTower', () => {
  it('pose une tour valide (grille, budget) à portée de la voie de la vague à tenir', () => {
    const wave = waveOf(laneOf([{ type: 'gobelin' }]));
    const tower = initRandomTower(map, [], wave, 20, [archer]);
    expect(tower).toBeDefined();
    expect(canPlaceTower(map, [], archer, tower!.position, 20).ok).toBe(true);
  });

  it("undefined si aucun type n'est achetable", () => {
    const wave = waveOf(laneOf([{ type: 'gobelin' }]));
    expect(initRandomTower(map, [], wave, 5, [archer])).toBeUndefined();
  });
});

describe('initRandomDefense', () => {
  it('pose des tours tant que le budget le permet, sans le dépasser', () => {
    const wave = waveOf(laneOf([{ type: 'gobelin' }]));
    const towers = initRandomDefense(map, wave, 60, [archer]);
    expect(towers.length).toBeGreaterThan(0);
    expect(towers.length * archer.cost).toBeLessThanOrEqual(60);
    const positions = new Set(towers.map((tower) => `${tower.position.x},${tower.position.y}`));
    expect(positions.size).toBe(towers.length);
  });

  it('reste vide sans budget', () => {
    const wave = waveOf(laneOf([{ type: 'gobelin' }]));
    expect(initRandomDefense(map, wave, 0, [archer])).toEqual([]);
  });
});

function towerAt(x: number, y: number, id: string = `tower-${x}-${y}`): TowerInstance {
  return { id, typeId: 'archer', position: { x, y }, level: 1, placedAtPalier: 0 };
}

describe('crossDefenses', () => {
  it('ne produit jamais deux tours sur la même case', () => {
    const parentA = [towerAt(1, 1), towerAt(2, 2)];
    const parentB = [towerAt(1, 1, 'tower-dup'), towerAt(3, 3)];

    const child = crossDefenses(parentA, parentB);
    const positions = child.map((tower) => `${tower.position.x},${tower.position.y}`);
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("ne garde que des tours héritées de l'un des deux parents", () => {
    const parentA = [towerAt(1, 1)];
    const parentB = [towerAt(2, 2), towerAt(3, 3)];

    const child = crossDefenses(parentA, parentB);
    const parentIds = new Set([...parentA, ...parentB].map((tower) => tower.id));
    for (const tower of child) {
      expect(parentIds.has(tower.id)).toBe(true);
    }
  });
});

describe('enforceDefenseBudget', () => {
  it('retire des tours au hasard tant que le coût dépasse le budget', () => {
    const overBudget = [towerAt(1, 1), towerAt(2, 2), towerAt(3, 3)];
    const trimmed = enforceDefenseBudget(overBudget, 20, [archer]);
    expect(trimmed.length).toBeLessThanOrEqual(1);
  });

  it('ne change rien si la forteresse respecte déjà le budget', () => {
    const withinBudget = [towerAt(1, 1), towerAt(2, 2)];
    const trimmed = enforceDefenseBudget(withinBudget, 40, [archer]);
    expect(trimmed.length).toBe(2);
  });
});

describe('evolveDefense', () => {
  it('trouve une défense qui transforme un échec (château nu) en réussite', async () => {
    // Un seul monstre, mais assez de dégâts pour dépasser les PV du château si rien ne l'arrête ;
    // une seule tour suffisante à le tuer avant qu'il n'atteigne le château doit donc être trouvée.
    const deadly: MonsterType = { ...gobelin, id: 'deadly', hp: 10, chateauDamage: 150 };
    const strongArcher: TowerType = { ...archer, range: 100, damage: 8, cooldown: 5 };
    const wave = waveOf(laneOf([{ type: 'deadly' }]));

    const towers = await evolveDefense(map, wave, 60, 100, [deadly], [strongArcher], 10, 300);

    const withoutTowers = new DefenseSimulation([], wave, 100, [deadly], [strongArcher]);
    expect(withoutTowers.runToCompletion()).toBe('failure');

    const withTowers = new DefenseSimulation(towers, wave, 100, [deadly], [strongArcher]);
    expect(withTowers.runToCompletion()).toBe('success');

    const scoreWithTowers = phaseScore(towers, wave, 100, map, [deadly], [strongArcher], 'defense');
    const scoreWithoutTowers = phaseScore([], wave, 100, map, [deadly], [strongArcher], 'defense');
    expect(scoreWithTowers).toBeGreaterThan(scoreWithoutTowers);
  });

  it('entre deux défenses qui tiennent la vague sans le moindre dégât, préfère la plus étalée (le plus de cases prises par des tours)', () => {
    const wave = waveOf(laneOf([{ type: 'gobelin' }]));
    // Portée/dégâts surdimensionnés pour garantir que le gobelin meurt bien avant le château,
    // quel que soit le nombre de tours : les deux défenses tiennent sans le moindre dégât, seul
    // l'étalement les départage.
    const lethalArcher: TowerType = { ...archer, range: 100, damage: 15, cooldown: 1 };
    const oneTower = [{ id: 't1', typeId: 'archer', position: { x: 1, y: 1 }, level: 1, placedAtPalier: 0 }];
    const twoTowers = [
      ...oneTower,
      { id: 't2', typeId: 'archer', position: { x: 2, y: 1 }, level: 1, placedAtPalier: 0 },
    ];

    const scoreOneTower = phaseScore(oneTower, wave, 100, map, [gobelin], [lethalArcher], 'defense');
    const scoreTwoTowers = phaseScore(twoTowers, wave, 100, map, [gobelin], [lethalArcher], 'defense');

    expect(scoreOneTower).toBeGreaterThan(1_000_000); // les deux tiennent (succès), pas juste survivent
    expect(scoreTwoTowers).toBeGreaterThan(scoreOneTower);
  });

  it("ne dépasse jamais le budget de défense, même après croisement de plusieurs tours", async () => {
    const wave = waveOf(laneOf([{ type: 'gobelin' }, { type: 'gobelin' }, { type: 'gobelin' }]));
    const defenseBudget = 80;
    const towers = await evolveDefense(map, wave, defenseBudget, 100, [gobelin], [archer], 15, 300);
    const totalCost = towers.length * archer.cost;
    expect(totalCost).toBeLessThanOrEqual(defenseBudget);
  });

  it('réinvestit une forteresse héritée sans dépasser le budget brut', async () => {
    const wave = waveOf(laneOf([{ type: 'gobelin' }, { type: 'gobelin' }]));
    const seed = initRandomDefense(map, wave, 20, [archer]);
    expect(seed.length).toBeGreaterThan(0);
    const towers = await evolveDefense(
      map,
      wave,
      60,
      100,
      [gobelin],
      [archer],
      8,
      200,
      undefined,
      undefined,
      seed,
    );
    expect(towers.length * archer.cost).toBeLessThanOrEqual(60);
  });

  it('rappelle onBestFound à la fin de chaque génération avec la meilleure défense trouvée jusqu\'ici', async () => {
    const wave = waveOf(laneOf([{ type: 'gobelin' }, { type: 'gobelin' }, { type: 'gobelin' }]));
    const seenScores: number[] = [];
    const towers = await evolveDefense(
      map,
      wave,
      80,
      100,
      [gobelin],
      [archer],
      15,
      300,
      (best) => {
        seenScores.push(phaseScore(best, wave, 100, map, [gobelin], [archer], 'defense'));
      },
    );
    expect(seenScores.length).toBeGreaterThan(0);
    const finalScore = phaseScore(towers, wave, 100, map, [gobelin], [archer], 'defense');
    // La sélection ne fait jamais reculer le meilleur score au fil des générations (`fittestDefenses`
    // conserve toujours les meilleurs individus, parents compris) : le dernier score publié ne peut
    // pas être meilleur que le résultat final.
    expect(seenScores[seenScores.length - 1]).toBeLessThanOrEqual(finalScore);
  });
});
