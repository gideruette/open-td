import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  afterNextRender,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Tooltip, type TooltipStat } from '../tooltip/tooltip';

/** Bouton catalogue (sprite + nom + info) : partagé par la liste des tours et celle des monstres. */
@Component({
  selector: 'otd-item-button',
  imports: [Tooltip],
  templateUrl: './item-button.html',
  styleUrl: './item-button.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ItemButton {
  readonly spriteSrc = input.required<string>();
  readonly label = input.required<string>();
  readonly meta = input.required<string>();
  readonly description = input('');
  readonly stats = input<readonly TooltipStat[]>([]);
  readonly selected = input(false);
  readonly disabled = input(false);

  readonly clicked = output<MouseEvent>();

  private readonly destroyRef = inject(DestroyRef);
  private readonly tooltipHostRef = viewChild<ElementRef<HTMLElement>>('tooltipHost');
  /** Position (coordonnées viewport) de l'infobulle survolée ; `undefined` = masquée. */
  protected readonly tooltipPos = signal<{ left: number; top: number } | undefined>(undefined);

  constructor() {
    // Rattachée à <body> pour échapper à l'overflow-x des rangées défilantes (voir CONCEPTION du curseur de file).
    afterNextRender(() => {
      const node = this.tooltipHostRef()?.nativeElement;
      if (!node) {
        return;
      }
      document.body.appendChild(node);
      this.destroyRef.onDestroy(() => node.remove());
    });
  }

  protected showTooltip(event: Event): void {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.tooltipPos.set({ left: rect.left + rect.width / 2, top: rect.bottom + 6 });
  }

  protected hideTooltip(): void {
    this.tooltipPos.set(undefined);
  }
}
