import { text, password, isCancel, intro, outro, cancel, log } from '@clack/prompts';
import { NhsError } from './errors.mjs';

/**
 * Prompts use the terminal on stderr; passwords alone are masked.
 * @param {string} message
 * @param {{secret?: boolean, validate?: (value: string | undefined) => string | undefined, input?: typeof process.stdin, output?: typeof process.stderr}} options
 */
export async function promptInput(message, { secret = false, validate = undefined, input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY || !output.isTTY) throw new NhsError('auth_required', 'Interactive authentication requires a terminal. Run nhs auth login in a terminal.');
  const controller = new AbortController();
  const closed = () => controller.abort();
  input.once('end', closed);
  input.once('close', closed);
  try {
    const value = await (secret ? password : text)({ message, input, output, validate, signal: controller.signal });
    if (isCancel(value)) throw new NhsError('auth_cancelled', 'Authentication was cancelled.');
    return /** @type {string} */ (value);
  } finally {
    input.off('end', closed);
    input.off('close', closed);
  }
}

const phases = {
  session: 'Checking saved NHS session',
  credentials: 'Signing in to NHS login',
  authorization: 'Connecting securely to NHS login',
  otp: 'NHS has sent a security code to your phone',
  verify: 'Verifying your security code',
  create: 'Creating and securely saving your NHS session',
  gp: 'Connecting to your GP services',
};
/** Only fixed phase labels enter progress output, never authentication values. */
export function createUi({ enabled = false, output = process.stderr } = {}) {
  let started = false;
  return {
    phase(phase) {
      if (!enabled || !Object.hasOwn(phases, phase)) return;
      if (!started) { intro('NHS CLI · unofficial NHS App client', { output }); started = true; }
      log.step(phases[phase], { output });
    },
    finish(login = false) {
      if (started) outro(login ? 'Signed in. Your login is securely saved.' : 'NHS session ready.', { output });
      started = false;
    },
    fail() {
      if (started) cancel('Could not complete this command.', { output });
      started = false;
    },
  };
}
