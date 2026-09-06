import { CookieJar } from 'tough-cookie';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { compatibility, origins } from './config.mjs';
import { NhsError } from './errors.mjs';

const allowedOrigins = new Set(Object.values(origins).map(value => new URL(value).origin));
/** @param {string|URL} value @param {string} base */
export function trustedUrl(value, base = origins.app) {
  let url;
  try { url = new URL(value, base); } catch { throw new NhsError('invalid_redirect', 'NHS returned an invalid redirect URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !allowedOrigins.has(url.origin)) throw new NhsError('untrusted_redirect', 'NHS returned a redirect outside the supported HTTPS origins.');
  return url;
}

export class Transport {
  constructor({ fetchImpl = fetch, timeoutMs = 30000, pause = sleep } = {}) {
    this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.pause = pause;
  }
  /** @param {string|URL} value @param {RequestInit & {jar?: CookieJar}} options */
  async raw(value, options = {}) {
    const url = trustedUrl(value);
    const { jar, ...init } = options;
    const headers = new Headers(init.headers);
    headers.set('User-Agent', compatibility.userAgent);
    if (jar) {
      const cookie = await jar.getCookieString(url.toString());
      if (cookie) headers.set('Cookie', cookie);
    }
    let response;
    try {
      response = await this.fetchImpl(url.toString(), { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {
      throw new NhsError('network_error', 'NHS could not be reached within the request deadline.');
    }
    if (jar) {
      for (const cookie of response.headers.getSetCookie()) {
        try { await jar.setCookie(cookie, url.toString()); } catch { throw new NhsError('invalid_response', 'NHS returned an invalid cookie.'); }
      }
    }
    return response;
  }
  async redirects(url, jar, stop = (_url) => false) {
    let current = trustedUrl(url);
    for (let count = 0; count < 10; count++) {
      if (stop(current)) return { url: current, response: null };
      const response = await this.raw(current, { jar });
      if (response.status < 300 || response.status >= 400) return { url: current, response };
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new NhsError('invalid_redirect', 'NHS returned a redirect without a destination.');
      current = trustedUrl(location, current.toString());
    }
    throw new NhsError('redirect_limit', 'NHS authentication exceeded the redirect limit.');
  }
}

export async function jsonResponse(response) {
  try {
    const text = await boundedBody(response, 8 * 1024 * 1024);
    return JSON.parse(text.toString('utf8'));
  } catch (error) {
    if (error instanceof NhsError) throw error;
    throw new NhsError('invalid_response', 'NHS returned invalid JSON.');
  }
}

export async function boundedBody(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new NhsError('response_too_large', 'NHS response exceeds the supported size.');
  }
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new NhsError('response_too_large', 'NHS response exceeds the supported size.'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof NhsError) throw error;
    throw new NhsError('network_error', 'NHS response could not be read within the request deadline.');
  } finally { reader.releaseLock(); }
}

export async function assertHttp(response, operation = 'request') {
  if (response.ok) return;
  await response.body?.cancel();
  if (response.status === 401) throw new NhsError('session_expired', 'NHS session has expired.');
  if (response.status === 403) throw new NhsError('access_denied', 'NHS denied access to this operation.');
  if (response.status === 404 || response.status === 501) throw new NhsError('unsupported', 'This NHS operation is unavailable for this account or client version.');
  if (response.status === 429) throw new NhsError('rate_limited', 'NHS is limiting requests. Wait before trying again.');
  if (response.status >= 500) throw new NhsError('upstream_unavailable', 'NHS or the GP provider is temporarily unavailable.', { status: response.status });
  throw new NhsError('request_failed', `NHS ${operation} failed.`, { status: response.status });
}

/** @param {import('./types.mjs').Session} session */
export function apiHeaders(session, bearer = false) {
  /** @type {Record<string, string>} */
  const headers = {
    Accept: 'application/json', 'Content-Type': 'application/json',
    'NHSO-Request-ID': randomUUID(), 'NHSO-Web-Version-Tag': compatibility.webVersion,
    'NHSO-Native-Version-Tag': compatibility.nativeVersion,
    Origin: origins.app, Referer: `${origins.app}/`,
  };
  if (session.csrfToken) headers['X-CSRF-TOKEN'] = session.csrfToken;
  if (session.patientId) headers['NHSO-Patient-Id'] = session.patientId;
  if (bearer && session.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  return headers;
}

export { CookieJar };
