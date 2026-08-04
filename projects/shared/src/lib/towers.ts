import type { TowerType } from './types';

/**
 * Catalogue des tours MVP (CONCEPTION.md §4).
 * Valeurs indicatives ; l'équilibrage fin est hors scope de ce prototype.
 */
export const TOWER_TYPES: readonly TowerType[] = [
  {
    id: 'archer',
    name: 'Archer',
    description: 'Tour polyvalente à cadence de tir élevée et bonne portée.',
    cost: 20,
    range: 3,
    damage: 8,
    cooldown: 5,
  },
  {
    id: 'canon',
    name: 'Canon',
    description: 'Tir lourd à dégâts de zone, redoutable contre les groupes de monstres.',
    cost: 35,
    range: 2,
    damage: 15,
    cooldown: 15,
    splashRadius: 1.5,
  },
  {
    id: 'glace',
    name: 'Glace',
    description: 'Dégâts modestes mais ralentit durablement sa cible pour retarder les vagues.',
    cost: 25,
    range: 2,
    damage: 3,
    cooldown: 10,
    slowFactor: 0.4,
    slowDuration: 30,
  },
  {
    id: 'catapulte',
    name: 'Catapulte',
    description: 'Inflige des dégâts bonus aux monstres blindés.',
    cost: 30,
    range: 3,
    damage: 10,
    cooldown: 8,
    armorBonus: 2,
  },
];

export function findTowerType(typeId: string): TowerType | undefined {
  return TOWER_TYPES.find((type) => type.id === typeId);
}
