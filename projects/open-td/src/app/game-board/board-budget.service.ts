import { Injectable, signal } from '@angular/core';

export interface BudgetSnapshot {
  remaining: number;
  total: number;
}

const EMPTY_BUDGET: BudgetSnapshot = { remaining: 0, total: 0 };

/** Stockage du budget de défense et d'attaque affiché au-dessus du plateau. */
@Injectable()
export class BoardBudgetService {
  private readonly defenseState = signal<BudgetSnapshot>(EMPTY_BUDGET);
  private readonly attackState = signal<BudgetSnapshot>(EMPTY_BUDGET);

  readonly defense = this.defenseState.asReadonly();
  readonly attack = this.attackState.asReadonly();

  setDefenseBudget(remaining: number, total: number): void {
    this.defenseState.set({ remaining, total });
  }

  setAttackBudget(remaining: number, total: number): void {
    this.attackState.set({ remaining, total });
  }
}
