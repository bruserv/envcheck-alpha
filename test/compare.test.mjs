import test from 'node:test';
import assert from 'node:assert/strict';
import { compareProjects, formatComparison, formatComparisonMarkdown } from '../src/compare.mjs';
import { fixture } from './helpers.mjs';

test('comparison catches standalone Zod default removal without disclosing its value', async t => {
  const before = await fixture(t, {
    'src/app.ts': `import { z } from 'zod';
      const schema = z.object({ API_KEY: z.string().default('private-comparison-default') });
      schema.parse(process.env);`
  });
  const after = await fixture(t, {
    'src/app.ts': `import { z } from 'zod';
      const schema = z.object({ API_KEY: z.string() }); schema.parse(process.env);`
  });
  const report = await compareProjects(before, after);
  assert.equal(report.scope.complete, true);
  assert.deepEqual(report.changes.map(c => [c.kind, c.variable]), [['BECAME_REQUIRED', 'API_KEY']]);
  assert.ok(!JSON.stringify(report).includes('private-comparison-default'));
  assert.ok(!formatComparisonMarkdown(report).includes('private-comparison-default'));
});

test('comparison identifies resolved documentation and Compose findings', async () => {
  const report = await compareProjects(new URL('../examples/broken', import.meta.url), new URL('../examples/fixed', import.meta.url));
  assert.equal(report.summary.currentErrors, 0);
  assert.deepEqual(report.resolved.map(f => f.rule).sort(), ['COMPOSE_VARIABLE_MISSING', 'UNDOCUMENTED_VARIABLE']);
  assert.equal(report.scope.after.valuesChecked, false);
});

test('comparison catches an optional setting becoming required and type changes', async t => {
  const before = await fixture(t, { 'src/app.ts': 'const key = process.env.API_KEY ?? "fallback";', 'envcheck.config.json': { version: 1, variables: { API_KEY: { type: 'string' } } } });
  const after = await fixture(t, { 'envcheck.config.json': { version: 1, variables: { API_KEY: { type: 'url' } } } });
  const report = await compareProjects(before, after);
  assert.deepEqual(report.changes.map(c => c.kind).sort(), ['BECAME_REQUIRED', 'TYPE_RULE_CHANGED']);
});

test('formatComparisonMarkdown formats contract changes, newly required variables, status and summary', async t => {
  const before = await fixture(t, { 'src/app.ts': 'const key = process.env.API_KEY ?? "fallback";', 'envcheck.config.json': { version: 1, variables: { API_KEY: { type: 'string' } } } });
  const after = await fixture(t, { 'envcheck.config.json': { version: 1, variables: { API_KEY: { type: 'url' } } } });
  const report = await compareProjects(before, after);
  const markdown = formatComparisonMarkdown(report);
  assert.ok(markdown.includes('## EnvCheck Comparison'));
  assert.ok(markdown.includes('### Contract Changes'));
  assert.ok(markdown.includes('`API_KEY`'));
  assert.ok(markdown.includes('`BECAME_REQUIRED`'));
  assert.ok(markdown.includes('`TYPE_RULE_CHANGED`'));
  assert.ok(markdown.includes('**Current Status:**'));
  assert.ok(markdown.includes('**Summary:** 2 contract change(s)'));
});

test('Markdown comparison explicitly notes when there are no changes while reporting existing issues', async () => {
  const report = await compareProjects(new URL('../examples/broken', import.meta.url), new URL('../examples/broken', import.meta.url));
  const markdown = formatComparisonMarkdown(report);
  assert.ok(markdown.includes('No configuration changes detected between the compared versions.'));
  assert.ok(markdown.includes('**Current Status:** 2 error(s)'));
  assert.ok(markdown.includes('Existing issues remain in the target snapshot.'));
});

test('Markdown comparison flags incomplete analysis scope', async t => {
  const before = await fixture(t, { 'src/app.ts': 'const key = process.env[dynamicKey];' });
  const after = await fixture(t, { 'src/app.ts': 'const key = process.env[dynamicKey];' });
  const report = await compareProjects(before, after);
  assert.equal(report.scope.complete, false);
  const markdown = formatComparisonMarkdown(report);
  assert.ok(markdown.includes('> **INCOMPLETE:** One or both snapshots contain unsupported input.'));
});

test('Markdown comparison never reveals secret values or source code', async t => {
  const before = await fixture(t, { '.env': 'API_KEY=LOCAL-SECRET-BEFORE' });
  const after = await fixture(t, { '.env': 'API_KEY=LOCAL-SECRET-AFTER' });
  const report = await compareProjects(before, after);
  const markdown = formatComparisonMarkdown(report);
  assert.ok(!markdown.includes('LOCAL-SECRET-BEFORE'));
  assert.ok(!markdown.includes('LOCAL-SECRET-AFTER'));
});

test('Markdown escaping sanitizes special markdown characters in variable names and paths', () => {
  const syntheticReport = {
    schemaVersion: 1,
    comparison: 'structural-project-snapshots',
    scope: { complete: true },
    summary: { changes: 1, introduced: 1, resolved: 0, currentErrors: 0, currentWarnings: 0, blockingChanges: 0 },
    changes: [{
      kind: 'ADDED_VARIABLE',
      variable: 'SPECIAL_`VAR`_<TEST>',
      severity: 'info',
      message: 'Notice with *asterisks* and [brackets] & <tags>'
    }],
    introduced: [{
      rule: 'SYNTAX_ERROR',
      variable: 'INJECT_`KEY`',
      severity: 'error',
      locations: [{ file: 'src/file with `ticks` and <tag>.ts', line: 10 }]
    }],
    resolved: []
  };
  const markdown = formatComparisonMarkdown(syntheticReport);
  assert.ok(markdown.includes('`SPECIAL_\'VAR\'_<TEST>`'));
  assert.ok(markdown.includes('\\*asterisks\\*'));
  assert.ok(markdown.includes('\\[brackets\\]'));
  assert.ok(markdown.includes('\\<tags\\>'));
  assert.ok(markdown.includes('`src/file with \'ticks\' and <tag>.ts:10`'));
});

test('comparison never reads selected local environment values', async t => {
  const before = await fixture(t, { '.env': 'API_KEY=BEFORE-PRIVATE-MARKER' });
  const after = await fixture(t, { '.env': 'API_KEY=AFTER-PRIVATE-MARKER' });
  const report = await compareProjects(before, after);
  assert.equal(report.scope.before.valuesChecked, false);
  assert.equal(report.scope.after.valuesChecked, false);
  assert.ok(!JSON.stringify(report).includes('PRIVATE-MARKER'));
});

test('condition policy changes are reported without exposing comparison values', async t => {
  const first = { version: 1, variables: { API_KEY: { when: { variable: 'ENABLED', equals: 'POLICY-VALUE-ONE' } } } };
  const second = { version: 1, variables: { API_KEY: { when: { variable: 'ENABLED', equals: 'POLICY-VALUE-TWO' } } } };
  const before = await fixture(t, { 'envcheck.config.json': first });
  const after = await fixture(t, { 'envcheck.config.json': second });
  const report = await compareProjects(before, after);
  assert.ok(report.changes.some(c => c.kind === 'CONDITION_CHANGED'));
  assert.ok(!JSON.stringify(report).includes('POLICY-VALUE'));
});

test('reordering condition JSON fields is not a policy change', async t => {
  const before = await fixture(t, { 'envcheck.config.json': { version: 1, variables: { API_KEY: { when: { variable: 'ENABLED', equals: 'true' } } } } });
  const after = await fixture(t, { 'envcheck.config.json': { version: 1, variables: { API_KEY: { when: { equals: 'true', variable: 'ENABLED' } } } } });
  const result = await compareProjects(before, after);
  assert.ok(!result.changes.some(c => c.kind === 'CONDITION_CHANGED'));
});

test('comparison counts additional and resolved unknown reads in the same file', async t => {
  const before = await fixture(t, { 'src/app.ts': 'const a = process.env[firstKey];' });
  const after = await fixture(t, { 'src/app.ts': 'const a = process.env[firstKey];\nconst b = process.env[secondKey];' });
  const added = await compareProjects(before, after);
  assert.equal(added.scope.complete, false);
  assert.equal(added.summary.introduced, 1);
  assert.equal(added.introduced[0].rule, 'UNRESOLVED_ENV_ACCESS');
  assert.equal(added.introduced[0].locations[0].line, 2);
  const removed = await compareProjects(after, before);
  assert.equal(removed.summary.resolved, 1);
  assert.equal(removed.resolved[0].rule, 'UNRESOLVED_ENV_ACCESS');
});

test('moving an unchanged finding to a later line is not an introduced or resolved issue', async t => {
  const before = await fixture(t, { 'src/app.ts': 'const key = process.env.UNDOCUMENTED;' });
  const after = await fixture(t, { 'src/app.ts': '// New comment\n\nconst key = process.env.UNDOCUMENTED;' });
  const report = await compareProjects(before, after);
  assert.equal(report.summary.introduced, 0);
  assert.equal(report.summary.resolved, 0);
  assert.equal(report.summary.currentErrors, 1);
});

test('Markdown sanitizes the Git application path as inline code', () => {
  const report = {
    scope: { complete: true },
    summary: { changes: 0, introduced: 0, resolved: 0, currentErrors: 0, currentWarnings: 0 },
    changes: [], introduced: [], resolved: [],
    git: { baseCommit: 'a'.repeat(40), app: 'apps/`api`\n### forged section' }
  };
  const markdown = formatComparisonMarkdown(report);
  assert.ok(markdown.includes("(app: `apps/'api' ### forged section`)"));
  assert.ok(!markdown.includes('\n### forged section'));
});

test('narrowing a complete source scope cannot appear as a complete comparison', async t => {
  const files = {
    'apps/api/app.ts': 'export const key = process.env.API_KEY;',
    'apps/worker/app.ts': 'export const key = process.env.WORKER_KEY;'
  };
  const before = await fixture(t, { ...files, 'envcheck.config.json': { version: 1, sources: ['apps/api', 'apps/worker'] } });
  const after = await fixture(t, { ...files, 'envcheck.config.json': { version: 1, sources: ['apps/api'] } });
  const report = await compareProjects(before, after);
  assert.equal(report.scope.before.complete, true);
  assert.equal(report.scope.after.complete, true);
  assert.equal(report.scope.comparable, false);
  assert.equal(report.scope.complete, false);
  assert.ok(report.changes.some(c => c.kind === 'REMOVED_VARIABLE' && c.variable === 'WORKER_KEY'));
  assert.match(formatComparison(report), /comparison scopes differ/);
  assert.match(formatComparisonMarkdown(report), /Comparison scopes differ/);
  assert.ok(!formatComparisonMarkdown(report).includes('(clean)'));
});

test('equivalent source paths, duplicates and order retain comparable scope', async t => {
  const extra = { 'other/app.ts': 'export const unused = true;' };
  const before = await fixture(t, { ...extra, 'envcheck.config.json': { version: 1, sources: ['src/.', './src', 'src/', 'other', 'src'] } });
  const after = await fixture(t, { ...extra, 'envcheck.config.json': { version: 1, sources: ['other', 'src'] } });
  const report = await compareProjects(before, after);
  assert.equal(report.scope.comparable, true);
  assert.equal(report.scope.complete, true);
  assert.equal(report.summary.changes, 0);
});

test('changing the selected Compose service is an explicit comparison scope change', async t => {
  const compose = 'services:\n  api:\n    environment:\n      API_KEY: ${API_KEY}\n  worker:\n    environment:\n      API_KEY: ${API_KEY}\n';
  const before = await fixture(t, { 'compose.yaml': compose, 'envcheck.config.json': { version: 1, compose: { file: 'compose.yaml', service: 'api' } } });
  const after = await fixture(t, { 'compose.yaml': compose, 'envcheck.config.json': { version: 1, compose: { file: './compose.yaml', service: 'worker' } } });
  const report = await compareProjects(before, after);
  assert.equal(report.scope.before.complete, true);
  assert.equal(report.scope.after.complete, true);
  assert.equal(report.scope.comparable, false);
  assert.equal(report.scope.complete, false);
});

test('variable-level findings stay stable across added reads in earlier files and file renames while occurrence findings remain per-file', async t => {
  const config = {
    version: 1,
    sources: ['src'],
    compose: { file: 'compose.yaml', service: 'api' },
    variables: { COND_KEY: { when: { variable: 'FLAG', equals: 'true' } } }
  };
  const compose = 'services:\n  api:\n    image: app\n';
  const before = await fixture(t, {
    'src/app.ts': null,
    'src/z.ts': 'export const k = process.env.LEGACY_KEY;\nexport const c = process.env.COND_KEY;\nexport const d = process.env[dynZ];',
    '.env.example': 'COND_KEY=\nFLAG=\n',
    'compose.yaml': compose,
    'envcheck.config.json': config
  });
  const afterAddedRead = await fixture(t, {
    'src/app.ts': null,
    'src/a.ts': 'export const k = process.env.LEGACY_KEY;\nexport const c = process.env.COND_KEY;\nexport const d = process.env[dynA];',
    'src/z.ts': 'export const k = process.env.LEGACY_KEY;\nexport const c = process.env.COND_KEY;\nexport const d = process.env[dynZ];',
    '.env.example': 'COND_KEY=\nFLAG=\n',
    'compose.yaml': compose,
    'envcheck.config.json': config
  });
  const addedReport = await compareProjects(before, afterAddedRead);
  assert.deepEqual(addedReport.changes, []);
  assert.deepEqual(addedReport.introduced.map(f => [f.rule, f.locations[0]?.file]), [
    ['UNRESOLVED_ENV_ACCESS', 'src/a.ts']
  ]);
  assert.deepEqual(addedReport.resolved, []);

  const afterRenamed = await fixture(t, {
    'src/app.ts': null,
    'src/a.ts': 'export const k = process.env.LEGACY_KEY;\nexport const c = process.env.COND_KEY;',
    '.env.example': 'COND_KEY=\nFLAG=\n',
    'compose.yaml': compose,
    'envcheck.config.json': config
  });
  const beforeSingle = await fixture(t, {
    'src/app.ts': null,
    'src/z.ts': 'export const k = process.env.LEGACY_KEY;\nexport const c = process.env.COND_KEY;',
    '.env.example': 'COND_KEY=\nFLAG=\n',
    'compose.yaml': compose,
    'envcheck.config.json': config
  });
  const renamedReport = await compareProjects(beforeSingle, afterRenamed);
  assert.deepEqual(renamedReport.changes, []);
  assert.deepEqual(renamedReport.introduced, []);
  assert.deepEqual(renamedReport.resolved, []);
});
