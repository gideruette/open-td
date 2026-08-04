import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  type OnInit,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import type { DefenseOutcome, DefenseSimulation } from 'engine';
import { GameEngine, cellsBetween, isHeartCell, isSpawnCell, isValidPathStep } from 'engine';
import {
  BIOME_COLORS,
  MONSTER_TYPES,
  TOWER_TYPES,
  findMapCatalogEntry,
  findMonsterType,
  findTowerType,
  sellRefund,
} from 'shared';
import type { GameMap, GamePhase, GridCoord, MapBiomeColors, MapPath, TowerInstance, Wave, WaveUnit } from 'shared';

const CELL_SIZE = 32;
const TICK_INTERVAL_MS = 100;
const PROJECTILE_DURATION_MS = 120;
const SPRITE_IDS = ['archer', 'canon', 'glace', 'lance-pierres', 'goblin', 'orc', 'golem', 'heart'];
const DEFAULT_BIOME_COLORS: MapBiomeColors = BIOME_COLORS.foret;

/** Convertit une couleur hex (`#rrggbb`) en `rgba(...)` pour appliquer une transparence. */
function hexToRgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Part des cases intérieures (hors bord, cœur, spawns) semées d'un élément de décor. */
const DECOR_DENSITY = 0.05;

interface DecorItem {
  x: number;
  y: number;
  scale: number;
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
  }
  return hash;
}

/** Générateur pseudo-aléatoire déterministe (mulberry32) : même carte ⇒ même décor à chaque rendu. */
function seededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sème des éléments de décor sur les cases intérieures non spéciales (hors bord, cœur, spawns). */
function generateDecor(map: GameMap): DecorItem[] {
  const candidates: GridCoord[] = [];
  for (let y = 1; y < map.grid.rows - 1; y++) {
    for (let x = 1; x < map.grid.cols - 1; x++) {
      if (isHeartCell(map, { x, y }) || isSpawnCell(map, { x, y })) {
        continue;
      }
      candidates.push({ x, y });
    }
  }

  const random = seededRandom(hashString(map.id));
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const count = Math.round(candidates.length * DECOR_DENSITY);
  return candidates.slice(0, count).map((cell) => ({
    x: cell.x + 0.2 + random() * 0.6,
    y: cell.y + 0.2 + random() * 0.6,
    scale: 0.6 + random() * 0.7,
  }));
}

const FAILURE_MESSAGES: Record<string, string> = {
  'map-not-loaded': 'Carte non chargée.',
  'unknown-tower-type': 'Type de tour inconnu.',
  'out-of-bounds': 'Case hors grille.',
  'heart-cell': 'Impossible de construire sur le cœur.',
  'border-cell': 'Impossible de construire sur un bord de la grille.',
  occupied: 'Case déjà occupée par une tour.',
  'insufficient-budget': 'Budget insuffisant.',
  'wrong-phase': 'Impossible pendant cette phase.',
  'tower-not-found': 'Tour introuvable.',
};

interface MonsterView {
  position: GridCoord;
  hp: number;
  typeId: string;
}

interface ProjectileView {
  from: GridCoord;
  to: GridCoord;
  firedAtMs: number;
}

/**
 * Un monstre affecté à une voie en cours de composition, avec la tentative d'attaque durant
 * laquelle il a été ajouté : le retrait est gratuit tant que cette tentative est la tentative
 * courante, payant sinon (CONCEPTION.md §5.2).
 */
interface DraftUnit extends WaveUnit {
  addedAtAttempt: number;
}

/** Une voie en cours de composition côté attaquant : un chemin (préconçu ou tracé) + ses monstres. */
interface LaneDraft {
  path: MapPath;
  units: DraftUnit[];
}

/** Plateau de jeu : grille + phase Défense (placement/targeting) + phase Attaque (composition/tracé/chemins). */
@Component({
  selector: 'otd-game-board',
  imports: [],
  templateUrl: './game-board.html',
  styleUrl: './game-board.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameBoard implements OnInit {
  readonly mapId = input.required<string>();

  private readonly engine = new GameEngine();
  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('board');
  private readonly destroyRef = inject(DestroyRef);

  private activeTrial: DefenseSimulation | undefined;
  private pendingAttackWave: Wave | undefined;
  private trialTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly sprites = new Map<string, HTMLImageElement>();
  private readonly spriteVersion = signal(0);
  protected readonly biomeColors = signal<MapBiomeColors>(DEFAULT_BIOME_COLORS);
  protected readonly decor = signal<readonly DecorItem[]>([]);
  private projectiles: ProjectileView[] = [];
  private projectileAnimationHandle: number | undefined;
  private customLaneSequence = 0;

  protected readonly towerTypes = TOWER_TYPES;
  protected readonly monsterTypes = MONSTER_TYPES;

  protected readonly map = signal<GameMap | undefined>(undefined);
  protected readonly towers = signal<readonly TowerInstance[]>([]);
  protected readonly remainingBudget = signal(0);
  protected readonly defenseBudgetTotal = signal(0);
  protected readonly attackBudgetTotal = signal(0);
  protected readonly selectedTypeId = signal<string>(TOWER_TYPES[0].id);
  protected readonly selectedTowerId = signal<string | undefined>(undefined);
  /** Tour en cours de déplacement (case de destination attendue au prochain clic sur la grille). */
  protected readonly movingTowerId = signal<string | undefined>(undefined);
  protected readonly message = signal<string | undefined>(undefined);
  protected readonly hoverCell = signal<GridCoord | undefined>(undefined);

  protected readonly phase = signal<GamePhase>('defense');
  protected readonly palier = signal(1);
  protected readonly vagueCourante = signal<Wave | undefined>(undefined);
  protected readonly heartMaxHp = signal(0);

  protected readonly lanes = signal<LaneDraft[]>([]);
  protected readonly activeLaneIndex = signal<number | undefined>(undefined);
  /** Points déjà cliqués du tracé en cours ; `undefined` = pas en train de tracer. */
  protected readonly drawingPath = signal<GridCoord[] | undefined>(undefined);

  protected readonly trialHeartHp = signal<number | undefined>(undefined);
  protected readonly trialBreachCount = signal<number | undefined>(undefined);
  protected readonly trialMonsters = signal<readonly MonsterView[]>([]);
  protected readonly trialOutcome = signal<DefenseOutcome | undefined>(undefined);

  protected readonly selectedTower = computed(() =>
    this.towers().find((tower) => tower.id === this.selectedTowerId()),
  );
  protected readonly isTrialRunning = computed(() => this.trialOutcome() === 'pending');
  protected readonly isDrawingPath = computed(() => this.drawingPath() !== undefined);
  protected readonly isMovingTower = computed(() => this.movingTowerId() !== undefined);

  constructor() {
    this.preloadSprites();

    this.destroyRef.onDestroy(() => {
      if (this.trialTimer !== undefined) {
        clearTimeout(this.trialTimer);
      }
      if (this.projectileAnimationHandle !== undefined) {
        cancelAnimationFrame(this.projectileAnimationHandle);
      }
    });

    effect(() => {
      this.map();
      this.towers();
      this.selectedTowerId();
      this.movingTowerId();
      this.hoverCell();
      this.selectedTypeId();
      this.phase();
      this.lanes();
      this.activeLaneIndex();
      this.drawingPath();
      this.trialMonsters();
      this.trialHeartHp();
      this.spriteVersion();
      this.biomeColors();
      this.decor();
      this.draw();
    });
  }

  ngOnInit(): void {
    void this.bootstrap();
  }

  private preloadSprites(): void {
    for (const id of SPRITE_IDS) {
      const image = new Image();
      image.onload = () => this.spriteVersion.update((version) => version + 1);
      image.src = `assets/sprites/${id}.svg`;
      this.sprites.set(id, image);
    }
  }

  // ---- Phase Défense ---------------------------------------------------

  protected selectTowerType(typeId: string): void {
    if (this.isTrialRunning() || this.isMovingTower()) {
      return;
    }
    this.selectedTypeId.set(typeId);
    this.selectedTowerId.set(undefined);
    this.message.set(undefined);
  }

  protected sellSelected(): void {
    const towerId = this.selectedTowerId();
    if (!towerId || this.isTrialRunning() || this.isMovingTower()) {
      return;
    }
    const refund = this.engine.sellTower(towerId);
    if (refund === undefined) {
      return;
    }
    this.selectedTowerId.set(undefined);
    this.message.set(`Tour vendue (+${refund}).`);
    this.syncFromEngine();
  }

  /** Démarre le déplacement de la tour sélectionnée : le prochain clic sur une case libre la relocalise. */
  protected startMovingTower(): void {
    const towerId = this.selectedTowerId();
    if (!towerId || this.isTrialRunning()) {
      return;
    }
    this.movingTowerId.set(towerId);
    this.message.set('Cliquez une case libre pour déplacer la tour.');
  }

  protected cancelMovingTower(): void {
    this.movingTowerId.set(undefined);
    this.message.set(undefined);
  }

  /** Prix de revente : plein tarif si posée ce palier-ci, réduit si héritée d'un palier précédent. */
  protected refundFor(tower: TowerInstance): number {
    const type = findTowerType(tower.typeId);
    return type ? sellRefund(type.cost, tower.placedAtPalier === this.palier()) : 0;
  }

  protected describeWave(wave: Wave | undefined): string {
    if (!wave || wave.lanes.every((lane) => lane.units.length === 0)) {
      return '—';
    }
    return wave.lanes
      .map((lane, index) => {
        const counts = new Map<string, number>();
        for (const unit of lane.units) {
          counts.set(unit.type, (counts.get(unit.type) ?? 0) + 1);
        }
        const parts = Array.from(counts.entries()).map(
          ([type, count]) => `${findMonsterType(type)?.name ?? type} ×${count}`,
        );
        return `Chemin ${index + 1} (${lane.path.id}) : ${parts.join(', ') || 'vide'}`;
      })
      .join(' | ');
  }

  /** Lance vagueCourante contre la forteresse actuelle. */
  protected startTrial(): void {
    const wave = this.vagueCourante();
    if (!wave || this.isTrialRunning()) {
      return;
    }
    this.selectedTowerId.set(undefined);
    this.message.set(undefined);
    this.activeTrial = this.engine.startDefenseTrial();
    this.trialHeartHp.set(this.activeTrial.getHeartHp());
    this.trialMonsters.set([]);
    this.trialOutcome.set(this.activeTrial.getOutcome());
    this.scheduleTrialTick();
  }

  // ---- Phase Attaque : composition des voies ---------------------------

  /** Ajoute une nouvelle voie reprenant un chemin prédéfini de la carte. */
  protected addPresetLane(path: MapPath): void {
    if (this.phase() !== 'attack' || this.isTrialRunning() || this.isDrawingPath()) {
      return;
    }
    this.lanes.update((lanes) => [...lanes, { path: { id: path.id, nodes: [...path.nodes] }, units: [] }]);
    this.activeLaneIndex.set(this.lanes().length - 1);
    this.message.set(undefined);
  }

  /** Supprime un chemin prédéfini de la carte : il n'apparaîtra plus en Défense ni en Attaque. */
  protected removePresetPath(pathId: string): void {
    if (this.isTrialRunning()) {
      return;
    }
    this.engine.removePath(pathId);
    this.syncFromEngine();
  }

  /**
   * Démarre le tracé libre d'une nouvelle voie. Avec un seul spawn sur la carte (cas courant),
   * le tracé démarre directement dessus — pas besoin de viser précisément une case unique en
   * bord de grille. Avec plusieurs spawns, le prochain clic doit tomber sur l'un d'eux.
   */
  protected startTracing(): void {
    if (this.phase() !== 'attack' || this.isTrialRunning()) {
      return;
    }
    this.activeLaneIndex.set(undefined);
    const spawns = this.map()?.spawns ?? [];
    if (spawns.length === 1) {
      this.drawingPath.set([{ x: spawns[0].x, y: spawns[0].y }]);
      this.message.set('Cliquez des cases adjacentes jusqu’au cœur.');
      return;
    }
    this.drawingPath.set([]);
    this.message.set('Cliquez une case de spawn pour démarrer le tracé.');
  }

  protected cancelTracing(): void {
    this.drawingPath.set(undefined);
    this.message.set(undefined);
  }

  protected undoLastTracePoint(): void {
    this.drawingPath.update((path) => (path && path.length > 0 ? path.slice(0, -1) : path));
  }

  protected selectLane(index: number): void {
    if (this.isTrialRunning()) {
      return;
    }
    this.activeLaneIndex.set(index);
  }

  protected removeLane(index: number): void {
    if (this.isTrialRunning()) {
      return;
    }
    for (const unit of this.lanes()[index]?.units ?? []) {
      this.engine.recordAttackUnitRemoval(unit.type, unit.addedAtAttempt);
    }
    this.lanes.update((lanes) => lanes.filter((_, i) => i !== index));
    if (this.activeLaneIndex() === index) {
      this.activeLaneIndex.set(undefined);
    }
  }

  protected laneLabel(lane: LaneDraft, index: number): string {
    const isPreset = this.map()?.paths.some((path) => path.id === lane.path.id) ?? false;
    const kind = isPreset ? lane.path.id : `tracé, ${lane.path.nodes.length} cases`;
    return `Chemin ${index + 1} — ${kind}`;
  }

  protected appendMonster(typeId: string): void {
    const laneIndex = this.activeLaneIndex();
    if (this.phase() !== 'attack' || this.isTrialRunning() || laneIndex === undefined) {
      return;
    }
    const type = findMonsterType(typeId);
    if (!type || type.cost > this.getAttackBudgetRemaining()) {
      return;
    }
    const addedAtAttempt = this.engine.getAttackAttempt();
    this.lanes.update((lanes) =>
      lanes.map((lane, i) =>
        i === laneIndex ? { ...lane, units: [...lane.units, { type: typeId, addedAtAttempt }] } : lane,
      ),
    );
  }

  protected removeQueueUnit(laneIndex: number, unitIndex: number): void {
    if (this.isTrialRunning()) {
      return;
    }
    const unit = this.lanes()[laneIndex]?.units[unitIndex];
    if (unit) {
      this.engine.recordAttackUnitRemoval(unit.type, unit.addedAtAttempt);
    }
    this.lanes.update((lanes) =>
      lanes.map((lane, i) =>
        i === laneIndex ? { ...lane, units: lane.units.filter((_, ui) => ui !== unitIndex) } : lane,
      ),
    );
  }

  protected moveQueueUnit(laneIndex: number, unitIndex: number, direction: -1 | 1): void {
    if (this.isTrialRunning()) {
      return;
    }
    this.lanes.update((lanes) =>
      lanes.map((lane, i) => {
        if (i !== laneIndex) {
          return lane;
        }
        const target = unitIndex + direction;
        if (target < 0 || target >= lane.units.length) {
          return lane;
        }
        const nextUnits = [...lane.units];
        [nextUnits[unitIndex], nextUnits[target]] = [nextUnits[target], nextUnits[unitIndex]];
        return { ...lane, units: nextUnits };
      }),
    );
  }

  protected monsterName(typeId: string): string {
    return findMonsterType(typeId)?.name ?? typeId;
  }

  /** Convertit des voies en cours de composition en `Wave` propre (sans le bookkeeping de tentative). */
  private toWave(lanes: readonly LaneDraft[]): Wave {
    return {
      lanes: lanes.map((lane) => ({
        path: lane.path,
        units: lane.units.map((unit) => ({ type: unit.type })),
      })),
    };
  }

  protected getAttackBudgetRemaining(): number {
    return this.engine.getAttackBudgetRemaining(this.toWave(this.lanes()));
  }

  /** Lance la vague composée (toutes les voies non vides) contre la forteresse figée. */
  protected startAttack(): void {
    if (this.phase() !== 'attack' || this.isTrialRunning() || this.isDrawingPath()) {
      return;
    }
    const activeLanes = this.lanes().filter((lane) => lane.units.length > 0);
    if (activeLanes.length === 0) {
      return;
    }
    const wave = this.toWave(activeLanes);
    this.pendingAttackWave = wave;
    this.message.set(undefined);
    this.activeTrial = this.engine.startAttackTrial(wave);
    this.trialHeartHp.set(this.activeTrial.getHeartHp());
    this.trialBreachCount.set(this.activeTrial.getBreachCount());
    this.trialMonsters.set([]);
    this.trialOutcome.set(this.activeTrial.getOutcome());
    this.scheduleTrialTick();
  }

  // ---- Interaction canvas commune --------------------------------------

  protected onCanvasClick(event: MouseEvent): void {
    const coord = this.toGridCoord(event);
    if (!coord) {
      return;
    }

    if (this.phase() === 'attack' && this.isDrawingPath()) {
      this.handleTracingClick(coord);
      return;
    }

    if (this.phase() !== 'defense' || this.isTrialRunning()) {
      return;
    }

    const movingId = this.movingTowerId();
    if (movingId) {
      const moveResult = this.engine.moveTower(movingId, coord);
      if (!moveResult.ok) {
        this.message.set(FAILURE_MESSAGES[moveResult.reason] ?? 'Déplacement impossible.');
        return;
      }
      this.movingTowerId.set(undefined);
      this.message.set(undefined);
      this.syncFromEngine();
      this.selectedTowerId.set(movingId);
      return;
    }

    const existing = this.towers().find(
      (tower) => tower.position.x === coord.x && tower.position.y === coord.y,
    );
    if (existing) {
      this.selectedTowerId.set(existing.id);
      this.message.set(undefined);
      return;
    }

    const result = this.engine.placeTower(this.selectedTypeId(), coord);
    if (!result.ok) {
      this.selectedTowerId.set(undefined);
      this.message.set(FAILURE_MESSAGES[result.reason] ?? 'Placement impossible.');
      return;
    }
    this.message.set(undefined);
    this.syncFromEngine();
    const placed = this.towers().find(
      (tower) => tower.position.x === coord.x && tower.position.y === coord.y,
    );
    this.selectedTowerId.set(placed?.id);
  }

  private handleTracingClick(coord: GridCoord): void {
    const map = this.map();
    const path = this.drawingPath();
    if (!map || !path) {
      return;
    }

    if (path.length === 0) {
      if (!isSpawnCell(map, coord)) {
        this.message.set('Le tracé doit démarrer sur une case de spawn.');
        return;
      }
      this.drawingPath.set([coord]);
      this.message.set('Cliquez des cases adjacentes jusqu’au cœur.');
      return;
    }

    const last = path[path.length - 1];
    if (last.x === coord.x && last.y === coord.y) {
      return;
    }

    // Case non adjacente : on comble automatiquement les cases traversées (CONCEPTION.md §5.3).
    const steps = cellsBetween(last, coord);
    const filledCells: GridCoord[] = [];
    let cursor = last;
    let reachedHeart = false;
    for (const step of steps) {
      if (!isValidPathStep(map, this.towers(), cursor, step)) {
        this.message.set('Case invalide : doit être dans la grille et libre de tour.');
        return;
      }
      filledCells.push(step);
      cursor = step;
      if (isHeartCell(map, step)) {
        reachedHeart = true;
        break;
      }
    }

    const nextPath = [...path, ...filledCells];
    if (reachedHeart) {
      const newLane: LaneDraft = {
        path: { id: `custom-${this.customLaneSequence++}`, nodes: nextPath.map((p) => [p.x, p.y]) },
        units: [],
      };
      this.engine.addPath(newLane.path);
      this.lanes.update((lanes) => [...lanes, newLane]);
      this.activeLaneIndex.set(this.lanes().length - 1);
      this.drawingPath.set(undefined);
      this.message.set(undefined);
      this.syncFromEngine();
      return;
    }
    this.drawingPath.set(nextPath);
  }

  protected onCanvasMove(event: MouseEvent): void {
    this.hoverCell.set(this.toGridCoord(event));
  }

  protected onCanvasLeave(): void {
    this.hoverCell.set(undefined);
  }

  // ---- Simulation commune (Défense et Attaque) -------------------------

  private scheduleTrialTick(): void {
    this.trialTimer = setTimeout(() => this.advanceTrial(), TICK_INTERVAL_MS);
  }

  private advanceTrial(): void {
    const trial = this.activeTrial;
    if (!trial) {
      return;
    }
    const running = trial.step();
    this.trialHeartHp.set(trial.getHeartHp());
    this.trialBreachCount.set(trial.getBreachCount());
    this.trialMonsters.set(
      trial.getMonsters().map((monster) => ({
        position: trial.getMonsterPosition(monster),
        hp: monster.hp,
        typeId: monster.typeId,
      })),
    );
    this.trialOutcome.set(trial.getOutcome());

    const firedAtMs = performance.now();
    const shots = trial.getShotsThisTick();
    if (shots.length > 0) {
      this.projectiles.push(
        ...shots.map((shot) => ({ from: shot.towerPosition, to: shot.targetPosition, firedAtMs })),
      );
      this.ensureProjectileAnimationRunning();
    }

    if (running) {
      this.scheduleTrialTick();
      return;
    }
    this.concludeTrial(trial);
  }

  private concludeTrial(trial: DefenseSimulation): void {
    const outcome = trial.getOutcome();

    if (this.phase() === 'defense') {
      if (outcome === 'success') {
        this.engine.resolveDefenseSuccess();
        this.message.set('Défense réussie ! La forteresse est figée : phase Attaque.');
        this.resetTrialDisplay();
      } else {
        this.message.set('Défense échouée — le cœur est tombé. Ajustez vos tours et réessayez.');
      }
    } else {
      if (outcome === 'success') {
        const wave = this.pendingAttackWave;
        if (wave) {
          this.engine.resolveAttackSuccess(wave);
        }
        // Le plan d'attaque n'est pas remis à zéro : il reste le point de départ du prochain
        // cycle. Ses affectations, déjà éprouvées par une attaque réussie, sont marquées
        // comme établies (retrait payant) — CONCEPTION.md §5.2.
        this.lanes.update((lanes) =>
          lanes.map((lane) => ({ ...lane, units: lane.units.map((unit) => ({ ...unit, addedAtAttempt: 0 })) })),
        );
        this.activeLaneIndex.set(undefined);
        this.message.set(
          `Vague victorieuse (${trial.getBreachCount()} brèche(s)) ! Palier ${this.engine.getPalier()} — retour en Défense.`,
        );
        this.resetTrialDisplay();
      } else {
        this.engine.recordFailedAttackAttempt();
        this.message.set('Vague anéantie, aucune brèche. Recomposez et réessayez.');
      }
    }
    this.pendingAttackWave = undefined;
    this.syncFromEngine();
  }

  private resetTrialDisplay(): void {
    this.trialOutcome.set(undefined);
    this.trialMonsters.set([]);
    this.trialHeartHp.set(undefined);
    this.trialBreachCount.set(undefined);
  }

  /** Anime les projectiles en cours (indépendamment des ticks) jusqu'à ce qu'ils s'estompent. */
  private ensureProjectileAnimationRunning(): void {
    if (this.projectileAnimationHandle !== undefined) {
      return;
    }
    const step = () => {
      const now = performance.now();
      this.projectiles = this.projectiles.filter((projectile) => now - projectile.firedAtMs < PROJECTILE_DURATION_MS);
      this.draw();
      this.projectileAnimationHandle =
        this.projectiles.length > 0 ? requestAnimationFrame(step) : undefined;
    };
    this.projectileAnimationHandle = requestAnimationFrame(step);
  }

  private async bootstrap(): Promise<void> {
    const mapId = this.mapId();
    const catalogEntry = findMapCatalogEntry(mapId);
    if (!catalogEntry) {
      this.message.set('Carte inconnue.');
      return;
    }
    this.biomeColors.set(BIOME_COLORS[catalogEntry.biome]);
    try {
      const map = await fetch(`maps/${mapId}.map.json`).then((response) => response.json() as Promise<GameMap>);
      this.decor.set(generateDecor(map));
      this.engine.startRun(map, catalogEntry.startingData);
      this.syncFromEngine();
    } catch {
      this.message.set('Impossible de charger la carte.');
    }
  }

  private toGridCoord(event: MouseEvent): GridCoord | undefined {
    const map = this.map();
    const canvas = this.canvasRef()?.nativeElement;
    if (!map || !canvas) {
      return undefined;
    }
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.floor(((event.clientX - rect.left) * scaleX) / CELL_SIZE);
    const y = Math.floor(((event.clientY - rect.top) * scaleY) / CELL_SIZE);
    if (x < 0 || y < 0 || x >= map.grid.cols || y >= map.grid.rows) {
      return undefined;
    }
    return { x, y };
  }

  private syncFromEngine(): void {
    this.map.set(this.engine.getMap());
    this.towers.set(this.engine.getTowers());
    this.remainingBudget.set(this.engine.getRemainingBudget());
    this.defenseBudgetTotal.set(this.engine.getDefenseBudget());
    this.attackBudgetTotal.set(this.engine.getAttackBudget());
    this.heartMaxHp.set(this.engine.getHeartMaxHp());
    this.phase.set(this.engine.getPhase());
    this.palier.set(this.engine.getPalier());
    this.vagueCourante.set(this.engine.getVagueCourante());
  }

  private draw(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const map = this.map();
    if (!canvas || !map) {
      return;
    }
    const width = map.grid.cols * CELL_SIZE;
    const height = map.grid.rows * CELL_SIZE;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const biome = this.biomeColors();
    ctx.fillStyle = biome.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.drawDecor(ctx, biome.decor);

    // Bords de la grille : jamais constructibles (CONCEPTION.md §4).
    ctx.fillStyle = '#1c2230';
    for (let x = 0; x < map.grid.cols; x++) {
      ctx.fillRect(x * CELL_SIZE, 0, CELL_SIZE, CELL_SIZE);
      ctx.fillRect(x * CELL_SIZE, (map.grid.rows - 1) * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    }
    for (let y = 0; y < map.grid.rows; y++) {
      ctx.fillRect(0, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
      ctx.fillRect((map.grid.cols - 1) * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    }

    ctx.strokeStyle = '#2a2f3a';
    ctx.lineWidth = 1;
    for (let x = 0; x <= map.grid.cols; x++) {
      ctx.beginPath();
      ctx.moveTo(x * CELL_SIZE, 0);
      ctx.lineTo(x * CELL_SIZE, map.grid.rows * CELL_SIZE);
      ctx.stroke();
    }
    for (let y = 0; y <= map.grid.rows; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * CELL_SIZE);
      ctx.lineTo(map.grid.cols * CELL_SIZE, y * CELL_SIZE);
      ctx.stroke();
    }

    const isAttackPhase = this.phase() === 'attack';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Chemins prédéfinis de la carte : couleur pleine en défense, simple référence estompée en attaque.
    for (const path of map.paths) {
      ctx.strokeStyle = isAttackPhase ? hexToRgba(biome.path, 0.25) : biome.path;
      ctx.lineWidth = CELL_SIZE * 0.4;
      this.strokePolyline(ctx, path.nodes.map(([x, y]) => ({ x, y })));
    }

    // Voies composées par l'attaquant : la voie active en surbrillance, les autres atténuées.
    this.lanes().forEach((lane, index) => {
      const isActive = index === this.activeLaneIndex();
      ctx.strokeStyle = isActive ? '#ffe08c' : 'rgba(255, 224, 140, 0.55)';
      ctx.lineWidth = CELL_SIZE * 0.32;
      this.strokePolyline(ctx, lane.path.nodes.map(([x, y]) => ({ x, y })));
    });

    // Tracé en cours : ligne pointillée vive + un point à chaque case cliquée.
    const drawing = this.drawingPath();
    if (drawing && drawing.length > 0) {
      ctx.strokeStyle = '#7be0ff';
      ctx.lineWidth = CELL_SIZE * 0.28;
      ctx.setLineDash([8, 6]);
      this.strokePolyline(ctx, drawing);
      ctx.setLineDash([]);

      ctx.fillStyle = '#7be0ff';
      for (const point of drawing) {
        ctx.beginPath();
        ctx.arc(point.x * CELL_SIZE + CELL_SIZE / 2, point.y * CELL_SIZE + CELL_SIZE / 2, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const awaitingSpawnClick = this.isDrawingPath() && this.drawingPath()?.length === 0;
    for (const spawn of map.spawns) {
      if (awaitingSpawnClick) {
        this.drawRangeRing(ctx, spawn.x, spawn.y, 0.85, '#7be0ff');
      }
      ctx.fillStyle = '#7a5c2e';
      ctx.fillRect(spawn.x * CELL_SIZE + 4, spawn.y * CELL_SIZE + 4, CELL_SIZE - 8, CELL_SIZE - 8);
    }

    const heartCx = map.heart.x * CELL_SIZE + CELL_SIZE / 2;
    const heartCy = map.heart.y * CELL_SIZE + CELL_SIZE / 2;
    if (!this.drawSprite(ctx, 'heart', heartCx, heartCy, CELL_SIZE * 0.9)) {
      ctx.fillStyle = '#c0392b';
      ctx.beginPath();
      ctx.arc(heartCx, heartCy, CELL_SIZE / 2 - 4, 0, Math.PI * 2);
      ctx.fill();
    }

    const hover = this.hoverCell();
    if (hover && !this.selectedTowerId() && !this.isTrialRunning() && this.phase() === 'defense') {
      const type = findTowerType(this.selectedTypeId());
      if (type) {
        this.drawRangeRing(ctx, hover.x, hover.y, type.range, 'rgba(120, 200, 255, 0.5)');
      }
    }

    for (const tower of this.towers()) {
      const isSelected = tower.id === this.selectedTowerId();
      const type = findTowerType(tower.typeId);
      const cx = tower.position.x * CELL_SIZE + CELL_SIZE / 2;
      const cy = tower.position.y * CELL_SIZE + CELL_SIZE / 2;

      if (isSelected && type) {
        this.drawRangeRing(ctx, tower.position.x, tower.position.y, type.range, 'rgba(120, 200, 255, 0.8)');
      }

      if (!this.drawSprite(ctx, tower.typeId, cx, cy, CELL_SIZE * 0.85)) {
        ctx.fillStyle = isSelected ? '#5fb0ff' : '#8fd0ff';
        ctx.beginPath();
        ctx.arc(cx, cy, CELL_SIZE / 2 - 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#0b0d12';
        ctx.font = `${CELL_SIZE * 0.4}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((type?.name ?? '?').charAt(0).toUpperCase(), cx, cy);
      }

      if (isSelected) {
        ctx.strokeStyle = '#5fb0ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, CELL_SIZE / 2 - 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    for (const monster of this.trialMonsters()) {
      const cx = monster.position.x * CELL_SIZE + CELL_SIZE / 2;
      const cy = monster.position.y * CELL_SIZE + CELL_SIZE / 2;
      const maxHp = findMonsterType(monster.typeId)?.hp ?? monster.hp;
      const hpRatio = maxHp > 0 ? Math.max(0, monster.hp / maxHp) : 0;
      const radius = CELL_SIZE * 0.22;

      if (!this.drawSprite(ctx, monster.typeId, cx, cy, CELL_SIZE * 0.55)) {
        ctx.fillStyle = '#e0524a';
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      const barWidth = CELL_SIZE * 0.6;
      const barX = cx - barWidth / 2;
      const barY = cy - radius - 6;
      ctx.fillStyle = '#3a1414';
      ctx.fillRect(barX, barY, barWidth, 3);
      ctx.fillStyle = '#7be07a';
      ctx.fillRect(barX, barY, barWidth * hpRatio, 3);
    }

    const now = performance.now();
    for (const projectile of this.projectiles) {
      const t = Math.min(1, (now - projectile.firedAtMs) / PROJECTILE_DURATION_MS);
      const alpha = 1 - t;
      const fromX = projectile.from.x * CELL_SIZE + CELL_SIZE / 2;
      const fromY = projectile.from.y * CELL_SIZE + CELL_SIZE / 2;
      const toX = projectile.to.x * CELL_SIZE + CELL_SIZE / 2;
      const toY = projectile.to.y * CELL_SIZE + CELL_SIZE / 2;
      const bx = fromX + (toX - fromX) * t;
      const by = fromY + (toY - fromY) * t;

      ctx.strokeStyle = `rgba(255, 224, 140, ${alpha * 0.6})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(fromX, fromY);
      ctx.lineTo(bx, by);
      ctx.stroke();

      ctx.fillStyle = `rgba(255, 224, 140, ${alpha})`;
      ctx.beginPath();
      ctx.arc(bx, by, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Dessine le décor de fond (touffes de végétation, roches…) : purement cosmétique, sous les chemins et le reste. */
  private drawDecor(ctx: CanvasRenderingContext2D, color: string): void {
    ctx.fillStyle = color;
    for (const item of this.decor()) {
      const cx = item.x * CELL_SIZE;
      const cy = item.y * CELL_SIZE;
      const r = CELL_SIZE * 0.16 * item.scale;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.arc(cx + r * 0.7, cy + r * 0.25, r * 0.7, 0, Math.PI * 2);
      ctx.arc(cx - r * 0.6, cy + r * 0.35, r * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private strokePolyline(ctx: CanvasRenderingContext2D, points: readonly GridCoord[]): void {
    if (points.length === 0) {
      return;
    }
    ctx.beginPath();
    points.forEach((point, index) => {
      const px = point.x * CELL_SIZE + CELL_SIZE / 2;
      const py = point.y * CELL_SIZE + CELL_SIZE / 2;
      if (index === 0) {
        ctx.moveTo(px, py);
      } else {
        ctx.lineTo(px, py);
      }
    });
    ctx.stroke();
  }

  /** Dessine le sprite `id` centré sur (cx, cy). Retourne false si l'image n'est pas encore prête. */
  private drawSprite(ctx: CanvasRenderingContext2D, id: string, cx: number, cy: number, size: number): boolean {
    const image = this.sprites.get(id);
    if (!image || !image.complete || image.naturalWidth === 0) {
      return false;
    }
    ctx.drawImage(image, cx - size / 2, cy - size / 2, size, size);
    return true;
  }

  private drawRangeRing(
    ctx: CanvasRenderingContext2D,
    cellX: number,
    cellY: number,
    range: number,
    color: string,
  ): void {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(
      cellX * CELL_SIZE + CELL_SIZE / 2,
      cellY * CELL_SIZE + CELL_SIZE / 2,
      range * CELL_SIZE,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  }
}
