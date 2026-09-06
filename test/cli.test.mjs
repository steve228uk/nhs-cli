import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, symlink, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { parseArgs, execute, doctor } from '../src/cli.mjs';
import { errorPayload, NhsError } from '../src/errors.mjs';
import { publicData, exportFile } from '../src/output.mjs';
import { memoryStore, response, sessionData } from './helpers.mjs';
import { Transport } from '../src/transport.mjs';
import { VaultStore } from '../src/storage.mjs';

const exec = promisify(execFile);
test('legacy commands map to new command groups; bad flags fail before any I/O', () => {
  assert.deepEqual(parseArgs(['status', '--json'], true), { group: 'prescriptions', verb: 'list', id: undefined, flags: new Map([['json', true]]) });
  for (const argv of [['--password=secret'], ['prescriptions', 'order', '--confirm=false'], ['--ids'], ['--json', '--json']]) assert.throws(() => parseArgs(argv), { code: 'usage' });
});

test('auth status and doctor do not access the network or mutate state', async () => {
  const store = memoryStore();
  const transport = new Transport({ fetchImpl: async () => { throw new Error('network must not be used'); } });
  const result = await execute(parseArgs(['auth', 'status']), { store, transport });
  assert.equal(result.sessionValidity, 'not-checked');
  assert.equal(result.sessionStored, true);
  assert.equal(store.writes, 0);
  await doctor(store); assert.equal(store.writes, 0);
});

test('native errors and protocol credentials never reach output, even with debug', () => {
  assert.ok(!JSON.stringify(errorPayload(new Error('password=synthetic-secret'))).includes('synthetic-secret'));
  assert.deepEqual(publicData({ data: { name: 'Medicine A', token: 'synthetic-secret', nested: [{ authorization: 'synthetic-secret', text: 'message' }] } }), { data: { name: 'Medicine A', nested: [{ text: 'message' }] } });
});

test('exports are private and never overwrite existing files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nhs-export-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'export.json'); await exportFile(path, 'synthetic-data');
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(exportFile(path, 'replacement'), { code: 'export_failed' });
  assert.equal(await readFile(path, 'utf8'), 'synthetic-data');
});

test('entrypoints work through installed-style symlinks and --version needs no keyring', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nhs-bin-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const target = new URL('../bin/nhs-prescriptions.mjs', import.meta.url).pathname;
  const link = join(directory, 'nhs-prescriptions'); await symlink(target, link);
  const version = await exec(process.execPath, [link, '--version']);
  assert.equal(version.stdout.trim(), '0.1.0');
  const modern = await exec(process.execPath, [new URL('../bin/nhs.mjs', import.meta.url).pathname, '--version']);
  assert.equal(modern.stdout.trim(), '0.1.0');
});

test('order honours no-login and no-prompt without requesting credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nhs-order-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { NHS_CLI_STATE_KEY: randomBytes(32).toString('base64') };
  const store = new VaultStore({ directory, backend: 'encrypted-file', env });
  const transport = new Transport({ fetchImpl: async () => { throw new Error('network must not be used'); } });
  await assert.rejects(execute(parseArgs(['prescriptions', 'order', '--ids=one', '--dry-run', '--no-login', '--no-prompt']), { store, transport, env, config: { dataDir: directory, legacyPath: join(directory, 'missing'), backend: 'encrypted-file' } }), { code: 'auth_required' });
});

test('unconfirmed orders and unsupported pagination fail before reading any store', async () => {
  const store = memoryStore(); store.load = async () => { throw new Error('must not read storage'); };
  for (const [argv, code] of [[['prescriptions', 'order', '--ids=one'], 'order_requires_confirmation'], [['prescriptions', 'order', '--confirm'], 'order_requires_scope'], [['messages', 'list', '--source=gp', '--index=20'], 'usage']]) {
    await assert.rejects(execute(parseArgs(argv), { store }), { code });
  }
});
