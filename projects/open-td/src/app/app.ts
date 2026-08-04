import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { GameBoard } from './game-board/game-board';
import { MapSelect } from './map-select/map-select';

@Component({
  selector: 'otd-root',
  imports: [RouterOutlet, GameBoard, MapSelect],
  templateUrl: './app.html',
  styleUrl: './app.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  protected readonly title = signal('Open TD');
  protected readonly selectedMapId = signal<string | undefined>(undefined);

  protected onMapChosen(mapId: string): void {
    this.selectedMapId.set(mapId);
  }

  protected backToMenu(): void {
    this.selectedMapId.set(undefined);
  }
}
