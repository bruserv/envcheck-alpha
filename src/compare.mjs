import { scanProject } from './scan.mjs';
import { loadConfig } from './config.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const VARIABLE_RULES = new Set(['UNDOCUMENTED_VARIABLE', 'COMPOSE_VARIABLE_MISSING', 'CONDITION_UNRESOLVED', 'COMPOSE_VALUE_EMPTY', 'REQUIRED_VALUE_MISSING']);
const findingKey = f => `${f.rule}\0${f.severity}\0${f.variable ?? ''}\0${VARIABLE_RULES.has(f.rule) ? '' : f.locations[0]?.file ?? ''}`;
const normalizedPath = input => path.normalize(input).split(path.sep).join('/').replace(/\/+$/, '') || '.';
const normalizedSet = values => [...new Set(values)].sort();

// Match counts rather than set membership: several unresolved reads can share a
// rule and file. Ignore line shifts so adding a comment does not invent changes.
function unmatchedFindings(current, previous) {
  const remaining = new Map();
  for (const finding of previous) {
    const key = findingKey(finding);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return current.filter(finding => {
    const key = findingKey(finding);
    const count = remaining.get(key) ?? 0;
    if (!count) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

function comparableScopes(before, after) {
  const identity = config => JSON.stringify({
    sources: normalizedSet(config.sources.map(normalizedPath)),
    ignore: normalizedSet(config.ignore),
    compose: config.compose ? { file: normalizedPath(config.compose.file), service: config.compose.service } : null
  });
  return identity(before) === identity(after);
}

export async function compareProjects(beforeRoot, afterRoot) {
  // Structural snapshots only: do not compare or serialize credential values.
  const before = await scanProject(beforeRoot, { noValues: true });
  const after = await scanProject(afterRoot, { noValues: true });
  const beforeConfig = await loadConfig(await fs.realpath(beforeRoot));
  const afterConfig = await loadConfig(await fs.realpath(afterRoot));
  const comparable = comparableScopes(beforeConfig, afterConfig);
  const oldVariables = new Map(before.variables.map(v => [v.name, v]));
  const newVariables = new Map(after.variables.map(v => [v.name, v]));
  const changes = [];
  const add = (kind, variable, severity, message) => changes.push({ kind, variable, severity, message });
  for (const [name, current] of newVariables) {
    const old = oldVariables.get(name);
    if (!old) add(current.required === true ? 'ADDED_REQUIRED_VARIABLE' : 'ADDED_VARIABLE', name, current.required === true ? 'warning' : 'info', 'The new version introduces a configuration variable.');
    else {
      if (old.required === false && current.required === true) add('BECAME_REQUIRED', name, 'warning', 'A previously optional setting is now required. Supply it before deployment.');
      if (old.type !== current.type) add('TYPE_RULE_CHANGED', name, 'warning', 'The configured validation type changed. Check existing deployment values.');
      const previousCondition = beforeConfig.variables[name]?.when;
      const nextCondition = afterConfig.variables[name]?.when;
      if (previousCondition?.variable !== nextCondition?.variable || previousCondition?.equals !== nextCondition?.equals) add('CONDITION_CHANGED', name, 'warning', 'The requirement condition changed; review integration settings.');
      if (old.documented && !current.documented) add('DOCUMENTATION_REMOVED', name, 'error', 'The variable remains in use but was removed from the example.');
      if (old.compose?.state === 'declared' && current.compose?.state === 'missing') add('COMPOSE_DECLARATION_REMOVED', name, current.required === true ? 'error' : 'warning', 'The selected service no longer declares this variable.');
    }
  }
  for (const name of oldVariables.keys()) if (!newVariables.has(name)) add('REMOVED_VARIABLE', name, 'info', 'No reference or explicit rule remains in the new scan scope. Review external consumers before deleting the setting.');
  const introduced = unmatchedFindings(after.findings, before.findings);
  const resolved = unmatchedFindings(before.findings, after.findings);
  const blockingChanges = changes.filter(c => c.severity === 'error').length;
  return {
    schemaVersion: 1,
    comparison: 'structural-project-snapshots',
    scope: { before: before.scope, after: after.scope, comparable, complete: comparable && before.scope.complete && after.scope.complete },
    summary: { changes: changes.length, introduced: introduced.length, resolved: resolved.length, currentErrors: after.summary.errors, currentWarnings: after.summary.warnings, blockingChanges },
    changes, introduced, resolved,
    limitations: [...after.limitations, 'Compare equivalent application scopes. This command compares two directories; it does not fetch Git revisions or remote deployment settings.']
  };
}

export function formatComparison(report) {
  const out = ['EnvCheck structural version comparison', ''];
  if (report.git) out.push(`Base commit: ${report.git.baseCommit}${report.git.mergeBase ? ' (merge-base)' : ''}`, '');
  for (const change of report.changes) out.push(`[${change.severity.toUpperCase()}] ${change.kind}: ${change.variable}`, `  ${change.message}`);
  for (const finding of report.introduced) out.push(`[NEW ${finding.severity.toUpperCase()}] ${finding.rule}${finding.variable ? `: ${finding.variable}` : ''}`);
  for (const finding of report.resolved) out.push(`[RESOLVED] ${finding.rule}${finding.variable ? `: ${finding.variable}` : ''}`);
  out.push('', `${report.summary.changes} contract change(s), ${report.summary.introduced} new finding(s), ${report.summary.resolved} resolved finding(s).`);
  out.push(`New snapshot: ${report.summary.currentErrors} error(s), ${report.summary.currentWarnings} warning(s).`);
  if (report.scope.comparable === false) out.push('INCOMPLETE: comparison scopes differ (sources, ignored variables or selected Compose service/file). Removed variables and resolved findings may reflect scope changes.');
  if (!report.scope.complete && (report.scope.comparable !== false || !report.scope.before.complete || !report.scope.after.complete)) out.push('INCOMPLETE: one or both snapshots contain unsupported input.');
  out.push('Local values, remote secrets and actual startup were NOT checked.');
  return out.join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';
}

const sanitizeInline = text => String(text ?? '')
  .replace(/[\r\n\t]+/g, ' ')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

const mdCode = text => `\`${sanitizeInline(text).replace(/`/g, "'")}\``;
const mdText = text => sanitizeInline(text).replace(/([\\*_{}[\]()<>#+!~`|])/g, '\\$1');

export function formatComparisonMarkdown(report) {
  const out = ['## EnvCheck Comparison', ''];

  if (report.git) {
    const base = report.git.baseCommit ? `\`${report.git.baseCommit.slice(0, 7)}\`` : 'base';
    const mergeBaseNote = report.git.mergeBase ? ' (merge-base)' : '';
    const target = report.git.headCommit ? `\`${report.git.headCommit.slice(0, 7)}\`` : 'working tree';
    const app = report.git.app && report.git.app !== '.' ? ` (app: ${mdCode(report.git.app)})` : '';
    out.push(`- **Base:** ${base}${mergeBaseNote}`, `- **Target:** ${target}${app}`, '');
  }

  const hasChanges = report.summary.changes > 0 || report.summary.introduced > 0 || report.summary.resolved > 0;
  if (!hasChanges) {
    out.push('No configuration changes detected between the compared versions.', '');
  }

  const statusNote = report.scope.complete && report.summary.currentErrors === 0 && report.summary.currentWarnings === 0 ? ' (clean)' : '';
  out.push(`**Current Status:** ${report.summary.currentErrors} error(s), ${report.summary.currentWarnings} warning(s)${statusNote}`);
  out.push(`**Summary:** ${report.summary.changes} contract change(s), ${report.summary.introduced} new finding(s), ${report.summary.resolved} resolved finding(s)`);
  out.push('');

  if (report.changes.length > 0) {
    out.push('### Contract Changes', '');
    for (const change of report.changes) {
      out.push(`- [${change.severity.toUpperCase()}] **${mdCode(change.variable)}** (\`${change.kind}\`): ${mdText(change.message)}`);
    }
    out.push('');
  }

  if (report.introduced.length > 0) {
    out.push('### New Findings', '');
    for (const finding of report.introduced) {
      const locText = finding.locations?.[0]?.file ? `${finding.locations[0].file}${finding.locations[0].line ? `:${finding.locations[0].line}` : ''}` : null;
      const location = locText ? ` (${mdCode(locText)})` : '';
      out.push(`- [NEW ${finding.severity.toUpperCase()}] **${mdCode(finding.rule)}**${finding.variable ? `: ${mdCode(finding.variable)}` : ''}${location}`);
    }
    out.push('');
  }

  if (report.resolved.length > 0) {
    out.push('### Resolved Findings', '');
    for (const finding of report.resolved) {
      const locText = finding.locations?.[0]?.file ? `${finding.locations[0].file}${finding.locations[0].line ? `:${finding.locations[0].line}` : ''}` : null;
      const location = locText ? ` (${mdCode(locText)})` : '';
      out.push(`- [RESOLVED] **${mdCode(finding.rule)}**${finding.variable ? `: ${mdCode(finding.variable)}` : ''}${location}`);
    }
    out.push('');
  }

  if (!hasChanges && (report.summary.currentErrors > 0 || report.summary.currentWarnings > 0)) {
    out.push('> **Note:** Existing issues remain in the target snapshot.', '');
  }

  if (report.scope.comparable === false) {
    out.push('> **INCOMPLETE:** Comparison scopes differ (sources, ignored variables or selected Compose service/file). Removed variables and resolved findings may reflect scope changes.', '');
  }
  if (!report.scope.complete && (report.scope.comparable !== false || !report.scope.before.complete || !report.scope.after.complete)) {
    out.push('> **INCOMPLETE:** One or both snapshots contain unsupported input.', '');
  }

  out.push('> Local values, remote secrets and actual startup were NOT checked.', '');

  return out.join('\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).trimEnd() + '\n';
}
