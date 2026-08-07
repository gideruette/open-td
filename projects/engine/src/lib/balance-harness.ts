import type { TowerInstance, Wave } from 'shared';
import { MONSTER_TYPES, TOWER_TYPES, findMapCatalogEntry, findMonsterType, findTowerType } from 'shared';
import { DefenseSimulation, waveCost } from './combat';
import { GameEngine } from './engine';
import { evolveAttackWave } from './ia-attack-player';
import { playDefensePhase } from './ia-defense-player';
import { PATH_CELL_COST, coveredCells } from './path';

/**
 * Cœur du harnais d'équilibre IA vs IA (CONCEPTION.md §13) : une partie complète, l'agrégat et
 * le rapport texte. Consommé par le spec Vitest (campagne courte) et par le runner Node parallèle
 * (`scripts/balance-campaign.mjs`) pour les campagnes lourdes.
 */

export interface BalanceHarnessOptions {
  /** Temps de réflexion accordé à chaque IA par phase (ms). */
  thinkMs: number;
  /** Garde-fou : la partie doit se conclure avant. */
  maxPaliers: number;
  attackMaxLanes: number;
  /** Aligné sur `OFFICIAL_POPULATION_SIZE` en jeu. */
  attackPopulation: number;
}

export const DEFAULT_BALANCE_OPTIONS: BalanceHarnessOptions = {
  thinkMs: 1000,
  maxPaliers: 20,
  attackMaxLanes: 5,
  attackPopulation: 50,
};

/** Issue d'une épreuve, plus le cas dégénéré où la simulation n'a pas convergé dans `maxTicks`. */
export type PhaseOutcome = 'success' | 'failure' | 'non-convergent';

export interface AttackPhaseMetrics {
  palier: number;
  budget: number;
  /** Coût total payé (monstres + cases de route) : `waveCost`. */
  spent: number;
  routeCost: number;
  monsterCost: number;
  lanes: number;
  /** Cases de route distinctes (une case partagée par deux voies n'est facturée qu'une fois). */
  routeCells: number;
  units: number;
  unitsByType: Map<string, number>;
  costByType: Map<string, number>;
  /** 'success' = château détruit, l'attaque emporte la phase. */
  outcome: PhaseOutcome;
  breaches: number;
  chateauHpLeft: number;
  ticks: number;
}

export interface DefensePhaseMetrics {
  palier: number;
  budget: number;
  spent: number;
  towers: number;
  towersByType: Map<string, number>;
  costByType: Map<string, number>;
  /** Placements proposés par l'IA que le moteur a refusés : doit rester à 0. */
  rejected: number;
  /** 'success' = aucun dégât encaissé (CONCEPTION.md §13). */
  outcome: PhaseOutcome;
  chateauHpLeft: number;
  /** Dégâts infligés / PV totaux de la vague composée. > 1 = puissance de feu excédentaire. */
  overkill: number;
  ticks: number;
}

export interface RunMetrics {
  winner: 'attack' | 'defense' | 'none';
  palierAtEnd: number;
  attacks: AttackPhaseMetrics[];
  defenses: DefensePhaseMetrics[];
}

/** Forme JSON-friendly de `RunMetrics` (Maps → objets), pour les shards JSONL. */
export interface SerializedRunMetrics {
  winner: RunMetrics['winner'];
  palierAtEnd: number;
  attacks: SerializedAttackPhase[];
  defenses: SerializedDefensePhase[];
}

interface SerializedAttackPhase extends Omit<AttackPhaseMetrics, 'unitsByType' | 'costByType'> {
  unitsByType: Record<string, number>;
  costByType: Record<string, number>;
}

interface SerializedDefensePhase extends Omit<DefensePhaseMetrics, 'towersByType' | 'costByType'> {
  towersByType: Record<string, number>;
  costByType: Record<string, number>;
}

/** PV totaux des monstres composés dans la vague (hors progéniture d'une scission). */
function waveHp(wave: Wave): number {
  return wave.lanes.reduce(
    (total, lane) =>
      total + lane.units.reduce((sum, unit) => sum + (findMonsterType(unit.type)?.hp ?? 0), 0),
    0,
  );
}

function bump(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function mergeInto(target: Map<string, number>, source: Map<string, number>): void {
  for (const [key, value] of source) {
    bump(target, key, value);
  }
}

function towersCost(towers: readonly TowerInstance[]): number {
  return towers.reduce((total, tower) => total + (findTowerType(tower.typeId)?.cost ?? 0), 0);
}

function runPhase(trial: DefenseSimulation): PhaseOutcome {
  try {
    return trial.runToCompletion() === 'success' ? 'success' : 'failure';
  } catch {
    return 'non-convergent';
  }
}

function mapToRecord(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries(map);
}

function recordToMap(record: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(record));
}

/** Sérialise une partie pour écriture JSONL (shards workers). */
export function serializeRun(run: RunMetrics): SerializedRunMetrics {
  return {
    winner: run.winner,
    palierAtEnd: run.palierAtEnd,
    attacks: run.attacks.map((phase) => ({
      ...phase,
      unitsByType: mapToRecord(phase.unitsByType),
      costByType: mapToRecord(phase.costByType),
    })),
    defenses: run.defenses.map((phase) => ({
      ...phase,
      towersByType: mapToRecord(phase.towersByType),
      costByType: mapToRecord(phase.costByType),
    })),
  };
}

/** Rehydrate une partie depuis un shard JSONL. */
export function deserializeRun(raw: SerializedRunMetrics): RunMetrics {
  return {
    winner: raw.winner,
    palierAtEnd: raw.palierAtEnd,
    attacks: raw.attacks.map((phase) => ({
      ...phase,
      unitsByType: recordToMap(phase.unitsByType),
      costByType: recordToMap(phase.costByType),
    })),
    defenses: raw.defenses.map((phase) => ({
      ...phase,
      towersByType: recordToMap(phase.towersByType),
      costByType: recordToMap(phase.costByType),
    })),
  };
}

/** Joue une partie IA vs IA complète sur `mapId` et retourne les métriques brutes. */
export async function playBalanceRun(
  mapId: string,
  options: BalanceHarnessOptions = DEFAULT_BALANCE_OPTIONS,
): Promise<RunMetrics> {
  const { geometry, startingData } = findMapCatalogEntry(mapId)!;
  const engine = new GameEngine();
  engine.startRun(geometry, startingData);

  const attacks: AttackPhaseMetrics[] = [];
  const defenses: DefensePhaseMetrics[] = [];
  let winner: RunMetrics['winner'] = 'none';

  for (let i = 0; i < options.maxPaliers && winner === 'none'; i++) {
    const palier = engine.getPalier();
    const currentMap = engine.getMap()!;

    const attackBudget = engine.getAttackBudget();
    const wave = await evolveAttackWave(
      currentMap,
      engine.getTowers(),
      attackBudget,
      engine.getChateauMaxHp(),
      MONSTER_TYPES,
      options.attackMaxLanes,
      options.attackPopulation,
      options.thinkMs,
    );

    const routeCells = coveredCells(wave.lanes.map((lane) => lane.path)).size;
    const routeCost = routeCells * PATH_CELL_COST;
    const spent = waveCost(wave);
    const unitsByType = new Map<string, number>();
    const attackCostByType = new Map<string, number>();
    for (const lane of wave.lanes) {
      for (const unit of lane.units) {
        bump(unitsByType, unit.type, 1);
        bump(attackCostByType, unit.type, findMonsterType(unit.type)?.cost ?? 0);
      }
    }

    const attackTrial = engine.startAttackTrial(wave);
    const attackOutcome = runPhase(attackTrial);

    attacks.push({
      palier,
      budget: attackBudget,
      spent,
      routeCost,
      monsterCost: spent - routeCost,
      lanes: wave.lanes.length,
      routeCells,
      units: [...unitsByType.values()].reduce((a, b) => a + b, 0),
      unitsByType,
      costByType: attackCostByType,
      outcome: attackOutcome,
      breaches: attackTrial.getBreachCount(),
      chateauHpLeft: attackTrial.getChateauHp(),
      ticks: attackTrial.getTick(),
    });

    if (attackOutcome !== 'success') {
      winner = 'defense';
      break;
    }
    engine.resolveAttackSuccess(wave);

    const vagueCourante = engine.getVagueCourante() as Wave;
    const defenseBudget = engine.getDefenseBudget();
    engine.resetDefenseSession();

    const proposed =
      (await playDefensePhase({
        map: engine.getMap()!,
        wave: vagueCourante,
        defenseBudget,
        chateauMaxHp: engine.getChateauMaxHp(),
        maxTime: options.thinkMs,
      })) ?? [];

    let rejected = 0;
    for (const tower of proposed) {
      if (!engine.placeTower(tower.typeId, tower.position).ok) {
        rejected++;
      }
    }

    const placed = engine.getTowers();
    const towersByType = new Map<string, number>();
    const defenseCostByType = new Map<string, number>();
    for (const tower of placed) {
      bump(towersByType, tower.typeId, 1);
      bump(defenseCostByType, tower.typeId, findTowerType(tower.typeId)?.cost ?? 0);
    }

    const defenseTrial = engine.startDefenseTrial();
    const defenseOutcome = runPhase(defenseTrial);
    const hp = waveHp(vagueCourante);

    defenses.push({
      palier: engine.getPalier(),
      budget: defenseBudget,
      spent: towersCost(placed),
      towers: placed.length,
      towersByType,
      costByType: defenseCostByType,
      rejected,
      outcome: defenseOutcome,
      chateauHpLeft: defenseTrial.getChateauHp(),
      overkill: hp > 0 ? defenseTrial.getTotalDamageDealt() / hp : 0,
      ticks: defenseTrial.getTick(),
    });

    if (defenseOutcome !== 'success') {
      winner = 'attack';
      break;
    }
    engine.resolveDefenseSuccess();
  }

  return { winner, palierAtEnd: engine.getPalier(), attacks, defenses };
}

// ---------------------------------------------------------------------------
// Indicateurs de forme de partie
// ---------------------------------------------------------------------------

/**
 * Risque de fin de partie à un palier, conditionné au fait de l'avoir atteint.
 *
 * Un jeu intéressant a une courbe PLATE. Un taux de victoire global de 50% obtenu avec tout le
 * risque concentré sur les premiers paliers ne décrit pas une partie serrée mais deux régimes
 * (« l'attaque perce tôt » / « la partie est jouée d'avance »), ce que le seul %victoires masque.
 *
 * Convention de palier du harnais : la phase Défense qui répond à l'attaque du palier `p` est
 * enregistrée avec `palier === p + 1`, le moteur incrémentant dans `resolveAttackSuccess`. Les deux
 * risques ci-dessous sont donc bien ceux d'un même tour de jeu.
 */
export interface PalierHazard {
  palier: number;
  /** Parties ayant atteint ce palier (phase Attaque jouée). */
  atRisk: number;
  /** Attaques repoussées ici → la défense emporte la partie. */
  attackFailures: number;
  /** Phases Défense jouées ici, c.-à-d. attaques ayant percé. */
  defensePhases: number;
  /** Défenses percées ici → l'attaque emporte la partie. */
  defenseFailures: number;
  /** P(la partie s'arrête à ce palier | l'avoir atteint). */
  hazard: number;
  /** P(victoire finale de l'attaque | avoir atteint ce palier) : révèle où la partie se joue. */
  eventualAttackWinRate: number;
}

/** Échantillon minimal pour qu'un palier pèse dans la recherche de bascule. */
const TIPPING_MIN_SAMPLE = 10;
/** Sous ce taux de victoire finale, l'attaque est considérée hors course. */
const TIPPING_THRESHOLD = 0.1;
/** Fenêtre « début de partie » pour la comparaison de risque précoce / tardif. */
const EARLY_WINDOW = 5;

/** Courbe de risque par palier, du palier 1 au plus profond atteint. */
export function hazardCurve(runs: readonly RunMetrics[]): PalierHazard[] {
  const maxPalier = Math.max(0, ...runs.flatMap((run) => run.attacks.map((phase) => phase.palier)));
  const curve: PalierHazard[] = [];

  for (let palier = 1; palier <= maxPalier; palier++) {
    const reached = runs.filter((run) => run.attacks.some((phase) => phase.palier === palier));
    if (reached.length === 0) {
      continue;
    }
    const attackFailures = reached.filter((run) =>
      run.attacks.some((phase) => phase.palier === palier && phase.outcome !== 'success'),
    ).length;
    const withDefense = reached.filter((run) =>
      run.defenses.some((phase) => phase.palier === palier + 1),
    );
    const defenseFailures = withDefense.filter((run) =>
      run.defenses.some((phase) => phase.palier === palier + 1 && phase.outcome !== 'success'),
    ).length;

    curve.push({
      palier,
      atRisk: reached.length,
      attackFailures,
      defensePhases: withDefense.length,
      defenseFailures,
      hazard: (attackFailures + defenseFailures) / reached.length,
      eventualAttackWinRate:
        reached.filter((run) => run.winner === 'attack').length / reached.length,
    });
  }
  return curve;
}

/** Résumé scalaire de la forme de partie, dérivé de la courbe de risque. */
export interface DecisionProfile {
  /**
   * Premier palier de la série terminale où l'attaque ne gagne plus que `TIPPING_THRESHOLD` :
   * au-delà, la partie continue mais l'issue est écrite. `undefined` = l'attaque reste en course
   * jusqu'au bout (l'objectif).
   */
  tippingPalier: number | undefined;
  /** Part des tours joués au palier >= `tippingPalier` : temps de jeu dépensé sur une issue écrite. */
  deadRoundShare: number;
  /** Part des parties décidées au palier <= `earlyWindow`. */
  earlyDecisionShare: number;
  earlyWindow: number;
  /** Risque agrégé (pooled) par tour, avant et après `earlyWindow`. */
  hazardEarly: number;
  hazardLate: number;
  /** Palier avant lequel 90% des victoires de l'attaque sont acquises. */
  attackWinP90: number | undefined;
  /** Premier palier où la défense décroche une victoire : mesure le recouvrement des deux issues. */
  firstDefenseWinPalier: number | undefined;
}

function quantile(sorted: readonly number[], q: number): number | undefined {
  if (sorted.length === 0) {
    return undefined;
  }
  const rank = Math.ceil(q * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export function decisionProfile(runs: readonly RunMetrics[]): DecisionProfile {
  const curve = hazardCurve(runs);

  // Bascule : on remonte depuis la fin tant que l'attaque est hors course, pour ne pas confondre
  // un creux transitoire avec la fin réelle de la course.
  const usable = curve.filter((point) => point.atRisk >= TIPPING_MIN_SAMPLE);
  let tippingPalier: number | undefined;
  for (let i = usable.length - 1; i >= 0; i--) {
    if (usable[i].eventualAttackWinRate > TIPPING_THRESHOLD) {
      break;
    }
    tippingPalier = usable[i].palier;
  }

  const totalRounds = runs.reduce((total, run) => total + run.attacks.length, 0);
  const deadRounds =
    tippingPalier === undefined
      ? 0
      : runs.reduce(
          (total, run) =>
            total + run.attacks.filter((phase) => phase.palier >= tippingPalier!).length,
          0,
        );

  const pooled = (points: readonly PalierHazard[]) => {
    const atRisk = points.reduce((total, point) => total + point.atRisk, 0);
    const ended = points.reduce(
      (total, point) => total + point.attackFailures + point.defenseFailures,
      0,
    );
    return atRisk > 0 ? ended / atRisk : 0;
  };

  const decided = runs.filter((run) => run.winner !== 'none');
  const attackWins = runs
    .filter((run) => run.winner === 'attack')
    .map((run) => run.palierAtEnd)
    .sort((a, b) => a - b);
  const defenseWins = runs
    .filter((run) => run.winner === 'defense')
    .map((run) => run.palierAtEnd)
    .sort((a, b) => a - b);

  return {
    tippingPalier,
    deadRoundShare: totalRounds > 0 ? deadRounds / totalRounds : 0,
    earlyDecisionShare:
      runs.length > 0
        ? decided.filter((run) => run.palierAtEnd <= EARLY_WINDOW).length / runs.length
        : 0,
    earlyWindow: EARLY_WINDOW,
    hazardEarly: pooled(curve.filter((point) => point.palier <= EARLY_WINDOW)),
    hazardLate: pooled(curve.filter((point) => point.palier > EARLY_WINDOW)),
    attackWinP90: quantile(attackWins, 0.9),
    firstDefenseWinPalier: defenseWins[0],
  };
}

/**
 * Santé des IA en fonction de la profondeur de partie. À `thinkMs` constant, l'espace de recherche
 * croît avec le budget : une IA qui cesse de dépenser son budget en fin de partie sature, et les
 * mesures d'équilibre tardives décrivent alors la limite du solveur, pas celle du jeu. À vérifier
 * AVANT d'interpréter une domination tardive comme un déséquilibre.
 */
export interface AiDriftMetrics {
  splitPalier: number;
  attackPhasesEarly: number;
  attackPhasesLate: number;
  attackBudgetUseEarly: number;
  attackBudgetUseLate: number;
  attackSuccessEarly: number;
  attackSuccessLate: number;
  defenseBudgetUseEarly: number;
  defenseBudgetUseLate: number;
  defenseOverkillEarly: number;
  defenseOverkillLate: number;
}

export function aiDrift(
  runs: readonly RunMetrics[],
  splitPalier: number = EARLY_WINDOW,
): AiDriftMetrics {
  const attacks = runs.flatMap((run) => run.attacks);
  const defenses = runs.flatMap((run) => run.defenses);
  const attackEarly = attacks.filter((phase) => phase.palier <= splitPalier);
  const attackLate = attacks.filter((phase) => phase.palier > splitPalier);
  const defenseEarly = defenses.filter((phase) => phase.palier <= splitPalier);
  const defenseLate = defenses.filter((phase) => phase.palier > splitPalier);

  const mean = (values: readonly number[]) =>
    values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const use = (phases: readonly { spent: number; budget: number }[]) =>
    mean(phases.map((phase) => phase.spent / Math.max(1, phase.budget)));
  const successRate = (phases: readonly { outcome: PhaseOutcome }[]) =>
    phases.length > 0
      ? phases.filter((phase) => phase.outcome === 'success').length / phases.length
      : 0;

  return {
    splitPalier,
    attackPhasesEarly: attackEarly.length,
    attackPhasesLate: attackLate.length,
    attackBudgetUseEarly: use(attackEarly),
    attackBudgetUseLate: use(attackLate),
    attackSuccessEarly: successRate(attackEarly),
    attackSuccessLate: successRate(attackLate),
    defenseBudgetUseEarly: use(defenseEarly),
    defenseBudgetUseLate: use(defenseLate),
    defenseOverkillEarly: mean(defenseEarly.map((phase) => phase.overkill)),
    defenseOverkillLate: mean(defenseLate.map((phase) => phase.overkill)),
  };
}

// ---------------------------------------------------------------------------
// Rapport
// ---------------------------------------------------------------------------

interface Stats {
  n: number;
  mean: number;
  median: number;
  min: number;
  max: number;
}

function stats(values: readonly number[]): Stats {
  if (values.length === 0) {
    return { n: 0, mean: 0, median: 0, min: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    median: sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

/**
 * Entropie de Shannon normalisée (0 → 1) des parts d'usage : 1 = catalogue parfaitement diversifié,
 * 0 = un seul type capte tout. `slots` = nombre de types disponibles, y compris part nulle.
 */
function normalizedEntropy(shares: readonly number[], slots: number): number {
  const total = shares.reduce((a, b) => a + b, 0);
  if (total <= 0 || slots <= 1) {
    return 0;
  }
  let entropy = 0;
  for (const share of shares) {
    const p = share / total;
    if (p > 0) {
      entropy -= p * Math.log(p);
    }
  }
  return entropy / Math.log(slots);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function row(cells: readonly (string | number)[], widths: readonly number[]): string {
  return cells
    .map((cell, index) => {
      const text = typeof cell === 'number' ? cell.toFixed(2) : cell;
      return index === 0 ? text.padEnd(widths[index]) : text.padStart(widths[index]);
    })
    .join('  ');
}

function logUsageTable(
  lines: string[],
  title: string,
  catalogue: readonly { id: string; name: string; cost: number }[],
  unitLabel: string,
  counts: Map<string, number>,
  costs: Map<string, number>,
  phasesPresent: Map<string, number>,
  totalPhases: number,
): number {
  const totalCost = [...costs.values()].reduce((a, b) => a + b, 0);
  const totalCount = [...counts.values()].reduce((a, b) => a + b, 0);
  const widths = [18, 5, 7, 9, 9, 9];

  lines.push(`\n${title}`);
  lines.push(row(['type', 'prix', unitLabel, '%' + unitLabel, '%budget', 'présence'], widths));
  lines.push('-'.repeat(widths.reduce((a, b) => a + b + 2, 0)));

  const ordered = [...catalogue].sort((a, b) => (costs.get(b.id) ?? 0) - (costs.get(a.id) ?? 0));
  for (const type of ordered) {
    const count = counts.get(type.id) ?? 0;
    const cost = costs.get(type.id) ?? 0;
    lines.push(
      row(
        [
          type.id,
          String(type.cost),
          String(count),
          totalCount > 0 ? pct(count / totalCount) : '—',
          totalCost > 0 ? pct(cost / totalCost) : '—',
          totalPhases > 0 ? pct((phasesPresent.get(type.id) ?? 0) / totalPhases) : '—',
        ],
        widths,
      ),
    );
  }

  const entropy = normalizedEntropy(
    catalogue.map((type) => costs.get(type.id) ?? 0),
    catalogue.length,
  );
  lines.push(`entropie d'usage (part de budget, normalisée) : ${entropy.toFixed(3)}`);
  return entropy;
}

export interface BalanceReportInput {
  mapId: string;
  runs: readonly RunMetrics[];
  options: BalanceHarnessOptions;
  /** Ex. "8 workers" — apparaîtra dans l'en-tête. */
  parallelNote?: string;
}

/** Produit le rapport texte d'équilibre (même format que l'ancien spec). */
export function formatBalanceReport(input: BalanceReportInput): string {
  const { mapId, runs, options, parallelNote } = input;
  const startingData = findMapCatalogEntry(mapId)!.startingData;
  const buyableMonsters = MONSTER_TYPES.filter((type) => !type.internal);
  const runCount = runs.length;
  const lines: string[] = [];

  lines.push('='.repeat(78));
  lines.push(`ÉQUILIBRE — carte "${mapId}" — ${runCount} parties`);
  lines.push(
    `réflexion IA ${options.thinkMs} ms/phase · population attaque ${options.attackPopulation} · ` +
      `voies max ${options.attackMaxLanes} · paliers max ${options.maxPaliers}` +
      (parallelNote ? ` · ${parallelNote}` : ''),
  );
  lines.push(
    `budgets départ déf/att ${startingData.startingDefenseBudget}/${startingData.startingAttackBudget} · ` +
      `croissance +${startingData.budgetGrowth.defense}/+${startingData.budgetGrowth.attack} par palier · ` +
      `PV château ${startingData.chateauHp} · coût case de route ${PATH_CELL_COST}`,
  );
  lines.push('='.repeat(78));

  const attacks = runs.flatMap((run) => run.attacks);
  const defenses = runs.flatMap((run) => run.defenses);

  const attackWins = runs.filter((run) => run.winner === 'attack').length;
  const defenseWins = runs.filter((run) => run.winner === 'defense').length;
  const undecided = runs.filter((run) => run.winner === 'none').length;
  const palierStats = stats(runs.map((run) => run.palierAtEnd));

  lines.push(`\n--- 1. Issue des parties -------------------------------------------`);
  lines.push(`attaque gagne  : ${attackWins}/${runCount}  (${pct(attackWins / runCount)})`);
  lines.push(`défense gagne  : ${defenseWins}/${runCount}  (${pct(defenseWins / runCount)})`);
  lines.push(`indécis (plafond ${options.maxPaliers} paliers) : ${undecided}/${runCount}`);
  lines.push(
    `palier atteint : médiane ${palierStats.median} · moyenne ${palierStats.mean.toFixed(1)} · ` +
      `min ${palierStats.min} · max ${palierStats.max}`,
  );

  const curve = hazardCurve(runs);
  const profile = decisionProfile(runs);
  const drift = aiDrift(runs);

  lines.push(`\n--- 2. Courbe par palier -------------------------------------------`);
  const curveWidths = [6, 5, 8, 8, 7, 9, 8, 7, 9];
  lines.push(
    row(
      ['palier', 'runs', '%att OK', '%déf OK', 'risque', '%att fin', 'bud.att', '%util', 'overkill'],
      curveWidths,
    ),
  );
  lines.push('-'.repeat(curveWidths.reduce((a, b) => a + b + 2, 0)));
  for (const point of curve) {
    const atPalier = attacks.filter((phase) => phase.palier === point.palier);
    const defenseAtPalier = defenses.filter((phase) => phase.palier === point.palier + 1);
    const attackSuccess = atPalier.filter((phase) => phase.outcome === 'success').length;
    const defenseSuccess = defenseAtPalier.filter((phase) => phase.outcome === 'success').length;
    lines.push(
      row(
        [
          String(point.palier),
          String(point.atRisk),
          pct(attackSuccess / atPalier.length),
          defenseAtPalier.length > 0 ? pct(defenseSuccess / defenseAtPalier.length) : '—',
          pct(point.hazard),
          pct(point.eventualAttackWinRate),
          stats(atPalier.map((phase) => phase.budget)).mean.toFixed(0),
          pct(stats(atPalier.map((phase) => phase.spent / Math.max(1, phase.budget))).mean),
          defenseAtPalier.length > 0
            ? stats(defenseAtPalier.map((phase) => phase.overkill)).mean.toFixed(2)
            : '—',
        ],
        curveWidths,
      ),
    );
  }
  lines.push(
    'Lire : risque = P(la partie s\'arrête ici | l\'avoir atteint) ; ' +
      '%att fin = P(l\'attaque gagne au final | avoir atteint ce palier).',
  );

  lines.push(`\n--- 3. Forme de partie --------------------------------------------`);
  lines.push(
    `risque par tour : ${pct(profile.hazardEarly)} aux paliers 1-${profile.earlyWindow} · ` +
      `${pct(profile.hazardLate)} au-delà` +
      (profile.hazardLate > 0
        ? `  (ratio ${(profile.hazardEarly / profile.hazardLate).toFixed(1)}×)`
        : ''),
  );
  lines.push(
    `parties décidées au palier <= ${profile.earlyWindow} : ${pct(profile.earlyDecisionShare)}`,
  );
  lines.push(
    `90% des victoires attaque acquises au palier <= ${profile.attackWinP90 ?? '—'} · ` +
      `1re victoire défense au palier ${profile.firstDefenseWinPalier ?? '—'}` +
      (profile.attackWinP90 !== undefined &&
      profile.firstDefenseWinPalier !== undefined &&
      profile.attackWinP90 < profile.firstDefenseWinPalier
        ? '  → issues disjointes : deux régimes, pas une partie serrée'
        : ''),
  );
  if (profile.tippingPalier === undefined) {
    lines.push(
      `bascule : aucune — l'attaque reste en course (> ${pct(TIPPING_THRESHOLD)}) à tous les paliers`,
    );
  } else {
    lines.push(
      `bascule au palier ${profile.tippingPalier} : au-delà, l'attaque gagne ` +
        `<= ${pct(TIPPING_THRESHOLD)} des parties`,
    );
    lines.push(
      `tours joués sur une issue déjà écrite : ${pct(profile.deadRoundShare)} du total`,
    );
  }

  lines.push(`\n--- 4. Dérive des IA (fiabilité de la mesure) ----------------------`);
  const driftWidths = [22, 12, 12, 10];
  lines.push(
    row(
      ['indicateur', `pal. 1-${drift.splitPalier}`, `pal. > ${drift.splitPalier}`, 'écart'],
      driftWidths,
    ),
  );
  lines.push('-'.repeat(driftWidths.reduce((a, b) => a + b + 2, 0)));
  const driftRow = (label: string, early: number, late: number, format = pct) =>
    lines.push(
      row([label, format(early), format(late), format(late - early)], driftWidths),
    );
  driftRow('budget attaque util.', drift.attackBudgetUseEarly, drift.attackBudgetUseLate);
  driftRow('attaques réussies', drift.attackSuccessEarly, drift.attackSuccessLate);
  driftRow('budget défense util.', drift.defenseBudgetUseEarly, drift.defenseBudgetUseLate);
  driftRow(
    'overkill défense',
    drift.defenseOverkillEarly,
    drift.defenseOverkillLate,
    (value) => value.toFixed(2),
  );
  lines.push(
    `phases mesurées : ${drift.attackPhasesEarly} tôt · ${drift.attackPhasesLate} tard`,
  );
  lines.push(
    'Lire : une utilisation du budget d\'attaque qui chute en fin de partie signale un GA qui sature ' +
      'à thinkMs constant — la domination tardive mesure alors le solveur, pas le jeu.',
  );

  const monsterCounts = new Map<string, number>();
  const monsterCosts = new Map<string, number>();
  const monsterPresence = new Map<string, number>();
  for (const phase of attacks) {
    mergeInto(monsterCounts, phase.unitsByType);
    mergeInto(monsterCosts, phase.costByType);
    for (const typeId of phase.unitsByType.keys()) {
      bump(monsterPresence, typeId, 1);
    }
  }
  const monsterEntropy = logUsageTable(
    lines,
    '--- 5. Monstres (demande révélée par l\'IA d\'attaque) --------------',
    buyableMonsters,
    'unités',
    monsterCounts,
    monsterCosts,
    monsterPresence,
    attacks.length,
  );

  const towerCounts = new Map<string, number>();
  const towerCosts = new Map<string, number>();
  const towerPresence = new Map<string, number>();
  for (const phase of defenses) {
    mergeInto(towerCounts, phase.towersByType);
    mergeInto(towerCosts, phase.costByType);
    for (const typeId of phase.towersByType.keys()) {
      bump(towerPresence, typeId, 1);
    }
  }
  const towerEntropy = logUsageTable(
    lines,
    '--- 6. Tours (demande révélée par l\'IA de défense) ----------------',
    TOWER_TYPES,
    'tours',
    towerCounts,
    towerCosts,
    towerPresence,
    defenses.length,
  );

  const laneStats = stats(attacks.map((phase) => phase.lanes));
  const cellStats = stats(attacks.map((phase) => phase.routeCells));
  const routeShareStats = stats(attacks.map((phase) => phase.routeCost / Math.max(1, phase.spent)));
  lines.push(`\n--- 7. Routes -----------------------------------------------------`);
  lines.push(
    `voies par vague     : médiane ${laneStats.median} · moyenne ${laneStats.mean.toFixed(2)} · ` +
      `min ${laneStats.min} · max ${laneStats.max}  (plafond ${options.attackMaxLanes})`,
  );
  lines.push(
    `cases de route      : médiane ${cellStats.median} · moyenne ${cellStats.mean.toFixed(1)} · ` +
      `min ${cellStats.min} · max ${cellStats.max}`,
  );
  lines.push(
    `part du budget att. : moyenne ${pct(routeShareStats.mean)} · ` +
      `min ${pct(routeShareStats.min)} · max ${pct(routeShareStats.max)}`,
  );

  const attackUseStats = stats(attacks.map((phase) => phase.spent / Math.max(1, phase.budget)));
  const defenseUseStats = stats(defenses.map((phase) => phase.spent / Math.max(1, phase.budget)));
  const overkillStats = stats(defenses.map((phase) => phase.overkill));
  const failedAttacks = attacks.filter((phase) => phase.outcome === 'failure');
  const breachStats = stats(failedAttacks.map((phase) => phase.breaches));
  const hpLeftStats = stats(failedAttacks.map((phase) => phase.chateauHpLeft));

  lines.push(`\n--- 8. Marges et tension ------------------------------------------`);
  lines.push(
    `budget attaque utilisé : moyenne ${pct(attackUseStats.mean)} · min ${pct(attackUseStats.min)}`,
  );
  lines.push(
    `budget défense utilisé : moyenne ${pct(defenseUseStats.mean)} · min ${pct(defenseUseStats.min)}`,
  );
  lines.push(
    `overkill défense (dégâts infligés / PV vague) : moyenne ${overkillStats.mean.toFixed(2)} · ` +
      `médiane ${overkillStats.median.toFixed(2)} · max ${overkillStats.max.toFixed(2)}`,
  );
  lines.push(
    `sur ${failedAttacks.length} attaque(s) repoussée(s) : ` +
      `${breachStats.mean.toFixed(2)} brèche(s) en moyenne, ` +
      `château à ${hpLeftStats.mean.toFixed(2)}/${startingData.chateauHp} PV`,
  );
  lines.push(
    `tours posées : moyenne ${stats(defenses.map((phase) => phase.towers)).mean.toFixed(1)} · ` +
      `monstres par vague : moyenne ${stats(attacks.map((phase) => phase.units)).mean.toFixed(1)}`,
  );

  const alerts: string[] = [];
  const totalMonsterCost = [...monsterCosts.values()].reduce((a, b) => a + b, 0);
  const totalTowerCost = [...towerCosts.values()].reduce((a, b) => a + b, 0);

  for (const type of buyableMonsters) {
    const share = totalMonsterCost > 0 ? (monsterCosts.get(type.id) ?? 0) / totalMonsterCost : 0;
    if ((monsterCounts.get(type.id) ?? 0) === 0) {
      alerts.push(`monstre "${type.id}" (${type.cost}) jamais acheté → surpayé ou inutile`);
    } else if (share > 0.4) {
      alerts.push(`monstre "${type.id}" (${type.cost}) capte ${pct(share)} du budget → sous-payé`);
    }
  }
  for (const type of TOWER_TYPES) {
    const share = totalTowerCost > 0 ? (towerCosts.get(type.id) ?? 0) / totalTowerCost : 0;
    if ((towerCounts.get(type.id) ?? 0) === 0) {
      alerts.push(`tour "${type.id}" (${type.cost}) jamais posée → surpayée ou inutile`);
    } else if (share > 0.5) {
      alerts.push(`tour "${type.id}" (${type.cost}) capte ${pct(share)} du budget → sous-payée`);
    }
  }
  if (attackUseStats.mean < 0.9) {
    alerts.push(
      `budget d'attaque utilisé à ${pct(attackUseStats.mean)} → il n'est pas la contrainte active`,
    );
  }
  if (defenseUseStats.mean < 0.9) {
    alerts.push(
      `budget de défense utilisé à ${pct(defenseUseStats.mean)} → il n'est pas la contrainte active`,
    );
  }
  if (attackWins === runCount || defenseWins === runCount) {
    alerts.push(
      `un camp gagne 100% des parties → régler le ratio de croissance des budgets AVANT les prix`,
    );
  }

  // Forme de partie : un %victoires équilibré peut cacher une partie décidée d'avance.
  if (profile.tippingPalier !== undefined) {
    alerts.push(
      `partie décidée dès le palier ${profile.tippingPalier} (l'attaque y gagne ` +
        `<= ${pct(TIPPING_THRESHOLD)}) → ${pct(profile.deadRoundShare)} des tours joués le sont ` +
        `sur une issue écrite`,
    );
  }
  if (profile.hazardLate > 0 && profile.hazardEarly > 2 * profile.hazardLate) {
    alerts.push(
      `risque concentré au début (${pct(profile.hazardEarly)} vs ${pct(profile.hazardLate)} par ` +
        `tour) → le %victoires global mélange deux régimes, il ne mesure pas une partie serrée`,
    );
  }
  if (
    profile.attackWinP90 !== undefined &&
    profile.firstDefenseWinPalier !== undefined &&
    profile.attackWinP90 < profile.firstDefenseWinPalier
  ) {
    alerts.push(
      `issues disjointes : 90% des victoires attaque avant le palier ${profile.attackWinP90}, ` +
        `1re victoire défense au palier ${profile.firstDefenseWinPalier} → aucun recouvrement`,
    );
  }

  // Fiabilité : distinguer un déséquilibre réel d'une IA qui sature à thinkMs constant.
  if (drift.attackPhasesLate > 0 && drift.attackBudgetUseLate < drift.attackBudgetUseEarly - 0.03) {
    alerts.push(
      `l'IA d'attaque cesse de dépenser son budget en fin de partie ` +
        `(${pct(drift.attackBudgetUseEarly)} → ${pct(drift.attackBudgetUseLate)}) → GA saturé à ` +
        `${options.thinkMs} ms, rejouer plus haut AVANT d'en tirer une conclusion de prix`,
    );
  }
  if (drift.attackPhasesLate > 0 && drift.defenseBudgetUseLate < drift.defenseBudgetUseEarly - 0.03) {
    alerts.push(
      `l'IA de défense cesse de dépenser son budget en fin de partie ` +
        `(${pct(drift.defenseBudgetUseEarly)} → ${pct(drift.defenseBudgetUseLate)}) → GA saturé à ` +
        `${options.thinkMs} ms`,
    );
  }
  if (monsterEntropy < 0.6) {
    alerts.push(`entropie monstres ${monsterEntropy.toFixed(3)} < 0.6 → catalogue peu diversifié`);
  }
  if (towerEntropy < 0.6) {
    alerts.push(`entropie tours ${towerEntropy.toFixed(3)} < 0.6 → catalogue peu diversifié`);
  }
  const rejectedTotal = defenses.reduce((total, phase) => total + phase.rejected, 0);
  if (rejectedTotal > 0) {
    alerts.push(`${rejectedTotal} placement(s) de tour refusé(s) par le moteur → mesures faussées`);
  }
  const nonConvergent = [...attacks, ...defenses].filter(
    (phase) => phase.outcome === 'non-convergent',
  ).length;
  if (nonConvergent > 0) {
    alerts.push(`${nonConvergent} simulation(s) non convergente(s) (maxTicks dépassé)`);
  }
  const emptyWaves = attacks.filter((phase) => phase.lanes === 0).length;
  if (emptyWaves > 0) {
    alerts.push(
      `${emptyWaves}/${attacks.length} vague(s) d'attaque vides (0 voie) → THINK_MS trop court, ` +
        `moyennes d'attaque faussées`,
    );
  }

  lines.push(`\n--- 9. Alertes (indicatif) ----------------------------------------`);
  if (alerts.length === 0) {
    lines.push('aucune');
  } else {
    for (const alert of alerts) {
      lines.push(`  ⚠ ${alert}`);
    }
  }
  lines.push(
    `\nRappel : ces chiffres mesurent l'équilibre FACE À DES IA À ${options.thinkMs} ms/phase, ` +
      `pas face à un joueur.\nAvant toute décision de tarification, rejouer à ` +
      `THINK_MS plus élevé et vérifier que les conclusions tiennent.`,
  );
  lines.push('='.repeat(78));

  return lines.join('\n');
}
