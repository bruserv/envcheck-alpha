import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { auditPackage, packageFailureStatus, npmFailureCode, packagePathInside, sanitizePackageEvidence, persistPackageEvidence } from './package-contract.mjs';

const checkout = fileURLToPath(new URL('../', import.meta.url));
const evidence = path.join(checkout, 'examples/reports/package-validation.json');
const artifactDirectory = path.join(checkout, '.envcheck-test-work/package-output');
const secretMarkers = ['PACKAGE_LOCAL_', 'PACKAGE_EXAMPLE_', 'PACKAGE_COMPOSE_'].map(prefix => prefix + randomUUID());
const report = { schemaVersion: 1, status: 'running', node: process.version, platform: process.platform, offline: process.env.ENVCHECK_PACKAGE_OFFLINE === '1', stages: [], installationVerified: false, checkoutIndependent: false, network: 'npm install needs registry access or a complete cache; pack/unit tests do not need the registry.' };
let stage = 'npm-preflight';
let work;
const safeEvidence = value => sanitizePackageEvidence(value, [[work, '<tmp>'], [checkout.replace(/[\\/]+$/, ''), '<checkout>'], [os.tmpdir(), '<tmp>'], [os.homedir(), '<home>']]);

const omit = value => safeEvidence(secretMarkers.reduce((text, secret) => text.replaceAll(secret, '[redacted fixture value]'), String(value ?? ''))
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1[redacted]@')
  .replace(/((?:_authToken|_password|authorization)\s*[=:]\s*)\S+/gi, '$1[redacted]'));
const env = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? process.env.Path ?? '') };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;
const child = (command, args, cwd, options = {}) => spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...options });

async function npmCli() {
  const candidates = [process.env.ENVCHECK_NPM_CLI, process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) {
    candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'));
    try {
      const executable = await fs.realpath(path.join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm'));
      if (path.basename(executable) === 'npm-cli.js') candidates.push(executable);
    } catch { /* Other PATH entries may not provide npm. */ }
  }
  for (const candidate of candidates) {
    if (path.basename(candidate) !== 'npm-cli.js') continue;
    try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* Try the next installed npm. */ }
  }
  const error = new Error('npm CLI not found (ENOENT). Run npm run test:package, or set ENVCHECK_NPM_CLI to an installed npm-cli.js. No pack or install was performed.');
  error.code = 'ENOENT';
  throw error;
}

function verifyProcess(result, label, expected = 0) {
  for (const secret of secretMarkers) assert.ok(!`${result.stdout ?? ''}${result.stderr ?? ''}`.includes(secret), `${label}: configuration value exposed`);
  if (result.error || result.status !== expected) {
    const error = new Error(`${label}: ${result.error?.code ?? `exit ${result.status}`}\n${omit(result.stderr || result.stdout)}`);
    error.code = result.error?.code;
    error.npmCode = result.error ? null : npmFailureCode(result.stderr || result.stdout);
    error.exit = result.status;
    throw error;
  }
}

async function main() {
  const npm = await npmCli();
  const version = child(process.execPath, [npm, '--version'], checkout);
  verifyProcess(version, 'npm version');
  report.npm = version.stdout.trim();
  const temporaryBase = await fs.realpath(os.tmpdir());
  work = await fs.mkdtemp(path.join(temporaryBase, 'envcheck-package-'));
  assert.ok(!packagePathInside(await fs.realpath(checkout), await fs.realpath(work)), 'Consumer must be outside the source checkout');
  report.work = work;
  const consumer = path.join(work, 'consumer app');
  const packDirectory = path.join(work, 'archives');
  await fs.mkdir(consumer);
  await fs.mkdir(packDirectory);
  const npmOptions = ['--ignore-scripts', '--no-audit', '--no-fund', '--color=false', '--fetch-retries=0', '--fetch-timeout=30000',
    ...(process.env.ENVCHECK_PACKAGE_CACHE ? ['--cache', path.resolve(process.env.ENVCHECK_PACKAGE_CACHE)] : []),
    ...(process.env.ENVCHECK_PACKAGE_OFFLINE === '1' ? ['--offline'] : [])];
  stage = 'npm-pack';
  const pack = child(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory, ...npmOptions], checkout, { timeout: 180_000 });
  verifyProcess(pack, 'npm pack --ignore-scripts');
  report.stages.push({ stage, exit: 0 });
  stage = 'pack-audit';
  const [packed] = JSON.parse(pack.stdout);
  assert.equal(path.basename(packed.filename), packed.filename);
  const inventory = packed.files.map(file => file.path);
  // At this stage npm's own inventory is checked against source bytes. Later it
  // is checked again against the actual independently installed package bytes.
  report.inventory = await auditPackage(inventory, name => fs.readFile(path.join(checkout, name), 'utf8'));
  report.files = inventory;
  const archive = path.join(packDirectory, packed.filename);
  const bytes = await fs.readFile(archive);
  await fs.mkdir(artifactDirectory, { recursive: true });
  const preserved = path.join(artifactDirectory, packed.filename);
  await fs.copyFile(archive, preserved);
  report.tarball = { path: path.relative(checkout, preserved).split(path.sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), integrity: packed.integrity };
  await fs.writeFile(preserved + '.sha256', `${report.tarball.sha256}  ${packed.filename}\n`);
  report.stages.push({ stage, exit: 0 });

  await fs.writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'envcheck-package-consumer', version: '1.0.0', private: true, type: 'module' }) + '\n');
  // Install a relocated archive, never a file: checkout directory or npm link.
  const relocated = path.join(consumer, packed.filename);
  await fs.copyFile(archive, relocated);
  stage = 'npm-install';
  const install = child(process.execPath, [npm, 'install', '--save-dev', relocated, ...npmOptions], consumer, { timeout: 180_000 });
  verifyProcess(install, 'npm install --ignore-scripts');
  report.stages.push({ stage, exit: 0 });
  stage = 'installed-package';
  const installed = path.join(consumer, 'node_modules/envcheck-workbench');
  assert.equal((await fs.lstat(installed)).isSymbolicLink(), false, 'Installation must not link to the checkout');
  assert.ok((await fs.realpath(installed)).startsWith(consumer + path.sep));
  await auditPackage(inventory, name => fs.readFile(path.join(installed, name), 'utf8'));
  for (const name of inventory) assert.ok((await fs.readFile(path.join(installed, name))).equals(await fs.readFile(path.join(checkout, name))), `Installed bytes differ: ${name}`);
  report.installationVerified = true;
  report.stages.push({ stage, exit: 0 });

  stage = 'installed-documentation';
  const configurationGuide = await fs.readFile(path.join(installed, 'docs/configuration.md'), 'utf8');
  for (const topic of ['"compose"', '"variables"', '"required": false', '"ignore"', 'fallback', 'found', 'completeDiff']) assert.ok(configurationGuide.includes(topic), `Installed configuration guide lacks ${topic}`);
  const installationGuide = await fs.readFile(path.join(installed, 'docs/installation.md'), 'utf8');
  assert.match(installationGuide, /\]\(configuration\.md\)/);
  report.stages.push({ stage, exit: 0 });

  stage = 'installed-cli';
  const bin = path.join(consumer, 'node_modules/.bin', process.platform === 'win32' ? 'envcheck.cmd' : 'envcheck');
  await fs.access(bin);
  const invoke = (label, args, expected, json = true) => {
    const commandArgs = [...args, ...(json ? ['--json'] : [])];
    let result;
    if (process.platform === 'win32') {
      // cmd expands % and ! even in quoted arguments. The test generates paths,
      // never report text; reject expansion characters before using the shim.
      const quoted = [bin, ...commandArgs].map(arg => {
        assert.ok(!/[\r\n"%!]/.test(arg), 'Unsupported expansion character in Windows package-test path');
        return `"${arg}"`;
      });
      result = child(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${quoted.join(' ')}"`], consumer, { windowsVerbatimArguments: true });
    } else result = child(bin, commandArgs, consumer);
    verifyProcess(result, label, expected);
    assert.equal(result.stderr, '', `${label}: unexpected stderr`);
    report.stages.push({ stage: label, exit: result.status });
    return json ? JSON.parse(result.stdout) : result.stdout;
  };
  assert.match(invoke('help', ['--help'], 0, false), /Usage:[\s\S]*fix-compose/);
  const roots = {};
  const fixtureEol = '\r\n';
  const source = "\uFEFF#!/usr/bin/env node\r\nimport { z } from 'zod'; z.object({ API_KEY: z.string(), PORT: z.number().default(3000) }).parse(process.env);\r\n";
  for (const name of ['good', 'broken']) {
    const root = path.join(consumer, `${name} app`);
    roots[name] = root;
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/app.ts'), source);
    await fs.writeFile(path.join(root, 'src/first-line.ts'), '\uFEFFprocess.env.API_KEY;\r\n');
    await fs.writeFile(path.join(root, 'envcheck.config.json'), '\uFEFF' + JSON.stringify({ version: 1, sources: ['src'], envFiles: ['.env'], example: '.env.example', compose: { file: 'compose.yaml', service: 'api' }, variables: { PORT: { type: 'port', required: false } } }));
    await fs.writeFile(path.join(root, '.env.example'), `\uFEFFPORT=${secretMarkers[1]}\r\n# Preserve existing example content.\r\n${name === 'good' ? 'API_KEY=\r\n' : ''}`);
    await fs.writeFile(path.join(root, '.env'), `\uFEFFAPI_KEY=${secretMarkers[0]}left\uFEFFright\r\nPORT=3000\r\n`);
    await fs.writeFile(path.join(root, 'compose.yaml'), `\uFEFFservices:\r\n  api:\r\n    environment:\r\n      PORT: "3000" # Preserve this comment.\r\n      OTHER: ${secretMarkers[2]}left\uFEFFright\r\n${name === 'good' ? '      API_KEY: ${API_KEY:?Set API_KEY locally}\r\n' : ''}`);
  }
  const good = invoke('scan-good', ['scan', roots.good, '--strict'], 0);
  assert.equal(good.scope.complete, true);
  assert.equal(good.scope.valuesChecked, true);
  assert.ok(good.variables.find(v => v.name === 'API_KEY').usages.some(u => u.file === 'src/first-line.ts' && u.line === 1 && u.column === 1));
  const explanation = invoke('explain-json', ['explain', 'API_KEY', roots.good, '--no-values'], 0);
  assert.equal(explanation.found, true);
  assert.equal(explanation.schemaVersion, 1);
  assert.match(invoke('explain-text', ['explain', 'API_KEY', roots.good, '--no-values'], 0, false), /EnvCheck explanation: API_KEY[\s\S]*Required: yes[\s\S]*NOT CHECKED/);
  const broken = invoke('scan-broken', ['scan', roots.broken, '--strict', '--no-values'], 1);
  assert.deepEqual(broken.findings.map(f => f.rule).sort(), ['COMPOSE_VARIABLE_MISSING', 'UNDOCUMENTED_VARIABLE']);
  const comparison = invoke('compare-json', ['compare', roots.good, roots.broken, '--strict'], 1);
  assert.ok(comparison.changes.some(change => change.kind === 'DOCUMENTATION_REMOVED'));
  assert.match(invoke('compare-markdown', ['compare', roots.good, roots.broken, '--markdown', '--strict'], 1, false), /## EnvCheck Comparison[\s\S]*DOCUMENTATION_REMOVED/);
  const originalSource = await fs.readFile(path.join(roots.broken, 'src/app.ts'));
  const originalExample = await fs.readFile(path.join(roots.broken, '.env.example'), 'utf8');
  const originalCompose = await fs.readFile(path.join(roots.broken, 'compose.yaml'), 'utf8');
  const originalLocal = await fs.readFile(path.join(roots.broken, '.env'), 'utf8');
  invoke('preview-example', ['fix-example', roots.broken], 1);
  const composePreview = invoke('preview-compose', ['fix-compose', roots.broken], 1);
  assert.equal(composePreview.preview.kind, 'map');
  assert.equal(composePreview.preview.completeDiff, false);
  assert.ok(composePreview.preview.lines.includes('  API_KEY: ${API_KEY:?Set API_KEY locally}'));
  assert.match(invoke('preview-compose-text', ['fix-compose', roots.broken], 1, false), /not a full diff[\s\S]*API_KEY: \$\{API_KEY:\?Set API_KEY locally\}/);
  assert.equal(await fs.readFile(path.join(roots.broken, '.env.example'), 'utf8'), originalExample);
  assert.equal(await fs.readFile(path.join(roots.broken, 'compose.yaml'), 'utf8'), originalCompose);
  assert.deepEqual(invoke('apply-example', ['fix-example', roots.broken, '--apply'], 1).additions, ['API_KEY']);
  assert.deepEqual(invoke('apply-compose', ['fix-compose', roots.broken, '--apply'], 0).additions, ['API_KEY']);
  assert.equal(await fs.readFile(path.join(roots.broken, '.env.example'), 'utf8'), originalExample + 'API_KEY=' + fixtureEol);
  assert.ok((await fs.readFile(path.join(roots.broken, 'compose.yaml'), 'utf8')).includes('# Preserve this comment.'));
  const updatedCompose = await fs.readFile(path.join(roots.broken, 'compose.yaml'), 'utf8');
  assert.ok(updatedCompose.includes(`OTHER: ${secretMarkers[2]}left\uFEFFright`));
  assert.ok(updatedCompose.startsWith('\uFEFFservices:'));
  assert.ok(!updatedCompose.startsWith('\uFEFF\uFEFF'));
  assert.ok(!updatedCompose.replaceAll(fixtureEol, '').includes('\n'));
  assert.equal(await fs.readFile(path.join(roots.broken, '.env'), 'utf8'), originalLocal);
  assert.ok((await fs.readFile(path.join(roots.broken, 'src/app.ts'))).equals(originalSource));
  invoke('rescan', ['scan', roots.broken, '--strict'], 0);
  assert.equal(invoke('repeat-example', ['fix-example', roots.broken, '--apply'], 0).changed, false);
  assert.equal(invoke('repeat-compose', ['fix-compose', roots.broken, '--apply'], 0).changed, false);
  const resolved = invoke('compare-repaired', ['compare', roots.good, roots.broken, '--strict'], 0);
  assert.deepEqual(resolved.changes, []);

  const goodExampleFile = path.join(roots.good, '.env.example');
  const goodExample = await fs.readFile(goodExampleFile);
  await fs.appendFile(goodExampleFile, 'DOC_ONLY=\r\n');
  const exampleOnly = invoke('explain-example-only-json', ['explain', 'DOC_ONLY', roots.good, '--no-values'], 1);
  assert.equal(exampleOnly.found, false);
  assert.equal(Object.hasOwn(exampleOnly, 'variable'), false);
  assert.ok(exampleOnly.findings.some(f => f.rule === 'UNREFERENCED_EXAMPLE_VARIABLE'));
  assert.match(invoke('explain-example-only-text', ['explain', 'DOC_ONLY', roots.good, '--no-values'], 1, false), /UNREFERENCED_EXAMPLE_VARIABLE[\s\S]*\.env\.example/);
  await fs.writeFile(goodExampleFile, goodExample);

  const listRoot = path.join(consumer, 'list app');
  await fs.mkdir(path.join(listRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(listRoot, 'src/app.ts'), 'process.env.API_KEY;\n');
  await fs.writeFile(path.join(listRoot, '.env.example'), 'API_KEY=\n');
  await fs.writeFile(path.join(listRoot, 'envcheck.config.json'), JSON.stringify({ version: 1, sources: ['src'], envFiles: [], compose: { file: 'compose.yaml', service: 'api' } }));
  const listComposeFile = path.join(listRoot, 'compose.yaml');
  const listCompose = `services:\n  api:\n    environment:\n      - OTHER=${secretMarkers[2]}\n`;
  await fs.writeFile(listComposeFile, listCompose);
  const listPreview = invoke('preview-compose-list-json', ['fix-compose', listRoot], 1);
  assert.equal(listPreview.preview.kind, 'list');
  assert.ok(listPreview.preview.lines.includes('  - API_KEY=${API_KEY:?Set API_KEY locally}'));
  assert.match(invoke('preview-compose-list-text', ['fix-compose', listRoot], 1, false), /not a full diff[\s\S]*- API_KEY=\$\{API_KEY:\?Set API_KEY locally\}/);
  assert.equal(await fs.readFile(listComposeFile, 'utf8'), listCompose);
  invoke('apply-compose-list', ['fix-compose', listRoot, '--apply'], 0);
  assert.ok((await fs.readFile(listComposeFile, 'utf8')).includes(`- OTHER=${secretMarkers[2]}`));
  assert.equal(invoke('repeat-compose-list', ['fix-compose', listRoot, '--apply'], 0).changed, false);
  report.usability = { readableExplain: true, exampleOnlyDiagnostics: true, foundContractUnchanged: true, composeMapAndListPreview: true, previewIsNotFullDiff: true, installedConfigurationGuide: true };

  const skill = invoke('skill-install', ['skill', 'install', roots.broken, '--agent', 'both'], 0);
  assert.equal(skill.filesAdded, 4);
  for (const folder of ['.agents/skills/envcheck', '.claude/skills/envcheck']) {
    for (const resource of ['SKILL.md', 'references/workflow.md']) {
      const actual = await fs.readFile(path.join(roots.broken, folder, resource));
      const expected = await fs.readFile(path.join(installed, 'skills/envcheck', resource));
      assert.ok(actual.equals(expected), `Installed skill resource differs: ${resource}`);
    }
    const skillText = await fs.readFile(path.join(roots.broken, folder, 'SKILL.md'), 'utf8');
    for (const match of skillText.matchAll(/\]\((references\/[^)]+)\)/g)) await fs.access(path.join(roots.broken, folder, match[1]));
  }
  assert.equal(invoke('skill-repeat', ['skill', 'install', roots.broken, '--agent', 'both'], 0).filesAdded, 0);
  assert.equal(invoke('invocation-error', ['scan', roots.good, '--unknown-option'], 2).error.code, 'INPUT_ERROR');
  const configFile = path.join(roots.good, 'envcheck.config.json');
  const originalConfig = await fs.readFile(configFile, 'utf8');
  await fs.writeFile(configFile, '\uFEFF{"sources":["src"]}');
  const missingVersion = invoke('config-missing-version-bom', ['scan', roots.good], 2);
  assert.equal(missingVersion.error.code, 'INPUT_ERROR');
  assert.match(missingVersion.error.message, /Configuration must declare version: 1/);
  await fs.writeFile(configFile, originalConfig);
  await fs.writeFile(path.join(roots.broken, '.env'), '\uFEFFAPI_KEY=\r\nPORT=3000\r\n');
  const empty = invoke('scan-empty-value', ['scan', roots.broken, '--strict'], 1);
  assert.equal(empty.variables.find(v => v.name === 'API_KEY').local.state, 'empty');
  assert.ok(empty.findings.some(f => f.rule === 'REQUIRED_VALUE_MISSING'));
  const composeFile = path.join(roots.broken, 'compose.yaml');
  const validCompose = await fs.readFile(composeFile, 'utf8');
  for (const [label, invalid] of [['double', '\uFEFF' + validCompose], ['after-blank', '\r\n' + validCompose]]) {
    await fs.writeFile(composeFile, invalid);
    const unsupported = invoke(`compose-${label}-scan`, ['scan', roots.broken, '--strict', '--no-values'], 1);
    assert.equal(unsupported.scope.complete, false);
    assert.ok(unsupported.findings.some(f => f.rule === 'COMPOSE_UNSUPPORTED' && /BOM/.test(f.message)));
    for (const [action, args] of [['preview', []], ['apply', ['--apply']]]) {
      const refused = invoke(`compose-${label}-${action}`, ['fix-compose', roots.broken, ...args], 2);
      assert.equal(refused.error.code, 'INPUT_ERROR');
      assert.match(refused.error.message, /additional or noninitial BOM/);
      assert.equal(await fs.readFile(composeFile, 'utf8'), invalid);
    }
  }
  const unsafeRoundTrip = ` \uFEFFx-note: ${secretMarkers[2]}\r\n services:\r\n   api:\r\n     environment:\r\n       PORT: "3000"\r\n`;
  await fs.writeFile(composeFile, unsafeRoundTrip);
  const interpreted = invoke('compose-roundtrip-scan', ['scan', roots.broken, '--strict', '--no-values'], 1);
  assert.equal(interpreted.scope.complete, true);
  assert.ok(interpreted.findings.some(f => f.rule === 'COMPOSE_VARIABLE_MISSING'));
  for (const [action, args] of [['preview', []], ['apply', ['--apply']]]) {
    const refused = invoke(`compose-roundtrip-${action}`, ['fix-compose', roots.broken, ...args], 2);
    assert.equal(refused.error.code, 'INPUT_ERROR');
    assert.match(refused.error.message, /cannot preserve U\+FEFF/);
    assert.equal(await fs.readFile(composeFile, 'utf8'), unsafeRoundTrip);
  }
  await fs.writeFile(composeFile, validCompose);
  report.encoding = { files: ['src/app.ts', 'src/first-line.ts', 'envcheck.config.json', '.env.example', '.env', 'compose.yaml'], leadingBom: true, lineEndings: 'CRLF', embeddedFeffPreserved: true, repairIdempotence: true, sourceShebang: true, firstLineColumn: 1, extraComposeBomWriteRefused: true, roundTripLossWriteRefused: true };

  // Exercise the new presence proof from the independently installed archive.
  // These are scanner inputs only: no Zod or application callbacks are run.
  for (const adapter of ['standalone', 't3']) {
    const root = path.join(consumer, `pipeline-${adapter}`);
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    const field = 'z.string().transform(v => v.split(",")).pipe(z.array(z.string())).optional()';
    const source = adapter === 'standalone' ?
      `import { z } from 'zod'; z.object({ TOKEN: ${field} }).parse(process.env);` :
      `import { z } from 'zod'; import { createEnv } from '@t3-oss/env-core';
       createEnv({ server: { token: ${field} }, runtimeEnv: { token: process.env.TOKEN } });`;
    await fs.writeFile(path.join(root, 'src/app.ts'), source);
    await fs.writeFile(path.join(root, '.env.example'), 'TOKEN=\n');
    await fs.writeFile(path.join(root, 'envcheck.config.json'), JSON.stringify({ version: 1, envFiles: [], compose: { file: 'compose.yaml', service: 'api' } }));
    await fs.writeFile(path.join(root, 'compose.yaml'), 'services:\n  api:\n    image: example\n');
    for (const strict of [false, true]) {
      const checked = invoke(`pipeline-${adapter}-${strict ? 'strict' : 'scan'}`, ['scan', root, ...(strict ? ['--strict'] : [])], strict ? 1 : 0);
      assert.equal(checked.scope.complete, false);
      assert.ok(checked.findings.some(f => f.rule === 'SOURCE_UNSUPPORTED'));
      assert.deepEqual(checked.variables.map(v => [v.name, v.required, v.compose.state]), [['TOKEN', false, 'missing']]);
    }
    const plan = invoke(`pipeline-${adapter}-plan`, ['plan', root], 0);
    assert.deepEqual(plan.example.append, []);
    assert.deepEqual(plan.compose.environment, []);
    assert.equal(plan.scope.complete, false);
  }
  report.pipelinePresence = { adapters: ['standalone', 't3-mapped'], optional: true, incomplete: true, normalExit: 0, strictExit: 1, noRequiredComposeAddition: true };

  stage = 'installed-api';
  const apiProbe = path.join(consumer, 'api-probe.mjs');
  await fs.writeFile(apiProbe, `import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as api from 'envcheck-workbench';
const expected = ['VERSION','scanProject','makePlan','explainVariable','formatReport','compareProjects','formatComparison','formatComparisonMarkdown','compareGit','fixExample','fixCompose'];
assert.deepEqual(Object.keys(api).sort(), expected.sort());
for (const name of expected.filter(name => name !== 'VERSION')) assert.equal(typeof api[name], 'function');
const resolved = fileURLToPath(import.meta.resolve('envcheck-workbench'));
assert.ok(resolved.startsWith(path.join(import.meta.dirname, 'node_modules') + path.sep));
assert.equal(api.VERSION, ${JSON.stringify(packed.version)});
const report = await api.scanProject(process.argv[2], { noValues: true });
assert.equal(report.schemaVersion, 1);
assert.equal(report.summary.errors, 0);
assert.equal(report.scope.valuesChecked, false);
assert.equal(api.explainVariable(report, 'API_KEY').found, true);
assert.deepEqual(api.makePlan(report).example.append, []);
assert.match(api.formatReport(report), /Local values: NOT CHECKED/);
const comparison = await api.compareProjects(process.argv[2], process.argv[3]);
assert.equal(comparison.summary.currentErrors, 0);
assert.match(api.formatComparison(comparison), /comparison/);
assert.match(api.formatComparisonMarkdown(comparison), /## EnvCheck Comparison/);
console.log(JSON.stringify({ resolved, exports: expected, schemaVersion: report.schemaVersion }));
`);
  const api = child(process.execPath, [apiProbe, roots.good, roots.broken], consumer);
  verifyProcess(api, 'public API import');
  report.api = JSON.parse(api.stdout);
  report.stages.push({ stage, exit: 0 });
  report.checkoutIndependent = true;
  report.status = 'passed';
}

try { await main(); }
catch (error) {
  const message = omit(error.message);
  report.status = packageFailureStatus(stage, error);
  report.failure = { stage, code: error.code ?? null, npmCode: error.npmCode ?? null, exit: error.exit ?? null, message };
  process.stderr.write(`${stage}: ${message}\n`);
  process.exitCode = report.status === 'blocked' ? 2 : 1;
} finally {
  report.completedStages = report.stages.length;
  await persistPackageEvidence(report, async () => {
    if (work && process.env.ENVCHECK_PACKAGE_KEEP !== '1') {
      const temporaryBase = await fs.realpath(os.tmpdir());
      const resolved = await fs.realpath(work);
      assert.equal(path.dirname(resolved), temporaryBase, 'Cleanup must stay directly in the temporary directory');
      assert.ok(path.basename(resolved).startsWith('envcheck-package-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      report.temporaryCopyRemoved = true;
    }
  }, async finalReport => {
    await fs.mkdir(path.dirname(evidence), { recursive: true });
    await fs.writeFile(evidence, JSON.stringify(safeEvidence(finalReport), null, 2) + '\n');
  });
  if (report.status !== 'passed') process.exitCode = report.status === 'blocked' ? 2 : 1;
  process.stdout.write(`Package test: ${report.status}; ${report.completedStages} completed stages. Evidence: examples/reports/package-validation.json\n`);
}
