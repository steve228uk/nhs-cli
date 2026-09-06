import assert from 'node:assert/strict';
import test from 'node:test';
import { client, response, sessionData, loginHandler } from './helpers.mjs';
import { callbackCode } from '../src/auth.mjs';
import { callback, origins } from '../src/config.mjs';
import { CookieJar, Transport } from '../src/transport.mjs';
import { resolveOtp, readOtpFromMessages, extractOtpCode } from '../src/otp.mjs';
import { resolveCredentials } from '../src/credentials.mjs';

test('reuses session and persists all rotated values without accessing credentials', async () => {
  const { auth, store, calls } = client(() => response(sessionData({ accessToken: 'synthetic-access' }), 200, { 'set-cookie': 'NHSO-Session-Id=rotated; Secure; Path=/' }), { credentials: async () => { throw new Error('must not request credentials'); } });
  await auth.ensure();
  assert.equal(calls.length, 1);
  assert.equal(store.value.session.sessionId, 'rotated');
  assert.equal(store.value.session.csrfToken, 'synthetic-csrf-new');
  assert.equal(store.value.session.patientId, 'synthetic-patient-new');
  assert.equal(store.value.session.accessToken, 'synthetic-access');
});

test('outages and access denial never cause credential login', async () => {
  for (const status of [403, 429, 503]) {
    const { auth, calls } = client(() => response({}, status));
    await assert.rejects(auth.ensure());
    assert.ok(calls.every(call => call.url.pathname === '/v1/session'));
    assert.equal(auth.loginAttempts, 0);
  }
});

test('confirmed expiry signs in once; fresh sessions immediately uplift when GP is needed', async () => {
  const handler = loginHandler({ gp: true, extra: call => call.url.pathname === '/v1/session' && call.method === 'GET' ? response({}, 401) : undefined });
  const { auth, store, calls } = client(handler, { options: { env: { NHS_CLI_CREDENTIALS: '{"email":"person@example.com","password":"synthetic-password"}' } } });
  await auth.ensure({ gp: true });
  assert.equal(auth.loginAttempts, 1);
  assert.equal(store.value.session.hasGpSession, true);
  assert.equal(store.value.credentials, undefined);
  assert.equal(store.value.session.rmdToken, 'synthetic-body-rmd');
  assert.equal(store.value.session.rememberMyDevice, 'synthetic-cookie-rmd');
  assert.ok(calls.some(call => call.url.pathname === '/v1/session/gp-session-on-demand'));
  assert.equal(calls.filter(call => call.url.pathname === '/login/user-sign-in').length, 1);
});

test('OTP workflow preserves separate body and cookie tokens; explicit credential persistence', async () => {
  const { auth, store } = client(loginHandler({ otp: true }), { initial: { version: 1, session: {} }, options: { allowPrompt: true, saveCredentials: true }, credentials: async () => ({ value: { email: 'person@example.com', password: 'synthetic-password' }, source: 'injected' }), otp: async () => '123456' });
  await auth.ensure();
  assert.equal(store.value.session.rmdToken, 'synthetic-body-rmd');
  assert.equal(store.value.session.rememberMyDevice, 'synthetic-cookie-rmd');
  assert.equal(store.value.credentials.password, 'synthetic-password');
});

test('noninteractive MFA never triggers unsolicited SMS', async () => {
  const { auth, calls } = client(loginHandler({ otp: true }), { initial: { version: 1, session: {} }, options: { allowPrompt: false }, credentials: async () => ({ value: { email: 'person@example.com', password: 'synthetic' } }) });
  await assert.rejects(auth.ensure(), { code: 'auth_required' });
  assert.ok(!calls.some(call => call.url.pathname.includes('trigger-otp')));
});

test('no-login prevents authentication on expiry or absent session', async () => {
  for (const initial of [{ version: 1, session: {} }, undefined]) {
    const { auth, calls } = client(() => response({}, 401), { initial, options: { allowLogin: false } });
    await assert.rejects(auth.ensure(), { code: 'auth_required' });
    assert.ok(calls.every(call => call.url.pathname === '/v1/session'));
  }
});

test('extends only a still-valid session near the inactivity deadline', async () => {
  const { auth, calls } = client(call => response(sessionData()), { now: () => 1_000_000 });
  auth.session.checkedAt = 500_000; auth.session.sessionTimeout = 550;
  await auth.ensure();
  assert.deepEqual(calls.map(call => call.url.pathname), ['/v1/session', '/v1/session/extend']);
});

test('bearer refresh is separate and errors are surfaced', async () => {
  const { auth, calls } = client(() => response({ token: 'synthetic-bearer' }));
  await auth.ensureBearer();
  assert.equal(auth.session.accessToken, 'synthetic-bearer');
  assert.equal(calls[0].url.pathname, '/v1/patient/authorization/access-token/refresh');
  const broken = client(() => response({}, 403));
  await assert.rejects(broken.auth.ensureBearer(), { code: 'access_denied' });
});

test('rejects malformed session responses', async () => {
  const { auth } = client(() => response({ error: 'not a session' }));
  await assert.rejects(auth.ensure(), { code: 'invalid_response' });
});

test('logout clears locally during outages and forget removes credentials', async () => {
  const { auth, store } = client(() => { throw new Error('synthetic secret error'); });
  auth.vault.credentials = { email: 'person@example.com', password: 'synthetic' };
  const result = await auth.logout(true);
  assert.equal(result.serverSessionRevoked, false);
  assert.deepEqual(store.value.session, {});
  assert.equal(store.value.credentials, undefined);
});

test('callback validation rejects wrong origin, path, state and duplicate code', () => {
  assert.equal(callbackCode(`${callback}?state=expected&code=ok`, 'expected'), 'ok');
  for (const url of [`${callback}?state=wrong&code=ok`, `${callback}?state=expected&code=a&code=b`, 'https://evil.example/?state=expected&code=ok', `${origins.app}/auth-return-evil?state=expected&code=ok`]) assert.throws(() => callbackCode(url, 'expected'));
});

test('cookie jar scopes secrets to host and path; redirects cannot escape HTTPS origins', async () => {
  const jar = new CookieJar(); await jar.setCookie('login-secret=synthetic; Secure; Path=/login', origins.login);
  const cookies = [];
  const transport = new Transport({ fetchImpl: async (_url, init) => { cookies.push(init.headers.get('cookie')); return response({}); } });
  await transport.raw(`${origins.login}/login/otp`, { jar });
  await transport.raw(`${origins.login}/other`, { jar });
  await transport.raw(`${origins.api}/v1/session`, { jar });
  assert.deepEqual(cookies, ['login-secret=synthetic', null, null]);
  await assert.rejects(transport.raw('https://evil.example/'), { code: 'untrusted_redirect' });
  const redirect = new Transport({ fetchImpl: async () => response({}, 302, { location: 'https://evil.example/' }) });
  await assert.rejects(redirect.redirects(`${origins.authorize}/authorize`, jar), { code: 'untrusted_redirect' });
});

test('OTP matching excludes unrelated providers and codes before the challenge', async () => {
  assert.equal(extractOtpCode('Your bank security code is 123456'), null);
  const now = Date.now();
  const code = await readOtpFromMessages({ platform: 'darwin', since: now - 5000, execImpl: async () => ({ stdout: JSON.stringify([{ text: 'Your NHS code is 111111', received_unix: (now - 60000) / 1000 }, { text: 'Your NHS code is 222222', received_unix: now / 1000 }]) }) });
  assert.equal(code, '222222');
  await assert.rejects(resolveOtp({ since: now, allowPrompt: false }), { code: 'auth_required' });
});

test('stored and injected credential sources remain distinct', async () => {
  const vault = { credentials: { email: 'saved@example.com', password: 'saved' } };
  assert.equal((await resolveCredentials(vault, { env: {} })).source, 'stored');
  assert.equal((await resolveCredentials(vault, { env: { NHS_PRESCRIPTIONS_CREDENTIALS: '{"email":"injected@example.com","password":"injected"}' } })).source, 'injected');
  assert.equal(vault.credentials.password, 'saved');
});

test('current SMS contract explicitly opts into remembered-device renewal', async () => {
  const { auth, calls } = client(loginHandler({ otp: true }), { initial: { version: 1, session: { rememberMyDevice: 'synthetic-cookie-old', rmdToken: 'synthetic-body-old' } }, options: { allowPrompt: true }, credentials: async () => ({ value: { email: 'person@example.com', password: 'synthetic' } }), otp: async () => '123456' });
  await auth.ensure();
  assert.equal(calls.find(call => call.url.pathname === '/login/user-sign-in').body.rmd_token, 'synthetic-cookie-old');
  assert.equal(calls.find(call => call.url.pathname === '/login/otp').body.otp_type, 'mobile');
  const remember = calls.find(call => call.url.pathname === '/login/remember-my-device');
  assert.deepEqual(remember.body, { remember_my_device: 'true' });
  assert.match(remember.headers.get('cookie'), /id_token=synthetic-id-token/);
});

test('TOTP and unregistered accounts require interaction without sending SMS', async () => {
  for (const challenge of [{ authentication_state: 'VERIFIED', authentication_methods: { totp: true } }, { authentication_state: 'UNREGISTERED' }]) {
    const { auth, calls } = client(loginHandler({ extra: call => call.url.pathname === '/login/user-sign-in' ? response(challenge) : undefined }), { initial: { version: 1, session: {} }, options: { allowPrompt: true }, credentials: async () => ({ value: { email: 'person@example.com', password: 'synthetic' } }) });
    await assert.rejects(auth.ensure(), { code: 'auth_required' });
    assert.ok(!calls.some(call => call.url.pathname === '/login/trigger-otp'));
  }
});

test('failed secure-storage preflight prevents any login network request', async () => {
  const { auth, store, calls } = client(loginHandler(), { initial: { version: 1, session: {} }, credentials: async () => ({ value: { email: 'person@example.com', password: 'synthetic' } }) });
  store.save = async () => { throw new Error('synthetic write failure'); };
  await assert.rejects(auth.ensure());
  assert.equal(calls.length, 0);
});

test('invalid remembered-device state is removed even when MFA cannot continue', async () => {
  const { auth, store } = client(loginHandler({ extra: call => call.url.pathname === '/login/user-sign-in' ? response({ authentication_state: 'VERIFIED', rmd_token: 'INVALID' }) : undefined }), { initial: { version: 1, session: { rememberMyDevice: 'synthetic-old-cookie', rmdToken: 'synthetic-old-token' } }, credentials: async () => ({ value: { email: 'person@example.com', password: 'synthetic' } }) });
  await assert.rejects(auth.ensure(), { code: 'auth_required' });
  assert.equal(store.value.session.rememberMyDevice, undefined);
  assert.equal(store.value.session.rmdToken, undefined);
});

test('read expiry after login never loops or resubmits credentials', async () => {
  const { auth, calls } = client(loginHandler({ extra: call => call.url.pathname === '/v1/patient/demographics' ? response({}, 401) : undefined }), { options: { env: { NHS_CLI_CREDENTIALS: '{"email":"person@example.com","password":"synthetic"}' } } });
  await assert.rejects(auth.read('/v1/patient/demographics'), { code: 'session_expired' });
  assert.equal(calls.filter(call => call.url.pathname === '/login/user-sign-in').length, 1);
  assert.equal(calls.filter(call => call.url.pathname === '/v1/patient/demographics').length, 2);
});

test('redirect loops and long read throttles remain bounded', async () => {
  let requests = 0;
  const transport = new Transport({ fetchImpl: async () => { requests++; return response({}, 302, { location: `${origins.authorize}/authorize` }); } });
  await assert.rejects(transport.redirects(`${origins.authorize}/authorize`, new CookieJar()), { code: 'redirect_limit' });
  assert.equal(requests, 10);
  const { auth, calls } = client(() => response({}, 429, { 'retry-after': '600' }));
  await assert.rejects(auth.ensure(), { code: 'rate_limited' });
  assert.equal(calls.length, 1);
});

test('read retries respect numeric, date, missing, and invalid cooldowns without retrying writes', async () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  for (const [retryAfter, expected] of [[undefined, [1000]], ['2', [2000]], ['Thu, 01 Jan 2026 00:00:03 GMT', [3000]], ['Wed, 31 Dec 2025 23:59:59 GMT', [0]], ['not-a-date', []], ['6', []]]) {
    const headers = retryAfter === undefined ? {} : { 'retry-after': retryAfter };
    const { auth, calls } = client((_call, count) => response({}, count === 1 ? 429 : 200, headers), { now: () => now });
    const delays = []; auth.transport.pause = async ms => { delays.push(ms); };
    const result = await auth.request('/v1/patient/demographics');
    assert.deepEqual(delays, expected);
    assert.equal(calls.length, expected.length + 1);
    assert.equal(result.status, expected.length ? 200 : 429);
  }
  const { auth, calls } = client(() => response({}, 503, { 'retry-after': '1' }));
  auth.transport.pause = async () => { throw new Error('writes must not retry'); };
  assert.equal((await auth.request('/v1/patient/prescriptions', { method: 'POST', body: { CourseIds: ['synthetic-id'], SpecialRequest: '' } })).status, 503);
  assert.equal(calls.length, 1);
});

test('rejected service bearer is renewed within the valid cookie session without password login', async () => {
  let reads = 0;
  const { auth, calls } = client(call => {
    if (call.url.pathname === '/v1/session') return response(sessionData());
    if (call.url.pathname.endsWith('/access-token/refresh')) return response({ token: 'synthetic-renewed-bearer' });
    return response({ messages: [], canLoadMore: false }, ++reads === 1 ? 401 : 200);
  }, { options: { allowLogin: false } });
  auth.session.accessToken = `synthetic.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString('base64url')}.signature`;
  await auth.read('/v2/api/users/me/messages', { bearer: true });
  assert.equal(auth.loginAttempts, 0);
  assert.equal(calls.filter(call => call.url.pathname.endsWith('/access-token/refresh')).length, 1);
  assert.equal(calls.at(-1).headers.get('authorization'), 'Bearer synthetic-renewed-bearer');
});

test('consent requirements preserve renewed device material and do not create an app session', async () => {
  const { auth, store, calls } = client(loginHandler({ otp: true, extra: call => call.url.pathname === '/authcode' ? response({ consent_required: true }) : undefined }), { initial: { version: 1, session: {} }, options: { allowPrompt: true }, credentials: async () => ({ value: { email: 'person@example.com', password: 'synthetic' } }), otp: async () => '123456' });
  await assert.rejects(auth.ensure(), { code: 'auth_required' });
  assert.equal(store.value.session.rememberMyDevice, 'synthetic-cookie-rmd');
  assert.equal(store.value.session.rmdToken, 'synthetic-body-rmd');
  assert.ok(!calls.some(call => call.url.pathname === '/v1/session' && call.method === 'POST'));
});

test('remember-device acknowledgement may omit a body without failing login', async () => {
  const { auth } = client(loginHandler({ otp: true, extra: call => call.url.pathname === '/login/remember-my-device' ? response({}, 204, { 'set-cookie': 'remember_my_device=synthetic-cookie-only; Domain=login.nhs.uk; Secure; Path=/' }) : undefined }), { initial: { version: 1, session: {} }, options: { allowPrompt: true }, credentials: async () => ({ value: { email: 'person@example.com', password: 'synthetic' } }), otp: async () => '123456' });
  await auth.ensure();
  assert.equal(auth.session.rememberMyDevice, 'synthetic-cookie-only');
});
