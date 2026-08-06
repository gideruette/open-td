/**
 * Hook de résolution ESM : mappe les noms de packages Angular (`shared`, `engine`)
 * vers les artefacts `dist/` pour pouvoir importer le moteur depuis un script Node.
 */
import { pathToFileURL } from 'node:url';
import { dirname, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = pathResolve(dirname(fileURLToPath(import.meta.url)), '..');

const aliases = {
  shared: pathResolve(root, 'dist/shared/fesm2022/shared.mjs'),
  engine: pathResolve(root, 'dist/engine/fesm2022/engine.mjs'),
};

export async function resolve(specifier, context, nextResolve) {
  const target = aliases[specifier];
  if (target) {
    return {
      shortCircuit: true,
      url: pathToFileURL(target).href,
    };
  }
  return nextResolve(specifier, context);
}
