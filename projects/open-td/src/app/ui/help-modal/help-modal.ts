import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import { MONSTER_TYPES, TOWER_TYPES } from 'shared';
import type { MonsterType, TowerType } from 'shared';
import { formatMonsterStats, formatTowerStats } from '../../game-board/board-format';
import type { TooltipStat } from '../tooltip/tooltip';

type HelpTabId = 'regles' | 'defense' | 'attaque' | 'tours' | 'monstres';

interface HelpTab {
  id: HelpTabId;
  label: string;
  icon: string;
  color: string;
}

interface CatalogueBadge {
  label: string;
  color: string;
}

interface CatalogueEntry<T> {
  type: T;
  badge: CatalogueBadge;
  stats: readonly TooltipStat[];
}

const TABS: readonly HelpTab[] = [
  { id: 'regles', label: 'Règles', icon: 'assets/sprites/chateau.svg', color: '#e8e6e1' },
  { id: 'defense', label: 'Défense', icon: 'assets/sprites/shield-defense.svg', color: '#5fb0ff' },
  { id: 'attaque', label: 'Attaque', icon: 'assets/sprites/swords-attack.svg', color: '#ffe08c' },
  { id: 'tours', label: 'Tours', icon: 'assets/sprites/archer.svg', color: '#5fb0ff' },
  { id: 'monstres', label: 'Monstres', icon: 'assets/sprites/goblin.svg', color: '#ffe08c' },
];

/** Badge coloré résumant la spécialité d'une tour — dérivé de ses stats, `TowerType` n'ayant pas de champ dédié. */
function towerBadge(type: TowerType): CatalogueBadge {
  if (type.splashRadius) {
    return { label: 'Zone', color: '#ff9f5a' };
  }
  if (type.slowFactor) {
    return { label: 'Contrôle', color: '#7be0ff' };
  }
  if (type.armorBonus) {
    return { label: 'Anti-blindé', color: '#c58bff' };
  }
  return { label: 'Polyvalente', color: '#5fb0ff' };
}

/** Badge coloré résumant la spécialité d'un monstre — dérivé de ses stats, `MonsterType` n'ayant pas de champ dédié. */
function monsterBadge(type: MonsterType): CatalogueBadge {
  if (type.armored) {
    return { label: 'Blindé', color: '#b8c4d0' };
  }
  if (type.regenPerTick) {
    return { label: 'Régénération', color: '#7be07a' };
  }
  if (type.splitOnDeath) {
    return { label: 'Scission', color: '#ff8fd6' };
  }
  if (type.slowResistance) {
    return { label: 'Résiste au froid', color: '#7be0ff' };
  }
  return { label: 'Standard', color: '#ffe08c' };
}

/**
 * Fenêtre modale d'aide : onglets Règles / Défense / Attaque + catalogues Tours et Monstres
 * (icônes de sprites + badge coloré par spécialité), ouverte depuis le bouton d'aide.
 */
@Component({
  selector: 'otd-help-modal',
  imports: [],
  templateUrl: './help-modal.html',
  styleUrl: './help-modal.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HelpModal {
  readonly open = input(false);

  readonly closed = output<void>();

  protected readonly tabs = TABS;
  protected readonly activeTab = signal<HelpTabId>('regles');

  protected readonly towerEntries: readonly CatalogueEntry<TowerType>[] = TOWER_TYPES.map((type) => ({
    type,
    badge: towerBadge(type),
    stats: formatTowerStats(type),
  }));

  protected readonly monsterEntries: readonly CatalogueEntry<MonsterType>[] = MONSTER_TYPES.map((type) => ({
    type,
    badge: monsterBadge(type),
    stats: formatMonsterStats(type),
  }));

  protected selectTab(id: HelpTabId): void {
    this.activeTab.set(id);
  }

  protected close(): void {
    this.activeTab.set('regles');
    this.closed.emit();
  }
}
