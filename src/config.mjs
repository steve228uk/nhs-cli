import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { NhsError } from './errors.mjs';

// Observed public web client, 2026-09-06. Update together with docs/api-research.md.
export const compatibility = Object.freeze({
  webVersion: 'v4.76.3 (commit:bfaf34f72f)',
  nativeVersion: 'web',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
});
export const origins = Object.freeze({
  app: 'https://www.nhsapp.service.nhs.uk',
  api: 'https://api.nhsapp.service.nhs.uk',
  gpconnect: 'https://gpconnectapi.nhsapp.service.nhs.uk/api',
  login: 'https://api.login.nhs.uk',
  authorize: 'https://auth.login.nhs.uk',
  access: 'https://access.login.nhs.uk',
});
export const callback = `${origins.app}/auth-return`;
export const gpCallback = `${origins.app}/on-demand-gp-return`;

export function settings(env = process.env) {
  const dataHome = env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  const dataDir = env.NHS_CLI_DATA_DIR || join(dataHome, 'nhs-cli');
  if (!isAbsolute(dataDir)) throw new NhsError('configuration_error', 'NHS_CLI_DATA_DIR and XDG_DATA_HOME must be absolute paths.');
  const backend = env.NHS_CLI_STORAGE || 'keyring';
  if (!['keyring', 'encrypted-file'].includes(backend)) throw new NhsError('configuration_error', 'NHS_CLI_STORAGE must be keyring or encrypted-file.');
  return { dataDir, backend, legacyPath: join(homedir(), '.local', 'share', 'nhs-prescriptions', 'state.json') };
}
