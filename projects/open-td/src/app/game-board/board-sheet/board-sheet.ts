import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** Tiroir bas générique : chrome + zone de contenu projetée. */
@Component({
  selector: 'otd-board-sheet',
  templateUrl: './board-sheet.html',
  styleUrl: './board-sheet.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BoardSheet {
  readonly open = input(false);
  readonly sheetId = input.required<string>();
  readonly title = input.required<string>();
  readonly ariaLabel = input.required<string>();

  readonly closed = output<void>();
}
