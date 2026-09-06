import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, chmod, stat, symlink, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { VaultStore, NativeKeyProvider, withLock, migrateLegacy, readPrivate, atomicWrite } from '../src/storage.mjs';
import { memoryStore } from './helpers.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nhs-storage-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = { NHS_CLI_STATE_KEY: randomBytes(32).toString('base64') };
  return { directory, env, store: new VaultStore({ directory, backend: 'encrypted-file', env }) };
}
const secretVault = () => ({ version: 1, session: { csrfToken: 'synthetic-sensitive-csrf', sessionId: 'synthetic-sensitive-session' }, credentials: { email: 'person@example.com', password: 'synthetic-sensitive-password' } });

test('vault stores no plaintext secrets and persists across independent processes', async t => {
  const { store, directory, env } = await fixture(t); const value = secretVault();
  await store.save(value);
  assert.deepEqual(await store.load(), value);
  const disk = await readFile(store.path, 'utf8');
  for (const secret of ['person@example.com', 'synthetic-sensitive', env.NHS_CLI_STATE_KEY]) assert.ok(!disk.includes(secret));
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const source = `import { VaultStore } from ${JSON.stringify(new URL('../src/storage.mjs', import.meta.url).href)}; const store = new VaultStore({directory:process.env.TEST_VAULT_DIR,backend:'encrypted-file'}); const v=await store.load(); console.log(v.session.sessionId === 'synthetic-sensitive-session');`;
  const child = await exec(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, ...env, TEST_VAULT_DIR: directory } });
  assert.equal(child.stdout.trim(), 'true');
});

test('wrong key and modified ciphertext fail without overwriting the vault', async t => {
  const { store, directory } = await fixture(t); await store.save(secretVault());
  const old = await readFile(store.path, 'utf8');
  const wrong = new VaultStore({ directory, backend: 'encrypted-file', env: { NHS_CLI_STATE_KEY: randomBytes(32).toString('base64') } });
  await assert.rejects(wrong.load(), { code: 'storage_corrupt' });
  assert.equal(await readFile(store.path, 'utf8'), old);
  const data = JSON.parse(old); data.data = Buffer.from('tampered').toString('base64');
  await writeFile(store.path, JSON.stringify(data), { mode: 0o600 });
  await assert.rejects(store.load(), { code: 'storage_corrupt' });
});

test('missing encryption key never creates a file or falls back', async t => {
  const { directory } = await fixture(t);
  const store = new VaultStore({ directory, backend: 'encrypted-file', env: {} });
  await assert.rejects(store.save(secretVault()), { code: 'storage_key_required' });
  assert.deepEqual(await readdir(directory), []);
});

test('oversized writes preserve the existing encrypted vault', async t => {
  const { store } = await fixture(t); await store.save(secretVault());
  const old = await readFile(store.path, 'utf8');
  await assert.rejects(store.save({ version: 1, session: { csrfToken: 'x'.repeat(1024 * 1024) } }), { code: 'storage_too_large' });
  assert.equal(await readFile(store.path, 'utf8'), old);
});

test('unsafe files and symlinks are rejected', async t => {
  const { directory } = await fixture(t); const path = join(directory, 'state');
  await writeFile(path, '{}', { mode: 0o600 }); await chmod(path, 0o644);
  await assert.rejects(readPrivate(path), { code: 'unsafe_storage_file' });
  await symlink(path, join(directory, 'alias'));
  await assert.rejects(readPrivate(join(directory, 'alias')), { code: 'storage_read_failed' });
});

test('concurrent operations serialize and errors release the lock', async t => {
  const { directory } = await fixture(t); const events = [];
  await Promise.all([withLock(directory, async () => { events.push('a'); await new Promise(resolve => setTimeout(resolve, 30)); events.push('b'); }), withLock(directory, async () => { events.push('c'); })]);
  assert.deepEqual(events, ['a', 'b', 'c']);
  await assert.rejects(withLock(directory, async () => { throw new Error('fixture'); }));
  await withLock(directory, async () => {});
});

test('migration verifies secure storage before deleting the plaintext original', async t => {
  const { directory, store } = await fixture(t); const legacy = join(directory, 'legacy.json');
  await writeFile(legacy, JSON.stringify({ ...secretVault().session, unrelatedPatientResponse: { sensitive: true } }), { mode: 0o600 });
  const value = await withLock(directory, () => migrateLegacy(store, legacy));
  assert.equal(value.session.sessionId, 'synthetic-sensitive-session');
  assert.equal(value.session.unrelatedPatientResponse, undefined);
  await assert.rejects(access(legacy));
  assert.deepEqual(await store.load(), value);
});

test('failed migration retains the original and credentials', async t => {
  const { directory } = await fixture(t); const legacy = join(directory, 'legacy.json');
  const raw = JSON.stringify(secretVault().session); await writeFile(legacy, raw, { mode: 0o600 });
  const store = memoryStore({ version: 1, session: {}, credentials: secretVault().credentials });
  store.save = async () => { throw new Error('write denied'); };
  await assert.rejects(migrateLegacy(store, legacy));
  assert.equal(await readFile(legacy, 'utf8'), raw);
  assert.deepEqual(store.value.credentials, secretVault().credentials);
});

function nativeFixture({ linuxFallback = false, locked = false } = {}) {
  const serviceValues = new Map(), transient = new Map(), written = [];
  return {
    written, serviceValues,
    module: {
      AsyncEntry: class {
        constructor(service, name) { this.key = `${service}:${name}`; this.account = name; this.map = linuxFallback ? transient : serviceValues; }
        async getPassword() { if (locked) throw new Error('locked synthetic-secret'); return this.map.get(this.key)?.password; }
        async setPassword(password) { if (locked) throw new Error('denied synthetic-secret'); written.push(password); this.map.set(this.key, { account: this.account, password }); }
        async deleteCredential() { return this.map.delete(this.key); }
      },
      async findCredentialsAsync() { if (locked) throw new Error('locked synthetic-secret'); return [...serviceValues.values()]; },
    },
  };
}

test('Linux proves Secret Service storage before writing a key and reuses it', async () => {
  const fixture = nativeFixture();
  const provider = new NativeKeyProvider({ platform: 'linux', loadNative: async () => fixture.module });
  const key = await provider.key(true);
  assert.equal(key.length, 32);
  assert.match(fixture.written[0], /^nhs-cli-storage-probe:/);
  assert.equal(fixture.written.length, 2);
  assert.deepEqual(await provider.key(), key);
});

test('Linux transient fallback receives only a non-secret probe, never a key', async () => {
  const fixture = nativeFixture({ linuxFallback: true });
  const provider = new NativeKeyProvider({ platform: 'linux', loadNative: async () => fixture.module });
  await assert.rejects(provider.key(true), { code: 'secure_storage_unavailable' });
  assert.equal(fixture.written.length, 1);
  assert.match(fixture.written[0], /^nhs-cli-storage-probe:/);
});

test('native permission errors are actionable and omit native secret-bearing messages', async () => {
  for (const platform of ['darwin', 'linux']) {
    const fixture = nativeFixture({ locked: true });
    const provider = new NativeKeyProvider({ platform, loadNative: async () => fixture.module });
    await assert.rejects(provider.key(true), error => error.code === 'secure_storage_unavailable' && !error.message.includes('synthetic-secret'));
    assert.equal(fixture.written.length, 0);
  }
});

test('an interrupted replacement preserves the previous decryptable vault', async t => {
  const { store, directory } = await fixture(t); await store.save(secretVault());
  const old = await readFile(store.path, 'utf8');
  await assert.rejects(atomicWrite(store.path, 'synthetic-replacement', { replace: async () => { throw new Error('simulated interruption before rename'); } }));
  assert.equal(await readFile(store.path, 'utf8'), old);
  assert.deepEqual(await store.load(), secretVault());
  assert.deepEqual(await readdir(directory), ['vault.enc']);
});

test('migration recovers after secure save but before plaintext deletion without rolling back sessions', async t => {
  const { directory, store } = await fixture(t); const legacy = join(directory, 'legacy.json');
  const raw = JSON.stringify(secretVault().session);
  await writeFile(legacy, raw, { mode: 0o600 });
  await migrateLegacy(store, legacy);
  const vault = await store.load(); vault.session.sessionId = 'synthetic-rotated'; await store.save(vault);
  await writeFile(legacy, raw, { mode: 0o600 }); // source left behind at an interrupted migration boundary
  assert.equal((await migrateLegacy(store, legacy)).session.sessionId, 'synthetic-rotated');
  await assert.rejects(access(legacy));
  await writeFile(legacy, '{}', { mode: 0o600 });
  await assert.rejects(migrateLegacy(store, legacy), { code: 'migration_conflict' });
  assert.equal(await readFile(legacy, 'utf8'), '{}');
});

test('failed migration readback leaves the plaintext source in place', async t => {
  const { directory } = await fixture(t); const legacy = join(directory, 'legacy.json');
  await writeFile(legacy, JSON.stringify(secretVault().session), { mode: 0o600 });
  const store = memoryStore({ version: 1, session: {} }); store.save = async () => {};
  await assert.rejects(migrateLegacy(store, legacy), { code: 'migration_failed' });
  await access(legacy);
});

test('independent command processes do not lose concurrent state updates', async t => {
  const { store, directory, env } = await fixture(t); await store.save({ version: 1, session: {} });
  const source = `import { VaultStore,withLock } from ${JSON.stringify(new URL('../src/storage.mjs', import.meta.url).href)}; const directory=process.env.TEST_VAULT_DIR; const store=new VaultStore({directory,backend:'encrypted-file'}); await withLock(directory,async()=>{const value=await store.load();value.session[process.env.TEST_FIELD]='synthetic';await new Promise(r=>setTimeout(r,25));await store.save(value)});`;
  await Promise.all(['csrfToken', 'sessionId'].map(field => exec(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, ...env, TEST_VAULT_DIR: directory, TEST_FIELD: field } })));
  assert.deepEqual((await store.load()).session, { csrfToken: 'synthetic', sessionId: 'synthetic' });
});

test('an abandoned non-secret Linux probe can recover without accepting it as a vault key', async () => {
  const fixture = nativeFixture();
  fixture.serviceValues.set('nhs-cli:vault-key-v1', { account: 'vault-key-v1', password: `nhs-cli-storage-probe:${'a'.repeat(32)}` });
  const provider = new NativeKeyProvider({ platform: 'linux', loadNative: async () => fixture.module });
  assert.equal(await provider.key(false), null);
  assert.equal((await provider.key(true)).length, 32);
});
