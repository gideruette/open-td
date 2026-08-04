import { describe, expect, it } from 'vitest';
import {
  HEX_UNIT_SIZE,
  axialToOddR,
  hexCorners,
  hexDistance,
  hexGridPixelSize,
  hexLinedraw,
  hexNeighbors,
  hexToWorld,
  oddRToAxial,
  worldToHex,
} from './hex';

describe('oddRToAxial / axialToOddR', () => {
  it('round-trips odd-r coordinates', () => {
    const samples = [
      { x: 0, y: 0 },
      { x: 3, y: 2 },
      { x: 4, y: 5 },
      { x: 1, y: 1 },
    ];
    for (const coord of samples) {
      expect(axialToOddR(oddRToAxial(coord))).toEqual(coord);
    }
  });
});

describe('hexDistance', () => {
  it('is zero for the same cell', () => {
    expect(hexDistance({ x: 2, y: 3 }, { x: 2, y: 3 })).toBe(0);
  });

  it('is 1 for each of the six neighbors', () => {
    const origin = { x: 2, y: 2 };
    for (const neighbor of hexNeighbors(origin)) {
      expect(hexDistance(origin, neighbor)).toBe(1);
    }
  });

  it('grows for farther cells', () => {
    expect(hexDistance({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(3);
  });
});

describe('hexNeighbors', () => {
  it('returns exactly six distinct neighbors', () => {
    const neighbors = hexNeighbors({ x: 2, y: 2 });
    expect(neighbors).toHaveLength(6);
    const keys = new Set(neighbors.map((n) => `${n.x},${n.y}`));
    expect(keys.size).toBe(6);
  });
});

describe('hexLinedraw', () => {
  it('returns nothing for identical cells', () => {
    expect(hexLinedraw({ x: 1, y: 1 }, { x: 1, y: 1 })).toEqual([]);
  });

  it('returns the destination when already adjacent', () => {
    const from = { x: 1, y: 1 };
    const to = hexNeighbors(from)[0];
    expect(hexLinedraw(from, to)).toEqual([to]);
  });

  it('fills a horizontal line with adjacent steps', () => {
    const steps = hexLinedraw({ x: 0, y: 0 }, { x: 3, y: 0 });
    expect(steps.at(-1)).toEqual({ x: 3, y: 0 });
    let previous = { x: 0, y: 0 };
    for (const step of steps) {
      expect(hexDistance(previous, step)).toBe(1);
      previous = step;
    }
  });

  it('each step stays at hex distance 1 from the previous', () => {
    const steps = hexLinedraw({ x: 0, y: 0 }, { x: 4, y: 3 });
    let previous = { x: 0, y: 0 };
    for (const step of steps) {
      expect(hexDistance(previous, step)).toBe(1);
      previous = step;
    }
    expect(previous).toEqual({ x: 4, y: 3 });
  });
});

describe('hexToWorld / worldToHex', () => {
  it('places neighboring centers at distance ~1 with HEX_UNIT_SIZE', () => {
    const a = hexToWorld({ x: 0, y: 0 });
    const b = hexToWorld({ x: 1, y: 0 });
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(1, 10);
  });

  it('round-trips discrete cells through world space', () => {
    const samples = [
      { x: 0, y: 0 },
      { x: 5, y: 2 },
      { x: 3, y: 7 },
      { x: 1, y: 1 },
    ];
    for (const coord of samples) {
      const world = hexToWorld(coord);
      expect(worldToHex(world.x, world.y)).toEqual(coord);
    }
  });

  it('scales with an explicit outer radius', () => {
    const size = 32;
    const a = hexToWorld({ x: 0, y: 0 }, size);
    const b = hexToWorld({ x: 1, y: 0 }, size);
    expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(size * Math.sqrt(3), 10);
  });
});

describe('hexCorners', () => {
  it('returns six corners around the cell center', () => {
    const center = hexToWorld({ x: 2, y: 1 }, HEX_UNIT_SIZE);
    const corners = hexCorners({ x: 2, y: 1 }, HEX_UNIT_SIZE);
    expect(corners).toHaveLength(6);
    for (const corner of corners) {
      expect(Math.hypot(corner.x - center.x, corner.y - center.y)).toBeCloseTo(HEX_UNIT_SIZE, 10);
    }
  });
});

describe('hexGridPixelSize', () => {
  it('grows with cols and rows', () => {
    const small = hexGridPixelSize(4, 4, 10);
    const wide = hexGridPixelSize(8, 4, 10);
    const tall = hexGridPixelSize(4, 8, 10);
    expect(wide.width).toBeGreaterThan(small.width);
    expect(tall.height).toBeGreaterThan(small.height);
  });
});
