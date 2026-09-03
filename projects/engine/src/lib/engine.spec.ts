import { describe, expect, it } from 'vitest';
import type { GameMap, MapPath, MapSpawn, StartingData, Wave, WaveLane, WaveUnit } from 'shared';
import { findTowerType } from 'shared';
import { GameEngine } from './engine';
import { canOccupyCell, isBorderCell, isChateauCell } from './fortress';
import { expandPathCells, pathCellsCost } from './path';

const p1: MapPath = { id: 'p1', nodes: [[0, 3], [3, 3]] };
const p2: MapPath = { id: 'p2', nodes: [[3, 0], [3, 3]] };

const map: GameMap = {
  id: 'test-map',
  grid: { cols: 6, rows: 6, cell: 'hex', orientation: 'pointy', offset: 'odd-r' },
  chateau: { x: 3, y: 3 },
  spawns: [{ id: 's1', x: 0, y: 3 }],
  paths: [p1, p2],
};

function lane(units: WaveUnit[] = [], path: MapPath = p1): WaveLane {
  return { path, units };
}

function wave(...lanes: WaveLane[]): Wave {
  return { lanes };
}

function makeStartingData(overrides: Partial<StartingData> = {}): StartingData {
  return {
    mapId: 'test-map',
    startingDefenseBudget: 100,
    startingAttackBudget: 80,
    budgetGrowth: { initialMargin: 40, marginStep: 30 },
    chateauHp: 100,
    ...overrides,
  };
}

/**
 * Démarre une run et l'amène en phase Défense (palier 2) via une première phase Attaque jouée
 * contre une forteresse vide — reproduit le déroulé réel du jeu : plus de vague pré-construite,
 * le palier 1 est une vraie phase Attaque (CONCEPTION.md §3). `budgetGrowth` est neutralisée
 * (marge nulle) par défaut : `defenseBudget` reste au seed `startingDefenseBudget` pour ce tout
 * premier palier (le seul jamais lu sans relance, cf. `GameEngine.resolveAttackSuccess`) ; à
 * surcharger explicitement dans les tests qui portent sur la relance des budgets — auquel cas
 * penser en termes de « quel budget alimente l'AUTRE camp au prochain tour », pas de croissance
 * indépendante par camp (voir `BudgetGrowth`).
 */
function startInDefense(engine: GameEngine, overrides: Partial<StartingData> = {}): void {
  engine.startRun(map, makeStartingData({ budgetGrowth: { initialMargin: 0, marginStep: 0 }, ...overrides }));
  engine.resolveAttackSuccess(wave(lane([])));
}

describe('GameEngine', () => {
  it('defaults to the defense phase before any run is started', () => {
    const engine = new GameEngine();
    expect(engine.getPhase()).toBe('defense');
  });

  it('reports ready status', () => {
    const engine = new GameEngine();
    expect(engine.getStatus()).toContain('Open TD engine ready');
  });

  it('starts a run in the attack phase, against an empty fortress, with no vagueCourante yet', () => {
    const engine = new GameEngine();
    engine.startRun(map, makeStartingData());

    expect(engine.getPhase()).toBe('attack');
    expect(engine.getVagueCourante()).toBeUndefined();
    expect(engine.getTowers()).toHaveLength(0);
  });

  describe('placeTower', () => {
    it('rejects placement before a run is started', () => {
      const engine = new GameEngine();
      expect(engine.placeTower('archer', { x: 1, y: 1 })).toEqual({
        ok: false,
        reason: 'map-not-loaded',
      });
    });

    it('rejects placement during the initial attack phase (palier 1)', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      expect(engine.placeTower('archer', { x: 1, y: 1 })).toEqual({
        ok: false,
        reason: 'wrong-phase',
      });
    });

    it('places a tower on a valid cell and deducts its cost from the budget', () => {
      const engine = new GameEngine();
      startInDefense(engine);

      const result = engine.placeTower('archer', { x: 1, y: 1 });

      expect(result).toEqual({ ok: true });
      expect(engine.getTowers()).toHaveLength(1);
      expect(engine.getRemainingBudget()).toBe(100 - findTowerType('archer')!.cost);
    });

    it('stamps new towers with the current palier', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.placeTower('archer', { x: 1, y: 1 });

      expect(engine.getTowers()[0].placedAtPalier).toBe(2);
    });

    it('rejects a second tower on the same cell', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.placeTower('archer', { x: 1, y: 1 });

      expect(engine.placeTower('canon', { x: 1, y: 1 })).toEqual({
        ok: false,
        reason: 'occupied',
      });
      expect(engine.getTowers()).toHaveLength(1);
    });

    it('rejects placement once the budget is exhausted', () => {
      const engine = new GameEngine();
      startInDefense(engine, { startingDefenseBudget: 20 });
      engine.placeTower('archer', { x: 1, y: 1 });

      expect(engine.placeTower('canon', { x: 2, y: 2 })).toEqual({
        ok: false,
        reason: 'insufficient-budget',
      });
    });

    it('rejects placement on the chateau cell', () => {
      const engine = new GameEngine();
      startInDefense(engine);

      expect(engine.placeTower('archer', { x: 3, y: 3 })).toEqual({
        ok: false,
        reason: 'chateau-cell',
      });
    });

    it('rejects placement on a border cell', () => {
      const engine = new GameEngine();
      startInDefense(engine);

      expect(engine.placeTower('archer', { x: 0, y: 2 })).toEqual({
        ok: false,
        reason: 'border-cell',
      });
    });

    it('resets towers and budget when a new run starts', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.placeTower('archer', { x: 1, y: 1 });

      startInDefense(engine, { startingDefenseBudget: 50 });

      expect(engine.getTowers()).toHaveLength(0);
      expect(engine.getRemainingBudget()).toBe(50);
    });

    it('rejects placement outside the defense phase', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.resolveDefenseSuccess();

      expect(engine.placeTower('archer', { x: 1, y: 1 })).toEqual({
        ok: false,
        reason: 'wrong-phase',
      });
    });
  });

  describe('deleteTower', () => {
    it('removes the tower and recovers its full construction cost', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.placeTower('archer', { x: 1, y: 1 }); // cost 20
      const towerId = engine.getTowers()[0].id;

      const recovered = engine.deleteTower(towerId);

      expect(recovered).toBe(findTowerType('archer')!.cost);
      expect(engine.getTowers()).toHaveLength(0);
      expect(engine.getRemainingBudget()).toBe(100);
    });

    it('frees the cell so a new tower can be placed there', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.placeTower('archer', { x: 1, y: 1 });
      engine.deleteTower(engine.getTowers()[0].id);

      expect(engine.placeTower('canon', { x: 1, y: 1 })).toEqual({ ok: true });
    });

    it('returns undefined for an unknown tower id', () => {
      const engine = new GameEngine();
      startInDefense(engine);

      expect(engine.deleteTower('missing')).toBeUndefined();
    });

    it('returns undefined outside the defense phase', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.placeTower('archer', { x: 1, y: 1 });
      const towerId = engine.getTowers()[0].id;
      engine.resolveDefenseSuccess();

      expect(engine.deleteTower(towerId)).toBeUndefined();
      expect(engine.getTowers()).toHaveLength(1);
    });

    it('recovers the full cost even for a tower inherited from a previous palier', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.placeTower('archer', { x: 1, y: 1 }); // cost 20, placed at palier 2
      const towerId = engine.getTowers()[0].id;

      engine.resolveDefenseSuccess();
      engine.resolveAttackSuccess(wave(lane([{ type: 'orc' }]))); // palier -> 3, back to defense

      expect(engine.deleteTower(towerId)).toBe(findTowerType('archer')!.cost);
      expect(engine.getRemainingBudget()).toBe(engine.getDefenseBudget());
    });
  });

  describe('moveTower', () => {
    it('relocates the tower and frees its old cell', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.placeTower('archer', { x: 1, y: 1 });
      const towerId = engine.getTowers()[0].id;

      const result = engine.moveTower(towerId, { x: 2, y: 2 });

      expect(result).toEqual({ ok: true });
      expect(engine.getTowers()[0].position).toEqual({ x: 2, y: 2 });
      expect(engine.placeTower('canon', { x: 1, y: 1 })).toEqual({ ok: true }); // old cell is free
    });

    it('is free (no budget change) for a tower placed this palier', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.placeTower('archer', { x: 1, y: 1 });
      const towerId = engine.getTowers()[0].id;
      const before = engine.getRemainingBudget();

      engine.moveTower(towerId, { x: 2, y: 2 });

      expect(engine.getRemainingBudget()).toBe(before);
    });

    it('is free even for a tower inherited from a previous palier', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.placeTower('archer', { x: 1, y: 1 }); // cost 20, placed at palier 2
      const towerId = engine.getTowers()[0].id;

      engine.resolveDefenseSuccess();
      engine.resolveAttackSuccess(wave(lane([{ type: 'orc' }]))); // palier -> 3
      const before = engine.getRemainingBudget();

      const result = engine.moveTower(towerId, { x: 2, y: 2 });

      expect(result).toEqual({ ok: true });
      expect(engine.getRemainingBudget()).toBe(before);
    });

    it('rejects a move onto a cell already occupied by another tower', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.placeTower('archer', { x: 1, y: 1 });
      engine.placeTower('canon', { x: 2, y: 2 });
      const towerId = engine.getTowers()[0].id;

      expect(engine.moveTower(towerId, { x: 2, y: 2 })).toEqual({ ok: false, reason: 'occupied' });
    });

    it('rejects a move onto the chateau cell', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.placeTower('archer', { x: 1, y: 1 });
      const towerId = engine.getTowers()[0].id;

      expect(engine.moveTower(towerId, { x: 3, y: 3 })).toEqual({ ok: false, reason: 'chateau-cell' });
    });

    it('rejects a move onto a border cell', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.placeTower('archer', { x: 1, y: 1 });
      const towerId = engine.getTowers()[0].id;

      expect(engine.moveTower(towerId, { x: 0, y: 2 })).toEqual({ ok: false, reason: 'border-cell' });
    });

    it('returns tower-not-found for an unknown tower id', () => {
      const engine = new GameEngine();
      startInDefense(engine);

      expect(engine.moveTower('missing', { x: 2, y: 2 })).toEqual({ ok: false, reason: 'tower-not-found' });
    });

    it('returns wrong-phase outside the defense phase', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.placeTower('archer', { x: 1, y: 1 });
      const towerId = engine.getTowers()[0].id;
      engine.resolveDefenseSuccess();

      expect(engine.moveTower(towerId, { x: 2, y: 2 })).toEqual({ ok: false, reason: 'wrong-phase' });
    });
  });

  describe('applyFortressLayout', () => {
    it('keeps matching towers, deletes extras, and places the rest', () => {
      const engine = new GameEngine();
      startInDefense(engine, { startingDefenseBudget: 200 });
      engine.placeTower('archer', { x: 1, y: 1 });
      engine.placeTower('archer', { x: 2, y: 2 });
      const keptId = engine.getTowers()[0].id;

      const { rejected } = engine.applyFortressLayout([
        { id: 'keep', typeId: 'archer', position: { x: 1, y: 1 }, level: 1, placedAtPalier: 2 },
        { id: 'new', typeId: 'archer', position: { x: 1, y: 2 }, level: 1, placedAtPalier: 2 },
      ]);

      expect(rejected).toBe(0);
      const towers = engine.getTowers();
      expect(towers).toHaveLength(2);
      expect(towers.some((tower) => tower.id === keptId)).toBe(true);
      expect(towers.some((tower) => tower.position.x === 1 && tower.position.y === 2)).toBe(true);
      expect(towers.some((tower) => tower.position.x === 2 && tower.position.y === 2)).toBe(false);
    });

    it('keeps towers across a full defense → attack → defense cycle', () => {
      const engine = new GameEngine();
      startInDefense(engine, { startingDefenseBudget: 200, budgetGrowth: { initialMargin: 40, marginStep: 10 } });
      engine.placeTower('archer', { x: 1, y: 1 });
      const id = engine.getTowers()[0].id;
      engine.resolveDefenseSuccess();
      engine.resolveAttackSuccess(wave(lane([{ type: 'orc' }])));

      expect(engine.getPhase()).toBe('defense');
      expect(engine.getTowers()[0].id).toBe(id);
      engine.applyFortressLayout(engine.getTowers());
      expect(engine.getTowers()[0].id).toBe(id);
    });
  });

  describe('vagueCourante & startDefenseTrial', () => {
    it('has no vagueCourante until the initial attack phase resolves', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      expect(engine.getVagueCourante()).toBeUndefined();
    });

    it('freezes the winning wave routes onto the map, so their cells stop being buildable', () => {
      // Une case de chemin n'est jamais constructible (`canOccupyCell`) : c'est ce qui donne au
      // terrain gagné par l'attaquant sa valeur durable. La règle vivait auparavant dans la seule
      // couche d'affichage, donc le jeu sans interface se jouait sans elle.
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      const traced: MapPath = { id: 'traced', nodes: [[0, 1], [3, 3]] };
      // Une case intérieure du tracé : ni bord ni château, sinon elle serait déjà inconstructible
      // pour une autre raison et le test ne prouverait rien.
      const interior = expandPathCells(traced).find(
        (cell) => !isBorderCell(map, cell) && !isChateauCell(map, cell),
      )!;
      expect(interior).toBeDefined();
      expect(canOccupyCell(engine.getMap(), [], interior).ok).toBe(true);

      engine.resolveAttackSuccess(wave(lane([{ type: 'orc' }], traced)));

      const updated = engine.getMap()!;
      expect(updated.paths.map((path) => path.id)).toContain('traced');
      // Le départ du tracé devient un spawn, comme pour un tracé libre validé.
      expect(updated.spawns.some((spawn) => spawn.x === 0 && spawn.y === 1)).toBe(true);
      expect(canOccupyCell(updated, [], interior)).toEqual({ ok: false, reason: 'path-cell' });
    });

    it('does not add a route the interface already put on the map', () => {
      // `materializeWave` pose déjà les chemins côté interface : la règle doit être idempotente.
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      engine.resolveAttackSuccess(wave(lane([{ type: 'orc' }], p1)));

      expect(engine.getMap()!.paths.filter((path) => path.id === 'p1')).toHaveLength(1);
    });

    it('exposes the wave played in the initial attack phase as vagueCourante', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      const firstWave = wave(lane([{ type: 'orc' }]));

      engine.resolveAttackSuccess(firstWave);

      expect(engine.getVagueCourante()).toEqual(firstWave);
    });

    it('throws when starting a defense trial before a run has started', () => {
      const engine = new GameEngine();
      expect(() => engine.startDefenseTrial()).toThrow();
    });

    it('throws when starting a defense trial before the initial attack phase has resolved', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      expect(() => engine.startDefenseTrial()).toThrow();
    });

    it('runs vagueCourante against the current fortress', () => {
      const engine = new GameEngine();
      startInDefense(engine, { chateauHp: 5 }); // vagueCourante = empty wave from the bootstrap attack

      const trial = engine.startDefenseTrial();

      expect(trial.runToCompletion()).toBe('success'); // empty wave, nothing to fight through
    });
  });

  describe('phase alternation', () => {
    it('resolves the initial attack and moves to the defense phase, without relance on this very first transition', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      engine.resolveAttackSuccess(wave(lane([{ type: 'orc' }])));

      expect(engine.getPhase()).toBe('defense');
      expect(engine.getPalier()).toBe(2);
      // Palier 1 -> 2 est le seul cas sans relance (voir `resolveAttackSuccess`) : le tout premier
      // palier de défense joue sur son propre seed, jamais encore consommé par une relance.
      expect(engine.getDefenseBudget()).toBe(100); // startingDefenseBudget, inchangé
      expect(engine.getAttackBudget()).toBe(80); // startingAttackBudget, inchangé (pas encore relancé)
    });

    it('locks the fortress and moves to the attack phase on defense success', () => {
      const engine = new GameEngine();
      startInDefense(engine);

      engine.resolveDefenseSuccess();

      expect(engine.getPhase()).toBe('attack');
    });

    it('is a no-op when resolveDefenseSuccess is called outside the defense phase', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.resolveDefenseSuccess();

      engine.resolveDefenseSuccess();

      expect(engine.getPhase()).toBe('attack');
    });

    it('throws when starting an attack trial outside the attack phase', () => {
      const engine = new GameEngine();
      startInDefense(engine);

      expect(() => engine.startAttackTrial(wave(lane([])))).toThrow();
    });

    it('runs a composed wave against the frozen fortress in attack mode', () => {
      const engine = new GameEngine();
      startInDefense(engine, { chateauHp: 1 });
      engine.resolveDefenseSuccess();

      const composedWave = wave(lane([{ type: 'goblin' }]));
      const trial = engine.startAttackTrial(composedWave);

      expect(trial.runToCompletion()).toBe('success'); // no towers defending, the goblin destroys the château
    });

    it('throws when the composed wave costs more than the attack budget', () => {
      const engine = new GameEngine();
      // `startingDefenseBudget`, pas `startingAttackBudget` : après `resolveDefenseSuccess()`, le
      // budget d'attaque relance sur le DERNIER budget de défense (+ marge nulle, neutralisée par
      // `startInDefense`) — c'est donc `startingDefenseBudget` qui pilote le budget d'attaque
      // effectivement utilisé ici, pas son propre seed (déjà consommé par le palier 1).
      startInDefense(engine, { startingDefenseBudget: 20 });
      engine.resolveDefenseSuccess();

      // orc cost 12 (shared/monsters.ts): three of them, plus the route, is well past a budget of 20.
      const tooExpensive = wave(lane([{ type: 'orc' }, { type: 'orc' }, { type: 'orc' }]));

      expect(() => engine.startAttackTrial(tooExpensive)).toThrow();
    });

    it('replaces vagueCourante, raises the palier and relances both budgets on attack success', () => {
      const engine = new GameEngine();
      startInDefense(engine, { budgetGrowth: { initialMargin: 40, marginStep: 10 } });
      // defenseBudget stays at its seed (100) through the bootstrap attack (palier 1 -> 2, no
      // relance on this very first transition) — resolveDefenseSuccess is the first real relance.
      engine.resolveDefenseSuccess();
      // attackBudget = defenseBudget(100) + margin(40) = 140 ; margin grows to 40 + 10 = 50.
      expect(engine.getAttackBudget()).toBe(140);

      const composedWave = wave(lane([{ type: 'orc' }]));
      engine.resolveAttackSuccess(composedWave);

      expect(engine.getVagueCourante()).toEqual(composedWave);
      expect(engine.getPalier()).toBe(3); // 1 (bootstrap attack) -> 2 (defense) -> 3
      // defenseBudget = attackBudget(140) + margin(50, grown from 40) = 190 : the margin used here
      // is bigger than the one that produced 140, exactly the "growing margin" relance mechanic.
      expect(engine.getRemainingBudget()).toBe(190);
      expect(engine.getAttackBudget()).toBe(140); // unchanged since the last relance above
      expect(engine.getPhase()).toBe('defense');
    });

    it('is a no-op when resolveAttackSuccess is called outside the attack phase', () => {
      const engine = new GameEngine();
      startInDefense(engine);

      engine.resolveAttackSuccess(wave(lane([{ type: 'orc' }])));

      expect(engine.getPalier()).toBe(2);
      expect(engine.getPhase()).toBe('defense');
    });

    it('unlocks the fortress for editing again after returning to defense', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.resolveDefenseSuccess();
      engine.resolveAttackSuccess(wave(lane([{ type: 'orc' }])));

      expect(engine.placeTower('archer', { x: 1, y: 1 })).toEqual({ ok: true });
    });
  });

  describe('getAttackBudgetRemaining', () => {
    it('subtracts the cost of the composed wave from the attack budget', () => {
      const engine = new GameEngine();
      startInDefense(engine, { startingAttackBudget: 80 });

      // goblin cost 5, orc cost 12 (shared/monsters.ts)
      const composedWave = wave(lane([{ type: 'goblin' }, { type: 'orc' }]));

      expect(engine.getAttackBudgetRemaining(composedWave)).toBe(
        80 - 5 - 12 - pathCellsCost([p1]),
      );
    });
  });

  describe('removePath', () => {
    it('removes a predefined path and keeps the rest', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      const removed = engine.removePath('p1');

      expect(removed).toBe(true);
      expect(engine.getMap()?.paths).toEqual([p2]);
    });

    it('returns false for an unknown path id', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      expect(engine.removePath('missing')).toBe(false);
      expect(engine.getMap()?.paths).toEqual([p1, p2]);
    });

    it('returns false before a run is started', () => {
      const engine = new GameEngine();
      expect(engine.removePath('p1')).toBe(false);
    });

    it('keeps working across phases (removed paths stay removed in defense and attack)', () => {
      const engine = new GameEngine();
      startInDefense(engine);
      engine.removePath('p1');
      engine.resolveDefenseSuccess();

      expect(engine.getMap()?.paths).toEqual([p2]);
    });
  });

  describe('addPath', () => {
    const custom: MapPath = { id: 'custom-0', nodes: [[0, 3], [2, 5], [3, 3]] };

    it('appends a path, keeping the existing ones', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      engine.addPath(custom);

      expect(engine.getMap()?.paths).toEqual([p1, p2, custom]);
    });

    it('is a no-op before a run is started', () => {
      const engine = new GameEngine();
      engine.addPath(custom);

      expect(engine.getMap()).toBeUndefined();
    });

    it('survives the defense-to-attack transition (persisted, not tied to the wave draft)', () => {
      const engine = new GameEngine();
      startInDefense(engine);

      engine.addPath(custom);
      engine.resolveDefenseSuccess();

      expect(engine.getMap()?.paths).toEqual([p1, p2, custom]);
    });

    it('survives a full cycle back into defense', () => {
      const engine = new GameEngine();
      startInDefense(engine);

      engine.addPath(custom);
      engine.resolveDefenseSuccess();
      engine.resolveAttackSuccess(wave(lane([{ type: 'orc' }])));

      expect(engine.getMap()?.paths).toEqual([p1, p2, custom]);
    });
  });

  describe('addSpawn', () => {
    const spawn: MapSpawn = { id: 'spawn-0', x: 3, y: 0 };

    it('appends a spawn, keeping the existing ones', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      engine.addSpawn(spawn);

      expect(engine.getMap()?.spawns).toEqual([{ id: 's1', x: 0, y: 3 }, spawn]);
    });

    it('is a no-op before a run is started', () => {
      const engine = new GameEngine();
      engine.addSpawn(spawn);

      expect(engine.getMap()).toBeUndefined();
    });

    it('survives the defense-to-attack transition', () => {
      const engine = new GameEngine();
      startInDefense(engine);

      engine.addSpawn(spawn);
      engine.resolveDefenseSuccess();

      expect(engine.getMap()?.spawns).toEqual([{ id: 's1', x: 0, y: 3 }, spawn]);
    });
  });

  describe('pruneOrphanSpawns', () => {
    it('removes a spawn no path starts on, keeping spawns still connected', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      const orphanSpawn: MapSpawn = { id: 'spawn-orphan', x: 5, y: 5 };
      engine.addSpawn(orphanSpawn);

      engine.pruneOrphanSpawns();

      expect(engine.getMap()?.spawns).toEqual([{ id: 's1', x: 0, y: 3 }]);
    });

    it('is a no-op before a run is started', () => {
      const engine = new GameEngine();
      engine.pruneOrphanSpawns();

      expect(engine.getMap()).toBeUndefined();
    });
  });

  describe('getDefenseBudget', () => {
    it('reports the gross defense budget, unaffected by towers already placed', () => {
      const engine = new GameEngine();
      startInDefense(engine, { startingDefenseBudget: 100 });
      engine.placeTower('archer', { x: 1, y: 1 });

      expect(engine.getDefenseBudget()).toBe(100);
      expect(engine.getRemainingBudget()).toBe(100 - findTowerType('archer')!.cost);
    });

    it('relances after an attack success, alongside the remaining budget', () => {
      const engine = new GameEngine();
      startInDefense(engine, { startingDefenseBudget: 100, budgetGrowth: { initialMargin: 40, marginStep: 10 } });
      engine.resolveDefenseSuccess(); // attackBudget = defenseBudget(100) + margin(40) = 140
      engine.resolveAttackSuccess(wave(lane([{ type: 'orc' }])));

      // defenseBudget = attackBudget(140) + margin(50, grown from 40 by marginStep) = 190.
      expect(engine.getDefenseBudget()).toBe(190);
    });
  });

  describe('budget relance (BudgetGrowth)', () => {
    it('reproduces the exact reciprocal relance sequence over several cycles, margin growing each time', () => {
      const engine = new GameEngine();
      engine.startRun(
        map,
        makeStartingData({
          startingAttackBudget: 10,
          startingDefenseBudget: 100,
          budgetGrowth: { initialMargin: 5, marginStep: 5 },
        }),
      );

      engine.resolveAttackSuccess(wave(lane([]))); // palier 1 -> 2 : pas de relance, seed inchangé
      expect(engine.getDefenseBudget()).toBe(100);

      engine.resolveDefenseSuccess(); // attaque relance : 100 + margin(5)
      expect(engine.getAttackBudget()).toBe(105);

      engine.resolveAttackSuccess(wave(lane([]))); // défense relance : 105 + margin(10, 5+5)
      expect(engine.getDefenseBudget()).toBe(115);

      engine.resolveDefenseSuccess(); // attaque relance : 115 + margin(15, 10+5)
      expect(engine.getAttackBudget()).toBe(130);

      engine.resolveAttackSuccess(wave(lane([]))); // défense relance : 130 + margin(20, 15+5)
      expect(engine.getDefenseBudget()).toBe(150);
    });
  });
});
