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

export function laneDisplayLabel(lane: LaneDraft, index: number): string {
  return lane.path.name?.trim() || `Voie ${index + 1}`;
}

export function describeWave(wave: Wave | undefined): string {
  if (!wave || wave.lanes.every((lane) => lane.units.length === 0)) {
    return '—';
  }
  return wave.lanes
    .map((lane, index) => {
      const counts = new Map<string, number>();
      for (const unit of lane.units) {
        counts.set(unit.type, (counts.get(unit.type) ?? 0) + 1);
      }
      const parts = Array.from(counts.entries()).map(
        ([type, count]) => `${findMonsterType(type)?.name ?? type} ×${count}`,
      );
      return `Chemin ${index + 1} (${lane.path.id}) : ${parts.join(', ') || 'vide'}`;
    })
    .join(' | ');
}
