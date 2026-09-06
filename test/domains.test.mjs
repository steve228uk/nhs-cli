import assert from 'node:assert/strict';
import test from 'node:test';
import { NhsServices, buildStatusPayload, capabilitiesFrom } from '../src/domains.mjs';
import { client, journeys, response } from './helpers.mjs';

const courses = { courses: [{ id: 'one', name: 'Medicine A', requestable: true }, { id: 'two', name: 'Medicine B', requestable: false }], specialRequestNecessity: 'None' };
function fixture(handler) {
  const setup = client(call => call.url.pathname === '/v1/patient/journey-configuration' ? response(journeys) : call.url.pathname === '/v1/patient/courses' ? response(courses) : handler(call));
  return { ...setup, services: new NhsServices(setup.auth) };
}

test('prescription preview includes exact scope and note with no submission', async () => {
  const { services, calls } = fixture(() => { throw new Error('unexpected'); });
  const result = await services.order({ ids: 'one', note: 'Please use my usual pharmacy.', dryRun: true });
  assert.deepEqual(result.order.courseIds, ['one']);
  assert.deepEqual(result.order.selectedNames, ['Medicine A']);
  assert.equal(result.order.note, 'Please use my usual pharmacy.');
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('confirmation and current availability are required; duplicate and conflicting scopes fail', async () => {
  const { services, calls } = fixture(() => response({}, 201));
  await assert.rejects(services.order({ ids: 'one' }), { code: 'order_requires_confirmation' });
  assert.equal(calls.length, 0);
  for (const ids of ['missing', 'two', 'one,one', ',']) await assert.rejects(services.order({ ids, dryRun: true }), { code: 'order_invalid_scope' });
  await assert.rejects(services.order({ ids: 'one', all: true, dryRun: true }), { code: 'order_requires_scope' });
  assert.ok(calls.every(call => call.method === 'GET'));
});

test('successful submission reports only a confirmed HTTP 201 acknowledgement', async () => {
  const { services, calls } = fixture(() => response({}, 201));
  const result = await services.order({ ids: 'one', confirm: true });
  assert.equal(result.order.submitted, true);
  const writes = calls.filter(call => call.method === 'POST');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].body, { CourseIds: ['one'], SpecialRequest: '' });
});

test('uncertain submissions never retry', async () => {
  for (const status of [200, 202, 408, 503]) {
    const { services, calls } = fixture(() => response({}, status));
    await assert.rejects(services.order({ ids: 'one', confirm: true }), { code: 'order_unknown' });
    assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  }
  const { services, calls } = fixture(() => { throw new Error('network lost'); });
  await assert.rejects(services.order({ ids: 'one', confirm: true }), { code: 'order_unknown' });
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('malformed prescription responses do not become empty successful results', () => {
  for (const data of [{}, { courses: null }, { courses: [{ id: 'one', name: 'Medicine A', requestable: 'false' }] }]) assert.throws(() => buildStatusPayload(data), { code: 'invalid_response' });
  assert.equal(buildStatusPayload({ courses: [] }).summary.total, 0);
});

test('capabilities distinguish disabled from unsupported providers', () => {
  const data = structuredClone(journeys); data.journeys.prescriptions.provider = 'gpc'; data.journeys.messaging = false;
  const capabilities = capabilitiesFrom(data);
  assert.equal(capabilities.prescriptions.status, 'unsupported');
  assert.equal(capabilities.nhsMessages.status, 'unavailable');
});

test('provider and record capabilities preserve available, disabled, and unknown states', () => {
  for (const [provider, expected] of [['im1', 'available'], ['none', 'unavailable'], ['gpc', 'unsupported'], [undefined, 'unsupported']]) {
    const data = structuredClone(journeys);
    data.journeys.prescriptions.provider = provider;
    data.journeys.appointments.provider = provider;
    const capabilities = capabilitiesFrom(data);
    assert.equal(capabilities.prescriptions.status, expected);
    assert.equal(capabilities.appointments.status, expected);
  }
  for (const [version, expected] of [[1, 'available'], ['2', 'available'], [null, 'unavailable'], [undefined, 'unsupported'], ['3', 'unsupported']]) {
    const data = structuredClone(journeys);
    data.journeys.medicalRecord.version = version;
    assert.equal(capabilitiesFrom(data).records.status, expected);
  }
});

test('disabled capabilities are enforced before resource access', async () => {
  const data = structuredClone(journeys); data.journeys.messaging = false;
  const { auth, calls } = client(() => response(data));
  await assert.rejects(new NhsServices(auth).messages(), { code: 'capability_unavailable' });
  assert.equal(calls.length, 1);
});

test('NHS and GP inbox reads preserve read state and bounded pagination', async () => {
  const { services, auth, calls } = fixture(call => response(call.url.pathname.includes('/patient/messages/') ? { messageDetails: { body: 'Synthetic message' } } : { messages: [], canLoadMore: false }));
  auth.session.accessToken = `synthetic.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString('base64url')}.signature`;
  await services.messages({ source: 'nhs', index: 20, count: 10 });
  await services.messages({ source: 'gp', id: 'synthetic-id' });
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.equal(calls[1].url.searchParams.get('index'), '20');
  assert.equal(calls[1].url.searchParams.get('count'), '10');
  assert.ok(calls[1].headers.get('authorization').startsWith('Bearer '));
  await assert.rejects(services.messages({ count: 101 }), { code: 'usage' });
});

test('records, results, appointments, history and profile use observed response contracts', async () => {
  const { services } = fixture(call => {
    if (call.url.pathname.endsWith('/my-record')) return response({ response: { hasSummaryRecordAccess: true, testResults: { results: [] } } });
    if (call.url.pathname.endsWith('/test-result')) return response({ response: { title: 'Synthetic result' } });
    if (call.url.pathname.endsWith('/appointments')) return response({ upcomingAppointments: [], pastAppointments: [] });
    if (call.url.pathname.endsWith('/prescriptions')) return response({ prescriptions: [], courses: [] });
    if (call.url.pathname.endsWith('/demographics')) return response({ name: 'Synthetic person' });
    return response({ response: [] });
  });
  assert.equal((await services.record()).hasSummaryRecordAccess, true);
  assert.deepEqual(await services.results(), { results: [] });
  assert.equal((await services.results({ id: 'one' })).title, 'Synthetic result');
  assert.deepEqual(await services.results({ year: '2025' }), []);
  assert.deepEqual((await services.appointments()).upcomingAppointments, []);
  assert.deepEqual((await services.history()).prescriptions, []);
  assert.equal((await services.profile()).name, 'Synthetic person');
});

test('document downloads require an ID in the current account list', async () => {
  const { services, auth, calls } = fixture(call => response(call.url.pathname.includes('/Download/') ? { content: Buffer.from('Synthetic document').toString('base64'), contentType: 'text/plain' } : { patientDocuments: [{ id: 'doc-one', description: 'Synthetic letter' }] }));
  auth.nhsNumber = '9999999999';
  await assert.rejects(services.documents('unknown', true), { code: 'not_found' });
  const data = await services.documents('doc-one', true);
  assert.equal(data.content.toString(), 'Synthetic document');
  assert.equal(calls.find(call => call.url.pathname.endsWith('/Download/doc-one')).headers.get('prefer'), 'statuscode=200');
  assert.ok(calls.every(call => call.method === 'GET'));
  assert.ok(!calls.some(call => call.url.pathname.endsWith('/Download/unknown')));
});

test('classic results support null version but never guess version-3 contracts', () => {
  const data = structuredClone(journeys); data.journeys.im1TestResults.version = null;
  assert.equal(capabilitiesFrom(data).results.status, 'available');
  data.journeys.im1TestResults.version = '3';
  assert.equal(capabilitiesFrom(data).results.status, 'unsupported');
});

test('GP inboxes and slots reject missing response containers', async () => {
  const { services } = fixture(() => response({}));
  await assert.rejects(services.messages({ source: 'gp' }), { code: 'invalid_response' });
  await assert.rejects(services.appointments(true), { code: 'invalid_response' });
});

test('a medicine becoming unavailable after preview is never submitted', async () => {
  let requestable = true;
  const { auth, calls } = client(call => call.url.pathname.endsWith('/journey-configuration') ? response(journeys) : response({ courses: [{ id: 'one', name: 'Medicine A', requestable }] }));
  const services = new NhsServices(auth);
  await services.order({ ids: 'one', dryRun: true });
  requestable = false;
  await assert.rejects(services.order({ ids: 'one', confirm: true }), { code: 'order_invalid_scope' });
  assert.ok(calls.every(call => call.method === 'GET'));
});
