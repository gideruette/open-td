import type { StartingData } from './types';

/** Niveau de difficulté indicatif affiché à l'écran de sélection de carte. */
export type MapDifficulty = 'facile' | 'modérée' | 'difficile';

/** Biome d'une carte : détermine son habillage visuel (fond + couleur des chemins). */
export type MapBiome = 'clairiere' | 'foret' | 'marais' | 'toundra' | 'montagne';

export interface MapBiomeColors {
  /** Couleur de fond du plateau. */
  background: string;
  /** Couleur des chemins (route empruntée par les monstres). */
  path: string;
}

/** Une couleur de fond et de chemin par biome, appliquée uniformément à toute la carte. */
export const BIOME_COLORS: Record<MapBiome, MapBiomeColors> = {
  clairiere: { background: '#132016', path: '#d9c37a' },
  foret: { background: '#0e1712', path: '#c9a24b' },
  marais: { background: '#0e1a16', path: '#8a9a4a' },
  toundra: { background: '#141a22', path: '#bcd8e8' },
  montagne: { background: '#181414', path: '#9a8f7a' },
};

/**
 * Entrée du catalogue de cartes de départ (écran d'accueil, CONCEPTION.md §9 « Sélection carte »).
 * La géométrie (`{id}.map.json`) est chargée depuis `public/maps/` une fois la carte choisie ;
 * le paramétrage de la run (budgets, vague #0) est porté directement par le catalogue.
 */
export interface MapCatalogEntry {
  id: string;
  name: string;
  description: string;
  difficulty: MapDifficulty;
  biome: MapBiome;
  grid: { cols: number; rows: number };
  startingData: StartingData;
}

/** Les 5 cartes de départ proposées à l'écran d'accueil, de dimensions et difficultés variées. */
export const MAP_CATALOG: readonly MapCatalogEntry[] = [
  {
    id: 'clairiere-02',
    name: 'Clairière',
    description: 'Petite carte resserrée avec un seul spawn : idéale pour découvrir le jeu.',
    difficulty: 'facile',
    biome: 'clairiere',
    grid: { cols: 16, rows: 12 },
    startingData: {
      mapId: 'clairiere-02',
      startingDefenseBudget: 70,
      startingAttackBudget: 50,
      budgetGrowth: { defense: 30, attack: 20 },
      heartHp: 5,
      initialWave: {
        lanes: [
          {
            path: {
              id: 'sud',
              nodes: [
                [0, 6],
                [0, 10],
                [8, 10],
                [8, 6],
              ],
            },
            units: [{ type: 'goblin' }, { type: 'goblin' }, { type: 'goblin' }, { type: 'goblin' }],
          },
        ],
      },
    },
  },
  {
    id: 'forest-01',
    name: 'Forêt',
    description: 'Un spawn, deux chemins en tenailles autour du cœur.',
    difficulty: 'modérée',
    biome: 'foret',
    grid: { cols: 32, rows: 24 },
    startingData: {
      mapId: 'forest-01',
      startingDefenseBudget: 100,
      startingAttackBudget: 80,
      budgetGrowth: { defense: 40, attack: 30 },
      heartHp: 5,
      initialWave: {
        lanes: [
          {
            path: {
              id: 'south',
              nodes: [
                [0, 12],
                [0, 18],
                [16, 18],
                [16, 12],
              ],
            },
            units: [
              { type: 'goblin' },
              { type: 'goblin' },
              { type: 'goblin' },
              { type: 'orc' },
              { type: 'goblin' },
            ],
          },
        ],
      },
    },
  },
  {
    id: 'marais-03',
    name: 'Marais',
    description: 'Deux spawns opposés : la pression peut venir des deux côtés à la fois.',
    difficulty: 'modérée',
    biome: 'marais',
    grid: { cols: 24, rows: 18 },
    startingData: {
      mapId: 'marais-03',
      startingDefenseBudget: 130,
      startingAttackBudget: 100,
      budgetGrowth: { defense: 45, attack: 35 },
      heartHp: 6,
      initialWave: {
        lanes: [
          {
            path: { id: 'ouest', nodes: [[0, 9], [12, 9]] },
            units: [{ type: 'goblin' }, { type: 'goblin' }, { type: 'goblin' }, { type: 'orc' }],
          },
          {
            path: { id: 'est', nodes: [[23, 9], [12, 9]] },
            units: [{ type: 'goblin' }, { type: 'goblin' }, { type: 'goblin' }],
          },
        ],
      },
    },
  },
  {
    id: 'toundra-05',
    name: 'Toundra',
    description: 'Carte large et basse : deux longues voies encerclantes.',
    difficulty: 'difficile',
    biome: 'toundra',
    grid: { cols: 48, rows: 16 },
    startingData: {
      mapId: 'toundra-05',
      startingDefenseBudget: 140,
      startingAttackBudget: 110,
      budgetGrowth: { defense: 48, attack: 38 },
      heartHp: 6,
      initialWave: {
        lanes: [
          {
            path: {
              id: 'haut',
              nodes: [
                [0, 8],
                [0, 2],
                [24, 2],
                [24, 8],
              ],
            },
            units: [{ type: 'goblin' }, { type: 'goblin' }, { type: 'goblin' }, { type: 'orc' }],
          },
          {
            path: {
              id: 'bas',
              nodes: [
                [0, 8],
                [0, 14],
                [24, 14],
                [24, 8],
              ],
            },
            units: [{ type: 'goblin' }, { type: 'goblin' }, { type: 'goblin' }, { type: 'orc' }],
          },
        ],
      },
    },
  },
  {
    id: 'montagne-04',
    name: 'Montagne',
    description: 'Grande carte, trois spawns et trois voies d’assaut simultanées.',
    difficulty: 'difficile',
    biome: 'montagne',
    grid: { cols: 40, rows: 30 },
    startingData: {
      mapId: 'montagne-04',
      startingDefenseBudget: 160,
      startingAttackBudget: 120,
      budgetGrowth: { defense: 50, attack: 40 },
      heartHp: 7,
      initialWave: {
        lanes: [
          {
            path: {
              id: 'haute',
              nodes: [
                [0, 5],
                [10, 5],
                [10, 15],
                [20, 15],
              ],
            },
            units: [{ type: 'goblin' }, { type: 'goblin' }, { type: 'orc' }],
          },
          {
            path: { id: 'centrale', nodes: [[0, 15], [20, 15]] },
            units: [{ type: 'orc' }, { type: 'orc' }],
          },
          {
            path: {
              id: 'basse',
              nodes: [
                [0, 25],
                [10, 25],
                [10, 15],
                [20, 15],
              ],
            },
            units: [{ type: 'goblin' }, { type: 'goblin' }, { type: 'orc' }],
          },
        ],
      },
    },
  },
];

export function findMapCatalogEntry(id: string): MapCatalogEntry | undefined {
  return MAP_CATALOG.find((entry) => entry.id === id);
}
