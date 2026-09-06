import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import packageInfo from '../package.json' with { type: 'json' };

const root = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this script through npm run build.');
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
const [packed] = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', 'dist'], { cwd: root, encoding: 'utf8' }));
try {
  assert.equal(packed.name, '@steve228uk/nhs-cli');
  assert.equal(packed.version, packageInfo.version);
  const rootFiles = new Set(['package.json', 'README.md', 'INSTALL.md', 'LICENSE', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md']);
  const paths = new Set(packed.files.map(file => file.path));
  for (const file of packed.files) {
    assert.ok(rootFiles.has(file.path) || /^(?:bin|src)\/[a-z-]+\.mjs$/.test(file.path) || /^docs\/[a-z-]+\.md$/.test(file.path) || file.path === 'skills/nhs/SKILL.md', `Unexpected package file: ${file.path}`);
  }
  for (const path of [...rootFiles, 'src/cli.mjs', 'skills/nhs/SKILL.md', ...Object.values(packageInfo.bin)]) {
    assert.ok(paths.has(path), `Missing package file: ${path}`);
  }
  for (const path of Object.values(packageInfo.bin)) {
    assert.ok(packed.files.find(file => file.path === path).mode & 0o111, `Entrypoint is not executable: ${path}`);
  }
} catch (error) {
  await unlink(new URL(`../dist/${packed.filename}`, import.meta.url));
  throw error;
}
console.log(`Built dist/${packed.filename}: ${packed.entryCount} reviewed file paths, ${packed.size} bytes.`);
