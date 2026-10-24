import assert from 'node:assert/strict';
import path from 'node:path';
import { parse } from '@babel/parser';

const docs = new Set(['docs/installation.md', 'docs/configuration.md', 'docs/limitations.md', 'docs/zod.md']);
export const packageFileAllowed = name => ['package.json', 'README.md', 'LICENSE', 'skills/envcheck/SKILL.md'].includes(name) ||
  /^src\/[A-Za-z0-9_-]+\.mjs$/.test(name) || /^skills\/envcheck\/references\/[A-Za-z0-9_-]+\.md$/.test(name) || docs.has(name);

export function packageFailureStatus(stage, error) {
  if (stage === 'npm-preflight' && ['ENOENT', 'EACCES'].includes(error.code)) return 'blocked';
  if (error.code) return 'failed';
  if (['npm-pack', 'npm-install'].includes(stage) &&
    ['EACCES', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'ENOTCACHED', 'ETIMEDOUT'].includes(error.npmCode)) return 'blocked';
  // Missing files, permission failures and assertions after installation are
  // distribution regressions, never an environmental skip.
  return 'failed';
}

// Only npm's final error-code line is evidence about npm's failure. Warning
// text and a spawnSync timeout cannot establish a registry/cache problem.
export function npmFailureCode(output) {
  return [...String(output ?? '').matchAll(/^npm (?:error|ERR!) code ([A-Z][A-Z0-9_]*)\s*$/gm)].at(-1)?.[1] ?? null;
}

export function packagePathInside(parent, target, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const normalize = value => platform === 'win32' ? paths.resolve(value).toLowerCase() : paths.resolve(value);
  const relative = paths.relative(normalize(parent), normalize(target));
  return relative === '' || (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + paths.sep));
}

export function sanitizePackageEvidence(value, roots) {
  if (Array.isArray(value)) return value.map(item => sanitizePackageEvidence(item, roots));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizePackageEvidence(item, roots)]));
  if (typeof value !== 'string') return value;
  for (const [root, replacement] of roots.filter(([root]) => root && root.length > 1).sort((a, b) => b[0].length - a[0].length)) {
    for (const variant of new Set([root, root.replaceAll('\\', '/')])) {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      value = value.replace(new RegExp(escaped, 'gi'), () => replacement);
    }
  }
  return value;
}

export async function persistPackageEvidence(report, cleanup, write) {
  try { await cleanup(); }
  catch (error) {
    report.cleanupError = { code: error.code ?? null, message: error.message };
    if (report.status === 'passed') {
      report.status = 'failed';
      report.failure = { stage: 'cleanup', ...report.cleanupError };
    }
  }
  await write(report);
}

// Audit npm's actual pack inventory, then the bytes unpacked by npm install.
// Unit callers use inert in-memory files; they never pack/install or use a network.
export async function auditPackage(files, read) {
  assert.ok(Array.isArray(files) && files.length > 0, 'Package inventory is empty');
  const names = new Set(files);
  assert.equal(names.size, files.length, 'Package inventory has duplicate paths');
  for (const name of names) assert.ok(packageFileAllowed(name), `Unexpected package file: ${name}`);
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(manifest.name, 'envcheck-workbench');
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.bin.envcheck, 'src/cli.mjs');
  assert.equal(manifest.exports, './src/index.mjs');
  assert.equal(manifest.engines.node, '^22.18.0 || >=24.11.0');
  assert.deepEqual(manifest.files, ['src/*.mjs', 'skills/envcheck/SKILL.md',
    'skills/envcheck/references/*.md', ...docs, 'README.md', 'LICENSE'], 'Manifest must retain the narrow package boundary');
  assert.deepEqual(manifest.dependencies, { '@babel/parser': '8.0.7', '@babel/traverse': '8.0.7', yaml: '2.9.1' });
  for (const required of ['README.md', 'LICENSE', 'skills/envcheck/SKILL.md', 'skills/envcheck/references/workflow.md', ...docs, manifest.bin.envcheck, manifest.exports.slice(2)]) {
    assert.ok(names.has(required), `Missing package resource: ${required}`);
  }
  assert.match(await read(manifest.bin.envcheck), /^#!\/usr\/bin\/env node\r?\n/, 'CLI must retain its executable shebang');
  const imports = new Map();
  for (const name of names) {
    const text = await read(name);
    let specifiers = [];
    if (name.endsWith('.mjs')) {
      let ast;
      try { ast = parse(text, { sourceType: 'module' }); }
      catch { throw new Error(`Packed runtime module could not be parsed: ${name}`); }
      // The package's runtime closure uses static ESM imports/re-exports. Parse
      // syntax so strings/comments describing application code are not imports.
      specifiers = ast.program.body.filter(node => ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source).map(node => node.source.value);
    }
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
        assert.ok(names.has(target), `Module dependency missing: ${name} -> ${target}`);
        if (!imports.has(name)) imports.set(name, []);
        imports.get(name).push(target);
      } else if (!specifier.startsWith('node:')) {
        const dependency = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
        assert.ok(Object.hasOwn(manifest.dependencies, dependency), `Undeclared runtime dependency: ${dependency}`);
      }
    }
    if (name.endsWith('.md')) for (const match of text.matchAll(/\]\(([^\s)]+)\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(match[1])) continue;
      const link = match[1].split('#')[0];
      if (!link) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), link));
      assert.ok(names.has(target), `Package documentation reference missing: ${name} -> ${target}`);
    }
  }
  const reachable = new Set();
  const visit = name => {
    if (reachable.has(name)) return;
    reachable.add(name);
    for (const target of imports.get(name) ?? []) visit(target);
  };
  visit(manifest.bin.envcheck);
  visit(manifest.exports.slice(2));
  for (const name of names) if (name.endsWith('.mjs')) assert.ok(reachable.has(name), `Unreachable package module: ${name}`);
  return { files: names.size, modules: files.filter(name => name.endsWith('.mjs')).length, private: manifest.private, name: manifest.name, version: manifest.version };
}
