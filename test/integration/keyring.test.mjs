import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NativeKeyProvider, VaultStore, withLock } from '../../src/storage.mjs';

test('real OS keyring persists across processes and deletes only its isolated test entry', { skip: process.env.NHS_CLI_TEST_KEYRING !== '1', timeout: 60000 }, async t => {
  const service = `nhs-cli-test-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), 'nhs-native-test-'));
  const native = await import('@napi-rs/keyring');
  t.after(async () => {
    await new native.AsyncEntry(service, 'vault-key-v1').deleteCredential();
    await rm(directory, { recursive: true, force: true });
  });
  const provider = new NativeKeyProvider({ service });
  const store = new VaultStore({ directory, keyProvider: provider });
  await withLock(directory, () => store.save({ version: 1, session: { sessionId: 'synthetic-native-session' } }));
  const source = `import {NativeKeyProvider,VaultStore} from ${JSON.stringify(new URL('../../src/storage.mjs', import.meta.url).href)};const store=new VaultStore({directory:process.env.TEST_DIRECTORY,keyProvider:new NativeKeyProvider({service:process.env.TEST_SERVICE})});console.log((await store.load()).session.sessionId==='synthetic-native-session');`;
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, TEST_DIRECTORY: directory, TEST_SERVICE: service } });
  assert.equal(child.stdout.trim(), 'true');
  if (process.platform === 'linux') assert.equal((await native.findCredentialsAsync(service)).length, 1);
  await new native.AsyncEntry(service, 'vault-key-v1').deleteCredential();
  assert.equal(await provider.key(false), null);
  await assert.rejects(store.load(), { code: 'storage_key_missing' });
  await new native.AsyncEntry(service, 'vault-key-v1').setPassword('synthetic-invalid-key'.repeat(100));
  await assert.rejects(provider.key(false), { code: 'secure_storage_unavailable' });
});

test('Linux without an accessible Secret Service fails before creating a vault', { skip: process.env.NHS_CLI_TEST_KEYRING !== '1' || process.platform !== 'linux', timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nhs-native-unavailable-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = `import {NativeKeyProvider,VaultStore} from ${JSON.stringify(new URL('../../src/storage.mjs', import.meta.url).href)}; const store=new VaultStore({directory:process.env.TEST_DIRECTORY,keyProvider:new NativeKeyProvider({service:process.env.TEST_SERVICE})}); try {await store.save({version:1,session:{}});process.exitCode=1} catch(error){console.log(error.code==='secure_storage_unavailable')}`;
  const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { timeout: 10000, env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(directory, 'absent-bus')}`, TEST_DIRECTORY: directory, TEST_SERVICE: `nhs-cli-test-${randomUUID()}` } });
  assert.equal(child.stdout.trim(), 'true');
});
