// Writes public/sw.js from src/lib/sw-cache-policy.ts.
// Compile first: `npm run test:unit` (or `npx tsc -p tsconfig.tests.json`), then run this script.
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const compiled = resolve(root, 'node_modules', '.cache', 'omnilume-tests', 'src', 'lib', 'sw-cache-policy.js');
const { renderServiceWorker } = await import(pathToFileURL(compiled).href);
writeFileSync(resolve(root, 'public', 'sw.js'), renderServiceWorker());
console.log('Wrote public/sw.js');
