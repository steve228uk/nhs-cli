import { createHash, randomBytes } from 'node:crypto';
import { CookieJar, Transport, apiHeaders, assertHttp, jsonResponse, boundedBody, trustedUrl } from './transport.mjs';
import { callback, gpCallback, origins } from './config.mjs';
import { NhsError, shape } from './errors.mjs';
import { resolveCredentials, parseCredentialsPayload } from './credentials.mjs';
import { resolveOtp } from './otp.mjs';

const trust = ['P5.Cp.Cd', 'P5.Cp.Ck', 'P5.Cm', 'P9.Cp.Cd', 'P9.Cp.Ck', 'P9.Cm'];
const accountDigest = email => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
export function buildAuthorizeUrl(challenge, nonce, state) {
  const url = new URL('/authorize', origins.authorize);
  Object.entries({ response_type: 'code', client_id: 'nhs-online', scope: 'openid profile email profile_extended gp_registration_details', vtr: JSON.stringify(trust), code_challenge: challenge, code_challenge_method: 'S256', redirect_uri: callback, nonce, state }).forEach(([key, value]) => url.searchParams.set(key, value));
  return url;
}

export function callbackCode(value, expectedState, expectedCallback = callback) {
  const url = trustedUrl(value);
  const target = new URL(expectedCallback);
  if (url.origin !== target.origin || url.pathname !== target.pathname || url.hash || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== expectedState || url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code')) throw new NhsError('oauth_validation_failed', 'NHS authorization callback failed destination or state validation.');
  return url.searchParams.get('code');
}

/** @typedef {{allowLogin?: boolean, allowPrompt?: boolean, messages?: boolean, forceOtp?: boolean, saveCredentials?: boolean, env?: NodeJS.ProcessEnv, onPhase?: (phase: string) => void}} AuthOptions */
export class AuthClient {
  /** @param {{store: import('./types.mjs').SecureStore, vault: import('./types.mjs').Vault, transport?: Transport, options?: AuthOptions, credentials?: typeof resolveCredentials, otp?: typeof resolveOtp, now?: () => number}} input */
  constructor({ store, vault, transport = new Transport(), options = {}, credentials = resolveCredentials, otp = resolveOtp, now = Date.now }) {
    this.store = store; this.vault = vault; this.transport = transport; this.options = options;
    this.credentials = credentials; this.otp = otp; this.now = now; this.loginAttempts = 0;
    this.jar = vault.session.cookies ? CookieJar.fromJSON(vault.session.cookies) : new CookieJar();
    /** @type {string | undefined} Own-account identifier, held only for this command. */
    this.nhsNumber = undefined;
    if (!vault.session.cookies) {
      for (const [name, value] of [['NHSO-Session-Id', vault.session.sessionId], ['NHSO-Session-Expiry', vault.session.sessionExpiry]]) {
        if (value) this.jar.setCookieSync(`${name}=${value}; Secure; Path=/`, origins.api);
      }
    }
  }
  get session() { return this.vault.session; }
  async persist() {
    this.session.cookies = await this.jar.serialize();
    const cookies = await this.jar.getCookies(origins.api);
    this.session.sessionId = cookies.find(cookie => cookie.key === 'NHSO-Session-Id')?.value;
    this.session.sessionExpiry = cookies.find(cookie => cookie.key === 'NHSO-Session-Expiry')?.value;
    this.session.updatedAt = new Date(this.now()).toISOString();
    await this.store.save(this.vault);
  }
  updateSession(data, required = false) {
    shape(data && typeof data === 'object' && !Array.isArray(data));
    if (required) shape(typeof data.token === 'string' && !!data.token && typeof data.patientSessionId === 'string' && !!data.patientSessionId);
    for (const [input, output] of [['token', 'csrfToken'], ['patientSessionId', 'patientId'], ['accessToken', 'accessToken']]) {
      if (data[input] !== undefined) { shape(typeof data[input] === 'string'); this.session[output] = data[input]; }
    }
    if (typeof data.hasGpSession === 'boolean') this.session.hasGpSession = data.hasGpSession;
    if (typeof data.nhsNumber === 'string') this.nhsNumber = data.nhsNumber.replace(/\s/g, '');
    if (typeof data.sessionTimeout === 'number' && data.sessionTimeout > 0) this.session.sessionTimeout = data.sessionTimeout;
    this.session.checkedAt = this.now();
  }
  /** @param {string} path @param {{method?: string, body?: any, bearer?: boolean, origin?: string, retry?: boolean, headers?: Record<string,string>}} options */
  async request(path, { method = 'GET', body = undefined, bearer = false, origin = origins.api, retry = method === 'GET', headers = {} } = {}) {
    const attempts = retry ? 3 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const response = await this.transport.raw(`${origin}${path}`, {
        method, headers: { ...apiHeaders(this.session, bearer), ...headers }, jar: this.jar,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      await this.persist();
      if ([429, 502, 503, 504, 598].includes(response.status) && attempt < attempts) {
        const retryAfter = response.headers.get('retry-after');
        const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : retryAfter ? Math.max(0, (Date.parse(retryAfter) - this.now()) / 1000) : attempt;
        // Long server cooldowns are surfaced instead of blocking an agent indefinitely.
        if (!Number.isFinite(seconds) || seconds > 5) return response;
        await response.body?.cancel();
        await this.transport.pause(seconds * 1000);
        continue;
      }
      return response;
    }
    throw new NhsError('upstream_unavailable', 'NHS is temporarily unavailable.');
  }
  async ensure({ gp = false, reauth = false } = {}) {
    const env = this.options.env || process.env;
    const injected = env.NHS_CLI_CREDENTIALS || env.NHS_PRESCRIPTIONS_CREDENTIALS;
    if (injected && this.vault.credentialAccount && accountDigest(parseCredentialsPayload(injected).email) !== this.vault.credentialAccount) throw new NhsError('account_changed', 'Injected credentials belong to a different saved login. Run nhs auth logout --forget before changing accounts.');
    if (reauth || !this.session.csrfToken || !this.session.sessionId) {
      await this.login();
    } else {
      this.options.onPhase?.('session');
      const nearExpiry = this.session.checkedAt && this.session.sessionTimeout && this.now() - this.session.checkedAt > Math.max(0, this.session.sessionTimeout - 60) * 1000;
      const response = await this.request('/v1/session');
      if (response.status === 401) { await response.body?.cancel(); await this.login(); }
      else {
        await assertHttp(response);
        this.updateSession(await jsonResponse(response), true);
        await this.persist();
        if (nearExpiry) {
          const extended = await this.request('/v1/session/extend', { method: 'POST' });
          await assertHttp(extended, 'session extension'); await extended.body?.cancel();
        }
      }
    }
    if (gp && !this.session.hasGpSession) await this.ensureGp();
  }
  async ensureBearer(force = false) {
    let expiry = 0;
    try { expiry = JSON.parse(Buffer.from(this.session.accessToken?.split('.')[1] || '', 'base64url').toString()).exp * 1000; } catch { /* absent or opaque tokens must be refreshed */ }
    if (!force && Number.isFinite(expiry) && expiry > this.now() + 60000) return;
    const response = await this.request('/v1/patient/authorization/access-token/refresh', { method: 'POST' });
    await assertHttp(response, 'access-token refresh');
    const data = await jsonResponse(response);
    shape(typeof data?.token === 'string' && !!data.token);
    this.session.accessToken = data.token; await this.persist();
  }
  /** Only read operations may be retried after reauthentication. */
  /** @param {string} path @param {{method?: string, body?: any, bearer?: boolean, gp?: boolean, origin?: string, headers?: Record<string,string>}} options */
  async read(path, { bearer = false, gp = false, method = 'GET', body = undefined, origin = origins.api, headers = {} } = {}) {
    try {
      if (bearer) await this.ensureBearer();
      const response = await this.request(path, { method, body, bearer, origin, headers, retry: method === 'GET' });
      await assertHttp(response); return response;
    } catch (error) {
      if (error.code !== 'session_expired') throw error;
      if (bearer) {
        // A service-token rejection is not proof the cookie session expired.
        const active = await this.request('/v1/session');
        if (active.status !== 401) {
          await assertHttp(active); this.updateSession(await jsonResponse(active), true); await this.persist();
          try {
            await this.ensureBearer(true);
            const retried = await this.request(path, { method, body, bearer, origin, headers, retry: method === 'GET' });
            await assertHttp(retried); return retried;
          } catch (refreshError) {
            if (refreshError.code === 'session_expired') throw new NhsError('access_denied', 'NHS rejected service authorization within a valid app session.');
            throw refreshError;
          }
        }
        await active.body?.cancel();
      }
      if (this.loginAttempts !== 0 || this.options.allowLogin === false) throw error;
      await this.login();
      if (gp) await this.ensureGp();
      if (bearer) await this.ensureBearer();
      const response = await this.request(path, { method, body, bearer, origin, headers, retry: method === 'GET' });
      await assertHttp(response); return response;
    }
  }
  async login() {
    if (this.options.allowLogin === false || this.loginAttempts >= 1) throw new NhsError('auth_required', 'NHS authentication is required. Run nhs auth login in a terminal.');
    this.loginAttempts++;
    this.options.onPhase?.('credentials');
    const { value } = await this.credentials(this.vault, { env: this.options.env, allowPrompt: this.options.allowPrompt });
    const account = accountDigest(value.email);
    if (this.vault.credentialAccount && this.vault.credentialAccount !== account) throw new NhsError('account_changed', 'Credentials belong to a different saved login. Run nhs auth logout --forget before changing accounts.');
    // Prove secure writes work before contacting login or requesting a code.
    await this.store.save(this.vault);
    this.options.onPhase?.('authorization');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const nonce = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
    const jar = new CookieJar();
    const started = await this.transport.redirects(buildAuthorizeUrl(challenge, nonce, state), jar);
    if (started.response) { await assertHttp(started.response, 'authorization'); await started.response.body?.cancel(); }
    const authCookie = (await jar.getCookies(origins.access)).find(cookie => cookie.key === 'nhs-authorization-cookie');
    let params;
    try { params = JSON.parse(decodeURIComponent(authCookie?.value || '')); } catch { throw new NhsError('auth_flow_changed', 'NHS authorization cookie is missing or invalid.'); }
    if (params.state !== state || params.nonce !== nonce || params.code_challenge !== challenge || params.redirect_uri !== callback || params.client_id !== 'nhs-online' || params.code_challenge_method !== 'S256' || typeof params.session_id !== 'string') throw new NhsError('oauth_validation_failed', 'NHS authorization parameters did not match this login request.');
    if (this.session.rememberMyDevice && this.session.rememberMyDevice !== 'INVALID') await jar.setCookie(`remember_my_device=${this.session.rememberMyDevice}; Domain=login.nhs.uk; Secure; Path=/`, origins.login);
    const headers = { 'Content-Type': 'application/json; charset=utf-8', Accept: 'application/json', Origin: origins.access, Referer: `${origins.access}/`, session_id: params.session_id };
    const remembered = this.session.rememberMyDevice || this.session.rmdToken;
    const signIn = await this.transport.raw(`${origins.login}/login/user-sign-in`, { method: 'POST', headers, jar, body: JSON.stringify({ ...value, rmd_token: remembered && remembered !== 'INVALID' ? remembered : null }) });
    await assertHttp(signIn, 'sign-in');
    const data = await jsonResponse(signIn);
    if (data.rmd_token === 'INVALID') {
      await jar.setCookie('remember_my_device=; Domain=login.nhs.uk; Secure; Path=/; Max-Age=0', origins.login);
      delete this.session.rmdToken; delete this.session.rememberMyDevice;
      await this.persist();
    }
    let code;
    if (data.authentication_state === 'AUTHENTICATED') {
      shape(typeof data.redirect_uri === 'string');
      const redirected = await this.transport.redirects(data.redirect_uri, jar, url => url.origin === origins.app && url.pathname === '/auth-return');
      await redirected.response?.body?.cancel();
      code = callbackCode(redirected.url, state);
      if (typeof data.rmd_token === 'string') this.session.rmdToken = data.rmd_token;
    } else {
      // Only a declared MFA challenge enters the OTP flow; changed responses fail closed.
      if (data.authentication_state === 'UNREGISTERED' || data.authentication_methods?.totp || data.authentication_methods?.mobile === false) throw new NhsError('auth_required', 'NHS requires an interactive authentication method that this CLI does not support. Use the official NHS login.');
      if (data.authentication_state !== 'VERIFIED') throw new NhsError('auth_flow_changed', 'NHS requires an unsupported authentication step. Use the official app and report the CLI error code.');
      code = await this.handleOtp(jar, headers, params, state);
    }
    const rmdCookie = (await jar.getCookies(origins.login)).find(cookie => cookie.key === 'remember_my_device');
    if (rmdCookie) this.session.rememberMyDevice = rmdCookie.value;
    await this.persist();
    this.options.onPhase?.('create');
    // A new session gets a fresh jar; stale cookies must not affect creation.
    this.jar = new CookieJar();
    const response = await this.transport.raw(`${origins.api}/v1/session`, { method: 'POST', headers: apiHeaders({}), jar: this.jar, body: JSON.stringify({ authCode: code, codeVerifier: verifier, redirectUrl: callback, referrer: '', integrationReferrer: '', nonce }) });
    await assertHttp(response, 'session creation');
    this.session.hasGpSession = false;
    delete this.session.accessToken;
    this.updateSession(await jsonResponse(response), true);
    this.vault.credentialAccount = account;
    await this.persist();
    shape(!!this.session.sessionId, 'NHS session creation did not provide a session cookie.');
    if (this.options.saveCredentials) { this.vault.credentials = value; await this.persist(); }
  }
  async handleOtp(jar, headers, params, expectedState) {
    if (!this.options.allowPrompt && !this.options.messages) throw new NhsError('auth_required', 'NHS requires a security code. Run nhs auth login in a terminal.');
    const last = Date.parse(this.session.lastOtpTriggerAt || '');
    if (!this.options.forceOtp && Number.isFinite(last) && this.now() - last < 600000) throw new NhsError('otp_recently_requested', 'An NHS code was requested within the last ten minutes. Wait before retrying.');
    const since = this.now();
    // Persist before the request: a lost response must not cause repeated SMS sends.
    this.session.lastOtpTriggerAt = new Date(since).toISOString(); await this.persist();
    const trigger = await this.transport.raw(`${origins.login}/login/trigger-otp`, { method: 'POST', headers, jar, body: JSON.stringify({ is_login: true, otp_type: 'mobile' }) });
    await assertHttp(trigger, 'security-code request'); await trigger.body?.cancel();
    this.options.onPhase?.('otp');
    const otpCode = await this.otp({ since, messages: this.options.messages, allowPrompt: this.options.allowPrompt });
    this.options.onPhase?.('verify');
    const verified = await this.transport.raw(`${origins.login}/login/otp`, { method: 'POST', headers, jar, body: JSON.stringify({ client_id: 'nhs-online', session_id: params.session_id, otp_code: otpCode, otp_type: 'mobile' }) });
    await assertHttp(verified, 'security-code verification');
    const { id_token: idToken } = await jsonResponse(verified);
    shape(typeof idToken === 'string' && !!idToken);
    await jar.setCookie(`id_token=${idToken}; Domain=login.nhs.uk; Secure; Path=/`, origins.login);
    const remember = await this.transport.raw(`${origins.login}/login/remember-my-device`, { method: 'POST', headers, jar, body: JSON.stringify({ remember_my_device: 'true' }) });
    if (remember.ok) {
      const content = await boundedBody(remember, 1024 * 1024);
      let data;
      try { data = content.length ? JSON.parse(content.toString('utf8')) : {}; } catch { throw new NhsError('invalid_response', 'NHS returned invalid remembered-device metadata.'); }
      shape(data && typeof data === 'object' && !Array.isArray(data));
      if (typeof data.rmd_token === 'string') this.session.rmdToken = data.rmd_token;
    } else {
      await remember.body?.cancel();
      delete this.session.rmdToken;
      delete this.session.rememberMyDevice;
      await jar.setCookie('remember_my_device=; Domain=login.nhs.uk; Secure; Path=/; Max-Age=0', origins.login);
    }
    this.session.rememberMyDevice = (await jar.getCookies(origins.login)).find(cookie => cookie.key === 'remember_my_device')?.value;
    await this.persist();
    const exchanged = await this.transport.raw(`${origins.authorize}/authcode`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: idToken, Origin: origins.access, Referer: `${origins.access}/` }, body: JSON.stringify(Object.fromEntries(['scope', 'response_type', 'client_id', 'redirect_uri', 'session_id', 'state', 'nonce', 'code_challenge', 'code_challenge_method', 'vtr'].map(key => [key, params[key]]))) });
    await assertHttp(exchanged, 'authorization-code exchange');
    const data = await jsonResponse(exchanged);
    if (data.consent_required || data.terms_update_required) throw new NhsError('auth_required', 'NHS requires consent or updated terms in its official login.');
    return callbackCode(data.Location, expectedState);
  }
  async ensureGp() {
    this.options.onPhase?.('gp');
    const identity = await this.request('/v1/patient/asserted-login-identity', { method: 'POST', body: { IntendedRelyingPartyUrl: 'www.nhsapp.service.nhs.uk' } });
    await assertHttp(identity, 'GP identity');
    const { token } = await jsonResponse(identity); shape(typeof token === 'string' && !!token);
    const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url');
    const url = new URL('/authorize', origins.authorize);
    Object.entries({ asserted_login_identity: token, scope: 'openid profile email profile_extended nhs_app_credentials gp_registration_details', redirect_uri: gpCallback, client_id: 'nhs-online', state, vtr: JSON.stringify(trust), nonce, response_type: 'code' }).forEach(([key, value]) => url.searchParams.set(key, value));
    const redirected = await this.transport.redirects(url, new CookieJar(), url => url.origin === origins.app && url.pathname === '/on-demand-gp-return');
    await redirected.response?.body?.cancel();
    const code = callbackCode(redirected.url, state, gpCallback);
    const response = await this.request('/v1/session/gp-session-on-demand', { method: 'PUT', body: { authCode: code, redirectUrl: gpCallback, integrationReferrer: null, referrerOrigin: null } });
    await assertHttp(response, 'GP session creation');
    this.updateSession(await jsonResponse(response), true);
    this.session.hasGpSession = true;
    await this.persist();
  }
  async logout(forget = false) {
    let revoked = false;
    try {
      if (this.session.sessionId) {
        const response = await this.request('/v1/session', { method: 'DELETE' });
        revoked = response.ok || response.status === 401;
        await response.body?.cancel();
      }
    } catch { /* Local logout must still work during an outage. */ }
    this.vault.session = {}; this.jar = new CookieJar();
    if (forget) { delete this.vault.credentials; delete this.vault.credentialAccount; }
    await this.store.save(this.vault);
    return { ok: true, loggedOut: true, serverSessionRevoked: revoked, credentialsForgotten: forget };
  }
}
