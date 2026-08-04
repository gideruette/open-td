import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  type OnInit,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import type { DefenseOutcome, DefenseSimulation } from 'engine';
import {
  GameEngine,
  canPlaceTower,
  cellsBetween,
  expandPathCells,
  isBorderCell,
  isChateauCell,
  isSpawnCell,
  isValidPathStep,
} from 'engine';
import {
  BIOME_COLORS,
  findMapCatalogEntry,
  findMonsterType,
  findTowerType,
  hexCorners,
  hexGridPixelSize,
  hexToWorld,
  worldToHex,
} from 'shared';
import type {
  GameMap,
  GamePhase,
  GridCoord,
  MapBiomeColors,
  MapPath,
  TowerInstance,
  Wave,
  WaveUnit,
} from 'shared';
import { Tooltip, type TooltipStat } from '../ui/tooltip/tooltip';
import { formatMonsterStats, formatTowerStats, laneDisplayLabel } from './board-format';
import { BoardHud } from './board-hud/board-hud';
import { BoardSheet } from './board-sheet/board-sheet';
import { BoardStatus } from './board-status/board-status';
import type { BoardTool, LaneDraft } from './board-types';
import { LanesPanel } from './lanes-panel/lanes-panel';
import { TowerActions } from './tower-actions/tower-actions';

/** Rayon extérieur d'un hex (centre → sommet), en pixels. */
const CELL_SIZE = 32;
/** Marge autour de la grille pour que les hex ne collent pas au cadre. */
const CANVAS_PAD = Math.round(CELL_SIZE * 0.4);
/** Pixels par unité world (distance entre centres de voisins = 1). */
const WORLD_SCALE = CELL_SIZE * Math.sqrt(3);
/** Décalage pour que le hex (0,0) tienne entièrement dans le canvas (+ marge). */
const ORIGIN_X = (Math.sqrt(3) / 2) * CELL_SIZE + CANVAS_PAD;
const ORIGIN_Y = CELL_SIZE + CANVAS_PAD;
const TICK_INTERVAL_MS = 100;
const PROJECTILE_DURATION_MS = 120;
const SPLASH_DURATION_MS = 220;
/** Zoom minimal (légèrement sous le fit pour pouvoir dézoomer). */
const VIEW_ZOOM_MIN = 0.75;
const VIEW_ZOOM_MAX = 3.5;
/** Déplacement souris/toucher avant de considérer un drag comme un pan (pas un clic). */
const PAN_DRAG_THRESHOLD_PX = 10;
/** Marge de pan autorisée hors cadre (sinon ×1 = pan impossible = conflit avec la pose). */
const PAN_EDGE_MARGIN_PX = 64;
const SPRITE_IDS = ['archer', 'canon', 'glace', 'catapulte', 'goblin', 'orc', 'golem', 'chateau'];
const DEFAULT_BIOME_COLORS: MapBiomeColors = BIOME_COLORS.foret;

function cellCenterPx(coord: GridCoord): GridCoord {
  const center = hexToWorld(coord, CELL_SIZE);
  return { x: center.x + ORIGIN_X, y: center.y + ORIGIN_Y };
}

function worldToPx(world: GridCoord): GridCoord {
  return { x: world.x * WORLD_SCALE + ORIGIN_X, y: world.y * WORLD_SCALE + ORIGIN_Y };
}

function hexCornersPx(coord: GridCoord): GridCoord[] {
  return hexCorners(coord, CELL_SIZE).map((corner) => ({
    x: corner.x + ORIGIN_X,
    y: corner.y + ORIGIN_Y,
  }));
}

/** Convertit une couleur hex (`#rrggbb`) en `rgba(...)` pour appliquer une transparence. */
function hexToRgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Part des cases intérieures (hors bord, château, spawns) semées d'un élément de décor. */
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

/** Sème des éléments de décor sur les cases intérieures non spéciales (hors bord, château, spawns). */
function generateDecor(map: GameMap): DecorItem[] {
  const candidates: GridCoord[] = [];
  for (let y = 1; y < map.grid.rows - 1; y++) {
    for (let x = 1; x < map.grid.cols - 1; x++) {
      if (isChateauCell(map, { x, y }) || isSpawnCell(map, { x, y })) {
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
  return candidates.slice(0, count).map((cell) => {
    const center = cellCenterPx(cell);
    return {
      x: center.x + (random() - 0.5) * CELL_SIZE * 0.5,
      y: center.y + (random() - 0.5) * CELL_SIZE * 0.5,
      scale: 0.6 + random() * 0.7,
    };
  });
}

const FAILURE_MESSAGES: Record<string, string> = {
  'map-not-loaded': 'Carte non chargée.',
  'unknown-tower-type': 'Type de tour inconnu.',
  'out-of-bounds': 'Case hors grille.',
  'chateau-cell': 'Impossible de construire sur le château.',
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

/** Infobulle positionnée au survol d'une tour posée ou d'un monstre, en pixels relatifs au canvas. */
interface BoardTooltip {
  left: number;
  top: number;
  heading: string;
  description: string;
  stats: TooltipStat[];
}

interface ProjectileView {
  /** Position pixel sur le canvas (déjà convertie). */
  from: GridCoord;
  to: GridCoord;
  firedAtMs: number;
}

/** Explosion de zone à l'impact d'un tir à dégâts de zone (ex. Canon), affichée le temps de sa vie. */
interface SplashView {
  /** Position pixel sur le canvas (déjà convertie). */
  position: GridCoord;
  /** Rayon en pixels. */
  radiusPx: number;
  firedAtMs: number;
}

/** Plateau de jeu : grille + phase Défense (placement/targeting) + phase Attaque (composition/tracé/chemins). */
@Component({
  selector: 'otd-game-board',
  imports: [BoardHud, BoardSheet, BoardStatus, LanesPanel, Tooltip, TowerActions],
  templateUrl: './game-board.html',
  styleUrl: './game-board.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameBoard implements OnInit {
  readonly mapId = input.required<string>();

  private readonly engine = new GameEngine();
  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('board');
  private readonly viewportRef = viewChild<ElementRef<HTMLElement>>('viewport');
  private readonly destroyRef = inject(DestroyRef);

  private activeTrial: DefenseSimulation | undefined;
  private pendingAttackWave: Wave | undefined;
  private trialTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly sprites = new Map<string, HTMLImageElement>();
  private readonly spriteVersion = signal(0);
  protected readonly biomeColors = signal<MapBiomeColors>(DEFAULT_BIOME_COLORS);
  protected readonly decor = signal<readonly DecorItem[]>([]);
  private projectiles: ProjectileView[] = [];
  private splashes: SplashView[] = [];
  private projectileAnimationHandle: number | undefined;
  private customLaneSequence = 0;
  /** Voie en cours de retracé : unités / chemin conservés jusqu'à validation du nouveau tracé. */
  private retracing:
    | { index: number; units: WaveUnit[]; path: MapPath }
    | undefined;

  /** Pointeurs actifs pour pan / pinch-zoom. */
  private readonly activePointers = new Map<number, { x: number; y: number }>();
  private panSession:
    | {
        pointerId: number;
        startX: number;
        startY: number;
        originX: number;
        originY: number;
        dragged: boolean;
      }
    | undefined;
  private pinchSession:
    | {
        startDist: number;
        startZoom: number;
        startMidX: number;
        startMidY: number;
        originPanX: number;
        originPanY: number;
      }
    | undefined;
  private viewportResizeObserver: ResizeObserver | undefined;

  protected readonly map = signal<GameMap | undefined>(undefined);
  protected readonly towers = signal<readonly TowerInstance[]>([]);
  protected readonly remainingBudget = signal(0);
  protected readonly defenseBudgetTotal = signal(0);
  protected readonly attackBudgetTotal = signal(0);
  protected readonly selectedTypeId = signal<string | undefined>(undefined);
  protected readonly selectedTowerId = signal<string | undefined>(undefined);
  /** Tour en cours de déplacement (case de destination attendue au prochain clic sur la grille). */
  protected readonly movingTowerId = signal<string | undefined>(undefined);
  protected readonly message = signal<string | undefined>(undefined);
  protected readonly hoverCell = signal<GridCoord | undefined>(undefined);

  protected readonly phase = signal<GamePhase>('defense');
  protected readonly palier = signal(1);
  protected readonly vagueCourante = signal<Wave | undefined>(undefined);
  protected readonly chateauMaxHp = signal(0);

  protected readonly lanes = signal<LaneDraft[]>([]);
  protected readonly activeLaneIndex = signal<number | undefined>(undefined);
  /** Points déjà cliqués du tracé en cours ; `undefined` = pas en train de tracer. */
  protected readonly drawingPath = signal<GridCoord[] | undefined>(undefined);

  protected readonly trialChateauHp = signal<number | undefined>(undefined);
  protected readonly trialBreachCount = signal<number | undefined>(undefined);
  protected readonly trialMonsters = signal<readonly MonsterView[]>([]);
  protected readonly trialOutcome = signal<DefenseOutcome | undefined>(undefined);

  /** Infobulle affichée au survol d'une tour posée ou d'un monstre sur le plateau. */
  protected readonly boardTooltip = signal<BoardTooltip | undefined>(undefined);

  /** Main (pan) tant qu'aucune pose / tracé / déplacement n'est actif. */
  protected readonly boardTool = signal<BoardTool>('pan');
  /** Tiroir d'actions (tour sélectionnée ou voie sélectionnée). */
  protected readonly targetingOpen = signal(false);

  /** Caméra : zoom et pan CSS sur le canvas (navigation dans la carte). */
  protected readonly viewZoom = signal(1);
  protected readonly viewPanX = signal(0);
  protected readonly viewPanY = signal(0);
  protected readonly isPanning = signal(false);
  protected readonly viewTransform = computed(
    () => `translate(${this.viewPanX()}px, ${this.viewPanY()}px) scale(${this.viewZoom()})`,
  );

  protected readonly selectedTower = computed(() =>
    this.towers().find((tower) => tower.id === this.selectedTowerId()),
  );
  protected readonly activeLane = computed(() => {
    const index = this.activeLaneIndex();
    return index === undefined ? undefined : this.lanes()[index];
  });
  protected readonly activeLaneLabel = computed(() => {
    const lane = this.activeLane();
    const index = this.activeLaneIndex();
    if (!lane || index === undefined) {
      return 'Voie';
    }
    return laneDisplayLabel(lane, index);
  });
  protected readonly isTrialRunning = computed(() => this.trialOutcome() === 'pending');
  protected readonly isDrawingPath = computed(() => this.drawingPath() !== undefined);
  protected readonly isMovingTower = computed(() => this.movingTowerId() !== undefined);
  protected readonly canLaunch = computed(() => {
    if (this.isTrialRunning()) {
      return false;
    }
    if (this.phase() === 'defense') {
      return !!this.vagueCourante();
    }
    return !this.isDrawingPath() && this.lanes().length > 0;
  });

  constructor() {
    this.preloadSprites();

    this.destroyRef.onDestroy(() => {
      if (this.trialTimer !== undefined) {
        clearTimeout(this.trialTimer);
      }
      if (this.projectileAnimationHandle !== undefined) {
        cancelAnimationFrame(this.projectileAnimationHandle);
      }
      this.viewportResizeObserver?.disconnect();
    });

    // `passive: false` pour pouvoir empêcher le scroll de page pendant le zoom molette.
    afterNextRender(() => {
      const viewport = this.viewportRef()?.nativeElement;
      if (!viewport) {
        return;
      }
      const onWheel = (event: WheelEvent) => this.onViewWheel(event);
      viewport.addEventListener('wheel', onWheel, { passive: false });
      this.destroyRef.onDestroy(() => viewport.removeEventListener('wheel', onWheel));

      this.viewportResizeObserver = new ResizeObserver(() => {
        this.fitCanvasToViewport();
        this.clampPan();
      });
      this.viewportResizeObserver.observe(viewport);
      this.fitCanvasToViewport();
    });

    effect(() => {
      this.map();
      this.towers();
      this.selectedTowerId();
      this.movingTowerId();
      this.hoverCell();
      this.selectedTypeId();
      this.boardTool();
      this.phase();
      this.lanes();
      this.activeLaneIndex();
      this.drawingPath();
      this.trialMonsters();
      this.trialChateauHp();
      this.spriteVersion();
      this.biomeColors();
      this.decor();
      this.draw();
    });
  }

  ngOnInit(): void {
    void this.bootstrap();
  }

  protected enterHandMode(): void {
    this.boardTool.set('pan');
    this.selectedTypeId.set(undefined);
    this.movingTowerId.set(undefined);
    if (this.isDrawingPath()) {
      this.cancelTracing();
    }
  }

  protected toggleTargeting(): void {
    if (this.isTrialRunning()) {
      return;
    }
    if (this.phase() === 'attack' && this.activeLaneIndex() === undefined) {
      return;
    }
    this.targetingOpen.update((open) => !open);
  }

  protected closeTargeting(): void {
    this.targetingOpen.set(false);
  }

  protected closeDrawers(): void {
    this.targetingOpen.set(false);
  }

  protected onLaunch(): void {
    if (this.phase() === 'defense') {
      this.startTrial();
      return;
    }
    this.startAttack();
  }

  // ---- Caméra (pan / zoom) -----------------------------------------------

  protected onViewPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    event.preventDefault();
    if (this.targetingOpen()) {
      this.closeDrawers();
    }
    const viewport = this.viewportRef()?.nativeElement;
    if (!viewport) {
      return;
    }
    viewport.setPointerCapture(event.pointerId);
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.activePointers.size >= 2) {
      this.panSession = undefined;
      this.isPanning.set(true);
      this.hoverCell.set(undefined);
      this.boardTooltip.set(undefined);
      this.beginPinch();
      return;
    }

    this.panSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: this.viewPanX(),
      originY: this.viewPanY(),
      dragged: false,
    };
  }

  protected onViewPointerMove(event: PointerEvent): void {
    if (!this.activePointers.has(event.pointerId)) {
      this.onCanvasMove(event);
      return;
    }
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.activePointers.size >= 2) {
      this.updatePinch();
      return;
    }

    const session = this.panSession;
    if (!session || session.pointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.dragged && Math.hypot(dx, dy) >= PAN_DRAG_THRESHOLD_PX) {
      session.dragged = true;
      if (this.boardTool() === 'pan') {
        this.isPanning.set(true);
        this.hoverCell.set(undefined);
        this.boardTooltip.set(undefined);
      }
    }
    if (session.dragged && this.boardTool() === 'pan') {
      event.preventDefault();
      this.setPan(session.originX + dx, session.originY + dy);
      return;
    }
    if (!session.dragged) {
      this.onCanvasMove(event);
    }
  }

  protected onViewPointerUp(event: PointerEvent): void {
    if (!this.activePointers.has(event.pointerId)) {
      return;
    }

    const session = this.panSession;
    const isSessionPointer = session?.pointerId === event.pointerId;
    const wasTap =
      isSessionPointer &&
      !!session &&
      !session.dragged &&
      this.activePointers.size === 1 &&
      this.pinchSession === undefined;

    this.activePointers.delete(event.pointerId);

    if (isSessionPointer) {
      this.panSession = undefined;
    }

    if (this.activePointers.size < 2) {
      this.pinchSession = undefined;
    }

    if (wasTap) {
      this.isPanning.set(false);
      this.onCanvasTap(event);
      return;
    }

    if (this.activePointers.size === 1 && this.boardTool() === 'pan') {
      const remaining = this.activePointers.entries().next().value;
      if (!remaining) {
        this.isPanning.set(false);
        return;
      }
      const [pointerId, point] = remaining;
      this.panSession = {
        pointerId,
        startX: point.x,
        startY: point.y,
        originX: this.viewPanX(),
        originY: this.viewPanY(),
        dragged: true,
      };
      this.isPanning.set(true);
      return;
    }

    this.isPanning.set(false);
  }

  protected onViewWheel(event: WheelEvent): void {
    event.preventDefault();
    const viewport = this.viewportRef()?.nativeElement;
    if (!viewport) {
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, this.viewZoom() * factor);
  }

  protected resetView(): void {
    this.viewZoom.set(1);
    this.viewPanX.set(0);
    this.viewPanY.set(0);
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
    if (this.selectedTypeId() === typeId) {
      this.enterHandMode();
      this.message.set(undefined);
      return;
    }
    this.selectedTypeId.set(typeId);
    this.selectedTowerId.set(undefined);
    this.targetingOpen.set(false);
    this.boardTool.set('edit');
    this.message.set('Touchez une case libre pour poser la tour.');
  }

  protected deleteSelected(): void {
    const towerId = this.selectedTowerId();
    if (!towerId || this.isTrialRunning() || this.isMovingTower()) {
      return;
    }
    const recovered = this.engine.deleteTower(towerId);
    if (recovered === undefined) {
      return;
    }
    this.selectedTowerId.set(undefined);
    this.targetingOpen.set(false);
    this.message.set(`Tour supprimée (+${recovered}).`);
    this.syncFromEngine();
  }

  /** Démarre le déplacement de la tour sélectionnée : le prochain clic sur une case libre la relocalise. */
  protected startMovingTower(): void {
    const towerId = this.selectedTowerId();
    if (!towerId || this.isTrialRunning()) {
      return;
    }
    this.boardTool.set('edit');
    this.movingTowerId.set(towerId);
    this.targetingOpen.set(false);
    this.message.set('Touchez une case libre pour déplacer la tour.');
  }

  protected cancelMovingTower(): void {
    this.movingTowerId.set(undefined);
    this.boardTool.set('pan');
    this.message.set(undefined);
  }

  /** Abandonne les poses/suppressions/déplacements de la phase Défense en cours et revient à la forteresse de départ. */
  protected resetDefenseSession(): void {
    if (this.phase() !== 'defense' || this.isTrialRunning()) {
      return;
    }
    this.engine.resetDefenseSession();
    this.selectedTowerId.set(undefined);
    this.selectedTypeId.set(undefined);
    this.movingTowerId.set(undefined);
    this.boardTool.set('pan');
    this.targetingOpen.set(false);
    this.message.set(undefined);
    this.syncFromEngine();
  }

  /** Lance vagueCourante contre la forteresse actuelle. */
  protected startTrial(): void {
    const wave = this.vagueCourante();
    if (!wave || this.isTrialRunning()) {
      return;
    }
    this.selectedTowerId.set(undefined);
    this.movingTowerId.set(undefined);
    this.closeDrawers();
    this.boardTool.set('pan');
    this.message.set(undefined);
    this.activeTrial = this.engine.startDefenseTrial();
    this.trialChateauHp.set(this.activeTrial.getChateauHp());
    this.trialMonsters.set([]);
    this.trialOutcome.set(this.activeTrial.getOutcome());
    this.scheduleTrialTick();
  }

  // ---- Phase Attaque : composition des voies ---------------------------

  /**
   * Démarre le tracé libre d'une nouvelle voie. Avec un seul spawn sur la carte (cas courant),
   * le tracé démarre directement dessus — pas besoin de viser précisément une case unique en
   * bord de grille. Avec plusieurs spawns, le prochain clic doit tomber sur l'un d'eux.
   */
  protected startTracing(): void {
    if (this.phase() !== 'attack' || this.isTrialRunning()) {
      return;
    }
    this.boardTool.set('edit');
    this.targetingOpen.set(false);
    this.activeLaneIndex.set(undefined);
    const spawns = this.map()?.spawns ?? [];
    if (spawns.length === 1) {
      this.drawingPath.set([{ x: spawns[0].x, y: spawns[0].y }]);
      this.message.set('Touchez des cases jusqu’au château.');
      return;
    }
    this.drawingPath.set([]);
    this.message.set('Touchez un spawn pour démarrer.');
  }

  protected cancelTracing(): void {
    this.drawingPath.set(undefined);
    this.boardTool.set('pan');
    if (this.retracing) {
      const { index, units, path } = this.retracing;
      this.engine.addPath(path);
      this.lanes.update((lanes) => {
        const next = [...lanes];
        next.splice(Math.min(index, next.length), 0, { path, units });
        return next;
      });
      this.activeLaneIndex.set(Math.min(index, this.lanes().length - 1));
      this.retracing = undefined;
      this.syncFromEngine();
    }
    this.message.set(undefined);
  }

  protected undoLastTracePoint(): void {
    this.drawingPath.update((path) => (path && path.length > 0 ? path.slice(0, -1) : path));
  }

  protected selectLane(index: number): void {
    if (this.isTrialRunning() || this.isDrawingPath()) {
      return;
    }
    if (this.activeLaneIndex() === index && this.targetingOpen()) {
      this.targetingOpen.set(false);
      this.activeLaneIndex.set(undefined);
      return;
    }
    this.activeLaneIndex.set(index);
    this.targetingOpen.set(true);
  }

  /** Relance le tracé d'une voie existante en conservant sa file de monstres. */
  protected startRetracing(index: number): void {
    if (this.phase() !== 'attack' || this.isTrialRunning() || this.isDrawingPath()) {
      return;
    }
    const lane = this.lanes()[index];
    if (!lane) {
      return;
    }
    this.retracing = {
      index,
      units: lane.units.map((unit) => ({ ...unit })),
      path: { ...lane.path, nodes: lane.path.nodes.map((node) => [node[0], node[1]] as [number, number]) },
    };
    this.engine.removePath(lane.path.id);
    this.lanes.update((lanes) => lanes.filter((_, i) => i !== index));
    this.activeLaneIndex.set(undefined);
    this.targetingOpen.set(false);
    this.syncFromEngine();
    this.startTracing();
  }

  /** Supprime une voie : son tracé disparaît aussi de la carte (plus de référence fantôme au dessin). */
  protected removeLane(index: number): void {
    if (this.isTrialRunning()) {
      return;
    }
    const lane = this.lanes()[index];
    if (!lane) {
      return;
    }
    this.engine.removePath(lane.path.id);
    this.lanes.update((lanes) => lanes.filter((_, i) => i !== index));
    if (this.activeLaneIndex() === index) {
      this.activeLaneIndex.set(undefined);
      this.targetingOpen.set(false);
    } else if ((this.activeLaneIndex() ?? -1) > index) {
      this.activeLaneIndex.update((current) => (current === undefined ? undefined : current - 1));
    }
    this.syncFromEngine();
  }

  protected renameActiveLane(rawName: string): void {
    const index = this.activeLaneIndex();
    if (index === undefined) {
      return;
    }
    this.renameLane(index, rawName);
  }

  protected removeActiveLane(): void {
    const index = this.activeLaneIndex();
    if (index === undefined) {
      return;
    }
    this.removeLane(index);
  }

  protected retraceActiveLane(): void {
    const index = this.activeLaneIndex();
    if (index === undefined) {
      return;
    }
    this.startRetracing(index);
  }

  protected moveActiveQueueUnit(unitIndex: number, direction: -1 | 1): void {
    const laneIndex = this.activeLaneIndex();
    if (laneIndex === undefined) {
      return;
    }
    this.moveQueueUnit(laneIndex, unitIndex, direction);
  }

  protected removeActiveQueueUnit(unitIndex: number): void {
    const laneIndex = this.activeLaneIndex();
    if (laneIndex === undefined) {
      return;
    }
    this.removeQueueUnit(laneIndex, unitIndex);
  }

  /** Renomme une voie ; nom vide = retour à l'étiquette par défaut. */
  protected renameLane(index: number, rawName: string): void {
    const name = rawName.trim();
    this.lanes.update((lanes) =>
      lanes.map((lane, i) =>
        i === index ? { ...lane, path: { ...lane.path, name: name || undefined } } : lane,
      ),
    );
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
    this.lanes.update((lanes) =>
      lanes.map((lane, i) =>
        i === laneIndex ? { ...lane, units: [...lane.units, { type: typeId }] } : lane,
      ),
    );
  }

  protected removeQueueUnit(laneIndex: number, unitIndex: number): void {
    if (this.isTrialRunning()) {
      return;
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

  /** Recharge les voies en cours de composition depuis le plan d'attaque sauvegardé par le moteur. */
  private loadAttackPlan(): LaneDraft[] {
    return this.engine.getAttackPlan().lanes.map((lane) => ({
      path: lane.path,
      units: lane.units.map((unit) => ({ ...unit })),
    }));
  }

  /** Abandonne les modifications en cours et revient au plan d'attaque sauvegardé. */
  protected resetAttackPlan(): void {
    if (this.phase() !== 'attack' || this.isTrialRunning() || this.isDrawingPath()) {
      return;
    }
    this.lanes.set(this.loadAttackPlan());
    this.activeLaneIndex.set(undefined);
    this.message.set(undefined);
  }

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
    this.closeDrawers();
    this.boardTool.set('pan');
    this.message.set(undefined);
    this.activeTrial = this.engine.startAttackTrial(wave);
    this.trialChateauHp.set(this.activeTrial.getChateauHp());
    this.trialBreachCount.set(this.activeTrial.getBreachCount());
    this.trialMonsters.set([]);
    this.trialOutcome.set(this.activeTrial.getOutcome());
    this.scheduleTrialTick();
  }

  // ---- Interaction canvas commune --------------------------------------

  /**
   * Tap court.
   * - Mode Main : sélectionner une tour / voie (inspection), pas de pose.
   * - Mode Pose/Éditer : pose, tracé, déplacement.
   */
  protected onCanvasTap(event: PointerEvent): void {
    const coord = this.toGridCoord(event);
    if (!coord) {
      return;
    }

    if (this.phase() === 'attack') {
      if (this.isTrialRunning()) {
        return;
      }
      if (this.isDrawingPath()) {
        this.handleTracingClick(coord);
        return;
      }
      const laneIndex = this.lanes().findIndex((lane) => this.pathContainsCell(lane.path, coord));
      if (laneIndex !== -1) {
        this.selectLane(laneIndex);
      }
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
      this.boardTool.set('pan');
      this.message.set(undefined);
      this.syncFromEngine();
      this.selectedTowerId.set(movingId);
      return;
    }

    const existing = this.towers().find(
      (tower) => tower.position.x === coord.x && tower.position.y === coord.y,
    );
    if (existing) {
      this.selectedTypeId.set(undefined);
      this.boardTool.set('pan');
      this.selectedTowerId.set(existing.id);
      this.message.set(undefined);
      this.targetingOpen.set(true);
      return;
    }

    // Mode Main : pas de pose sur case vide.
    if (this.boardTool() === 'pan' || !this.selectedTypeId()) {
      this.selectedTowerId.set(undefined);
      this.targetingOpen.set(false);
      return;
    }

    const typeId = this.selectedTypeId();
    if (!typeId) {
      return;
    }
    const result = this.engine.placeTower(typeId, coord);
    if (!result.ok) {
      this.message.set(FAILURE_MESSAGES[result.reason] ?? 'Placement impossible.');
      return;
    }
    this.message.set(undefined);
    this.syncFromEngine();
    // Après pose : retour en mode main.
    this.selectedTypeId.set(undefined);
    this.boardTool.set('pan');
    this.selectedTowerId.set(undefined);
  }

  /** Vrai si `coord` tombe sur une case parcourue par `path` (nœuds inclus, segments interpolés). */
  private pathContainsCell(path: MapPath, coord: GridCoord): boolean {
    const nodes = path.nodes;
    if (nodes.length === 0) {
      return false;
    }
    const [x0, y0] = nodes[0];
    if (x0 === coord.x && y0 === coord.y) {
      return true;
    }
    for (let i = 1; i < nodes.length; i++) {
      const [ax, ay] = nodes[i - 1];
      const [bx, by] = nodes[i];
      if (
        cellsBetween({ x: ax, y: ay }, { x: bx, y: by }).some(
          (cell) => cell.x === coord.x && cell.y === coord.y,
        )
      ) {
        return true;
      }
    }
    return false;
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
      this.message.set('Cliquez des cases adjacentes jusqu’au château.');
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
    let reachedChateau = false;
    for (const step of steps) {
      if (!isValidPathStep(map, this.towers(), cursor, step)) {
        this.message.set('Case invalide : doit être dans la grille et libre de tour.');
        return;
      }
      filledCells.push(step);
      cursor = step;
      if (isChateauCell(map, step)) {
        reachedChateau = true;
        break;
      }
    }

    const nextPath = [...path, ...filledCells];
    if (reachedChateau) {
      const retracing = this.retracing;
      const newPath: MapPath = {
        id: retracing?.path.id ?? `custom-${this.customLaneSequence++}`,
        name: retracing?.path.name,
        nodes: nextPath.map((p) => [p.x, p.y]),
      };
      const newLane: LaneDraft = {
        path: newPath,
        units: retracing?.units.map((unit) => ({ ...unit })) ?? [],
      };
      this.engine.addPath(newLane.path);
      const insertAt = retracing ? Math.min(retracing.index, this.lanes().length) : this.lanes().length;
      this.lanes.update((lanes) => {
        const next = [...lanes];
        next.splice(insertAt, 0, newLane);
        return next;
      });
      this.activeLaneIndex.set(insertAt);
      this.retracing = undefined;
      this.drawingPath.set(undefined);
      this.boardTool.set('pan');
      this.message.set(undefined);
      this.targetingOpen.set(true);
      this.syncFromEngine();
      return;
    }
    this.drawingPath.set(nextPath);
  }

  protected onCanvasMove(event: { clientX: number; clientY: number }): void {
    if (this.isPanning()) {
      return;
    }
    this.hoverCell.set(this.toGridCoord(event));
    this.boardTooltip.set(this.computeBoardTooltip(event));
  }

  protected onCanvasLeave(): void {
    this.hoverCell.set(undefined);
    this.boardTooltip.set(undefined);
  }

  /** Infobulle au survol : positionnée en coords viewport (indépendant du zoom/pan). */
  private computeBoardTooltip(event: { clientX: number; clientY: number }): BoardTooltip | undefined {
    const coord = this.toGridCoord(event);
    if (!coord) {
      return undefined;
    }

    const viewport = this.viewportRef()?.nativeElement;
    const rect = viewport?.getBoundingClientRect();
    const left = rect ? event.clientX - rect.left + 14 : 14;
    const top = rect ? event.clientY - rect.top + 14 : 14;

    const tower = this.towers().find(
      (t) => t.position.x === coord.x && t.position.y === coord.y,
    );
    if (tower) {
      const type = findTowerType(tower.typeId);
      if (!type) {
        return undefined;
      }
      return {
        left,
        top,
        heading: type.name,
        description: type.description,
        stats: formatTowerStats(type),
      };
    }

    const fractional = this.toFractionalCoord(event);
    if (!fractional) {
      return undefined;
    }
    const monster = this.trialMonsters().find(
      (m) => Math.hypot(m.position.x - fractional.x, m.position.y - fractional.y) < 0.5,
    );
    if (monster) {
      const type = findMonsterType(monster.typeId);
      if (!type) {
        return undefined;
      }
      return {
        left,
        top,
        heading: type.name,
        description: type.description,
        stats: formatMonsterStats(type),
      };
    }

    return undefined;
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
    this.trialChateauHp.set(trial.getChateauHp());
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
        ...shots.map((shot) => ({
          from: cellCenterPx(shot.towerPosition),
          to: worldToPx(shot.targetPosition),
          firedAtMs,
        })),
      );
      const splashShots = shots.filter((shot): shot is typeof shot & { splashRadius: number } =>
        Boolean(shot.splashRadius),
      );
      if (splashShots.length > 0) {
        // L'explosion apparaît à l'impact, une fois le projectile arrivé sur sa cible.
        const impactAtMs = firedAtMs + PROJECTILE_DURATION_MS;
        this.splashes.push(
          ...splashShots.map((shot) => ({
            position: worldToPx(shot.targetPosition),
            radiusPx: shot.splashRadius * WORLD_SCALE,
            firedAtMs: impactAtMs,
          })),
        );
      }
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
        this.lanes.set(this.loadAttackPlan());
        this.activeLaneIndex.set(undefined);
        this.selectedTypeId.set(undefined);
        this.boardTool.set('pan');
        this.targetingOpen.set(false);
        this.message.set('Défense réussie ! La forteresse est figée : phase Attaque.');
        this.resetTrialDisplay();
      } else {
        this.message.set('Défense échouée — le château est tombé. Ajustez vos tours et réessayez.');
      }
    } else {
      if (outcome === 'success') {
        const wave = this.pendingAttackWave;
        if (wave) {
          this.engine.resolveAttackSuccess(wave);
        }
        // Le plan d'attaque n'est pas remis à zéro : il devient le plan sauvegardé, point de
        // départ du prochain cycle — CONCEPTION.md §5.2, §11 décision 12.
        this.lanes.set(this.loadAttackPlan());
        this.activeLaneIndex.set(undefined);
        this.selectedTypeId.set(undefined);
        this.boardTool.set('pan');
        this.targetingOpen.set(false);
        this.message.set(
          `Vague victorieuse (${trial.getBreachCount()} brèche(s)) ! Palier ${this.engine.getPalier()} — retour en Défense.`,
        );
        this.resetTrialDisplay();
      } else {
        this.message.set('Vague anéantie, aucune brèche. Recomposez et réessayez.');
      }
    }
    this.pendingAttackWave = undefined;
    this.syncFromEngine();
  }

  private resetTrialDisplay(): void {
    this.trialOutcome.set(undefined);
    this.trialMonsters.set([]);
    this.trialChateauHp.set(undefined);
    this.trialBreachCount.set(undefined);
  }

  /** Anime les projectiles en cours (indépendamment des ticks) jusqu'à ce qu'ils s'estompent. */
  private ensureProjectileAnimationRunning(): void {
    if (this.projectileAnimationHandle !== undefined) {
      return;
    }
    const step = () => {
      const now = performance.now();
      this.projectiles = this.projectiles.filter(
        (projectile) => now - projectile.firedAtMs < PROJECTILE_DURATION_MS,
      );
      this.splashes = this.splashes.filter((splash) => now - splash.firedAtMs < SPLASH_DURATION_MS);
      this.draw();
      this.projectileAnimationHandle =
        this.projectiles.length > 0 || this.splashes.length > 0
          ? requestAnimationFrame(step)
          : undefined;
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
      const map = await fetch(`maps/${mapId}.map.json`).then(
        (response) => response.json() as Promise<GameMap>,
      );
      this.decor.set(generateDecor(map));
      this.engine.startRun(map, catalogEntry.startingData);
      this.lanes.set(this.loadAttackPlan());
      this.resetView();
      this.syncFromEngine();
    } catch {
      this.message.set('Impossible de charger la carte.');
    }
  }

  /** Position du curseur en world-space (unité = distance entre centres voisins). */
  private toFractionalCoord(event: { clientX: number; clientY: number }): { x: number; y: number } | undefined {
    const px = this.clientToCanvasPx(event.clientX, event.clientY);
    if (!px) {
      return undefined;
    }
    return {
      x: (px.x - ORIGIN_X) / WORLD_SCALE,
      y: (px.y - ORIGIN_Y) / WORLD_SCALE,
    };
  }

  private toGridCoord(event: { clientX: number; clientY: number }): GridCoord | undefined {
    const map = this.map();
    const px = this.clientToCanvasPx(event.clientX, event.clientY);
    if (!map || !px) {
      return undefined;
    }
    const coord = worldToHex(px.x - ORIGIN_X, px.y - ORIGIN_Y, CELL_SIZE);
    if (coord.x < 0 || coord.y < 0 || coord.x >= map.grid.cols || coord.y >= map.grid.rows) {
      return undefined;
    }
    return coord;
  }

  /**
   * Convertit une position client (écran) en pixels canvas bitmap,
   * en tenant compte du pan/zoom CSS de la caméra.
   */
  private clientToCanvasPx(clientX: number, clientY: number): { x: number; y: number } | undefined {
    const canvas = this.canvasRef()?.nativeElement;
    const viewport = this.viewportRef()?.nativeElement;
    if (!canvas || !viewport) {
      return undefined;
    }
    const layoutW = canvas.offsetWidth;
    const layoutH = canvas.offsetHeight;
    if (layoutW <= 0 || layoutH <= 0) {
      return undefined;
    }
    const rect = viewport.getBoundingClientRect();
    const zoom = this.viewZoom();
    const layoutX = (clientX - rect.left - this.viewPanX()) / zoom;
    const layoutY = (clientY - rect.top - this.viewPanY()) / zoom;
    return {
      x: layoutX * (canvas.width / layoutW),
      y: layoutY * (canvas.height / layoutH),
    };
  }

  private beginPinch(): void {
    const points = [...this.activePointers.values()];
    if (points.length < 2) {
      return;
    }
    const [a, b] = points;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (dist < 1) {
      return;
    }
    const viewport = this.viewportRef()?.nativeElement;
    const rect = viewport?.getBoundingClientRect();
    this.pinchSession = {
      startDist: dist,
      startZoom: this.viewZoom(),
      startMidX: (a.x + b.x) / 2 - (rect?.left ?? 0),
      startMidY: (a.y + b.y) / 2 - (rect?.top ?? 0),
      originPanX: this.viewPanX(),
      originPanY: this.viewPanY(),
    };
  }

  private updatePinch(): void {
    const session = this.pinchSession;
    const points = [...this.activePointers.values()];
    if (!session || points.length < 2) {
      return;
    }
    const [a, b] = points;
    const dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (dist < 1) {
      return;
    }
    const viewport = this.viewportRef()?.nativeElement;
    const rect = viewport?.getBoundingClientRect();
    const midX = (a.x + b.x) / 2 - (rect?.left ?? 0);
    const midY = (a.y + b.y) / 2 - (rect?.top ?? 0);
    const contentX = (session.startMidX - session.originPanX) / session.startZoom;
    const contentY = (session.startMidY - session.originPanY) / session.startZoom;
    const zoom = Math.min(
      VIEW_ZOOM_MAX,
      Math.max(VIEW_ZOOM_MIN, session.startZoom * (dist / session.startDist)),
    );
    this.viewZoom.set(zoom);
    this.setPan(midX - contentX * zoom, midY - contentY * zoom);
  }

  /** Zoom centré sur un point du viewport (coords locales au wrap). */
  private zoomAt(viewportX: number, viewportY: number, nextZoom: number): void {
    const zoom = Math.min(VIEW_ZOOM_MAX, Math.max(VIEW_ZOOM_MIN, nextZoom));
    const prev = this.viewZoom();
    if (zoom === prev) {
      this.clampPan();
      return;
    }
    const panX = viewportX - ((viewportX - this.viewPanX()) * zoom) / prev;
    const panY = viewportY - ((viewportY - this.viewPanY()) * zoom) / prev;
    this.viewZoom.set(zoom);
    this.setPan(panX, panY);
  }

  private setPan(x: number, y: number): void {
    this.viewPanX.set(x);
    this.viewPanY.set(y);
    this.clampPan();
  }

  /** Empêche de faire sortir entièrement la carte du viewport. */
  private clampPan(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const viewport = this.viewportRef()?.nativeElement;
    if (!canvas || !viewport) {
      return;
    }
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    const zoom = this.viewZoom();
    const scaledW = canvas.offsetWidth * zoom;
    const scaledH = canvas.offsetHeight * zoom;
    const marginX = Math.min(PAN_EDGE_MARGIN_PX, vw * 0.2);
    const marginY = Math.min(PAN_EDGE_MARGIN_PX, vh * 0.2);

    // Toujours un peu de jeu (même à ×1), sinon le pan est impossible et conflict avec la pose.
    const minX = vw - scaledW - marginX;
    const maxX = marginX;
    const minY = vh - scaledH - marginY;
    const maxY = marginY;

    this.viewPanX.set(Math.min(maxX, Math.max(minX, this.viewPanX())));
    this.viewPanY.set(Math.min(maxY, Math.max(minY, this.viewPanY())));
  }

  private syncFromEngine(): void {
    this.map.set(this.engine.getMap());
    this.towers.set(this.engine.getTowers());
    this.remainingBudget.set(this.engine.getRemainingBudget());
    this.defenseBudgetTotal.set(this.engine.getDefenseBudget());
    this.attackBudgetTotal.set(this.engine.getAttackBudget());
    this.chateauMaxHp.set(this.engine.getChateauMaxHp());
    this.phase.set(this.engine.getPhase());
    this.palier.set(this.engine.getPalier());
    this.vagueCourante.set(this.engine.getVagueCourante());
  }

  /** Vrai si le type de tour courant peut être posé sur `coord` (grille, occupation, budget). */
  private canPlaceSelectedTypeAt(coord: GridCoord): boolean {
    const typeId = this.selectedTypeId();
    if (!typeId) {
      return false;
    }
    const type = findTowerType(typeId);
    return canPlaceTower(
      this.map(),
      this.towers(),
      type,
      coord,
      this.remainingBudget(),
    ).ok;
  }

  /** Centre + portée à prévisualiser sur les chemins : la tour sélectionnée, ou celle en attente de pose au survol. */
  private computeRangePreview(): { center: GridCoord; range: number } | undefined {
    if (
      this.phase() !== 'defense' ||
      this.boardTool() !== 'edit' ||
      this.isTrialRunning() ||
      this.isMovingTower()
    ) {
      return undefined;
    }
    const selected = this.selectedTower();
    if (selected) {
      const type = findTowerType(selected.typeId);
      return type ? { center: selected.position, range: type.range } : undefined;
    }
    if (this.selectedTowerId()) {
      return undefined;
    }
    const hover = this.hoverCell();
    const typeId = this.selectedTypeId();
    if (!hover || !typeId || !this.canPlaceSelectedTypeAt(hover)) {
      return undefined;
    }
    const type = findTowerType(typeId);
    return type ? { center: hover, range: type.range } : undefined;
  }

  /**
   * Cases des chemins de la carte situées à `range` cases de `center` (même métrique de distance
   * que le ciblage moteur, cf. combat.ts::selectTarget).
   */
  private pathCellsInRange(map: GameMap, center: GridCoord, range: number): GridCoord[] {
    const cells: GridCoord[] = [];
    for (const path of map.paths) {
      const nodes = path.nodes;
      if (nodes.length === 0) {
        continue;
      }
      const [x0, y0] = nodes[0];
      cells.push({ x: x0, y: y0 });
      for (let i = 1; i < nodes.length; i++) {
        const [ax, ay] = nodes[i - 1];
        const [bx, by] = nodes[i];
        cells.push(...cellsBetween({ x: ax, y: ay }, { x: bx, y: by }));
      }
    }
    return cells.filter((cell) => {
      const cellWorld = hexToWorld(cell);
      const centerWorld = hexToWorld(center);
      return Math.hypot(cellWorld.x - centerWorld.x, cellWorld.y - centerWorld.y) <= range;
    });
  }

  /**
   * Adapte la taille CSS du canvas pour qu’il tienne entièrement dans le viewport
   * (contain), sans provoquer de scroll de page.
   */
  private fitCanvasToViewport(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const viewport = this.viewportRef()?.nativeElement;
    if (!canvas || !viewport || canvas.width <= 0 || canvas.height <= 0) {
      return;
    }
    const availableW = viewport.clientWidth;
    const availableH = viewport.clientHeight;
    if (availableW <= 0 || availableH <= 0) {
      return;
    }
    const scale = Math.min(availableW / canvas.width, availableH / canvas.height);
    canvas.style.width = `${canvas.width * scale}px`;
    canvas.style.height = `${canvas.height * scale}px`;
  }

  private draw(): void {
    const canvas = this.canvasRef()?.nativeElement;
    const map = this.map();
    if (!canvas || !map) {
      return;
    }
    const { width, height } = hexGridPixelSize(map.grid.cols, map.grid.rows, CELL_SIZE);
    const canvasWidth = Math.ceil(width + 2 * CANVAS_PAD);
    const canvasHeight = Math.ceil(height + 2 * CANVAS_PAD);
    if (canvas.width !== canvasWidth || canvas.height !== canvasHeight) {
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      this.fitCanvasToViewport();
    } else if (!canvas.style.width) {
      this.fitCanvasToViewport();
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
    for (let y = 0; y < map.grid.rows; y++) {
      for (let x = 0; x < map.grid.cols; x++) {
        if (isBorderCell(map, { x, y })) {
          this.fillHex(ctx, { x, y });
        }
      }
    }

    ctx.strokeStyle = '#2a2f3a';
    ctx.lineWidth = 1;
    for (let y = 0; y < map.grid.rows; y++) {
      for (let x = 0; x < map.grid.cols; x++) {
        this.strokeHex(ctx, { x, y });
      }
    }

    const isAttackPhase = this.phase() === 'attack';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Chemins prédéfinis de la carte : couleur pleine en défense, simple référence estompée en attaque.
    for (const path of map.paths) {
      ctx.strokeStyle = isAttackPhase ? hexToRgba(biome.path, 0.25) : biome.path;
      ctx.lineWidth = CELL_SIZE * 0.4;
      this.strokePolyline(ctx, expandPathCells(path));
    }

    // Portion des chemins atteignable par la tour sélectionnée (ou celle sur le point d'être posée).
    const rangePreview = this.computeRangePreview();
    if (rangePreview) {
      ctx.fillStyle = 'rgba(120, 255, 170, 0.45)';
      for (const cell of this.pathCellsInRange(map, rangePreview.center, rangePreview.range)) {
        this.fillHex(ctx, cell);
      }
    }

    // Voies composées par l'attaquant : la voie active en surbrillance, les autres atténuées.
    this.lanes().forEach((lane, index) => {
      const isActive = index === this.activeLaneIndex();
      ctx.strokeStyle = isActive ? '#ffe08c' : 'rgba(255, 224, 140, 0.55)';
      ctx.lineWidth = CELL_SIZE * 0.32;
      this.strokePolyline(ctx, expandPathCells(lane.path));
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
        const center = cellCenterPx(point);
        ctx.beginPath();
        ctx.arc(center.x, center.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const awaitingSpawnClick = this.isDrawingPath() && this.drawingPath()?.length === 0;
    for (const spawn of map.spawns) {
      if (awaitingSpawnClick) {
        this.drawRangeRing(ctx, spawn.x, spawn.y, 0.85, '#7be0ff');
      }
      ctx.fillStyle = '#7a5c2e';
      this.fillHex(ctx, spawn);
    }

    const chateauCenter = cellCenterPx(map.chateau);
    if (!this.drawSprite(ctx, 'chateau', chateauCenter.x, chateauCenter.y, CELL_SIZE * 0.9)) {
      ctx.fillStyle = '#9b9086';
      ctx.beginPath();
      ctx.arc(chateauCenter.x, chateauCenter.y, CELL_SIZE / 2 - 4, 0, Math.PI * 2);
      ctx.fill();
    }

    const hover = this.hoverCell();
    const selectedTypeId = this.selectedTypeId();
    if (
      hover &&
      selectedTypeId &&
      this.boardTool() === 'edit' &&
      !this.selectedTowerId() &&
      !this.isTrialRunning() &&
      this.phase() === 'defense' &&
      this.canPlaceSelectedTypeAt(hover)
    ) {
      const type = findTowerType(selectedTypeId);
      if (type) {
        this.drawRangeRing(ctx, hover.x, hover.y, type.range, 'rgba(120, 200, 255, 0.5)');
      }
    }

    for (const tower of this.towers()) {
      const isSelected = tower.id === this.selectedTowerId();
      const type = findTowerType(tower.typeId);
      const center = cellCenterPx(tower.position);

      if (isSelected && type) {
        this.drawRangeRing(
          ctx,
          tower.position.x,
          tower.position.y,
          type.range,
          'rgba(120, 200, 255, 0.8)',
        );
      }

      if (!this.drawSprite(ctx, tower.typeId, center.x, center.y, CELL_SIZE * 0.85)) {
        ctx.fillStyle = isSelected ? '#5fb0ff' : '#8fd0ff';
        ctx.beginPath();
        ctx.arc(center.x, center.y, CELL_SIZE / 2 - 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#0b0d12';
        ctx.font = `${CELL_SIZE * 0.4}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((type?.name ?? '?').charAt(0).toUpperCase(), center.x, center.y);
      }

      if (isSelected) {
        ctx.strokeStyle = '#5fb0ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(center.x, center.y, CELL_SIZE / 2 - 4, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    for (const monster of this.trialMonsters()) {
      const { x: cx, y: cy } = worldToPx(monster.position);
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
      const from = projectile.from;
      const to = projectile.to;
      const bx = from.x + (to.x - from.x) * t;
      const by = from.y + (to.y - from.y) * t;

      ctx.strokeStyle = `rgba(255, 224, 140, ${alpha * 0.6})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(bx, by);
      ctx.stroke();

      ctx.fillStyle = `rgba(255, 224, 140, ${alpha})`;
      ctx.beginPath();
      ctx.arc(bx, by, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    for (const splash of this.splashes) {
      const t = (now - splash.firedAtMs) / SPLASH_DURATION_MS;
      if (t < 0 || t > 1) {
        continue;
      }
      const { x: cx, y: cy } = splash.position;
      const radiusPx = splash.radiusPx * (0.3 + 0.7 * t);
      const alpha = 1 - t;

      ctx.fillStyle = `rgba(255, 140, 60, ${alpha * 0.25})`;
      ctx.beginPath();
      ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = `rgba(255, 180, 90, ${alpha * 0.9})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private hexPath(ctx: CanvasRenderingContext2D, coord: GridCoord): void {
    const corners = hexCornersPx(coord);
    ctx.beginPath();
    corners.forEach((corner, index) => {
      if (index === 0) {
        ctx.moveTo(corner.x, corner.y);
      } else {
        ctx.lineTo(corner.x, corner.y);
      }
    });
    ctx.closePath();
  }

  private fillHex(ctx: CanvasRenderingContext2D, coord: GridCoord): void {
    this.hexPath(ctx, coord);
    ctx.fill();
  }

  private strokeHex(ctx: CanvasRenderingContext2D, coord: GridCoord): void {
    this.hexPath(ctx, coord);
    ctx.stroke();
  }

  /** Dessine le décor de fond (touffes de végétation, roches…) : purement cosmétique, sous les chemins et le reste. */
  private drawDecor(ctx: CanvasRenderingContext2D, color: string): void {
    ctx.fillStyle = color;
    for (const item of this.decor()) {
      const cx = item.x;
      const cy = item.y;
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
      const center = cellCenterPx(point);
      if (index === 0) {
        ctx.moveTo(center.x, center.y);
      } else {
        ctx.lineTo(center.x, center.y);
      }
    });
    ctx.stroke();
  }

  /** Dessine le sprite `id` centré sur (cx, cy). Retourne false si l'image n'est pas encore prête. */
  private drawSprite(
    ctx: CanvasRenderingContext2D,
    id: string,
    cx: number,
    cy: number,
    size: number,
  ): boolean {
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
    const center = cellCenterPx({ x: cellX, y: cellY });
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(center.x, center.y, range * WORLD_SCALE, 0, Math.PI * 2);
    ctx.stroke();
  }
}
