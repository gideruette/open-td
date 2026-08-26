#!/usr/bin/env node
/**
 * Campagne d'équilibre IA vs IA parallèle.
 *
 * Chaque worker écrit son propre shard JSONL (pas de contention fichier), le parent fusionne
 * en CSV communs + rapport texte. Ne pas dépasser le nombre de cœurs libres : THINK_MS est un
 * budget mur, la contention CPU affaiblit les IA et fausse les mesures.
 *
 *   npm run balance -- --runs 100 --workers 8
 *   npm run balance -- --runs 20 --workers 4 --map clairiere-02 --think-ms 2000
 *
 * Prérequis : `dist/shared` et `dist/engine` à jour (`ng build shared && ng build engine`).
 * Le script `npm run balance` rebuild avant de lancer.
 */

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BALANCE_OPTIONS,
  deserializeRun,
  formatBalanceReport,
  playBalanceRun,
  serializeRun,
} from 'engine';
import { findMapCatalogEntry, findTowerType } from 'shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function parseCostList(raw) {
  return raw.split(',').map((part) => {
    const value = Number(part.trim());
    if (!Number.isFinite(value) || value < 1) {
      throw new Error(`Prix invalide dans la liste : "${part}"`);
    }
    return value;
  });
}

function parseArgs(argv) {
  const args = {
    runs: 100,
    workers: Math.min(8, cpus().length),
    map: 'clairiere-02',
    thinkMs: DEFAULT_BALANCE_OPTIONS.thinkMs,
    maxPaliers: DEFAULT_BALANCE_OPTIONS.maxPaliers,
    attackMaxLanes: DEFAULT_BALANCE_OPTIONS.attackMaxLanes,
    attackPopulation: DEFAULT_BALANCE_OPTIONS.attackPopulation,
    out: join(ROOT, 'artifacts', 'balance'),
    worker: null,
    workerRuns: null,
    archerCost: null,
    archerCosts: null,
    catapulteCost: null,
    catapulteCosts: null,
    defenseBudget: null,
    defenseBudgets: null,
    defenseGrowth: null,
    defenseGrowths: null,
    attackGrowth: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    const take = () => {
      i++;
      return next;
    };
    switch (flag) {
      case '--runs':
        args.runs = Number(take());
        break;
      case '--workers':
        args.workers = Number(take());
        break;
      case '--map':
        args.map = take();
        break;
      case '--think-ms':
        args.thinkMs = Number(take());
        break;
      case '--max-paliers':
        args.maxPaliers = Number(take());
        break;
      case '--attack-max-lanes':
        args.attackMaxLanes = Number(take());
        break;
      case '--attack-population':
        args.attackPopulation = Number(take());
        break;
      case '--out':
        args.out = resolve(take());
        break;
      case '--worker':
        args.worker = Number(take());
        break;
      case '--worker-runs':
        args.workerRuns = Number(take());
        break;
      case '--archer-cost':
        args.archerCost = Number(take());
        break;
      case '--archer-costs':
        args.archerCosts = parseCostList(take());
        break;
      case '--catapulte-cost':
        args.catapulteCost = Number(take());
        break;
      case '--catapulte-costs':
        args.catapulteCosts = parseCostList(take());
        break;
      case '--defense-budget':
        args.defenseBudget = Number(take());
        break;
      case '--defense-budgets':
        args.defenseBudgets = parseCostList(take());
        break;
      case '--defense-growth':
        args.defenseGrowth = Number(take());
        break;
      case '--defense-growths':
        args.defenseGrowths = parseCostList(take());
        break;
      case '--attack-growth':
        args.attackGrowth = Number(take());
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (flag.startsWith('-')) {
          throw new Error(`Option inconnue : ${flag}`);
        }
    }
  }
  return args;
}

function applyTowerCost(typeId, cost) {
  const tower = findTowerType(typeId);
  if (!tower) {
    throw new Error(`Type de tour "${typeId}" introuvable dans le catalogue`);
  }
  tower.cost = cost;
}

/**
 * Étage B du plan de ré-équilibrage : contrairement au prix d'une tour, le budget de défense de
 * départ n'est pas une propriété du catalogue mais de la carte (`startingData`) — même mécanisme
 * de mutation en place (partagée entre workers d'un même process, relue à chaque `playBalanceRun`)
 * que `applyTowerCost`, juste une cible différente.
 */
function applyDefenseBudget(mapId, budget) {
  const entry = findMapCatalogEntry(mapId);
  if (!entry) {
    throw new Error(`Carte "${mapId}" introuvable dans le catalogue`);
  }
  entry.startingData.startingDefenseBudget = budget;
}

/**
 * Suite de l'étage B : la dérive de risque observée après le palier 5 (budget=180) pointe vers le
 * RYTHME de croissance du budget défense plutôt que sa valeur de départ — `startingDefenseBudget`
 * fixe le palier 1, `budgetGrowth.defense` fixe si la défense garde le rythme ensuite.
 */
function applyDefenseGrowth(mapId, growth) {
  const entry = findMapCatalogEntry(mapId);
  if (!entry) {
    throw new Error(`Carte "${mapId}" introuvable dans le catalogue`);
  }
  entry.startingData.budgetGrowth.defense = growth;
}

/**
 * Contrôle de l'hypothèse « échelle vs pente » : réduire les deux croissances au même ratio
 * (~1.6) pour voir si la bascule tardive vient de l'écart proportionnel (auquel cas la réduire ne
 * change rien) ou de l'écart absolu accumulé palier après palier (auquel cas des incréments plus
 * petits repoussent la bascule plus loin, à ratio égal).
 */
function applyAttackGrowth(mapId, growth) {
  const entry = findMapCatalogEntry(mapId);
  if (!entry) {
    throw new Error(`Carte "${mapId}" introuvable dans le catalogue`);
  }
  entry.startingData.budgetGrowth.attack = growth;
}

/**
 * Applique les overrides économiques dans le process COURANT — nécessaire pour que l'en-tête de
 * `formatBalanceReport` (qui relit `findMapCatalogEntry(mapId).startingData` localement) reflète
 * le point réellement testé : les workers appliquent déjà ces mêmes overrides chacun dans son
 * propre process (`runWorker`), ce qui rend les PARTIES jouées correctes quel que soit l'appelant,
 * mais ne mute jamais l'état de l'orchestrateur, qui affichait donc encore les valeurs par défaut.
 */
function applyEconomyOverrides(mapId, overrides) {
  if (overrides.archerCost != null) {
    applyTowerCost('archer', overrides.archerCost);
  }
  if (overrides.catapulteCost != null) {
    applyTowerCost('catapulte', overrides.catapulteCost);
  }
  if (overrides.defenseBudget != null) {
    applyDefenseBudget(mapId, overrides.defenseBudget);
  }
  if (overrides.defenseGrowth != null) {
    applyDefenseGrowth(mapId, overrides.defenseGrowth);
  }
  if (overrides.attackGrowth != null) {
    applyAttackGrowth(mapId, overrides.attackGrowth);
  }
}

/**
 * Répartit les parties d'un balayage de prix : chaque worker reçoit un seul prix balayé
 * (évite de muter le catalogue en cours de route) et un quota de runs. Les overrides fixes
 * (ex. archer=24 pendant un sweep catapulte) sont reportés sur chaque assignment.
 */
function planTowerSweep(totalRuns, costs, workerCount, sweepField, fixedOverrides = {}) {
  if (totalRuns % costs.length !== 0) {
    throw new Error(
      `--runs (${totalRuns}) doit être divisible par le nombre de prix (${costs.length})`,
    );
  }
  const perCost = totalRuns / costs.length;
  const assignments = [];
  let workerId = 0;

  for (const cost of costs) {
    const slotWorkers = Math.max(1, Math.floor(workerCount / costs.length));
    const counts = splitRuns(perCost, slotWorkers);
    for (const n of counts) {
      assignments.push({ workerId, runs: n, ...fixedOverrides, [sweepField]: cost });
      workerId++;
    }
  }
  return assignments;
}

function median(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function towerBudgetShare(records, typeId) {
  let typed = 0;
  let total = 0;
  for (const record of records) {
    for (const phase of record.defenses) {
      for (const [id, cost] of Object.entries(phase.costByType)) {
        total += cost;
        if (id === typeId) {
          typed += cost;
        }
      }
    }
  }
  return total > 0 ? typed / total : 0;
}

function towerEntropy(records) {
  const costs = new Map();
  for (const record of records) {
    for (const phase of record.defenses) {
      for (const [typeId, cost] of Object.entries(phase.costByType)) {
        costs.set(typeId, (costs.get(typeId) ?? 0) + cost);
      }
    }
  }
  const slots = 4;
  const shares = [...costs.values()];
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
  // Types jamais achetés comptent dans slots (entropie normalisée comme le harnais).
  return entropy / Math.log(slots);
}

/** @param {'archer'|'catapulte'} sweepTower */
function formatSweepComparison(recordsByCost, sweepTower) {
  const short = sweepTower === 'catapulte' ? 'cata' : 'arch';
  const lines = [];
  lines.push('='.repeat(78));
  lines.push(`BALAYAGE PRIX ${sweepTower.toUpperCase()} — comparaison`);
  lines.push('='.repeat(78));
  const widths = [6, 5, 8, 8, 11, 11, 11, 14];
  const row = (cells) =>
    cells
      .map((cell, i) => {
        const text = String(cell);
        return i === 0 ? text.padEnd(widths[i]) : text.padStart(widths[i]);
      })
      .join('  ');
  lines.push(
    row(['prix', 'n', '%att', '%déf', 'pal.méd', `%bud.${short}`, '%bud.arch', 'ent.tours']),
  );
  lines.push('-'.repeat(widths.reduce((a, b) => a + b + 2, 0)));

  for (const [cost, records] of [...recordsByCost.entries()].sort((a, b) => a[0] - b[0])) {
    const n = records.length;
    const att = records.filter((r) => r.winner === 'attack').length;
    const def = records.filter((r) => r.winner === 'defense').length;
    const paliers = records.map((r) => r.palierAtEnd);
    lines.push(
      row([
        cost,
        n,
        `${((100 * att) / n).toFixed(0)}%`,
        `${((100 * def) / n).toFixed(0)}%`,
        median(paliers).toFixed(1),
        `${(100 * towerBudgetShare(records, sweepTower)).toFixed(1)}%`,
        `${(100 * towerBudgetShare(records, 'archer')).toFixed(1)}%`,
        towerEntropy(records).toFixed(3),
      ]),
    );
  }
  lines.push('');
  lines.push(
    `Lire : %bud.${short} = part du budget défense captée par ${sweepTower} ; ` +
      '%bud.arch = part archer ; ent.tours = entropie d\'usage normalisée (1 = diversifié).',
  );
  lines.push('='.repeat(78));
  return lines.join('\n');
}

/**
 * Étages B/B-suite du plan de ré-équilibrage : contrairement à `formatSweepComparison` (part de
 * budget captée par un type de tour), ce qui compte ici est le taux de tenue au palier 1 ET
 * l'issue de la partie complète (`%att`/`%déf`) — un balayage sur `startingDefenseBudget` bouge
 * surtout la première colonne, un balayage sur `budgetGrowth.defense` la laisse à peu près
 * constante (le palier 1 ne voit jamais la croissance) et bouge surtout `%att`/`%déf`/`pal.méd` :
 * la même table sert donc aux deux, seul le libellé de colonne et le titre changent.
 */
function formatEconomySweep(recordsByCost, { title, column }) {
  const lines = [];
  lines.push('='.repeat(78));
  lines.push(title);
  lines.push('='.repeat(78));
  const widths = [8, 5, 12, 8, 8, 9, 10, 11];
  const row = (cells) =>
    cells
      .map((cell, i) => {
        const text = String(cell);
        return i === 0 ? text.padEnd(widths[i]) : text.padStart(widths[i]);
      })
      .join('  ');
  lines.push(row([column, 'n', 'tenue pal.1', '%att', '%déf', 'pal.méd', 'tours pal.1', 'ent.tours']));
  lines.push('-'.repeat(widths.reduce((a, b) => a + b + 2, 0)));

  for (const [value, records] of [...recordsByCost.entries()].sort((a, b) => a[0] - b[0])) {
    const n = records.length;
    const att = records.filter((r) => r.winner === 'attack').length;
    const def = records.filter((r) => r.winner === 'defense').length;
    const paliers = records.map((r) => r.palierAtEnd);
    const firstDefenses = records.map((r) => r.defenses.find((d) => d.palier === 2)).filter(Boolean);
    const held = firstDefenses.filter((d) => d.outcome === 'success').length;
    const towersAtP1 = firstDefenses.map((d) => d.towers);
    lines.push(
      row([
        value,
        n,
        firstDefenses.length > 0 ? `${((100 * held) / firstDefenses.length).toFixed(0)}% (${held}/${firstDefenses.length})` : '—',
        `${((100 * att) / n).toFixed(0)}%`,
        `${((100 * def) / n).toFixed(0)}%`,
        median(paliers).toFixed(1),
        towersAtP1.length > 0 ? median(towersAtP1).toFixed(0) : '—',
        towerEntropy(records).toFixed(3),
      ]),
    );
  }
  lines.push('');
  lines.push(
    "Lire : tenue pal.1 = part des premières défenses sans le moindre dégât ; %att/%déf = issue de la " +
      'partie complète — un levier qui ne bouge que %att/%déf agit sur les paliers tardifs, pas le premier.',
  );
  lines.push('='.repeat(78));
  return lines.join('\n');
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

function csvRow(cells) {
  return cells.map(csvEscape).join(',');
}

function optionsFromArgs(args) {
  return {
    thinkMs: args.thinkMs,
    maxPaliers: args.maxPaliers,
    attackMaxLanes: args.attackMaxLanes,
    attackPopulation: args.attackPopulation,
  };
}

function splitRuns(total, workers) {
  const base = Math.floor(total / workers);
  const extra = total % workers;
  const counts = [];
  for (let i = 0; i < workers; i++) {
    const n = base + (i < extra ? 1 : 0);
    if (n > 0) {
      counts.push(n);
    }
  }
  return counts;
}

async function runWorker(args) {
  const workerId = args.worker;
  const runCount = args.workerRuns;
  const options = optionsFromArgs(args);
  const shardPath = join(args.out, `runs-w${workerId}.jsonl`);

  if (args.archerCost != null) {
    applyTowerCost('archer', args.archerCost);
  }
  if (args.catapulteCost != null) {
    applyTowerCost('catapulte', args.catapulteCost);
  }
  if (args.defenseBudget != null) {
    applyDefenseBudget(args.map, args.defenseBudget);
  }
  if (args.defenseGrowth != null) {
    applyDefenseGrowth(args.map, args.defenseGrowth);
  }
  if (args.attackGrowth != null) {
    applyAttackGrowth(args.map, args.attackGrowth);
  }

  writeFileSync(shardPath, '');

  for (let index = 0; index < runCount; index++) {
    const started = Date.now();
    const run = await playBalanceRun(args.map, options);
    const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
    const archerCost = args.archerCost ?? findTowerType('archer')?.cost ?? null;
    const catapulteCost = args.catapulteCost ?? findTowerType('catapulte')?.cost ?? null;
    const startingData = findMapCatalogEntry(args.map)?.startingData;
    const defenseBudget = args.defenseBudget ?? startingData?.startingDefenseBudget ?? null;
    const defenseGrowth = args.defenseGrowth ?? startingData?.budgetGrowth.defense ?? null;
    const record = {
      worker: workerId,
      run: index,
      mapId: args.map,
      archerCost,
      catapulteCost,
      defenseBudget,
      defenseGrowth,
      ...serializeRun(run),
    };
    appendFileSync(shardPath, `${JSON.stringify(record)}\n`);
    const tag = [
      archerCost != null ? `a=${archerCost}` : null,
      catapulteCost != null ? `c=${catapulteCost}` : null,
      args.defenseBudget != null ? `db=${defenseBudget}` : null,
      args.defenseGrowth != null ? `dg=${defenseGrowth}` : null,
    ]
      .filter(Boolean)
      .join(' ');
    console.error(
      `[w${workerId}${tag ? ` ${tag}` : ''}] ` +
        `run ${index + 1}/${runCount} : ${run.winner.toUpperCase()} ` +
        `palier ${run.palierAtEnd} (${elapsedSec}s)`,
    );
  }
}

function loadShards(outDir) {
  const files = readdirSync(outDir)
    .filter((name) => /^runs-w\d+\.jsonl$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));

  const records = [];
  for (const file of files) {
    const text = readFileSync(join(outDir, file), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      records.push(JSON.parse(line));
    }
  }
  return records;
}

function writeMergedCsv(outDir, records) {
  const runsPath = join(outDir, 'runs.csv');
  const attacksPath = join(outDir, 'attacks.csv');
  const defensesPath = join(outDir, 'defenses.csv');

  const runLines = [
    csvRow([
      'worker',
      'run',
      'mapId',
      'archerCost',
      'catapulteCost',
      'defenseBudget',
      'defenseGrowth',
      'winner',
      'palierAtEnd',
      'attackPhases',
      'defensePhases',
    ]),
  ];
  const attackLines = [
    csvRow([
      'worker',
      'run',
      'archerCost',
      'catapulteCost',
      'palier',
      'budget',
      'spent',
      'routeCost',
      'monsterCost',
      'lanes',
      'routeCells',
      'units',
      'outcome',
      'breaches',
      'chateauHpLeft',
      'ticks',
      'routeExposure',
      'unitsByType',
      'costByType',
    ]),
  ];
  const defenseLines = [
    csvRow([
      'worker',
      'run',
      'archerCost',
      'catapulteCost',
      'palier',
      'budget',
      'spent',
      'spentDelta',
      'towers',
      'rejected',
      'outcome',
      'chateauHpLeft',
      'overkill',
      'ticks',
      'attackerRoutingCost',
      'pathCellCount',
      'buildableCount',
      'terrainPressure',
      'incomingRouteExposure',
      'towersByType',
      'costByType',
    ]),
  ];

  for (const record of records) {
    runLines.push(
      csvRow([
        record.worker,
        record.run,
        record.mapId,
        record.archerCost,
        record.catapulteCost,
        record.defenseBudget,
        record.defenseGrowth,
        record.winner,
        record.palierAtEnd,
        record.attacks.length,
        record.defenses.length,
      ]),
    );
    for (const phase of record.attacks) {
      attackLines.push(
        csvRow([
          record.worker,
          record.run,
          record.archerCost,
          record.catapulteCost,
          phase.palier,
          phase.budget,
          phase.spent,
          phase.routeCost,
          phase.monsterCost,
          phase.lanes,
          phase.routeCells,
          phase.units,
          phase.outcome,
          phase.breaches,
          phase.chateauHpLeft,
          phase.ticks,
          phase.routeExposure ?? '',
          JSON.stringify(phase.unitsByType),
          JSON.stringify(phase.costByType),
        ]),
      );
    }
    for (const phase of record.defenses) {
      defenseLines.push(
        csvRow([
          record.worker,
          record.run,
          record.archerCost,
          record.catapulteCost,
          phase.palier,
          phase.budget,
          phase.spent,
          phase.spentDelta ?? '',
          phase.towers,
          phase.rejected,
          phase.outcome,
          phase.chateauHpLeft,
          phase.overkill,
          phase.ticks,
          phase.attackerRoutingCost ?? '',
          phase.pathCellCount ?? '',
          phase.buildableCount ?? '',
          phase.terrainPressure ?? '',
          phase.incomingRouteExposure ?? '',
          JSON.stringify(phase.towersByType),
          JSON.stringify(phase.costByType),
        ]),
      );
    }
  }

  writeFileSync(runsPath, `${runLines.join('\n')}\n`);
  writeFileSync(attacksPath, `${attackLines.join('\n')}\n`);
  writeFileSync(defensesPath, `${defenseLines.join('\n')}\n`);
  return { runsPath, attacksPath, defensesPath };
}

function spawnWorker(args, assignment) {
  // Chemins relatifs au cwd (ROOT) : sous Windows, `node --import C:\...` est rejeté
  // (scheme `c:`), il faut un chemin relatif ou une URL `file://`.
  const childArgs = [
    '--import',
    './scripts/register-workspace.mjs',
    './scripts/balance-campaign.mjs',
    '--worker',
    String(assignment.workerId),
    '--worker-runs',
    String(assignment.runs),
    '--map',
    args.map,
    '--think-ms',
    String(args.thinkMs),
    '--max-paliers',
    String(args.maxPaliers),
    '--attack-max-lanes',
    String(args.attackMaxLanes),
    '--attack-population',
    String(args.attackPopulation),
    '--out',
    args.out,
  ];
  if (args.attackGrowth != null) {
    childArgs.push('--attack-growth', String(args.attackGrowth));
  }
  if (assignment.archerCost != null) {
    childArgs.push('--archer-cost', String(assignment.archerCost));
  }
  if (assignment.catapulteCost != null) {
    childArgs.push('--catapulte-cost', String(assignment.catapulteCost));
  }
  if (assignment.defenseGrowth != null) {
    childArgs.push('--defense-growth', String(assignment.defenseGrowth));
  }
  if (assignment.defenseBudget != null) {
    childArgs.push('--defense-budget', String(assignment.defenseBudget));
  }

  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, childArgs, {
      cwd: ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env,
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(new Error(`Worker ${assignment.workerId} exit ${code}\n${stderr}`));
      }
    });
  });
}

function buildAssignments(args) {
  const sweepCount = [
    args.archerCosts?.length,
    args.catapulteCosts?.length,
    args.defenseBudgets?.length,
    args.defenseGrowths?.length,
  ].filter(Boolean).length;
  if (sweepCount > 1) {
    throw new Error(
      'Un seul balayage à la fois : --archer-costs, --catapulte-costs, --defense-budgets ou --defense-growths',
    );
  }
  const fixedOverrides = {
    archerCost: args.archerCost,
    catapulteCost: args.catapulteCost,
    defenseBudget: args.defenseBudget,
    defenseGrowth: args.defenseGrowth,
  };
  if (args.archerCosts?.length) {
    const { archerCost: _omit, ...rest } = fixedOverrides;
    return planTowerSweep(args.runs, args.archerCosts, args.workers, 'archerCost', rest);
  }
  if (args.catapulteCosts?.length) {
    const { catapulteCost: _omit, ...rest } = fixedOverrides;
    return planTowerSweep(args.runs, args.catapulteCosts, args.workers, 'catapulteCost', rest);
  }
  if (args.defenseBudgets?.length) {
    const { defenseBudget: _omit, ...rest } = fixedOverrides;
    return planTowerSweep(args.runs, args.defenseBudgets, args.workers, 'defenseBudget', rest);
  }
  if (args.defenseGrowths?.length) {
    const { defenseGrowth: _omit, ...rest } = fixedOverrides;
    return planTowerSweep(args.runs, args.defenseGrowths, args.workers, 'defenseGrowth', rest);
  }
  const counts = splitRuns(args.runs, args.workers);
  return counts.map((runs, workerId) => ({ workerId, runs, ...fixedOverrides }));
}

function sweepConfig(args) {
  if (args.catapulteCosts?.length) {
    return {
      tower: 'catapulte',
      costs: args.catapulteCosts,
      recordKey: 'catapulteCost',
    };
  }
  if (args.archerCosts?.length) {
    return {
      tower: 'archer',
      costs: args.archerCosts,
      recordKey: 'archerCost',
    };
  }
  if (args.defenseBudgets?.length) {
    return {
      tower: 'defenseBudget',
      costs: args.defenseBudgets,
      recordKey: 'defenseBudget',
    };
  }
  if (args.defenseGrowths?.length) {
    return {
      tower: 'defenseGrowth',
      costs: args.defenseGrowths,
      recordKey: 'defenseGrowth',
    };
  }
  return null;
}

async function runOrchestrator(args) {
  const cpuCount = cpus().length;
  const assignments = buildAssignments(args);
  const sweep = sweepConfig(args);
  if (assignments.length > cpuCount) {
    console.warn(
      `Attention : ${assignments.length} workers > ${cpuCount} cœurs logiques — ` +
        `THINK_MS dilué, mesures potentiellement faussées. Cap recommandé : ${cpuCount}.`,
    );
  }

  mkdirSync(args.out, { recursive: true });

  const meta = {
    startedAt: new Date().toISOString(),
    mapId: args.map,
    runs: args.runs,
    workers: assignments.length,
    archerCosts: args.archerCosts,
    archerCost: args.archerCost,
    catapulteCosts: args.catapulteCosts,
    catapulteCost: args.catapulteCost,
    defenseBudgets: args.defenseBudgets,
    defenseBudget: args.defenseBudget,
    defenseGrowths: args.defenseGrowths,
    defenseGrowth: args.defenseGrowth,
    options: optionsFromArgs(args),
    cpuCount,
    assignments: assignments.map((a) => ({
      workerId: a.workerId,
      archerCost: a.archerCost,
      catapulteCost: a.catapulteCost,
      defenseBudget: a.defenseBudget,
      defenseGrowth: a.defenseGrowth,
      runs: a.runs,
    })),
  };
  writeFileSync(join(args.out, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

  const costBits = [];
  if (args.archerCosts?.length) {
    costBits.push(`archer ∈ [${args.archerCosts.join(', ')}]`);
  } else if (args.archerCost != null) {
    costBits.push(`archer=${args.archerCost}`);
  }
  if (args.catapulteCosts?.length) {
    costBits.push(`catapulte ∈ [${args.catapulteCosts.join(', ')}]`);
  } else if (args.catapulteCost != null) {
    costBits.push(`catapulte=${args.catapulteCost}`);
  }
  if (args.defenseBudgets?.length) {
    costBits.push(`budget déf ∈ [${args.defenseBudgets.join(', ')}]`);
  } else if (args.defenseBudget != null) {
    costBits.push(`budget déf=${args.defenseBudget}`);
  }
  if (args.defenseGrowths?.length) {
    costBits.push(`croissance déf ∈ [${args.defenseGrowths.join(', ')}]`);
  } else if (args.defenseGrowth != null) {
    costBits.push(`croissance déf=${args.defenseGrowth}`);
  }
  if (args.attackGrowth != null) {
    costBits.push(`croissance att=${args.attackGrowth}`);
  }
  const costNote = costBits.length ? ` · ${costBits.join(' · ')}` : '';
  console.error(
    `Campagne équilibre : ${args.runs} parties · ${assignments.length} workers · ` +
      `carte "${args.map}" · think ${args.thinkMs} ms${costNote} → ${args.out}`,
  );

  const started = Date.now();
  await Promise.all(assignments.map((assignment) => spawnWorker(args, assignment)));
  const elapsedMs = Date.now() - started;

  const records = loadShards(args.out);
  if (records.length !== args.runs) {
    throw new Error(`Attendu ${args.runs} runs, trouvé ${records.length} dans les shards`);
  }

  const csvPaths = writeMergedCsv(args.out, records);

  const reportParts = [];
  if (sweep) {
    const byCost = new Map();
    for (const record of records) {
      const cost = record[sweep.recordKey];
      if (!byCost.has(cost)) {
        byCost.set(cost, []);
      }
      byCost.get(cost).push(record);
    }
    if (sweep.tower === 'defenseBudget') {
      reportParts.push(
        formatEconomySweep(byCost, { title: 'BALAYAGE BUDGET DÉFENSE — comparaison (étage B)', column: 'budget' }),
      );
    } else if (sweep.tower === 'defenseGrowth') {
      reportParts.push(
        formatEconomySweep(byCost, {
          title: 'BALAYAGE CROISSANCE BUDGET DÉFENSE — comparaison (étage B suite)',
          column: 'croissance',
        }),
      );
    } else {
      reportParts.push(formatSweepComparison(byCost, sweep.tower));
    }
    for (const cost of sweep.costs) {
      const group = byCost.get(cost) ?? [];
      const runs = group.map((record) =>
        deserializeRun({
          winner: record.winner,
          palierAtEnd: record.palierAtEnd,
          attacks: record.attacks,
          defenses: record.defenses,
        }),
      );
      applyEconomyOverrides(args.map, {
        archerCost: args.archerCost,
        catapulteCost: args.catapulteCost,
        defenseBudget: args.defenseBudget,
        defenseGrowth: args.defenseGrowth,
        attackGrowth: args.attackGrowth,
        [sweep.recordKey]: cost,
      });
      const fixed =
        sweep.tower === 'catapulte' && args.archerCost != null
          ? `archer=${args.archerCost} · `
          : sweep.tower === 'archer' && args.catapulteCost != null
            ? `catapulte=${args.catapulteCost} · `
            : '';
      reportParts.push('');
      reportParts.push(
        formatBalanceReport({
          mapId: args.map,
          runs,
          options: optionsFromArgs(args),
          parallelNote: `${fixed}${sweep.tower}=${cost} · ${assignments.length} workers`,
        }),
      );
    }
  } else {
    applyEconomyOverrides(args.map, {
      archerCost: args.archerCost,
      catapulteCost: args.catapulteCost,
      defenseBudget: args.defenseBudget,
      defenseGrowth: args.defenseGrowth,
      attackGrowth: args.attackGrowth,
    });
    const runs = records.map((record) =>
      deserializeRun({
        winner: record.winner,
        palierAtEnd: record.palierAtEnd,
        attacks: record.attacks,
        defenses: record.defenses,
      }),
    );
    reportParts.push(
      formatBalanceReport({
        mapId: args.map,
        runs,
        options: optionsFromArgs(args),
        parallelNote: `${assignments.length} workers`,
      }),
    );
  }

  const report = reportParts.join('\n');
  const reportPath = join(args.out, 'report.txt');
  writeFileSync(reportPath, `${report}\n`);
  console.log(`\n${report}`);
  console.error(
    `\nTerminé en ${(elapsedMs / 1000).toFixed(1)}s ` +
      `(${(elapsedMs / args.runs / 1000).toFixed(1)}s/partie wall effective).\n` +
      `CSV : ${csvPaths.runsPath}\n` +
      `     ${csvPaths.attacksPath}\n` +
      `     ${csvPaths.defensesPath}\n` +
      `Rapport : ${reportPath}`,
  );
}

function printHelp() {
  console.log(`Usage: npm run balance -- [options]

Options:
  --runs N                 Parties totales (défaut: 100)
  --workers N              Processus parallèles (défaut: min(8, cœurs))
  --map ID                 Carte catalogue (défaut: clairiere-02)
  --think-ms N             Budget réflexion IA / phase (défaut: 1000)
  --max-paliers N          Garde-fou paliers (défaut: 20)
  --attack-max-lanes N     Voies max attaque (défaut: 5)
  --attack-population N    Population GA attaque (défaut: 50)
  --archer-cost N          Force le prix de l'archer
  --archer-costs A,B,...   Balayage prix archer
  --catapulte-cost N       Force le prix de la catapulte
  --catapulte-costs A,B,... Balayage prix catapulte (ex. avec --archer-cost 24)
  --defense-budget N       Force le budget de défense de départ (startingDefenseBudget)
  --defense-budgets A,B,... Balayage budget défense (étage B du plan de ré-équilibrage)
  --defense-growth N       Force la croissance du budget défense (budgetGrowth.defense)
  --defense-growths A,B,... Balayage croissance budget défense (étage B suite)
  --attack-growth N        Force la croissance du budget attaque (budgetGrowth.attack)
  --out DIR                Dossier artefacts (défaut: artifacts/balance)

Chaque worker écrit runs-w{N}.jsonl ; le parent fusionne en runs/attacks/defenses.csv + report.txt.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (!Number.isFinite(args.runs) || args.runs < 1) {
    throw new Error('--runs doit être ≥ 1');
  }
  if (args.worker == null) {
    if (!Number.isFinite(args.workers) || args.workers < 1) {
      throw new Error('--workers doit être ≥ 1');
    }
  }
  if (args.archerCost != null && !Number.isFinite(args.archerCost)) {
    throw new Error('--archer-cost invalide');
  }
  if (args.catapulteCost != null && !Number.isFinite(args.catapulteCost)) {
    throw new Error('--catapulte-cost invalide');
  }
  if (args.archerCosts && args.archerCost != null) {
    throw new Error('Utiliser --archer-cost ou --archer-costs, pas les deux');
  }
  if (args.catapulteCosts && args.catapulteCost != null) {
    throw new Error('Utiliser --catapulte-cost ou --catapulte-costs, pas les deux');
  }
  if (args.defenseBudget != null && !Number.isFinite(args.defenseBudget)) {
    throw new Error('--defense-budget invalide');
  }
  if (args.defenseBudgets && args.defenseBudget != null) {
    throw new Error('Utiliser --defense-budget ou --defense-budgets, pas les deux');
  }
  if (args.defenseGrowth != null && !Number.isFinite(args.defenseGrowth)) {
    throw new Error('--defense-growth invalide');
  }
  if (args.defenseGrowths && args.defenseGrowth != null) {
    throw new Error('Utiliser --defense-growth ou --defense-growths, pas les deux');
  }
  if (args.attackGrowth != null && !Number.isFinite(args.attackGrowth)) {
    throw new Error('--attack-growth invalide');
  }
  if (
    [args.archerCosts?.length, args.catapulteCosts?.length, args.defenseBudgets?.length, args.defenseGrowths?.length].filter(
      Boolean,
    ).length > 1
  ) {
    throw new Error(
      'Un seul balayage à la fois : --archer-costs, --catapulte-costs, --defense-budgets ou --defense-growths',
    );
  }

  const sharedOk = existsSync(join(ROOT, 'dist/shared/fesm2022/shared.mjs'));
  const engineOk = existsSync(join(ROOT, 'dist/engine/fesm2022/engine.mjs'));
  if (!sharedOk || !engineOk) {
    throw new Error(
      'dist/shared et dist/engine introuvables. Lancer `ng build shared && ng build engine` ' +
        '(ou `npm run balance`, qui rebuild).',
    );
  }

  if (args.worker != null) {
    if (!Number.isFinite(args.workerRuns) || args.workerRuns < 1) {
      throw new Error('--worker-runs doit être ≥ 1');
    }
    await runWorker(args);
    return;
  }

  await runOrchestrator(args);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
