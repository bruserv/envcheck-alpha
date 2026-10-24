import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
async function compare(before, after, ...options) {
  try {
    const result = await execute(process.execPath, [cli, 'compare', before, after, ...options], { encoding: 'utf8', windowsHide: true });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('CLI compare keeps unchanged target errors blocking in JSON and Markdown', async t => {
  const root = await fixture(t, { '.env.example': '' });
  const json = await compare(root, root, '--json');
  assert.equal(json.code, 1);
  const report = JSON.parse(json.stdout);
  assert.equal(report.summary.changes, 0);
  assert.equal(report.summary.introduced, 0);
  assert.equal(report.summary.currentErrors, 1);
  const markdown = await compare(root, root, '--markdown');
  assert.equal(markdown.code, 1);
  assert.match(markdown.stdout, /Existing issues remain/);
});

test('strict CLI comparison fails when only the older snapshot is incomplete', async t => {
  const before = await fixture(t, { 'src/app.ts': 'const unknown = process.env[dynamicKey];' });
  const after = await fixture(t, { 'src/app.ts': 'export const noop = true;' });
  const result = await compare(before, after, '--strict', '--json');
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.scope.before.complete, false);
  assert.equal(report.scope.after.complete, true);
  assert.equal(report.summary.currentErrors, 0);
  assert.equal(report.summary.currentWarnings, 0);
});

test('strict CLI comparison fails on changed scopes even when both snapshots are clean', async t => {
  const files = { 'src/app.ts': 'export const noop = true;', 'other/app.ts': 'export const noop = true;', '.env.example': '' };
  const before = await fixture(t, { ...files, 'envcheck.config.json': { version: 1, sources: ['src'] } });
  const after = await fixture(t, { ...files, 'envcheck.config.json': { version: 1, sources: ['other'] } });
  const result = await compare(before, after, '--strict', '--markdown');
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Comparison scopes differ/);
});
