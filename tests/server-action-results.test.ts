import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { actionResult, unwrapAction } from '../src/lib/action-result.js';

const actionsDirectory = resolve(process.cwd(), 'src', 'actions');

function bodyOf(text: string, start: number) {
  // From the parameter list's closing paren, skip a return-type annotation
  // (which may contain braces inside <...>) and return the function body.
  let depth = 0;
  let index = text.indexOf('(', start);
  for (; index < text.length; index++) {
    if (text[index] === '(') depth++;
    else if (text[index] === ')' && --depth === 0) break;
  }
  let angle = 0;
  for (index++; index < text.length; index++) {
    const c = text[index];
    if (c === '<') angle++;
    else if (c === '>') angle--;
    else if (c === '{' && angle === 0 && !/:\s*$/.test(text.slice(0, index))) break;
  }
  let braces = 0;
  const open = index;
  for (; index < text.length; index++) {
    if (text[index] === '{') braces++;
    else if (text[index] === '}' && --braces === 0) break;
  }
  return text.slice(open + 1, index).trim();
}

test('actionResult returns data, or the original error message as data', async () => {
  assert.deepEqual(await actionResult(async () => 42), { ok: true, data: 42 });
  assert.deepEqual(await actionResult(async () => { throw new Error('Whiteboard update rejected: expected version does not match.'); }), {
    ok: false,
    error: 'Whiteboard update rejected: expected version does not match.',
  });
  const long = await actionResult(async () => { throw new Error(`x\n${'y'.repeat(500)}`); });
  assert.equal(long.ok, false);
  assert.ok(!long.ok && long.error.length <= 300 && !long.error.includes('\n'));
  const empty = await actionResult(async () => { throw new Error(''); });
  assert.ok(!empty.ok && empty.error.length > 0);
});

test('unwrapAction re-throws the server message as a normal Error', () => {
  assert.equal(unwrapAction({ ok: true, data: 'value' }), 'value');
  assert.throws(() => unwrapAction({ ok: false, error: 'You do not have permission to use Study in this room.' }), /You do not have permission to use Study in this room\./);
  assert.throws(() => unwrapAction(undefined as never), /Unexpected response/);
});

test('no Server Action can throw its error to the browser', () => {
  // Production React replaces a thrown Server Action error with "Minified
  // React error #441", so every exported action must return its outcome:
  // either through actionResult or a try/catch that returns { success: false }.
  const offenders: string[] = [];
  for (const file of readdirSync(actionsDirectory).filter((name) => name.endsWith('.ts'))) {
    const text = readFileSync(join(actionsDirectory, file), 'utf8').replace(/\r\n/g, '\n');
    if (!/^'use server'/m.test(text)) continue;
    // Local helpers that can throw (for example requireUser()).
    const throwingHelpers = [...text.matchAll(/(?:async )?function (\w+)\s*\(/g)]
      .filter((match) => !/export async function\s*$/.test(text.slice(Math.max(0, (match.index ?? 0) - 7), (match.index ?? 0) + 'async function'.length + 1)))
      .filter((match) => /\bthrow\b/.test(bodyOf(text, match.index ?? 0)))
      .map((match) => match[1]);
    const exported = [...text.matchAll(/export async function (\w+)\s*\(/g)].map((match) => ({ name: match[1], body: bodyOf(text, match.index ?? 0) }));
    const compliant = new Set<string>();
    for (const { name, body } of exported) {
      const returnsResult = /^return actionResult\(/.test(body);
      const catchesToResult = /^try\s*\{/.test(body) && /\}\s*catch\s*(\([^)]*\))?\s*\{[\s\S]*return\s*\{\s*success:\s*false/.test(body);
      const neverThrows = !/\bthrow\b/.test(body) && !throwingHelpers.some((helper) => new RegExp(`\\b${helper}\\(`).test(body));
      if (returnsResult || catchesToResult || neverThrows) compliant.add(name);
    }
    for (const { name, body } of exported) {
      const delegate = body.match(/^return (\w+)\([^;]*\);?$/)?.[1];
      if (!compliant.has(name) && !(delegate && compliant.has(delegate))) offenders.push(`${file}:${name}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('study notes keep edits typed while a save is in flight', () => {
  const panel = readFileSync(resolve(process.cwd(), 'src/components/room/StudyNotesPanel.tsx'), 'utf8');
  assert.match(panel, /const revision = revisionRef\.current;/);
  assert.match(panel, /if \(revisionRef\.current === revision\) \{ dirtyRef\.current = false; setStatus\('saved'\); \}/);
  assert.match(panel, /Keep my version/);
});
