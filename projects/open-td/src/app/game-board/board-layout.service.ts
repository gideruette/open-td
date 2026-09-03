import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

export type LayoutEdge = 'top' | 'right' | 'bottom' | 'left';

const EMPTY_INSETS: Record<LayoutEdge, number> = { top: 0, right: 0, bottom: 0, left: 0 };

function watchMedia(query: string, onChange: (matches: boolean) => void): (() => void) | undefined {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return undefined;
  }
  const mql = window.matchMedia(query);
  const listener = (event: MediaQueryListEvent) => onChange(event.matches);
  mql.addEventListener('change', listener);
  onChange(mql.matches);
  return () => mql.removeEventListener('change', listener);
}

/**
 * État de layout partagé du plateau : orientation/hauteur courtes (paysage téléphone), et
 * empiètement agrégé des panneaux flottants sur les bords du viewport. `game-board.ts` lit
 * `insets()` pour que le fit/pan de la carte évite les panneaux au lieu de centrer la carte
 * dessous (CONCEPTION mobile : la carte doit rester pleinement jouable sous le HUD).
 */
@Injectable()
export class BoardLayoutService {
  private readonly isLandscapeState = signal(false);
  private readonly isShortState = signal(false);

  readonly isLandscape = this.isLandscapeState.asReadonly();
  readonly isShort = this.isShortState.asReadonly();
  /**
   * Vrai quand le HUD doit se docker en rail latéral plutôt qu'en feuille inférieure. Basé sur la
   * hauteur (`isShort`), pas la largeur : un téléphone en paysage dépasse souvent 820px de large
   * (ex. 844×390) tout en restant bas — c'est la hauteur qui est rare dans cette orientation.
   */
  readonly isRailLayout = computed(() => this.isLandscape() && this.isShort());

  private readonly contributions = new Map<string, Partial<Record<LayoutEdge, number>>>();
  private readonly insetState = signal<Record<LayoutEdge, number>>(EMPTY_INSETS);
  readonly insets = this.insetState.asReadonly();

  constructor() {
    const destroyRef = inject(DestroyRef);
    const unsubs = [
      watchMedia('(orientation: landscape)', (matches) => this.isLandscapeState.set(matches)),
      watchMedia('(max-height: 520px)', (matches) => this.isShortState.set(matches)),
    ];
    destroyRef.onDestroy(() => unsubs.forEach((unsub) => unsub?.()));
  }

  /** Enregistre l'empiètement (px) d'un panneau flottant sur un ou plusieurs bords du viewport. */
  setInset(key: string, edges: Partial<Record<LayoutEdge, number>>): void {
    this.contributions.set(key, edges);
    this.recomputeInsets();
  }

  clearInset(key: string): void {
    if (this.contributions.delete(key)) {
      this.recomputeInsets();
    }
  }

  private recomputeInsets(): void {
    const next: Record<LayoutEdge, number> = { ...EMPTY_INSETS };
    for (const edges of this.contributions.values()) {
      (['top', 'right', 'bottom', 'left'] as const).forEach((edge) => {
        next[edge] = Math.max(next[edge], edges[edge] ?? 0);
      });
    }
    this.insetState.set(next);
  }
}
