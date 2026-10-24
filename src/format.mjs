// Avoid letting repository-controlled names inject terminal escape sequences.
const safe = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
export function formatReport(report) {
  const { errors, warnings, info } = report.summary;
  const out = [`EnvCheck ${report.toolVersion}`, `${report.scope.sourceFiles} source file(s) | ${report.variables.length} variable(s)`, ''];
  for (const finding of report.findings) {
    out.push(`[${finding.severity.toUpperCase()}] ${finding.rule}${finding.variable ? `: ${safe(finding.variable)}` : ''}`);
    out.push(`  ${safe(finding.message)}`);
    for (const at of finding.locations.slice(0, 3)) out.push(`  ${safe(at.file)}${Number.isInteger(at.line) && Number.isInteger(at.column) ? `:${at.line}:${at.column}` : ' (position unknown)'}`);
    out.push(`  Next: ${safe(finding.action)}`, '');
  }
  out.push(`${errors} error(s), ${warnings} warning(s), ${info} note(s).`);
  if (!errors && !warnings) out.push('No issues found within the supported scan scope.');
  if (!report.scope.complete) out.push('INCOMPLETE: some source/configuration could not be analyzed.');
  out.push(`Local values: ${report.scope.valuesChecked ? 'checked in selected files (values omitted)' : 'NOT CHECKED'}.`);
  out.push(`Compose: ${report.scope.compose ? 'declarations checked; resolved runtime values NOT verified' : 'NOT CHECKED'}.`);
  return out.join('\n') + '\n';
}

export function explainVariable(report, name) {
  const variable = report.variables.find(v => v.name === name);
  return { schemaVersion: 1, name, found: !!variable, ...(variable ? { variable } : {}), findings: report.findings.filter(f => f.variable === name), scope: report.scope };
}

export function formatExplanation(explanation) {
  const { name, variable, findings, scope } = explanation;
  const at = location => `${safe(location.file)}${Number.isInteger(location.line) && Number.isInteger(location.column) ? `:${location.line}:${location.column}` : ' (position unknown)'}`;
  const out = [`EnvCheck explanation: ${safe(name)}`, ''];
  if (explanation.found) {
    out.push('Scope: selected source/rule variable list (found: true).');
    out.push(`Required: ${variable.required === null ? 'unknown' : variable.required ? 'yes' : 'no'}`);
    out.push(`Documented: ${variable.documented ? 'yes' : 'no'} (example: ${safe(scope.example)})`);
    if (variable.type) out.push(`Type rule: ${safe(variable.type)}`);
    if (variable.conditionVariable) out.push(`Condition variable: ${safe(variable.conditionVariable)} (comparison value omitted)`);
    out.push(`Local value: ${variable.local.state === 'not-checked' ? 'NOT CHECKED' : safe(variable.local.state)} (values omitted)`);
    if (variable.local.source) out.push(`Local source: ${at(variable.local.source)}`);
    out.push(`Compose: ${variable.compose ? safe(variable.compose.state) : 'NOT CHECKED'}`);
    if (scope.compose) out.push(`Selected service: ${safe(scope.compose.service)} (${safe(scope.compose.file)})`);
    if (variable.compose?.source) out.push(`Compose source: ${at(variable.compose.source)}`);
    out.push('', `Supported source reads: ${variable.usages.length}`);
    for (const usage of variable.usages) out.push(`  ${at(usage)} (${safe(usage.kind)}; ${usage.optional ? 'optional read evidence' : 'no optional read evidence'})`);
  } else out.push('Not in the selected source/rule variable list (found: false). Related findings may still exist in the example.');
  out.push('');
  if (!findings.length) out.push('No variable-specific findings.');
  for (const finding of findings) {
    out.push(`[${safe(finding.severity.toUpperCase())}] ${safe(finding.rule)}`, `  ${safe(finding.message)}`);
    for (const location of finding.locations) out.push(`  ${at(location)}`);
    out.push(`  Next: ${safe(finding.action)}`, '');
  }
  out.push(scope.complete ? 'Coverage: checked within the supported scope.' : 'INCOMPLETE: some analysis is unknown and needs review.');
  out.push(`Local checks: ${scope.valuesChecked ? 'checked in selected files; values omitted' : 'NOT CHECKED'}.`);
  out.push('Exit status uses project-wide findings when found is true; found false returns 1. Use scan for the full project report.');
  return out.join('\n') + '\n';
}

export function makePlan(report) {
  const additions = [...new Set(report.findings.filter(f => f.rule === 'UNDOCUMENTED_VARIABLE').map(f => f.variable))].sort();
  const composeAdditions = [...new Set(report.findings.filter(f => f.rule === 'COMPOSE_VARIABLE_MISSING').map(f => f.variable))].sort();
  return {
    schemaVersion: 1, applied: false, scope: report.scope,
    example: { file: report.scope.example, append: additions.map(name => `${name}=`) },
    ...(report.scope.compose ? {
      compose: {
        file: report.scope.compose.file,
        service: report.scope.compose.service,
        environment: composeAdditions.map(name => `${name}: \${${name}:?Set ${name} locally}`)
      }
    } : {}),
    actions: report.findings.filter(f => ['error', 'warning'].includes(f.severity)).map(f => ({ rule: f.rule, ...(f.variable ? { variable: f.variable } : {}), locations: f.locations, action: f.action })),
    note: 'Preview only. Existing files and credentials have not been changed. Empty placeholders do not satisfy runtime requirements.'
  };
}

export function formatPlan(plan) {
  const out = ['EnvCheck configuration plan (no files changed)', ''];
  if (plan.example.append.length) out.push(`Append to ${safe(plan.example.file)}:`, ...plan.example.append.map(line => `+ ${safe(line)}`), '');
  if (plan.compose?.environment.length) out.push(`Add to ${safe(plan.compose.file)} (services.${safe(plan.compose.service)}.environment):`, ...plan.compose.environment.map(line => `+ ${safe(line)}`), '');
  for (const action of plan.actions) out.push(`- ${safe(action.rule)}${action.variable ? ` (${safe(action.variable)})` : ''}: ${safe(action.action)}`);
  out.push('', plan.note);
  return out.join('\n') + '\n';
}
