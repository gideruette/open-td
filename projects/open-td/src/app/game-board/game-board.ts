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
  isDevMode,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { DecimalPipe } from '@angular/common';
import type { DefenseSimulation, MonsterInstance, ShotEvent } from 'engine';
import {
  cellsBetween,
  expandPathCells,
  isBorderCell,
  isChateauCell,
  isRiverCell,
  isSpawnCell,
  selectTarget,
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
  GridCoord,
  MapBiomeColors,
  MapPath,
  TowerInstance,
  TowerType,
  Wave,
} from 'shared';
import { Tooltip, type TooltipStat } from '../ui/tooltip/tooltip';
import { BoardBudgetService } from './board-budget.service';
import type { MatchSlots, MonsterView } from './board-types';
import { BoardDefenseService } from './board-defense.service';
import { BoardEngineService } from './board-engine.service';
import { formatMonsterStats, formatTowerStats } from './board-format';
import { BoardHud } from './board-hud/board-hud';
import { BoardLanesService } from './board-lanes.service';
import { BoardLaunchService } from './board-launch.service';
import { AI_THINK_TIME_MS, BoardMatchService } from './board-match.service';
import { BoardMatchResult } from './board-match-result/board-match-result';
import { BoardMessage } from './board-message/board-message';
import { BoardMessageService } from './board-message.service';
import { BoardStatus } from './board-status/board-status';
import { BoardTrialService } from './board-trial.service';

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
/**
 * Doit valoir `TICK_INTERVAL_MS` : le projectile part en anticipation du tick où il touchera
 * réellement sa cible (voir `predictNextTickShots`), pour arriver pile quand les hp baissent.
 */
const PROJECTILE_DURATION_MS = TICK_INTERVAL_MS;
const SPLASH_DURATION_MS = 220;
/** Durée du flash + recul affiché sur un monstre touché par un projectile. */
const HIT_EFFECT_DURATION_MS = 180;
/** Amplitude du recul (pixels) à l'impact, dans le sens du tir. */
const HIT_RECOIL_PX = CELL_SIZE * 0.22;
/** Distance en pixels sous laquelle deux monstres sont considérés superposés à l'écran. */
const CLUSTER_DISTANCE_PX = CELL_SIZE * 0.55;
/** Rayon du petit cercle sur lequel sont répartis les monstres d'un même amas. */
const CLUSTER_SPREAD_PX = CELL_SIZE * 0.4;
/** Vitesse de lissage (0..1) du décalage d'amas d'une frame à l'autre. */
const CLUSTER_EASE = 0.18;
/** Zoom minimal (légèrement sous le fit pour pouvoir dézoomer). */
const VIEW_ZOOM_MIN = 0.75;
const VIEW_ZOOM_MAX = 3.5;
/** Déplacement souris/toucher avant de considérer un drag comme un pan (pas un clic). */
const PAN_DRAG_THRESHOLD_PX = 10;
/** Marge de pan autorisée hors cadre (sinon ×1 = pan impossible = conflit avec la pose). */
const PAN_EDGE_MARGIN_PX = 64;
const SPRITE_IDS = [
  'archer',
  'canon',
  'glace',
  'catapulte',
  'goblin',
  'orc',
  'golem',
  'rat',
  'loup',
  'brute',
  'chevalier_noir',
  'saboteur',
  'necrophage',
  'gelee',
  'gelee_mini',
  'troll_glace',
  'chateau',
  'spawn',
];
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

/** Assombrit (`percent` < 0) ou éclaircit (`percent` > 0) une couleur hex de -1 à 1. */
function shadeColor(hex: string, percent: number): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const target = percent < 0 ? 0 : 255;
  const ratio = Math.min(1, Math.abs(percent));
  const mix = (channel: number) => Math.round(channel + (target - channel) * ratio);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
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
      if (
        isChateauCell(map, { x, y }) ||
        isSpawnCell(map, { x, y }) ||
        isRiverCell(map, { x, y })
      ) {
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

/** Largeur du chemin dessiné, utilisée à la fois pour le tracé et pour caler la texture dessus. */
const PATH_WIDTH = CELL_SIZE * 0.36;
/** Multiplicateur de largeur appliqué à une rivière par rapport à un chemin (rendu plus large). */
const RIVER_WIDTH_SCALE = 1.5;

/** Moucheture (caillou/terre) semée sur un chemin pour lui donner un peu de relief. */
interface PathSpeckle {
  x: number;
  y: number;
  radius: number;
  /** true = moucheture sombre (creux), false = moucheture claire (caillou). */
  dark: boolean;
}

/**
 * Sème des mouchetures le long de chaque chemin donné, déterministe (même carte ⇒ même texture).
 * Réutilisé pour les chemins et pour les rivières (même rendu, `seedPrefix` distinct).
 */
function generatePathTexture(paths: readonly MapPath[], seedPrefix: string): PathSpeckle[] {
  const speckles: PathSpeckle[] = [];
  paths.forEach((path, pathIndex) => {
    const random = seededRandom(hashString(`${seedPrefix}:${path.id ?? pathIndex}`));
    const cells = expandPathCells(path);
    for (let i = 0; i < cells.length - 1; i++) {
      const from = cellCenterPx(cells[i]);
      const to = cellCenterPx(cells[i + 1]);
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const segmentLength = Math.hypot(dx, dy) || 1;
      const normalX = -dy / segmentLength;
      const normalY = dx / segmentLength;
      const speckleCount = Math.max(2, Math.round(segmentLength / (CELL_SIZE * 0.35)));
      for (let s = 0; s < speckleCount; s++) {
        const t = (s + random() * 0.7) / speckleCount;
        const offset = (random() - 0.5) * PATH_WIDTH;
        speckles.push({
          x: from.x + dx * t + normalX * offset,
          y: from.y + dy * t + normalY * offset,
          radius: CELL_SIZE * (0.03 + random() * 0.035),
          dark: random() < 0.5,
        });
      }
    }
  });
  return speckles;
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

/** Flash + recul bref affiché sur un monstre au moment où un projectile l'atteint. */
interface HitEffectView {
  monsterId: string;
  /** Angle (radians) du tir, tour → cible : direction dans laquelle le monstre recule. */
  angle: number;
  firedAtMs: number;
}

/** Plateau de jeu : grille + phase Défense (placement/targeting) + phase Attaque (composition/tracé/chemins). */
@Component({
  selector: 'otd-game-board',
  imports: [BoardHud, BoardMatchResult, BoardMessage, BoardStatus, DecimalPipe, Tooltip],
  providers: [
    BoardBudgetService,
    BoardEngineService,
    BoardLaunchService,
    BoardMatchService,
    BoardMessageService,
    BoardTrialService,
    BoardDefenseService,
    BoardLanesService,
  ],
  templateUrl: './game-board.html',
  styleUrl: './game-board.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GameBoard implements OnInit {
  readonly mapId = input.required<string>();
  readonly slots = input.required<MatchSlots>();
  readonly restart = output<void>();

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
  protected readonly pathTexture = signal<readonly PathSpeckle[]>([]);
  protected readonly riverTexture = signal<readonly PathSpeckle[]>([]);
  private projectiles: ProjectileView[] = [];
  private splashes: SplashView[] = [];
  private hitEffects: HitEffectView[] = [];
  /** Décalage courant (lissé) de chaque monstre pour désempiler les sprites trop proches à l'écran. */
  private readonly clusterOffsets = new Map<string, GridCoord>();
  /** Dernier angle (radians) auquel chaque tour a visé une cible ; conservé tant qu'aucune cible n'est à portée. */
  private readonly towerFacing = new Map<string, number>();
  private projectileAnimationHandle: number | undefined;

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

  private readonly gameState = inject(BoardEngineService);
  private readonly defenseService = inject(BoardDefenseService);
  private readonly lanesService = inject(BoardLanesService);
  private readonly trialService = inject(BoardTrialService);
  private readonly budget = inject(BoardBudgetService);
  private readonly launchService = inject(BoardLaunchService);
  private readonly messages = inject(BoardMessageService);
  private readonly matchService = inject(BoardMatchService);

  /** Issue de la partie (vainqueur déclaré) une fois qu'une IA a échoué à trouver une solution à temps. */
  protected readonly matchOutcome = this.matchService.outcome;
  /** Vrai pendant que l'IA calcule son coup : affiche un loader plutôt qu'un changement de phase brutal. */
  protected readonly aiThinking = this.matchService.isThinking;
  /** Nombre d'individus notés et score du meilleur trouvé jusqu'ici pendant une recherche IA en cours. */
  protected readonly aiProgress = this.matchService.aiProgress;
  /** Debug uniquement (`isDevMode()`) : affiche `aiProgress` sous le loader « L'IA réfléchit... ». */
  protected readonly showAiDebug = computed(() => isDevMode() && this.aiProgress() !== undefined);
  /** Vrai quand l'écran de fin de partie est replié pour laisser inspecter la carte avant de rejouer. */
  protected readonly inspectingMap = signal(false);

  protected readonly map = this.gameState.map;
  protected readonly towers = this.gameState.towers;
  protected readonly phase = this.gameState.phase;
  protected readonly palier = this.gameState.palier;
  protected readonly vagueCourante = this.gameState.vagueCourante;
  protected readonly chateauMaxHp = this.gameState.chateauMaxHp;

  /** Type de tour prévisualisé sur la case choisie (barre du bas). */
  protected readonly selectedTypeId = this.defenseService.selectedTypeId;
  /** Case choisie (vide ou occupée) : la barre du bas propose d'y construire ou d'en supprimer la tour. */
  protected readonly pickingCell = this.defenseService.pickingCell;
  /** Tour posée sur la case choisie, s'il y en a une (sinon la case est libre). */
  protected readonly pickingTower = this.defenseService.pickingTower;
  /** Vrai tant qu'une case (vide ou occupée) est choisie dans la barre du bas. */
  protected readonly isPickingTower = this.defenseService.isPicking;

  protected readonly lanes = this.lanesService.lanes;
  protected readonly activeLaneIndex = this.lanesService.activeLaneIndex;
  protected readonly activeLane = this.lanesService.activeLane;
  /** Points déjà cliqués du tracé en cours ; `undefined` = pas en train de tracer. */
  protected readonly drawingPath = this.lanesService.drawingPath;
  protected readonly isDrawingPath = this.lanesService.isDrawingPath;
  /** Main (pan) tant qu'aucun tracé n'est actif. */
  protected readonly boardTool = this.lanesService.boardTool;

  protected readonly trialChateauHp = this.trialService.chateauHp;
  protected readonly trialBreachCount = this.trialService.breachCount;
  protected readonly trialMonsters = this.trialService.monsters;
  protected readonly trialOutcome = this.trialService.outcome;
  protected readonly isTrialRunning = this.trialService.isRunning;

  /** Case survolée (souris/toucher) : pour le curseur et la surbrillance de la case. */
  protected readonly hoverCell = signal<GridCoord | undefined>(undefined);

  /** Infobulle affichée au survol d'une tour posée ou d'un monstre sur le plateau. */
  protected readonly boardTooltip = signal<BoardTooltip | undefined>(undefined);

  /** Caméra : zoom et pan CSS sur le canvas (navigation dans la carte). */
  protected readonly viewZoom = signal(1);
  protected readonly viewPanX = signal(0);
  protected readonly viewPanY = signal(0);
  protected readonly isPanning = signal(false);
  protected readonly viewTransform = computed(
    () => `translate(${this.viewPanX()}px, ${this.viewPanY()}px) scale(${this.viewZoom()})`,
  );

  /** Curseur du canvas : pointer au survol d'une case (sélectionnable), grab sinon. */
  protected readonly canvasCursor = computed(() => {
    if (this.isPanning()) {
      return 'grabbing';
    }
    return this.hoverCell() ? 'pointer' : 'grab';
  });
  protected readonly canLaunch = computed(() => {
    if (this.isTrialRunning() || this.matchService.isOver() || this.matchService.isThinking()) {
      return false;
    }
    if (this.phase() === 'defense') {
      return !!this.vagueCourante();
    }
    const lanes = this.lanes();
    return (
      !this.isDrawingPath() && lanes.length > 0 && lanes.every((lane) => lane.units.length > 0)
    );
  });
  /** Tour cliquée en phase Attaque, dont la portée est affichée sur la carte (`undefined` = aucune). */
  protected readonly selectedAttackTowerId = signal<string | undefined>(undefined);
  protected readonly selectedAttackTower = computed(() => {
    const id = this.selectedAttackTowerId();
    return id ? this.towers().find((tower) => tower.id === id) : undefined;
  });

  /** Repli affiché au-dessus de la carte tant qu'aucune voie n'est composée en phase Attaque (à vous de jouer). */
  protected readonly attackNoRouteHint = computed(() => {
    if (this.phase() !== 'attack' || this.lanes().length > 0 || this.isDrawingPath()) {
      return undefined;
    }
    if (this.isTrialRunning() || this.matchService.isOver() || this.matchService.isThinking()) {
      return undefined;
    }
    if (this.matchService.currentMoverKind('attack') === 'ai') {
      return undefined;
    }
    return 'Cliquez sur une case de bord pour ajouter un point d’arrivée des monstres, puis tracez un chemin jusqu’au château.';
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
      this.pickingCell();
      this.hoverCell();
      this.isPanning();
      this.selectedTypeId();
      this.boardTool();
      this.phase();
      this.lanes();
      this.activeLaneIndex();
      this.drawingPath();
      this.selectedAttackTowerId();
      this.trialMonsters();
      this.trialChateauHp();
      this.chateauMaxHp();
      this.spriteVersion();
      this.biomeColors();
      this.decor();
      this.draw();
    });

    effect(() => {
      this.launchService.set(this.canLaunch(), this.isTrialRunning());
    });
    this.launchService.requested.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.onLaunch();
    });
  }

  ngOnInit(): void {
    void this.bootstrap();
  }

  protected onLaunch(): void {
    if (this.phase() === 'defense') {
      this.startTrial();
      return;
    }
    this.startAttack();
  }

  /** Replie l'écran de fin de partie pour laisser inspecter la carte avant de relancer. */
  protected onInspectMap(): void {
    this.inspectingMap.set(true);
  }

  /** Ramène l'écran de fin de partie au premier plan après une inspection de la carte. */
  protected onResumeMatchResult(): void {
    this.inspectingMap.set(false);
  }

  // ---- Caméra (pan / zoom) -----------------------------------------------

  protected onViewPointerDown(event: PointerEvent): void {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    event.preventDefault();
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
      this.isPanning.set(true);
      this.hoverCell.set(undefined);
      this.boardTooltip.set(undefined);
    }
    if (session.dragged) {
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

    if (this.activePointers.size === 1) {
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

  /** Lance vagueCourante contre la forteresse actuelle. */
  protected startTrial(): void {
    const wave = this.vagueCourante();
    if (!wave || this.isTrialRunning()) {
      return;
    }
    this.defenseService.clearSelection();
    this.lanesService.setPanTool();
    this.messages.set(undefined);
    this.activeTrial = this.gameState.engine.startDefenseTrial();
    this.trialService.setChateauHp(this.activeTrial.getChateauHp());
    this.trialService.setMonsters([]);
    this.trialService.setOutcome(this.activeTrial.getOutcome());
    this.scheduleTrialTick();
  }

  // ---- Phase Attaque : composition des voies ---------------------------

  /** Lance la vague composée (toutes les voies non vides) contre la forteresse figée. */
  protected startAttack(): void {
    if (this.phase() !== 'attack' || this.isTrialRunning() || this.isDrawingPath()) {
      return;
    }
    const activeLanes = this.lanes().filter((lane) => lane.units.length > 0);
    if (activeLanes.length === 0) {
      return;
    }
    const wave = this.lanesService.toWave(activeLanes);
    this.pendingAttackWave = wave;
    this.lanesService.setPanTool();
    this.selectedAttackTowerId.set(undefined);
    this.messages.set(undefined);
    this.activeTrial = this.gameState.engine.startAttackTrial(wave);
    this.trialService.setChateauHp(this.activeTrial.getChateauHp());
    this.trialService.setBreachCount(this.activeTrial.getBreachCount());
    this.trialService.setMonsters([]);
    this.trialService.setOutcome(this.activeTrial.getOutcome());
    this.scheduleTrialTick();
  }

  // ---- Interaction canvas commune --------------------------------------

  /**
   * Tap court : sélectionne une case (défense) ou une voie (attaque), ou avance un tracé en cours.
   */
  protected onCanvasTap(event: PointerEvent): void {
    if (this.matchService.isOver() || this.matchService.isThinking()) {
      return;
    }
    const coord = this.toGridCoord(event);
    if (!coord) {
      // En dehors de la grille : annule la case choisie en phase Défense, ou la tour sélectionnée en Attaque.
      if (this.phase() === 'defense' && this.isPickingTower()) {
        this.defenseService.clearSelection();
      } else if (this.phase() === 'attack') {
        this.selectedAttackTowerId.set(undefined);
      }
      return;
    }

    if (this.phase() === 'attack') {
      if (this.isTrialRunning()) {
        return;
      }
      if (this.isDrawingPath()) {
        this.lanesService.handleTracingClick(coord);
        return;
      }
      // Tour cliquée : affiche (ou masque, si déjà sélectionnée) sa portée sur la carte.
      const tappedTower = this.towers().find(
        (tower) => tower.position.x === coord.x && tower.position.y === coord.y,
      );
      if (tappedTower) {
        this.selectedAttackTowerId.update((id) => (id === tappedTower.id ? undefined : tappedTower.id));
        return;
      }
      // Clic ailleurs que sur la tour sélectionnée : efface sa portée affichée.
      this.selectedAttackTowerId.set(undefined);
      const laneIndex = this.lanes().findIndex((lane) =>
        this.lanesService.pathContainsCell(lane.path, coord),
      );
      if (laneIndex !== -1) {
        this.lanesService.selectLane(laneIndex);
        return;
      }
      // Case sans route existante mais spawn possible (existant ou bord éligible) : démarre
      // directement un nouveau tracé, sans passer par l'outil « Tracer ».
      const map = this.map();
      if (
        map &&
        (isSpawnCell(map, coord) || (isBorderCell(map, coord) && !isChateauCell(map, coord)))
      ) {
        this.lanesService.startTracing();
        this.lanesService.handleTracingClick(coord);
      }
      return;
    }

    if (this.phase() !== 'defense' || this.isTrialRunning()) {
      return;
    }

    this.defenseService.pickCell(coord);
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
  private computeBoardTooltip(event: {
    clientX: number;
    clientY: number;
  }): BoardTooltip | undefined {
    const coord = this.toGridCoord(event);
    if (!coord) {
      return undefined;
    }

    const viewport = this.viewportRef()?.nativeElement;
    const rect = viewport?.getBoundingClientRect();
    const left = rect ? event.clientX - rect.left + 14 : 14;
    const top = rect ? event.clientY - rect.top + 14 : 14;

    const tower = this.towers().find((t) => t.position.x === coord.x && t.position.y === coord.y);
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
    const monsters = trial.getMonsters();
    this.trialService.setChateauHp(trial.getChateauHp());
    this.trialService.setBreachCount(trial.getBreachCount());
    this.trialService.setMonsters(
      monsters.map((monster) => ({
        id: monster.id,
        position: trial.getMonsterPosition(monster),
        hp: monster.hp,
        typeId: monster.typeId,
        distance: monster.distance,
      })),
    );
    this.trialService.setOutcome(trial.getOutcome());

    const firedAtMs = performance.now();
    const shots = trial.getShotsThisTick();
    let hasNewAnimation = false;
    if (shots.length > 0) {
      // Les hp du monstre visé sont déjà décrémentés à ce tick : le flash + recul doit apparaître
      // immédiatement (et non à l'arrivée visuelle du projectile, déjà lancé au tick précédent en
      // anticipation — voir plus bas) pour coïncider avec la baisse de hp.
      for (const shot of shots) {
        const targetId = this.findNearestMonsterId(trial, monsters, shot.targetPosition);
        if (!targetId) {
          continue;
        }
        const towerPx = cellCenterPx(shot.towerPosition);
        const targetPx = worldToPx(shot.targetPosition);
        this.hitEffects.push({
          monsterId: targetId,
          angle: Math.atan2(targetPx.y - towerPx.y, targetPx.x - towerPx.x),
          firedAtMs,
        });
      }
      const splashShots = shots.filter((shot): shot is typeof shot & { splashRadius: number } =>
        Boolean(shot.splashRadius),
      );
      if (splashShots.length > 0) {
        // Idem : l'explosion coïncide avec la baisse de hp plutôt qu'avec l'arrivée du projectile.
        this.splashes.push(
          ...splashShots.map((shot) => ({
            position: worldToPx(shot.targetPosition),
            radiusPx: shot.splashRadius * WORLD_SCALE,
            firedAtMs,
          })),
        );
      }
      hasNewAnimation = true;
    }

    if (running) {
      // Anticipe les tirs du prochain tick : le projectile part dès maintenant pour arriver pile
      // quand `trial.step()` appliquera réellement ses dégâts (voir `DefenseSimulation.clone()`).
      const predictedShots = this.predictNextTickShots(trial);
      if (predictedShots.length > 0) {
        this.projectiles.push(
          ...predictedShots.map((shot) => ({
            from: cellCenterPx(shot.towerPosition),
            to: worldToPx(shot.targetPosition),
            firedAtMs,
          })),
        );
        hasNewAnimation = true;
      }
    }

    if (hasNewAnimation) {
      this.ensureProjectileAnimationRunning();
    }

    if (running) {
      this.scheduleTrialTick();
      return;
    }
    this.concludeTrial(trial);
  }

  /** Prévisualise, sans altérer `trial`, les tirs qui surviendront au tick suivant. */
  private predictNextTickShots(trial: DefenseSimulation): readonly ShotEvent[] {
    const preview = trial.clone();
    preview.step();
    return preview.getShotsThisTick();
  }

  private concludeTrial(trial: DefenseSimulation): void {
    // Une phase terminée ne doit laisser traîner ni projectile en vol, ni flash/explosion résiduels
    // (visés sur des monstres qui n'existent plus une fois la phase suivante commencée).
    this.clearProjectileEffects();
    const outcome = trial.getOutcome();
    // Capturé avant tout resolve*Success() : `phase()` change dès la résolution d'un succès.
    const phaseJustPlayed = this.phase() as 'attack' | 'defense';
    const moverWasAi = this.matchService.currentMoverKind(phaseJustPlayed) === 'ai';

    if (phaseJustPlayed === 'defense') {
      if (outcome === 'success') {
        this.gameState.engine.resolveDefenseSuccess();
        this.gameState.refresh();
        this.lanesService.applySavedPlan((lanes) => (lanes.length > 0 ? 0 : undefined));
        this.defenseService.clearSelection();
        this.lanesService.setPanTool();
        this.messages.set(
          `Les Chevaliers l'ont emporté, château intact ! La forteresse est figée : ${this.nextMoverPhrase('attack')}.`,
        );
        this.resetTrialDisplay();
        this.maybeStartAiTurn();
      } else if (moverWasAi) {
        this.declareAiFailure('defense');
        this.trialService.setMonsters([]);
      } else {
        this.messages.set(
          'Les Chevaliers ont échoué — le château a encaissé des dégâts. Ajustez vos tours et réessayez.',
        );
        this.trialService.setMonsters([]);
      }
    } else {
      if (outcome === 'success') {
        const wave = this.pendingAttackWave;
        if (wave) {
          this.gameState.engine.resolveAttackSuccess(wave);
        }
        this.gameState.refresh();
        // Le plan d'attaque n'est pas remis à zéro : il devient le plan sauvegardé, point de
        // départ du prochain cycle — CONCEPTION.md §5.2, §11 décision 12.
        this.lanesService.applySavedPlan(() => undefined);
        this.defenseService.clearSelection();
        this.lanesService.setPanTool();
        this.messages.set(
          `Château détruit ! Palier ${this.palier()} — ${this.nextMoverPhrase('defense')}.`,
        );
        this.resetTrialDisplay();
        this.maybeStartAiTurn();
      } else if (moverWasAi) {
        this.declareAiFailure('attack');
        this.trialService.setMonsters([]);
      } else {
        this.messages.set(`Château non détruit ! Recomposez et réessayez.`);
        this.trialService.setMonsters([]);
      }
    }
    this.pendingAttackWave = undefined;
  }

  private resetTrialDisplay(): void {
    this.trialService.reset();
  }

  // ---- Tours joués par l'IA (système de slots) --------------------------

  /** Déclenche le tour de l'IA si le slot de la phase courante lui est assigné. */
  private maybeStartAiTurn(): void {
    if (this.matchService.isOver() || this.isTrialRunning()) {
      return;
    }
    if (this.matchService.currentMoverKind(this.phase() as 'attack' | 'defense') !== 'ai') {
      return;
    }
    this.matchService.setThinking(true);
    // Laisse Angular peindre le loader « L'IA réfléchit... » avant de lancer la recherche —
    // celle-ci met ensuite la carte à jour en direct avec le meilleur coup trouvé à chaque
    // génération (`onBestFound`), jusqu'au résultat final.
    setTimeout(() => void this.runAiTurn(), 50);
  }

  private async runAiTurn(): Promise<void> {
    const phaseNow = this.phase();
    if (phaseNow === 'defense') {
      await this.defenseService.playAiDefenseTurn(AI_THINK_TIME_MS);
      this.matchService.setThinking(false);
      this.startTrial();
      return;
    }
    await this.lanesService.playAiAttackTurn(AI_THINK_TIME_MS);
    this.matchService.setThinking(false);
    if (!this.lanes().some((lane) => lane.units.length > 0)) {
      // L'IA n'a rien pu composer : échec direct, aucune épreuve à lancer.
      this.declareAiFailure('attack');
      return;
    }
    this.startAttack();
  }

  /** Formule qui va jouer la phase `nextPhase` à venir — adapte le message selon le slot (IA ou vous). */
  private nextMoverPhrase(nextPhase: 'attack' | 'defense'): string {
    const isAi = this.matchService.currentMoverKind(nextPhase) === 'ai';
    return nextPhase === 'attack'
      ? isAi
        ? "l'IA prend le contrôle des Monstres"
        : 'à vous de jouer les Monstres'
      : isAi
        ? "l'IA prend le contrôle des Chevaliers"
        : 'à vous de jouer les Chevaliers';
  }

  /** L'IA du rôle `phase` n'a pas trouvé de solution à temps : l'autre rôle (humain) remporte la partie. */
  private declareAiFailure(phase: 'attack' | 'defense'): void {
    this.matchService.declareVictory(phase);
    const winnerLabel = phase === 'attack' ? 'Chevaliers' : 'Monstres';
    const failedLabel = phase === 'attack' ? 'Monstres' : 'Chevaliers';
    this.messages.set(
      `L'IA (${failedLabel}) n'a pas trouvé de solution à temps : victoire pour les ${winnerLabel} !`,
    );
  }

  /** Stoppe l'animation en cours et efface projectiles, explosions et flashs affichés. */
  private clearProjectileEffects(): void {
    if (this.projectileAnimationHandle !== undefined) {
      cancelAnimationFrame(this.projectileAnimationHandle);
      this.projectileAnimationHandle = undefined;
    }
    this.projectiles = [];
    this.splashes = [];
    this.hitEffects = [];
    this.draw();
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
      this.hitEffects = this.hitEffects.filter(
        (effect) => now - effect.firedAtMs < HIT_EFFECT_DURATION_MS,
      );
      this.draw();
      this.projectileAnimationHandle =
        this.projectiles.length > 0 || this.splashes.length > 0 || this.hitEffects.length > 0
          ? requestAnimationFrame(step)
          : undefined;
    };
    this.projectileAnimationHandle = requestAnimationFrame(step);
  }

  /** Monstre le plus proche (world-space) de la position visée par un tir, pour lui appliquer le flash d'impact. */
  private findNearestMonsterId(
    trial: DefenseSimulation,
    monsters: readonly MonsterInstance[],
    target: GridCoord,
  ): string | undefined {
    let bestId: string | undefined;
    let bestDistSq = Infinity;
    for (const monster of monsters) {
      const pos = trial.getMonsterPosition(monster);
      const dx = pos.x - target.x;
      const dy = pos.y - target.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
        bestId = monster.id;
      }
    }
    return bestId;
  }

  /** Effet de flash/recul actif sur ce monstre à l'instant `now`, s'il en a un (le plus récent sinon). */
  private activeHitEffect(monsterId: string, now: number): HitEffectView | undefined {
    let latest: HitEffectView | undefined;
    for (const effect of this.hitEffects) {
      if (effect.monsterId !== monsterId) {
        continue;
      }
      const elapsed = now - effect.firedAtMs;
      if (elapsed < 0 || elapsed >= HIT_EFFECT_DURATION_MS) {
        continue;
      }
      if (!latest || effect.firedAtMs > latest.firedAtMs) {
        latest = effect;
      }
    }
    return latest;
  }

  /**
   * Recalcule et lisse le décalage de chaque monstre trop proche d'un autre à l'écran, pour les
   * répartir en petit cercle plutôt que de les superposer (sinon on n'en voit qu'un seul).
   */
  private updateClusterOffsets(monsters: readonly MonsterView[]): void {
    const activeIds = new Set(monsters.map((monster) => monster.id));
    for (const id of this.clusterOffsets.keys()) {
      if (!activeIds.has(id)) {
        this.clusterOffsets.delete(id);
      }
    }

    const targets = this.computeClusterTargets(monsters);
    for (const monster of monsters) {
      const target = targets.get(monster.id) ?? { x: 0, y: 0 };
      const current = this.clusterOffsets.get(monster.id) ?? { x: 0, y: 0 };
      this.clusterOffsets.set(monster.id, {
        x: current.x + (target.x - current.x) * CLUSTER_EASE,
        y: current.y + (target.y - current.y) * CLUSTER_EASE,
      });
    }
  }

  /** Groupe les monstres dont les sprites se chevaucheraient à l'écran et leur assigne une position en cercle. */
  private computeClusterTargets(monsters: readonly MonsterView[]): Map<string, GridCoord> {
    const points = monsters.map((monster) => ({ id: monster.id, px: worldToPx(monster.position) }));
    const parent = points.map((_, index) => index);
    const find = (index: number): number => {
      while (parent[index] !== index) {
        index = parent[index];
      }
      return index;
    };
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const dx = points[i].px.x - points[j].px.x;
        const dy = points[i].px.y - points[j].px.y;
        if (Math.hypot(dx, dy) < CLUSTER_DISTANCE_PX) {
          const rootI = find(i);
          const rootJ = find(j);
          if (rootI !== rootJ) {
            parent[rootI] = rootJ;
          }
        }
      }
    }

    const groups = new Map<number, { id: string; px: GridCoord }[]>();
    points.forEach((point, index) => {
      const root = find(index);
      const group = groups.get(root);
      if (group) {
        group.push(point);
      } else {
        groups.set(root, [point]);
      }
    });

    const targets = new Map<string, GridCoord>();
    for (const group of groups.values()) {
      if (group.length < 2) {
        continue;
      }
      // Ordre stable (indépendant de l'ordre d'itération courant) pour éviter les sauts de position.
      const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
      const centerX = sorted.reduce((sum, point) => sum + point.px.x, 0) / sorted.length;
      const centerY = sorted.reduce((sum, point) => sum + point.px.y, 0) / sorted.length;
      sorted.forEach((point, index) => {
        const angle = (index / sorted.length) * Math.PI * 2;
        targets.set(point.id, {
          x: centerX + Math.cos(angle) * CLUSTER_SPREAD_PX - point.px.x,
          y: centerY + Math.sin(angle) * CLUSTER_SPREAD_PX - point.px.y,
        });
      });
    }
    return targets;
  }

  private async bootstrap(): Promise<void> {
    const mapId = this.mapId();
    const catalogEntry = findMapCatalogEntry(mapId);
    if (!catalogEntry) {
      this.messages.set('Carte inconnue.');
      return;
    }
    this.biomeColors.set(BIOME_COLORS[catalogEntry.biome]);
    try {
      const map = await fetch(`maps/${mapId}.map.json`).then(
        (response) => response.json() as Promise<GameMap>,
      );
      this.decor.set(generateDecor(map));
      this.riverTexture.set(generatePathTexture(map.rivers ?? [], `${map.id}:river`));
      this.gameState.startRun(map, catalogEntry.startingData);
      this.matchService.configure(this.slots());
      this.resetView();
      this.maybeStartAiTurn();
    } catch (error) {
      console.error('Impossible de charger la carte', error);
      this.messages.set('Impossible de charger la carte.');
    }
  }

  /** Position du curseur en world-space (unité = distance entre centres voisins). */
  private toFractionalCoord(event: {
    clientX: number;
    clientY: number;
  }): { x: number; y: number } | undefined {
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

  /**
   * Bornes de pan sur un axe : carte centrée (± un peu de jeu pour le geste) si elle tient dans
   * le viewport, sinon bornée classiquement pour ne pas la faire sortir entièrement du cadre.
   */
  private panBounds(viewportSize: number, scaledSize: number, margin: number): [number, number] {
    if (scaledSize <= viewportSize) {
      const center = (viewportSize - scaledSize) / 2;
      return [center - margin, center + margin];
    }
    return [viewportSize - scaledSize - margin, margin];
  }

  /** Empêche de faire sortir entièrement la carte du viewport (et la centre si elle y tient). */
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

    const [minX, maxX] = this.panBounds(vw, scaledW, marginX);
    const [minY, maxY] = this.panBounds(vh, scaledH, marginY);

    this.viewPanX.set(Math.min(maxX, Math.max(minX, this.viewPanX())));
    this.viewPanY.set(Math.min(maxY, Math.max(minY, this.viewPanY())));
  }

  /** Vrai si le type de tour courant peut être posé sur `coord` (grille, occupation, budget). */
  private canPlaceSelectedTypeAt(coord: GridCoord): boolean {
    return this.defenseService.canPlaceSelectedTypeAt(coord, this.budget.defense().remaining);
  }

  /** Centre + portée à prévisualiser sur les chemins pour la tour en cours de choix (case sélectionnée). */
  private computeRangePreview(): { center: GridCoord; range: number } | undefined {
    if (this.phase() !== 'defense' || this.isTrialRunning()) {
      return undefined;
    }
    const cell = this.pickingCell();
    const typeId = this.selectedTypeId();
    if (!cell || !typeId) {
      return undefined;
    }
    const type = findTowerType(typeId);
    return type ? { center: cell, range: type.range } : undefined;
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

  /** Cases de la grille (hors bord) situées à `range` de `center`, même métrique que le ciblage moteur. */
  private gridCellsInRange(map: GameMap, center: GridCoord, range: number): GridCoord[] {
    const centerWorld = hexToWorld(center);
    const cells: GridCoord[] = [];
    for (let y = 0; y < map.grid.rows; y++) {
      for (let x = 0; x < map.grid.cols; x++) {
        if (isBorderCell(map, { x, y })) {
          continue;
        }
        const cellWorld = hexToWorld({ x, y });
        if (Math.hypot(cellWorld.x - centerWorld.x, cellWorld.y - centerWorld.y) <= range) {
          cells.push({ x, y });
        }
      }
    }
    return cells;
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
      this.clampPan();
    } else if (!canvas.style.width) {
      this.fitCanvasToViewport();
      this.clampPan();
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
    ctx.lineCap = 'round';
    for (let y = 0; y < map.grid.rows; y++) {
      for (let x = 0; x < map.grid.cols; x++) {
        this.strokeHexSoft(ctx, { x, y });
      }
    }

    const isAttackPhase = this.phase() === 'attack';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Rivières : terrain non constructible, jamais franchi par un chemin (CONCEPTION.md §4).
    // Même rendu que les chemins (berge sombre + remplissage clair + mouchetures), en plus large.
    for (const river of map.rivers ?? []) {
      this.drawTexturedPath(ctx, expandPathCells(river), biome.river, RIVER_WIDTH_SCALE);
    }
    for (const speckle of this.riverTexture()) {
      ctx.fillStyle = speckle.dark ? 'rgba(0, 0, 0, 0.18)' : 'rgba(255, 255, 255, 0.22)';
      ctx.beginPath();
      ctx.arc(speckle.x, speckle.y, speckle.radius, 0, Math.PI * 2);
      ctx.fill();
    }

    // Chemins prédéfinis de la carte : texturé en défense, simple référence estompée en attaque.
    if (isAttackPhase) {
      ctx.strokeStyle = hexToRgba(biome.path, 0.25);
      ctx.lineWidth = CELL_SIZE * 0.4;
      for (const path of map.paths) {
        this.strokePolyline(ctx, expandPathCells(path));
      }
    } else {
      for (const path of map.paths) {
        this.drawTexturedPath(ctx, expandPathCells(path), biome.path);
      }
      for (const speckle of this.pathTexture()) {
        ctx.fillStyle = speckle.dark ? 'rgba(0, 0, 0, 0.16)' : 'rgba(255, 255, 255, 0.18)';
        ctx.beginPath();
        ctx.arc(speckle.x, speckle.y, speckle.radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Portée de la tour cliquée en phase Attaque : teinte les cases qu'elle couvre.
    if (isAttackPhase) {
      const selectedTower = this.selectedAttackTower();
      const selectedType = selectedTower ? findTowerType(selectedTower.typeId) : undefined;
      if (selectedTower && selectedType) {
        ctx.fillStyle = 'rgba(224, 64, 64, 0.22)';
        for (const cell of this.gridCellsInRange(map, selectedTower.position, selectedType.range)) {
          this.fillHex(ctx, cell);
        }
      }
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
      const spawnCenter = cellCenterPx(spawn);
      if (!this.drawSprite(ctx, 'spawn', spawnCenter.x, spawnCenter.y, CELL_SIZE * 1.8)) {
        ctx.fillStyle = '#7a5c2e';
        this.fillHex(ctx, spawn);
      }
    }

    const chateauCenter = cellCenterPx(map.chateau);
    if (!this.drawSprite(ctx, 'chateau', chateauCenter.x, chateauCenter.y, CELL_SIZE * 2)) {
      ctx.fillStyle = '#9b9086';
      ctx.beginPath();
      ctx.arc(chateauCenter.x, chateauCenter.y, CELL_SIZE / 2 - 4, 0, Math.PI * 2);
      ctx.fill();
    }
    this.drawChateauHpBar(ctx, chateauCenter);

    // Case survolée : surbrillance générique (retour visuel « cette case est cliquable »).
    const hover = this.hoverCell();
    if (hover && !this.isPanning()) {
      ctx.save();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      this.fillHex(ctx, hover);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
      ctx.lineWidth = 2;
      this.strokeHex(ctx, hover);
      ctx.restore();
    }

    // Case choisie depuis la barre du bas (vide ou occupée) : contour de sélection.
    const picking = this.pickingCell();
    if (picking) {
      ctx.save();
      ctx.strokeStyle = '#5fb0ff';
      ctx.lineWidth = 3;
      this.strokeHex(ctx, picking);
      ctx.restore();
    }

    // Tour prévisualisée sur une case libre choisie : sprite grisé, même taille qu'une fois posée.
    const previewTypeId = this.selectedTypeId();
    if (
      picking &&
      previewTypeId &&
      !this.pickingTower() &&
      !this.isTrialRunning() &&
      this.phase() === 'defense'
    ) {
      const type = findTowerType(previewTypeId);
      if (type) {
        const affordable = this.canPlaceSelectedTypeAt(picking);
        this.drawRangeRing(
          ctx,
          picking.x,
          picking.y,
          type.range,
          affordable ? 'rgba(120, 200, 255, 0.5)' : 'rgba(255, 143, 122, 0.5)',
        );
        const center = cellCenterPx(picking);
        ctx.save();
        ctx.filter = 'grayscale(1)';
        ctx.globalAlpha = affordable ? 0.75 : 0.45;
        if (!this.drawSprite(ctx, previewTypeId, center.x, center.y, CELL_SIZE * 2)) {
          ctx.fillStyle = '#8fd0ff';
          ctx.beginPath();
          ctx.arc(center.x, center.y, CELL_SIZE - 4, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    for (const tower of this.towers()) {
      const isSelected = tower.id === this.pickingTower()?.id;
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

      this.drawTowerShadow(ctx, center);

      const facing = this.computeTowerFacing(tower, type, center);
      ctx.save();
      ctx.translate(center.x, center.y);
      ctx.rotate(facing);
      ctx.translate(-center.x, -center.y);
      const spriteDrawn = this.drawSprite(ctx, tower.typeId, center.x, center.y, CELL_SIZE * 2);
      ctx.restore();

      if (!spriteDrawn) {
        ctx.fillStyle = isSelected ? '#5fb0ff' : '#8fd0ff';
        ctx.beginPath();
        ctx.arc(center.x, center.y, CELL_SIZE - 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#0b0d12';
        ctx.font = `${CELL_SIZE * 0.7}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText((type?.name ?? '?').charAt(0).toUpperCase(), center.x, center.y);
      }

      if (isSelected) {
        ctx.strokeStyle = '#5fb0ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(center.x, center.y, CELL_SIZE - 2, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    const now = performance.now();
    this.updateClusterOffsets(this.trialMonsters());
    for (const monster of this.trialMonsters()) {
      const base = worldToPx(monster.position);
      const clusterOffset = this.clusterOffsets.get(monster.id);
      let cx = base.x + (clusterOffset?.x ?? 0);
      let cy = base.y + (clusterOffset?.y ?? 0);

      let flashAlpha = 0;
      const hit = this.activeHitEffect(monster.id, now);
      if (hit) {
        const t = (now - hit.firedAtMs) / HIT_EFFECT_DURATION_MS;
        const recoil = HIT_RECOIL_PX * Math.sin(t * Math.PI);
        cx += Math.cos(hit.angle) * recoil;
        cy += Math.sin(hit.angle) * recoil;
        flashAlpha = (1 - t) * 0.85;
      }

      const maxHp = findMonsterType(monster.typeId)?.hp ?? monster.hp;
      const hpRatio = maxHp > 0 ? Math.max(0, monster.hp / maxHp) : 0;
      const radius = CELL_SIZE * 0.44;

      this.drawMonsterShadow(ctx, cx, cy, radius);

      if (!this.drawSprite(ctx, monster.typeId, cx, cy, CELL_SIZE * 1.1, flashAlpha)) {
        ctx.fillStyle = '#e0524a';
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
        if (flashAlpha > 0) {
          ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha})`;
          ctx.beginPath();
          ctx.arc(cx, cy, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      const barWidth = CELL_SIZE * 0.9;
      const barX = cx - barWidth / 2;
      const barY = cy - radius - 6;
      ctx.fillStyle = '#3a1414';
      ctx.fillRect(barX, barY, barWidth, 3);
      ctx.fillStyle = '#7be07a';
      ctx.fillRect(barX, barY, barWidth * hpRatio, 3);
    }

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

  /**
   * Trace uniquement le centre de chaque arête (25%-75%), en laissant les angles ouverts : la
   * grille de fond paraît aérée au lieu d'un pavage à angles vifs, sans risque de couture puisque
   * rien n'est dessiné aux sommets partagés par plusieurs cases.
   */
  private strokeHexSoft(ctx: CanvasRenderingContext2D, coord: GridCoord): void {
    const corners = hexCornersPx(coord);
    ctx.beginPath();
    for (let i = 0; i < corners.length; i++) {
      const start = corners[i];
      const end = corners[(i + 1) % corners.length];
      ctx.moveTo(start.x + (end.x - start.x) * 0.25, start.y + (end.y - start.y) * 0.25);
      ctx.lineTo(start.x + (end.x - start.x) * 0.75, start.y + (end.y - start.y) * 0.75);
    }
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

  /** Dessine un chemin (ou une rivière, `widthScale` > 1) avec un léger relief : bordure sombre en dessous, remplissage clair par-dessus. */
  private drawTexturedPath(
    ctx: CanvasRenderingContext2D,
    points: readonly GridCoord[],
    color: string,
    widthScale = 1,
  ): void {
    ctx.strokeStyle = shadeColor(color, -0.4);
    ctx.lineWidth = PATH_WIDTH * 1.3 * widthScale;
    this.strokePolyline(ctx, points);

    ctx.strokeStyle = color;
    ctx.lineWidth = PATH_WIDTH * widthScale;
    this.strokePolyline(ctx, points);
  }

  /**
   * Trace une ligne lissée passant par le centre de chaque case : aux points intermédiaires, la
   * ligne rejoint le milieu du segment suivant via une courbe (au lieu d'un coin à angle vif).
   */
  private strokePolyline(ctx: CanvasRenderingContext2D, points: readonly GridCoord[]): void {
    if (points.length === 0) {
      return;
    }
    const centers = points.map(cellCenterPx);
    ctx.beginPath();
    ctx.moveTo(centers[0].x, centers[0].y);
    for (let i = 1; i < centers.length - 1; i++) {
      const current = centers[i];
      const next = centers[i + 1];
      const midX = (current.x + next.x) / 2;
      const midY = (current.y + next.y) / 2;
      ctx.quadraticCurveTo(current.x, current.y, midX, midY);
    }
    if (centers.length > 1) {
      const last = centers[centers.length - 1];
      ctx.lineTo(last.x, last.y);
    }
    ctx.stroke();
  }

  /** Ombre au sol de la tour, dessinée hors de toute rotation pour qu'elle ne tourne pas avec le sprite. */
  private drawTowerShadow(ctx: CanvasRenderingContext2D, center: GridCoord): void {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.beginPath();
    ctx.ellipse(
      center.x,
      center.y + CELL_SIZE * 0.75,
      CELL_SIZE * 0.6,
      CELL_SIZE * 0.16,
      0,
      0,
      Math.PI * 2,
    );
    ctx.fill();
    ctx.restore();
  }

  /** Barre de vie du château, affichée au-dessus de son sprite (même style que les monstres). */
  private drawChateauHpBar(ctx: CanvasRenderingContext2D, center: GridCoord): void {
    const maxHp = this.chateauMaxHp();
    if (maxHp <= 0) {
      return;
    }
    const hp = this.trialChateauHp() ?? maxHp;
    const hpRatio = Math.max(0, hp / maxHp);
    const barWidth = CELL_SIZE * 1.8;
    const barX = center.x - barWidth / 2;
    const barY = center.y - CELL_SIZE - 10;
    ctx.fillStyle = '#3a1414';
    ctx.fillRect(barX, barY, barWidth, 5);
    ctx.fillStyle = '#7be07a';
    ctx.fillRect(barX, barY, barWidth * hpRatio, 5);
  }

  /** Ombre au sol d'un monstre, dessinée sous son sprite (proportionnelle à son rayon d'affichage). */
  private drawMonsterShadow(
    ctx: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    radius: number,
  ): void {
    ctx.save();
    ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + radius * 0.85, radius * 0.9, radius * 0.28, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Angle (radians, 0 = vers la droite) auquel orienter le sprite d'une tour vers sa cible courante.
   * Réutilise la même sélection de cible que la simulation (`selectTarget`), indépendamment du
   * cooldown, pour que la tour suive visuellement le monstre qu'elle viserait si elle tirait.
   * Conserve le dernier angle connu tant qu'aucune cible n'est à portée, plutôt que de revenir à 0.
   */
  private computeTowerFacing(
    tower: TowerInstance,
    type: TowerType | undefined,
    center: GridCoord,
  ): number {
    if (!type) {
      return this.towerFacing.get(tower.id) ?? 0;
    }
    const monsters = this.trialMonsters();
    const candidates = monsters.map((monster, index) => ({
      id: String(index),
      distance: monster.distance,
      position: monster.position,
    }));
    const targetId = selectTarget(hexToWorld(tower.position), type.range, candidates);
    if (targetId === undefined) {
      return this.towerFacing.get(tower.id) ?? 0;
    }
    const target = monsters[Number(targetId)];
    const targetPx = worldToPx(target.position);
    const angle = Math.atan2(targetPx.y - center.y, targetPx.x - center.x);
    this.towerFacing.set(tower.id, angle);
    return angle;
  }

  /**
   * Dessine le sprite `id` centré sur (cx, cy). Retourne false si l'image n'est pas encore prête.
   * `flashAlpha` (0..1) surimpose une teinte blanche sur les pixels non transparents du sprite
   * (flash d'impact), en respectant sa silhouette grâce à `source-atop`.
   */
  private drawSprite(
    ctx: CanvasRenderingContext2D,
    id: string,
    cx: number,
    cy: number,
    size: number,
    flashAlpha = 0,
  ): boolean {
    const image = this.sprites.get(id);
    if (!image || !image.complete || image.naturalWidth === 0) {
      return false;
    }
    ctx.drawImage(image, cx - size / 2, cy - size / 2, size, size);
    if (flashAlpha > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha})`;
      ctx.beginPath();
      ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
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
