import type { MonsterType } from './types';

/**
 * Catalogue des monstres MVP (CONCEPTION.md §5.1). Volant exclu (post-MVP).
 * Valeurs indicatives ; l'équilibrage fin est hors scope de ce prototype.
 */
export const MONSTER_TYPES: readonly MonsterType[] = [
  {
    id: 'rat',
    name: 'Rat des égouts',
    description:
      'Chair à canon ultra bon marché, à envoyer en nombre pour saturer les tours à faible cadence.',
    cost: 3,
    hp: 10,
    speed: 0.5,
    armored: false,
    chateauDamage: 1,
  },
  {
    id: 'gelee_mini',
    name: 'Gelée miniature',
    description: 'Fragment issu de la scission d’une Gelée.',
    cost: 4,
    hp: 12,
    speed: 0.26,
    armored: false,
    chateauDamage: 1,
    internal: true,
  },
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
    id: 'loup',
    name: 'Loup',
    description: 'Rapide en meute, met à l’épreuve les tours à faible portée.',
    cost: 8,
    hp: 28,
    speed: 0.3,
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
    id: 'gelee',
    name: 'Gelée',
    description:
      'Se scinde en deux Gelées miniatures à sa mort : la tuer ne suffit pas à s’en débarrasser.',
    cost: 14,
    hp: 36,
    speed: 0.22,
    armored: false,
    chateauDamage: 2,
    splitOnDeath: { typeId: 'gelee_mini', count: 2 },
  },
  {
    id: 'saboteur',
    name: 'Saboteur',
    description:
      'Fragile mais dévastateur s’il atteint le château : punit sévèrement la moindre brèche.',
    cost: 15,
    hp: 15,
    speed: 0.28,
    armored: false,
    chateauDamage: 6,
  },
  {
    id: 'brute',
    name: 'Brute',
    description: 'Palier intermédiaire entre l’Orc et le Golem, mais sans blindage.',
    cost: 18,
    hp: 70,
    speed: 0.2,
    armored: false,
    chateauDamage: 3,
  },
  {
    id: 'necrophage',
    name: 'Nécrophage',
    description:
      'Régénère ses PV en continu : sans burst pour l’achever vite, il se soigne plus qu’on ne l’entame.',
    cost: 20,
    hp: 40,
    speed: 0.2,
    armored: false,
    chateauDamage: 2,
    regenPerTick: 1,
  },
  {
    id: 'troll_glace',
    name: 'Troll des glaces',
    description:
      'Très résistant au ralentissement : contre directement une défense qui compte sur la tour Glace.',
    cost: 26,
    hp: 65,
    speed: 0.19,
    armored: false,
    chateauDamage: 3,
    slowResistance: 0.8,
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
  {
    id: 'chevalier_noir',
    name: 'Chevalier noir',
    description: 'Blindé et pourtant loin d’être lent : casse l’association blindé = lent.',
    cost: 40,
    hp: 90,
    speed: 0.16,
    armored: true,
    chateauDamage: 3,
  },
];

export function findMonsterType(typeId: string): MonsterType | undefined {
  return MONSTER_TYPES.find((type) => type.id === typeId);
}
