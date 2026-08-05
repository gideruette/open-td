import { findMonsterType } from 'shared';
import type { MonsterType, TowerType, Wave } from 'shared';
import type { TooltipStat } from '../ui/tooltip/tooltip';
import type { LaneDraft } from './board-types';

/** Caractéristiques d'un type de tour, formatées pour l'infobulle. */
export function formatTowerStats(type: TowerType): TooltipStat[] {
  const stats: TooltipStat[] = [
    { label: 'Coût', value: `${type.cost}` },
    { label: 'Portée', value: `${type.range} cases` },
    { label: 'Dégâts', value: `${type.damage}` },
    { label: 'Cadence', value: `${type.cooldown} ticks` },
  ];
  if (type.splashRadius) {
    stats.push({ label: 'Zone', value: `${type.splashRadius} cases` });
  }
  if (type.slowFactor) {
    stats.push({
      label: 'Ralentissement',
      value: `-${Math.round((1 - type.slowFactor) * 100)}% pendant ${type.slowDuration} ticks`,
    });
  }
  if (type.armorBonus) {
    stats.push({ label: 'Bonus anti-blindé', value: `×${type.armorBonus}` });
  }
  return stats;
}

/** Caractéristiques d'un type de monstre, formatées pour l'infobulle. */
export function formatMonsterStats(type: MonsterType): TooltipStat[] {
  return [
    { label: 'PV', value: `${type.hp}` },
    { label: 'Vitesse', value: `${type.speed} case/tick` },
    { label: 'Blindage', value: type.armored ? 'Blindé' : 'Non blindé' },
    { label: 'Dégâts au château', value: `${type.chateauDamage}` },
  ];
}

export function monsterDisplayName(typeId: string): string {
  return findMonsterType(typeId)?.name ?? typeId;
}

export function monsterDescription(typeId: string): string {
  return findMonsterType(typeId)?.description ?? '';
}

export function laneDisplayLabel(lane: LaneDraft, index: number): string {
  return lane.path.name?.trim() || `Voie ${index + 1}`;
}
