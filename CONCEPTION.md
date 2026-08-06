# Open TD — Document de conception

> Tower-defense / attack en PWA open-source, **solo**.  
> Le joueur **construit sa forteresse**, puis **l’attaque lui-même**.  
> L’alternance défense ↔ attaque se déclenche **uniquement en cas de succès** de la phase en cours.

**Statut** : brouillon v0.5  
**Licence prévue** : MIT (à confirmer)

---

## 1. Vision

Open TD est un jeu de stratégie solo où le joueur est à la fois architecte et assiégeant de **sa propre** forteresse.

1. **Phase Défense** — placer / améliorer des tours, puis **tenir** face à la vague courante.
2. **Phase Attaque** — composer une vague (ordre + itinéraire) pour **détruire** la forteresse qu’il vient de bâtir.
3. **Résolution** — simulation ; succès ou échec de l’objectif de phase.
4. **Succès** → bascule vers l’autre phase. **Échec** → rester dans la phase et réessayer.

**Chaîne des vagues** : seule la **première** vague est pré-construite (data du jeu). Ensuite, chaque vague d’**attaque réussie** est **conservée** telle quelle et devient la vague que la défense suivante doit tenir.

Le plaisir vient du dialogue avec soi-même : _« Ma défense tient contre ce que j’ai moi-même envoyé ? Puis-je inventer mieux pour la faire craquer ? »_

### Promesse joueur

> « Je bâtis une forteresse, je tiens contre la vague sans la moindre égratignure, je la détruis avec une nouvelle composition — et cette composition devient mon prochain défi à défendre. »

---

## 2. Plateforme & contraintes techniques

| Élément | Choix |
|--------|--------|
| Format | **PWA** (installable, offline-first) |
| Cible | Desktop + mobile (tactile prioritaire) |
| Rendu | **Canvas 2D** (dans Angular) |
| Stack | **Angular 22** + TypeScript + Canvas 2D |
| Grille | **Hexagonale** (pointy-top, offset odd-r) |
| Persistance | IndexedDB / localStorage (progression, forteresse, replays) |
| Multijoueur | **Hors scope** (solo uniquement) |
| Open-source | Code, assets libres, docs de contribution |

### Principes PWA

- Installable (manifest + service worker).
- Jouable **100 % hors-ligne**.
- Démarrage rapide (< 3 s sur connexion moyenne).
- Pas de compte obligatoire.

---

## 3. Boucle de jeu (MVP)

```
┌────────────────────────────────────────────┐
│  Setup : carte + vague initiale (data)     │
│  vagueCourante ← vague #0 pré-construite   │
└────────────────────┬───────────────────────┘
                     ▼
          ┌─────────────────────┐
          │   PHASE DÉFENSE     │
          │  placer / up tours  │
          │  tenir vagueCourante│
          └──────────┬──────────┘
                     ▼
              Défense réussie ?
                 │           │
                non         oui
                 │           │
                 ▼           ▼
              Réessayer   ┌─────────────────────┐
              (défense)   │   PHASE ATTAQUE     │
                          │  nouvelle vague     │
                          │  (ordre + path)     │
                          │  vs forteresse figée│
                          └──────────┬──────────┘
                                     ▼
                              Attaque réussie ?
                                 │           │
                                non         oui
                                 │           │
                                 ▼           ▼
                              Réessayer   vagueCourante ← vague
                              (attaque)   d’attaque réussie
                                          + retour DÉFENSE
                                          (budget↑, palier↑)
```

### Règle d’alternance

| Phase en cours | Condition de succès                                        | Effet                                                                         |
| -------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Défense**    | Le château ne subit **aucun dégât** face à `vagueCourante` | Passage en **Attaque** (forteresse **figée**)                                 |
| **Attaque**    | Le château est **détruit** (PV à 0)                        | `vagueCourante` ← cette vague réussie ; retour **Défense** (budget↑, palier↑) |

L’échec **ne change pas** de phase : le joueur réorganise tours ou vague et relance (**tentatives illimitées**).  
Une attaque **échouée** ne remplace pas `vagueCourante`.

### Chaîne des vagues

| Moment                  | Contenu de `vagueCourante`                                   |
| ----------------------- | ------------------------------------------------------------ |
| Début de run            | Vague **#0 pré-construite** (seule vague fournie par le jeu) |
| Après attaque réussie   | Exactement la vague jouée (composition, ordre, itinéraire)   |
| Pendant retries défense | Inchangée                                                    |
| Pendant retries attaque | Inchangée (la nouvelle vague n’est mémorisée qu’au succès)   |

### Rythme

- Session typique : **10–20 minutes**, plusieurs cycles défense → attaque.
- UI clairement distincte selon la phase.
- Un **cycle** = succès défense + succès attaque.
- Un **palier** augmente après chaque attaque réussie (budgets ; la difficulté de l’épreuve suit la vague que le joueur a lui-même créée).

---

## 4. Phase Défense — Créer / tenir sa forteresse

### Objectif

Construire une défense capable de **tenir `vagueCourante` sans le moindre dégât**. Succès → la forteresse est verrouillée pour la phase Attaque.

### Actions joueur

| Action             | Description                                |
| ------------------ | ------------------------------------------ |
| Placer une tour    | Sur une case constructible                 |
| Améliorer une tour | Niveaux 1 → N (coût croissant)             |
| Déplacer           | Change la case d'une tour déjà posée (gratuit) |
| Supprimer          | Retire la tour et libère intégralement son coût de construction |
| Consulter portée   | Surbrillance de la zone de tir             |
| Valider & éprouver | Lance `vagueCourante` contre sa forteresse |

### Vague à défendre

Le joueur **ne compose pas** la vague en phase Défense. Il affronte `vagueCourante` :

| Origine                      | Quand                                                                |
| ---------------------------- | -------------------------------------------------------------------- |
| **Vague #0 pré-construite**  | Première défense de la run (seule vague data du jeu)                 |
| **Dernière attaque réussie** | Toutes les défenses suivantes (composition + ordre + path conservés) |

Conséquence design : en phase Attaque, le joueur sait que sa vague, si elle détruit le château, devra ensuite être **défendue sans le moindre dégât**. Composer une vague « trop forte » rend le cycle suivant plus dur.

Le joueur peut **prévisualiser** `vagueCourante` (liste, ordre, chemin) avant de valider sa défense.

### Règles de placement

- Grille **hexagonale** (pointy-top, coordonnées offset odd-r : `x` = colonne, `y` = ligne).
- Tour posable **n'importe où**, sauf sur le **château** et sur un **bord de grille** (première/dernière ligne ou colonne du rectangle offset).
- Budget de construction du palier.
- Limite optionnelle : nombre max de tours.
- Forteresse **persistante** : entre deux cycles, les tours déjà placées restent ; le nouveau budget sert à renforcer / compléter (pas de wipe).

### Ciblage des tours

Chaque tour cible automatiquement le monstre le plus avancé sur son chemin, à portée : pas de stratégie de visée au choix du joueur.

### Types de tours (MVP)

| Tour              | Rôle           | Notes                         |
| ----------------- | -------------- | ----------------------------- |
| **Archer**        | DPS mono-cible | Cadence élevée, dégâts moyens |
| **Canon**         | Zone / splash  | Lent, fort vs groupes         |
| **Glace**         | Ralentissement | Peu de dégâts, contrôle       |
| **Lance-pierres** | Anti-blindé    | Bonus vs monstres lourds      |

### Château

- PV limités ; le **moindre point de dégât** encaissé pendant l’épreuve → **échec de défense** (rester en phase Défense, retries illimités), que le château tombe à 0 ou non.
- Entre deux tentatives de défense : forteresse éditable tant que non validée ; après succès, **snapshot figé** pour l’Attaque.
- Entre deux **cycles** : la forteresse **persiste** (les tours restent) ; le budget du nouveau palier s’ajoute pour améliorer.

### Suppression et déplacement d'une tour

- Supprimer une tour **libère toujours l'intégralité** de son coût de construction dans le budget.
- Déplacer une tour est **toujours gratuit** : le budget défense n'est pas touché.
- La forteresse reste éditable librement tant que la phase Défense n'est pas validée (y compris les tours héritées d'un palier précédent).

---

## 5. Phase Attaque — Détruire sa propre forteresse

### Objectif

Avec un **budget d’attaque** du palier, **détruire** le château (PV à 0) de **sa** forteresse figée. Si la vague réussit, elle sera **conservée** comme prochaine `vagueCourante`.

### 5.1 Composition de vague

| Monstre     | Coût   | Rôle                        | MVP        |
| ----------- | ------ | --------------------------- | ---------- |
| **Gobelin** | Faible | Rapide, peu de PV           | Oui        |
| **Orc**     | Moyen  | Équilibré                   | Oui        |
| **Golem**   | Élevé  | Lent, tank / blindé         | Oui        |
| **Volant**  | Moyen+ | Chemins spéciaux            | **Non**    |

### 5.2 Ordre de passage

Le joueur ordonne la file avant le lancement.

Exemples :

- **Tank first** — golems en tête, trash derrière.
- **Rush** — gobelins pour saturer.
- **Mix** — intercaler types pour varier les profils (blindé, groupé…) reçus par les tours sur un même passage.

Réordonner la file (faire monter/descendre un monstre) est **toujours gratuit**. Ordre figé au lancement (pas de micro live en MVP).

### Retirer un monstre déjà mis en file

Retirer un monstre de la file (ou supprimer une voie entière) est **toujours gratuit** : le budget d'attaque correspondant est immédiatement récupéré, que le monstre ait été ajouté pendant la tentative en cours ou lors d'une tentative précédente.

### Le plan d'attaque persiste entre deux cycles

Comme la forteresse défensive, le plan d'attaque (voies, chemins, files de monstres) **n'est pas remis à zéro** après une attaque réussie : il reste affiché — y compris pendant le cycle de Défense qui suit — et sert de point de départ à la composition du cycle d'Attaque suivant, que le budget d'attaque accru permet d'enrichir. Modifier ce plan (retraits, ajouts, réordonnancement) reste gratuit.

### 5.3 Choix d’itinéraire

La carte expose des chemins prédéfinis spawn → château, mais l’attaquant n’y est pas limité :

- **Chemin prédéfini** : réutiliser un chemin existant de la carte tel quel. Ces chemins n’ont rien de figé : le joueur peut en supprimer un (par exemple « north » ou « south ») ; ceux qui restent continuent d’apparaître aussi bien en phase Défense qu’en phase Attaque.
- **Tracé libre** : dessiner sa propre route case par case (pas de case occupée par une tour), depuis un spawn jusqu’au château. Les cases adjacentes sont les **6 voisins hex**. Cliquer une case non adjacente à la dernière comble automatiquement les cases traversées (ligne hex). Une fois validé (le tracé atteint le château), ce chemin devient lui aussi persistant, au même titre qu’un chemin prédéfini : il apparaît en Défense comme en Attaque et peut être réutilisé ou supprimé.
- **Multi-chemins simultané** : la vague peut se répartir en plusieurs **voies** actives en même temps, chacune avec son propre chemin (prédéfini ou tracé) et sa propre file de monstres ordonnée. Chaque voie est traitée en parallèle par la simulation ; le château cumule les dégâts/brèches de toutes les voies confondues.

Preview avant validation : les voies composées et le tracé en cours restent visibles sur la grille avant de lancer l’attaque.

### Cases de chemin payantes

Chaque case occupée par un chemin (prédéfini ou tracé) est décomptée du budget d'attaque, au même titre qu'un monstre. Si plusieurs voies se superposent sur une même case, cette case n'est facturée **qu'une seule fois** pour l'ensemble de la vague. Retirer une voie récupère intégralement le coût de ses cases, comme pour ses monstres.

### Chaque voie doit être empruntée

Une voie composée sans aucun monstre en file ne peut pas être lancée : chaque chemin actif doit être emprunté par au moins un monstre. Une voie vidée de tous ses monstres reste affichée mais bloque le lancement, jusqu'à ce qu'elle soit garnie à nouveau ou supprimée.

### 5.4 Lancement & succès

Simulation contre le **snapshot** de forteresse.

- **Succès** : **château détruit (PV à 0)** → cette vague (composition + ordre + path) **remplace** `vagueCourante` ; nouveau palier ; retour Défense avec budget accru (forteresse persistante).
- **Échec** : le château survit à la fin de la vague, même percé par un ou plusieurs monstres → réessayer l’attaque sans limite (même forteresse figée, `vagueCourante` inchangée).

La forteresse **ne se modifie pas** pendant la phase Attaque.

Tension volontaire : la vague qui vient de détruire le château devient le prochain mur à tenir — le joueur est jugé par ses propres choix d’assaut.

---

## 6. Résolution, paliers & progression

### Simulation

- Tick-based, **déterministe** (tests, replays).
- Même état + mêmes actions → même résultat.

### Conditions (MVP proposé)

| Phase   | Succès                                       | Échec                                          |
| ------- | ---------------------------------------------- | ------------------------------------------------ |
| Défense | Aucun dégât reçu (PV = max) en fin de `vagueCourante` | Au moins 1 point de dégât reçu             |
| Attaque | Château détruit (PV ≤ 0)                        | Château survit, même percé par un ou plusieurs monstres |

Variantes possibles plus tard : seuil de dégâts, % de vague passée, score minimum.

### Paliers

Après chaque **attaque réussie** :

- `vagueCourante` ← vague d’attaque qui vient de réussir (conservation intégrale)
- Budget défense ↑ (pour pouvoir tenir cette vague plus dure sans le moindre dégât)
- Budget attaque ↑ (pour pouvoir détruire une défense renforcée)

La montée en difficulté des vagues n’est **pas** scriptée palier par palier : elle émerge des compositions du joueur. Seule la vague #0 est authorée.

Fin de partie optionnelle : palier max, run endless avec high-score = palier atteint.

### Scoring (proposition)

| Métrique                                          | Usage                |
| ---------------------------------------------------- | -------------------- |
| Palier max                                        | High-score principal |
| Cycles réussis                                    | Stat de run          |
| Attaque minimale (château détruit, budget peu dépensé) | Bonus / achievement  |

---

## 7. Modes de jeu

| Mode                      | MVP | Description                                                                                |
| ------------------------- | --- | ------------------------------------------------------------------------------------------ |
| **Run solo**              | Oui | Alternance défense / attaque sur paliers                                                   |
| **Sandbox**               | Oui | Construire + attaquer sans contrainte de palier (labo)                                     |
| **Défi quotidien**        | Non | Carte + seed + palier fixes, classement local                                              |
| **Partage de forteresse** | Non | Exporter un snapshot pour qu’un autre tente de le détruire (post-MVP, pas d’adversaire live) |

Pas de vs IA, pas de hot-seat, pas de multijoueur.

---

## 8. Cartes & contenu

### Carte MVP

- 5 cartes officielles, portées par le catalogue partagé (`MAP_CATALOG`, projet `shared`) : géométrie et paramétrage de run au même endroit, importés aussi bien par le jeu que par les harnais d'équilibre. Les cartes ont vécu un temps en `.map.json` chargés au runtime ; chaque harnais devant alors en garder sa propre copie, elles ont divergé.
- Aucune carte livrée ne fournit de spawn ni de chemin prédéfini : l'attaquant trace toutes ses routes lui-même depuis une case de bord et les paie (§5.3). Le seul relief est la rivière (§4).
- Le schéma reste celui du type `GameMap` ci-dessous — spawns et chemins prédéfinis restent donc possibles pour une carte future.

```json
{
  "id": "forest-01",
  "grid": {
    "cols": 16,
    "rows": 12,
    "cell": "hex",
    "orientation": "pointy",
    "offset": "odd-r"
  },
  "chateau": { "x": 8, "y": 6 },
  "spawns": [{ "id": "s1", "x": 8, "y": 11 }],
  "paths": [
    {
      "id": "ouest",
      "nodes": [
        [8, 11],
        [1, 11],
        [1, 1],
        [8, 1],
        [8, 6]
      ]
    },
    {
      "id": "est",
      "nodes": [
        [8, 11],
        [14, 11],
        [14, 1],
        [8, 1],
        [8, 6]
      ]
    }
  ]
}
```

### Data de départ (indicatif)

```json
{
  "mapId": "forest-01",
  "startingDefenseBudget": 100,
  "startingAttackBudget": 80,
  "budgetGrowth": { "defense": 40, "attack": 30 },
  "initialWave": {
    "lanes": [
      {
        "path": {
          "id": "west",
          "nodes": [[16, 23], [2, 23], [2, 2], [16, 2], [16, 12]]
        },
        "units": [
          { "type": "goblin" },
          { "type": "goblin" },
          { "type": "goblin" },
          { "type": "orc" },
          { "type": "goblin" }
        ]
      }
    ]
  }
}
```

`initialWave` est la **seule** vague pré-construite. Une vague est une ou plusieurs **voies** (`lanes`), chacune un chemin (embarqué intégralement — prédéfini ou tracé) et une file de monstres ordonnée ; les voies avancent simultanément (§5.3). Les vagues suivantes sont des snapshots de vagues d’attaque réussies, mêmes champs.

### Éditeur (post-MVP)

- Cartes communautaires ; export / import de forteresses.

---

## 9. UX / UI

### Principes

- Phase courante très visible (titre + couleur d’accent).
- Objectif de succès rappelé en permanence (_« Tiens bon, sans le moindre dégât »_ / _« Détruis le château »_).
- Échec = feedback clair + retour immédiat à l’édition (tours ou vague).

### Écrans MVP

1. Accueil (Jouer / Sandbox / Comment jouer / Installer)
2. Sélection carte
3. Phase défense (boutique tours + preview de `vagueCourante`)
4. Résolution défense
5. Phase attaque (composition, ordre, path) sur forteresse figée — rappel que la vague sera conservée si succès
6. Résolution attaque
7. Récap palier / game over / high-score

### Accessibilité

- Contraste suffisant ; pas d’info couleur seule.
- Vitesse de combat 0.5× / 1× / 2× / skip.

---

## 10. Architecture logicielle (proposition)

```
open-td/                    → workspace Angular 22
  projects/open-td/         → PWA (UI Angular + Canvas 2D)
  projects/engine/          → lib logique pure (placement, combat, paliers)
  projects/shared/          → lib types, constantes, schémas cartes
```

PWA via Angular Service Worker (`@angular/service-worker`).  
Le canvas est un composant Angular qui délègue toute la règle métier à `engine`.

### Moteur (`projects/engine`)

- Validation placement
- Simulation vague
- Évaluation succès défense (aucun dégât château) / attaque (château détruit)
- Conservation de vague (`vagueCourante`) au succès d’attaque
- Transition de phase & montée de palier / budgets
- Forteresse persistante entre cycles
- Sérialisation (save, replay, snapshot forteresse + vague)

Règle d’or : **testable sans navigateur** (Vitest / Jest / runner Angular).

### Client (`projects/open-td`)

- Rendu Canvas 2D + HUD Angular ; capture input ; appelle le moteur.
- Service worker + manifest PWA.

---

## 11. Décisions tranchées

| # | Question | Décision |
|---|----------|----------|
| 1 | Grille | **Hexagonale** (pointy-top, offset odd-r) |
| 2 | Targeting des tours | **Fixe** : toujours le monstre le plus avancé à portée (pas de choix du joueur) |
| 3 | Volants en MVP | **Non** (post-MVP) |
| 4 | Succès attaque | **Château détruit** (PV à 0), pas seulement percé |
| 5 | Entre deux défenses | Forteresse **persistante** (améliorer, pas reset) |
| 6 | Stack | **Angular 22 + Canvas 2D** |
| 7 | Tentatives | **Illimitées** |
| 8 | Placement des tours | **N'importe où**, sauf château et bords de grille (plus de liste blanche de cases constructibles) |
| 9 | Suppression / déplacement d'une tour | **Toujours gratuit** (suppression = budget récupéré intégralement, déplacement sans coût) |
| 10 | Retrait d'un monstre en file (Attaque) | **Toujours gratuit** (budget récupéré intégralement) |
| 11 | Réordonner la file d'une voie (Attaque) | **Toujours gratuit** |
| 12 | Entre deux attaques | Plan d'attaque **persistant** (comme la forteresse), établi au succès ; éditable librement |
| 13 | Succès défense | **Aucun dégât** reçu par le château, pas seulement survivre |

---

## 12. Roadmap

### Phase 0 — Conception & squelette

- [x] Document de conception
- [x] Repo, licence, README
- [x] Workspace Angular 22 PWA + libs `engine` / `shared`
- [x] Schéma JSON carte + vague initiale + 1 carte test

### Phase 1 — Prototype défense

- [x] Grille hexagonale + placement de tours
- [x] 2–3 types de tours
- [x] Vague #0 pré-construite
- [x] Succès / échec défense

### Phase 2 — Prototype attaque

- [x] Snapshot forteresse figée
- [x] Composition + ordre + chemin
- [x] Succès / échec attaque
- [x] Conservation de la vague réussie → `vagueCourante`
- [x] Alternance de phase

### Phase 3 — Paliers & run

- [ ] Croissance des budgets par cycle
- [ ] High-score local
- [ ] Sandbox
- [ ] Écrans de flux complets

### Phase 4 — PWA & polish

- [ ] Manifest, SW, offline
- [ ] Balancing, VFX/SFX, tuto court
- [ ] CI + tests moteur

### Phase 5 — Communauté

- [ ] Export / import de forteresses
- [ ] Éditeur de cartes
- [ ] Contenu data-driven

---

## 13. Équilibre (guidelines)

- La vague #0 doit être tenable **sans le moindre dégât** avec le budget défense de départ pour un joueur novice.
- Le budget attaque N doit permettre de **détruire** une défense N « bonne » avec une exécution soignée (ordre + path).
- Le budget défense N+1 doit permettre de tenir **sans dégât** la vague que le joueur vient d’utiliser pour détruire le château — en **renforçant** la forteresse persistante, pas en recommençant from scratch.
- Le joueur arbitrage risque/récompense : vague d’attaque minimale qui détruit le château vs vague écrasante qui sera cauchemardesque à défendre ensuite.
- L’ordre et le path restent des leviers majeurs.

---

## 14. Métriques de succès (MVP)

- Comprendre l’alternance en ≤ 1 run tutorielle.
- Au moins 3–5 cycles défense/attaque dans une session type.
- PWA installable + offline.
- Tests unitaires sur succès/échec de phase et combat critique.

---

## 15. Licence & contribution

- Code : **MIT** (proposition).
- Assets : CC0 / CC-BY ; `/assets/CREDITS.md`.
- `CONTRIBUTING.md` : tests engine obligatoires pour les règles de jeu.

---

## 16. Glossaire

| Terme                   | Définition                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------- |
| **Château**             | Bâtiment à protéger sans le moindre dégât (défense) ou à détruire (attaque)             |
| **vagueCourante**       | Vague à défendre ; vague #0 puis dernière attaque réussie                               |
| **Vague #0**            | Unique vague pré-construite fournie par le jeu                                          |
| **Snapshot forteresse** | État figé des tours (placement, niveaux) pour l’Attaque                                 |
| **Vague**               | Une ou plusieurs voies actives simultanément (phase Attaque)                            |
| **Voie**                | Chemin (prédéfini ou tracé) + file ordonnée de monstres qui l’emprunte                  |
| **Chemin**              | Itinéraire spawn → château : prédéfini par la carte, ou tracé librement par l’attaquant |
| **Palier**              | Niveau de run ; monte après une attaque réussie                                         |
| **Cycle**               | Succès défense + succès attaque                                                         |

---

## Prochaines étapes suggérées

1. Croissance des budgets / high-score / sandbox (Phase 3).
2. Polish PWA, balancing, VFX.
3. Contenu data-driven et éditeur de cartes.
