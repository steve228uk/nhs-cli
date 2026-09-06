import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NhsError } from './errors.mjs';
import { promptInput } from './ui.mjs';

const exec = promisify(execFile);
export function isLikelyNhsOtpText(text) {
  return /\bNHS\b/i.test(text) && /\b(login|security|verification|code|passcode|OTP)\b/i.test(text) && /\b\d{6}\b/.test(text);
}
export function extractOtpCode(text) { return isLikelyNhsOtpText(text) ? text.match(/\b(\d{6})\b/)?.[1] ?? null : null; }

export async function readOtpFromMessages({ since = Date.now(), execImpl = exec, platform = process.platform } = {}) {
  if (platform !== 'darwin') throw new NhsError('otp_messages_unsupported', 'Messages OTP lookup requires macOS.');
  if (!Number.isFinite(since)) throw new NhsError('otp_invalid', 'The security-code challenge time is invalid.');
  const sql = `WITH nhs_messages AS (SELECT text, CASE WHEN date > 1000000000000 THEN date / 1000000000.0 + 978307200 ELSE date + 978307200 END AS received_unix FROM message WHERE is_from_me = 0 AND text LIKE '%NHS%') SELECT text, received_unix FROM nhs_messages WHERE received_unix >= ${since / 1000} ORDER BY received_unix DESC LIMIT 30;`;
  let rows;
  try {
    const { stdout } = await execImpl('sqlite3', ['-readonly', '-json', join(homedir(), 'Library', 'Messages', 'chat.db'), sql], { timeout: 5000, maxBuffer: 128 * 1024 });
    rows = JSON.parse(String(stdout) || '[]');
  } catch { throw new NhsError('otp_messages_unavailable', 'Messages OTP lookup is unavailable. Enter the code directly in the terminal or enable Messages access.'); }
  const now = Date.now();
  for (const row of rows) {
    const received = Number(row.received_unix) * 1000;
    if (!Number.isFinite(received) || received < since || received > now + 1000) continue;
    const code = extractOtpCode(row.text || ''); if (code) return code;
  }
  throw new NhsError('otp_not_found', 'No NHS code received after this login challenge was found.');
}

export async function resolveOtp({ since, messages = false, allowPrompt = false, prompt = promptInput, readMessages = readOtpFromMessages, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (messages) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try { return await readMessages({ since }); }
      catch (error) {
        if (error.code !== 'otp_not_found') { if (!allowPrompt) throw error; break; }
        if (attempt < 5) await pause(10000);
      }
    }
  }
  if (!allowPrompt) throw new NhsError('auth_required', 'NHS requires a security code. Run nhs auth login in a terminal.');
  const value = String(await prompt('NHS security code', { validate: value => /^\d{6}$/.test(value?.trim() || '') ? undefined : 'Enter the six-digit NHS security code.' })).trim();
  if (!/^\d{6}$/.test(value)) throw new NhsError('otp_invalid', 'The NHS security code must contain six digits.');
  return value;
}
