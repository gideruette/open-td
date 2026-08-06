import { describe, expect, it } from 'vitest';
import type { GameMap, TowerInstance, Wave } from 'shared';
import { MONSTER_TYPES, TOWER_TYPES, findMapCatalogEntry, findMonsterType, findTowerType } from 'shared';
import { DefenseSimulation, waveCost } from './combat';
import { GameEngine } from './engine';
import { evolveAttackWave } from './ia-attack-player';
import { playDefensePhase } from './ia-defense-player';
import { PATH_CELL_COST, coveredCells } from './path';

/**
 * Harnais de mesure d'équilibre : joue `RUNS` parties IA vs IA complètes et agrège des métriques
 * exploitables pour tarifer monstres, tours, routes et budgets (CONCEPTION.md §13). Ce spec ne
 * porte aucun jugement — il ne fait qu'observer et logger ; les seuils d'alerte en fin de rapport
 * sont indicatifs et n'échouent pas le test.
 *
 * Le signal principal pour un prix, c'est la **demande révélée** : ce que la GA achète
 * spontanément quand elle cherche à gagner. Un type qui capte une part de budget écrasante est
 * sous-payé ; un type jamais acheté est surpayé (ou inutile). Les parts de budget et les taux de
 * présence ci-dessous sont donc les colonnes à lire en premier.
 *
 * Les réglages du harnais sont les constantes ci-dessous : le projet n'a pas `@types/node`, donc
 * pas de `process.env` ici — pour une campagne plus lourde, on édite ces valeurs.
 *
 * Le rapport passe par `console.log`, que le reporter par défaut d'Angular avale. Lancer avec :
 *
 *   npx ng test engine --include "**\/balance-metrics.spec.ts" --reporters verbose
 */

/** Nombre de parties complètes jouées par carte : l'agrégat n'a de sens que sur plusieurs runs (les IA tirent au hasard, `Math.random` n'est pas seedé, rien n'est reproductible run à run). */
const RUNS = 8;
/** Temps de réflexion accordé à chaque IA par phase. Volontairement bas par défaut (vs 1500 ms en jeu réel) — voir la note sur la force des IA en fin de rapport. */
const THINK_MS = 1000;
/** Garde-fou : rien côté moteur ne borne le nombre de paliers, la partie doit se conclure avant. */
const MAX_PALIERS = 20;
const ATTACK_MAX_LANES = 5;
/**
 * Aligné sur `OFFICIAL_POPULATION_SIZE`, la population que `playAttackPhase` utilise réellement en
 * jeu : mesurer l'équilibre contre une IA plus faible que celle qui joue n'aurait pas de sens. Une
 * valeur réduite (20) a été nécessaire un temps, quand la notation d'une vague coûtait assez cher
 * pour que la seule population initiale dépasse le budget de temps aux paliers élevés — ce n'est
 * plus le cas (elle en consomme ~10 %).
 */
const ATTACK_POPULATION = 50;
/** Cartes mesurées. Élargir à `['clairiere-02', 'forest-01', ...]` pour comparer les difficultés. */
const MAP_IDS: readonly string[] = ['clairiere-02'];

/**
 * Géométrie réelle des cartes, recopiée de `projects/open-td/public/maps/{id}.map.json` (le spec ne
 * peut pas lire le disque, faute de `@types/node`). À resynchroniser si une carte change.
 *
 * Noter `spawns: []` et `paths: []` : c'est bien la situation de jeu — aucune carte ne fournit de
 * chemin, l'IA d'attaque trace toutes ses routes elle-même depuis une case de bord
 * (`initRandomRoute`). Mesurer sur une géométrie à chemins pré-câblés, comme le font les autres
 * specs, donnerait un équilibre qui ne correspond à aucune partie réelle.
 */
const GRID = { cell: 'hex', orientation: 'pointy', offset: 'odd-r' } as const;
const MAPS: Readonly<Record<string, GameMap>> = {
  'clairiere-02': {
    id: 'clairiere-02',
    grid: { cols: 16, rows: 12, ...GRID },
    chateau: { x: 8, y: 6 },
    spawns: [],
    paths: [],
    rivers: [{ id: 'riviere', nodes: [[6, 0], [8, 6], [15, 11]] }],
  },
  'forest-01': {
    id: 'forest-01',
    grid: { cols: 32, rows: 24, ...GRID },
    chateau: { x: 16, y: 12 },
    spawns: [],
    paths: [],
    rivers: [{ id: 'riviere', nodes: [[6, 0], [8, 9], [16, 12], [23, 9], [30, 0]] }],
  },
  'marais-03': {
    id: 'marais-03',
    grid: { cols: 24, rows: 18, ...GRID },
    chateau: { x: 12, y: 9 },
    spawns: [],
    paths: [],
    rivers: [{ id: 'riviere', nodes: [[12, 0], [10, 6], [12, 9], [6, 17]] }],
  },
  'toundra-05': {
    id: 'toundra-05',
    grid: { cols: 48, rows: 16, ...GRID },
    chateau: { x: 24, y: 8 },
    spawns: [],
    paths: [],
    rivers: [{ id: 'riviere', nodes: [[24, 0], [24, 14]] }],
  },
  'montagne-04': {
    id: 'montagne-04',
    grid: { cols: 40, rows: 30, ...GRID },
    chateau: { x: 20, y: 15 },
    spawns: [],
    paths: [],
    rivers: [
      { id: 'riviere', nodes: [[0, 0], [6, 8], [5, 10], [20, 15], [23, 14], [28, 20], [20, 29]] },
    ],
  },
};

/** Issue d'une épreuve, plus le cas dégénéré où la simulation n'a pas convergé dans `maxTicks`. */
type PhaseOutcome = 'success' | 'failure' | 'non-convergent';

/** Déroule l'épreuve jusqu'au bout ; `runToCompletion` lève si elle n'a pas convergé (`maxTicks`). */
function runPhase(trial: DefenseSimulation): PhaseOutcome {
  try {
    return trial.runToCompletion() === 'success' ? 'success' : 'failure';
  } catch {
    return 'non-convergent';
  }
}

interface AttackPhaseMetrics {
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

interface DefensePhaseMetrics {
  palier: number;
  budget: number;
  spent: number;
  towers: number;
  towersByType: Map<string, number>;
  costByType: Map<string, number>;
  /** Placements proposés par l'IA que le moteur a refusés (budget, case occupée…) : doit rester à 0. */
  rejected: number;
  /** 'success' = aucun dégât encaissé (CONCEPTION.md §13). */
  outcome: PhaseOutcome;
  chateauHpLeft: number;
  /** Dégâts infligés / PV totaux de la vague composée. > 1 = puissance de feu excédentaire. */
  overkill: number;
  ticks: number;
}

interface RunMetrics {
  winner: 'attack' | 'defense' | 'none';
  palierAtEnd: number;
  attacks: AttackPhaseMetrics[];
  defenses: DefensePhaseMetrics[];
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

// ---------------------------------------------------------------------------
// Une partie complète
// ---------------------------------------------------------------------------

async function playRun(map: GameMap, mapId: string): Promise<RunMetrics> {
  const startingData = findMapCatalogEntry(mapId)!.startingData;
  const engine = new GameEngine();
  engine.startRun(map, startingData);

  const attacks: AttackPhaseMetrics[] = [];
  const defenses: DefensePhaseMetrics[] = [];
  let winner: RunMetrics['winner'] = 'none';

  for (let i = 0; i < MAX_PALIERS && winner === 'none'; i++) {
    const palier = engine.getPalier();

    // --- Phase Attaque : composer une vague qui détruit la forteresse figée ---
    const attackBudget = engine.getAttackBudget();
    const wave = await evolveAttackWave(
      map,
      engine.getTowers(),
      attackBudget,
      engine.getChateauMaxHp(),
      MONSTER_TYPES,
      ATTACK_MAX_LANES,
      ATTACK_POPULATION,
      THINK_MS,
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

    // --- Phase Défense : tenir cette même vague, sans le moindre dégât ---
    const vagueCourante = engine.getVagueCourante() as Wave;
    const defenseBudget = engine.getDefenseBudget();

    // Les deux camps repartent d'une configuration libre à chaque palier, budget total
    // ré-allouable : `playDefensePhase` compose un jeu de tours from scratch pour
    // `defenseBudget`, il faut donc libérer la forteresse précédente avant de le poser —
    // sinon son coût grève le budget restant et les placements sont refusés.
    engine.resetDefenseSession();

    const proposed =
      (await playDefensePhase({
        map,
        wave: vagueCourante,
        defenseBudget,
        chateauMaxHp: engine.getChateauMaxHp(),
        maxTime: THINK_MS,
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
// Statistiques
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
 * Entropie de Shannon normalisée (0 → 1) des parts d'usage : 1 = catalogue parfaitement diversifié
 * (tous les types tirés à égalité), 0 = un seul type capte tout. C'est la mesure synthétique de
 * « est-ce que mes prix rendent tout le catalogue jouable ». `slots` doit être le nombre de types
 * réellement disponibles à l'achat, y compris ceux à part nulle.
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

/** Tableau d'usage d'un catalogue : parts de budget / de volume et taux de présence par type. */
function logUsageTable(
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

  console.log(`\n${title}`);
  console.log(row(['type', 'prix', unitLabel, '%' + unitLabel, '%budget', 'présence'], widths));
  console.log('-'.repeat(widths.reduce((a, b) => a + b + 2, 0)));

  const ordered = [...catalogue].sort((a, b) => (costs.get(b.id) ?? 0) - (costs.get(a.id) ?? 0));
  for (const type of ordered) {
    const count = counts.get(type.id) ?? 0;
    const cost = costs.get(type.id) ?? 0;
    console.log(
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
  console.log(`entropie d'usage (part de budget, normalisée) : ${entropy.toFixed(3)}`);
  return entropy;
}

// ---------------------------------------------------------------------------
// Le spec
// ---------------------------------------------------------------------------

describe('Métriques d\'équilibre IA vs IA', () => {
  for (const mapId of MAP_IDS) {
    it(
      `agrège ${RUNS} parties sur "${mapId}"`,
      async () => {
        const map = MAPS[mapId];
        const startingData = findMapCatalogEntry(mapId)!.startingData;
        const buyableMonsters = MONSTER_TYPES.filter((type) => !type.internal);

        console.log(`\n${'='.repeat(78)}`);
        console.log(`ÉQUILIBRE — carte "${mapId}" — ${RUNS} parties`);
        console.log(
          `réflexion IA ${THINK_MS} ms/phase · population attaque ${ATTACK_POPULATION} · ` +
            `voies max ${ATTACK_MAX_LANES} · paliers max ${MAX_PALIERS}`,
        );
        console.log(
          `budgets départ déf/att ${startingData.startingDefenseBudget}/${startingData.startingAttackBudget} · ` +
            `croissance +${startingData.budgetGrowth.defense}/+${startingData.budgetGrowth.attack} par palier · ` +
            `PV château ${startingData.chateauHp} · coût case de route ${PATH_CELL_COST}`,
        );
        console.log('='.repeat(78));

        const runs: RunMetrics[] = [];
        for (let index = 0; index < RUNS; index++) {
          const run = await playRun(map, mapId);
          runs.push(run);
          console.log(
            `run ${String(index + 1).padStart(2)} : ${run.winner.toUpperCase().padEnd(7)} ` +
              `au palier ${String(run.palierAtEnd).padStart(2)} ` +
              `(${run.attacks.length} phase(s) attaque, ${run.defenses.length} défense)`,
          );
        }

        const attacks = runs.flatMap((run) => run.attacks);
        const defenses = runs.flatMap((run) => run.defenses);

        // --- 1. Issue des parties -------------------------------------------------
        const attackWins = runs.filter((run) => run.winner === 'attack').length;
        const defenseWins = runs.filter((run) => run.winner === 'defense').length;
        const undecided = runs.filter((run) => run.winner === 'none').length;
        const palierStats = stats(runs.map((run) => run.palierAtEnd));

        console.log(`\n--- 1. Issue des parties -------------------------------------------`);
        console.log(`attaque gagne  : ${attackWins}/${RUNS}  (${pct(attackWins / RUNS)})`);
        console.log(`défense gagne  : ${defenseWins}/${RUNS}  (${pct(defenseWins / RUNS)})`);
        console.log(`indécis (plafond ${MAX_PALIERS} paliers) : ${undecided}/${RUNS}`);
        console.log(
          `palier atteint : médiane ${palierStats.median} · moyenne ${palierStats.mean.toFixed(1)} · ` +
            `min ${palierStats.min} · max ${palierStats.max}`,
        );

        // --- 2. Courbe de difficulté par palier -----------------------------------
        // Le tableau à lire pour trancher la question du ratio de croissance des budgets :
        // un camp qui gagne systématiquement au même palier signale un déséquilibre structurel
        // qu'aucun ajustement de prix de monstre ou de tour ne corrigera.
        console.log(`\n--- 2. Courbe par palier -------------------------------------------`);
        const curveWidths = [7, 7, 11, 11, 11, 10, 10];
        console.log(
          row(
            ['palier', 'runs', '%att réussie', '%déf tenue', 'budget att', '%att util', 'overkill déf'],
            curveWidths,
          ),
        );
        console.log('-'.repeat(curveWidths.reduce((a, b) => a + b + 2, 0)));
        const maxPalierSeen = Math.max(...attacks.map((phase) => phase.palier), 1);
        for (let palier = 1; palier <= maxPalierSeen; palier++) {
          const atPalier = attacks.filter((phase) => phase.palier === palier);
          if (atPalier.length === 0) {
            continue;
          }
          const defenseAtPalier = defenses.filter((phase) => phase.palier === palier + 1);
          const attackSuccess = atPalier.filter((phase) => phase.outcome === 'success').length;
          const defenseSuccess = defenseAtPalier.filter((phase) => phase.outcome === 'success').length;
          console.log(
            row(
              [
                String(palier),
                String(atPalier.length),
                pct(attackSuccess / atPalier.length),
                defenseAtPalier.length > 0 ? pct(defenseSuccess / defenseAtPalier.length) : '—',
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

        // --- 3. Usage du catalogue de monstres ------------------------------------
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
          '--- 3. Monstres (demande révélée par l\'IA d\'attaque) --------------',
          buyableMonsters,
          'unités',
          monsterCounts,
          monsterCosts,
          monsterPresence,
          attacks.length,
        );

        // --- 4. Usage du catalogue de tours ---------------------------------------
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
          '--- 4. Tours (demande révélée par l\'IA de défense) ----------------',
          TOWER_TYPES,
          'tours',
          towerCounts,
          towerCosts,
          towerPresence,
          defenses.length,
        );

        // --- 5. Routes ------------------------------------------------------------
        // `PATH_CELL_COST` est un levier global : il taxe la liberté de tracé de l'attaquant.
        // Sa part du budget d'attaque dit combien cette liberté coûte réellement en pratique.
        const laneStats = stats(attacks.map((phase) => phase.lanes));
        const cellStats = stats(attacks.map((phase) => phase.routeCells));
        const routeShareStats = stats(
          attacks.map((phase) => phase.routeCost / Math.max(1, phase.spent)),
        );
        console.log(`\n--- 5. Routes -----------------------------------------------------`);
        console.log(
          `voies par vague     : médiane ${laneStats.median} · moyenne ${laneStats.mean.toFixed(2)} · ` +
            `min ${laneStats.min} · max ${laneStats.max}  (plafond ${ATTACK_MAX_LANES})`,
        );
        console.log(
          `cases de route      : médiane ${cellStats.median} · moyenne ${cellStats.mean.toFixed(1)} · ` +
            `min ${cellStats.min} · max ${cellStats.max}`,
        );
        console.log(
          `part du budget att. : moyenne ${pct(routeShareStats.mean)} · ` +
            `min ${pct(routeShareStats.min)} · max ${pct(routeShareStats.max)}`,
        );

        // --- 6. Marges et tension -------------------------------------------------
        // Un camp qui n'épuise pas son budget signale que le budget n'est PAS la contrainte
        // active : le tuner en priorité serait un coup dans l'eau.
        const attackUseStats = stats(attacks.map((phase) => phase.spent / Math.max(1, phase.budget)));
        const defenseUseStats = stats(defenses.map((phase) => phase.spent / Math.max(1, phase.budget)));
        const overkillStats = stats(defenses.map((phase) => phase.overkill));
        const failedAttacks = attacks.filter((phase) => phase.outcome === 'failure');
        const breachStats = stats(failedAttacks.map((phase) => phase.breaches));
        const hpLeftStats = stats(failedAttacks.map((phase) => phase.chateauHpLeft));

        console.log(`\n--- 6. Marges et tension ------------------------------------------`);
        console.log(
          `budget attaque utilisé : moyenne ${pct(attackUseStats.mean)} · min ${pct(attackUseStats.min)}`,
        );
        console.log(
          `budget défense utilisé : moyenne ${pct(defenseUseStats.mean)} · min ${pct(defenseUseStats.min)}`,
        );
        console.log(
          `overkill défense (dégâts infligés / PV vague) : moyenne ${overkillStats.mean.toFixed(2)} · ` +
            `médiane ${overkillStats.median.toFixed(2)} · max ${overkillStats.max.toFixed(2)}`,
        );
        console.log(
          `sur ${failedAttacks.length} attaque(s) repoussée(s) : ` +
            `${breachStats.mean.toFixed(2)} brèche(s) en moyenne, ` +
            `château à ${hpLeftStats.mean.toFixed(2)}/${startingData.chateauHp} PV`,
        );
        console.log(
          `tours posées : moyenne ${stats(defenses.map((phase) => phase.towers)).mean.toFixed(1)} · ` +
            `monstres par vague : moyenne ${stats(attacks.map((phase) => phase.units)).mean.toFixed(1)}`,
        );

        // --- 7. Alertes -----------------------------------------------------------
        // Indicatif : n'échoue jamais le test, sert de checklist de lecture du rapport.
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
        if (attackWins === RUNS || defenseWins === RUNS) {
          alerts.push(
            `un camp gagne 100% des parties → régler le ratio de croissance des budgets AVANT les prix`,
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
        // Une vague sans aucune voie est un échec de la recherche génétique (temps de réflexion trop
        // court pour construire ne serait-ce qu'une route viable), pas un choix tactique : la phase
        // est perdue d'office et tire toutes les moyennes vers le bas. À traiter comme du bruit de
        // mesure, pas comme un signal d'équilibre.
        const emptyWaves = attacks.filter((phase) => phase.lanes === 0).length;
        if (emptyWaves > 0) {
          alerts.push(
            `${emptyWaves}/${attacks.length} vague(s) d'attaque vides (0 voie) → THINK_MS trop court, ` +
              `moyennes d'attaque faussées`,
          );
        }

        console.log(`\n--- 7. Alertes (indicatif) ----------------------------------------`);
        if (alerts.length === 0) {
          console.log('aucune');
        } else {
          for (const alert of alerts) {
            console.log(`  ⚠ ${alert}`);
          }
        }
        console.log(
          `\nRappel : ces chiffres mesurent l'équilibre FACE À DES IA À ${THINK_MS} ms/phase, ` +
            `pas face à un joueur.\nAvant toute décision de tarification, rejouer à ` +
            `THINK_MS plus élevé et vérifier que les conclusions tiennent.`,
        );
        console.log('='.repeat(78));

        expect(runs).toHaveLength(RUNS);
        expect(attacks.length).toBeGreaterThan(0);
      },
      30 * 60_000,
    );
  }
});
