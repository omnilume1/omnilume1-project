// Writes src/app/app-themes.css from src/lib/app-theme.ts.
// Compile first: `npm run test:unit` (or `npx tsc -p tsconfig.tests.json`), then run this script.
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const compiled = resolve(root, 'node_modules', '.cache', 'omnilume-tests', 'src', 'lib', 'app-theme.js');
const { renderThemeCss } = await import(pathToFileURL(compiled).href);
writeFileSync(resolve(root, 'src', 'app', 'app-themes.css'), renderThemeCss());
console.log('Wrote src/app/app-themes.css');
