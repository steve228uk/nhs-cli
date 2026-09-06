import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import packageInfo from '../package.json' with { type: 'json' };

const exec = promisify(execFile);
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this script through npm run test:package.');
// An explicit npm spec also allows verification of the published release.
const archiveName = `${packageInfo.name.replace(/^@/, '').replace('/', '-')}-${packageInfo.version}.tgz`;
const source = process.argv[2] || fileURLToPath(new URL(`../dist/${archiveName}`, import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'nhs-package-test-'));
try {
  const prefix = join(directory, 'prefix');
  await exec(process.execPath, [npmCli, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', source], { timeout: 120000 });
  // npm's global package layout on the supported macOS/Linux platforms.
  const installed = join(prefix, 'lib', 'node_modules', packageInfo.name);
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.version, packageInfo.version);
  assert.deepEqual(await readdir(join(installed, 'skills')), ['nhs']);
  assert.match(await readFile(join(installed, 'skills', 'nhs', 'SKILL.md'), 'utf8'), /^---\nname: nhs\n/);
  await readFile(join(installed, 'INSTALL.md'), 'utf8');
  // Exercise local diagnostics with fresh synthetic state, never the user's vault.
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, NHS_CLI_STORAGE: 'encrypted-file', NHS_CLI_DATA_DIR: join(directory, 'state'), NHS_CLI_STATE_KEY: randomBytes(32).toString('base64') };
  delete env.NHS_CLI_CREDENTIALS;
  delete env.NHS_PRESCRIPTIONS_CREDENTIALS;
  for (const name of Object.keys(packageInfo.bin)) {
    const executable = resolve(prefix, 'bin', name);
    const version = await exec(executable, ['--version'], { env });
    assert.equal(version.stdout.trim(), packageInfo.version);
    const help = await exec(executable, ['--help'], { env });
    assert.match(help.stdout, /Usage: nhs/);
    const doctor = await exec(executable, ['doctor', '--json'], { env });
    assert.equal(JSON.parse(doctor.stdout).ok, true);
  }
  const status = await exec(join(prefix, 'bin', 'nhs'), ['auth', 'status', '--json'], { env });
  assert.equal(JSON.parse(status.stdout).sessionStored, false);
  assert.equal(JSON.parse(status.stdout).sessionValidity, 'not-checked');
  console.log(`Installed package ${metadata.name}@${metadata.version}: both entrypoints, skill, and synthetic local diagnostics passed.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
