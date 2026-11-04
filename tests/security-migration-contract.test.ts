import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

// Static contract checks over the ordered migration sources. These prove what
// the migrations declare, not what the remote catalog holds or how an
// authenticated caller is treated: use supabase/audits/action01-10 and the
// two-account checklist for those.

const migrationsDirectory = resolve(process.cwd(), 'supabase', 'migrations');

const migrations = readdirSync(migrationsDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: readFileSync(join(migrationsDirectory, file), 'utf8') }));

const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, '');
const normalize = (sql: string) => stripComments(sql).replace(/\s+/g, ' ').trim();

const statements = migrations.flatMap(({ file, sql }) =>
  normalize(sql)
    .split(';')
    .map((statement) => ({ file, statement: statement.trim() }))
    .filter(({ statement }) => statement.length > 0),
);

const functionNames = (statement: string) =>
  [...statement.matchAll(/public\.([a-z0-9_]+)\s*\(/g)].map((match) => match[1]);

test('room-scoped message inserts require the chat capability in the latest policy definition', () => {
  const definitions = statements.filter(({ statement }) =>
    /^(CREATE|ALTER) POLICY "Users can insert messages" ON public\.messages/i.test(statement),
  );
  assert.ok(definitions.length > 0, 'No "Users can insert messages" policy definition was found.');

  const latest = definitions[definitions.length - 1];
  const roomBranch = latest.statement.slice(latest.statement.lastIndexOf('room_id IS NOT NULL'));
  assert.match(
    roomBranch,
    /public\.room_has_capability\(room_id, auth\.uid\(\), 'chat'\)/,
    `${latest.file} lets room members insert messages without the chat capability.`,
  );
});

test('every function granted to authenticated is also revoked from anon', () => {
  // Pure IMMUTABLE path parsers used by storage policies. They read no data, so
  // anon EXECUTE discloses nothing.
  const allowedForAnon = new Set(['room_storage_path_kind', 'room_storage_path_room_id']);
  const grantedToAuthenticated = new Set<string>();
  const revokedFromAnon = new Set<string>();

  for (const { statement } of statements) {
    if (/^GRANT EXECUTE ON FUNCTION/i.test(statement) && /\bTO\b.*\bauthenticated\b/i.test(statement)) {
      functionNames(statement).forEach((name) => grantedToAuthenticated.add(name));
    }
    if (/^REVOKE (ALL|EXECUTE)\b.*\bON FUNCTION/i.test(statement) && /\bFROM\b.*\banon\b/i.test(statement)) {
      functionNames(statement).forEach((name) => revokedFromAnon.add(name));
    }
  }

  const missing = [...grantedToAuthenticated]
    .filter((name) => !revokedFromAnon.has(name) && !allowedForAnon.has(name))
    .sort();
  assert.deepEqual(missing, [], `Supabase grants EXECUTE to anon by default; revoke it for: ${missing.join(', ')}`);
});

test('client roles lose TRUNCATE, TRIGGER and REFERENCES on public tables', () => {
  const remediation = migrations.find(({ sql }) =>
    /REVOKE %s ON TABLE public\.%I FROM PUBLIC, anon, authenticated/.test(sql),
  );
  assert.ok(remediation, 'No migration revokes residual table privileges from client roles.');
  assert.match(remediation.sql, /'TRUNCATE, TRIGGER, REFERENCES'/);
  assert.match(remediation.sql, /c\.relkind IN \('r', 'p'\)/);
});
