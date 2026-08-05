import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** Bouton catalogue (sprite + nom + info) : partagé par la liste des tours et celle des monstres. */
@Component({
  selector: 'otd-item-button',
  templateUrl: './item-button.html',
  styleUrl: './item-button.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemButton {
  readonly spriteSrc = input.required<string>();
  readonly label = input.required<string>();
  readonly meta = input.required<string>();
  readonly selected = input(false);
  readonly disabled = input(false);

  readonly clicked = output<MouseEvent>();
}
