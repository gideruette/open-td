import { describe, expect, it } from 'vitest';
import type { MapPath, MonsterType, TowerInstance, TowerType, Wave, WaveLane, WaveUnit } from 'shared';
import { DefenseSimulation, selectTarget, totalHeartDamage, waveCost } from './combat';

const p1: MapPath = { id: 'p1', nodes: [[0, 0], [20, 0]] };
const p2: MapPath = { id: 'p2', nodes: [[0, 3], [20, 3]] };

function lane(units: WaveUnit[] = [], path: MapPath = p1): WaveLane {
  return { path, units };
}

function wave(...lanes: WaveLane[]): Wave {
  return { lanes };
}

const unit: MonsterType = { id: 'unit', name: 'Unit', cost: 1, hp: 1000, speed: 1, armored: false, heartDamage: 1 };
const goblin: MonsterType = { id: 'goblin', name: 'Gobelin', cost: 5, hp: 20, speed: 1, armored: false, heartDamage: 1 };
const golem: MonsterType = { id: 'golem', name: 'Golem', cost: 30, hp: 40, speed: 1, armored: true, heartDamage: 4 };
const monsterCatalog: MonsterType[] = [unit, goblin, golem];

const weakTower: TowerType = { id: 'weak', name: 'Weak', cost: 1, range: 100, damage: 1, cooldown: 1000 };
const strongTower: TowerType = { id: 'strong', name: 'Strong', cost: 1, range: 100, damage: 1000, cooldown: 1 };
const splashTower: TowerType = {
  id: 'splash',
  name: 'Splash',
  cost: 1,
  range: 2,
  damage: 15,
  cooldown: 1000,
  splashRadius: 2,
};
const slowTower: TowerType = {
  id: 'slow',
  name: 'Slow',
  cost: 1,
  range: 100,
  damage: 0,
  cooldown: 1000,
  slowFactor: 0.5,
  slowDuration: 10,
};
const armorTower: TowerType = {
  id: 'armor',
  name: 'Armor',
  cost: 1,
  range: 100,
  damage: 10,
  cooldown: 1000,
  armorBonus: 2,
};
const towerCatalog: TowerType[] = [weakTower, strongTower, splashTower, slowTower, armorTower];

function tower(overrides: Partial<TowerInstance> = {}): TowerInstance {
  return {
    id: 't1',
    typeId: 'weak',
    position: { x: 10, y: 0 },
    level: 1,
    placedAtPalier: 1,
    ...overrides,
  };
}

describe('DefenseSimulation', () => {
  it('fails once the heart hp is depleted by monsters reaching the end of the path', () => {
    const sim = new DefenseSimulation([], wave(lane([{ type: 'unit' }])), 1, monsterCatalog, towerCatalog, 1);

    const outcome = sim.runToCompletion();

    expect(outcome).toBe('failure');
    expect(sim.getHeartHp()).toBeLessThanOrEqual(0);
  });

  it('succeeds when every monster is destroyed before reaching the heart', () => {
    const towers = [tower({ typeId: 'strong' })];
    const sim = new DefenseSimulation(
      towers,
      wave(lane([{ type: 'unit' }, { type: 'unit' }])),
      10,
      monsterCatalog,
      towerCatalog,
      1,
    );

    const outcome = sim.runToCompletion();

    expect(outcome).toBe('success');
    expect(sim.getHeartHp()).toBe(10);
  });

  it('applies splash damage to monsters near the primary target', () => {
    // Tower sits at path-distance 5 with a short range: it only starts firing once a monster
    // walks into [3,7], by which point both goblins (spawned 1 tick apart) are on the board
    // and close enough together to both fall within the splash radius.
    const towers = [tower({ typeId: 'splash', position: { x: 5, y: 0 } })];
    const sim = new DefenseSimulation(
      towers,
      wave(lane([{ type: 'goblin' }, { type: 'goblin' }])),
      100,
      monsterCatalog,
      towerCatalog,
      1,
    );

    for (let i = 0; i < 4; i++) {
      sim.step();
    }

    const monsters = sim.getMonsters();
    expect(monsters).toHaveLength(2);
    expect(monsters.every((monster) => monster.hp < goblin.hp)).toBe(true);
  });

  it('slows a monster hit by a slow tower', () => {
    const towers = [tower({ typeId: 'slow' })];
    const sim = new DefenseSimulation(towers, wave(lane([{ type: 'unit' }])), 100, monsterCatalog, towerCatalog, 1);

    sim.step(); // spawn (d=0), fire applies slow, move by speed*multiplier
    const [monster] = sim.getMonsters();

    // slowed on the very tick it is hit and moved: distance advances by speed * slowFactor
    expect(monster.distance).toBeCloseTo(unit.speed * 0.5, 5);
  });

  it('deals bonus damage to armored monsters', () => {
    const towers = [tower({ typeId: 'armor' })];
    const sim = new DefenseSimulation(towers, wave(lane([{ type: 'golem' }])), 100, monsterCatalog, towerCatalog, 1);

    sim.step();
    const [monster] = sim.getMonsters();

    expect(monster.hp).toBe(golem.hp - armorTower.damage * (armorTower.armorBonus ?? 1));
  });

  it('does not apply the armor bonus to unarmored monsters', () => {
    const towers = [tower({ typeId: 'armor' })];
    const sim = new DefenseSimulation(towers, wave(lane([{ type: 'goblin' }])), 100, monsterCatalog, towerCatalog, 1);

    sim.step();
    const [monster] = sim.getMonsters();

    expect(monster.hp).toBe(goblin.hp - armorTower.damage);
  });

  describe('getShotsThisTick', () => {
    it('records a shot from the tower to its target on the tick it fires', () => {
      const towers = [tower({ typeId: 'weak', position: { x: 10, y: 0 } })];
      const sim = new DefenseSimulation(towers, wave(lane([{ type: 'unit' }])), 100, monsterCatalog, towerCatalog, 1);

      sim.step(); // spawn at d=0, tower (range 100) fires immediately

      expect(sim.getShotsThisTick()).toEqual([
        { towerPosition: { x: 10, y: 0 }, targetPosition: { x: 0, y: 0 } },
      ]);
    });

    it('is empty on a tick where no tower fires', () => {
      // weakTower has cooldown 1000, so it cannot fire again on tick 2
      const towers = [tower({ typeId: 'weak' })];
      const sim = new DefenseSimulation(towers, wave(lane([{ type: 'unit' }])), 100, monsterCatalog, towerCatalog, 1);

      sim.step();
      sim.step();

      expect(sim.getShotsThisTick()).toEqual([]);
    });

    it('is reset each tick rather than accumulating', () => {
      const towers = [tower({ typeId: 'strong' })];
      const sim = new DefenseSimulation(
        towers,
        wave(lane([{ type: 'unit' }, { type: 'unit' }])),
        100,
        monsterCatalog,
        towerCatalog,
        1,
      );

      sim.step();
      expect(sim.getShotsThisTick()).toHaveLength(1);
      sim.step();
      expect(sim.getShotsThisTick().length).toBeLessThanOrEqual(1);
    });
  });

  describe('attack mode', () => {
    it('succeeds the instant a monster breaches, even if towers remain and other units are still queued', () => {
      // tower placed far off the path: out of range of every monster, so the wave goes unopposed.
      const towers = [tower({ typeId: 'weak', position: { x: 999, y: 999 } })];
      const sim = new DefenseSimulation(
        towers,
        wave(lane([{ type: 'unit' }, { type: 'unit' }])),
        100,
        monsterCatalog,
        towerCatalog,
        1,
        'attack',
      );

      const outcome = sim.runToCompletion();

      expect(outcome).toBe('success');
      expect(sim.getBreachCount()).toBeGreaterThanOrEqual(1);
    });

    it('fails when the whole wave is destroyed without a single breach', () => {
      const towers = [tower({ typeId: 'strong' })];
      const sim = new DefenseSimulation(
        towers,
        wave(lane([{ type: 'unit' }, { type: 'unit' }])),
        100,
        monsterCatalog,
        towerCatalog,
        1,
        'attack',
      );

      const outcome = sim.runToCompletion();

      expect(outcome).toBe('failure');
      expect(sim.getBreachCount()).toBe(0);
    });

    it('defaults to defense mode when omitted', () => {
      const sim = new DefenseSimulation([], wave(lane([{ type: 'unit' }])), 1, monsterCatalog, towerCatalog, 1);

      expect(sim.runToCompletion()).toBe('failure'); // heart depleted: this is defense-mode behavior
    });
  });

  describe('multi-lane waves', () => {
    it('runs monsters from different lanes concurrently, each along its own path', () => {
      const twoLaneWave = wave(lane([{ type: 'unit' }], p1), lane([{ type: 'unit' }], p2));
      const sim = new DefenseSimulation([], twoLaneWave, 1000, monsterCatalog, towerCatalog, 1);

      sim.step(); // both lanes spawn on the same tick (both queues were empty of delay)

      const monsters = sim.getMonsters();
      expect(monsters).toHaveLength(2);
      const positions = monsters.map((monster) => sim.getMonsterPosition(monster));
      // lane 0 follows p1 (y=0), lane 1 follows p2 (y=3)
      expect(positions).toContainEqual({ x: expect.any(Number), y: 0 });
      expect(positions).toContainEqual({ x: expect.any(Number), y: 3 });
    });

    it('does not resolve success until every lane has finished spawning (defense mode)', () => {
      // Lane 0 starts empty (trivially "done"); lane 1 has one unit but its spawn is delayed.
      // If outcome resolution only checked lane 0, this would wrongly resolve 'success' at tick 1.
      const twoLaneWave = wave(lane([], p1), lane([{ type: 'unit' }], p2));
      const sim = new DefenseSimulation([], twoLaneWave, 1000, monsterCatalog, towerCatalog, 3);

      sim.step(); // tick 1: lane 1 hasn't spawned yet (ticksBetweenSpawns=3)
      expect(sim.getOutcome()).toBe('pending');
      sim.step(); // tick 2: still hasn't spawned
      expect(sim.getOutcome()).toBe('pending');
    });

    it('lets a tower positioned on one lane ignore monsters on another out-of-range lane', () => {
      // tower sits on p1 (y=0) with a tight range; p2 (y=3) is far enough to stay out of range.
      const towers = [tower({ typeId: 'strong', position: { x: 5, y: 0 } })];
      const towerTypeWithTightRange: TowerType = { ...strongTower, id: 'strong', range: 1 };
      const twoLaneWave = wave(lane([{ type: 'goblin' }], p1), lane([{ type: 'goblin' }], p2));
      const sim = new DefenseSimulation(
        towers,
        twoLaneWave,
        100,
        monsterCatalog,
        [towerTypeWithTightRange],
        1,
      );

      // Run a handful of ticks so the p1 goblin walks into range and gets destroyed.
      for (let i = 0; i < 6; i++) {
        sim.step();
      }

      const remaining = sim.getMonsters();
      expect(remaining.some((monster) => sim.getMonsterPosition(monster).y === 3)).toBe(true);
    });

    it('breaches independently attribute heart damage regardless of lane', () => {
      const twoLaneWave = wave(lane([{ type: 'goblin' }], p1), lane([{ type: 'goblin' }], p2));
      const sim = new DefenseSimulation([], twoLaneWave, 2, monsterCatalog, towerCatalog, 1);

      const outcome = sim.runToCompletion();

      // Two goblins (heartDamage 1 each) breach across two lanes -> heart drops to 0 -> failure.
      expect(outcome).toBe('failure');
      expect(sim.getBreachCount()).toBe(2);
    });
  });
});

describe('selectTarget', () => {
  const towerPosition = { x: 10, y: 5 };

  it('picks the most advanced monster in range', () => {
    const candidates = [
      { id: 'a', distance: 3, position: { x: 3, y: 0 } },
      { id: 'b', distance: 8, position: { x: 8, y: 0 } },
    ];
    expect(selectTarget(towerPosition, 100, candidates)).toBe('b');
  });

  it('ignores monsters outside the tower range', () => {
    const candidates = [{ id: 'a', distance: 3, position: { x: 999, y: 999 } }];
    expect(selectTarget(towerPosition, 5, candidates)).toBeUndefined();
  });

  it('returns undefined when there are no candidates', () => {
    expect(selectTarget(towerPosition, 100, [])).toBeUndefined();
  });
});

describe('totalHeartDamage', () => {
  it('sums the heart damage of every unit across all lanes', () => {
    const w = wave(lane([{ type: 'goblin' }, { type: 'goblin' }]), lane([{ type: 'golem' }], p2));
    expect(totalHeartDamage(w, monsterCatalog)).toBe(goblin.heartDamage * 2 + golem.heartDamage);
  });

  it('ignores unknown unit types instead of throwing', () => {
    const w = wave(lane([{ type: 'ghost' }]));
    expect(totalHeartDamage(w, monsterCatalog)).toBe(0);
  });

  it('the shipped forest-01 wave #0 can destroy an undefended heart (CONCEPTION.md §4, §6)', () => {
    // Mirrors projects/open-td/public/maps/forest-01.start.json — if that data changes,
    // this must be kept in sync so a fully undefended heart stays destructible.
    const southPath: MapPath = { id: 'south', nodes: [[0, 12], [0, 18], [16, 18], [16, 12]] };
    const wave0 = wave(
      lane(
        [{ type: 'goblin' }, { type: 'goblin' }, { type: 'goblin' }, { type: 'orc' }, { type: 'goblin' }],
        southPath,
      ),
    );
    const shippedHeartHp = 5;
    expect(totalHeartDamage(wave0)).toBeGreaterThanOrEqual(shippedHeartHp);
  });
});

describe('waveCost', () => {
  it('sums the cost of every unit across all lanes', () => {
    const w = wave(lane([{ type: 'goblin' }, { type: 'goblin' }]), lane([{ type: 'golem' }], p2));
    expect(waveCost(w, monsterCatalog)).toBe(goblin.cost * 2 + golem.cost);
  });

  it('ignores unknown unit types instead of throwing', () => {
    expect(waveCost(wave(lane([{ type: 'ghost' }])), monsterCatalog)).toBe(0);
  });

  it('is zero for an empty composition', () => {
    expect(waveCost(wave(), monsterCatalog)).toBe(0);
  });
});
