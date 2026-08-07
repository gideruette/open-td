import { describe, expect, it } from 'vitest';
import {
  aiDrift,
  decisionProfile,
  hazardCurve,
  type AttackPhaseMetrics,
  type DefensePhaseMetrics,
  type PhaseOutcome,
  type RunMetrics,
} from './balance-harness';

/**
 * Indicateurs de forme de partie sur des parties SYNTHÉTIQUES : rapide et déterministe, contrairement
 * à `balance-metrics.spec.ts` qui joue de vraies parties. Vérifie surtout la convention de palier du
 * harnais, seule source d'erreur silencieuse : la phase Défense qui répond à l'attaque du palier `p`
 * porte `palier === p + 1`, si bien qu'une victoire de l'attaque au tour `p` se solde par
 * `palierAtEnd === p + 1`, alors qu'une victoire de la défense au tour `p` donne `palierAtEnd === p`.
 */

function attackPhase(palier: number, outcome: PhaseOutcome): AttackPhaseMetrics {
  return {
    palier,
    budget: 100 + 40 * (palier - 1),
    spent: 100 + 40 * (palier - 1),
    routeCost: 10,
    monsterCost: 90 + 40 * (palier - 1),
    lanes: 4,
    routeCells: 10,
    units: 10,
    unitsByType: new Map([['rat', 10]]),
    costByType: new Map([['rat', 30]]),
    outcome,
    breaches: outcome === 'success' ? 5 : 0,
    chateauHpLeft: outcome === 'success' ? 0 : 5,
    ticks: 100,
  };
}

function defensePhase(palier: number, outcome: PhaseOutcome): DefensePhaseMetrics {
  return {
    palier,
    budget: 140 + 60 * (palier - 1),
    spent: 140 + 60 * (palier - 1),
    towers: 7,
    towersByType: new Map([['archer', 7]]),
    costByType: new Map([['archer', 140]]),
    rejected: 0,
    outcome,
    chateauHpLeft: outcome === 'success' ? 5 : 0,
    overkill: 1.4,
    ticks: 100,
  };
}

/** Partie où l'attaque perce jusqu'au tour `round` inclus, puis la défense la repousse. */
function defenseWinsAtRound(round: number): RunMetrics {
  const attacks: AttackPhaseMetrics[] = [];
  const defenses: DefensePhaseMetrics[] = [];
  for (let palier = 1; palier < round; palier++) {
    attacks.push(attackPhase(palier, 'success'));
    defenses.push(defensePhase(palier + 1, 'success'));
  }
  attacks.push(attackPhase(round, 'failure'));
  return { winner: 'defense', palierAtEnd: round, attacks, defenses };
}

/** Partie où la défense tient jusqu'au tour `round`, où elle est percée : l'attaque gagne. */
function attackWinsAtRound(round: number): RunMetrics {
  const attacks: AttackPhaseMetrics[] = [];
  const defenses: DefensePhaseMetrics[] = [];
  for (let palier = 1; palier < round; palier++) {
    attacks.push(attackPhase(palier, 'success'));
    defenses.push(defensePhase(palier + 1, 'success'));
  }
  attacks.push(attackPhase(round, 'success'));
  defenses.push(defensePhase(round + 1, 'failure'));
  return { winner: 'attack', palierAtEnd: round + 1, attacks, defenses };
}

describe('hazardCurve', () => {
  it('sépare les deux risques d\'un même tour malgré le décalage de palier', () => {
    const runs = [defenseWinsAtRound(1), attackWinsAtRound(1), defenseWinsAtRound(2)];
    const curve = hazardCurve(runs);

    expect(curve).toHaveLength(2);

    const [first, second] = curve;
    expect(first.palier).toBe(1);
    expect(first.atRisk).toBe(3);
    expect(first.attackFailures).toBe(1);
    expect(first.defensePhases).toBe(2);
    expect(first.defenseFailures).toBe(1);
    expect(first.hazard).toBeCloseTo(2 / 3);
    expect(first.eventualAttackWinRate).toBeCloseTo(1 / 3);

    // Seule la partie survivante atteint le tour 2, et l'attaque y échoue.
    expect(second.palier).toBe(2);
    expect(second.atRisk).toBe(1);
    expect(second.attackFailures).toBe(1);
    expect(second.defensePhases).toBe(0);
    expect(second.hazard).toBe(1);
    expect(second.eventualAttackWinRate).toBe(0);
  });

  it('ne compte au risque que les parties ayant atteint le palier', () => {
    const runs = [defenseWinsAtRound(1), defenseWinsAtRound(5)];
    const curve = hazardCurve(runs);

    expect(curve.map((point) => point.atRisk)).toEqual([2, 1, 1, 1, 1]);
  });
});

describe('decisionProfile', () => {
  /**
   * Reproduit la pathologie observée sur "clairiere-02" : l'attaque ne gagne qu'aux tours 1-3, la
   * défense n'emporte les siennes qu'à partir du tour 10. Échantillons volontairement gros, sinon
   * les paliers profonds tombent sous `TIPPING_MIN_SAMPLE` et aucune bascule ne peut être conclue.
   */
  const frontLoadedRuns: RunMetrics[] = [
    ...Array.from({ length: 12 }, () => attackWinsAtRound(1)),
    ...Array.from({ length: 12 }, () => attackWinsAtRound(2)),
    ...Array.from({ length: 12 }, () => attackWinsAtRound(3)),
    ...[10, 11, 12, 13, 14, 15].flatMap((round) =>
      Array.from({ length: 4 }, () => defenseWinsAtRound(round)),
    ),
  ];

  it('détecte la bascule et chiffre les tours joués d\'avance', () => {
    const profile = decisionProfile(frontLoadedRuns);

    // L'attaque gagne encore 33% au palier 3, plus rien au palier 4 : la bascule est là.
    expect(profile.tippingPalier).toBe(4);

    // 372 tours joués au total, dont 228 au palier >= 4.
    expect(profile.deadRoundShare).toBeCloseTo(228 / 372);
  });

  it('mesure un risque plus élevé en début de partie', () => {
    const profile = decisionProfile(frontLoadedRuns);

    expect(profile.hazardEarly).toBeCloseTo(36 / 192);
    expect(profile.hazardLate).toBeCloseTo(24 / 180);
    expect(profile.hazardEarly).toBeGreaterThan(profile.hazardLate);
  });

  it('révèle des issues sans recouvrement', () => {
    const profile = decisionProfile(frontLoadedRuns);

    expect(profile.attackWinP90).toBe(4);
    expect(profile.firstDefenseWinPalier).toBe(10);
  });

  it('ne déclare aucune bascule quand l\'attaque reste en course au dernier palier', () => {
    const runs = [
      ...Array.from({ length: 10 }, () => attackWinsAtRound(4)),
      ...Array.from({ length: 10 }, () => defenseWinsAtRound(4)),
    ];
    const profile = decisionProfile(runs);

    expect(profile.tippingPalier).toBeUndefined();
    expect(profile.deadRoundShare).toBe(0);
  });

  it('ignore les paliers à faible échantillon pour la bascule', () => {
    // Une seule partie profonde : le palier 2 n'a pas l'échantillon requis pour conclure.
    const runs = [
      ...Array.from({ length: 10 }, () => attackWinsAtRound(1)),
      defenseWinsAtRound(9),
    ];

    expect(decisionProfile(runs).tippingPalier).toBeUndefined();
  });

  it('reste défini sur un jeu de parties vide', () => {
    const profile = decisionProfile([]);

    expect(profile.tippingPalier).toBeUndefined();
    expect(profile.deadRoundShare).toBe(0);
    expect(profile.earlyDecisionShare).toBe(0);
    expect(profile.attackWinP90).toBeUndefined();
  });
});

describe('aiDrift', () => {
  it('sépare les phases tôt / tard autour du palier de coupure', () => {
    const drift = aiDrift([defenseWinsAtRound(8)], 5);

    // Attaques aux paliers 1..8 : 5 tôt, 3 tard.
    expect(drift.attackPhasesEarly).toBe(5);
    expect(drift.attackPhasesLate).toBe(3);
    // La dernière attaque échoue, les 7 premières percent.
    expect(drift.attackSuccessEarly).toBe(1);
    expect(drift.attackSuccessLate).toBeCloseTo(2 / 3);
  });

  it('renvoie des zéros plutôt que NaN quand un côté est vide', () => {
    const drift = aiDrift([defenseWinsAtRound(1)], 5);

    expect(drift.attackPhasesLate).toBe(0);
    expect(drift.attackBudgetUseLate).toBe(0);
    expect(drift.defenseOverkillLate).toBe(0);
  });
});
