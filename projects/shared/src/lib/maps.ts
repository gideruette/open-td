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
  /** Couleur des éléments de décor (végétation, roches…) semés sur le fond. */
  decor: string;
}

/** Une couleur de fond, de chemin et de décor par biome, appliquée uniformément à toute la carte. */
export const BIOME_COLORS: Record<MapBiome, MapBiomeColors> = {
  clairiere: { background: '#132016', path: '#d9c37a', decor: '#2f5a37' },
  foret: { background: '#0e1712', path: '#c9a24b', decor: '#1f3a24' },
  marais: { background: '#0e1a16', path: '#8a9a4a', decor: '#173028' },
  toundra: { background: '#141a22', path: '#bcd8e8', decor: '#2c3e4e' },
  montagne: { background: '#181414', path: '#9a8f7a', decor: '#2c2622' },
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
  grid: { cols: number; rows: number; cell: 'hex'; orientation: 'pointy'; offset: 'odd-r' };
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
    grid: { cols: 16, rows: 12, cell: 'hex', orientation: 'pointy', offset: 'odd-r' },
    startingData: {
      mapId: 'clairiere-02',
      startingDefenseBudget: 70,
      startingAttackBudget: 50,
      budgetGrowth: { defense: 30, attack: 20 },
      chateauHp: 5,
      initialWave: {
        lanes: [
          {
            path: {
              id: 'ouest',
              nodes: [
                [8, 11],
                [1, 11],
                [1, 1],
                [8, 1],
                [8, 6],
              ],
            },
            units: [{ type: 'goblin' }, { type: 'goblin' }, { type: 'goblin' }, { type: 'goblin' }],
          },
          {
            path: {
              id: 'est',
              nodes: [
                [8, 11],
                [14, 11],
                [14, 1],
                [8, 1],
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
    description: 'Un spawn bas, deux chemins en tenailles autour du château.',
    difficulty: 'modérée',
    biome: 'foret',
    grid: { cols: 32, rows: 24, cell: 'hex', orientation: 'pointy', offset: 'odd-r' },
    startingData: {
      mapId: 'forest-01',
      startingDefenseBudget: 100,
      startingAttackBudget: 80,
      budgetGrowth: { defense: 40, attack: 30 },
      chateauHp: 5,
      initialWave: {
        lanes: [
          {
            path: {
              id: 'west',
              nodes: [
                [16, 23],
                [2, 23],
                [2, 2],
                [16, 2],
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
    description:
      'Deux spawns opposés (haut et bas) : la pression peut venir des deux côtés à la fois.',
    difficulty: 'modérée',
    biome: 'marais',
    grid: { cols: 24, rows: 18, cell: 'hex', orientation: 'pointy', offset: 'odd-r' },
    startingData: {
      mapId: 'marais-03',
      startingDefenseBudget: 130,
      startingAttackBudget: 100,
      budgetGrowth: { defense: 45, attack: 35 },
      chateauHp: 6,
      initialWave: {
        lanes: [
          {
            path: {
              id: 'nord',
              nodes: [
                [12, 0],
                [3, 0],
                [3, 9],
                [12, 9],
              ],
            },
            units: [{ type: 'goblin' }, { type: 'goblin' }, { type: 'goblin' }, { type: 'orc' }],
          },
          {
            path: {
              id: 'sud',
              nodes: [
                [12, 17],
                [20, 17],
                [20, 9],
                [12, 9],
              ],
            },
            units: [{ type: 'goblin' }, { type: 'goblin' }, { type: 'goblin' }],
          },
        ],
      },
    },
  },
  {
    id: 'toundra-05',
    name: 'Toundra',
    description: 'Carte large et basse : deux longues voies encerclantes depuis le bas.',
    difficulty: 'difficile',
    biome: 'toundra',
    grid: { cols: 48, rows: 16, cell: 'hex', orientation: 'pointy', offset: 'odd-r' },
    startingData: {
      mapId: 'toundra-05',
      startingDefenseBudget: 140,
      startingAttackBudget: 110,
      budgetGrowth: { defense: 48, attack: 38 },
      chateauHp: 6,
      initialWave: {
        lanes: [
          {
            path: {
              id: 'ouest',
              nodes: [
                [24, 15],
                [2, 15],
                [2, 1],
                [24, 1],
                [24, 8],
              ],
            },
            units: [{ type: 'goblin' }, { type: 'goblin' }, { type: 'goblin' }, { type: 'orc' }],
          },
          {
            path: {
              id: 'est',
              nodes: [
                [24, 15],
                [45, 15],
                [45, 1],
                [24, 1],
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
    description: 'Grande carte, trois spawns (haut et bas) et trois voies d’assaut simultanées.',
    difficulty: 'difficile',
    biome: 'montagne',
    grid: { cols: 40, rows: 30, cell: 'hex', orientation: 'pointy', offset: 'odd-r' },
    startingData: {
      mapId: 'montagne-04',
      startingDefenseBudget: 160,
      startingAttackBudget: 120,
      budgetGrowth: { defense: 50, attack: 40 },
      chateauHp: 7,
      initialWave: {
        lanes: [
          {
            path: {
              id: 'haute-ouest',
              nodes: [
                [5, 0],
                [2, 0],
                [2, 15],
                [20, 15],
              ],
            },
            units: [{ type: 'goblin' }, { type: 'goblin' }, { type: 'orc' }],
          },
          {
            path: {
              id: 'haute-est',
              nodes: [
                [35, 0],
                [37, 0],
                [37, 15],
                [20, 15],
              ],
            },
            units: [{ type: 'orc' }, { type: 'orc' }],
          },
          {
            path: {
              id: 'basse',
              nodes: [
                [20, 29],
                [8, 29],
                [8, 22],
                [20, 22],
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
