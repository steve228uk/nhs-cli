import { NhsError, shape } from './errors.mjs';
import { jsonResponse, assertHttp } from './transport.mjs';
import { origins } from './config.mjs';

export function parsePositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  return /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}
export function positive(value, fallback, max = 100) {
  if (value === undefined) return fallback;
  const n = parsePositiveInteger(value, 0);
  if (!n || n > max) throw new NhsError('usage', 'Numeric option is outside its supported range.');
  return n;
}
export function identifier(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x20]/.test(value) || value === '.' || value === '..') throw new NhsError('usage', 'A valid resource identifier is required.');
  return encodeURIComponent(value);
}

export function buildStatusPayload(data) {
  shape(data && Array.isArray(data.courses));
  const courses = data.courses.map(course => {
    shape(course && ['string', 'number'].includes(typeof course.id) && typeof course.name === 'string' && typeof course.requestable === 'boolean' && (course.details === undefined || typeof course.details === 'string'));
    return { id: course.id, name: course.name, details: course.details ?? '', requestable: course.requestable };
  });
  const available = courses.filter(course => course.requestable);
  return { ok: true, checkedAt: new Date().toISOString(), summary: { total: courses.length, requestable: available.length, requestableNames: available.map(course => course.name), specialRequestNecessity: data.specialRequestNecessity ?? 'None' }, courses };
}

function capability(enabled, supported = true) {
  return { status: enabled === false ? 'unavailable' : enabled === true && supported ? 'available' : 'unsupported', evidence: 'client-observed' };
}
export function capabilitiesFrom(data) {
  shape(data?.journeys && typeof data.journeys === 'object' && !Array.isArray(data.journeys));
  const rules = data.journeys;
  const provider = name => rules[name]?.provider;
  const record = ['1', '2'].includes(String(rules.medicalRecord?.version));
  return {
    prescriptions: capability(provider('prescriptions') === 'none' ? false : provider('prescriptions') === 'im1' ? true : undefined),
    records: capability(rules.medicalRecord?.version === null ? false : record ? true : undefined),
    results: capability(record && [null, '1', '2'].includes(rules.im1TestResults?.version) ? true : undefined),
    appointments: capability(provider('appointments') === 'none' ? false : provider('appointments') === 'im1' ? true : undefined),
    nhsMessages: capability(rules.messaging), gpMessages: capability(rules.im1Messaging?.isEnabled),
    pharmacy: capability(rules.nominatedPharmacy), documents: capability(rules.documents), profile: capability(true),
  };
}

export class NhsServices {
  /** @param {import('./auth.mjs').AuthClient} auth */
  constructor(auth) { this.auth = auth; this.capabilities = null; }
  async discover() {
    if (!this.capabilities) {
      const data = await jsonResponse(await this.auth.read('/v1/patient/journey-configuration'));
      this.capabilities = capabilitiesFrom(data);
    }
    return this.capabilities;
  }
  async require(name, gp = false) {
    const capabilities = await this.discover();
    const cap = capabilities[name];
    if (!cap || cap.status !== 'available') throw new NhsError(cap?.status === 'unavailable' ? 'capability_unavailable' : 'unsupported', 'This capability is not available through a supported provider for this account.', { capability: name });
    if (gp && !this.auth.session.hasGpSession) await this.auth.ensureGp();
  }
  async courses() {
    await this.require('prescriptions', true);
    let response;
    try { response = await this.auth.read('/v1/patient/courses', { gp: true }); }
    catch (error) {
      if (error.details?.status !== 598) throw error;
      await this.auth.ensureGp();
      response = await this.auth.read('/v1/patient/courses', { gp: true });
    }
    return buildStatusPayload(await jsonResponse(response));
  }
  async order({ ids = undefined, all = false, note = '', confirm = false, dryRun = false } = {}) {
    if ((!ids && !all) || (ids && all)) throw new NhsError('order_requires_scope', 'Choose either explicit --ids or --all-requestable.');
    if (typeof note !== 'string' || note.length > 1000) throw new NhsError('usage', 'The prescription note must contain at most 1000 characters.');
    if (!dryRun && !confirm) throw new NhsError('order_requires_confirmation', 'Review a fresh dry-run preview and confirm the exact medicines before using --confirm.');
    const status = await this.courses();
    const wanted = ids ? String(ids).split(',').map(id => id.trim()).filter(Boolean) : [];
    if (ids && (!wanted.length || new Set(wanted).size !== wanted.length)) throw new NhsError('order_invalid_scope', 'Prescription IDs must be non-empty and unique.');
    const selected = wanted.length ? wanted.map(id => status.courses.find(course => String(course.id) === id)) : status.courses.filter(course => course.requestable);
    if (selected.some(course => !course?.requestable)) throw new NhsError('order_invalid_scope', 'Some supplied medication IDs are unknown or not currently requestable.');
    if (!selected.length) return { ...status, order: { submitted: false, reason: 'no_requestable_courses' } };
    if (dryRun) return { ...status, order: { submitted: false, dryRun: true, courseIds: selected.map(course => course.id), selectedNames: selected.map(course => course.name), note } };
    let response;
    try { response = await this.auth.request('/v1/patient/prescriptions', { method: 'POST', body: { CourseIds: selected.map(course => course.id), SpecialRequest: note } }); }
    catch { throw new NhsError('order_unknown', 'The prescription request outcome is unknown. Check the official NHS App before submitting again.'); }
    if (response.status >= 500 || response.status === 202 || response.status === 408) {
      await response.body?.cancel();
      throw new NhsError('order_unknown', 'The prescription request outcome is unknown. Check the official NHS App before submitting again.');
    }
    await assertHttp(response, 'prescription request');
    if (response.status !== 201) {
      await response.body?.cancel();
      throw new NhsError('order_unknown', 'NHS returned an unrecognised submission acknowledgement. Check the official NHS App before submitting again.');
    }
    await response.body?.cancel();
    return { ...status, order: { submitted: true, result: { submitted: true }, orderedNames: selected.map(course => course.name) } };
  }
  async history(from) {
    await this.require('prescriptions', true);
    const date = from ? new Date(from) : new Date(new Date().setMonth(new Date().getMonth() - 6));
    if (!Number.isFinite(date.getTime())) throw new NhsError('usage', '--from must be an ISO date.');
    const data = await jsonResponse(await this.auth.read(`/v1/patient/prescriptions?${new URLSearchParams({ fromDate: date.toISOString() })}`, { gp: true }));
    shape(Array.isArray(data?.prescriptions) && Array.isArray(data?.courses)); return data;
  }
  async record() {
    await this.require('records', true);
    const data = await jsonResponse(await this.auth.read('/v1/patient/my-record', { gp: true }));
    shape(data?.response && typeof data.response === 'object');
    if (data.response.hasSummaryRecordAccess === false && data.response.hasDetailedRecordAccess !== true) throw new NhsError('capability_unavailable', 'The GP has not enabled access to this medical record.');
    return data.response;
  }
  async results({ id = undefined, year = undefined } = {}) {
    await this.require('results', true);
    if (id && year) throw new NhsError('usage', 'Choose a result ID or a historical year.');
    if (!id && !year) {
      const record = await this.record(); shape(record.testResults !== undefined); return record.testResults;
    }
    if (year && (!/^\d{4}$/.test(String(year)) || Number(year) < 1900 || Number(year) > new Date().getFullYear())) throw new NhsError('usage', '--year must be a year between 1900 and the current year.');
    const path = id ? `/v1/patient/test-result?${new URLSearchParams({ testResultId: String(id) })}` : `/v1/patient/historic-test-results/${year}`;
    const data = await jsonResponse(await this.auth.read(path, { gp: true }));
    shape(data?.response !== undefined); return data.response;
  }
  async appointments(slots = false) {
    await this.require('appointments', true);
    const data = await jsonResponse(await this.auth.read(slots ? '/v1/patient/appointment-slots' : '/v1/patient/appointments', { gp: true }));
    shape(data && typeof data === 'object');
    if (!slots) shape(Array.isArray(data.upcomingAppointments) || Array.isArray(data.pastAppointments));
    else shape(Array.isArray(data.slots));
    return data;
  }
  async messages({ source = 'nhs', id = undefined, index = 0, count = 20 } = {}) {
    if (!['nhs', 'gp'].includes(source)) throw new NhsError('usage', '--source must be nhs or gp.');
    await this.require(source === 'nhs' ? 'nhsMessages' : 'gpMessages', source === 'gp');
    if (!Number.isSafeInteger(index) || index < 0 || index > 100000 || !Number.isInteger(count) || count < 1 || count > 100) throw new NhsError('usage', 'Message index must be 0–100000 and count 1–100.');
    const path = source === 'nhs' ? id ? `/v1/api/users/me/messages/${identifier(id)}` : `/v2/api/users/me/messages?${new URLSearchParams({ index: String(index), count: String(count) })}` : id ? `/v1/patient/messages/${identifier(id)}` : '/v1/patient/messages';
    const data = await jsonResponse(await this.auth.read(path, { bearer: source === 'nhs', gp: source === 'gp' }));
    shape(data && typeof data === 'object');
    if (!id && source === 'nhs') shape(Array.isArray(data.messages) && typeof data.canLoadMore === 'boolean');
    if (!id && source === 'gp') shape(Array.isArray(data.messageSummaries));
    if (id && source === 'gp') shape(data.messageDetails && typeof data.messageDetails === 'object');
    return data;
  }
  async profile() {
    const data = await jsonResponse(await this.auth.read('/v1/patient/demographics'));
    shape(data && typeof data === 'object' && !Array.isArray(data)); return data;
  }
  async pharmacy() {
    await this.require('pharmacy');
    const data = await jsonResponse(await this.auth.read('/v1/patient/nominated-pharmacy'));
    shape(data === null || typeof data === 'object'); return data;
  }
  async documents(id = undefined, download = false) {
    await this.require('documents', true);
    if (!this.auth.nhsNumber || !/^\d{10}$/.test(this.auth.nhsNumber)) throw new NhsError('unsupported', 'NHS did not provide the own-account identifier required for document access.');
    const list = await jsonResponse(await this.auth.read(`/v1/AccessDocuments/Patient/${this.auth.nhsNumber}/DocumentReference`, { origin: origins.gpconnect, gp: true }));
    shape(Array.isArray(list?.patientDocuments));
    if (!id) return { documents: list.patientDocuments };
    const metadata = list.patientDocuments.find(doc => String(doc.id) === String(id));
    if (!metadata) throw new NhsError('not_found', 'That document is not in this account’s available document list.');
    if (!download) return metadata;
    const data = await jsonResponse(await this.auth.read(`/v1/AccessDocuments/Download/${identifier(id)}`, { origin: origins.gpconnect, gp: true, headers: { Prefer: 'statuscode=200' } }));
    shape(typeof data?.content === 'string' && typeof data?.contentType === 'string');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.content) || !data.content) throw new NhsError('invalid_response', 'Document content is missing or invalid base64.');
    return { content: Buffer.from(data.content, 'base64'), contentType: data.contentType, metadata };
  }
}
