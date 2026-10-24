import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { VERSION } from '../src/index.mjs';
import { checkDocumentation } from '../scripts/check-docs.mjs';
import { fixture } from './helpers.mjs';
const root = new URL('../', import.meta.url);

test('alpha metadata, CLI/API and installation filenames use one version', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('package.json', root)));
  const lock = JSON.parse(await fs.readFile(new URL('package-lock.json', root)));
  assert.equal(manifest.version, '0.2.0-alpha.1');
  assert.equal(VERSION, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(manifest.private, true);
  assert.equal(manifest.name, 'envcheck-workbench');
  for (const file of ['README.md', 'START-HERE.pl.md', 'docs/installation.md', 'docs/release-plan.md']) {
    assert.ok((await fs.readFile(new URL(file, root), 'utf8')).includes(`envcheck-workbench-${manifest.version}.tgz`));
  }
});

test('documentation checker rejects missing files and anchors, ignoring fenced code', async t => {
  const dir = await fixture(t);
  const file = path.join(dir, 'README.md');
  await fs.writeFile(file, '# Title\n\n[Valid](#title)\n\n```sh\n[Inert](absent.md)\n```\n');
  assert.equal((await checkDocumentation(dir)).localLinks, 1);
  await fs.writeFile(file, '# Title\n\n[Missing](absent.md)\n');
  await assert.rejects(checkDocumentation(dir), /Broken link/);
  await fs.writeFile(file, '# Title\n\n[Wrong anchor](#absent)\n');
  await assert.rejects(checkDocumentation(dir), /Broken anchor/);
});
