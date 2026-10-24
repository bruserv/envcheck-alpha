import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { scanProject } from './scan.mjs';
import { exists, projectPath, stripLeadingBom } from './files.mjs';
import { parseEnvironment } from './env.mjs';
import { assertComposeBom, parseCompose, patchComposeService } from './compose.mjs';

const safe = text => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** Only document known names. Do not manufacture local values or change application behavior. */
export async function fixExample(project, { apply = false } = {}) {
  const root = await fs.realpath(project);
  const initial = await scanProject(root, { noValues: true });
  const relative = initial.scope.example;
  if (!/\.(?:example|sample|template)$/i.test(path.basename(relative))) throw new Error('Automatic repair is limited to files ending in .example, .sample or .template; credential files are never repair targets.');
  const target = await projectPath(root, relative, true);
  const present = await exists(target);
  const original = present ? await fs.readFile(target, 'utf8') : '';
  const definitions = parseEnvironment(original, relative).definitions;
  const additions = [...new Set(initial.findings.filter(f => f.rule === 'UNDOCUMENTED_VARIABLE').map(f => f.variable))].filter(name => !definitions.has(name)).sort();
  const needsChange = additions.length > 0 || !present;
  const result = {
    schemaVersion: 1, operation: 'document-missing-variables', target: relative,
    applied: false, changed: false, additions, scope: initial.scope,
    note: 'Only empty example placeholders are added. Existing content is preserved. Credentials, code, local envFiles and Compose are not changed.'
  };
  if (!apply || !needsChange) return { ...result, report: initial };
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const header = present ? '' : `# Environment variable names only. Supply real values locally.${eol}`;
  const separator = stripLeadingBom(original) && !original.endsWith('\n') ? eol : '';
  const replacement = original + separator + header + additions.map(name => `${name}=${eol}`).join('');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await projectPath(root, relative, !present);
  // Re-read just before writing; stale plans must not overwrite intervening edits.
  if (present && await fs.readFile(target, 'utf8') !== original) throw new Error('The example changed during repair; rerun the preview before applying.');
  if (!present) {
    await fs.writeFile(target, replacement, { flag: 'wx', mode: 0o644 });
  } else {
    const temporary = `${target}.envcheck-${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, replacement, { flag: 'wx', mode: (await fs.stat(target)).mode & 0o777 });
      if (await fs.readFile(target, 'utf8') !== original) throw new Error('The example changed during repair; rerun the preview before applying.');
      await fs.rename(temporary, target);
    } finally {
      try { await fs.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return { ...result, applied: true, changed: true, report: await scanProject(root, { noValues: true }) };
}

export function formatRepair(result) {
  const out = [`EnvCheck example repair: ${result.applied ? 'APPLIED' : result.additions.length ? 'PREVIEW' : 'NO ADDITIONS'}`, `Target: ${safe(result.target)}`, ''];
  for (const name of result.additions) out.push(`+ ${name}=`);
  out.push('', result.note);
  if (!result.applied && result.additions.length) out.push('Run the same command with --apply to write these additions.');
  out.push(`Remaining structural findings: ${result.report.summary.errors} error(s), ${result.report.summary.warnings} warning(s).`);
  if (!result.scope.complete) out.push('INCOMPLETE: unsupported inputs still need review.');
  return out.join('\n') + '\n';
}

/** Add interpolation references (${VAR:?...}) for missing variables in the selected Compose service. */
export async function fixCompose(project, { apply = false } = {}) {
  const root = await fs.realpath(project);
  const initial = await scanProject(root, { noValues: true });
  if (!initial.scope.compose) throw new Error('No Compose service is configured for this project.');
  const { file: relative, service } = initial.scope.compose;
  if (!/\.(?:ya?ml|json)$/i.test(path.basename(relative))) {
    throw new Error('Automatic Compose repair is limited to .yaml, .yml or .json Compose files.');
  }
  const target = await projectPath(root, relative, true);
  if (!await exists(target)) throw new Error('The configured Compose file does not exist.');
  const original = await fs.readFile(target, 'utf8');
  assertComposeBom(original, relative);
  const additions = [...new Set(initial.findings.filter(f => f.rule === 'COMPOSE_VARIABLE_MISSING').map(f => f.variable))].sort();
  const replacement = patchComposeService(original, relative, service, additions);
  const declarations = additions.map(name => `${name}=\${${name}:?Set ${name} locally}`);
  const preview = { kind: null, format: null, lines: [], completeDiff: false };
  if (additions.length) {
    const environment = parseCompose(replacement, relative).data.services[service].environment;
    preview.kind = Array.isArray(environment) ? 'list' : 'map';
    preview.format = 'yaml';
    try { JSON.parse(stripLeadingBom(replacement)); preview.format = 'json'; } catch { /* YAML is the serialized representation. */ }
    const entries = additions.map(name => [name, `\${${name}:?Set ${name} locally}`]);
    if (preview.format === 'json') {
      const proposed = preview.kind === 'list' ? declarations : Object.fromEntries(entries);
      preview.lines = JSON.stringify({ environment: proposed }, null, 2).split('\n').slice(1, -1);
    } else preview.lines = ['environment:', ...entries.map(([name, value]) => `  ${preview.kind === 'list' ? `- ${name}=${value}` : `${name}: ${value}`}`)];
  }
  const result = {
    schemaVersion: 1, operation: 'declare-missing-compose-variables', target: relative, service,
    applied: false, changed: false, additions, declarations, preview, scope: initial.scope,
    note: 'Only interpolation references (${VAR:?...}) are added to the selected service environment. Existing entries and comments are preserved; local envFiles, .env.example and runtime credentials are not changed. New declarations are not a full diff. Serialization may also change formatting; inspect the file diff after applying.'
  };
  if (!apply || !additions.length) return { ...result, report: initial };
  await projectPath(root, relative, false);
  if (await fs.readFile(target, 'utf8') !== original) throw new Error('The Compose file changed during repair; rerun the preview before applying.');
  const temporary = `${target}.envcheck-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, replacement, { flag: 'wx', mode: (await fs.stat(target)).mode & 0o777 });
    if (await fs.readFile(target, 'utf8') !== original) throw new Error('The Compose file changed during repair; rerun the preview before applying.');
    await fs.rename(temporary, target);
  } finally {
    try { await fs.unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { ...result, applied: true, changed: true, report: await scanProject(root, { noValues: true }) };
}

export function formatComposeRepair(result) {
  const out = [`EnvCheck Compose repair: ${result.applied ? 'APPLIED' : result.additions.length ? 'PREVIEW' : 'NO ADDITIONS'}`, `Target: ${safe(result.target)} (service: ${safe(result.service)})`, ''];
  if (result.preview?.lines.length) out.push(`New declarations (${safe(result.preview.kind)}, ${safe(result.preview.format)}; not a full diff):`, ...result.preview.lines.map(line => `  ${safe(line)}`));
  out.push('', result.note);
  if (!result.applied && result.additions.length) out.push('Run the same command with --apply to write these declarations.');
  out.push(`Remaining structural findings: ${result.report.summary.errors} error(s), ${result.report.summary.warnings} warning(s).`);
  if (!result.scope.complete) out.push('INCOMPLETE: unsupported inputs still need review.');
  return out.join('\n') + '\n';
}
