import { describe, expect, it } from 'vitest';
import type { GridCoord, MapPath, MonsterType, TowerInstance, TowerType, Wave, WaveLane, WaveUnit } from 'shared';
import { hexToWorld } from 'shared';
import { DefenseSimulation, phaseScore, selectTarget, spreadScore, totalChateauDamage, waveCost } from './combat';
import { pathCellsCost } from './path';

const p1: MapPath = { id: 'p1', nodes: [[0, 0], [20, 0]] };
const p2: MapPath = { id: 'p2', nodes: [[0, 3], [20, 3]] };
const chateau: GridCoord = { x: 20, y: 0 };

function lane(units: WaveUnit[] = [], path: MapPath = p1): WaveLane {
  return { path, units };
}

function wave(...lanes: WaveLane[]): Wave {
  return { lanes };
}

const unit: MonsterType = { id: 'unit', name: 'Unit', description: '', cost: 1, hp: 1000, speed: 1, armored: false, chateauDamage: 1 };
const goblin: MonsterType = { id: 'goblin', name: 'Gobelin', description: '', cost: 5, hp: 20, speed: 1, armored: false, chateauDamage: 1 };
const golem: MonsterType = { id: 'golem', name: 'Golem', description: '', cost: 30, hp: 40, speed: 1, armored: true, chateauDamage: 4 };
const regenerating: MonsterType = {
  id: 'regenerating',
  name: 'Regenerating',
  description: '',
  cost: 1,
  hp: 20,
  speed: 1,
  armored: false,
  chateauDamage: 1,
  regenPerTick: 5,
};
const slowResistant: MonsterType = {
  id: 'slow-resistant',
  name: 'Slow resistant',
  description: '',
  cost: 1,
  hp: 1000,
  speed: 1,
  armored: false,
  chateauDamage: 1,
  slowResistance: 1,
};
const partiallySlowResistant: MonsterType = {
  id: 'partially-slow-resistant',
  name: 'Partially slow resistant',
  description: '',
  cost: 1,
  hp: 1000,
  speed: 1,
  armored: false,
  chateauDamage: 1,
  slowResistance: 0.5,
};
const splitter: MonsterType = {
  id: 'splitter',
  name: 'Splitter',
  description: '',
  cost: 1,
  hp: 10,
  speed: 1,
  armored: false,
  chateauDamage: 1,
  splitOnDeath: { typeId: 'split-child', count: 2 },
};
const splitChild: MonsterType = {
  id: 'split-child',
  name: 'Split child',
  description: '',
  cost: 1,
  hp: 5,
  speed: 1,
  armored: false,
  chateauDamage: 1,
};
const monsterCatalog: MonsterType[] = [
  unit,
  goblin,
  golem,
  regenerating,
  slowResistant,
  partiallySlowResistant,
  splitter,
  splitChild,
];

const weakTower: TowerType = { id: 'weak', name: 'Weak', description: '', cost: 1, range: 100, damage: 1, cooldown: 1000 };
const strongTower: TowerType = { id: 'strong', name: 'Strong', description: '', cost: 1, range: 100, damage: 1000, cooldown: 1 };
const splashTower: TowerType = {
  id: 'splash',
  name: 'Splash',
  description: '',
  cost: 1,
  range: 2,
  damage: 15,
  cooldown: 1000,
  splashRadius: 2,
};
const slowTower: TowerType = {
  id: 'slow',
  name: 'Slow',
  description: '',
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
  description: '',
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
  it('fails once the chateau hp is depleted by monsters reaching the end of the path', () => {
    const sim = new DefenseSimulation([], wave(lane([{ type: 'unit' }])), 1, monsterCatalog, towerCatalog, 1);

    const outcome = sim.runToCompletion();

    expect(outcome).toBe('failure');
    expect(sim.getChateauHp()).toBeLessThanOrEqual(0);
  });

  it('fails as soon as the chateau takes any damage, even if it survives above zero', () => {
    const sim = new DefenseSimulation([], wave(lane([{ type: 'unit' }])), 100, monsterCatalog, towerCatalog, 1);

    const outcome = sim.runToCompletion();

    expect(outcome).toBe('failure');
    expect(sim.getChateauHp()).toBe(99);
  });

  it('succeeds when every monster is destroyed before reaching the chateau', () => {
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
    expect(sim.getChateauHp()).toBe(10);
  });

  describe('phaseScore', () => {
    it('is derived from the spread (towers + route cells) once every monster is destroyed, not from the chateau hp', () => {
      const towers = [tower({ typeId: 'strong' })];
      const testWave = wave(lane([{ type: 'unit' }, { type: 'unit' }]));

      const score = phaseScore(towers, testWave, 10, chateau, monsterCatalog, towerCatalog, 'defense');

      expect(score).not.toBe(10);
      expect(score).toBeGreaterThan(spreadScore(towers, testWave, chateau));
    });

    it('ranks a more spread-out successful defense above a more compact one', () => {
      // Les tours sont posées hors du tracé (y=5, la voie longe y=0) pour ne pas se confondre
      // avec une case de route déjà comptée dans l'étalement.
      const testWave = wave(lane([{ type: 'unit' }, { type: 'unit' }]));
      const oneTower = [tower({ typeId: 'strong', position: { x: 10, y: 5 } })];
      const twoTowers = [
        tower({ typeId: 'strong', position: { x: 10, y: 5 } }),
        tower({ id: 't2', typeId: 'strong', position: { x: 11, y: 5 } }),
      ];

      const scoreOneTower = phaseScore(oneTower, testWave, 10, chateau, monsterCatalog, towerCatalog, 'defense');
      const scoreTwoTowers = phaseScore(twoTowers, testWave, 10, chateau, monsterCatalog, towerCatalog, 'defense');

      expect(scoreTwoTowers).toBeGreaterThan(scoreOneTower);
    });

    it('can go negative once the chateau is depleted by more monsters than it has hp for (failure)', () => {
      const score = phaseScore([], wave(lane([{ type: 'unit' }, { type: 'unit' }])), 1, chateau, monsterCatalog, towerCatalog, 'defense');

      expect(score).toBe(-1);
    });
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

  it('regenerates hp each tick up to the type max, on top of damage taken', () => {
    const towers = [tower({ typeId: 'weak' })];
    const sim = new DefenseSimulation(
      towers,
      wave(lane([{ type: 'regenerating' }])),
      100,
      monsterCatalog,
      towerCatalog,
      1,
    );

    sim.step(); // spawn at hp 20 (already max), weak tower hits for 1 -> 19
    expect(sim.getMonsters()[0].hp).toBe(19);

    sim.step(); // weak tower still on cooldown (1000); regen brings hp back up, capped at 20
    expect(sim.getMonsters()[0].hp).toBe(20);
  });

  it('reduces the effective slow of a monster with partial slow resistance', () => {
    const towers = [tower({ typeId: 'slow' })];
    const sim = new DefenseSimulation(
      towers,
      wave(lane([{ type: 'partially-slow-resistant' }])),
      100,
      monsterCatalog,
      towerCatalog,
      1,
    );

    sim.step();
    const [monster] = sim.getMonsters();

    // slowFactor 0.5 blended halfway toward 1 (resistance 0.5) -> effective factor 0.75
    expect(monster.distance).toBeCloseTo(partiallySlowResistant.speed * 0.75, 5);
  });

  it('fully immunizes a monster with maximum slow resistance', () => {
    const towers = [tower({ typeId: 'slow' })];
    const sim = new DefenseSimulation(
      towers,
      wave(lane([{ type: 'slow-resistant' }])),
      100,
      monsterCatalog,
      towerCatalog,
      1,
    );

    sim.step();
    const [monster] = sim.getMonsters();

    expect(monster.distance).toBeCloseTo(slowResistant.speed, 5);
  });

  it('replaces a monster with splitOnDeath by its children when killed', () => {
    const towers = [tower({ typeId: 'strong' })];
    const sim = new DefenseSimulation(
      towers,
      wave(lane([{ type: 'splitter' }])),
      100,
      monsterCatalog,
      towerCatalog,
      1,
    );

    sim.step(); // strong tower (damage 1000) kills the splitter on the tick it spawns

    const monsters = sim.getMonsters();
    expect(monsters).toHaveLength(2);
    expect(monsters.every((monster) => monster.typeId === 'split-child')).toBe(true);
    expect(monsters.every((monster) => monster.hp === splitChild.hp)).toBe(true);
  });

  describe('spawn gap proportional to monster speed', () => {
    const fast: MonsterType = {
      id: 'fast',
      name: 'Fast',
      description: '',
      cost: 1,
      hp: 1000,
      speed: 0.5,
      armored: false,
      chateauDamage: 1,
    };
    const slow: MonsterType = {
      id: 'slow',
      name: 'Slow',
      description: '',
      cost: 1,
      hp: 1000,
      speed: 0.25,
      armored: false,
      chateauDamage: 1,
    };
    const speedCatalog: MonsterType[] = [fast, slow];

    function tickOfSecondSpawn(typeId: string, catalog: readonly MonsterType[] = speedCatalog): number {
      const sim = new DefenseSimulation(
        [],
        wave(lane([{ type: typeId }, { type: typeId }])),
        1000,
        catalog,
        towerCatalog,
        8,
      );
      let tick = 0;
      while (sim.getMonsters().length < 2 && tick < 200) {
        sim.step();
        tick++;
      }
      return tick;
    }

    it('spawns a monster twice as fast in half the ticks of one at half the speed', () => {
      const fastGap = tickOfSecondSpawn('fast');
      const slowGap = tickOfSecondSpawn('slow');

      expect(slowGap).toBe(fastGap * 2);
    });

    it('never gates a spawn to less than one tick apart, however fast the monster', () => {
      // speed 5 makes the raw gap (ticksBetweenSpawns * referenceSpeed / speed = 8*0.25/5 = 0.4)
      // round down to 0 ticks without the floor: the long path keeps both monsters on the board
      // long enough to observe that the floor of 1 tick is actually enforced.
      const veryFast: MonsterType = { ...fast, id: 'very-fast', speed: 5 };
      const longPath: MapPath = { id: 'long', nodes: [[0, 0], [1000, 0]] };
      const sim = new DefenseSimulation(
        [],
        wave(lane([{ type: 'very-fast' }, { type: 'very-fast' }], longPath)),
        1000,
        [veryFast],
        towerCatalog,
        8,
      );

      sim.step();
      sim.step();

      expect(sim.getMonsters()).toHaveLength(2);
    });
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
    it('succeeds once the chateau is destroyed, even if towers remain and other units are still queued', () => {
      // tower placed far off the path: out of range of every monster, so the wave goes unopposed.
      const towers = [tower({ typeId: 'weak', position: { x: 999, y: 999 } })];
      const sim = new DefenseSimulation(
        towers,
        wave(lane([{ type: 'unit' }, { type: 'unit' }, { type: 'unit' }])),
        1,
        monsterCatalog,
        towerCatalog,
        1,
        'attack',
      );

      const outcome = sim.runToCompletion();

      expect(outcome).toBe('success');
      expect(sim.getChateauHp()).toBeLessThanOrEqual(0);
      // Destroyed by the first breach alone: the two remaining queued units never had to spawn.
      expect(sim.getBreachCount()).toBe(1);
    });

    it('does not succeed on a breach that fails to destroy the chateau', () => {
      // tower placed far off the path: out of range of every monster, so the wave goes unopposed.
      const towers = [tower({ typeId: 'weak', position: { x: 999, y: 999 } })];
      const sim = new DefenseSimulation(
        towers,
        wave(lane([{ type: 'unit' }])),
        100,
        monsterCatalog,
        towerCatalog,
        1,
        'attack',
      );

      const outcome = sim.runToCompletion();

      expect(outcome).toBe('failure');
      expect(sim.getBreachCount()).toBe(1);
      expect(sim.getChateauHp()).toBe(99);
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

      expect(sim.runToCompletion()).toBe('failure'); // chateau depleted: this is defense-mode behavior
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
      // lane 0 follows p1 (row 0), lane 1 follows p2 (row 3) — positions are world-space.
      const lane0Y = hexToWorld({ x: 0, y: 0 }).y;
      const lane1Y = hexToWorld({ x: 0, y: 3 }).y;
      expect(positions.some((pos) => Math.abs(pos.y - lane0Y) < 1e-9)).toBe(true);
      expect(positions.some((pos) => Math.abs(pos.y - lane1Y) < 1e-9)).toBe(true);
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
      const lane1Y = hexToWorld({ x: 0, y: 3 }).y;
      expect(remaining.some((monster) => Math.abs(sim.getMonsterPosition(monster).y - lane1Y) < 1e-9)).toBe(
        true,
      );
    });

    it('breaches independently attribute chateau damage regardless of lane', () => {
      const twoLaneWave = wave(lane([{ type: 'goblin' }], p1), lane([{ type: 'goblin' }], p2));
      const sim = new DefenseSimulation([], twoLaneWave, 2, monsterCatalog, towerCatalog, 1);

      const outcome = sim.runToCompletion();

      // Two goblins (chateauDamage 1 each) breach across two lanes -> chateau drops to 0 -> failure.
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

describe('totalChateauDamage', () => {
  it('sums the chateau damage of every unit across all lanes', () => {
    const w = wave(lane([{ type: 'goblin' }, { type: 'goblin' }]), lane([{ type: 'golem' }], p2));
    expect(totalChateauDamage(w, monsterCatalog)).toBe(goblin.chateauDamage * 2 + golem.chateauDamage);
  });

  it('ignores unknown unit types instead of throwing', () => {
    const w = wave(lane([{ type: 'ghost' }]));
    expect(totalChateauDamage(w, monsterCatalog)).toBe(0);
  });

  it('the shipped forest-01 wave #0 can destroy an undefended chateau (CONCEPTION.md §4, §6)', () => {
    // Mirrors projects/open-td/public/maps/forest-01.start.json — if that data changes,
    // this must be kept in sync so a fully undefended chateau stays destructible.
    const westPath: MapPath = {
      id: 'west',
      nodes: [
        [16, 23],
        [2, 23],
        [2, 2],
        [16, 2],
        [16, 12],
      ],
    };
    const wave0 = wave(
      lane(
        [{ type: 'goblin' }, { type: 'goblin' }, { type: 'goblin' }, { type: 'orc' }, { type: 'goblin' }],
        westPath,
      ),
    );
    const shippedChateauHp = 5;
    expect(totalChateauDamage(wave0)).toBeGreaterThanOrEqual(shippedChateauHp);
  });
});

describe('waveCost', () => {
  it('sums the cost of every unit across all lanes, plus the cost of each lane\'s path cells', () => {
    const w = wave(lane([{ type: 'goblin' }, { type: 'goblin' }]), lane([{ type: 'golem' }], p2));
    expect(waveCost(w, monsterCatalog)).toBe(
      goblin.cost * 2 + golem.cost + pathCellsCost([p1, p2]),
    );
  });

  it('ignores unknown unit types instead of throwing', () => {
    expect(waveCost(wave(lane([{ type: 'ghost' }])), monsterCatalog)).toBe(pathCellsCost([p1]));
  });

  it('is zero for an empty composition', () => {
    expect(waveCost(wave(), monsterCatalog)).toBe(0);
  });

  it('charges the cells of an overlapping path only once, across lanes (CONCEPTION.md §5.3)', () => {
    const overlapping: MapPath = { id: 'overlapping', nodes: [[0, 0], [20, 0]] };
    const w = wave(lane([{ type: 'goblin' }], p1), lane([{ type: 'goblin' }], overlapping));
    expect(waveCost(w, monsterCatalog)).toBe(goblin.cost * 2 + pathCellsCost([p1]));
  });

  it('accepts a custom cost per path cell', () => {
    const w = wave(lane([{ type: 'goblin' }]));
    expect(waveCost(w, monsterCatalog, 5)).toBe(goblin.cost + pathCellsCost([p1], 5));
  });
});
