import { describe, expect, it } from 'vitest';
import type { GameMap, MapPath, MapSpawn, StartingData, Wave, WaveLane, WaveUnit } from 'shared';
import { GameEngine } from './engine';

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
    budgetGrowth: { defense: 40, attack: 30 },
    chateauHp: 100,
    initialWave: wave(lane([{ type: 'goblin' }])),
    ...overrides,
  };
}

describe('GameEngine', () => {
  it('starts in defense phase', () => {
    const engine = new GameEngine();
    expect(engine.getPhase()).toBe('defense');
  });

  it('reports ready status', () => {
    const engine = new GameEngine();
    expect(engine.getStatus()).toContain('Open TD engine ready');
  });

  describe('placeTower', () => {
    it('rejects placement before a run is started', () => {
      const engine = new GameEngine();
      expect(engine.placeTower('archer', { x: 1, y: 1 })).toEqual({
        ok: false,
        reason: 'map-not-loaded',
      });
    });

    it('places a tower on a valid cell and deducts its cost from the budget', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      const result = engine.placeTower('archer', { x: 1, y: 1 });

      expect(result).toEqual({ ok: true });
      expect(engine.getTowers()).toHaveLength(1);
      expect(engine.getRemainingBudget()).toBe(80);
    });

    it('stamps new towers with the current palier', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.placeTower('archer', { x: 1, y: 1 });

      expect(engine.getTowers()[0].placedAtPalier).toBe(1);
    });

    it('rejects a second tower on the same cell', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.placeTower('archer', { x: 1, y: 1 });

      expect(engine.placeTower('canon', { x: 1, y: 1 })).toEqual({
        ok: false,
        reason: 'occupied',
      });
      expect(engine.getTowers()).toHaveLength(1);
    });

    it('rejects placement once the budget is exhausted', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData({ startingDefenseBudget: 20 }));
      engine.placeTower('archer', { x: 1, y: 1 });

      expect(engine.placeTower('canon', { x: 2, y: 2 })).toEqual({
        ok: false,
        reason: 'insufficient-budget',
      });
    });

    it('rejects placement on the chateau cell', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      expect(engine.placeTower('archer', { x: 3, y: 3 })).toEqual({
        ok: false,
        reason: 'chateau-cell',
      });
    });

    it('rejects placement on a border cell', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      expect(engine.placeTower('archer', { x: 0, y: 2 })).toEqual({
        ok: false,
        reason: 'border-cell',
      });
    });

    it('resets towers and budget when a new run starts', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.placeTower('archer', { x: 1, y: 1 });

      engine.startRun(map, makeStartingData({ startingDefenseBudget: 50 }));

      expect(engine.getTowers()).toHaveLength(0);
      expect(engine.getRemainingBudget()).toBe(50);
    });

    it('rejects placement outside the defense phase', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
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
      engine.startRun(map, makeStartingData());
      engine.placeTower('archer', { x: 1, y: 1 }); // cost 20
      const towerId = engine.getTowers()[0].id;

      const recovered = engine.deleteTower(towerId);

      expect(recovered).toBe(20);
      expect(engine.getTowers()).toHaveLength(0);
      expect(engine.getRemainingBudget()).toBe(100); // 100 - 20 + 20
    });

    it('frees the cell so a new tower can be placed there', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.placeTower('archer', { x: 1, y: 1 });
      engine.deleteTower(engine.getTowers()[0].id);

      expect(engine.placeTower('canon', { x: 1, y: 1 })).toEqual({ ok: true });
    });

    it('returns undefined for an unknown tower id', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      expect(engine.deleteTower('missing')).toBeUndefined();
    });

    it('returns undefined outside the defense phase', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.placeTower('archer', { x: 1, y: 1 });
      const towerId = engine.getTowers()[0].id;
      engine.resolveDefenseSuccess();

      expect(engine.deleteTower(towerId)).toBeUndefined();
      expect(engine.getTowers()).toHaveLength(1);
    });

    it('recovers the full cost even for a tower inherited from a previous palier', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.placeTower('archer', { x: 1, y: 1 }); // cost 20, placed at palier 1
      const towerId = engine.getTowers()[0].id;

      engine.resolveDefenseSuccess();
      engine.resolveAttackSuccess(wave(lane([{ type: 'orc' }]))); // palier -> 2, back to defense

      expect(engine.deleteTower(towerId)).toBe(20);
      expect(engine.getRemainingBudget()).toBe(engine.getDefenseBudget());
    });
  });

  describe('moveTower', () => {
    it('relocates the tower and frees its old cell', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.placeTower('archer', { x: 1, y: 1 });
      const towerId = engine.getTowers()[0].id;

      const result = engine.moveTower(towerId, { x: 2, y: 2 });

      expect(result).toEqual({ ok: true });
      expect(engine.getTowers()[0].position).toEqual({ x: 2, y: 2 });
      expect(engine.placeTower('canon', { x: 1, y: 1 })).toEqual({ ok: true }); // old cell is free
    });

    it('is free (no budget change) for a tower placed this palier', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.placeTower('archer', { x: 1, y: 1 });
      const towerId = engine.getTowers()[0].id;
      const before = engine.getRemainingBudget();

      engine.moveTower(towerId, { x: 2, y: 2 });

      expect(engine.getRemainingBudget()).toBe(before);
    });

    it('is free even for a tower inherited from a previous palier', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.placeTower('archer', { x: 1, y: 1 }); // cost 20, placed at palier 1
      const towerId = engine.getTowers()[0].id;

      engine.resolveDefenseSuccess();
      engine.resolveAttackSuccess(wave(lane([{ type: 'orc' }]))); // palier -> 2
      const before = engine.getRemainingBudget();

      const result = engine.moveTower(towerId, { x: 2, y: 2 });

      expect(result).toEqual({ ok: true });
      expect(engine.getRemainingBudget()).toBe(before);
    });

    it('rejects a move onto a cell already occupied by another tower', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.placeTower('archer', { x: 1, y: 1 });
      engine.placeTower('canon', { x: 2, y: 2 });
      const towerId = engine.getTowers()[0].id;

      expect(engine.moveTower(towerId, { x: 2, y: 2 })).toEqual({ ok: false, reason: 'occupied' });
    });

    it('rejects a move onto the chateau cell', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.placeTower('archer', { x: 1, y: 1 });
      const towerId = engine.getTowers()[0].id;

      expect(engine.moveTower(towerId, { x: 3, y: 3 })).toEqual({ ok: false, reason: 'chateau-cell' });
    });

    it('rejects a move onto a border cell', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.placeTower('archer', { x: 1, y: 1 });
      const towerId = engine.getTowers()[0].id;

      expect(engine.moveTower(towerId, { x: 0, y: 2 })).toEqual({ ok: false, reason: 'border-cell' });
    });

    it('returns tower-not-found for an unknown tower id', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      expect(engine.moveTower('missing', { x: 2, y: 2 })).toEqual({ ok: false, reason: 'tower-not-found' });
    });

    it('returns wrong-phase outside the defense phase', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.placeTower('archer', { x: 1, y: 1 });
      const towerId = engine.getTowers()[0].id;
      engine.resolveDefenseSuccess();

      expect(engine.moveTower(towerId, { x: 2, y: 2 })).toEqual({ ok: false, reason: 'wrong-phase' });
    });
  });

  describe('vagueCourante & startDefenseTrial', () => {
    it('exposes the initial wave as vagueCourante after startRun', () => {
      const engine = new GameEngine();
      const initialWave = wave(lane([{ type: 'orc' }]));
      engine.startRun(map, makeStartingData({ initialWave }));

      expect(engine.getVagueCourante()).toEqual(initialWave);
    });

    it('throws when starting a defense trial before a run has started', () => {
      const engine = new GameEngine();
      expect(() => engine.startDefenseTrial()).toThrow();
    });

    it('runs vagueCourante against the current fortress', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData({ initialWave: wave(lane([])), chateauHp: 5 }));

      const trial = engine.startDefenseTrial();

      expect(trial.runToCompletion()).toBe('success'); // empty wave, nothing to fight through
    });
  });

  describe('phase alternation', () => {
    it('locks the fortress and moves to the attack phase on defense success', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      engine.resolveDefenseSuccess();

      expect(engine.getPhase()).toBe('attack');
    });

    it('is a no-op when resolveDefenseSuccess is called outside the defense phase', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.resolveDefenseSuccess();

      engine.resolveDefenseSuccess();

      expect(engine.getPhase()).toBe('attack');
    });

    it('throws when starting an attack trial outside the attack phase', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      expect(() => engine.startAttackTrial(wave(lane([])))).toThrow();
    });

    it('runs a composed wave against the frozen fortress in attack mode', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.resolveDefenseSuccess();

      const composedWave = wave(lane([{ type: 'goblin' }]));
      const trial = engine.startAttackTrial(composedWave);

      expect(trial.runToCompletion()).toBe('success'); // no towers defending, the goblin gets through
    });

    it('replaces vagueCourante, raises the palier and grows both budgets on attack success', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.resolveDefenseSuccess();

      const composedWave = wave(lane([{ type: 'orc' }]));
      engine.resolveAttackSuccess(composedWave);

      expect(engine.getVagueCourante()).toEqual(composedWave);
      expect(engine.getPalier()).toBe(2);
      expect(engine.getRemainingBudget()).toBe(140); // 100 + 40 growth
      expect(engine.getAttackBudget()).toBe(110); // 80 + 30 growth
      expect(engine.getPhase()).toBe('defense');
    });

    it('is a no-op when resolveAttackSuccess is called outside the attack phase', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

      engine.resolveAttackSuccess(wave(lane([{ type: 'orc' }])));

      expect(engine.getPalier()).toBe(1);
      expect(engine.getPhase()).toBe('defense');
    });

    it('unlocks the fortress for editing again after returning to defense', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());
      engine.resolveDefenseSuccess();
      engine.resolveAttackSuccess(wave(lane([{ type: 'orc' }])));

      expect(engine.placeTower('archer', { x: 1, y: 1 })).toEqual({ ok: true });
    });
  });

  describe('getAttackBudgetRemaining', () => {
    it('subtracts the cost of the composed wave from the attack budget', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData({ startingAttackBudget: 80 }));

      // goblin cost 5, orc cost 12 (shared/monsters.ts)
      const composedWave = wave(lane([{ type: 'goblin' }, { type: 'orc' }]));

      expect(engine.getAttackBudgetRemaining(composedWave)).toBe(80 - 5 - 12);
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
      engine.startRun(map, makeStartingData());
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
      engine.startRun(map, makeStartingData());

      engine.addPath(custom);
      engine.resolveDefenseSuccess();

      expect(engine.getMap()?.paths).toEqual([p1, p2, custom]);
    });

    it('survives a full cycle back into defense', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData());

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
      engine.startRun(map, makeStartingData());

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
      engine.startRun(map, makeStartingData({ startingDefenseBudget: 100 }));
      engine.placeTower('archer', { x: 1, y: 1 });

      expect(engine.getDefenseBudget()).toBe(100);
      expect(engine.getRemainingBudget()).toBe(80);
    });

    it('grows after an attack success, alongside the remaining budget', () => {
      const engine = new GameEngine();
      engine.startRun(map, makeStartingData({ startingDefenseBudget: 100 }));
      engine.resolveDefenseSuccess();
      engine.resolveAttackSuccess(wave(lane([{ type: 'orc' }])));

      expect(engine.getDefenseBudget()).toBe(140); // 100 + 40 growth
    });
  });
});
