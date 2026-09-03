/** Phase active de la run. */
export type GamePhase = 'defense' | 'attack' | 'resolution';

export type CellKind = 'empty' | 'path' | 'obstacle' | 'chateau';

export interface GridCoord {
  x: number;
  y: number;
}

export interface TowerInstance {
  id: string;
  typeId: string;
  position: GridCoord;
  level: number;
  /** Palier auquel la tour a été posée. */
  placedAtPalier: number;
}

/** Type de tour disponible à la construction (voir CONCEPTION.md §4). */
export interface TowerType {
  id: string;
  name: string;
  /** Texte descriptif affiché dans les infobulles. */
  description: string;
  /** Coût de construction (niveau 1). */
  cost: number;
  /** Portée en cases de grille. */
  range: number;
  /** Dégâts infligés par tir. */
  damage: number;
  /** Ticks entre deux tirs. */
  cooldown: number;
  /** Rayon de zone (cases) : dégâts aussi infligés aux monstres proches de la cible. */
  splashRadius?: number;
  /** Multiplicateur de vitesse appliqué à la cible touchée (ex. 0.4 = 60% plus lent). */
  slowFactor?: number;
  /** Durée du ralentissement, en ticks. */
  slowDuration?: number;
  /** Multiplicateur de dégâts contre les monstres blindés. */
  armorBonus?: number;
}

/** Type de monstre disponible en composition de vague (voir CONCEPTION.md §5.1). */
export interface MonsterType {
  id: string;
  name: string;
  /** Texte descriptif affiché dans les infobulles. */
  description: string;
  /** Coût en budget d'attaque. */
  cost: number;
  hp: number;
  /** Vitesse de déplacement, en cases de grille par tick. */
  speed: number;
  /** Blindé : cible privilégiée des tours anti-blindé (bonus de dégâts). */
  armored: boolean;
  /** Dégâts infligés au château si le monstre atteint la fin du chemin. */
  chateauDamage: number;
  /** PV régénérés à chaque tick (jusqu'à `hp`) : impose du burst plutôt que du dégât étalé. */
  regenPerTick?: number;
  /** Résistance au ralentissement (0 = aucune, 1 = immunité totale) : atténue le `slowFactor` subi. */
  slowResistance?: number;
  /** Scission à la mort : le monstre tué est remplacé par `count` instances du type `typeId`, à sa position. */
  splitOnDeath?: { typeId: string; count: number };
  /** Non composable directement dans une voie (ex. progéniture d'une scission) : absent du sélecteur de vague. */
  internal?: boolean;
}

/** Raison de rejet d'un placement (ou déplacement) de tour. */
export type PlacementFailureReason =
  | 'map-not-loaded'
  | 'out-of-bounds'
  | 'chateau-cell'
  | 'border-cell'
  | 'path-cell'
  | 'river-cell'
  | 'occupied'
  | 'insufficient-budget'
  | 'unknown-tower-type'
  | 'tower-not-found'
  | 'wrong-phase';

export type PlacementResult =
  | { ok: true }
  | { ok: false; reason: PlacementFailureReason };

export interface WaveUnit {
  type: string;
}

/** Point de spawn nommé sur la carte. */
export interface MapSpawn extends GridCoord {
  id: string;
}

/**
 * Itinéraire spawn → château (nœuds en coordonnées de grille), soit l'un des chemins
 * prédéfinis de la carte, soit un tracé libre dessiné par l'attaquant (CONCEPTION.md §5.3).
 */
export interface MapPath {
  id: string;
  /** Nom lisible donné par le joueur (tracés libres uniquement) ; sinon l'id sert d'étiquette. */
  name?: string;
  nodes: Array<[number, number]>;
}

/** Une voie de la vague : un chemin (prédéfini ou tracé) et les monstres qui l'empruntent, dans l'ordre. */
export interface WaveLane {
  path: MapPath;
  units: WaveUnit[];
}

/** Vague d'attaque : une ou plusieurs voies actives simultanément (CONCEPTION.md §5.3). */
export interface Wave {
  lanes: WaveLane[];
}

/** Descripteur de grille hexagonale (pointy-top, offset odd-r). */
export interface HexGrid {
  cols: number;
  rows: number;
  cell: 'hex';
  orientation: 'pointy';
  offset: 'odd-r';
}

/** Schéma JSON d'une carte (voir CONCEPTION.md §8). */
export interface GameMap {
  id: string;
  grid: HexGrid;
  chateau: GridCoord;
  spawns: MapSpawn[];
  paths: MapPath[];
  /** Rivière(s) : jamais constructible, tracé fermé aux chemins (CONCEPTION.md §4). */
  rivers?: MapPath[];
}

/**
 * Relance réciproque des budgets (CONCEPTION.md §8) : chaque nouveau budget dépasse le dernier
 * budget du camp adverse d'une marge qui grandit de `marginStep` à chaque relance (attaque OU
 * défense, pas par palier complet) — ex. `initialMargin=5, marginStep=5` donne 10, 15, 25, 40, 65...
 * en partant d'un budget d'attaque de départ de 10. Remplace un taux de croissance constant par
 * camp : un écart constant s'accumule linéairement et finit toujours par devenir écrasant sur une
 * partie assez longue, alors que cette marge, bien que croissante en valeur absolue, devient
 * proportionnellement négligeable face aux budgets eux-mêmes (`margin_n / b_n → 0`).
 */
export interface BudgetGrowth {
  /** Marge de la toute première relance (palier 1 → défense). */
  initialMargin: number;
  /** Croissance de la marge à chaque relance ultérieure. */
  marginStep: number;
}

/** Données de départ d'une run : budgets initiaux (voir CONCEPTION.md §8). */
export interface StartingData {
  mapId: string;
  startingDefenseBudget: number;
  startingAttackBudget: number;
  budgetGrowth: BudgetGrowth;
  /** PV du château au début d'une épreuve de défense. */
  chateauHp: number;
}
