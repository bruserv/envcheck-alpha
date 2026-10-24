import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseCompose } from '../src/compose.mjs';

test('portable skill has valid standard metadata, links and no scaffold placeholders', async () => {
  const skill = await fs.readFile(new URL('../skills/envcheck/SKILL.md', import.meta.url), 'utf8');
  const match = skill.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/);
  assert.ok(match, 'YAML frontmatter is required');
  const metadata = parseCompose(match[1], 'SKILL.md').data;
  assert.deepEqual(Object.keys(metadata).sort(), ['description', 'name']);
  assert.match(metadata.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(metadata.name.length <= 64);
  assert.equal(typeof metadata.description, 'string');
  assert.ok(metadata.description.length > 20 && metadata.description.length < 1024);
  assert.ok(!skill.includes('[TODO'));
  for (const link of skill.matchAll(/\]\((references\/[^)]+)\)/g)) {
    await fs.access(new URL(`../skills/envcheck/${link[1]}`, import.meta.url));
  }
});
