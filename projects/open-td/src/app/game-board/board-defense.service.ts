import { Injectable, computed, inject, signal } from '@angular/core';
import { canOccupyCell, canPlaceTower } from 'engine';
import { TOWER_TYPES, findTowerType } from 'shared';
import type { GridCoord } from 'shared';
import { BoardEngineService } from './board-engine.service';
import { BoardLanesService } from './board-lanes.service';
import { BoardMessageService } from './board-message.service';
import { BoardTrialService } from './board-trial.service';

const FAILURE_MESSAGES: Record<string, string> = {
  'map-not-loaded': 'Carte non chargée.',
  'unknown-tower-type': 'Type de tour inconnu.',
  'out-of-bounds': 'Case hors grille.',
  'chateau-cell': 'Impossible de construire sur le château.',
  'border-cell': 'Impossible de construire sur un bord de la grille.',
  'path-cell': 'Impossible de construire sur un chemin.',
  occupied: 'Case déjà occupée par une tour.',
  'insufficient-budget': 'Budget insuffisant.',
  'wrong-phase': 'Impossible pendant cette phase.',
  'tower-not-found': 'Tour introuvable.',
};

/**
 * Phase Défense : case choisie dans la barre du bas (vide ou occupée), type de tour prévisualisé,
 * et actions de pose/suppression. Segment "placement de tours" — injecté directement dans `BoardHud`
 * plutôt que relayé en props par `GameBoard`.
 */
@Injectable()
export class BoardDefenseService {
  private readonly gameState = inject(BoardEngineService);
  private readonly messages = inject(BoardMessageService);
  private readonly trial = inject(BoardTrialService);

  /** Case choisie (vide ou occupée) : la barre du bas propose d'y construire ou d'en supprimer la tour. */
  private readonly pickingCellState = signal<GridCoord | undefined>(undefined);
  /** Type de tour prévisualisé sur la case choisie. */
  private readonly selectedTypeIdState = signal<string | undefined>(undefined);

  readonly pickingCell = this.pickingCellState.asReadonly();
  readonly selectedTypeId = this.selectedTypeIdState.asReadonly();

  /** Tour posée sur la case choisie, s'il y en a une (sinon la case est libre). */
  readonly pickingTower = computed(() => {
    const cell = this.pickingCellState();
    if (!cell) {
      return undefined;
    }
    return this.gameState
      .towers()
      .find((tower) => tower.position.x === cell.x && tower.position.y === cell.y);
  });

  /** Vrai tant qu'une case (vide ou occupée) est choisie dans la barre du bas. */
  readonly isPicking = computed(() => this.pickingCellState() !== undefined);

  /**
   * Sélectionne une case tapée sur la grille (phase Défense) : reprend la tour existante si la case
   * en porte une, sinon la propose à la construction si elle est constructible.
   */
  pickCell(coord: GridCoord): void {
    const existing = this.pickingTowerAt(coord);
    if (existing) {
      this.pickingCellState.set(coord);
      this.selectedTypeIdState.set(existing.typeId);
      this.messages.set(undefined);
      return;
    }

    const occupancy = canOccupyCell(this.gameState.map(), this.gameState.towers(), coord);
    if (!occupancy.ok) {
      this.messages.set(FAILURE_MESSAGES[occupancy.reason] ?? 'Impossible de construire ici.');
      return;
    }
    this.pickingCellState.set(coord);
    this.selectedTypeIdState.set(TOWER_TYPES[0]?.id);
    this.messages.set(undefined);
  }

  private pickingTowerAt(coord: GridCoord) {
    return this.gameState
      .towers()
      .find((tower) => tower.position.x === coord.x && tower.position.y === coord.y);
  }

  /** Abandonne la case choisie (tap en dehors de la grille, réinitialisation…). */
  clearSelection(): void {
    this.pickingCellState.set(undefined);
    this.selectedTypeIdState.set(undefined);
  }

  /** Choisit le type de tour prévisualisé sur la case choisie (toujours un type sélectionné tant qu'une case l'est). */
  choosePreviewType(typeId: string): void {
    if (this.trial.isRunning() || !this.pickingCellState() || this.pickingTower()) {
      return;
    }
    this.selectedTypeIdState.set(typeId);
  }

  /** Construit la tour prévisualisée sur la case choisie. */
  confirmPlaceTower(): void {
    const coord = this.pickingCellState();
    const typeId = this.selectedTypeIdState();
    if (!coord || !typeId || this.trial.isRunning()) {
      return;
    }
    const result = this.gameState.engine.placeTower(typeId, coord);
    if (!result.ok) {
      this.messages.set(FAILURE_MESSAGES[result.reason] ?? 'Placement impossible.');
      return;
    }
    this.messages.set(undefined);
    this.gameState.refresh();
    this.clearSelection();
  }

  /** Supprime la tour posée sur la case choisie. */
  deleteSelected(): void {
    const towerId = this.pickingTower()?.id;
    if (!towerId || this.trial.isRunning()) {
      return;
    }
    const recovered = this.gameState.engine.deleteTower(towerId);
    if (recovered === undefined) {
      return;
    }
    this.clearSelection();
    this.messages.set(`Tour supprimée (+${recovered}).`);
    this.gameState.refresh();
  }

  /** Abandonne les poses/suppressions de la phase Défense en cours et revient à la forteresse de départ. */
  resetSession(): void {
    if (this.gameState.phase() !== 'defense' || this.trial.isRunning() || this.isPicking()) {
      return;
    }
    this.gameState.engine.resetDefenseSession();
    this.clearSelection();
    this.messages.set(undefined);
    this.gameState.refresh();
  }

  /** Vrai si le type de tour courant peut être posé sur `coord` (grille, occupation, budget). */
  canPlaceSelectedTypeAt(coord: GridCoord, budgetRemaining: number): boolean {
    const typeId = this.selectedTypeIdState();
    if (!typeId) {
      return false;
    }
    const type = findTowerType(typeId);
    return canPlaceTower(this.gameState.map(), this.gameState.towers(), type, coord, budgetRemaining).ok;
  }
}
