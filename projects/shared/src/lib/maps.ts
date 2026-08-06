import type { GameMap, HexGrid, StartingData } from './types';

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
 * Entrée du catalogue de cartes de départ (écran d'accueil, CONCEPTION.md §9 « Sélection carte ») :
 * géométrie du plateau et paramétrage de la run (budgets, PV du château).
 *
 * La géométrie vit ici, et non plus dans un `{id}.map.json` chargé au runtime, pour qu'il n'en
 * existe qu'un seul exemplaire. Les harnais d'équilibre tournent sous Vitest, sans accès au disque :
 * chacun gardait donc sa propre copie des cartes, et elles ont divergé — le harnais IA contre IA
 * mesurait une « clairiere-02 » sans rivière et à chemins pré-câblés, c'est-à-dire une carte qui
 * n'existe dans aucune partie. Un import commun rend cette dérive impossible.
 */
export interface MapCatalogEntry {
  id: string;
  name: string;
  description: string;
  difficulty: MapDifficulty;
  biome: MapBiome;
  /** Plateau de la carte : grille, château, spawns, chemins prédéfinis, rivières (CONCEPTION.md §8). */
  geometry: GameMap;
  startingData: StartingData;
}

/** Toutes les cartes partagent la même convention de grille hexagonale (CONCEPTION.md §8). */
const HEX_GRID = { cell: 'hex', orientation: 'pointy', offset: 'odd-r' } as const satisfies Omit<
  HexGrid,
  'cols' | 'rows'
>;

/**
 * Les 5 cartes de départ proposées à l'écran d'accueil, de dimensions et difficultés variées.
 *
 * Aucune ne fournit de spawn ni de chemin prédéfini : l'attaquant trace toutes ses routes lui-même
 * depuis une case de bord et paie leurs cases sur son budget (CONCEPTION.md §5.3). Le seul relief
 * est la rivière, jamais constructible et fermée aux tracés (CONCEPTION.md §4).
 */
export const MAP_CATALOG: readonly MapCatalogEntry[] = [
  {
    id: 'clairiere-02',
    name: 'Clairière',
    description: 'Petite carte resserrée, idéale pour découvrir le jeu.',
    difficulty: 'facile',
    biome: 'clairiere',
    geometry: {
      id: 'clairiere-02',
      grid: { cols: 16, rows: 12, ...HEX_GRID },
      chateau: { x: 8, y: 6 },
      spawns: [],
      paths: [],
      rivers: [{ id: 'riviere', nodes: [[6, 0], [8, 6], [15, 11]] }],
    },
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
    description: 'Carte plus large et un peu plus difficile',
    difficulty: 'modérée',
    biome: 'foret',
    geometry: {
      id: 'forest-01',
      grid: { cols: 32, rows: 24, ...HEX_GRID },
      chateau: { x: 16, y: 12 },
      spawns: [],
      paths: [],
      rivers: [{ id: 'riviere', nodes: [[6, 0], [8, 9], [16, 12], [23, 9], [30, 0]] }],
    },
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
    description: 'Carte large et basse, avec une rivière sinueuse qui coupe le plateau en deux.',
    difficulty: 'modérée',
    biome: 'marais',
    geometry: {
      id: 'marais-03',
      grid: { cols: 24, rows: 18, ...HEX_GRID },
      chateau: { x: 12, y: 9 },
      spawns: [],
      paths: [],
      rivers: [{ id: 'riviere', nodes: [[12, 0], [10, 6], [12, 9], [6, 17]] }],
    },
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
    description: 'Carte large et basse, avec une rivière sinueuse qui coupe le plateau en deux.',
    difficulty: 'difficile',
    biome: 'toundra',
    geometry: {
      id: 'toundra-05',
      grid: { cols: 48, rows: 16, ...HEX_GRID },
      chateau: { x: 24, y: 8 },
      spawns: [],
      paths: [],
      rivers: [{ id: 'riviere', nodes: [[24, 0], [24, 14]] }],
    },
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
    description: 'Grande carte',
    difficulty: 'difficile',
    biome: 'montagne',
    geometry: {
      id: 'montagne-04',
      grid: { cols: 40, rows: 30, ...HEX_GRID },
      chateau: { x: 20, y: 15 },
      spawns: [],
      paths: [],
      rivers: [
        { id: 'riviere', nodes: [[0, 0], [6, 8], [5, 10], [20, 15], [23, 14], [28, 20], [20, 29]] },
      ],
    },
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
