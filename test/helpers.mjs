import { AuthClient } from '../src/auth.mjs';
import { Transport } from '../src/transport.mjs';
import { origins, callback, gpCallback } from '../src/config.mjs';

export const session = () => ({ csrfToken: 'synthetic-csrf', patientId: 'synthetic-patient', sessionId: 'synthetic-session', sessionExpiry: 'synthetic-expiry', hasGpSession: true });
export const sessionData = (extra = {}) => ({ token: 'synthetic-csrf-new', patientSessionId: 'synthetic-patient-new', hasGpSession: true, sessionTimeout: 600, nhsNumber: '9999999999', ...extra });
export const response = (body = {}, status = 200, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
export function memoryStore(value = { version: 1, session: session() }) {
  return { backend: 'test', value: structuredClone(value), writes: 0, async probe() {}, async load() { return structuredClone(this.value); }, async save(value) { this.value = structuredClone(value); this.writes++; } };
}
export function client(handler, { initial = { version: 1, session: session() }, options = {}, now = Date.now, credentials, otp } = {}) {
  const calls = [], store = memoryStore(initial);
  const transport = new Transport({ pause: async () => {}, fetchImpl: async (url, init) => { const call = { url: new URL(url), ...init, body: init.body ? JSON.parse(init.body) : undefined }; calls.push(call); return handler(call, calls.length); } });
  const auth = new AuthClient({ store, vault: structuredClone(initial), transport, options, now, credentials, otp });
  return { auth, store, calls };
}
export function loginHandler({ otp = false, gp = false, extra = (_call) => undefined } = {}) {
  let params;
  return async call => {
    const custom = await extra(call); if (custom) return custom;
    const path = call.url.pathname;
    if (path === '/authorize' && call.url.searchParams.has('asserted_login_identity')) return response({}, 302, { location: `${gpCallback}?code=synthetic-gp-code&state=${call.url.searchParams.get('state')}` });
    if (path === '/authorize') {
      params = { ...Object.fromEntries(call.url.searchParams), session_id: 'synthetic-login-id' };
      return response({}, 302, { location: `${origins.access}/enter-email`, 'set-cookie': `nhs-authorization-cookie=${encodeURIComponent(JSON.stringify(params))}; Domain=login.nhs.uk; Path=/; Secure` });
    }
    if (path === '/enter-email') return response({});
    if (path === '/login/user-sign-in') return response({ authentication_state: otp ? 'VERIFIED' : 'AUTHENTICATED', redirect_uri: `${origins.authorize}/complete`, rmd_token: 'synthetic-body-rmd' });
    if (path === '/complete') return response({}, 302, { location: `${callback}?code=synthetic-code&state=${params.state}`, 'set-cookie': 'remember_my_device=synthetic-cookie-rmd; Domain=login.nhs.uk; Path=/; Secure' });
    if (path === '/login/trigger-otp') return response({});
    if (path === '/login/otp') return response({ id_token: 'synthetic-id-token' });
    if (path === '/login/remember-my-device') return response({ rmd_token: 'synthetic-body-rmd' }, 200, { 'set-cookie': 'remember_my_device=synthetic-cookie-rmd; Domain=login.nhs.uk; Path=/; Secure' });
    if (path === '/authcode') return response({ Location: `${callback}?code=synthetic-code&state=${params.state}` });
    if (path === '/v1/session' && call.method === 'POST') return response(sessionData({ hasGpSession: !gp }), 200, { 'set-cookie': 'NHSO-Session-Id=synthetic-new-session; Path=/; Secure' });
    if (path === '/v1/patient/asserted-login-identity') return response({ token: 'synthetic-assertion' });
    if (path === '/v1/session/gp-session-on-demand') return response(sessionData());
    if (path === '/v1/session') return response(sessionData());
    throw new Error('Unexpected mock request');
  };
}

export const journeys = { journeys: { prescriptions: { provider: 'im1' }, appointments: { provider: 'im1' }, medicalRecord: { version: '1' }, im1TestResults: { version: '1' }, im1Messaging: { isEnabled: true }, messaging: true, documents: true, nominatedPharmacy: true } };
