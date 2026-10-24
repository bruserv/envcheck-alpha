import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fixture } from './helpers.mjs';
import { compareGit } from '../src/git.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
async function git(root, ...args) {
  const { stdout } = await execute('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  return stdout.trim();
}
async function commit(root) {
  await git(root, 'add', '--', '.');
  await git(root, '-c', 'user.name=EnvCheck fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'Synthetic test fixture');
  return git(root, 'rev-parse', 'HEAD');
}
async function repository(t, files = {}) {
  const root = await fixture(t, { '.gitignore': '.env\n', ...files });
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.name', 'EnvCheck fixture');
  await git(root, 'config', 'user.email', 'fixture@example.invalid');
  await git(root, 'config', 'commit.gpgsign', 'false');
  // Hooks are only synthetic fixture data, never user's repository settings.
  const hooks = path.join(root, '.test-hooks');
  await fs.mkdir(hooks);
  await git(root, 'config', 'core.hooksPath', hooks);
  return { root, base: await commit(root), tempDir: path.dirname(root) };
}

test('Git comparison catches dirty working-tree contract changes without checking out', async t => {
  const { root, base, tempDir } = await repository(t, { 'src/app.ts': 'const key = process.env.API_KEY ?? "fallback";' });
  await fs.writeFile(path.join(root, 'src/app.ts'), 'const key = process.env.API_KEY;\n');
  const original = await fs.readFile(path.join(root, 'src/app.ts'), 'utf8');
  const result = await compareGit(root, { base, tempDir });
  assert.equal(result.git.baseCommit, base);
  assert.equal(result.git.target, 'working-tree');
  assert.ok(result.changes.some(c => c.kind === 'BECAME_REQUIRED'));
  assert.equal(await git(root, 'rev-parse', 'HEAD'), base);
  assert.equal(await fs.readFile(path.join(root, 'src/app.ts'), 'utf8'), original);
  assert.ok(!(await fs.readdir(tempDir)).some(name => name.startsWith('envcheck-git-')));
});

test('explicit head compares committed code even when working tree differs', async t => {
  const { root, base, tempDir } = await repository(t);
  await fs.writeFile(path.join(root, 'src/app.ts'), 'const key = process.env.UNTRACKED_CHANGE;');
  const result = await compareGit(root, { base, head: 'HEAD', tempDir });
  assert.equal(result.git.headCommit, base);
  assert.equal(result.changes.length, 0);
  assert.equal(result.summary.currentErrors, 0);
});

test('untracked source files are included in the working-tree target', async t => {
  const { root, base, tempDir } = await repository(t);
  await fs.writeFile(path.join(root, 'src/new.ts'), 'const x = process.env.NEW_KEY;');
  const result = await compareGit(root, { base, tempDir });
  assert.ok(result.changes.some(c => c.variable === 'NEW_KEY' && c.kind === 'ADDED_REQUIRED_VARIABLE'));
  assert.ok(result.introduced.some(f => f.variable === 'NEW_KEY' && f.rule === 'UNDOCUMENTED_VARIABLE'));
});

test('app subdirectory is scoped to the matching subtree in each revision', async t => {
  const { root, base, tempDir } = await repository(t, {
    'apps/api/src/app.ts': 'const x = process.env.API_KEY;',
    'apps/api/.env.example': 'API_KEY=\n',
    'apps/worker/src/app.ts': 'const x = process.env.WORKER_ONLY;'
  });
  const result = await compareGit(path.join(root, 'apps/api'), { base, tempDir });
  assert.equal(result.git.app, 'apps/api');
  assert.equal(result.summary.currentErrors, 0);
  assert.ok(!JSON.stringify(result).includes('WORKER_ONLY'));
});

test('snapshot includes short and long Compose env_file declarations and cleans temporary data', async t => {
  const { root, base, tempDir } = await repository(t, {
    'envcheck.config.json': { version: 1, sources: ['src'], envFiles: [], compose: { file: 'deploy/compose.yaml', service: 'api' } },
    'deploy/compose.yaml': 'services:\n  api:\n    env_file:\n      - path: runtime.env\n        required: true\n      - path: optional.env\n        required: false\n',
    'deploy/runtime.env': 'API_KEY=HISTORICAL-PRIVATE-SENTINEL\n'
  });
  const result = await compareGit(root, { base, head: 'HEAD', tempDir });
  assert.equal(result.summary.currentErrors, 0);
  assert.ok(!JSON.stringify(result).includes('HISTORICAL-PRIVATE-SENTINEL'));
  assert.ok(!(await fs.readdir(tempDir)).some(name => name.startsWith('envcheck-git-')));
});

test('invalid revision and option-like ref fail without exposing git stderr', async t => {
  const { root, tempDir } = await repository(t);
  await assert.rejects(compareGit(root, { base: '--help', tempDir }), /non-option/);
  await assert.rejects(compareGit(root, { base: 'missing-private-ref-name', tempDir }), error => !error.message.includes('missing-private-ref-name'));
});

test('CLI supports --base and --head with JSON and strict exit codes', async t => {
  const { root, base, tempDir } = await repository(t);
  const { stdout } = await execute(process.execPath, [cli, 'compare', root, '--base', base, '--head', 'HEAD', '--json', '--strict'], {
    encoding: 'utf8', env: { ...process.env, ENVCHECK_TMPDIR: tempDir }, windowsHide: true
  });
  assert.equal(JSON.parse(stdout).comparison, 'git-configuration-change');
});

test('CLI supports --base with --markdown emitting git PR comparison', async t => {
  const { root, base, tempDir } = await repository(t);
  const { stdout } = await execute(process.execPath, [cli, 'compare', root, '--base', base, '--markdown'], {
    encoding: 'utf8', env: { ...process.env, ENVCHECK_TMPDIR: tempDir }, windowsHide: true
  });
  assert.ok(stdout.includes('## EnvCheck Comparison'));
  assert.ok(stdout.includes('- **Base:**'));
  assert.ok(stdout.includes('- **Target:** working tree'));
});

test('failed snapshot analysis cleans its temporary directory and preserves repository files', async t => {
  const { root, tempDir } = await repository(t, { 'envcheck.config.json': { version: 1, misspelledSources: ['src'] } });
  const before = await fs.readFile(path.join(root, 'envcheck.config.json'), 'utf8');
  await assert.rejects(compareGit(root, { base: 'HEAD', tempDir }), /Unknown configuration/);
  assert.equal(await fs.readFile(path.join(root, 'envcheck.config.json'), 'utf8'), before);
  assert.ok(!(await fs.readdir(tempDir)).some(name => name.startsWith('envcheck-git-')));
});

test('committed symlink inputs are rejected before materialization', async t => {
  const { root, tempDir } = await repository(t);
  // Write a blob without requiring Windows symlink-creation privileges.
  const linkText = path.join(root, 'link-target.txt');
  await fs.writeFile(linkText, '../outside');
  const oid = await git(root, 'hash-object', '-w', '--', 'link-target.txt');
  await git(root, 'update-index', '--add', '--cacheinfo', `120000,${oid},src/linked.ts`);
  await git(root, '-c', 'user.name=EnvCheck fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'Synthetic symlink fixture');
  await assert.rejects(compareGit(root, { base: 'HEAD', tempDir }), /linked, nonportable or unsupported/);
  assert.ok(!(await fs.readdir(tempDir)).some(name => name.startsWith('envcheck-git-')));
});

test('compareGit with --merge-base on diverging branches does not report base-only additions as removals', async t => {
  const { root, base: commitA, tempDir } = await repository(t, {
    'src/app.ts': 'const a = process.env.ORIGINAL_VAR;\n',
    '.env.example': 'ORIGINAL_VAR=\n'
  });

  // Feature branch adds FEATURE_VAR
  await git(root, 'checkout', '-b', 'feature');
  await fs.writeFile(path.join(root, 'src/app.ts'), 'const a = process.env.ORIGINAL_VAR;\nconst f = process.env.FEATURE_VAR;\n');
  await fs.writeFile(path.join(root, '.env.example'), 'ORIGINAL_VAR=\nFEATURE_VAR=\n');
  const commitB = await commit(root);

  // Main branch diverges by adding BASE_ONLY_VAR
  await git(root, 'checkout', 'main');
  await fs.writeFile(path.join(root, 'src/app.ts'), 'const a = process.env.ORIGINAL_VAR;\nconst b = process.env.BASE_ONLY_VAR;\n');
  await fs.writeFile(path.join(root, '.env.example'), 'ORIGINAL_VAR=\nBASE_ONLY_VAR=\n');
  const commitC = await commit(root);

  // Without --merge-base, BASE_ONLY_VAR in main appears removed in feature
  const direct = await compareGit(root, { base: 'main', head: 'feature', tempDir });
  assert.ok(direct.changes.some(c => c.kind === 'REMOVED_VARIABLE' && c.variable === 'BASE_ONLY_VAR'));

  // With --merge-base, base is resolved to common ancestor commitA
  const withMergeBase = await compareGit(root, { base: 'main', head: 'feature', mergeBase: true, tempDir });
  assert.equal(withMergeBase.git.baseCommit, commitA);
  assert.equal(withMergeBase.git.requestedBase, commitC);
  assert.equal(withMergeBase.git.headCommit, commitB);
  assert.equal(withMergeBase.git.mergeBase, true);
  assert.ok(!withMergeBase.changes.some(c => c.variable === 'BASE_ONLY_VAR'));
  assert.ok(withMergeBase.changes.some(c => c.variable === 'FEATURE_VAR'));

  // Target defaults to working tree when head is omitted, including uncommitted/untracked files
  await git(root, 'checkout', 'feature');
  await fs.writeFile(path.join(root, 'src/uncommitted.ts'), 'const u = process.env.UNCOMMITTED_VAR;\n');
  const workingTree = await compareGit(root, { base: 'main', mergeBase: true, tempDir });
  assert.equal(workingTree.git.baseCommit, commitA);
  assert.equal(workingTree.git.target, 'working-tree');
  assert.ok(!workingTree.changes.some(c => c.variable === 'BASE_ONLY_VAR'));
  assert.ok(workingTree.changes.some(c => c.variable === 'UNCOMMITTED_VAR'));
  assert.ok(!(await fs.readdir(tempDir)).some(name => name.startsWith('envcheck-git-')));
});

test('compareGit rejects revisions with no common ancestor or multiple merge bases', async t => {
  const { root, base: commitA, tempDir } = await repository(t);

  // Orphan branch has no common ancestor
  await git(root, 'checkout', '--orphan', 'orphan');
  await fs.writeFile(path.join(root, 'src/orphan.ts'), 'const o = process.env.ORPHAN;\n');
  await commit(root);
  await assert.rejects(compareGit(root, { base: 'main', head: 'orphan', mergeBase: true, tempDir }), /No common Git ancestor found/);

  // Criss-cross merge history produces multiple merge bases
  await git(root, 'checkout', 'main');
  await git(root, 'checkout', '-b', 'branch1');
  await fs.writeFile(path.join(root, 'src/b1.ts'), 'export const b1 = 1;\n');
  await commit(root);

  await git(root, 'checkout', 'main');
  await git(root, 'checkout', '-b', 'branch2');
  await fs.writeFile(path.join(root, 'src/b2.ts'), 'export const b2 = 2;\n');
  await commit(root);

  await git(root, 'checkout', '-b', 'branchD', 'branch1');
  await git(root, 'merge', '--no-edit', '-m', 'Merge branch2 into D', 'branch2');

  await git(root, 'checkout', '-b', 'branchE', 'branch2');
  await git(root, 'merge', '--no-edit', '-m', 'Merge branch1 into E', 'branch1');

  await assert.rejects(compareGit(root, { base: 'branchD', head: 'branchE', mergeBase: true, tempDir }), /Multiple merge bases found/);
  assert.ok(!(await fs.readdir(tempDir)).some(name => name.startsWith('envcheck-git-')));
});

test('selected Git source directories cannot silently turn symlinks into empty scope', async t => {
  const { root, tempDir } = await repository(t, { 'envcheck.config.json': { version: 1, sources: ['linked'] } });
  const linkText = path.join(root, 'link-target.txt');
  await fs.writeFile(linkText, 'src');
  const oid = await git(root, 'hash-object', '-w', '--', 'link-target.txt');
  await git(root, 'update-index', '--add', '--cacheinfo', `120000,${oid},linked`);
  await git(root, 'commit', '--no-verify', '-m', 'Synthetic selected source symlink');
  await assert.rejects(compareGit(root, { base: 'HEAD', head: 'HEAD', tempDir }), /linked, nonportable or unsupported/);
  assert.ok(!(await fs.readdir(tempDir)).some(name => name.startsWith('envcheck-git-')));
});

test('selected Git submodule sources fail as unsupported input', async t => {
  const { root, base, tempDir } = await repository(t, { 'envcheck.config.json': { version: 1, sources: ['external'] } });
  await git(root, 'update-index', '--add', '--cacheinfo', `160000,${base},external`);
  await git(root, 'commit', '--no-verify', '-m', 'Synthetic selected source submodule');
  await assert.rejects(compareGit(root, { base: 'HEAD', head: 'HEAD', tempDir }), /linked, nonportable or unsupported/);
});

test('default source selection does not bypass a committed linked src directory', async t => {
  const { root, tempDir } = await repository(t, { 'src/app.ts': null, 'app.ts': 'export const x = process.env.ROOT_ONLY;' });
  const linkText = path.join(root, 'link-target.txt');
  await fs.writeFile(linkText, 'elsewhere');
  const oid = await git(root, 'hash-object', '-w', '--', 'link-target.txt');
  await git(root, 'update-index', '--add', '--cacheinfo', `120000,${oid},src`);
  await git(root, 'commit', '--no-verify', '-m', 'Synthetic default source symlink');
  await assert.rejects(compareGit(root, { base: 'HEAD', head: 'HEAD', tempDir }), /linked, nonportable or unsupported/);
});

test('merge-base preserves independent monorepo scope and detects dirty source scope changes', async t => {
  const { root, base, tempDir } = await repository(t, {
    'apps/api/envcheck.config.json': { version: 1, sources: ['src'] },
    'apps/api/src/app.ts': 'export const key = process.env.API_KEY;',
    'apps/api/.env.example': 'API_KEY=\n',
    'apps/api/worker/worker.ts': 'export const key = process.env.WORKER_KEY;',
    'apps/other/src/app.ts': 'export const key = process.env.UNRELATED_KEY;'
  });
  await git(root, 'checkout', '-b', 'feature');
  await fs.writeFile(path.join(root, 'apps/api/envcheck.config.json'), JSON.stringify({ version: 1, sources: ['worker'] }));
  const report = await compareGit(path.join(root, 'apps/api'), { base: 'main', mergeBase: true, tempDir });
  assert.equal(report.git.baseCommit, base);
  assert.equal(report.git.app, 'apps/api');
  assert.equal(report.scope.before.complete, true);
  assert.equal(report.scope.after.complete, true);
  assert.equal(report.scope.comparable, false);
  assert.equal(report.scope.complete, false);
  assert.ok(report.changes.some(c => c.kind === 'ADDED_REQUIRED_VARIABLE' && c.variable === 'WORKER_KEY'));
  assert.ok(report.changes.some(c => c.kind === 'REMOVED_VARIABLE' && c.variable === 'API_KEY'));
  assert.ok(!JSON.stringify(report).includes('UNRELATED_KEY'));
  assert.equal(await git(root, 'rev-parse', 'HEAD'), base);
});

test('Git snapshots reject submodules in source scope while retaining excluded directory boundaries', async t => {
  const { root, base, tempDir } = await repository(t);
  await git(root, 'update-index', '--add', '--cacheinfo', `160000,${base},src/node_modules/dependency`);
  await git(root, 'commit', '--no-verify', '-m', 'Synthetic excluded submodule');
  const excluded = await compareGit(root, { base: 'HEAD', head: 'HEAD', tempDir });
  assert.equal(excluded.scope.complete, true);
  await git(root, 'update-index', '--add', '--cacheinfo', `160000,${base},src/linked-app`);
  await git(root, 'commit', '--no-verify', '-m', 'Synthetic in-scope submodule');
  await assert.rejects(compareGit(root, { base: 'HEAD', head: 'HEAD', tempDir }), /linked, nonportable or unsupported/);
});

test('a monorepo app absent from the base revision remains explicitly incomplete', async t => {
  const { root, base, tempDir } = await repository(t);
  const app = path.join(root, 'apps/new-api');
  await fs.mkdir(path.join(app, 'src'), { recursive: true });
  await fs.writeFile(path.join(app, 'src/app.ts'), 'export const key = process.env.API_KEY;');
  await fs.writeFile(path.join(app, '.env.example'), 'API_KEY=\n');
  const report = await compareGit(app, { base, mergeBase: true, tempDir });
  assert.equal(report.scope.before.sourceFiles, 0);
  assert.equal(report.scope.before.complete, false);
  assert.equal(report.scope.after.complete, true);
  assert.equal(report.scope.complete, false);
  assert.ok(report.changes.some(c => c.kind === 'ADDED_REQUIRED_VARIABLE' && c.variable === 'API_KEY'));
  assert.ok(!JSON.stringify(report).includes('envcheck-git-'));
});
