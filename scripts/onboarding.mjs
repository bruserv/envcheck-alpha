import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const template = fileURLToPath(new URL('../examples/onboarding/', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

// Exercise the real CLI on a disposable copy. The fixture and user settings are
// never repair targets, and no scanned application code or containers are run.
export async function runOnboarding() {
  const temporaryBase = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryBase, 'envcheck-onboarding-'));
  // Hidden from source traversal, with its own configuration and original inputs.
  const baseline = path.join(root, '.before');
  const steps = [];
  const step = (label, command, expectedExit) => {
    const result = spawnSync(process.execPath, [cli, ...command, '--json'], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined, `${label}: CLI must finish`);
    assert.equal(result.status, expectedExit, `${label}: expected exit ${expectedExit}`);
    assert.equal(result.stderr, '', `${label}: unexpected stderr`);
    const data = JSON.parse(result.stdout);
    steps.push({ label, exit: result.status, data });
    return data;
  };
  const read = name => fs.readFile(path.join(root, name), 'utf8');
  try {
    await fs.cp(template, root, { recursive: true });
    await fs.cp(template, baseline, { recursive: true });
    const originalExample = await read('.env.example');
    const originalCompose = await read('compose.yaml');
    const originalSource = await read('src/app.mjs');
    const broken = step('Initial structural scan', ['scan', root, '--no-values', '--strict'], 1);
    assert.equal(broken.scope.complete, true);
    assert.equal(broken.scope.valuesChecked, false);
    assert.equal(broken.variables.find(v => v.name === 'APP_LABEL').required, false);
    assert.deepEqual(broken.findings.map(f => f.rule).sort(), ['COMPOSE_VARIABLE_MISSING', 'UNDOCUMENTED_VARIABLE']);

    const explanation = step('Explain WEBHOOK_SECRET', ['explain', 'WEBHOOK_SECRET', root, '--no-values'], 1);
    assert.equal(explanation.found, true);
    assert.equal(explanation.variable.required, true);
    assert.equal(explanation.variable.compose.state, 'missing');
    const plan = step('Plan repairs', ['plan', root, '--no-values'], 1);
    assert.deepEqual(plan.example.append, ['WEBHOOK_SECRET=']);
    assert.equal(plan.compose.service, 'api');
    assert.deepEqual(plan.compose.environment, ['WEBHOOK_SECRET: ${WEBHOOK_SECRET:?Set WEBHOOK_SECRET locally}']);
    step('Preview example repair', ['fix-example', root], 1);
    step('Preview Compose repair', ['fix-compose', root], 1);
    assert.equal(await read('.env.example'), originalExample);
    assert.equal(await read('compose.yaml'), originalCompose);

    const example = step('Apply example repair', ['fix-example', root, '--apply'], 1);
    assert.deepEqual(example.additions, ['WEBHOOK_SECRET']);
    const compose = step('Apply Compose repair', ['fix-compose', root, '--apply'], 0);
    assert.deepEqual(compose.additions, ['WEBHOOK_SECRET']);
    const repaired = step('Repaired structural scan', ['scan', root, '--no-values', '--strict'], 0);
    assert.equal(repaired.scope.complete, true);
    assert.equal(repaired.scope.valuesChecked, false);
    assert.equal(repaired.variables.find(v => v.name === 'WEBHOOK_SECRET').local.state, 'not-checked');
    assert.equal(await read('.env.example'), originalExample + 'WEBHOOK_SECRET=\n');
    assert.ok((await read('compose.yaml')).includes('WEBHOOK_SECRET: ${WEBHOOK_SECRET:?Set WEBHOOK_SECRET locally}'));
    assert.ok((await read('compose.yaml')).includes('# Keep this existing declaration during repair.'));
    assert.equal(await read('src/app.mjs'), originalSource);
    const comparison = step('Compare before and after repairs', ['compare', baseline, root, '--strict'], 0);
    assert.equal(comparison.scope.complete, true);
    assert.equal(comparison.scope.before.valuesChecked, false);
    assert.equal(comparison.scope.after.valuesChecked, false);
    assert.deepEqual(comparison.changes, []);
    assert.deepEqual(comparison.introduced, []);
    assert.deepEqual(comparison.resolved.map(f => f.rule).sort(), ['COMPOSE_VARIABLE_MISSING', 'UNDOCUMENTED_VARIABLE']);
    assert.equal(comparison.summary.currentErrors, 0);
    // Idempotent repairs must not keep changing a project on repeated runs.
    assert.equal(step('Repeat example repair', ['fix-example', root, '--apply'], 0).changed, false);
    assert.equal(step('Repeat Compose repair', ['fix-compose', root, '--apply'], 0).changed, false);
    const unchanged = step('Compare repaired project with itself', ['compare', root, root, '--strict'], 0);
    assert.deepEqual(unchanged.summary, { changes: 0, introduced: 0, resolved: 0, currentErrors: 0, currentWarnings: 0, blockingChanges: 0 });

    // A real non-secret port enables file checks; no substitute credential is supplied.
    await fs.writeFile(path.join(root, '.env'), 'PORT=3000\n');
    const missing = step('Check local files: missing secret', ['scan', root, '--strict'], 1);
    assert.equal(missing.scope.valuesChecked, true);
    assert.equal(missing.variables.find(v => v.name === 'WEBHOOK_SECRET').local.state, 'missing');
    assert.ok(missing.findings.some(f => f.rule === 'REQUIRED_VALUE_MISSING' && f.variable === 'WEBHOOK_SECRET'));

    await fs.appendFile(path.join(root, '.env'), 'WEBHOOK_SECRET=\n');
    const empty = step('Check local files: empty placeholder', ['scan', root, '--strict'], 1);
    assert.equal(empty.variables.find(v => v.name === 'WEBHOOK_SECRET').local.state, 'empty');
    assert.ok(empty.findings.some(f => f.rule === 'REQUIRED_VALUE_MISSING' && f.variable === 'WEBHOOK_SECRET'));
    assert.equal(await read('.env'), 'PORT=3000\nWEBHOOK_SECRET=\n');
    // Structural comparison must neither read local credentials nor treat an
    // unchanged structural error as fixed just because the diff is empty.
    const structural = step('Compare without checking local credentials', ['compare', baseline, root, '--strict'], 0);
    assert.equal(structural.scope.after.valuesChecked, false);
    const existing = step('Compare unchanged broken project', ['compare', baseline, baseline, '--strict'], 1);
    assert.equal(existing.summary.changes, 0);
    assert.equal(existing.summary.introduced, 0);
    assert.equal(existing.summary.resolved, 0);
    assert.equal(existing.summary.currentErrors, 2);
    return steps;
  } finally {
    // Resolve and check the absolute target before recursive cleanup on Windows.
    const resolved = await fs.realpath(root);
    assert.equal(path.dirname(resolved), temporaryBase, 'Cleanup must stay in the temporary directory');
    assert.ok(path.basename(resolved).startsWith('envcheck-onboarding-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const steps = await runOnboarding();
    for (const { label, exit, data } of steps) {
      const report = data.report ?? data;
      const summary = report.summary;
      console.log(`${label}: exit ${exit}${summary ? `; ${summary.errors ?? summary.currentErrors} error(s), ${summary.warnings ?? summary.currentWarnings} warning(s)` : ''}`);
    }
    console.log('\nStructural repairs passed. Missing and empty secrets still fail local checks.');
    console.log('Supply a real WEBHOOK_SECRET through your own local/deployment configuration.');
    console.log('Credentials, service connectivity and application startup were not validated.');
    console.log('The temporary copy was removed; the original example was preserved.');
  } catch {
    console.error('Onboarding verification failed. Run node --test test/onboarding.test.mjs for diagnostics.');
    process.exitCode = 1;
  }
}
