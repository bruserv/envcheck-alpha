import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { fixture } from './helpers.mjs';
import { scanProject } from '../src/scan.mjs';
import { explainVariable } from '../src/format.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const marker = 'PRIVATE-USABILITY-SENTINEL';

test('explain text describes evidence and states while its JSON contract is unchanged', async t => {
  const root = await fixture(t, {
    'src/app.ts': `const internal = "${marker}"; process.env.API_KEY;`,
    '.env': `API_KEY=${marker}\n`, '.env.example': `API_KEY=${marker}\n`,
    'compose.yaml': `services:\n  api:\n    environment:\n      API_KEY: ${marker}\n`,
    'envcheck.config.json': { version: 1, compose: { file: 'compose.yaml', service: 'api' }, variables: { API_KEY: { type: 'string' } } }
  });
  const text = run(['explain', 'API_KEY', root]);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /^EnvCheck explanation: API_KEY/);
  assert.match(text.stdout, /Required: yes/);
  assert.match(text.stdout, /Documented: yes/);
  assert.match(text.stdout, /Local value: set/);
  assert.match(text.stdout, /Compose: declared/);
  assert.match(text.stdout, /src\/app.ts:1:/);
  assert.doesNotMatch(text.stdout, /"schemaVersion"/);
  const json = run(['explain', 'API_KEY', root, '--json']);
  assert.equal(json.status, text.status);
  const expected = explainVariable(await scanProject(root), 'API_KEY');
  assert.deepEqual(JSON.parse(json.stdout), expected);
  assert.deepEqual(Object.keys(expected).sort(), ['schemaVersion', 'name', 'found', 'variable', 'findings', 'scope'].sort());
  for (const output of [text, json]) {
    assert.equal(output.stderr, '');
    assert.ok(!output.stdout.includes(marker));
  }
});

test('explain shows example-only diagnoses without redefining found or adding variable JSON', async t => {
  for (const duplicate of [false, true]) {
    const root = await fixture(t, { '.env.example': `API_KEY=\nEXAMPLE_ONLY=${marker}\n${duplicate ? 'EXAMPLE_ONLY=\n' : ''}` });
    const text = run(['explain', 'EXAMPLE_ONLY', root, '--no-values']);
    assert.equal(text.status, 1);
    assert.match(text.stdout, /UNREFERENCED_EXAMPLE_VARIABLE/);
    assert.match(text.stdout, /\.env.example:[23]:1/);
    if (duplicate) assert.match(text.stdout, /DUPLICATE_ENV_KEY/);
    const json = run(['explain', 'EXAMPLE_ONLY', root, '--json', '--no-values']);
    const data = JSON.parse(json.stdout);
    assert.equal(json.status, 1);
    assert.equal(data.found, false);
    assert.equal(Object.hasOwn(data, 'variable'), false);
    assert.deepEqual(data, explainVariable(await scanProject(root, { noValues: true }), 'EXAMPLE_ONLY'));
    assert.ok(data.findings.some(f => f.rule === 'UNREFERENCED_EXAMPLE_VARIABLE'));
    assert.ok(!`${text.stdout}${json.stdout}`.includes(marker));
  }
});

test('explain preserves project-wide and not-found exit semantics for text and JSON', async t => {
  const clean = await fixture(t, { '.env': 'API_KEY=local-only\n' });
  const otherError = await fixture(t, { 'src/app.ts': 'process.env.API_KEY; process.env.OTHER;', '.env': 'API_KEY=local-only\n' });
  const warning = await fixture(t, { 'src/app.ts': 'process.env.API_KEY; process.env[dynamic];', '.env': 'API_KEY=local-only\n' });
  const exampleOnly = await fixture(t, { '.env.example': 'API_KEY=\nEXTRA=\n' });
  const invalid = await fixture(t, { 'envcheck.config.json': '{' });
  for (const json of [[], ['--json']]) for (const [root, name, options, code] of [
    [clean, 'API_KEY', [], 0], [otherError, 'API_KEY', [], 1],
    [warning, 'API_KEY', [], 0], [warning, 'API_KEY', ['--strict'], 1],
    [exampleOnly, 'EXTRA', [], 1], [clean, 'ABSENT', [], 1], [invalid, 'API_KEY', [], 2]
  ]) assert.equal(run(['explain', name, root, ...options, ...json]).status, code);
});

test('explain distinguishes unknown requirements, incomplete coverage and not-checked states', async t => {
  const root = await fixture(t, {
    '.env.example': 'API_KEY=\nENABLED=\n',
    'envcheck.config.json': { version: 1, variables: { API_KEY: { when: { variable: 'ENABLED', equals: marker } } } }
  });
  const result = run(['explain', 'API_KEY', root, '--no-values']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Required: unknown/);
  assert.match(result.stdout, /Local value: NOT CHECKED/);
  assert.match(result.stdout, /Compose: NOT CHECKED/);
  assert.match(result.stdout, /CONDITION_UNRESOLVED/);
  assert.match(result.stdout, /INCOMPLETE/);
  assert.ok(!result.stdout.includes(marker));
});

test('Compose preview uses actual map/list syntax, discloses formatting and preserves other entries', async t => {
  for (const [format, kind] of [['yaml', 'map'], ['yaml', 'list'], ['json', 'map'], ['json', 'list'], ['yaml', 'new-map']]) {
    const file = `compose.${format}`;
    const env = kind === 'list' ? [`OTHER=${marker}`] : { OTHER: marker };
    const data = { services: { api: { ...(kind === 'new-map' ? {} : { environment: env }), image: 'fixture' }, worker: { environment: { WORKER_ONLY: marker } } } };
    const original = format === 'json' ? JSON.stringify(data, null, 2) + '\n' :
      `# keep\nservices:\n  api:\n    image: fixture\n${kind === 'new-map' ? '' : kind === 'list' ? `    environment:\n      - OTHER=${marker}\n` : `    environment:\n      OTHER: ${marker}\n`}  worker:\n    environment:\n      WORKER_ONLY: ${marker}\n`;
    const root = await fixture(t, { [file]: original, 'envcheck.config.json': { version: 1, compose: { file, service: 'api' } } });
    const result = run(['fix-compose', root]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /not a full diff/);
    assert.match(result.stdout, /formatting/);
    const expected = format === 'json' ? kind === 'list' ? '"API_KEY=${API_KEY:?Set API_KEY locally}"' : '"API_KEY": "${API_KEY:?Set API_KEY locally}"' :
      kind === 'list' ? '- API_KEY=${API_KEY:?Set API_KEY locally}' : 'API_KEY: ${API_KEY:?Set API_KEY locally}';
    assert.ok(result.stdout.includes(expected), result.stdout);
    assert.ok(!result.stdout.includes(marker));
    assert.equal(await fs.readFile(path.join(root, file), 'utf8'), original);
    const json = JSON.parse(run(['fix-compose', root, '--json']).stdout);
    assert.deepEqual(json.declarations, ['API_KEY=${API_KEY:?Set API_KEY locally}']);
    assert.equal(json.preview.kind, kind === 'list' ? 'list' : 'map');
    assert.equal(json.preview.completeDiff, false);
    const fragment = json.preview.lines.join('\n');
    const proposed = format === 'json' ? JSON.parse('{' + fragment + '}').environment : parse(fragment).environment;
    const applied = run(['fix-compose', root, '--apply', '--json']);
    assert.equal(applied.status, 0);
    const actual = parse(await fs.readFile(path.join(root, file), 'utf8'));
    const actualEnv = actual.services.api.environment;
    assert.equal(Array.isArray(actualEnv), Array.isArray(proposed));
    if (Array.isArray(proposed)) for (const item of proposed) assert.ok(actualEnv.includes(item));
    else for (const [key, value] of Object.entries(proposed)) assert.equal(actualEnv[key], value);
    if (kind !== 'new-map') assert.equal(Array.isArray(actualEnv) ? actualEnv.includes(`OTHER=${marker}`) : actualEnv.OTHER === marker, true);
    assert.deepEqual(actual.services.worker, data.services.worker);
    assert.equal(JSON.parse(run(['fix-compose', root, '--apply', '--json']).stdout).changed, false);
  }
});
