import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { BoardLaunchService } from '../board-launch.service';

/** Bouton de lancement (vague de défense ou vague d'attaque), affiché dans le cartouche de phase. */
@Component({
  selector: 'otd-board-launch',
  templateUrl: './board-launch.html',
  styleUrl: './board-launch.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardLaunch {
  private readonly launch = inject(BoardLaunchService);

  protected readonly state = this.launch.value;

  protected onClick(): void {
    this.launch.requestLaunch();
  }
}
