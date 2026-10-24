import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { displayPath, projectPath } from './files.mjs';
import { loadConfig } from './config.mjs';
import { composeEnvFilePaths, parseCompose } from './compose.mjs';
import { compareProjects } from './compare.mjs';

const execute = promisify(execFile);
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 32 * 1024 * 1024;
const sourcePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const excluded = new Set(['node_modules', '.git', '.agents', '.claude', '.codex', 'dist', 'build', 'coverage', '.next', '.nuxt', '.output', 'vendor']);

async function git(root, args, maxBuffer = 16 * 1024 * 1024) {
  try {
    const { stdout } = await execute('git', ['--no-replace-objects', '--no-optional-locks', '-C', root, ...args], {
      encoding: 'buffer', maxBuffer, timeout: 30_000, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' }
    });
    return stdout;
  } catch {
    // git stderr may contain repository-controlled text. Never relay it verbatim.
    throw new Error('Git input could not be read. Check that Git is installed, the project is in a repository and the requested revision exists locally.');
  }
}

async function commitId(root, ref) {
  if (typeof ref !== 'string' || !ref || ref.startsWith('-') || /[\x00-\x1f\x7f]/.test(ref)) throw new Error('A non-option local Git revision is required.');
  const result = (await git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).toString('utf8').trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(result)) throw new Error('Git did not resolve a commit object.');
  return result;
}

async function findMergeBase(repo, commitA, commitB) {
  let stdout;
  try {
    const result = await execute('git', ['--no-replace-objects', '--no-optional-locks', '-C', repo, 'merge-base', '--all', commitA, commitB], {
      encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30_000, windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' }
    });
    stdout = result.stdout;
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 1 && !error.stdout?.trim()) {
      throw new Error('No common Git ancestor found between the selected revisions.');
    }
    throw new Error('Git input could not be read. Check that Git is installed, the project is in a repository and the requested revision exists locally.');
  }
  const bases = stdout.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (bases.length === 0) {
    throw new Error('No common Git ancestor found between the selected revisions.');
  }
  if (bases.length > 1) {
    throw new Error('Multiple merge bases found between the selected revisions; cannot resolve a unique ancestor.');
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(bases[0])) {
    throw new Error('Git did not resolve a commit object.');
  }
  return bases[0];
}

function portablePath(name) {
  return name && !/[\\:\x00-\x1f\x7f]/.test(name) && !name.startsWith('/') &&
    name.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

async function snapshot(repo, prefix, commit, destination) {
  const tree = (await git(repo, ['ls-tree', '-r', '-z', '--long', '--full-tree', commit])).toString('utf8');
  const entries = new Map();
  for (const row of tree.split('\0').filter(Boolean)) {
    const match = row.match(/^(\d+) (blob|commit) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/);
    if (!match) throw new Error('Unsupported Git tree entry.');
    const [, mode, type, oid, size, fullName] = match;
    if (prefix && prefix.startsWith(`${fullName}/`) && (type !== 'blob' || !['100644', '100755'].includes(mode))) {
      throw new Error('A selected Git input uses a linked, nonportable or unsupported path.');
    }
    if (prefix && !fullName.startsWith(prefix)) continue;
    const name = prefix ? fullName.slice(prefix.length) : fullName;
    entries.set(name, { mode, type, oid, size: Number(size) });
  }
  let total = 0;
  let copied = 0;
  const written = new Set();
  function assertSupportedReference(name) {
    const parts = name.split('/');
    for (let length = 1; length <= parts.length; length++) {
      const entry = entries.get(parts.slice(0, length).join('/'));
      if (entry && (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode))) {
        throw new Error('A selected Git input uses a linked, nonportable or unsupported path.');
      }
    }
  }
  async function copy(name) {
    if (written.has(name)) return;
    assertSupportedReference(name);
    const entry = entries.get(name);
    if (!entry) return;
    if (!portablePath(name) || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
      throw new Error('A selected Git input uses a linked, nonportable or unsupported path.');
    }
    if (entry.size > MAX_FILE || total + entry.size > MAX_TOTAL || copied >= 10_000) throw new Error('Git snapshot exceeds the supported input-size limit.');
    const content = await git(repo, ['cat-file', 'blob', entry.oid], MAX_FILE + 1);
    if (content.length !== entry.size) throw new Error('Git object size changed unexpectedly.');
    const target = await projectPath(destination, name, true);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, { flag: 'wx', mode: 0o600 });
    total += content.length;
    copied++;
    written.add(name);
  }

  await copy('envcheck.config.json');
  // Match the normal default scope even before the selected source files exist.
  if (entries.has('src') || [...entries.keys()].some(name => name.startsWith('src/'))) await fs.mkdir(path.join(destination, 'src'), { recursive: true });
  const config = await loadConfig(destination);
  for (const source of config.sources) {
    const absolute = await projectPath(destination, source, true);
    const normalized = displayPath(destination, absolute);
    assertSupportedReference(normalized);
    if (!entries.has(normalized) || !sourcePattern.test(normalized)) await fs.mkdir(absolute, { recursive: true });
    for (const name of entries.keys()) {
      const relative = normalized && name.startsWith(`${normalized}/`) ? name.slice(normalized.length + 1) : name;
      if (normalized && name !== normalized && !name.startsWith(`${normalized}/`)) continue;
      if (name !== normalized && relative.split('/').some(part => excluded.has(part) || part.startsWith('.'))) continue;
      if (entries.get(name).type === 'commit') throw new Error('A selected Git input uses a linked, nonportable or unsupported path.');
      if (!sourcePattern.test(name) || /\.d\.[cm]?ts$/.test(name)) continue;
      await copy(name);
    }
  }
  const example = displayPath(destination, await projectPath(destination, config.example, true));
  await copy(example);
  if (config.compose) {
    const composeName = displayPath(destination, await projectPath(destination, config.compose.file, true));
    await copy(composeName);
    if (written.has(composeName)) {
      let parsed;
      try { parsed = parseCompose(await fs.readFile(path.join(destination, composeName), 'utf8'), config.compose.file); } catch { /* scanner reports unsupported YAML */ }
      for (const item of composeEnvFilePaths(parsed?.data?.services?.[config.compose.service])) {
        let name;
        try { name = displayPath(destination, await projectPath(destination, path.join(path.dirname(composeName), item), true)); } catch { continue; }
        await copy(name);
      }
    }
  }
  return { files: copied, bytes: total };
}

/** Read local objects into a disposable snapshot; never checkout, fetch or mutate the repository. */
export async function compareGit(project, { base, head, mergeBase = false, tempDir } = {}) {
  const app = await fs.realpath(project);
  const repo = await fs.realpath((await git(app, ['rev-parse', '--show-toplevel'])).toString('utf8').trim());
  const relative = displayPath(repo, app);
  if (relative === '..' || relative.startsWith('../')) throw new Error('The app directory must be inside the Git working tree.');
  const prefix = relative ? `${relative}/` : '';
  const requestedBaseCommit = await commitId(repo, base);
  const headCommit = head ? await commitId(repo, head) : undefined;
  const targetCommit = headCommit ?? await commitId(repo, 'HEAD');
  const baseCommit = mergeBase ? await findMergeBase(repo, requestedBaseCommit, targetCommit) : requestedBaseCommit;
  const temporaryBase = await fs.realpath(tempDir ?? os.tmpdir());
  const temporary = await fs.mkdtemp(path.join(temporaryBase, 'envcheck-git-'));
  try {
    const before = path.join(temporary, 'before');
    await fs.mkdir(before);
    const baseSnapshot = await snapshot(repo, prefix, baseCommit, before);
    let after = app;
    let headSnapshot;
    if (headCommit) {
      after = path.join(temporary, 'after');
      await fs.mkdir(after);
      headSnapshot = await snapshot(repo, prefix, headCommit, after);
    }
    const report = await compareProjects(before, after);
    return {
      ...report, comparison: 'git-configuration-change',
      git: {
        baseCommit,
        ...(mergeBase ? { requestedBase: requestedBaseCommit, mergeBase: true } : {}),
        ...(headCommit ? { headCommit } : {}),
        target: headCommit ? 'commit' : 'working-tree',
        app: relative || '.',
        baseSnapshot,
        ...(headSnapshot ? { headSnapshot } : {})
      },
      limitations: [...report.limitations.filter(line => !line.includes('does not fetch Git revisions')), 'Git mode reads local commit objects without checkout, filters or hooks. The working-tree target includes uncommitted and untracked files in the selected source scope. Local envFiles are skipped; Compose env_file inputs are read for service declarations.']
    };
  } finally {
    // Verify the exact final target before recursive cleanup on Windows or Unix.
    const cleanupRelative = path.relative(temporaryBase, temporary);
    if (path.isAbsolute(cleanupRelative) || cleanupRelative.includes(path.sep) || !/^envcheck-git-[A-Za-z0-9]+$/.test(cleanupRelative)) throw new Error('Refusing cleanup outside the temporary snapshot directory.');
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
