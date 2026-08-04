import type { MapPath, WaveUnit } from 'shared';

/** Outil actif : Main (pan/zoom) ou Pose/Éditer (actions sur la grille). Dérivé de la sélection. */
export type BoardTool = 'pan' | 'edit';

/** Une voie en cours de composition côté attaquant : un chemin + ses monstres. */
export interface LaneDraft {
  path: MapPath;
  units: WaveUnit[];
}
