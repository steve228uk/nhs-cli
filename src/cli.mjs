import { createUi } from './ui.mjs';
import { settings } from './config.mjs';
import { VaultStore, withLock, migrateLegacy, legacyCredentials } from './storage.mjs';
import { AuthClient } from './auth.mjs';
import { NhsServices, positive } from './domains.mjs';
import { readOtpFromMessages } from './otp.mjs';
import { NhsError, errorPayload } from './errors.mjs';
import { publicData, render, exportFile } from './output.mjs';
import packageInfo from '../package.json' with { type: 'json' };

export const HELP = `NHS CLI — unofficial NHS App client

Usage: nhs <command> [options]

  auth login [--reauth] [--save-credentials] [--migrate-credentials]
  auth status                         Local saved-login status
  auth logout [--forget]               Clear login; optionally credentials
  doctor                              Local secure-storage diagnostics
  capabilities                        Available account capabilities
  prescriptions list | history [--from=YYYY-MM-DD]
  prescriptions order --ids=id1,id2 --dry-run [--note=...]
  prescriptions order --ids=id1,id2 --confirm [--note=...]
  records [list]                      Available GP record sections
  results list [--year=YYYY] | get <id>
  appointments list | slots
  messages list [--source=nhs|gp] [--index=0] [--count=20]
  messages get <id> [--source=nhs|gp]
  profile | pharmacy
  documents list | get <id> | download <id> --output=<new-file>

Common: --json --no-login --no-prompt --messages-otp --force-otp
        --output=<new-file> (explicit sensitive JSON export)
        --help --version

Secure storage defaults to the OS keyring. Headless use must explicitly set
NHS_CLI_STORAGE=encrypted-file and inject NHS_CLI_STATE_KEY from a secret manager.
NHS_CLI_CREDENTIALS and legacy NHS_PRESCRIPTIONS_CREDENTIALS accept injected JSON.
Secrets must never be supplied in arguments. --debug never emits response bodies.
`;

const booleans = new Set(['json', 'no-login', 'no-prompt', 'messages-otp', 'force-otp', 'save-credentials', 'migrate-credentials', 'reauth', 'forget', 'dry-run', 'confirm', 'all-requestable', 'debug', 'help', 'version']);
const values = new Set(['ids', 'note', 'from', 'year', 'source', 'index', 'count', 'output', 'max-age-minutes']);
export function parseArgs(argv, legacy = false) {
  /** @type {Map<string, string|boolean>} */
  const flags = new Map(); const words = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '-h') { flags.set('help', true); continue; }
    if (!arg.startsWith('--')) { if (arg.startsWith('-')) throw new NhsError('usage', 'Unknown short option. Use --help.'); words.push(arg); continue; }
    const equal = arg.indexOf('='), key = arg.slice(2, equal < 0 ? undefined : equal);
    if (!booleans.has(key) && !values.has(key)) throw new NhsError('usage', 'Unknown option. Use --help for supported options.');
    if (flags.has(key)) throw new NhsError('usage', 'Duplicate options are not supported.');
    if (booleans.has(key)) {
      if (equal >= 0) throw new NhsError('usage', 'Boolean flags do not accept values.');
      flags.set(key, true);
    } else {
      const value = equal >= 0 ? arg.slice(equal + 1) : argv[++index];
      if (value === undefined || value.startsWith('--') || !value) throw new NhsError('usage', 'An option value is missing.');
      flags.set(key, value);
    }
  }
  if (legacy) {
    const command = words.shift() || 'status';
    const aliases = { status: ['prescriptions', 'list'], list: ['prescriptions', 'list'], order: ['prescriptions', 'order'], login: ['auth', 'login'], doctor: ['doctor'], otp: ['otp'] };
    if (!aliases[command]) throw new NhsError('usage', 'Unknown legacy command. Use nhs --help.');
    words.unshift(...aliases[command]);
  }
  const [group = 'help', verb, id, ...extra] = words;
  if (extra.length) throw new NhsError('usage', 'Too many positional arguments.');
  return { group, verb, id, flags };
}

function commandSpecificOptions(group, verb) {
  switch (group) {
    case 'auth':
      if (verb === 'login') return ['reauth', 'save-credentials', 'migrate-credentials'];
      if (verb === 'logout') return ['forget'];
      return [];
    case 'prescriptions':
      if (verb === 'order') return ['ids', 'all-requestable', 'confirm', 'dry-run', 'note'];
      if (verb === 'history') return ['from'];
      return [];
    case 'results': return ['year'];
    case 'messages': return ['source', 'index', 'count'];
    case 'otp': return ['max-age-minutes'];
    default: return [];
  }
}

function validateCommand({ group, verb, id, flags }) {
  const verbs = { auth: ['login', 'status', 'logout'], prescriptions: ['list', 'history', 'order'], records: ['list'], results: ['list', 'get'], appointments: ['list', 'slots'], messages: ['list', 'get'], documents: ['list', 'get', 'download'], profile: [], pharmacy: [], doctor: [], capabilities: [], otp: [] };
  if (!Object.hasOwn(verbs, group)) throw new NhsError('usage', 'Unknown command. Use nhs --help.');
  if ((verb && !verbs[group].includes(verb)) || (group === 'auth' && !verb)) throw new NhsError('usage', 'Unknown or missing subcommand. Use nhs --help.');
  if (id && !['get', 'download'].includes(verb)) throw new NhsError('usage', 'This command does not accept an identifier.');
  if (['get', 'download'].includes(verb) && !id) throw new NhsError('usage', 'This command requires an identifier.');
  const allowed = new Set(['json', 'no-login', 'no-prompt', 'messages-otp', 'force-otp', 'debug', 'output']);
  for (const key of commandSpecificOptions(group, verb)) allowed.add(key);
  for (const key of flags.keys()) if (!allowed.has(key)) throw new NhsError('usage', 'An option is not supported for this command.');
  if (group === 'documents' && verb === 'download' && !flags.has('output')) throw new NhsError('usage', 'Document download requires --output pointing to a new file.');
  if (flags.has('no-login') && (flags.has('reauth') || flags.has('save-credentials'))) throw new NhsError('usage', '--no-login cannot be combined with --reauth or --save-credentials.');
  if (group === 'prescriptions' && verb === 'order') {
    if (flags.has('ids') === flags.has('all-requestable')) throw new NhsError('order_requires_scope', 'Choose either explicit --ids or --all-requestable.');
    if (!flags.has('dry-run') && !flags.has('confirm')) throw new NhsError('order_requires_confirmation', 'Review a fresh dry-run preview and confirm the exact medicines before using --confirm.');
  }
  if (group === 'messages' && (verb === 'get' || flags.get('source') === 'gp') && (flags.has('index') || flags.has('count'))) throw new NhsError('usage', 'Pagination options apply only to the NHS inbox list.');
  if (group === 'results' && verb === 'get' && flags.has('year')) throw new NhsError('usage', 'Choose a result ID or a historical year.');
}

/** No diagnostics probe writes, migration, healthcare requests or secret values. */
export async function doctor(store) {
  const checks = [{ name: 'node', ok: [22, 24].includes(Number(process.versions.node.split('.')[0])), detail: process.version }];
  try { await store.probe(); checks.push({ name: 'secureStorage', ok: true, detail: store.backend }); }
  catch (error) { checks.push({ name: 'secureStorage', ok: false, detail: error instanceof NhsError ? error.message : 'Secure storage unavailable.' }); }
  return { ok: checks.every(check => check.ok), checks, backend: store.backend };
}

export async function execute(command, { env = process.env, transport = undefined, store: suppliedStore = undefined, config: suppliedConfig = undefined, ui = createUi() } = {}) {
  validateCommand(command);
  const { group, verb, id, flags } = command;
  const config = suppliedConfig || settings(env);
  const store = suppliedStore || new VaultStore({ directory: config.dataDir, backend: config.backend, env });
  if (group === 'doctor') return doctor(store);
  if (group === 'auth' && verb === 'status') {
    const vault = await store.load();
    return { ok: true, sessionStored: !!vault.session.sessionId, credentialsStored: !!vault.credentials, rememberedDevice: !!(vault.session.rmdToken || vault.session.rememberMyDevice), backend: store.backend, sessionValidity: 'not-checked' };
  }
  if (group === 'otp') {
    if (!flags.has('messages-otp')) throw new NhsError('usage', 'Messages lookup requires --messages-otp.');
    const age = positive(flags.get('max-age-minutes'), 15, 60);
    await readOtpFromMessages({ since: Date.now() - age * 60000 });
    return { ok: true, found: true, maxAgeMinutes: age };
  }
  return withLock(config.dataDir, async () => {
    const vault = await migrateLegacy(store, config.legacyPath);
    if (flags.has('migrate-credentials')) { vault.credentials = await legacyCredentials(); await store.save(vault); }
    const auth = new AuthClient({ store, vault, transport, options: { env, onPhase: ui.phase, allowLogin: !flags.has('no-login'), allowPrompt: !!process.stdin.isTTY && !flags.has('no-prompt'), messages: flags.has('messages-otp'), forceOtp: flags.has('force-otp'), saveCredentials: flags.has('save-credentials') } });
    if (group === 'auth' && verb === 'logout') return auth.logout(flags.has('forget'));
    await auth.ensure({ reauth: flags.has('reauth') || flags.has('save-credentials') });
    if (group === 'auth') return { ok: true, loggedIn: true, statePath: store.path, backend: store.backend };
    const services = new NhsServices(auth);
    if (group === 'capabilities') return { ok: true, capabilities: await services.discover() };
    let data;
    if (group === 'prescriptions') {
      if (verb === 'order') return services.order({ ids: flags.get('ids'), all: flags.has('all-requestable'), note: String(flags.get('note') || ''), confirm: flags.has('confirm'), dryRun: flags.has('dry-run') });
      if (verb !== 'history') return services.courses();
      data = await services.history(flags.get('from'));
    } else if (group === 'records') data = await services.record();
    else if (group === 'results') data = await services.results({ id, year: flags.get('year') });
    else if (group === 'appointments') data = await services.appointments(verb === 'slots');
    else if (group === 'messages') data = await services.messages({ source: String(flags.get('source') || 'nhs'), id, index: flags.has('index') ? Number(flags.get('index')) : 0, count: positive(flags.get('count'), 20) });
    else if (group === 'profile') data = await services.profile();
    else if (group === 'pharmacy') data = await services.pharmacy();
    else if (group === 'documents') {
      data = await services.documents(id, verb === 'download');
      if (verb === 'download') {
        const path = await exportFile(String(flags.get('output')), data.content);
        return { ok: true, downloaded: true, path, contentType: data.contentType, bytes: data.content.length };
      }
    }
    return { ok: true, resource: group, checkedAt: new Date().toISOString(), data: publicData(data) };
  });
}

export async function main(argv = process.argv.slice(2), legacy = false) {
  const json = argv.includes('--json') || !process.stdout.isTTY;
  const interactive = !json && !!process.stdin.isTTY && !!process.stderr.isTTY && !argv.includes('--no-prompt');
  const ui = createUi({ enabled: interactive });
  try {
    const command = parseArgs(argv, legacy);
    if (command.flags.has('version')) { process.stdout.write(`${packageInfo.version}\n`); return; }
    if (command.flags.has('help') || command.group === 'help') { process.stdout.write(HELP); return; }
    const payload = await execute(command, { ui });
    const login = command.group === 'auth' && command.verb === 'login';
    if (command.flags.has('output') && !(command.group === 'documents' && command.verb === 'download')) {
      const path = await exportFile(String(command.flags.get('output')), render(payload, true));
      process.stdout.write(render({ ok: true, exported: true, path }, json));
      ui.finish();
    } else {
      ui.finish(login);
      if (!(interactive && login)) process.stdout.write(render(payload, json));
    }
    if (!payload.ok) process.exitCode = 1;
  } catch (error) {
    ui.fail();
    const output = render(errorPayload(error), json);
    (json ? process.stdout : process.stderr).write(output);
    process.exitCode = 1;
  }
}
