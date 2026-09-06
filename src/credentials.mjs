import { NhsError } from './errors.mjs';
import { promptInput } from './ui.mjs';

export function parseCredentialsPayload(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { throw new NhsError('invalid_credentials', 'Injected credentials must be a JSON object containing email and password.'); }
  if (!value || typeof value.email !== 'string' || !value.email.trim() || typeof value.password !== 'string' || !value.password) throw new NhsError('invalid_credentials', 'Credentials require a non-empty email and password.');
  return { email: value.email.trim(), password: value.password };
}

export async function resolveCredentials(vault, { env = process.env, allowPrompt = false, prompt = promptInput } = {}) {
  const injected = env.NHS_CLI_CREDENTIALS || env.NHS_PRESCRIPTIONS_CREDENTIALS;
  if (injected) return { value: parseCredentialsPayload(injected), source: 'injected' };
  if (vault.credentials) return { value: parseCredentialsPayload(JSON.stringify(vault.credentials)), source: 'stored' };
  if (!allowPrompt) throw new NhsError('auth_required', 'No saved credentials are available. Run nhs auth login --save-credentials or configure secret injection.');
  const email = await prompt('NHS login email', { validate: value => value?.trim() ? undefined : 'Enter your NHS login email.' });
  const password = await prompt('NHS login password', { secret: true, validate: value => value ? undefined : 'Enter your password.' });
  return { value: parseCredentialsPayload(JSON.stringify({ email, password })), source: 'prompt' };
}
