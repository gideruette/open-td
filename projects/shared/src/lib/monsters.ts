import type { MonsterType } from './types';

/**
 * Catalogue des monstres MVP (CONCEPTION.md §5.1). Volant exclu (post-MVP).
 * Valeurs indicatives ; l'équilibrage fin est hors scope de ce prototype.
 */
export const MONSTER_TYPES: readonly MonsterType[] = [
  {
    id: 'goblin',
    name: 'Gobelin',
    description: 'Rapide et fragile, peu coûteux à envoyer en nombre.',
    cost: 5,
    hp: 20,
    speed: 0.25,
    armored: false,
    chateauDamage: 1,
  },
  {
    id: 'orc',
    name: 'Orc',
    description: 'Robuste et lent, inflige de lourds dégâts s’il atteint le château.',
    cost: 12,
    hp: 50,
    speed: 0.18,
    armored: false,
    chateauDamage: 2,
  },
  {
    id: 'golem',
    name: 'Golem',
    description: 'Très lent mais blindé et increvable, à envoyer en dernier recours.',
    cost: 30,
    hp: 120,
    speed: 0.12,
    armored: true,
    chateauDamage: 4,
  },
];

export function findMonsterType(typeId: string): MonsterType | undefined {
  return MONSTER_TYPES.find((type) => type.id === typeId);
}

/** Part du coût récupérée en retirant un monstre déjà mis en file d'une voie (CONCEPTION.md §5.2). */
const UNIT_REMOVAL_REFUND_RATIO = 0.5;

/**
 * Retirer un monstre déjà mis en file d'une voie ne rend qu'une fraction de son coût :
 * modifier une composition d'attaque une fois une voie établie n'est pas gratuit
 * (CONCEPTION.md §5.2).
 */
export function unitRemovalRefund(cost: number): number {
  return Math.floor(cost * UNIT_REMOVAL_REFUND_RATIO);
}
