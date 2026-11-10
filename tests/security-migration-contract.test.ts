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
  // anon EXECUTE discloses nothing. get_public_invite_card is the signed-out
  // /join card by design (hostel roadmap phase 05): valid token only, no ids,
  // rate-limited.
  const allowedForAnon = new Set(['room_storage_path_kind', 'room_storage_path_room_id', 'get_public_invite_card']);
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

// Latest definition of each function, by migration filename order.
const latestFunctionBodies = () => {
  const bodies = new Map<string, { file: string; body: string }>();
  const definition = /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.([a-z0-9_]+)\s*\([\s\S]*?\bAS\s+(\$[A-Za-z_]*\$)([\s\S]*?)\2/gi;
  for (const { file, sql } of migrations) {
    for (const match of stripComments(sql).matchAll(definition)) bodies.set(match[1], { file, body: match[3] });
  }
  return bodies;
};

test('no PL/pgSQL variable shadows an ON CONFLICT target column', () => {
  // A declared variable named like a conflict column raises 42702 at runtime
  // (20260923120000 notify_room_recovery_decision broke every recovery decision).
  const conflicts: string[] = [];
  for (const [name, { file, body }] of latestFunctionBodies()) {
    const declare = body.match(/\bDECLARE\b([\s\S]*?)\bBEGIN\b/i)?.[1] ?? '';
    const variables = new Set([...declare.matchAll(/(?:^|;)\s*([a-z_][a-z0-9_]*)\s+[a-z]/gi)].map((match) => match[1].toLowerCase()));
    for (const target of body.matchAll(/ON\s+CONFLICT\s*\(([^)]*)\)/gi)) {
      for (const column of target[1].split(',').map((part) => part.trim().toLowerCase())) {
        if (variables.has(column)) conflicts.push(`${name} (${file}): ${column}`);
      }
    }
  }
  assert.deepEqual(conflicts, []);
});

test('no current policy reads a table that client roles cannot select', () => {
  // Policy subqueries run with the caller's privileges. Reading a table revoked
  // from authenticated fails the whole statement (20260923140000 storage DELETE).
  const unreadable = new Set<string>();
  for (const { statement } of statements) {
    const revoke = statement.match(/^REVOKE ALL ON TABLE (.+?) FROM (.+)$/i);
    if (revoke && /\bauthenticated\b/i.test(revoke[2])) {
      for (const table of revoke[1].matchAll(/public\.([a-z0-9_]+)/g)) unreadable.add(table[1]);
    }
    const grant = statement.match(/^GRANT [^]*?\bSELECT\b[^]*? ON TABLE (.+?) TO (.+)$/i);
    if (grant && /\bauthenticated\b/i.test(grant[2])) {
      for (const table of grant[1].matchAll(/public\.([a-z0-9_]+)/g)) unreadable.delete(table[1]);
    }
  }

  const latestPolicies = new Map<string, { file: string; statement: string }>();
  for (const entry of statements) {
    const policy = entry.statement.match(/^(CREATE|ALTER|DROP) POLICY (?:IF EXISTS )?"([^"]+)" ON ([a-z_.]+)/i);
    if (!policy) continue;
    const key = `${policy[3]}.${policy[2]}`;
    if (policy[1].toUpperCase() === 'DROP') latestPolicies.delete(key);
    else latestPolicies.set(key, entry);
  }

  const offenders: string[] = [];
  for (const [key, { file, statement }] of latestPolicies) {
    for (const reference of statement.matchAll(/\b(?:FROM|JOIN)\s+public\.([a-z0-9_]+)/gi)) {
      if (unreadable.has(reference[1])) offenders.push(`${key} (${file}) reads public.${reference[1]}`);
    }
  }
  assert.ok(unreadable.has('room_files'), 'Expected room_files to be revoked from authenticated.');
  assert.deepEqual(offenders, []);
});

test('no current function regex escapes a dot with a doubled backslash', () => {
  // In a $$ body '\\.' matches a literal backslash plus any character, which
  // rejected every valid subtitle path (D8, 20260923140000).
  const offenders = [...latestFunctionBodies()]
    .filter(([, { body }]) => /\\\\\./.test(body))
    .map(([name, { file }]) => `${name} (${file})`);
  assert.deepEqual(offenders, []);
});

test('post authors can read their own posts, so create and soft-delete can return rows', () => {
  // PostgREST mutations use RETURNING, which must pass the SELECT policy (D9).
  const definitions = statements.filter(({ statement }) => /^(CREATE|ALTER) POLICY "posts_select_visible" ON public\.posts/i.test(statement));
  const latest = definitions[definitions.length - 1];
  assert.ok(latest, 'No posts_select_visible definition found.');
  assert.match(latest.statement, /auth\.uid\(\) = author_id OR/, `${latest.file} hides authors' own posts from them`);
  const profiles = readFileSync(resolve(process.cwd(), 'src', 'actions', 'profiles.ts'), 'utf8');
  // With authors able to see deleted rows, every reader must filter them out.
  const postReads = [...profiles.matchAll(/\.from\('posts'\)\s*\.select\([\s\S]*?;/g)].map((match) => match[0]);
  assert.ok(postReads.length > 0);
  for (const read of postReads) assert.match(read, /\.is\('deleted_at', null\)/, `post read without deleted_at filter: ${read.slice(0, 80)}`);
});

test('room chat is delivered by RLS-filtered Postgres Changes, never Broadcast', () => {
  const read = (...parts: string[]) => readFileSync(resolve(process.cwd(), ...parts), 'utf8');
  const sync = read('src', 'hooks', 'useRoomSync.ts');
  for (const event of ['INSERT', 'UPDATE']) {
    assert.match(
      sync,
      new RegExp(`postgres_changes', \\{ event: '${event}', schema: 'public', table: 'messages', filter: \`room_id=eq\\.\\$\\{roomId\\}\` \\}`),
      `useRoomSync must subscribe to ${event} on public.messages for the room`,
    );
  }
  // DELETE events are not RLS-filtered by Postgres Changes.
  assert.doesNotMatch(sync, /event: '(DELETE|\*)', schema: 'public', table: 'messages'/);
  assert.doesNotMatch(read('src', 'components', 'room', 'RoomChat.tsx'), /broadcastEvent\('room_message/);
  // Every Broadcast leaves through the wire contract.
  assert.match(sync, /const wirePayload = toRoomBroadcastPayload\(eventType, eventPayload\)/);
  assert.match(sync, /const payload = toRoomBroadcastPayload\(event\.event_type, event\.payload\)/);
});

test('app code registers Watch media through the RPC on contract storage paths', () => {
  const sourceRoot = resolve(process.cwd(), 'src');
  const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
    });

  // The CRON_SECRET-gated cleanup route is the only service-role client and
  // deletes expired rows by design; its steps live in lib/room-cleanup.ts,
  // which only that route may import. Every other module runs as the user.
  const serviceRoleRoute = join(sourceRoot, 'app', 'api', 'internal', 'cleanup-expired-rooms', 'route.ts');
  const serviceRoleSteps = join(sourceRoot, 'lib', 'room-cleanup.ts');
  const cleanupImporters = sourceFiles(sourceRoot).filter((file) => /from '@\/lib\/room-cleanup'|from '\.\.?\/.*room-cleanup'/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(cleanupImporters, [serviceRoleRoute]);

  const offenders = sourceFiles(sourceRoot).filter((file) => file !== serviceRoleRoute && file !== serviceRoleSteps).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const problems: string[] = [];
    // 20260923140000 revoked direct INSERT/UPDATE/DELETE on temporary_media.
    if (/from\(\s*'temporary_media'\s*\)\s*\.\s*(insert|update|upsert|delete)\b/.test(source)) problems.push('direct temporary_media write');
    // room_storage_path_kind treats any other second segment as read-only legacy.
    if (/\$\{roomId\}\/(temp|sub)-/.test(source)) problems.push('legacy upload path');
    return problems.map((problem) => `${file}: ${problem}`);
  });
  assert.deepEqual(offenders, []);
});

test('client roles lose TRUNCATE, TRIGGER and REFERENCES on public tables', () => {
  const remediation = migrations.find(({ sql }) =>
    /REVOKE %s ON TABLE public\.%I FROM PUBLIC, anon, authenticated/.test(sql),
  );
  assert.ok(remediation, 'No migration revokes residual table privileges from client roles.');
  assert.match(remediation.sql, /'TRUNCATE, TRIGGER, REFERENCES'/);
  assert.match(remediation.sql, /c\.relkind IN \('r', 'p'\)/);
});
