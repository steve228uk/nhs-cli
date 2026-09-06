import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { NhsError } from './errors.mjs';

const SERVICE = 'nhs-cli';
const ACCOUNT = 'vault-key-v1';
const MAX_BYTES = 1024 * 1024;
const AAD = Buffer.from('nhs-cli:vault:v1');
const storageError = () => new NhsError('secure_storage_unavailable', 'Secure storage is unavailable or locked. Unlock Keychain/Secret Service, or explicitly configure encrypted-file storage with an injected key.');

/** Explicit legacy import only; backend access remains inside storage. */
export async function legacyCredentials({ loadNative = () => import('@napi-rs/keyring'), platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new NhsError('unsupported', 'Legacy credential migration is only available on macOS.');
  try {
    const { AsyncEntry } = await loadNative();
    const email = await new AsyncEntry('openclaw-nhs-email', userInfo().username).getPassword();
    const password = await new AsyncEntry('openclaw-nhs-password', userInfo().username).getPassword();
    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) throw new Error();
    return { email: email.trim(), password };
  } catch { throw new NhsError('legacy_credentials_unavailable', 'Legacy Keychain credentials could not be read. Configure credentials with nhs auth login --save-credentials instead.'); }
}

export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new NhsError('unsafe_storage_path', 'Storage directory must be owned by the current user and must not be a symlink.');
  await chmod(path, 0o700);
}

export async function readPrivate(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > MAX_BYTES) throw new NhsError('unsafe_storage_file', 'Storage file has unsafe ownership, permissions, type, or size.');
    return await handle.readFile('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof NhsError) throw error;
    throw new NhsError('storage_read_failed', 'Could not safely read the storage file.');
  } finally { await handle?.close(); }
}

export async function atomicWrite(path, data, { replace = rename } = {}) {
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(data);
    await file.sync();
    await file.close(); file = undefined;
    await replace(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file?.close();
    await unlink(temporary).catch(() => {});
  }
}

/** Serializes the entire command, including auth renewal, migration and writes. */
export async function withLock(directory, run, { timeoutMs = 10000 } = {}) {
  await privateDirectory(directory);
  const path = join(directory, 'operation.lock');
  const deadline = Date.now() + timeoutMs;
  let held = false;
  while (!held) {
    try {
      await mkdir(path, { mode: 0o700 }); held = true;
      await atomicWrite(join(path, 'owner.json'), JSON.stringify({ pid: process.pid }));
    } catch (error) {
      if (held) { await rm(path, { recursive: true, force: true }); throw error; }
      if (error.code !== 'EEXIST') throw new NhsError('storage_lock_failed', 'Could not acquire the storage lock.');
      // Never steal a live or unidentifiable lock. A crashed process requires explicit repair.
      if (Date.now() >= deadline) throw new NhsError('storage_busy', 'Another nhs command holds the storage lock. If it crashed, verify no nhs process is running before removing operation.lock.');
      await sleep(100);
    }
  }
  try { return await run(); } finally { await rm(path, { recursive: true, force: true }); }
}

export function injectedKey(env = process.env) {
  const raw = env.NHS_CLI_STATE_KEY;
  if (!raw || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) throw new NhsError('storage_key_required', 'Encrypted-file storage requires NHS_CLI_STATE_KEY containing a base64-encoded random 32-byte key from your secret manager.');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new NhsError('storage_key_required', 'NHS_CLI_STATE_KEY must decode to exactly 32 bytes.');
  return key;
}

/**
 * Linux enumeration is implemented directly against Secret Service in pinned
 * @napi-rs/keyring 2.0.0. A non-secret probe proves a NEW Entry is bound to that
 * store before we ever give it a secret. Reuse that Entry for the key write:
 * constructing another Entry would re-run the library's fallback selection.
 */
export class NativeKeyProvider {
  constructor({ platform = process.platform, loadNative = () => import('@napi-rs/keyring'), service = SERVICE } = {}) {
    this.platform = platform; this.loadNative = loadNative; this.service = service;
  }
  async key(create = false) {
    if (!['darwin', 'linux'].includes(this.platform)) throw storageError();
    try {
      const native = await this.loadNative();
      let value;
      if (this.platform === 'linux') {
        const rows = await native.findCredentialsAsync(this.service);
        const matches = rows.filter(row => row.account === ACCOUNT);
        if (matches.length > 1) throw storageError();
        value = matches[0]?.password;
      } else {
        value = await new native.AsyncEntry(this.service, ACCOUNT).getPassword();
      }
      if (this.platform === 'linux' && /^nhs-cli-storage-probe:[0-9a-f]{32}$/.test(value || '')) value = undefined;
      if (value) {
        const key = Buffer.from(value, 'base64');
        if (key.length !== 32 || key.toString('base64') !== value) throw storageError();
        return key;
      }
      if (!create) return null;
      const entry = new native.AsyncEntry(this.service, ACCOUNT);
      if (this.platform === 'linux') {
        const probe = `nhs-cli-storage-probe:${randomBytes(16).toString('hex')}`;
        await entry.setPassword(probe);
        try {
          const rows = await native.findCredentialsAsync(this.service);
          if (!rows.some(row => row.account === ACCOUNT && row.password === probe)) throw storageError();
        } catch {
          await entry.deleteCredential().catch(() => {});
          throw storageError();
        }
      }
      const key = randomBytes(32);
      await entry.setPassword(key.toString('base64'));
      const verified = await this.key(false);
      if (!verified || !timingSafeEqual(verified, key)) throw storageError();
      return key;
    } catch { throw storageError(); }
  }
}

/** @typedef {import('./types.mjs').SecureStore} SecureStore */
/** @implements {SecureStore} */
export class VaultStore {
  constructor({ directory, backend = 'keyring', keyProvider = new NativeKeyProvider(), env = process.env }) {
    this.directory = directory; this.backend = backend; this.keyProvider = keyProvider; this.env = env;
    this.path = join(directory, 'vault.enc');
  }
  async getKey(create = false) {
    return this.backend === 'encrypted-file' ? injectedKey(this.env) : this.keyProvider.key(create);
  }
  async probe() { await this.getKey(false); }
  /** @returns {Promise<import('./types.mjs').Vault>} */
  async load() {
    const key = await this.getKey(false);
    const raw = await readPrivate(this.path);
    if (raw === null) return { version: 1, session: {} };
    if (!key) throw new NhsError('storage_key_missing', 'An encrypted vault exists but its key is unavailable. Restore the original key; the vault has not been overwritten.');
    try {
      const envelope = JSON.parse(raw);
      if (envelope.version !== 1) throw new Error();
      const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
      if (iv.length !== 12 || tag.length !== 16) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(AAD); decipher.setAuthTag(tag);
      const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8'));
      if (value.version !== 1 || !value.session || typeof value.session !== 'object' || Array.isArray(value.session)) throw new Error();
      return value;
    } catch { throw new NhsError('storage_corrupt', 'Could not authenticate the encrypted vault. Check the injected key or restore the encrypted vault; it has not been overwritten.'); }
  }
  /** @param {import('./types.mjs').Vault} value */
  async save(value) {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > MAX_BYTES / 2) throw new NhsError('storage_too_large', 'Authentication state exceeds the supported vault size.');
    const key = await this.getKey(true);
    if (!key) throw storageError();
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);
    await privateDirectory(this.directory);
    await atomicWrite(this.path, JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }));
  }
}

/** Run only under withLock. Local status and diagnostics never migrate. */
export async function migrateLegacy(store, path) {
  const vault = await store.load();
  const raw = await readPrivate(path);
  if (raw === null) return vault;
  const digest = createHash('sha256').update(raw).digest('hex');
  if (vault.legacyMigrated) {
    // A crash may happen after verified secure storage but before unlink. Never
    // reimport old sessions over rotated state, or remove a different source.
    if (vault.legacyMigrationDigest !== digest) throw new NhsError('migration_conflict', 'Legacy state changed after migration. The secure vault and legacy file have both been preserved.');
    await unlink(path);
    return vault;
  }
  let old;
  try { old = JSON.parse(raw); } catch { throw new NhsError('migration_failed', 'Legacy state is invalid; it has not been changed.'); }
  const allowed = ['csrfToken', 'patientId', 'sessionId', 'sessionExpiry', 'rememberMyDevice', 'rmdToken', 'lastOtpTriggerAt', 'updatedAt'];
  const session = Object.fromEntries(allowed.filter(key => typeof old[key] === 'string').map(key => [key, old[key]]));
  const next = { ...vault, session: { ...session, ...vault.session }, legacyMigrated: true, legacyMigrationDigest: digest };
  await store.save(next);
  const verified = await store.load();
  if (JSON.stringify(verified) !== JSON.stringify(next)) throw new NhsError('migration_failed', 'Secure migration verification failed; the legacy file has been preserved.');
  await unlink(path);
  return next;
}
