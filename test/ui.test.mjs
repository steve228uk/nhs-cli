import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';
import { promptInput, createUi } from '../src/ui.mjs';
import { resolveCredentials } from '../src/credentials.mjs';
import { resolveOtp } from '../src/otp.mjs';
import { client, loginHandler } from './helpers.mjs';

function terminal() {
  let rendered = '';
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {} });
  const output = Object.assign(new Writable({ write(chunk, _encoding, done) { rendered += chunk; done(); } }), { isTTY: true, columns: 100 });
  return { input, output, rendered: () => rendered };
}

test('real Clack prompts show email and OTP, masking the password throughout', async () => {
  const tty = terminal();
  const values = ['synthetic@example.com', 'SYNTHETIC-password-493', '123456'];
  let index = 0;
  const prompt = (message, options) => {
    const result = promptInput(message, { ...options, ...tty });
    tty.input.write(values[index++] + '\r');
    return result;
  };
  const credentials = await resolveCredentials({}, { env: {}, allowPrompt: true, prompt });
  assert.deepEqual(credentials.value, { email: values[0], password: values[1] });
  assert.equal(await resolveOtp({ since: Date.now(), allowPrompt: true, prompt }), values[2]);
  assert.ok(tty.rendered().includes(values[0]));
  assert.ok(tty.rendered().includes(values[2]));
  assert.ok(!tty.rendered().includes(values[1]));
  assert.ok(!tty.rendered().includes('SYNTHETIC-password'));
  tty.input.destroy();
});

test('cancelling or closing a prompt returns auth_cancelled and masks partial passwords', async () => {
  for (const close of [false, true]) {
    const tty = terminal();
    const result = promptInput('Password', { ...tty, secret: true });
    tty.input.write('partial-synthetic-secret');
    if (close) tty.input.end(); else tty.input.write('\x03');
    await assert.rejects(result, { code: 'auth_cancelled' });
    assert.ok(!tty.rendered().includes('partial-synthetic-secret'));
    assert.equal(tty.input.listenerCount('end'), 0);
    tty.input.destroy();
  }
});

test('interactive validation lets users correct an invalid security code', async () => {
  const tty = terminal();
  const result = resolveOtp({ since: Date.now(), allowPrompt: true, prompt: (message, options) => promptInput(message, { ...options, ...tty }) });
  tty.input.write('12\r');
  assert.ok(tty.rendered().includes('Enter the six-digit NHS security code.'));
  tty.input.write('3456\r');
  assert.equal(await result, '123456');
  tty.input.destroy();
});

test('redirected terminal streams never receive visible credentials', async () => {
  for (const field of ['input', 'output']) {
    const tty = terminal(); tty[field].isTTY = false;
    await assert.rejects(promptInput('Email', tty), { code: 'auth_required' });
    assert.equal(tty.rendered(), '');
    tty.input.destroy();
  }
});

test('no-prompt mode never opens either credential or security-code prompts', async () => {
  const prompt = async () => { assert.fail('must not prompt'); };
  await assert.rejects(resolveCredentials({}, { env: {}, allowPrompt: false, prompt }), { code: 'auth_required' });
  await assert.rejects(resolveOtp({ since: Date.now(), allowPrompt: false, prompt }), { code: 'auth_required' });
});

test('progress is disabled for agent output and contains only fixed labels when enabled', () => {
  const tty = terminal();
  const quiet = createUi({ output: tty.output });
  quiet.phase('session'); quiet.finish(true); quiet.fail();
  assert.equal(tty.rendered(), '');
  const ui = createUi({ enabled: true, output: tty.output });
  ui.phase('synthetic-private-token'); ui.phase('session'); ui.finish(true);
  assert.ok(tty.rendered().includes('Checking saved NHS session'));
  assert.ok(tty.rendered().includes('securely saved'));
  assert.ok(!tty.rendered().includes('synthetic-private-token'));
  tty.input.destroy();
});

test('authentication progress covers MFA and GP uplift without passing secret values', async () => {
  const phases = [];
  const { auth } = client(loginHandler({ otp: true, gp: true }), {
    initial: { version: 1, session: {} },
    options: { allowPrompt: true, onPhase: phase => phases.push(phase) },
    credentials: async () => ({ value: { email: 'synthetic@example.com', password: 'synthetic-secret' }, source: 'prompt' }),
    otp: async () => '123456',
  });
  await auth.ensure({ gp: true });
  assert.deepEqual(phases, ['credentials', 'authorization', 'otp', 'verify', 'create', 'gp']);
});
