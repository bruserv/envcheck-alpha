import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { auditPackage, packageFileAllowed, packageFailureStatus, npmFailureCode, packagePathInside, sanitizePackageEvidence, persistPackageEvidence } from '../scripts/package-contract.mjs';

const root = new URL('../', import.meta.url);
const inventory = async () => [
  'package.json', 'README.md', 'LICENSE',
  ...(await fs.readdir(new URL('src/', root))).filter(name => name.endsWith('.mjs')).map(name => `src/${name}`),
  'skills/envcheck/SKILL.md', 'skills/envcheck/references/workflow.md',
  'docs/installation.md', 'docs/configuration.md', 'docs/limitations.md', 'docs/zod.md'
];
const read = name => fs.readFile(new URL(name, root), 'utf8');

test('missing installed binaries/resources fail instead of pretending to be an environment block', () => {
  assert.equal(packageFailureStatus('npm-preflight', { code: 'ENOENT' }), 'blocked');
  assert.equal(packageFailureStatus('npm-install', { npmCode: 'ENOTCACHED' }), 'blocked');
  for (const stage of ['installed-package', 'installed-cli', 'installed-api']) {
    assert.equal(packageFailureStatus(stage, { code: 'ENOENT' }), 'failed');
    assert.equal(packageFailureStatus(stage, { code: 'EACCES' }), 'failed');
  }
  assert.equal(packageFailureStatus('npm-pack', { code: 'ENOENT' }), 'failed');
  assert.equal(packageFailureStatus('npm-install', { message: 'Integrity assertion failed' }), 'failed');
});

test('package audit checks runtime imports and skill/document references without npm or network', async () => {
  const files = await inventory();
  const result = await auditPackage(files, read);
  assert.equal(result.name, 'envcheck-workbench');
  assert.equal(result.private, true);
  assert.ok(result.modules >= 14);
});

test('package boundary excludes credential files, external trials and checkout-only material', async () => {
  const excluded = ['.env', '.env.example', '.npmrc', '../README.md', 'src/../.env',
    '.envcheck-test-work/real-world-trial/upstream/src/env.ts',
    'examples/reports/real-world-trial/LICENSE.upstream.txt', 'docs/real-world-trial.md',
    'docs/real-world-expectations.md', 'docs/work-session.md', 'node_modules/yaml/package.json',
    'scripts/onboarding.mjs', 'test/scan.test.mjs', '.git/config'];
  for (const name of excluded) assert.equal(packageFileAllowed(name), false, name);
  await assert.rejects(auditPackage([...(await inventory()), '.env'], read), /Unexpected package file/);
  await assert.rejects(auditPackage(await inventory(), async name => {
    if (name !== 'package.json') return read(name);
    const manifest = JSON.parse(await read(name));
    manifest.files.push('docs');
    return JSON.stringify(manifest);
  }), /Manifest must retain the narrow package boundary/);
});

test('package audit rejects a missing imported module or skill resource', async () => {
  const files = await inventory();
  await assert.rejects(auditPackage(files.filter(name => name !== 'src/zod.mjs'), read), /Module dependency missing/);
  await assert.rejects(auditPackage(files.filter(name => name !== 'skills/envcheck/references/workflow.md'), read), /Missing package resource/);
});

test('package audit rejects dangling documentation and undeclared runtime imports', async () => {
  const files = await inventory();
  await assert.rejects(auditPackage(files, async name => (await read(name)) +
    (name === 'skills/envcheck/SKILL.md' ? '\n[Missing](references/missing.md)\n' : '')), /Package documentation reference missing/);
  await assert.rejects(auditPackage(files, async name => (await read(name)) +
    (name === 'src/cli.mjs' ? "\nimport unexpected from 'undeclared-package';\n" : '')), /Undeclared runtime dependency/);
});

test('npm warnings cannot turn a manifest failure into an environmental block', () => {
  assert.equal(packageFailureStatus('npm-install', {
    npmCode: 'E404', message: 'npm error code E404\nnpm warn earlier getaddrinfo ENOTFOUND'
  }), 'failed');
  assert.equal(packageFailureStatus('npm-install', { code: 'ETIMEDOUT' }), 'failed');
  assert.equal(packageFailureStatus('npm-install', { code: 'ETIMEDOUT', npmCode: 'ENOTFOUND' }), 'failed');
  assert.equal(packageFailureStatus('pack-audit', { code: 'EACCES' }), 'failed');
  assert.equal(packageFailureStatus('npm-install', { npmCode: 'ENOTFOUND' }), 'blocked');
  assert.equal(packageFailureStatus('npm-install', { npmCode: 'ETARGET' }), 'failed');
  assert.equal(packageFailureStatus('npm-install', { npmCode: 'EBADENGINE' }), 'failed');
});

test('package audit rejects unused source files without printing their contents', async () => {
  const files = [...await inventory(), 'src/local-notes.mjs'];
  await assert.rejects(auditPackage(files, name => name === 'src/local-notes.mjs' ?
    'export const localNote = "synthetic private note";' : read(name)), {
    message: 'Unreachable package module: src/local-notes.mjs'
  });
});

test('package audit accepts a genuinely imported extra module, including cycles', async () => {
  const result = await auditPackage([...await inventory(), 'src/extra.mjs'], async name => {
    if (name === 'src/extra.mjs') return "import './cli.mjs';";
    return await read(name) + (name === 'src/cli.mjs' ? "\nimport './extra.mjs';\n" : '');
  });
  assert.equal(result.modules, 15);
});

test('npm cause parsing uses final error-code line, never warning tokens', () => {
  assert.equal(npmFailureCode('npm warn ENOTFOUND\r\nnpm error code E404\r\nnpm warn old ECONNRESET'), 'E404');
  assert.equal(npmFailureCode('npm ERR! code ENOTCACHED\nnpm error code ETARGET\n'), 'ETARGET');
  assert.equal(npmFailureCode('npm warn code ENOTFOUND'), null);
  assert.equal(npmFailureCode('npm error code ENOTCACHED\n'), 'ENOTCACHED');
});

test('consumer containment respects path boundaries and Windows case', () => {
  assert.equal(packagePathInside('A:\\Repo\\App', 'a:\\repo\\app\\tmp', 'win32'), true);
  assert.equal(packagePathInside('A:\\Repo\\App', 'A:\\Repo\\Application', 'win32'), false);
  assert.equal(packagePathInside('A:\\Repo\\App', 'B:\\Repo\\App', 'win32'), false);
  assert.equal(packagePathInside('/repo/app', '/repo/app/../consumer', 'linux'), false);
  assert.equal(packagePathInside('/repo/app', '/repo/app', 'linux'), true);
});

test('package evidence omits profile, checkout and temporary paths recursively', () => {
  const profile = 'C:\\Users\\Fixture Person';
  const work = profile + '\\Temp\\consumer';
  const evidence = sanitizePackageEvidence({ work, api: { resolved: work + '\\node_modules\\envcheck-workbench\\src\\index.mjs' },
    errors: [profile.replaceAll('\\', '/') + '/cache', 'A:\\Repo\\App\\src\\cli.mjs'], verified: true },
  [[work, '<tmp>'], [profile, '<home>'], ['A:\\Repo\\App', '<checkout>']]);
  assert.equal(evidence.work, '<tmp>');
  assert.equal(evidence.api.resolved, '<tmp>\\node_modules\\envcheck-workbench\\src\\index.mjs');
  assert.deepEqual(evidence.errors, ['<home>/cache', '<checkout>\\src\\cli.mjs']);
  assert.equal(evidence.verified, true);
  assert.ok(!JSON.stringify(evidence).includes('Fixture Person'));
});

test('cleanup failure still persists evidence and cannot leave a passed result', async () => {
  const report = { status: 'passed' };
  let written;
  await persistPackageEvidence(report, async () => { throw Object.assign(new Error('Temporary directory busy'), { code: 'EBUSY' }); },
    async value => { written = structuredClone(value); });
  assert.equal(written.status, 'failed');
  assert.equal(written.failure.stage, 'cleanup');
  assert.equal(written.cleanupError.code, 'EBUSY');
});

test('startup docs and CI matrix stay aligned on tarball installation, PowerShell npm.cmd and Node engines', async () => {
  const [readme, startHere, installation, ci, manifestText] = await Promise.all([
    read('README.md'),
    read('START-HERE.pl.md'),
    read('docs/installation.md'),
    read('.github/workflows/ci.yml'),
    read('package.json')
  ]);
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.engines.node, '^22.18.0 || >=24.11.0');
  for (const [label, doc] of [['README.md', readme], ['START-HERE.pl.md', startHere], ['docs/installation.md', installation]]) {
    assert.ok(doc.includes(`envcheck-workbench-${manifest.version}.tgz`), `${label} must recommend the .tgz archive`);
    assert.match(doc, /npm\.cmd install --save-dev --ignore-scripts/, `${label} must document npm.cmd install for PowerShell`);
    assert.doesNotMatch(doc, /npm(?:\.cmd)? install --save-dev (?:"C:\\Sciezka\\do\\envcheck"|\/path\/to\/envcheck-checkout)/, `${label} must not recommend checkout-directory installation`);
  }
  assert.match(ci, /os:\s*\[ubuntu-latest,\s*windows-latest\]/);
  assert.match(ci, /node:\s*\['22\.18\.0',\s*'22',\s*'24\.11\.0',\s*'24'\]/);
});
