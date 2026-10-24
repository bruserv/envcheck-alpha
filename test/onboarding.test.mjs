import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runOnboarding } from '../scripts/onboarding.mjs';

test('onboarding CLI repairs declarations but keeps missing credentials blocking', async () => {
  const template = new URL('../examples/onboarding/', import.meta.url);
  const files = ['.env.example', 'compose.yaml', 'src/app.mjs', 'envcheck.config.json'];
  const originals = await Promise.all(files.map(file => fs.readFile(new URL(file, template), 'utf8')));
  const steps = await runOnboarding();
  assert.equal(steps.length, 16);
  const structural = steps.find(step => step.label === 'Repaired structural scan');
  assert.equal(structural.exit, 0);
  assert.deepEqual(structural.data.summary, { errors: 0, warnings: 0, info: 0 });
  const comparison = steps.find(step => step.label === 'Compare before and after repairs');
  assert.equal(comparison.exit, 0);
  assert.deepEqual(comparison.data.resolved.map(f => f.rule).sort(), ['COMPOSE_VARIABLE_MISSING', 'UNDOCUMENTED_VARIABLE']);
  assert.equal(comparison.data.scope.after.valuesChecked, false);
  const empty = steps.find(step => step.label === 'Check local files: empty placeholder');
  assert.equal(empty.exit, 1);
  assert.equal(empty.data.variables.find(v => v.name === 'WEBHOOK_SECRET').local.state, 'empty');
  const existing = steps.at(-1);
  assert.equal(existing.exit, 1);
  assert.equal(existing.data.summary.changes, 0);
  assert.equal(existing.data.summary.currentErrors, 2);
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(new URL(file, template), 'utf8'))), originals);
  await assert.rejects(fs.access(new URL('.env', template)), { code: 'ENOENT' });
});
