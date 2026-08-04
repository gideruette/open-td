# Open TD

Tower-defense / attack solo en PWA : construis ta forteresse, tiens face à la vague, puis perce-la toi-même.

🎮 Jouer : [open-td](https://gideruette.github.io/open-td/)

Conception : voir [`CONCEPTION.md`](./CONCEPTION.md).

## Stack

- **Angular 22** (zoneless) + Canvas 2D
- Libs : `shared` (types), `engine` (logique pure)
- PWA : `@angular/service-worker`
- Tests : Vitest

## Démarrage

```bash
npm install
npm start
```

Ouvre `http://localhost:4200/`.

## Scripts

| Commande              | Description                           |
| --------------------- | ------------------------------------- |
| `npm start`           | Serve l’app `open-td`                 |
| `npm run build`       | Build `shared` → `engine` → `open-td` |
| `npm test`            | Tests unitaires de l’app              |
| `npm run test:engine` | Tests du moteur                       |

## Structure

```
projects/
  open-td/   # PWA (UI + canvas)
  engine/    # règles de jeu (sans DOM)
  shared/    # types & constantes
```
