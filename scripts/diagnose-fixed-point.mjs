#!/usr/bin/env node
/**
 * Étage A du plan de ré-équilibrage (voir le plan approuvé) : catalogue COMPLET, économie native
 * de la carte, seul `startingDefenseBudget` est multiplié pour éliminer toute excuse budgétaire.
 * But : confirmer qu'il EXISTE, en principe, une pose de tours qui tient une vague type du palier 1
 * sans encaisser le moindre dégât — avant toute recherche de prix. `--max-paliers 1` par défaut :
 * on ne s'intéresse qu'au premier cycle attaque→défense, pas à une partie complète.
 *
 * Log palier par palier pour voir OÙ et COMMENT la défense échoue quand elle échoue — budget
 * jamais suffisant (ne devrait plus arriver avec le multiplicateur) ou budget dépensé mais dégâts
 * insuffisants / mal ciblés (problème mécanique de couverture, pas de prix).
 *
 *   node --import ./scripts/register-workspace.mjs ./scripts/diagnose-fixed-point.mjs --games 20
 *   node --import ./scripts/register-workspace.mjs ./scripts/diagnose-fixed-point.mjs --games 20 --defense-budget-multiplier 15 --think-ms 3000
 */

import { DEFAULT_BALANCE_OPTIONS, playBalanceRun } from 'engine';
import { findMapCatalogEntry } from 'shared';

const MAP_ID = 'clairiere-02';

function applyDefenseBudgetMultiplier(multiplier) {
  const entry = findMapCatalogEntry(MAP_ID);
  entry.startingData.startingDefenseBudget = Math.round(entry.startingData.startingDefenseBudget * multiplier);
  entry.startingData.budgetGrowth.defense = Math.round(entry.startingData.budgetGrowth.defense * multiplier);
  return entry.startingData;
}

function fmtByType(byType) {
  if (!byType) return '';
  const entries = typeof byType.entries === 'function' ? [...byType.entries()] : Object.entries(byType);
  return entries.map(([id, n]) => `${id}×${n}`).join(',');
}

function printRun(run, gameIndex) {
  console.log(`\n${'='.repeat(78)}`);
  console.log(`Partie ${gameIndex + 1} — vainqueur : ${run.winner.toUpperCase()} · palier atteint : ${run.palierAtEnd}`);
  console.log('='.repeat(78));

  const byPalier = new Map();
  for (const a of run.attacks) {
    byPalier.set(a.palier, { attack: a });
  }
  for (const d of run.defenses) {
    const entry = byPalier.get(d.palier - 1) ?? {};
    entry.defense = d;
    byPalier.set(d.palier - 1, entry);
  }

  for (const palier of [...byPalier.keys()].sort((x, y) => x - y)) {
    const { attack, defense } = byPalier.get(palier);
    if (attack) {
      const pct = attack.budget > 0 ? Math.round((100 * attack.spent) / attack.budget) : 0;
      console.log(
        `  [P${palier}] ATTAQUE  budget ${attack.budget} · dépensé ${attack.spent} (${pct}%) · ` +
          `${attack.lanes} voie(s), ${attack.units} unité(s) [${fmtByType(attack.unitsByType)}] · ` +
          `→ ${attack.outcome === 'success' ? 'PERCE' : attack.outcome === 'failure' ? 'repoussée' : 'non-convergent'}` +
          (attack.outcome !== 'success' ? ` (château ${attack.chateauHpLeft} PV restants, ${attack.breaches} brèche(s))` : ''),
      );
    }
    if (defense) {
      const pct = defense.budget > 0 ? Math.round((100 * defense.spent) / defense.budget) : 0;
      console.log(
        `  [P${palier}] DÉFENSE  budget ${defense.budget} · dépensé ${defense.spent} (${pct}%) · ` +
          `${defense.towers} tour(s) [${fmtByType(defense.towersByType)}] · overkill ${defense.overkill.toFixed(2)} · ` +
          `routage att. ${defense.attackerRoutingCost ?? '?'} · ` +
          `→ ${defense.outcome === 'success' ? 'TIENT' : defense.outcome === 'failure' ? 'PERCÉE' : 'non-convergent'}` +
          (defense.outcome !== 'success' ? ` (château ${defense.chateauHpLeft} PV restants)` : ''),
      );
    }
  }
}

function parseArgs(argv) {
  const args = {
    games: 20,
    thinkMs: DEFAULT_BALANCE_OPTIONS.thinkMs,
    maxPaliers: 1,
    defenseBudgetMultiplier: 15,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const take = () => argv[++i];
    if (flag === '--games') args.games = Number(take());
    else if (flag === '--think-ms') args.thinkMs = Number(take());
    else if (flag === '--max-paliers') args.maxPaliers = Number(take());
    else if (flag === '--defense-budget-multiplier') args.defenseBudgetMultiplier = Number(take());
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startingData = applyDefenseBudgetMultiplier(args.defenseBudgetMultiplier);

  console.error(
    `Étage A · carte "${MAP_ID}" · catalogue complet (natif) · ` +
      `déf=${startingData.startingDefenseBudget}(+${startingData.budgetGrowth.defense}) [×${args.defenseBudgetMultiplier}] · ` +
      `att=${startingData.startingAttackBudget}(+${startingData.budgetGrowth.attack}) natif · ` +
      `chateauHp=${startingData.chateauHp} natif · think ${args.thinkMs}ms · maxPaliers ${args.maxPaliers} · ${args.games} partie(s)`,
  );

  const options = { ...DEFAULT_BALANCE_OPTIONS, thinkMs: args.thinkMs, maxPaliers: args.maxPaliers };
  let held = 0;
  let firstDefensePhases = 0;
  for (let i = 0; i < args.games; i++) {
    const cache = new Map();
    const run = await playBalanceRun(MAP_ID, options, cache);
    printRun(run, i);
    const firstDefense = run.defenses.find((d) => d.palier === 2);
    if (firstDefense) {
      firstDefensePhases++;
      if (firstDefense.outcome === 'success') {
        held++;
      }
    }
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(
    `RÉSUMÉ ÉTAGE A : tenue palier 1 = ${held}/${firstDefensePhases} ` +
      `(${firstDefensePhases > 0 ? Math.round((100 * held) / firstDefensePhases) : 0}%) · ` +
      `budget défense ×${args.defenseBudgetMultiplier} · critère de passage : > 90%`,
  );
  console.log('='.repeat(78));
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
