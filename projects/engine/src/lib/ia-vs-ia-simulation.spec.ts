import { describe, expect, it } from 'vitest';
import type { GameMap, GamePhase, Wave } from 'shared';
import { findMapCatalogEntry } from 'shared';
import { GameEngine } from './engine';
import { evolveAttackWave } from './ia-attack-player';
import { playDefensePhase } from './ia-defense-player';

/** Bornes raisonnables pour un run de script rapide (`playAttackPhase` a des valeurs bien plus
 * lourdes — maxLanes/populationSize — encore en cours de réglage dans ia-attack-player.ts). */
const ATTACK_MAX_LANES = 3;
const ATTACK_POPULATION_SIZE = 20;

/** Reprend la géométrie de la carte "clairiere-02" (public/maps/clairiere-02.map.json). */
const MAP: GameMap = {
  id: 'clairiere-02',
  grid: { cols: 16, rows: 12, cell: 'hex', orientation: 'pointy', offset: 'odd-r' },
  chateau: { x: 8, y: 6 },
  spawns: [{ id: 's1', x: 8, y: 11 }],
  paths: [
    { id: 'ouest', nodes: [[8, 11], [1, 11], [1, 1], [8, 1], [8, 6]] },
    { id: 'est', nodes: [[8, 11], [14, 11], [14, 1], [8, 1], [8, 6]] },
  ],
};

/** Temps de réflexion accordé à chaque IA par phase (vs 1500 ms en jeu réel, réduit pour un run rapide). */
const AI_THINK_TIME_MS = 300;
/** Garde-fou : rien côté moteur ne borne le nombre de paliers, la partie doit se conclure avant. */
const MAX_PALIERS = 100;

describe('Simulation IA vs IA', () => {
  it(
    "joue une partie jusqu'au bout et logue le résultat",
    () => {
      const startingData = findMapCatalogEntry('clairiere-02')!.startingData;
      const engine = new GameEngine();
      engine.startRun(MAP, startingData);

      let winner: 'attack' | 'defense' | undefined;
      console.log(`\n=== Partie IA vs IA — carte "${MAP.id}" ===`);

      for (let i = 0; i < MAX_PALIERS && !winner; i++) {
        const wave = engine.getVagueCourante() as Wave;
        const towers =
          playDefensePhase({
            map: MAP,
            wave,
            defenseBudget: engine.getDefenseBudget(),
            chateauMaxHp: engine.getChateauMaxHp(),
            maxTime: AI_THINK_TIME_MS,
          }) ?? [];
        for (const tower of towers) {
          engine.placeTower(tower.typeId, tower.position);
        }
        const defenseTrial = engine.startDefenseTrial();
        const defenseOutcome = defenseTrial.runToCompletion();
        console.log(
          `Palier ${engine.getPalier()} — Défense : ${towers.length} tour(s) posée(s), ` +
            `château à ${defenseTrial.getChateauHp()}/${engine.getChateauMaxHp()} PV → ${defenseOutcome}`,
        );
        if (defenseOutcome === 'failure') {
          winner = 'attack';
          break;
        }
        engine.resolveDefenseSuccess();

        const attackWave: Wave = evolveAttackWave(
          MAP,
          engine.getTowers(),
          engine.getAttackBudget(),
          engine.getChateauMaxHp(),
          undefined,
          ATTACK_MAX_LANES,
          ATTACK_POPULATION_SIZE,
          AI_THINK_TIME_MS,
        );
        const attackTrial = engine.startAttackTrial(attackWave);
        const attackOutcome = attackTrial.runToCompletion();
        console.log(
          `Palier ${engine.getPalier()} — Attaque : ${attackWave.lanes.length} voie(s), ` +
            `${attackTrial.getBreachCount()} brèche(s) → ${attackOutcome}`,
        );
        if (attackOutcome === 'failure') {
          winner = 'defense';
          break;
        }
        engine.resolveAttackSuccess(attackWave);
      }

      const phaseAtEnd: GamePhase = engine.getPhase();
      console.log(
        winner
          ? `>>> RÉSULTAT : ${winner === 'attack' ? 'ATTAQUE' : 'DÉFENSE'} gagne au palier ${engine.getPalier()} (phase "${phaseAtEnd}").`
          : `>>> RÉSULTAT : aucun vainqueur après ${MAX_PALIERS} paliers.`,
      );

      expect(winner).toBeDefined();
    },
    5 * 60_000,
  );
});
