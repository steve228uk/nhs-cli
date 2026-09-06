#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BASE_URL = 'https://api.nhsapp.service.nhs.uk';
const STATE_DIR = join(homedir(), '.local', 'share', 'nhs-prescriptions');
const STATE_PATH = join(STATE_DIR, 'state.json');
const MESSAGES_DB = join(homedir(), 'Library', 'Messages', 'chat.db');
const CREDENTIALS_ENV = 'NHS_PRESCRIPTIONS_CREDENTIALS';
const KEYCHAIN_EMAIL_SERVICE = 'openclaw-nhs-email';
const KEYCHAIN_PASSWORD_SERVICE = 'openclaw-nhs-password';
const BROWSER_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) nhsapp-ios/6.2.0 nhsapp-manufacturer/Apple nhsapp-model/iPhone17,4 nhsapp-os/26.5 nhsapp-architecture/arm64e';
const APP_UA = 'nhsapp-ios/6.2.0 nhsapp-manufacturer/Apple nhsapp-model/iPhone17,4 nhsapp-os/26.5 nhsapp-architecture/arm64e';
const WEB_VERSION = '4.63.2 (commit:615ae49071)';
const NATIVE_VERSION = 'ios 6.2.0';
const OTP_TRIGGER_COOLDOWN_MS = 10 * 60 * 1000;
const OTP_MESSAGES_POLL_MS = 60 * 1000;
const OTP_MESSAGES_POLL_INTERVAL_MS = 10 * 1000;
const COURSES_598_RETRY_ATTEMPTS = 12;
const COURSES_598_RETRY_INTERVAL_MS = 10 * 1000;
const COURSES_598_REFRESH_AFTER_ATTEMPTS = 3;

class NhsError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'NhsError';
    this.code = code;
    this.details = details;
  }
}

class CookieJar {
  constructor(initial = {}) {
    this.cookies = { ...initial };
  }

  absorb(headers) {
    for (const raw of headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      this.cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
  }

  toString() {
    return Object.entries(this.cookies).map(([key, value]) => `${key}=${value}`).join('; ');
  }

  get(name) {
    return this.cookies[name];
  }
}

function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(STATE_DIR, 0o700);
  } catch {
    // Best effort on filesystems that do not support POSIX modes.
  }
}

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function loadState() {
  ensureStateDir();
  return loadJson(STATE_PATH);
}

function saveState(state) {
  ensureStateDir();
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  try {
    chmodSync(STATE_PATH, 0o600);
  } catch {
    // Best effort on filesystems that do not support POSIX modes.
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildAuthorizeUrl(codeChallenge, nonce, state) {
  const url = new URL('https://auth.login.nhs.uk/authorize');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', 'nhs-online');
  url.searchParams.set('scope', 'openid profile email profile_extended gp_registration_details');
  url.searchParams.set('vtr', JSON.stringify(['P5.Cp.Cd', 'P5.Cp.Ck', 'P5.Cm', 'P9.Cp.Cd', 'P9.Cp.Ck', 'P9.Cm']));
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri', 'https://www.nhsapp.service.nhs.uk/auth-return');
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('state', state);
  return url.toString();
}

function redact(value) {
  return String(value ?? '')
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9._-]{24,}\.[A-Za-z0-9._-]{16,}/g, '[redacted-jwt]')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '[redacted-token]')
    .replace(/\b\d{6}\b/g, '[redacted-code]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/(NHSO-Session-Id=)[^;\s]+/gi, '$1[redacted]')
    .replace(/(NHSO-Session-Expiry=)[^;\s]+/gi, '$1[redacted]')
    .replace(/(authorization|csrfToken|email|id_token|password|patientId|patientSessionId|phone_number|phoneNumber|sessionId|sessionExpiry|token|rmdToken|rememberMyDevice)["']?\s*[:=]\s*["']?[^"',\s}]+/gi, '$1:[redacted]');
}

function outputJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function parseCredentialsPayload(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new NhsError('missing_credentials', `${CREDENTIALS_ENV} is not set. Configure secret injection or the supported macOS Keychain entries.`);
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new NhsError('invalid_credentials', `${CREDENTIALS_ENV} must be a JSON object with email and password fields.`);
  }
  const email = typeof parsed.email === 'string' ? parsed.email.trim() : '';
  const password = typeof parsed.password === 'string' ? parsed.password : '';
  if (!email || !password) throw new NhsError('invalid_credentials', `${CREDENTIALS_ENV} must include non-empty email and password fields.`);
  return { email, password };
}

async function resolveCredentials() {
  if (process.env[CREDENTIALS_ENV]) {
    return { ...parseCredentialsPayload(process.env[CREDENTIALS_ENV]), source: CREDENTIALS_ENV };
  }

  const [email, password] = await Promise.all([
    readKeychainSecret(KEYCHAIN_EMAIL_SERVICE),
    readKeychainSecret(KEYCHAIN_PASSWORD_SERVICE),
  ]);
  if (email && password) return { email, password, source: 'macOS Keychain' };

  throw new NhsError(
    'missing_credentials',
    `${CREDENTIALS_ENV} is not set and Keychain entries ${KEYCHAIN_EMAIL_SERVICE}/${KEYCHAIN_PASSWORD_SERVICE} were not available.`,
  );
}

async function readKeychainSecret(service) {
  if (process.platform !== 'darwin') return null;
  const attempts = [
    ['find-generic-password', '-a', process.env.USER || '', '-s', service, '-w'],
    ['find-generic-password', '-s', service, '-w'],
    ['find-generic-password', '-l', service, '-w'],
  ];

  for (const args of attempts) {
    try {
      const { stdout } = await execFileAsync('/usr/bin/security', args, { timeout: 5000, maxBuffer: 256 * 1024 });
      const value = stdout.trim();
      if (value) return value;
    } catch {
      // Try the next Keychain lookup form.
    }
  }
  return null;
}

function parseArgs(argv) {
  const [, , command = 'status', ...rest] = argv;
  const flags = new Map();
  const positional = [];
  for (const arg of rest) {
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) flags.set(arg.slice(2), true);
    else flags.set(arg.slice(2, eq), arg.slice(eq + 1));
  }
  return { command, flags, positional };
}

function wantJson(flags) {
  return flags.has('json') || !process.stdout.isTTY;
}

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer.trim());
  }));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isLikelyNhsOtpText(text) {
  return /\b\d{6}\b/.test(text) && /(nhs|login|security|verification|code|passcode|one-time|one time|otp)/i.test(text);
}

function extractOtpCode(text) {
  if (!isLikelyNhsOtpText(text)) return null;
  return text.match(/\b(\d{6})\b/)?.[1] ?? null;
}

async function readOtpFromMessages({ maxAgeMinutes = 15, debug = false } = {}) {
  if (process.platform !== 'darwin') throw new NhsError('otp_messages_unsupported', 'Messages OTP lookup is only supported on macOS.');
  if (!existsSync(MESSAGES_DB)) throw new NhsError('otp_messages_unavailable', 'Messages database not found.');

  const sinceUnix = Math.floor(Date.now() / 1000) - maxAgeMinutes * 60;
  const sql = `
    SELECT text,
           CASE
             WHEN date > 1000000000000 THEN CAST(date / 1000000000 + 978307200 AS INTEGER)
             ELSE CAST(date + 978307200 AS INTEGER)
           END AS received_unix
    FROM message
    WHERE text IS NOT NULL
      AND (
        text LIKE '%NHS%' OR text LIKE '%security%' OR text LIKE '%verification%' OR
        text LIKE '%code%' OR text LIKE '%passcode%' OR text LIKE '%one-time%' OR text LIKE '%OTP%'
      )
    ORDER BY date DESC
    LIMIT 30;
  `;

  let stdout;
  try {
    ({ stdout } = await execFileAsync('sqlite3', ['-json', MESSAGES_DB, sql], { timeout: 5000, maxBuffer: 1024 * 1024 }));
  } catch (error) {
    throw new NhsError('otp_messages_failed', 'Could not read Messages for OTP. Grant Full Disk Access to the app or terminal running this command, or enter the code manually.', { cause: error.message });
  }

  let rows;
  try {
    rows = JSON.parse(stdout || '[]');
  } catch {
    rows = [];
  }

  const candidates = rows
    .filter(row => Number(row.received_unix) >= sinceUnix)
    .map(row => ({ code: extractOtpCode(row.text ?? ''), receivedUnix: Number(row.received_unix) }))
    .filter(row => row.code);

  if (debug) console.error(`Messages OTP candidates: ${candidates.length}`);
  if (candidates[0]?.code) return candidates[0].code;
  throw new NhsError('otp_not_found', `No recent NHS OTP was found in Messages from the last ${maxAgeMinutes} minutes.`);
}

async function resolveOtp({ allowPrompt = process.stdin.isTTY, debug = false } = {}) {
  const deadline = Date.now() + OTP_MESSAGES_POLL_MS;
  let messagesError;

  try {
    return await readOtpFromMessages({ debug });
  } catch (error) {
    messagesError = error;
  }

  while (messagesError?.code === 'otp_not_found' && Date.now() < deadline) {
    const waitMs = Math.min(OTP_MESSAGES_POLL_INTERVAL_MS, deadline - Date.now());
    if (waitMs <= 0) break;
    if (debug) console.error(`No NHS OTP found in Messages yet. Retrying in ${Math.ceil(waitMs / 1000)} second(s).`);
    await delay(waitMs);
    try {
      return await readOtpFromMessages({ debug });
    } catch (error) {
      messagesError = error;
    }
  }

  if (!allowPrompt) throw messagesError;
  console.error(`${messagesError.message} Falling back to manual OTP entry.`);
  const code = await prompt('Enter NHS OTP code: ');
  if (!/^\d{6}$/.test(code)) throw new NhsError('otp_invalid', 'OTP must be a six-digit code.');
  return code;
}

function assertOtpTriggerAllowed(state, { forceOtp = false } = {}) {
  if (forceOtp) return;
  const lastTriggeredAt = Date.parse(state.lastOtpTriggerAt || '');
  if (!Number.isFinite(lastTriggeredAt)) return;
  const remainingMs = OTP_TRIGGER_COOLDOWN_MS - (Date.now() - lastTriggeredAt);
  if (remainingMs <= 0) return;
  throw new NhsError(
    'otp_recently_requested',
    `An NHS OTP was requested recently. Wait ${Math.ceil(remainingMs / 60000)} minute(s), or rerun with --force-otp if you are intentionally requesting another code.`,
    { lastOtpTriggerAt: state.lastOtpTriggerAt },
  );
}

async function login(state, options = {}) {
  const { email, password } = await resolveCredentials();

  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const nonce = randomBytes(32).toString('base64url');
  const oauthState = randomBytes(32).toString('base64url');
  const jar = new CookieJar();

  const authRes = await fetch(buildAuthorizeUrl(codeChallenge, nonce, oauthState), {
    redirect: 'manual',
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,*/*' },
  });
  jar.absorb(authRes.headers);
  const loginUrl = authRes.headers.get('location');
  if (!loginUrl) throw new NhsError('auth_redirect_missing', 'No redirect from NHS authorize endpoint.');

  let res = await fetch(loginUrl, {
    redirect: 'manual',
    headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,*/*', Cookie: jar.toString() },
  });
  jar.absorb(res.headers);
  while (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
    res = await fetch(res.headers.get('location'), {
      redirect: 'manual',
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,*/*', Cookie: jar.toString() },
    });
    jar.absorb(res.headers);
  }

  const authCookieRaw = jar.get('nhs-authorization-cookie');
  if (!authCookieRaw) throw new NhsError('auth_cookie_missing', 'NHS authorization cookie not found. The auth flow may have changed.');
  let authParams;
  try {
    authParams = JSON.parse(decodeURIComponent(authCookieRaw));
  } catch {
    authParams = JSON.parse(authCookieRaw);
  }
  const sessionId = authParams.session_id;

  if (state.rememberMyDevice && state.rememberMyDevice !== 'INVALID') jar.cookies.remember_my_device = state.rememberMyDevice;

  const signInRes = await fetch('https://api.login.nhs.uk/login/user-sign-in', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://access.login.nhs.uk',
      Referer: 'https://access.login.nhs.uk/',
      'User-Agent': BROWSER_UA,
      session_id: sessionId,
      Cookie: jar.toString(),
    },
    body: JSON.stringify({
      email,
      password,
      rmd_token: state.rmdToken && state.rmdToken !== 'INVALID' ? state.rmdToken : null,
    }),
  });
  if (!signInRes.ok) throw new NhsError('signin_failed', `NHS sign-in failed with HTTP ${signInRes.status}.`, { body: await signInRes.text() });
  jar.absorb(signInRes.headers);
  const signInData = await signInRes.json();

  const authCode = signInData.authentication_state === 'AUTHENTICATED'
    ? await completeAuthenticatedRedirect(signInData, jar, state)
    : await handleOtp(signInData, sessionId, jar, authParams, state, options);

  const sessionRes = await fetch(`${BASE_URL}/v1/session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: '*/*',
      'User-Agent': APP_UA,
      'NHSO-Request-ID': randomBytes(16).toString('hex').toUpperCase(),
    },
    body: JSON.stringify({
      authCode,
      codeVerifier,
      redirectUrl: 'https://www.nhsapp.service.nhs.uk/auth-return',
      referrer: '',
      integrationReferrer: '',
      nonce,
    }),
  });
  if (!sessionRes.ok) throw new NhsError('session_create_failed', `NHS session creation failed with HTTP ${sessionRes.status}.`, { body: await sessionRes.text() });

  const sessionData = await sessionRes.json();
  const sessionCookies = new CookieJar();
  sessionCookies.absorb(sessionRes.headers);

  state.csrfToken = sessionData.token;
  state.patientId = sessionData.patientSessionId;
  state.sessionId = sessionCookies.get('NHSO-Session-Id');
  state.sessionExpiry = sessionCookies.get('NHSO-Session-Expiry');
  state.updatedAt = new Date().toISOString();
  saveState(state);
  return state;
}

async function completeAuthenticatedRedirect(signInData, jar, state) {
  if (signInData.rmd_token) state.rmdToken = signInData.rmd_token;
  const newRmd = jar.get('remember_my_device');
  if (newRmd) state.rememberMyDevice = newRmd;
  const redirectRes = await fetch(signInData.redirect_uri, {
    redirect: 'manual',
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,*/*',
      Referer: 'https://access.login.nhs.uk/',
      Cookie: jar.toString(),
    },
  });
  jar.absorb(redirectRes.headers);
  const loc = redirectRes.headers.get('location');
  if (!loc) throw new NhsError('authcode_redirect_missing', 'No redirect from NHS authenticated authcode path.');
  const authCode = new URL(loc).searchParams.get('code');
  if (!authCode) throw new NhsError('authcode_missing', 'No auth code in NHS redirect.');
  return authCode;
}

async function handleOtp(signInData, sessionId, jar, authParams, state, options) {
  const headers = () => ({
    'Content-Type': 'application/json; charset=utf-8',
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://access.login.nhs.uk',
    Referer: 'https://access.login.nhs.uk/',
    'User-Agent': BROWSER_UA,
    session_id: sessionId,
    Cookie: jar.toString(),
  });

  assertOtpTriggerAllowed(state, options);

  const triggerRes = await fetch('https://api.login.nhs.uk/login/trigger-otp', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ is_login: true, otp_type: 'mobile' }),
  });
  jar.absorb(triggerRes.headers);
  if (triggerRes.status === 403) throw new NhsError('otp_locked', 'NHS OTP is locked out. Wait 15 minutes and retry.');
  if (!triggerRes.ok) throw new NhsError('otp_trigger_failed', `NHS OTP trigger failed with HTTP ${triggerRes.status}.`, { body: await triggerRes.text() });
  state.lastOtpTriggerAt = new Date().toISOString();
  saveState(state);

  const otpCode = await resolveOtp(options);
  const otpRes = await fetch('https://api.login.nhs.uk/login/otp', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ client_id: 'nhs-online', session_id: sessionId, otp_code: otpCode, remember_my_device: 'true' }),
  });
  jar.absorb(otpRes.headers);
  if (otpRes.status === 403) throw new NhsError('otp_locked', 'NHS OTP is locked out. Wait 15 minutes and retry.');
  if (!otpRes.ok) throw new NhsError('otp_verify_failed', `NHS OTP verification failed with HTTP ${otpRes.status}.`, { body: await otpRes.text() });
  const { id_token: idToken } = await otpRes.json();

  const rmdRes = await fetch('https://api.login.nhs.uk/login/remember-my-device', {
    method: 'POST',
    headers: { ...headers(), Cookie: new CookieJar({ ...jar.cookies, id_token: idToken }).toString() },
    body: JSON.stringify({}),
  });
  jar.absorb(rmdRes.headers);
  if (rmdRes.ok) {
    const rmdData = await rmdRes.json().catch(() => ({}));
    const rmdToken = rmdData.rmd_token ?? jar.get('remember_my_device');
    if (rmdToken) {
      state.rmdToken = rmdToken;
      state.rememberMyDevice = rmdToken;
    }
  }

  const authcodeRes = await fetch('https://auth.login.nhs.uk/authcode', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'application/json, text/plain, */*',
      Authorization: idToken,
      Origin: 'https://access.login.nhs.uk',
      Referer: 'https://access.login.nhs.uk/',
      'User-Agent': BROWSER_UA,
    },
    body: JSON.stringify({
      scope: authParams.scope,
      response_type: authParams.response_type,
      client_id: authParams.client_id,
      redirect_uri: authParams.redirect_uri,
      session_id: sessionId,
      state: authParams.state,
      nonce: authParams.nonce,
      code_challenge: authParams.code_challenge,
      code_challenge_method: authParams.code_challenge_method,
      vtr: authParams.vtr,
    }),
  });
  jar.absorb(authcodeRes.headers);
  const authcodeBody = await authcodeRes.text();
  if (options.debug) {
    const locationHeader = authcodeRes.headers.get('location');
    console.error(`[debug] NHS /authcode status=${authcodeRes.status} content-type=${authcodeRes.headers.get('content-type') || 'unknown'} location-header=${redact(locationHeader || '[none]')}`);
    try {
      const debugData = JSON.parse(authcodeBody);
      console.error(`[debug] NHS /authcode JSON keys=${Object.keys(debugData).join(', ') || '[none]'}`);
      if (debugData.Location || debugData.location) console.error(`[debug] NHS /authcode location=${redact(debugData.Location || debugData.location)}`);
    } catch {
      console.error(`[debug] NHS /authcode body=${redact(authcodeBody.slice(0, 1000))}`);
    }
  }
  if (!authcodeRes.ok) throw new NhsError('authcode_failed', `NHS authcode exchange failed with HTTP ${authcodeRes.status}.`, { body: authcodeBody });

  let authcodeData;
  try {
    authcodeData = JSON.parse(authcodeBody);
  } catch {
    throw new NhsError('authcode_invalid_response', 'NHS authcode exchange returned invalid JSON.', { body: authcodeBody });
  }
  const location = authcodeData.Location;
  if (!location) throw new NhsError('authcode_location_missing', 'No Location in NHS authcode response.');
  const authCode = new URL(location).searchParams.get('code');
  if (!authCode) throw new NhsError('authcode_missing', 'No auth code in NHS authcode Location.');
  return authCode;
}

function buildHeaders(state) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-CSRF-TOKEN': state.csrfToken,
    'NHSO-Patient-Id': state.patientId,
    'NHSO-Request-ID': randomBytes(16).toString('hex').toUpperCase(),
    'NHSO-Web-Version-Tag': WEB_VERSION,
    'NHSO-Native-Version-Tag': NATIVE_VERSION,
    'User-Agent': APP_UA,
    Origin: 'https://www.nhsapp.service.nhs.uk',
    Referer: 'https://www.nhsapp.service.nhs.uk/',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Cookie: `NHSO-Session-Expiry=${state.sessionExpiry}; NHSO-Session-Id=${state.sessionId}`,
  };
}

async function ensureSession(state, options = {}) {
  if (!state.csrfToken || !state.sessionId) {
    if (options.allowLogin === false) throw new NhsError('login_required', 'No stored NHS session is available. Run login explicitly.');
    return login(state, options);
  }

  const res = await fetch(`${BASE_URL}/v1/session`, { headers: buildHeaders(state) });
  if (!res.ok) {
    if (options.allowLogin === false) throw new NhsError('login_required', 'Stored NHS session is expired. Run login explicitly.');
    return login(state, options);
  }

  const sessionData = await res.json();
  const jar = new CookieJar();
  jar.absorb(res.headers);
  if (jar.get('NHSO-Session-Expiry')) {
    state.sessionExpiry = jar.get('NHSO-Session-Expiry');
    state.updatedAt = new Date().toISOString();
    saveState(state);
  }
  if (!sessionData.hasGpSession) state = await ensureGpSession(state);
  return state;
}

async function ensureGpSession(state) {
  const aliRes = await fetch(`${BASE_URL}/v1/patient/asserted-login-identity`, {
    method: 'POST',
    headers: buildHeaders(state),
    body: JSON.stringify({ IntendedRelyingPartyUrl: 'www.nhsapp.service.nhs.uk' }),
  });
  if (!aliRes.ok) throw new NhsError('gp_identity_failed', `NHS asserted-login-identity failed with HTTP ${aliRes.status}.`, { body: await aliRes.text() });
  const { token: aliToken } = await aliRes.json();

  const nonce = randomBytes(32).toString('base64url');
  const authorizeUrl = new URL('https://auth.login.nhs.uk/authorize');
  authorizeUrl.searchParams.set('asserted_login_identity', aliToken);
  authorizeUrl.searchParams.set('scope', 'openid profile email profile_extended nhs_app_credentials gp_registration_details');
  authorizeUrl.searchParams.set('redirect_uri', 'https://www.nhsapp.service.nhs.uk/on-demand-gp-return');
  authorizeUrl.searchParams.set('client_id', 'nhs-online');
  authorizeUrl.searchParams.set('state', encodeURIComponent('/patient/prescriptions/repeat-courses'));
  authorizeUrl.searchParams.set('vtr', JSON.stringify(['P5.Cp.Cd', 'P5.Cp.Ck', 'P5.Cm', 'P9.Cp.Cd', 'P9.Cp.Ck', 'P9.Cm']));
  authorizeUrl.searchParams.set('nonce', nonce);
  authorizeUrl.searchParams.set('response_type', 'code');

  const jar = new CookieJar();
  let gpAuthCode;
  let url = authorizeUrl.toString();
  for (let i = 0; i < 10; i += 1) {
    const redirectRes = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html,application/xhtml+xml,*/*', Cookie: jar.toString() },
    });
    jar.absorb(redirectRes.headers);
    const loc = redirectRes.headers.get('location');
    if (!loc) throw new NhsError('gp_sso_redirect_missing', `NHS GP SSO returned no redirect at step ${i}.`);
    if (loc.startsWith('https://www.nhsapp.service.nhs.uk/on-demand-gp-return')) {
      gpAuthCode = new URL(loc).searchParams.get('code');
      break;
    }
    url = loc.startsWith('http') ? loc : `https://auth.login.nhs.uk${loc}`;
  }
  if (!gpAuthCode) throw new NhsError('gp_authcode_missing', 'NHS GP SSO did not return an auth code.');

  const gpSessionRes = await fetch(`${BASE_URL}/v1/session/gp-session-on-demand`, {
    method: 'PUT',
    headers: buildHeaders(state),
    body: JSON.stringify({
      authCode: gpAuthCode,
      redirectUrl: 'https://www.nhsapp.service.nhs.uk/on-demand-gp-return',
      integrationReferrer: null,
      referrerOrigin: null,
    }),
  });
  if (!gpSessionRes.ok) throw new NhsError('gp_session_failed', `NHS GP session creation failed with HTTP ${gpSessionRes.status}.`, { body: await gpSessionRes.text() });

  const gpSessionData = await gpSessionRes.json();
  if (gpSessionData.token) state.csrfToken = gpSessionData.token;
  if (gpSessionData.patientSessionId) state.patientId = gpSessionData.patientSessionId;
  const gpJar = new CookieJar();
  gpJar.absorb(gpSessionRes.headers);
  if (gpJar.get('NHSO-Session-Id')) state.sessionId = gpJar.get('NHSO-Session-Id');
  if (gpJar.get('NHSO-Session-Expiry')) state.sessionExpiry = gpJar.get('NHSO-Session-Expiry');
  state.updatedAt = new Date().toISOString();
  saveState(state);
  return state;
}

async function listCourses(state, options = {}) {
  const retryAttempts = options.retryAttempts ?? COURSES_598_RETRY_ATTEMPTS;
  const retryIntervalMs = options.retryIntervalMs ?? COURSES_598_RETRY_INTERVAL_MS;
  const refreshAfterAttempts = options.refreshAfterAttempts ?? COURSES_598_REFRESH_AFTER_ATTEMPTS;
  let currentState = state;
  let lastBody = '';
  let refreshedGpSession = false;
  for (let attempt = 1; attempt <= retryAttempts; attempt += 1) {
    const res = await fetch(`${BASE_URL}/v1/patient/courses`, { headers: buildHeaders(currentState) });
    if (res.status === 401) throw new NhsError('session_expired', 'NHS session expired. Run login again.');
    if (res.status === 598) {
      lastBody = await res.text();
      if (!refreshedGpSession && typeof options.refreshGpSession === 'function' && attempt >= refreshAfterAttempts) {
        await delay(retryIntervalMs);
        currentState = await options.refreshGpSession(currentState);
        refreshedGpSession = true;
        continue;
      }
      if (attempt < retryAttempts) {
        await delay(retryIntervalMs);
        continue;
      }
      throw new NhsError('courses_failed', `NHS courses request failed with HTTP ${res.status} after ${retryAttempts} attempts.`, { body: lastBody });
    }
    if (!res.ok) {
      throw new NhsError('courses_failed', `NHS courses request failed with HTTP ${res.status}.`, { body: await res.text() });
    }
    return res.json();
  }
  throw new NhsError(
    'courses_failed',
    `NHS courses request failed after ${retryAttempts} attempts.`,
    lastBody ? { body: lastBody } : {},
  );
}

async function orderCourses(state, courseIds, specialRequest = '') {
  const res = await fetch(`${BASE_URL}/v1/patient/prescriptions`, {
    method: 'POST',
    headers: buildHeaders(state),
    body: JSON.stringify({ CourseIds: courseIds, SpecialRequest: specialRequest }),
  });
  if (!res.ok) throw new NhsError('order_failed', `NHS prescription order failed with HTTP ${res.status}.`, { body: await res.text() });
  return res.status === 201 ? { submitted: true } : res.json().catch(() => ({ submitted: true }));
}

function normalizeCourse(course) {
  return {
    id: course.id,
    name: course.name,
    details: course.details ?? '',
    requestable: Boolean(course.requestable),
  };
}

function buildStatusPayload(coursesData) {
  const courses = (coursesData.courses ?? []).map(normalizeCourse);
  const requestable = courses.filter(course => course.requestable);
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    summary: {
      total: courses.length,
      requestable: requestable.length,
      requestableNames: requestable.map(course => course.name),
      specialRequestNecessity: coursesData.specialRequestNecessity ?? 'None',
    },
    courses,
  };
}

function printStatus(payload) {
  console.log('');
  for (const course of payload.courses) {
    const tag = course.requestable ? '[REQUESTABLE]' : '[not available]';
    console.log(tag + ' ' + course.name);
    if (course.details) {
      for (const line of course.details.split(String.fromCharCode(10))) console.log('  ' + line);
    }
  }
  console.log('');
  console.log(payload.summary.requestable + ' of ' + payload.summary.total + ' medication(s) available to order.');
}

async function commandStatus(flags) {
  const state = await ensureSession(loadState(), {
    allowLogin: !flags.has('no-login'),
    allowPrompt: !flags.has('no-prompt'),
    debug: flags.has('debug'),
    forceOtp: flags.has('force-otp'),
  });
  const coursesData = await listCourses(state, { refreshGpSession: ensureGpSession });
  return buildStatusPayload(coursesData);
}

async function commandOrder(flags) {
  const state = await ensureSession(loadState(), {
    allowPrompt: !flags.has('no-prompt'),
    debug: flags.has('debug'),
    forceOtp: flags.has('force-otp'),
  });
  const coursesData = await listCourses(state, { refreshGpSession: ensureGpSession });
  const status = buildStatusPayload(coursesData);
  const requestable = status.courses.filter(course => course.requestable);
  const requestedIds = String(flags.get('ids') || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

  let selected;
  if (requestedIds.length > 0) {
    const selectedById = new Map(status.courses.map(course => [String(course.id), course]));
    const unknownIds = requestedIds.filter(id => !selectedById.has(id));
    const unavailableIds = requestedIds.filter(id => selectedById.has(id) && !selectedById.get(id).requestable);
    if (unknownIds.length > 0 || unavailableIds.length > 0) {
      throw new NhsError('order_invalid_scope', 'Some supplied medication IDs are unknown or not currently requestable.', { unknownIds, unavailableIds });
    }
    selected = requestedIds.map(id => selectedById.get(id));
  } else {
    if (!flags.has('all-requestable')) {
      throw new NhsError('order_requires_scope', 'Ordering requires --all-requestable or --ids=id1,id2 so the submitted scope is explicit.');
    }
    selected = requestable;
  }

  if (selected.length === 0) {
    return { ...status, order: { submitted: false, reason: 'no_requestable_courses' } };
  }
  if (flags.has('dry-run')) {
    return { ...status, order: { submitted: false, dryRun: true, courseIds: selected.map(course => course.id), selectedNames: selected.map(course => course.name) } };
  }
  if (!flags.has('confirm')) {
    throw new NhsError(
      'order_requires_confirmation',
      'Refusing to submit without --confirm. Review a fresh --dry-run result and confirm the exact medicines first.',
    );
  }
  const result = await orderCourses(state, selected.map(course => course.id), String(flags.get('note') || ''));
  return { ...status, order: { submitted: true, result, orderedNames: selected.map(course => course.name) } };
}

async function commandLogin(flags) {
  await login(loadState(), {
    allowPrompt: !flags.has('no-prompt'),
    debug: flags.has('debug'),
    forceOtp: flags.has('force-otp'),
  });
  return { ok: true, loggedIn: true, statePath: STATE_PATH };
}

async function commandOtp(flags) {
  const maxAgeMinutes = parsePositiveInteger(flags.get('max-age-minutes'), 15);
  await readOtpFromMessages({ maxAgeMinutes, debug: flags.has('debug') });
  return { ok: true, found: true, maxAgeMinutes };
}

async function commandDoctor() {
  ensureStateDir();
  const checks = [];
  let credentialsOk = false;
  let credentialsDetail = `${CREDENTIALS_ENV} is not set`;
  try {
    const credentials = await resolveCredentials();
    credentialsOk = Boolean(credentials.email && credentials.password);
    credentialsDetail = `available via ${credentials.source}`;
  } catch (error) {
    credentialsDetail = error.message;
  }
  checks.push({ name: 'node', ok: Number(process.versions.node.split('.')[0]) >= 18, detail: process.version });
  checks.push({
    name: 'credentials',
    ok: credentialsOk,
    detail: credentialsDetail,
  });
  checks.push({ name: 'stateDirectory', ok: existsSync(STATE_DIR), detail: STATE_DIR });
  checks.push({ name: 'messagesDatabase', ok: process.platform === 'darwin' && existsSync(MESSAGES_DB), detail: MESSAGES_DB });
  let sqliteOk = false;
  try {
    await execFileAsync('sqlite3', ['-version'], { timeout: 3000 });
    sqliteOk = true;
  } catch {
    sqliteOk = false;
  }
  checks.push({ name: 'sqlite3', ok: sqliteOk, detail: sqliteOk ? 'available' : 'sqlite3 not found or not executable' });
  if (existsSync(STATE_PATH)) {
    let mode = 'unknown';
    try {
      mode = `0${(statSync(STATE_PATH).mode & 0o777).toString(8)}`;
    } catch {
      mode = 'unknown';
    }
    checks.push({ name: 'statePermissions', ok: mode === '0600', detail: `${STATE_PATH} ${mode}` });
  }
  return { ok: checks.every(check => check.ok), checks, statePath: STATE_PATH };
}

async function main() {
  const { command, flags } = parseArgs(process.argv);
  const json = wantJson(flags);
  try {
    let payload;
    if (command === 'status' || command === 'list') payload = await commandStatus(flags);
    else if (command === 'order') payload = await commandOrder(flags);
    else if (command === 'login') payload = await commandLogin(flags);
    else if (command === 'otp') payload = await commandOtp(flags);
    else if (command === 'doctor') payload = await commandDoctor(flags);
    else {
      throw new NhsError('usage', 'Usage: nhs-prescriptions.mjs status|order|login|otp|doctor [--json] [--no-login] [--no-prompt] [--force-otp] [--dry-run] [--confirm] [--all-requestable] [--ids=id1,id2] [--note=...]');
    }

    if (json) outputJson(payload);
    else if (command === 'status' || command === 'list') printStatus(payload);
    else console.log(payload.ok ? 'OK' : 'Not OK');
  } catch (error) {
    const code = error.code || 'unexpected_error';
    const message = redact(error.message || String(error));
    if (json) {
      outputJson({
        ok: false,
        code,
        message,
        details: flags.has('debug') && error.details ? redact(JSON.stringify(error.details)) : undefined,
      });
    } else {
      console.error(`Error [${code}]: ${message}`);
    }
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { buildStatusPayload, extractOtpCode, isLikelyNhsOtpText, listCourses, parseCredentialsPayload, parsePositiveInteger, redact };
