import { NhsError } from './errors.mjs';
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

const secretKey = /^(?:authorization|cookie|cookies|set-cookie|password|csrfToken|token|accessToken|refreshToken|id_token|rmd_token|rmdToken|rememberMyDevice|remember_my_device|sessionId|patientId|patientSessionId|sessionExpiry|codeVerifier|nonce)$/i;
/** Strip protocol secrets from domain output; clinical data remains intentionally visible. */
export function publicData(value) {
  if (Array.isArray(value)) return value.map(publicData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKey.test(key)).map(([key, item]) => [key, publicData(item)]));
  return value;
}
function terminalText(text) { return String(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ''); }
export function render(payload, json) {
  const data = publicData(payload);
  if (json) return `${JSON.stringify(data, null, 2)}\n`;
  if (Array.isArray(data.checks)) return data.checks.map(check => `${check.ok ? '[OK]' : '[FAIL]'} ${check.name}: ${terminalText(check.detail)}`).join('\n') + '\n';
  if (data.courses && !data.order) return data.courses.map(course => `${course.requestable ? '[REQUESTABLE]' : '[not available]'} ${terminalText(course.name)}${course.details ? `\n  ${terminalText(course.details).replace(/\n/g, '\n  ')}` : ''}`).join('\n') + `\n\n${data.summary.requestable} of ${data.summary.total} medication(s) available to order.\n`;
  if (data.ok === false) return `Error [${data.code}]: ${terminalText(data.message)}\n`;
  // Nested record sections retain their labels and structure in human output.
  return `${JSON.stringify(data, null, 2)}\n`;
}
export async function exportFile(path, content) {
  const absolute = resolve(path); let handle; let created = false;
  try {
    handle = await open(absolute, 'wx', 0o600); created = true;
    await handle.writeFile(content); await handle.sync();
    return absolute;
  } catch (error) {
    if (created) await unlink(absolute).catch(() => {});
    throw new NhsError('export_failed', 'Could not create the export. Choose a new file path in an existing directory; existing files are never overwritten.');
  } finally { await handle?.close(); }
}
