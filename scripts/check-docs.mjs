import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const skipped = new Set(['.git', 'node_modules', '.envcheck-test-work', 'artifacts']);
const stripCode = text => text.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*(?:\n|$)/gm, '').replace(/^~~~[^\n]*\n[\s\S]*?^~~~[^\n]*(?:\n|$)/gm, '');
function anchors(text) {
  const seen = new Map(), result = new Set();
  for (const match of stripCode(text).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const slug = match[1].toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-');
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    result.add(slug + (n ? '-' + n : ''));
  }
  return result;
}
export async function checkDocumentation(directory = root) {
  directory = await fs.realpath(directory);
  const files = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (skipped.has(entry.name) || (path.relative(directory, current).split(path.sep).join('/') === 'examples' && entry.name === 'reports')) continue;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Linked public file is unsupported');
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
    }
  }
  await walk(directory);
  const external = new Set(); let localLinks = 0;
  for (const file of files.sort()) {
    const text = stripCode(await fs.readFile(file, 'utf8'));
    const targets = [...text.matchAll(/\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)].map(m => m[1] ?? m[2]);
    for (const match of text.matchAll(/^\s*\[[^\]]+\]:\s*(\S+)/gm)) targets.push(match[1]);
    for (const raw of targets) {
      if (/^https?:\/\//i.test(raw)) { external.add(raw); continue; }
      if (/^mailto:/i.test(raw)) continue;
      if (/^[a-z]+:/i.test(raw)) throw new Error('Nonportable documentation URL');
      const [part, fragment] = raw.split('#');
      const target = path.resolve(path.dirname(file), decodeURIComponent(part || path.basename(file)));
      const resolved = await fs.realpath(target).catch(() => { throw new Error(`Broken link: ${path.relative(directory, file)} -> ${raw}`); });
      const relative = path.relative(directory, resolved);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Documentation link leaves repository');
      if (fragment && target.endsWith('.md') && !anchors(await fs.readFile(target, 'utf8')).has(decodeURIComponent(fragment))) throw new Error(`Broken anchor: ${path.relative(directory, file)} -> ${raw}`);
      localLinks++;
    }
  }
  return { markdownFiles: files.length, localLinks, externalLinks: [...external].sort(), remoteUrlsFetched: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkDocumentation().then(result => console.log(JSON.stringify(result, null, 2))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
