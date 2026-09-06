import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStatusPayload,
  extractOtpCode,
  isLikelyNhsOtpText,
  parseCredentialsPayload,
  parsePositiveInteger,
  redact,
} from '../bin/nhs-prescriptions.mjs';

test('parses injected credentials without changing the password', () => {
  assert.deepEqual(
    parseCredentialsPayload('{"email":" person@example.com ","password":" spaced secret "}'),
    { email: 'person@example.com', password: ' spaced secret ' },
  );
});

test('rejects incomplete or invalid credentials', () => {
  assert.throws(() => parseCredentialsPayload('{}'));
  assert.throws(() => parseCredentialsPayload('not-json'));
});

test('recognises NHS-style OTP messages but ignores unrelated numbers', () => {
  assert.equal(isLikelyNhsOtpText('Your NHS login code is 123456'), true);
  assert.equal(extractOtpCode('Your NHS login code is 123456'), '123456');
  assert.equal(extractOtpCode('Your parcel reference is 123456'), null);
});

test('redacts sensitive authentication material', () => {
  const jwt = `${'a'.repeat(24)}.${'b'.repeat(24)}.${'c'.repeat(16)}`;
  const output = redact(`token=${jwt} NHSO-Session-Id=secret-value otp 123456 email=person@example.com`);
  assert.equal(output.includes(jwt), false);
  assert.equal(output.includes('secret-value'), false);
  assert.equal(output.includes('123456'), false);
  assert.equal(output.includes('person@example.com'), false);
});

test('normalises a status response', () => {
  const payload = buildStatusPayload({
    specialRequestNecessity: 'None',
    courses: [
      { id: 'one', name: 'Medicine A', details: '28 tablets', requestable: true },
      { id: 'two', name: 'Medicine B', requestable: false },
    ],
  });

  assert.equal(payload.ok, true);
  assert.deepEqual(payload.summary, {
    total: 2,
    requestable: 1,
    requestableNames: ['Medicine A'],
    specialRequestNecessity: 'None',
  });
  assert.deepEqual(payload.courses[1], {
    id: 'two',
    name: 'Medicine B',
    details: '',
    requestable: false,
  });
});

test('uses fallback for non-positive integer values', () => {
  assert.equal(parsePositiveInteger('12', 5), 12);
  assert.equal(parsePositiveInteger('0', 5), 5);
  assert.equal(parsePositiveInteger('nope', 5), 5);
});
