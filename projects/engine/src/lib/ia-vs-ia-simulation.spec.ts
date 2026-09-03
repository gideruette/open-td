import { describe, expect, it } from 'vitest';
import type { GamePhase, Wave } from 'shared';
import { findMapCatalogEntry } from 'shared';
import { GameEngine } from './engine';
import { evolveAttackWave } from './ia-attack-player';
import { playDefensePhase } from './ia-defense-player';

/** Bornes raisonnables pour un run de script rapide (`playAttackPhase` a des valeurs bien plus
 * lourdes — maxLanes/populationSize — encore en cours de réglage dans ia-attack-player.ts). */
const ATTACK_MAX_LANES = 3;
const ATTACK_POPULATION_SIZE = 20;

/**
 * Carte jouée, prise au catalogue partagé (`shared`) : c'est exactement celle du jeu, rivière
 * comprise et sans le moindre chemin prédéfini. Une copie locale de la géométrie avait fini par
 * dériver — spawn fixe, deux routes pré-câblées, aucune rivière — et cette partie ne mesurait plus
 * rien de réel : la défense disposait de cases que la rivière interdit, et l'attaque de deux
 * autoroutes qu'elle doit normalement tracer et payer elle-même.
 */
const MAP_ID = 'clairiere-02';

/** Temps de réflexion accordé à chaque IA par phase (vs 2000 ms en jeu réel, réduit pour un run rapide). */
const AI_THINK_TIME_MS = 300;
/** Garde-fou : rien côté moteur ne borne le nombre de paliers, la partie doit se conclure avant. */
const MAX_PALIERS = 100;

describe('Simulation IA vs IA', () => {
  it(
    "joue une partie jusqu'au bout et logue le résultat",
    async () => {
      const { geometry, startingData } = findMapCatalogEntry(MAP_ID)!;
      const engine = new GameEngine();
      engine.startRun(geometry, startingData);

      let winner: 'attack' | 'defense' | undefined;
      console.log(`\n=== Partie IA vs IA — carte "${MAP_ID}" ===`);

      for (let i = 0; i < MAX_PALIERS && !winner; i++) {
        // La carte est relue à chaque tour : elle change au fil de la partie, `resolveAttackSuccess`
        // y figeant les voies de chaque attaque victorieuse (`persistWaveRoutes` : chemins + spawns).
        // Repartir de la géométrie du catalogue ferait raisonner les deux IA sur une carte qui n'est
        // plus celle du moteur — et notamment sur des cases qu'elles croiraient encore constructibles.
        const currentMap = engine.getMap()!;

        // Plus de vague #0 pré-construite (CONCEPTION.md §3) : le palier 1 est une vraie phase
        // Attaque, jouée contre les tours actuellement posées (aucune au tout premier tour).
        const attackWave: Wave = await evolveAttackWave(
          currentMap,
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

        // Forteresse persistante : `playDefensePhase` reçoit les tours héritées et le budget brut
        // du palier ; `applyFortressLayout` aligne sans vider le plateau.
        const wave = engine.getVagueCourante() as Wave;
        const inherited = engine.getTowers();
        const towers =
          (await playDefensePhase({
            map: engine.getMap()!,
            wave,
            defenseBudget: engine.getDefenseBudget(),
            chateauMaxHp: engine.getChateauMaxHp(),
            maxTime: AI_THINK_TIME_MS,
            existingTowers: inherited,
          })) ?? [];
        engine.applyFortressLayout(towers);
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
