import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = fileURLToPath(new URL('.', import.meta.url));
const testsRoot = resolve(scriptsDirectory, '..', 'node_modules', '.cache', 'omnilume-tests', 'tests');

function findTests(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory()
      ? findTests(path)
      : path.endsWith('.test.js') ? [path] : [];
  });
}

const testFiles = findTests(testsRoot);
if (testFiles.length === 0) {
  throw new Error('No compiled unit test files were found.');
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], { stdio: 'inherit' });
process.exit(result.status ?? 1);
