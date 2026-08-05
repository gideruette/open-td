import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import type { MatchSlots } from './game-board/board-types';
import { GameBoard } from './game-board/game-board';
import { MapSelect } from './map-select/map-select';
import { MatchSetup } from './match-setup/match-setup';
import { HelpModal } from './ui/help-modal/help-modal';

@Component({
  selector: 'otd-root',
  imports: [RouterOutlet, GameBoard, MapSelect, MatchSetup, HelpModal],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly title = signal('Open TD');
  protected readonly selectedSlots = signal<MatchSlots | undefined>(undefined);
  protected readonly selectedMapId = signal<string | undefined>(undefined);
  protected readonly helpOpen = signal(false);

  protected onSlotsChosen(slots: MatchSlots): void {
    this.selectedSlots.set(slots);
  }

  protected onMapChosen(mapId: string): void {
    this.selectedMapId.set(mapId);
  }

  protected backToMenu(): void {
    this.selectedMapId.set(undefined);
  }

  /** Retour complet à l'écran de configuration (nouvelle partie, changement de mode). */
  protected changeMode(): void {
    this.selectedMapId.set(undefined);
    this.selectedSlots.set(undefined);
  }

  protected openHelp(): void {
    this.helpOpen.set(true);
  }

  protected closeHelp(): void {
    this.helpOpen.set(false);
  }
}
