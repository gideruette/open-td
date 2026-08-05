import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../projects/open-td/src/app/build-info.ts',
);

const buildDate = new Date().toISOString();

writeFileSync(
  outPath,
  `// Fichier généré automatiquement avant chaque build/serve (voir scripts/generate-build-info.mjs).\n// Ne pas éditer à la main : le contenu est écrasé à chaque exécution.\nexport const BUILD_DATE = '${buildDate}';\n`,
);
