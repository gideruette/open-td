import type { GridCoord, MapPath, WaveUnit } from 'shared';

/** Outil actif : Main (pan/zoom) ou Pose/Éditer (actions sur la grille). Dérivé de la sélection. */
export type BoardTool = 'pan' | 'edit';

/** Une voie en cours de composition côté attaquant : un chemin + ses monstres. */
export interface LaneDraft {
  path: MapPath;
  units: WaveUnit[];
}

/** Monstre d'une épreuve en cours, tel qu'affiché sur le plateau. */
export interface MonsterView {
  id: string;
  position: GridCoord;
  hp: number;
  typeId: string;
  /** Distance parcourue le long du chemin ; sert à choisir la cible visée par une tour (voir `selectTarget`). */
  distance: number;
}
