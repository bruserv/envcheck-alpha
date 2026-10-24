import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { installSkill } from '../src/skills.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('CLI uses standalone Zod schemas through documentation and Compose repairs', async t => {
  const root = await fixture(t, {
    'src/app.ts': `import { z } from 'zod';
      const schema = z.object({ API_KEY: z.string(), LABEL: z.string().default('private-cli-default') });
      schema.safeParse(process.env);`,
    '.env.example': 'LABEL=\n', '.env': 'LABEL=\n',
    'compose.yaml': 'services:\n  api:\n    image: example\n',
    'envcheck.config.json': { version: 1, compose: { file: 'compose.yaml', service: 'api' } }
  });
  const initial = run(['scan', root, '--no-values', '--json', '--strict']);
  assert.equal(initial.status, 1);
  assert.equal(JSON.parse(initial.stdout).scope.complete, true);
  const example = run(['fix-example', root, '--apply', '--json']);
  assert.equal(example.status, 1);
  assert.deepEqual(JSON.parse(example.stdout).additions, ['API_KEY']);
  const compose = run(['fix-compose', root, '--apply', '--json']);
  assert.equal(compose.status, 0);
  assert.deepEqual(JSON.parse(compose.stdout).additions, ['API_KEY']);
  const structural = run(['scan', root, '--no-values', '--json', '--strict']);
  assert.equal(structural.status, 0);
  const local = run(['scan', root, '--json', '--strict']);
  assert.equal(local.status, 1);
  assert.ok(JSON.parse(local.stdout).findings.some(f => f.rule === 'REQUIRED_VALUE_MISSING' && f.variable === 'API_KEY'));
  for (const output of [initial, example, compose, structural, local]) assert.ok(!output.stdout.includes('private-cli-default'));
});

test('CLI returns documented exit codes and parseable JSON', () => {
  const root = fileURLToPath(new URL('../examples/', import.meta.url));
  for (const [directory, expected] of [['broken', 1], ['fixed', 0]]) {
    const result = run(['scan', path.join(root, directory), '--json']);
    assert.equal(result.status, expected, result.stderr);
    assert.equal(JSON.parse(result.stdout).schemaVersion, 1);
    assert.equal(result.stderr, '');
  }
  const invalid = run(['scan', '--not-a-real-option', '--json']);
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'INPUT_ERROR');
});

test('strict mode makes incomplete source coverage blocking', async t => {
  const root = await fixture(t, { 'src/app.ts': 'const key = process.env[name];' });
  assert.equal(run(['scan', root, '--no-values']).status, 0);
  assert.equal(run(['scan', root, '--no-values', '--strict']).status, 1);
});

test('plan is a preview; it does not modify the example', async t => {
  const root = await fixture(t, { '.env.example': '# Keep this comment\n' });
  const result = run(['plan', root, '--json']);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.applied, false);
  assert.deepEqual(plan.example.append, ['API_KEY=']);
  assert.equal(await fs.readFile(path.join(root, '.env.example'), 'utf8'), '# Keep this comment\n');
});

test('explain shows provenance and missing variables have a nonzero exit', async t => {
  const root = await fixture(t);
  const result = run(['explain', 'API_KEY', root, '--json']);
  const data = JSON.parse(result.stdout);
  assert.equal(data.variable.usages[0].file, 'src/app.ts');
  assert.equal(run(['explain', 'DOES_NOT_EXIST', root, '--json']).status, 1);
});

test('init creates configuration and refuses to overwrite it', async t => {
  const root = await fixture(t);
  assert.equal(run(['init', root]).status, 0);
  const before = await fs.readFile(path.join(root, 'envcheck.config.json'), 'utf8');
  assert.equal(run(['init', root]).status, 2);
  assert.equal(await fs.readFile(path.join(root, 'envcheck.config.json'), 'utf8'), before);
});

test('both skills install idempotently; edited existing skills are preserved', async t => {
  const root = await fixture(t);
  assert.equal((await installSkill(root, 'both')).filesAdded, 4);
  assert.equal((await installSkill(root, 'both')).filesAdded, 0);
  const file = path.join(root, '.claude/skills/envcheck/SKILL.md');
  await fs.writeFile(file, 'User-customized skill');
  await assert.rejects(installSkill(root, 'both'), /differs/);
  assert.equal(await fs.readFile(file, 'utf8'), 'User-customized skill');
});

test('skill preflight prevents partially overwriting a conflicting installation', async t => {
  const root = await fixture(t, { '.claude/skills/envcheck/SKILL.md': 'Existing content' });
  await assert.rejects(installSkill(root, 'both'), /differs/);
  await assert.rejects(fs.access(path.join(root, '.agents/skills/envcheck/SKILL.md')));
});

test('invalid config JSON does not expose parser excerpts', async t => {
  const root = await fixture(t, { 'envcheck.config.json': '{ "secret": SUPER-PRIVATE-MARKER }' });
  const result = run(['scan', root, '--json']);
  assert.equal(result.status, 2);
  assert.ok(!result.stdout.includes('SUPER-PRIVATE-MARKER'));
  assert.ok(!result.stderr.includes('SUPER-PRIVATE-MARKER'));
});

test('CLI comparison is usable and strict blocks a newly required setting', async t => {
  const before = await fixture(t, { 'src/app.ts': 'const x = process.env.API_KEY ?? "default";' });
  const after = await fixture(t);
  const normal = run(['compare', before, after, '--json']);
  assert.equal(normal.status, 0);
  assert.equal(JSON.parse(normal.stdout).changes[0].kind, 'BECAME_REQUIRED');
  assert.equal(run(['compare', before, after, '--strict']).status, 1);
});

test('CLI compare --markdown emits Markdown report and respects exit codes', async t => {
  const before = await fixture(t, { 'src/app.ts': 'const x = process.env.API_KEY ?? "default";' });
  const after = await fixture(t);
  const normal = run(['compare', before, after, '--markdown']);
  assert.equal(normal.status, 0);
  assert.ok(normal.stdout.includes('## EnvCheck Comparison'));
  assert.ok(normal.stdout.includes('`BECAME_REQUIRED`'));
  const strict = run(['compare', before, after, '--markdown', '--strict']);
  assert.equal(strict.status, 1);
  assert.ok(strict.stdout.includes('## EnvCheck Comparison'));
});

test('CLI enforces mutual exclusivity between --json and --markdown with exit code 2', async t => {
  const before = await fixture(t);
  const after = await fixture(t);
  const conflict = run(['compare', before, after, '--json', '--markdown']);
  assert.equal(conflict.status, 2);
  const output = conflict.stdout + conflict.stderr;
  assert.ok(output.includes('--json and --markdown cannot be used together'));

  const invalidCommand = run(['scan', before, '--markdown']);
  assert.equal(invalidCommand.status, 2);
  assert.ok(invalidCommand.stderr.includes('--markdown is only valid with compare'));
});

test('CLI validates --merge-base requires compare and --base', async t => {
  const root = await fixture(t);
  const withoutBase = run(['compare', root, '--merge-base']);
  assert.equal(withoutBase.status, 2);
  assert.ok(withoutBase.stderr.includes('--merge-base requires --base'));

  const wrongCommand = run(['scan', root, '--merge-base']);
  assert.equal(wrongCommand.status, 2);
  assert.ok(wrongCommand.stderr.includes('--base, --head and --merge-base are only valid with compare'));
});

test('CLI --help lists usage, examples and repair apply requirement', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.includes('Examples:'));
  assert.ok(result.stdout.includes('envcheck scan /path/to/app'));
  assert.ok(result.stdout.includes('envcheck compare /path/to/app --base main'));
  assert.ok(result.stdout.includes('envcheck fix-compose /path/to/app'));
  assert.ok(result.stdout.includes('--apply'));
  assert.ok(result.stdout.includes('--markdown'));
  assert.ok(result.stdout.includes('--merge-base'));
});
