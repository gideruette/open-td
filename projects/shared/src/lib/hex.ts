import type { GridCoord } from './types';

/** √3 — constante locale (Math.SQRT3 n'est pas dans les lib TS ciblées). */
const SQRT3 = Math.sqrt(3);

/** Coordonnées axiales (q, r) — usage interne pour la géométrie hex. */
export interface AxialCoord {
  q: number;
  r: number;
}

/**
 * Rayon extérieur (centre → sommet) tel que la distance entre centres de deux
 * hexagones voisins vaille 1. Utilisé par défaut pour le monde logique du moteur.
 */
export const HEX_UNIT_SIZE = 1 / SQRT3;

/** Six directions axiales pointy-top (voisins immédiats). */
const AXIAL_DIRS: readonly AxialCoord[] = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

/** Offset odd-r (col=x, row=y) → axial. */
export function oddRToAxial(coord: GridCoord): AxialCoord {
  const q = coord.x - (coord.y - (coord.y & 1)) / 2;
  const r = coord.y;
  return { q, r };
}

/** Axial → offset odd-r. */
export function axialToOddR(axial: AxialCoord): GridCoord {
  const x = axial.q + (axial.r - (axial.r & 1)) / 2;
  const y = axial.r;
  return { x, y };
}

function axialToCube(a: AxialCoord): { x: number; y: number; z: number } {
  return { x: a.q, z: a.r, y: -a.q - a.r };
}

/** Distance hex (nombre de pas) entre deux cases odd-r. */
export function hexDistance(a: GridCoord, b: GridCoord): number {
  const ac = axialToCube(oddRToAxial(a));
  const bc = axialToCube(oddRToAxial(b));
  return (Math.abs(ac.x - bc.x) + Math.abs(ac.y - bc.y) + Math.abs(ac.z - bc.z)) / 2;
}

/** Les 6 voisins immédiats d'une case odd-r. */
export function hexNeighbors(coord: GridCoord): GridCoord[] {
  const axial = oddRToAxial(coord);
  return AXIAL_DIRS.map((dir) => axialToOddR({ q: axial.q + dir.q, r: axial.r + dir.r }));
}

function cubeLerp(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
  t: number,
): { x: number; y: number; z: number } {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

function cubeRound(cube: { x: number; y: number; z: number }): AxialCoord {
  let rx = Math.round(cube.x);
  let ry = Math.round(cube.y);
  let rz = Math.round(cube.z);
  const xDiff = Math.abs(rx - cube.x);
  const yDiff = Math.abs(ry - cube.y);
  const zDiff = Math.abs(rz - cube.z);
  if (xDiff > yDiff && xDiff > zDiff) {
    rx = -ry - rz;
  } else if (yDiff > zDiff) {
    ry = -rx - rz;
  } else {
    rz = -rx - ry;
  }
  return { q: rx, r: rz };
}

/**
 * Cases discrètes sur la ligne hex de `from` à `to` (from exclue, to incluse).
 * Équivalent hex du Bresenham utilisé pour le tracé libre.
 */
export function hexLinedraw(from: GridCoord, to: GridCoord): GridCoord[] {
  const n = hexDistance(from, to);
  if (n === 0) {
    return [];
  }
  const a = axialToCube(oddRToAxial(from));
  const b = axialToCube(oddRToAxial(to));
  // Nudge pour éviter les ambiguïtés sur les frontières de cubes.
  const bNudge = { x: b.x + 1e-6, y: b.y + 2e-6, z: b.z - 3e-6 };
  const cells: GridCoord[] = [];
  for (let i = 1; i <= n; i++) {
    cells.push(axialToOddR(cubeRound(cubeLerp(a, bNudge, i / n))));
  }
  return cells;
}

/**
 * Centre d'une case odd-r en coordonnées monde (pointy-top).
 * Avec `size = HEX_UNIT_SIZE` (défaut), la distance entre centres voisins vaut 1.
 * Avec `size` = rayon extérieur en pixels, le résultat est directement en pixels.
 */
export function hexToWorld(coord: GridCoord, size: number = HEX_UNIT_SIZE): GridCoord {
  const { q, r } = oddRToAxial(coord);
  return {
    x: size * (SQRT3 * q + (SQRT3 / 2) * r),
    y: size * ((3 / 2) * r),
  };
}

/** Arrondi d'une position monde vers la case odd-r la plus proche (hex-round). */
export function worldToHex(wx: number, wy: number, size: number = HEX_UNIT_SIZE): GridCoord {
  const q = ((SQRT3 / 3) * wx - (1 / 3) * wy) / size;
  const r = ((2 / 3) * wy) / size;
  return axialToOddR(cubeRound(axialToCube({ q, r })));
}

/** Les 6 sommets d'un hex pointy-top centré sur `hexToWorld(coord, size)`. */
export function hexCorners(coord: GridCoord, size: number = HEX_UNIT_SIZE): GridCoord[] {
  const center = hexToWorld(coord, size);
  const corners: GridCoord[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = -Math.PI / 2 + (Math.PI / 3) * i;
    corners.push({
      x: center.x + size * Math.cos(angle),
      y: center.y + size * Math.sin(angle),
    });
  }
  return corners;
}

/**
 * Dimensions du canvas pour une grille odd-r pointy-top de `cols`×`rows`,
 * avec `size` = rayon extérieur (centre → sommet).
 */
export function hexGridPixelSize(
  cols: number,
  rows: number,
  size: number,
): { width: number; height: number } {
  return {
    width: SQRT3 * size * (cols + 0.5),
    height: size * (1.5 * (rows - 1) + 2),
  };
}
