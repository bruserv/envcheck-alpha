import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { fixCompose, fixExample } from '../src/fix.mjs';

test('example repair defaults to preview without changing files', async t => {
  const root = await fixture(t, { '.env.example': '# Existing comment\n' });
  const result = await fixExample(root);
  assert.equal(result.applied, false);
  assert.deepEqual(result.additions, ['API_KEY']);
  assert.equal(await fs.readFile(path.join(root, '.env.example'), 'utf8'), '# Existing comment\n');
});

test('apply preserves existing content, CRLF and absence of final newline', async t => {
  const original = '# Preserve this comment\r\nEXISTING=example-value';
  const root = await fixture(t, { '.env.example': original });
  const result = await fixExample(root, { apply: true });
  assert.equal(result.applied, true);
  assert.equal(await fs.readFile(path.join(root, '.env.example'), 'utf8'), original + '\r\nAPI_KEY=\r\n');
  assert.equal(result.report.summary.errors, 0);
  const second = await fixExample(root, { apply: true });
  assert.equal(second.changed, false);
  assert.equal(second.additions.length, 0);
});

test('example repair keeps unterminated quoted values intact without swallowing or repeating placeholders', async t => {
  for (const quote of ['"', "'", '`']) {
    const original = `BROKEN=${quote}unterminated`;
    const root = await fixture(t, { '.env.example': original });
    const result = await fixExample(root, { apply: true });
    assert.equal(result.report.variables[0].documented, true);
    const updated = await fs.readFile(path.join(root, '.env.example'), 'utf8');
    assert.equal(updated, original + '\nAPI_KEY=\n');
    assert.equal((await fixExample(root, { apply: true })).changed, false);
    assert.equal(await fs.readFile(path.join(root, '.env.example'), 'utf8'), updated);
  }
});

test('repair can create a missing example, but never a credential file', async t => {
  const root = await fixture(t, { '.env.example': null });
  assert.equal((await fixExample(root, { apply: true })).report.summary.errors, 0);
  const other = await fixture(t, { 'envcheck.config.json': { version: 1, example: '.env' }, '.env': 'ORIGINAL=REAL-PRIVATE-SENTINEL\n' });
  await assert.rejects(fixExample(other, { apply: true }), /credential files/);
  assert.equal(await fs.readFile(path.join(other, '.env'), 'utf8'), 'ORIGINAL=REAL-PRIVATE-SENTINEL\n');
});

test('applying documentation repairs does not silence remaining Compose errors', async t => {
  const root = await fixture(t, {
    '.env.example': '', 'compose.yaml': 'services:\n  api:\n    image: app\n',
    'envcheck.config.json': { version: 1, compose: { file: 'compose.yaml', service: 'api' } }
  });
  const result = await fixExample(root, { apply: true });
  assert.equal(result.report.summary.errors, 1);
  assert.equal(result.report.findings.filter(f => f.severity === 'error')[0].rule, 'COMPOSE_VARIABLE_MISSING');
});

test('existing example values and local credentials are omitted from repair reports', async t => {
  const root = await fixture(t, { '.env.example': 'OLD=EXAMPLE-PRIVATE-SENTINEL\n', '.env': 'API_KEY=LOCAL-PRIVATE-SENTINEL\n' });
  const result = await fixExample(root, { apply: true });
  assert.ok(!JSON.stringify(result).includes('PRIVATE-SENTINEL'));
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'API_KEY=LOCAL-PRIVATE-SENTINEL\n');
});

test('CLI requires --apply for writes and retains remaining findings exit code', async t => {
  const root = await fixture(t, { '.env.example': '' });
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const preview = spawnSync(process.execPath, [cli, 'fix-example', root, '--json'], { encoding: 'utf8' });
  assert.equal(preview.status, 1);
  assert.equal(JSON.parse(preview.stdout).applied, false);
  const apply = spawnSync(process.execPath, [cli, 'fix-example', root, '--apply', '--json'], { encoding: 'utf8' });
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(JSON.parse(apply.stdout).applied, true);
});

test('Compose repair previews and applies map, sequence and missing-environment declarations while preserving comments and CRLF', async t => {
  const mapYaml = '# Top comment\r\nservices:\r\n  api:\r\n    image: node:22-alpine # inline\r\n    environment:\r\n      PORT: "3000"\r\n  # worker stays untouched\r\n  worker:\r\n    image: worker\r\n';
  const root = await fixture(t, {
    'compose.yaml': mapYaml,
    'envcheck.config.json': { version: 1, compose: { file: 'compose.yaml', service: 'api' } }
  });
  const preview = await fixCompose(root);
  assert.equal(preview.applied, false);
  assert.deepEqual(preview.additions, ['API_KEY']);
  assert.equal(await fs.readFile(path.join(root, 'compose.yaml'), 'utf8'), mapYaml);

  const applied = await fixCompose(root, { apply: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.changed, true);
  assert.equal(applied.report.summary.errors, 0);
  const updated = await fs.readFile(path.join(root, 'compose.yaml'), 'utf8');
  assert.ok(updated.includes('# Top comment\r\n'));
  assert.ok(updated.includes('# worker stays untouched\r\n'));
  assert.ok(updated.includes('API_KEY: ${API_KEY:?Set API_KEY locally}\r\n'));

  const idempotent = await fixCompose(root, { apply: true });
  assert.equal(idempotent.changed, false);
  assert.equal(idempotent.additions.length, 0);

  const seqRoot = await fixture(t, {
    'compose.yaml': 'services:\n  api:\n    image: node:22\n    environment:\n      - PORT=3000\n',
    'envcheck.config.json': { version: 1, compose: { file: 'compose.yaml', service: 'api' } }
  });
  assert.equal((await fixCompose(seqRoot, { apply: true })).report.summary.errors, 0);
  assert.ok((await fs.readFile(path.join(seqRoot, 'compose.yaml'), 'utf8')).includes('- API_KEY=${API_KEY:?Set API_KEY locally}\n'));

  const noEnvRoot = await fixture(t, {
    'compose.yaml': 'services:\n  api:\n    image: node:22\n',
    'envcheck.config.json': { version: 1, compose: { file: 'compose.yaml', service: 'api' } }
  });
  assert.equal((await fixCompose(noEnvRoot, { apply: true })).report.summary.errors, 0);
});

test('Compose repair refuses aliased or merged environments and non-Compose targets, and never leaks values', async t => {
  const aliased = await fixture(t, {
    'compose.yaml': 'x-env: &shared\n  PORT: "3000"\nservices:\n  api:\n    environment: *shared\n',
    'envcheck.config.json': { version: 1, compose: { file: 'compose.yaml', service: 'api' } }
  });
  await assert.rejects(fixCompose(aliased, { apply: true }), /aliased/);

  const merged = await fixture(t, {
    'compose.yaml': 'x-base: &base\n  environment:\n    PORT: "3000"\nservices:\n  api:\n    <<: *base\n    image: app\n',
    'envcheck.config.json': { version: 1, compose: { file: 'compose.yaml', service: 'api' } }
  });
  await assert.rejects(fixCompose(merged, { apply: true }), /merge keys/);

  const badTarget = await fixture(t, {
    '.env': 'API_KEY=SECRET-SENTINEL\n',
    'envcheck.config.json': { version: 1, compose: { file: '.env', service: 'api' } }
  });
  await assert.rejects(fixCompose(badTarget, { apply: true }), /\.yaml, \.yml or \.json/);

  const secretRoot = await fixture(t, {
    '.env': 'API_KEY=LOCAL-COMPOSE-SECRET\n',
    'compose.yaml': 'services:\n  api:\n    environment:\n      OTHER: COMPOSE-INLINE-SECRET\n',
    'envcheck.config.json': { version: 1, compose: { file: 'compose.yaml', service: 'api' } }
  });
  const result = await fixCompose(secretRoot, { apply: true });
  assert.ok(!JSON.stringify(result).includes('LOCAL-COMPOSE-SECRET'));
  assert.ok(!JSON.stringify(result).includes('COMPOSE-INLINE-SECRET'));
});

test('CLI fix-compose previews, applies and retains remaining undocumented errors until fix-example runs', async t => {
  const root = await fixture(t, {
    '.env.example': '',
    'compose.yaml': 'services:\n  api:\n    image: node:22\n',
    'envcheck.config.json': { version: 1, compose: { file: 'compose.yaml', service: 'api' } }
  });
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const preview = spawnSync(process.execPath, [cli, 'fix-compose', root, '--json'], { encoding: 'utf8' });
  assert.equal(preview.status, 1);
  assert.equal(JSON.parse(preview.stdout).applied, false);

  const composeApplied = spawnSync(process.execPath, [cli, 'fix-compose', root, '--apply', '--json'], { encoding: 'utf8' });
  assert.equal(composeApplied.status, 1);
  assert.equal(JSON.parse(composeApplied.stdout).applied, true);
  assert.equal(JSON.parse(composeApplied.stdout).report.findings[0].rule, 'UNDOCUMENTED_VARIABLE');

  const exampleApplied = spawnSync(process.execPath, [cli, 'fix-example', root, '--apply', '--json'], { encoding: 'utf8' });
  assert.equal(exampleApplied.status, 0, exampleApplied.stderr);
});
