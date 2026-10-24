import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture } from './helpers.mjs';

async function cleanupCase(t) {
  let cleanup;
  const root = await fixture({ after(fn) { cleanup = fn; } });
  const remove = fs.rm.bind(fs);
  // Keep the injected failures scoped to the fixture callback, not this fallback.
  t.after(() => remove(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await fs.mkdir(path.join(root, '.git/objects/pack'), { recursive: true });
  await fs.writeFile(path.join(root, '.git/objects/pack/synthetic.pack'), 'inert fixture');
  return { root, cleanup, remove };
}

test('fixture cleanup removes the tree after a transient ENOTEMPTY from the filesystem', async t => {
  const { root, cleanup, remove } = await cleanupCase(t);
  let interrupted = false;
  t.mock.method(fs, 'rm', async (target, options) => {
    if (target === root && !interrupted) {
      interrupted = true;
      throw Object.assign(new Error('Synthetic directory race'), { code: 'ENOTEMPTY' });
    }
    return remove(target, options);
  });
  await cleanup();
  assert.equal(interrupted, true);
  await assert.rejects(fs.access(root), { code: 'ENOENT' });
});

test('fixture cleanup preserves permanent permission errors and leaves evidence intact', async t => {
  const { root, cleanup, remove } = await cleanupCase(t);
  const failure = Object.assign(new Error('Synthetic access denied'), { code: 'EACCES' });
  t.mock.method(fs, 'rm', async (target, options) => {
    if (target === root) throw failure;
    return remove(target, options);
  });
  await assert.rejects(cleanup(), error => error === failure);
  await fs.access(path.join(root, '.git/objects/pack/synthetic.pack'));
});

test('fixture cleanup propagates a persistent ENOTEMPTY after a bounded retry budget', async t => {
  const { root, cleanup, remove } = await cleanupCase(t);
  const failure = Object.assign(new Error('Synthetic persistent directory race'), { code: 'ENOTEMPTY' });
  t.mock.method(fs, 'rm', async (target, options) => {
    if (target === root) throw failure;
    return remove(target, options);
  });
  await assert.rejects(cleanup(), error => error === failure);
  await fs.access(path.join(root, '.git/objects/pack/synthetic.pack'));
});
