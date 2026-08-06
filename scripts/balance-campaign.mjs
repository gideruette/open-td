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
import { findTowerType } from 'shared';

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

function applyArcherCost(cost) {
  const archer = findTowerType('archer');
  if (!archer) {
    throw new Error('Type de tour "archer" introuvable dans le catalogue');
  }
  archer.cost = cost;
}

/**
 * Répartit les parties d'un balayage de prix : chaque worker reçoit un seul prix d'archer
 * (évite de muter le catalogue en cours de route) et un quota de runs.
 */
function planArcherSweep(totalRuns, costs, workerCount) {
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
      assignments.push({ workerId, archerCost: cost, runs: n });
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

function archerBudgetShare(records) {
  let archer = 0;
  let total = 0;
  for (const record of records) {
    for (const phase of record.defenses) {
      for (const [typeId, cost] of Object.entries(phase.costByType)) {
        total += cost;
        if (typeId === 'archer') {
          archer += cost;
        }
      }
    }
  }
  return total > 0 ? archer / total : 0;
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

function formatSweepComparison(recordsByCost) {
  const lines = [];
  lines.push('='.repeat(78));
  lines.push('BALAYAGE PRIX ARCHER — comparaison');
  lines.push('='.repeat(78));
  const widths = [6, 5, 8, 8, 11, 11, 14];
  const row = (cells) =>
    cells
      .map((cell, i) => {
        const text = String(cell);
        return i === 0 ? text.padEnd(widths[i]) : text.padStart(widths[i]);
      })
      .join('  ');
  lines.push(
    row(['prix', 'n', '%att', '%déf', 'pal.méd', '%bud.arch', 'ent.tours']),
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
        `${(100 * archerBudgetShare(records)).toFixed(1)}%`,
        towerEntropy(records).toFixed(3),
      ]),
    );
  }
  lines.push('');
  lines.push(
    'Lire : %bud.arch = part du budget défense captée par l\'archer ; ' +
      'ent.tours = entropie d\'usage normalisée du catalogue tours (1 = diversifié).',
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
    applyArcherCost(args.archerCost);
  }

  writeFileSync(shardPath, '');

  for (let index = 0; index < runCount; index++) {
    const started = Date.now();
    const run = await playBalanceRun(args.map, options);
    const elapsedSec = ((Date.now() - started) / 1000).toFixed(1);
    const record = {
      worker: workerId,
      run: index,
      mapId: args.map,
      archerCost: args.archerCost ?? findTowerType('archer')?.cost ?? null,
      ...serializeRun(run),
    };
    appendFileSync(shardPath, `${JSON.stringify(record)}\n`);
    console.error(
      `[w${workerId}${args.archerCost != null ? ` a=${args.archerCost}` : ''}] ` +
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
      'unitsByType',
      'costByType',
    ]),
  ];
  const defenseLines = [
    csvRow([
      'worker',
      'run',
      'archerCost',
      'palier',
      'budget',
      'spent',
      'towers',
      'rejected',
      'outcome',
      'chateauHpLeft',
      'overkill',
      'ticks',
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
          phase.palier,
          phase.budget,
          phase.spent,
          phase.towers,
          phase.rejected,
          phase.outcome,
          phase.chateauHpLeft,
          phase.overkill,
          phase.ticks,
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
  if (assignment.archerCost != null) {
    childArgs.push('--archer-cost', String(assignment.archerCost));
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
  if (args.archerCosts?.length) {
    return planArcherSweep(args.runs, args.archerCosts, args.workers);
  }
  const counts = splitRuns(args.runs, args.workers);
  return counts.map((runs, workerId) => ({
    workerId,
    runs,
    archerCost: args.archerCost,
  }));
}

async function runOrchestrator(args) {
  const cpuCount = cpus().length;
  const assignments = buildAssignments(args);
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
    options: optionsFromArgs(args),
    cpuCount,
    assignments: assignments.map((a) => ({
      workerId: a.workerId,
      archerCost: a.archerCost,
      runs: a.runs,
    })),
  };
  writeFileSync(join(args.out, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

  const costNote = args.archerCosts?.length
    ? ` · archer ∈ [${args.archerCosts.join(', ')}]`
    : args.archerCost != null
      ? ` · archer=${args.archerCost}`
      : '';
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
  if (args.archerCosts?.length) {
    const byCost = new Map();
    for (const record of records) {
      const cost = record.archerCost;
      if (!byCost.has(cost)) {
        byCost.set(cost, []);
      }
      byCost.get(cost).push(record);
    }
    reportParts.push(formatSweepComparison(byCost));
    for (const cost of args.archerCosts) {
      const group = byCost.get(cost) ?? [];
      const runs = group.map((record) =>
        deserializeRun({
          winner: record.winner,
          palierAtEnd: record.palierAtEnd,
          attacks: record.attacks,
          defenses: record.defenses,
        }),
      );
      reportParts.push('');
      reportParts.push(
        formatBalanceReport({
          mapId: args.map,
          runs,
          options: optionsFromArgs(args),
          parallelNote: `archer=${cost} · ${assignments.length} workers`,
        }),
      );
    }
  } else {
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
  --archer-cost N          Force le prix de l'archer pour toute la campagne
  --archer-costs A,B,...   Balayage : répartit --runs également entre ces prix
                           (ex. --runs 400 --archer-costs 20,24,28,32)
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
  if (args.archerCosts && args.archerCost != null) {
    throw new Error('Utiliser --archer-cost ou --archer-costs, pas les deux');
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
