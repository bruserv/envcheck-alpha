import fs from 'node:fs/promises';
import { loadConfig } from './config.mjs';
import { displayPath, exists, projectPath, sourceFiles } from './files.mjs';
import { scanSource } from './source.mjs';
import { parseEnvironment, validValue } from './env.mjs';
import { inspectCompose } from './compose.mjs';

export const VERSION = '0.2.0-alpha.1';
const nodeBuiltins = new Set(['NODE_ENV', 'NODE_OPTIONS']);
const viteBuiltins = new Set(['MODE', 'BASE_URL', 'PROD', 'DEV', 'SSR']);
export const isBuiltin = u => u.kind === 'vite' ? viteBuiltins.has(u.name) : nodeBuiltins.has(u.name);

export async function scanProject(inputRoot, options = {}) {
  const root = await fs.realpath(inputRoot);
  const config = await loadConfig(root);
  const findings = [];
  let complete = true;
  const issue = (rule, severity, variable, message, locations, action) => findings.push({ rule, severity, ...(variable ? { variable } : {}), message, locations, action });
  const files = await sourceFiles(root, config.sources);
  const usages = [];
  for (const file of files) {
    const result = scanSource(await fs.readFile(file, 'utf8'), displayPath(root, file));
    usages.push(...result.usages.filter(u => !config.ignore.includes(u.name) && !isBuiltin(u)));
    findings.push(...result.findings);
    complete &&= result.complete;
  }
  if (!files.length) {
    complete = false;
    issue('NO_SOURCE_FILES', 'warning', undefined, 'No supported source files were found.', [], 'Set sources to directories containing JavaScript or TypeScript.');
  }
  const examplePath = await projectPath(root, config.example, true);
  const example = await exists(examplePath) ? parseEnvironment(await fs.readFile(examplePath, 'utf8'), config.example) : { values: {}, definitions: new Map(), findings: [] };
  if (!await exists(examplePath)) issue('EXAMPLE_MISSING', 'error', undefined, 'The environment example file is missing.', [], 'Create the configured example with variable names and placeholders only.');
  findings.push(...example.findings);

  let valuesChecked = false;
  const local = new Map();
  const checkedFiles = [];
  if (!options.noValues) for (const input of config.envFiles) {
    const file = await projectPath(root, input, true);
    if (!await exists(file)) {
      issue('LOCAL_ENV_FILE_MISSING', 'info', undefined, 'A selected local environment file was not found.', [{ file: input, line: 1, column: 1 }], 'Create it locally if needed. CI can use --no-values for structural checks.');
      continue;
    }
    const parsed = parseEnvironment(await fs.readFile(file, 'utf8'), input);
    valuesChecked = true;
    checkedFiles.push(input);
    findings.push(...parsed.findings);
    for (const [name, source] of parsed.definitions) local.set(name, { value: parsed.values[name] ?? '', source });
  }

  const compose = config.compose ? await inspectCompose(root, config.compose) : undefined;
  if (compose) { findings.push(...compose.findings); complete &&= compose.complete; }
  const usagesByName = new Map();
  for (const usage of usages) {
    let references = usagesByName.get(usage.name);
    if (!references) usagesByName.set(usage.name, references = []);
    references.push(usage);
  }
  const variableNames = new Set([...usages.map(u => u.name), ...Object.keys(config.variables), ...Object.values(config.variables).flatMap(r => r.when ? [r.when.variable] : [])]);
  const variables = [];
  for (const name of [...variableNames].sort()) {
    if (config.ignore.includes(name)) continue;
    const references = usagesByName.get(name) ?? [];
    const rule = config.variables[name] ?? {};
    const definition = example.definitions.get(name);
    const localEntry = local.get(name);
    const locations = references.length ? references.map(({ file, line, column }) => ({ file, line, column })) : definition ? [definition] : [];
    const inferredRequired = references.some(u => !u.optional);
    let required = rule.required ?? inferredRequired;
    if (rule.when) {
      const condition = local.get(rule.when.variable);
      if (valuesChecked && condition) required = condition.value === rule.when.equals;
      else {
        required = null;
        issue('CONDITION_UNRESOLVED', 'warning', name, `${name} has a requirement whose condition could not be evaluated.`, locations,
          'Check the condition locally; do not assume this integration is disabled.');
        complete = false;
      }
    }
    if (!definition) issue('UNDOCUMENTED_VARIABLE', 'error', name, `${name} is used or configured but absent from the example.`, locations, `Add ${name}= to the example and describe where its value comes from.`);
    const localState = !valuesChecked ? 'not-checked' : !localEntry ? 'missing' : localEntry.value.trim() ? 'set' : 'empty';
    if (valuesChecked && required && ['missing', 'empty'].includes(localState)) issue('REQUIRED_VALUE_MISSING', 'error', name, `${name} has no nonempty local value.`, localEntry ? [localEntry.source, ...locations] : locations, 'Set a real value locally or supply it in the deployment environment. Do not commit credentials.');
    if (valuesChecked && localState === 'set' && rule.type && !validValue(localEntry.value, rule.type)) issue('INVALID_VALUE_TYPE', 'error', name, `${name} does not match the configured ${rule.type} type.`, [localEntry.source], `Supply a valid ${rule.type}; the rejected value is deliberately omitted.`);

    let composeSummary;
    if (compose) {
      const declaration = compose.declarations.get(name);
      composeSummary = { state: declaration ? 'declared' : compose.complete ? 'missing' : 'unknown', ...(declaration ? { source: declaration.source, kind: declaration.kind } : {}) };
      if (required && !declaration && compose.complete) issue('COMPOSE_VARIABLE_MISSING', 'error', name, `${name} is required by the selected app but not declared for the selected service.`, locations,
        'Pass this variable through service environment or env_file. A project .env alone does not inject it into the container.');
      if (required && declaration?.empty) issue('COMPOSE_VALUE_EMPTY', 'error', name, `${name} is explicitly empty in the selected service.`, [declaration.source], 'Provide a nonempty value or an appropriate variable reference.');
    }
    variables.push({ name, documented: !!definition, required, ...(rule.type ? { type: rule.type } : {}), ...(rule.when ? { conditionVariable: rule.when.variable } : {}), usages: references, local: { state: localState, ...(localEntry ? { source: localEntry.source } : {}) }, ...(composeSummary ? { compose: composeSummary } : {}) });
  }
  for (const [name, source] of example.definitions) {
    if (!variableNames.has(name) && !config.ignore.includes(name) && !nodeBuiltins.has(name)) issue('UNREFERENCED_EXAMPLE_VARIABLE', 'info', name, `${name} has no reference in the selected source scope.`, [source], 'Check framework and deployment usage before removing it.');
  }
  findings.sort((a, b) => ['error', 'warning', 'info'].indexOf(a.severity) - ['error', 'warning', 'info'].indexOf(b.severity) || (a.variable ?? '').localeCompare(b.variable ?? '') || a.rule.localeCompare(b.rule));
  return {
    schemaVersion: 1, toolVersion: VERSION,
    scope: { sources: config.sources, sourceFiles: files.length, example: config.example, envFiles: checkedFiles, ...(config.compose ? { compose: config.compose } : {}), valuesChecked, complete },
    summary: { errors: findings.filter(f => f.severity === 'error').length, warnings: findings.filter(f => f.severity === 'warning').length, info: findings.filter(f => f.severity === 'info').length },
    findings, variables,
    limitations: [
      'Babel AST and scope analysis, not a type checker, data-flow engine or runtime proof. Dynamic keys, whole-env aliases, computed defaults and custom config wrappers need review.',
      'Local values come only from configured files, in order with later files winning. Host process variables are never inspected.',
      'Compose checks one explicitly selected app/service and declarations only. Image ENV, build-time variables, interpolation resolution, overlays and remote secrets are not verified.',
      'A clean structural result does not establish deployment readiness, credential validity or service connectivity.'
    ]
  };
}
