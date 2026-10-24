import fs from 'node:fs/promises';
import path from 'node:path';

const excluded = new Set(['node_modules', '.git', '.agents', '.claude', '.codex', 'dist', 'build', 'coverage', '.next', '.nuxt', '.output', 'vendor']);
export const displayPath = (root, file) => path.relative(root, file).split(path.sep).join('/');
// UTF-8 decoding leaves the signature as U+FEFF. Consume exactly one at the
// start; embedded characters remain data. This never changes the source file.
export const stripLeadingBom = text => text.startsWith('\uFEFF') ? text.slice(1) : text;

// The selected root is the trust boundary. Do not follow linked inputs or outputs.
export async function projectPath(root, input, allowMissing = false) {
  if (typeof input !== 'string' || path.isAbsolute(input)) throw new Error('Project paths must be relative.');
  const target = path.resolve(root, input);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Project path escapes the selected root.');
  }
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Linked project paths are unsupported.');
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}

export async function sourceFiles(root, inputs) {
  const found = new Set();
  async function walk(file) {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(file)).sort()) {
        if (!excluded.has(entry) && !entry.startsWith('.')) await walk(path.join(file, entry));
      }
    } else if (/\.(?:[cm]?[jt]s|[jt]sx)$/.test(file) && !/\.d\.[cm]?ts$/.test(file)) {
      found.add(file);
    }
  }
  for (const input of inputs) await walk(await projectPath(root, input));
  return [...found].sort();
}

export async function exists(file) {
  try { await fs.access(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function locate(text, offset, file) {
  const prefix = text.slice(0, offset);
  return { file, line: (prefix.match(/\n/g) ?? []).length + 1, column: offset - prefix.lastIndexOf('\n') };
}
