import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, output } from '@angular/core';
import { DateTime } from 'luxon';
import { BIOME_COLORS, MAP_CATALOG, type MapCatalogEntry } from 'shared';
import { BUILD_DATE } from '../build-info';

/** Taille max (px) du plus grand côté de la vignette de dimensions d'une carte. */
const PREVIEW_MAX_SIDE = 96;

/** Écran d'accueil : choix de la carte de départ parmi le catalogue (CONCEPTION.md §9). */
@Component({
  selector: 'otd-map-select',
  imports: [DatePipe],
  templateUrl: './map-select.html',
  styleUrl: './map-select.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MapSelect {
  protected readonly maps = MAP_CATALOG;
  protected readonly buildDate = DateTime.fromISO(BUILD_DATE).toJSDate();

  readonly mapChosen = output<string>();

  protected choose(entry: MapCatalogEntry): void {
    this.mapChosen.emit(entry.id);
  }

  protected previewSize(entry: MapCatalogEntry): { width: string; height: string } {
    const scale = PREVIEW_MAX_SIDE / Math.max(entry.grid.cols, entry.grid.rows);
    return {
      width: `${Math.round(entry.grid.cols * scale)}px`,
      height: `${Math.round(entry.grid.rows * scale)}px`,
    };
  }

  protected previewColors(entry: MapCatalogEntry): { background: string; border: string } {
    const colors = BIOME_COLORS[entry.biome];
    return { background: colors.background, border: colors.path };
  }
}
