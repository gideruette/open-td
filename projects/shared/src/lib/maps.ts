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
  /** Couleur des cases de rivière (terrain non constructible). */
  river: string;
}

/** Une couleur de fond, de chemin, de décor et de rivière par biome, appliquée uniformément à toute la carte. */
export const BIOME_COLORS: Record<MapBiome, MapBiomeColors> = {
  clairiere: { background: '#132016', path: '#d9c37a', decor: '#2f5a37', river: '#2c5f78' },
  foret: { background: '#0e1712', path: '#c9a24b', decor: '#1f3a24', river: '#255a72' },
  marais: { background: '#0e1a16', path: '#8a9a4a', decor: '#173028', river: '#1f5266' },
  toundra: { background: '#141a22', path: '#bcd8e8', decor: '#2c3e4e', river: '#3a7a9e' },
  montagne: { background: '#181414', path: '#9a8f7a', decor: '#2c2622', river: '#2f6480' },
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
      startingDefenseBudget: 140,
      startingAttackBudget: 100,
      budgetGrowth: { defense: 60, attack: 40 },
      chateauHp: 5,
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
      startingDefenseBudget: 120,
      startingAttackBudget: 100,
      budgetGrowth: { defense: 80, attack: 60 },
      chateauHp: 5,
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
      startingDefenseBudget: 260,
      startingAttackBudget: 200,
      budgetGrowth: { defense: 90, attack: 70 },
      chateauHp: 6,
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
      startingDefenseBudget: 280,
      startingAttackBudget: 220,
      budgetGrowth: { defense: 100, attack: 80 },
      chateauHp: 6,
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
      startingDefenseBudget: 320,
      startingAttackBudget: 240,
      budgetGrowth: { defense: 100, attack: 80 },
      chateauHp: 7,
    },
  },
];

export function findMapCatalogEntry(id: string): MapCatalogEntry | undefined {
  return MAP_CATALOG.find((entry) => entry.id === id);
}
